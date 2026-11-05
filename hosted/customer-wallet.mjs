// Customer wallet: the friendly wallet inside Eupova. One wallet per customer, shown with name, balance,
// network and address; money in (Pay on Eupova, simulated here), activity, and pending approvals.
// The customer controls it: every payment needs their individual approval (see wallet-payments.mjs) and a
// connected tool also needs an allowance they chose (see wallet-tools.mjs). Eupova holds no key.
//
// The offline preview uses the simulated provider only; funds are test money and are labelled as such.
// A live provider exists only when the deployment configuration is complete and consistent (wallet-providers.mjs); there is no reviewer flag.
import {CIRCLE_WEB_SDK_FRAME_ORIGINS} from './wallet-csp.mjs';
import {randomUUID} from 'node:crypto';
import {InputError} from '../server/validation.mjs';
import {WALLET_NETWORKS, WALLET_LIMITS, WALLET_TOKEN, simulatedPayCredit, units, parseUsdc} from '../shared/wallet-model.mjs';
import {createSimulatedWalletProvider, describeProviders} from './wallet-providers.mjs';
import {createWalletBridge} from './wallet-bridge.mjs';
import {createWalletPayments} from './wallet-payments.mjs';
import {createWalletTools, ALLOWANCE_CONFIRMATION} from './wallet-tools.mjs';

const uuid = x => typeof x === 'string' && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(x);
export const big = x => BigInt(String(x ?? '0'));
const amount6 = a => (Array.isArray(a) && a.length === 1 && /^\d{1,12}(\.\d{1,6})?$/.test(a[0]) ? (a[0].includes('.') ? a[0].padEnd(a[0].indexOf('.') + 7, '0') : a[0] + '.000000') : null);

export function createCustomerWallet({store, provider = createSimulatedWalletProvider(), clock = () => new Date(), config = {}, bridgeTransport = null}) {
  if (!provider || typeof provider.executeTransfer !== 'function') throw new Error('A wallet provider is required.');
  if (provider.simulated !== true && !(provider.id === 'circle_ucw' && provider.live === true && WALLET_NETWORKS[provider.network?.id])) throw new Error('Unknown wallet provider.');
  const {tx, query} = store;
  const simulated = provider.simulated === true;
  // One network per deployment. The simulation uses the Base Sepolia test network; a live deployment names its own.
  const net = simulated ? WALLET_NETWORKS.base_sepolia : WALLET_NETWORKS[provider.network.id];

  const lockOwner = (c, owner) => c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['cw-owner:' + owner]);
  const lockWallet = (c, walletId) => c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['cw-wallet:' + walletId]);
  async function note(c, owner, walletId, paymentId, kind, text) {
    await c.query('INSERT INTO relay_cw_events(owner,wallet_id,payment_id,kind,note) VALUES($1,$2,$3,$4,$5)', [owner, walletId, paymentId, kind, text]);
  }
  async function ledgerBalance(c, walletId) {
    const r = (await c.query("SELECT coalesce(sum(CASE direction WHEN 'in' THEN amount_raw ELSE -amount_raw END),0)::text AS b FROM relay_cw_ledger WHERE wallet_id=$1", [walletId])).rows[0];
    return big(r.b);
  }
  async function reservedTotal(c, walletId) {
    const r = (await c.query("SELECT coalesce(sum(reserved_raw),0)::text AS r FROM relay_cw_payments WHERE wallet_id=$1 AND status IN ('executing','outcome_unknown')", [walletId])).rows[0];
    const b = (await c.query("SELECT coalesce(sum(reserved_raw),0)::text AS r FROM relay_cw_bridges WHERE wallet_id=$1 AND status IN ('executing_burn','outcome_unknown')", [walletId])).rows[0];
    return big(r.r) + big(b.r);
  }
  // ---- Gas Station brake. Eupova pays network fees through a Circle Gas Station policy with a daily limit. Circle's policy is the authority; this
  // is Eupova's own conservative tally of that limit (UTC day), kept so a request is refused up front instead of failing later, and so a customer's
  // wallet is never asked to pay a fee that sponsorship was supposed to cover. Reservations count as spent until settled or released.
  const sponsored = !simulated && provider.feeModel?.asset === 'sponsored';
  const micro = t => { const [i, f = ''] = String(t ?? '0').split('.'); return BigInt(i || '0') * 1_000_000n + BigInt(f.padEnd(6, '0').slice(0, 6)); };
  const dailyMicro = sponsored ? micro(config.gasDailyUsd) : 0n, perTxMicro = sponsored ? micro(config.gasPerTxUsd) : 0n;
  const usedToday = async c => {
    const r = (await c.query("SELECT coalesce(sum(usd_micro) FILTER (WHERE state IN ('reserved','spent')),0)::text AS used, bool_or(state='breaker') AS tripped FROM relay_cw_sponsor WHERE day=(now() AT TIME ZONE 'utc')::date")).rows[0];
    return {used: big(r.used), tripped: !!r.tripped};
  };
  const sponsor = {
    enabled: sponsored,
    async roomNow(steps = 1) { if (!sponsored) return true; const u = await usedToday({query: (a, b) => query(a, b)}); return !u.tripped && u.used + perTxMicro * BigInt(steps) <= dailyMicro; },
    async reserve(c, ref, steps = 1) {
      if (!sponsored) return true;
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['cw-sponsor']);     // always the LAST lock taken
      const have = (await c.query("SELECT state FROM relay_cw_sponsor WHERE ref=$1", [ref])).rows[0];
      if (have && ['reserved', 'spent'].includes(have.state)) return true;
      const u = await usedToday(c);
      if (u.tripped || u.used + perTxMicro * BigInt(steps) > dailyMicro) return false;
      await c.query("INSERT INTO relay_cw_sponsor(ref,day,usd_micro,state) VALUES($1,(now() AT TIME ZONE 'utc')::date,$2,'reserved') ON CONFLICT (ref) DO UPDATE SET state='reserved', usd_micro=$2, day=(now() AT TIME ZONE 'utc')::date", [ref, (perTxMicro * BigInt(steps)).toString()]);
      return true;
    },
    async settle(c, ref) { if (sponsored) await c.query("UPDATE relay_cw_sponsor SET state='spent' WHERE ref=$1 AND state='reserved'", [ref]); },
    async release(c, ref) { if (sponsored) await c.query("UPDATE relay_cw_sponsor SET state='released' WHERE ref=$1 AND state='reserved'", [ref]); },
    // Stop sponsoring for the rest of the day. Called only on payer-specific evidence (the wallet's own balance fell), never because a fee appears on a record.
    async breaker(c) { if (sponsored) await c.query("INSERT INTO relay_cw_sponsor(ref,day,usd_micro,state) VALUES('breaker:'||(now() AT TIME ZONE 'utc')::date, (now() AT TIME ZONE 'utc')::date, 0, 'breaker') ON CONFLICT (ref) DO NOTHING"); },
  };
  // ETH held back for open payments AND open Arc moves: one ledger, read by both.
  async function nativeReservedTotal(c, walletId) {
    const p = (await c.query("SELECT coalesce(sum(native_fee_cap_wei),0)::text AS n FROM relay_cw_payments WHERE wallet_id=$1 AND status IN ('executing','outcome_unknown')", [walletId])).rows[0];
    const b = (await c.query("SELECT coalesce(sum(native_reserved_wei),0)::text AS n FROM relay_cw_bridges WHERE wallet_id=$1 AND status IN ('executing_burn','outcome_unknown')", [walletId])).rows[0];
    return big(p.n) + big(b.n);
  }
  async function readyWallet(c, owner, forUpdate = false) {
    const w = (await c.query(`SELECT * FROM relay_cw_wallets WHERE owner=$1 ${forUpdate ? 'FOR UPDATE' : ''}`, [owner])).rows[0];
    if (!w || w.status !== 'ready') throw new InputError('Create your wallet first.', 409);
    return w;
  }
  const rate = (key, limit, seconds) => store.rate(key, limit, seconds);
  // Spendable balance: the ledger for the simulation, the provider's own figure for a real wallet.
  // NOTE for live wallets this is a network read: callers must not hold a transaction open across it unless unavoidable.
  const balanceOf = async (c, w) => simulated ? ledgerBalance(c, w.id) : big(await provider.balance(w.owner, w.provider_ref));
  const ctx = {tx, query, rate, provider, simulated, net, clock, note, lockWallet, lockOwner, ledgerBalance, balanceOf, reservedTotal, nativeReservedTotal, sponsor, readyWallet, big, uuid};
  const payments = createWalletPayments(ctx);
  const tools = createWalletTools({...ctx, payments});
  const bridge = createWalletBridge({...ctx, networkId: net.id, transport: simulated ? null : bridgeTransport});

  // Simulated Pay on Eupova receipts for this wallet's saved-wallet record become ledger credits, once each.
  async function syncPayCredits(c, owner, w) {
    if (!simulated || !w.agent_id) return;
    if (!(await c.query("SELECT to_regclass('relay_live_orders') AS t")).rows[0].t) return;
    const rows = (await c.query("SELECT id, result FROM relay_live_orders WHERE owner=$1 AND status='checkout_received' AND request->'agent'->>'id'=$2", [owner, w.agent_id])).rows;
    for (const r of rows) {
      const raw = r.result?.delivery?.amountRaw;
      if (typeof raw !== 'string' || !/^\d{1,18}$/.test(raw) || raw === '0') continue;
      await c.query("INSERT INTO relay_cw_ledger(id,wallet_id,owner,kind,direction,amount_raw,ref,label,simulated) VALUES($1,$2,$3,'pay_credit','in',$4,$5,$6,true) ON CONFLICT (wallet_id,ref) DO NOTHING",
        [randomUUID(), w.id, owner, raw, 'order:' + r.id, 'Pay on Eupova (simulated test payment)']);
    }
  }

  async function saveReceivingWallet(c, owner, label, address) {
    // The same address is saved as a receiving wallet so the existing Pay on Eupova flow can fund it.
    const agentId = randomUUID();
    const data = {id: agentId, name: label, address, network: 'Base', token: 'USDC', ownership: 'eupova_customer_wallet'};
    const ins = await c.query('INSERT INTO relay_agents(id,owner,data,address_key) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id', [agentId, owner, data, address.toLowerCase()]);
    if (ins.rows[0]) return agentId;
    // The customer already saved this exact address: Add money opens that exact record, never another one.
    return (await c.query('SELECT id FROM relay_agents WHERE owner=$1 AND address_key=$2', [owner, address.toLowerCase()])).rows[0]?.id ?? null;
  }

  const walletView = w => w && ({
    id: w.id, label: w.label, address: w.address, network: (WALLET_NETWORKS[w.network] ?? net).label, networkId: w.network, environment: (WALLET_NETWORKS[w.network] ?? net).environment, token: WALLET_TOKEN.symbol,
    status: w.status, provider: w.provider, simulated: w.simulated, createdAt: w.created_at, savedWalletId: w.agent_id,
    addressNote: w.simulated ? 'Simulated address. It exists on no network and cannot hold real money.' : `Your own address on ${(WALLET_NETWORKS[w.network] ?? net).label}. Only send USDC on this network.`,
  });

  return {
    simulated, live: !simulated, providerId: provider.id, payments, tools, bridge, provider, webSdkFrameOrigins: simulated ? [] : [...CIRCLE_WEB_SDK_FRAME_ORIGINS],
    async migrate() {
      await tx(async c => {
        await c.query('SELECT pg_advisory_xact_lock(431931)');
        await c.query(`CREATE TABLE IF NOT EXISTS relay_cw_wallets(
          id uuid PRIMARY KEY, owner text NOT NULL UNIQUE, request_id uuid NOT NULL, provider text NOT NULL CHECK(provider IN ('simulated','circle_ucw')),
          simulated boolean NOT NULL, label text NOT NULL, address text, provider_ref text, agent_id uuid,
          network text NOT NULL DEFAULT 'base_sepolia' CHECK(network IN ('base_sepolia','base')), status text NOT NULL CHECK(status IN ('pending_setup','ready','failed')),
          created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(owner,request_id))`);
        await c.query(`CREATE TABLE IF NOT EXISTS relay_cw_ledger(
          id uuid PRIMARY KEY, wallet_id uuid NOT NULL REFERENCES relay_cw_wallets(id), owner text NOT NULL,
          kind text NOT NULL CHECK(kind IN ('pay_credit','test_credit','payment','fee')), direction text NOT NULL CHECK(direction IN ('in','out')),
          amount_raw numeric(38,0) NOT NULL CHECK(amount_raw>0), ref text NOT NULL, payment_id uuid, label text NOT NULL, simulated boolean NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(wallet_id,ref))`);
        await c.query(`CREATE TABLE IF NOT EXISTS relay_cw_events(id bigserial PRIMARY KEY, owner text NOT NULL, wallet_id uuid, payment_id uuid, kind text NOT NULL, note text NOT NULL, at timestamptz NOT NULL DEFAULT now())`);
        // Additive upgrade for databases created before Base mainnet existed.
        await c.query('ALTER TABLE relay_cw_wallets DROP CONSTRAINT IF EXISTS relay_cw_wallets_network_check');
        await c.query("ALTER TABLE relay_cw_wallets ADD CONSTRAINT relay_cw_wallets_network_check CHECK(network IN ('base_sepolia','base'))");
        await tools.migrate(c);
        await payments.migrate(c);
        await bridge.migrate(c);
        await c.query("CREATE TABLE IF NOT EXISTS relay_cw_sponsor(ref text PRIMARY KEY, day date NOT NULL, usd_micro numeric(38,0) NOT NULL CHECK(usd_micro>=0), state text NOT NULL CHECK(state IN ('reserved','spent','released','breaker')), created_at timestamptz NOT NULL DEFAULT now())");
      });
    },

    async createWallet(owner, input) {
      if (!uuid(input?.requestId)) throw new InputError('Refresh and try again.');
      const label = typeof input.label === 'string' ? input.label.trim().replace(/\s+/g, ' ') : '';
      if (label.length < 2 || label.length > 40 || /[<>\u0000-\u001f]/.test(label)) throw new InputError('Give your wallet a name of 2 to 40 characters.');
      const stored = await tx(async c => {
        await lockOwner(c, owner);
        const old = (await c.query('SELECT * FROM relay_cw_wallets WHERE owner=$1', [owner])).rows[0];
        if (old) {
          if (old.request_id === input.requestId) return {id: old.id, again: true, status: old.status};
          throw new InputError('You already have a wallet. Eupova gives each customer one wallet.', 409);
        }
        const id = randomUUID();
        if (typeof provider.createWallet !== 'function') {
          // Live provider: the row is saved FIRST, then the provider is asked. A crash in between leaves a pending wallet
          // the customer can resume; the provider call is idempotent by this request id.
          await c.query("INSERT INTO relay_cw_wallets(id,owner,request_id,provider,simulated,label,network,status) VALUES($1,$2,$3,$4,false,$5,$6,'pending_setup')", [id, owner, input.requestId, provider.id, label, net.id]);
          await note(c, owner, id, null, 'wallet_setup_started', `Wallet "${label}" is being set up. Finish the PIN step to open it.`);
          return {id, live: true};
        }
        const made = await provider.createWallet({owner, requestId: input.requestId});
        let agentId = null;
        if (made.state === 'ready' && made.address) agentId = await saveReceivingWallet(c, owner, label, made.address);
        await c.query("INSERT INTO relay_cw_wallets(id,owner,request_id,provider,simulated,label,address,provider_ref,agent_id,network,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
          [id, owner, input.requestId, provider.id, simulated, label, made.address ?? null, made.providerRef ?? null, agentId, net.id, made.state === 'ready' ? 'ready' : 'pending_setup']);
        await note(c, owner, id, null, 'wallet_created', simulated ? `Simulated wallet "${label}" created. It holds test money only.` : `Wallet "${label}" created.`);
        return {id};
      });
      if (stored.again && stored.status !== 'pending_setup') return {id: stored.id};
      if (!stored.live && !stored.again) return {id: stored.id};
      const setup = await provider.beginWalletSetup({owner, requestId: input.requestId});
      return {id: stored.id, challenge: setup.alreadyInitialized ? null : setup};
    },

    // The customer closed the page mid-setup: ask again (idempotent by the original request id) and run the step again.
    async resumeSetup(owner) {
      if (simulated || typeof provider.beginWalletSetup !== 'function') throw new InputError('Not found.', 404);
      const w = (await query("SELECT id,request_id,status FROM relay_cw_wallets WHERE owner=$1", [owner])).rows[0];
      if (!w) throw new InputError('Create your wallet first.', 409);
      if (w.status !== 'pending_setup') return {id: w.id};
      const setup = await provider.beginWalletSetup({owner, requestId: w.request_id});
      return {id: w.id, challenge: setup.alreadyInitialized ? null : setup};
    },

    // Real provider only: after the customer finished the PIN step, read the wallet back from the provider.
    async finishSetup(owner) {
      if (simulated || typeof provider.findWallet !== 'function') throw new InputError('Not found.', 404);
      const w0 = (await query("SELECT id,status FROM relay_cw_wallets WHERE owner=$1", [owner])).rows[0];
      if (!w0) throw new InputError('Create your wallet first.', 409);
      if (w0.status === 'ready') return {id: w0.id};
      const found = await provider.findWallet(owner); // read-only, outside any transaction
      if (!found) throw new InputError('Your wallet is not ready yet. Finish the PIN step, then try again.', 409);
      return tx(async c => {
        await lockOwner(c, owner);
        const w = (await c.query("SELECT * FROM relay_cw_wallets WHERE owner=$1 FOR UPDATE", [owner])).rows[0];
        if (w.status === 'ready') return {id: w.id};
        const agentId = await saveReceivingWallet(c, owner, w.label, found.address);
        await c.query("UPDATE relay_cw_wallets SET status='ready',address=$2,provider_ref=$3,agent_id=$4,updated_at=now() WHERE id=$1", [w.id, found.address, found.providerRef, agentId]);
        await note(c, owner, w.id, null, 'wallet_ready', `Wallet "${w.label}" is ready.`);
        return {id: w.id};
      });
    },

    // One-step simulated Pay on Eupova, for quick demos. The full Pay flow targets the same address.
    async addTestMoney(owner, input) {
      if (!simulated) throw new InputError('Test money is only available in the simulation.', 404);
      if (!uuid(input?.requestId) || !Number.isInteger(input.pence)) throw new InputError('Choose an amount.');
      let credit;
      try { credit = simulatedPayCredit(input.pence); } catch (e) { throw new InputError(e.message); }
      return tx(async c => {
        await lockOwner(c, owner);
        const w = await readyWallet(c, owner, true);
        await lockWallet(c, w.id);
        const count = Number((await c.query("SELECT count(*) FROM relay_cw_ledger WHERE wallet_id=$1 AND kind='test_credit'", [w.id])).rows[0].count);
        const ref = 'test:' + input.requestId;
        const old = (await c.query('SELECT amount_raw::text AS a FROM relay_cw_ledger WHERE wallet_id=$1 AND ref=$2', [w.id, ref])).rows[0];
        if (old) { if (old.a !== credit.toString()) throw new InputError('This request was already used for a different amount.', 409); return {id: w.id}; }
        if (count >= WALLET_LIMITS.maxTestCredits) throw new InputError('Test money limit reached.', 409);
        await c.query("INSERT INTO relay_cw_ledger(id,wallet_id,owner,kind,direction,amount_raw,ref,label,simulated) VALUES($1,$2,$3,'test_credit','in',$4,$5,$6,true)",
          [randomUUID(), w.id, owner, credit.toString(), ref, `Pay on Eupova (simulated): £${Math.trunc(input.pence / 100)}.${String(input.pence % 100).padStart(2, '0')} of test money`]);
        await note(c, owner, w.id, null, 'test_money', `Added ${units(credit)} USDC of simulated test money.`);
        return {id: w.id};
      });
    },

    async state(owner) {
      // Bounded, throttled catch-up: payments the customer approved are checked against the network record without anyone pressing a button.
      if (!simulated) { await payments.reconcileOpen(owner).catch(() => 0); await bridge.reconcileOpen(owner).catch(() => 0); }
      // 1. Database only, under the lock. 2. Provider reads, outside any transaction. A slow provider never holds a lock.
      const data = await tx(async c => {
        const w = (await c.query('SELECT * FROM relay_cw_wallets WHERE owner=$1', [owner])).rows[0] ?? null;
        if (w) { await lockWallet(c, w.id); await syncPayCredits(c, owner, w); }
        await c.query("UPDATE relay_cw_payments SET status='expired',updated_at=now() WHERE owner=$1 AND status='awaiting_approval' AND expires_at<=now()", [owner]);
        await payments.sweepStuck(c, owner);
        if (!w) return {w: null};
        const reserved = await reservedTotal(c, w.id);
        const ledger = (await c.query('SELECT id,kind,direction,amount_raw::text AS a,label,simulated,payment_id,created_at FROM relay_cw_ledger WHERE wallet_id=$1 ORDER BY created_at DESC, id LIMIT 60', [w.id])).rows;
        return {w, reserved, ledger, bal: simulated ? await ledgerBalance(c, w.id) : undefined};
      });
      const live = data.w && !simulated && data.w.status === 'ready';
      let bal = data.bal ?? 0n, balanceError = false, history = [], usdcTokenId = null;
      if (live) {
        try { bal = big(await provider.balance(owner, data.w.provider_ref)); } catch { balanceError = true; }
        try { usdcTokenId = await provider.resolveUsdcTokenId(owner, data.w.provider_ref); } catch { usdcTokenId = null; }
        // Only the exact USDC token on this network is ever listed. With no token identity nothing from the provider is shown.
        try { history = usdcTokenId ? (await provider.history(owner, data.w.provider_ref)).filter(h => h.tokenId === usdcTokenId && (h.blockchain === null || h.blockchain === net.circleChain)) : []; } catch { history = []; }
      }
      const base = {
        enabled: true, simulated, live: !simulated, label: simulated ? 'Simulated wallet. Test money only.' : `Your wallet on ${net.label}`,
        provider: {id: provider.id, label: provider.label, custody: provider.custody},
        network: {id: net.id, label: net.label, environment: net.environment, mainnet: net.environment === 'mainnet', chainId: net.chainId, nativeSymbol: net.nativeSymbol},
        fees: simulated ? {asset: 'USDC', simulated: true} : {asset: provider.feeModel.asset, nativeSymbol: net.nativeSymbol},
        token: WALLET_TOKEN, allowanceConfirmation: ALLOWANCE_CONFIRMATION, limits: {allowanceMaxUsdc: units(WALLET_LIMITS.maxAllowanceRaw), allowanceMaxHours: WALLET_LIMITS.maxAllowanceHours, maxPaymentUsdc: units(WALLET_LIMITS.maxPaymentRaw)},
        // Provider comparison and setup descriptors are test-settings material: never part of a live customer's state.
        ...(simulated ? {providers: describeProviders({config, activeId: provider.id})} : {}),
      };
      if (data.w && balanceError) return {...base, wallet: walletView(data.w), balance: {unavailable: true, raw: '0', usdc: '0.000000', reservedUsdc: '0.000000', availableUsdc: '0.000000', simulated: false}, activity: [], pendingApprovals: [], payments: [], tools: [], notice: 'We could not read your balance just now. Nothing was changed. Try again in a moment.'};
      if (!data.w) return {...base, wallet: null, balance: null, activity: [], pendingApprovals: [], payments: [], tools: [], enrolmentCode: null};
      const pay = await payments.list(owner, data.w.id);
      const toolState = await tools.list(owner, data.w.id);
      // Activity. Only money that really moved shows as an amount. Waiting, declined, lapsed and failed requests show their
      // status and no spent amount, so a request that never paid can never be read as a payment.
      const moved = new Set(['succeeded']);
      const ownRefs = new Set(pay.map(p => p.id));
      const activity = [
        ...data.ledger.map(l => ({id: 'l:' + l.id, at: l.created_at, kind: l.kind, direction: l.direction, amountUsdc: units(l.a), label: l.label, simulated: l.simulated, status: 'posted', moved: true})),
        // Live wallets: this wallet's USDC activity from the provider. Our own payments are shown from our payment rows (their network
        // record was verified), so any provider row carrying one of their references is skipped, never listed twice. Incoming money that has
        // not completed shows as pending with no amount; transfers sent some other way show as such; a failed transaction that still paid
        // a network fee says so.
        ...(simulated ? [] : history.filter(h => !(h.refId && ownRefs.has(h.refId))).map(h => {
          const done = h.state === 'COMPLETE', failed = ['FAILED', 'DENIED', 'CANCELLED'].includes(h.state);
          const gas = failed && h.networkFee && Number(h.networkFee) > 0 ? ` The network still charged a fee of ${h.networkFee} ${net.nativeSymbol}.` : '';
          return {id: 'h:' + h.id, at: h.at, kind: 'chain', direction: h.direction, amountUsdc: done ? amount6(h.amounts) : null,
            label: (h.direction === 'in' ? (done ? 'Received' : failed ? 'Incoming transfer did not complete' : 'Incoming transfer, pending') : (done ? 'Sent from your wallet' : failed ? 'Transfer from your wallet failed' : 'Transfer from your wallet, pending')) + (done ? '' : '.') + gas,
            simulated: false, status: String(h.state).toLowerCase(), moved: done};
        })),
        ...pay.filter(p => !(simulated && moved.has(p.status)))
          .map(p => ({id: 'p:' + p.id, at: p.createdAt, kind: 'payment', direction: 'out', amountUsdc: moved.has(p.status) ? p.amountUsdc : null, label: `${p.service}: ${p.statusLabel}`, simulated: data.w.simulated, status: p.status, moved: moved.has(p.status)})),
      ].sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, 60);
      return {
        ...base, wallet: walletView(data.w),
        balance: {raw: bal.toString(), usdc: units(bal), reservedUsdc: units(data.reserved), availableUsdc: units(bal > data.reserved ? bal - data.reserved : 0n), simulated: data.w.simulated},
        activity, pendingApprovals: pay.filter(p => p.status === 'awaiting_approval' || p.status === 'outcome_unknown'), payments: pay, tools: toolState,
        bridge: simulated ? {available: false, reason: 'Not part of the simulated wallet. The simulated Base Sepolia to Arc Testnet bridge is on the Bridge and recovery page.', items: []} : await bridge.state(owner),
      };
    },
    parseUsdc,
  };
}
