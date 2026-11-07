// Wallet payments: every payment needs the customer's individual approval, bound to immutable details.
// Tool-originated payments additionally need an allowance the customer chose. All limit accounting happens
// under a per-wallet lock; the allowance row also carries a database CHECK (spent + reserved <= amount) as a
// second line of defence. Execution fails closed: an uncertain outcome is never retried automatically.
import {createHash, randomUUID} from 'node:crypto';
import {canChallenge, completeApproval, prepareApproval} from './x402-approval.mjs';
import {executeX402} from './x402-pay.mjs';
import {InputError} from '../server/validation.mjs';
import {
  WALLET_LIMITS, paymentBinding, canonicalPayment, parseUsdc, serviceName, checkNetworkToken,
  paymentStatusLabels, rejectReasons, shortFingerprint, units, nativeText,
} from '../shared/wallet-model.mjs';

const sha = text => createHash('sha256').update(text).digest('hex');
const STATUSES = "'awaiting_approval','declined','rejected','invalidated','expired','approved','executing','succeeded','failed','outcome_unknown','cancelled'";
const idemOk = k => typeof k === 'string' && /^[A-Za-z0-9._:-]{8,64}$/.test(k);

export function createWalletPayments({tx, query, provider, simulated, net, clock, note, lockWallet, ledgerBalance, balanceOf, reservedTotal, nativeReservedTotal, sponsor, big, uuid, fetchImpl = fetch}) {
  const feeAsset = simulated ? 'USDC' : provider.feeModel.asset; // 'USDC' (simulation) | 'ETH' | 'sponsored'

  function normalise(input, wallet) {
    if (input.network !== undefined) checkNetworkToken(typeof input.network === 'string' ? input.network : '', 'USDC', net.id); // this deployment's network only
    if (input.token !== undefined && input.token !== 'USDC') throw new RangeError('Only USDC can be used.');
    const destination = typeof input.destination === 'string' ? input.destination : '';
    if (!/^0x[0-9a-fA-F]{40}$/.test(destination) || /^0x0{40}$/.test(destination)) throw new RangeError('Check the destination address.');
    if (destination.toLowerCase() === String(wallet.address).toLowerCase()) throw new RangeError('Choose a different destination from this wallet.');
    const amount = parseUsdc(input.amount);
    // A USDC fee exists only in the simulation. On a live wallet the network fee is paid in ETH (or sponsored), is worked out
    // from the network, and is shown in ETH: a caller cannot set a USDC fee, and none is ever charged in USDC.
    if (!simulated && input.maxFee !== undefined && input.maxFee !== '0' && input.maxFee !== '0.00') throw new RangeError('The network fee is paid in ETH and is worked out for you. Leave the maximum fee out.');
    const fee = simulated ? parseUsdc(input.maxFee ?? '0.05', {allowZero: true}) : 0n;
    return {destination, amountRaw: amount, maxFeeRaw: fee, capRaw: amount + fee, service: serviceName(input.service ?? 'Payment')};
  }
  const detailsHash = (n) => sha(JSON.stringify([n.destination.toLowerCase(), n.amountRaw.toString(), n.maxFeeRaw.toString(), n.service, net.id, 'USDC']));

  function view(r, ctx = {}) {
    const binding = r.binding;
    const awaiting = r.status === 'awaiting_approval' && new Date(r.expires_at) > clock();
    return {
      id: r.id, origin: r.origin, kind: r.kind ?? 'transfer', service: r.service, destination: r.destination, network: net.label, networkId: r.network, token: r.token,
      // For an x402 payment the customer is approving a call, not a transfer: show the host and the single-use promise.
      ...(r.kind === 'x402' ? {x402: {host: r.x402?.host ?? null, payTo: r.destination, validForSeconds: r.x402?.requirement?.maxTimeoutSeconds ?? null, step: r.x402?.step ?? null}} : {}),
      amountUsdc: units(r.amount_raw), maxFeeUsdc: units(r.max_fee_raw), capUsdc: units(r.cap_raw),
      fee: {asset: r.fee_asset ?? 'USDC', usdcMax: units(r.max_fee_raw), nativeMax: r.fee_asset === 'ETH' ? nativeText(r.native_fee_cap_wei) : null, nativeSymbol: net.nativeSymbol, sponsored: r.fee_asset === 'sponsored'},
      environment: net.environment, mainnet: net.environment === 'mainnet', tokenAddress: net.usdc,
      status: r.status, statusLabel: paymentStatusLabels[r.status], reason: r.reject_reason ? (rejectReasons[r.reject_reason] ?? r.reject_reason) : null,
      reasonCode: r.reject_reason, fingerprint: r.binding_hash, shortFingerprint: shortFingerprint(r.binding_hash), binding,
      tool: binding.tool ? {id: binding.tool.id, name: ctx.toolNames?.get(binding.tool.id) ?? 'Connected tool', allowanceRevision: binding.tool.allowanceRevision} : null,
      expiresAt: r.expires_at, createdAt: r.created_at, decidedAt: r.decided_at, receipt: r.receipt, simulated,
      canApprove: awaiting, canDecline: awaiting,
      canCheckOutcome: r.status === 'outcome_unknown',
      challenge: r.provider_state?.challengeId ? {id: r.provider_state.challengeId} : null,
      canResume: r.status === 'executing' && !!r.provider_state?.tokenId, anomaly: r.receipt?.anomaly ?? null,
    };
  }

  async function toolNames(c, owner) {
    return new Map((await c.query('SELECT id,name FROM relay_cw_tools WHERE owner=$1', [owner])).rows.map(r => [r.id, r.name]));
  }
  const fullRow = (c, owner, id) => c.query('SELECT *, amount_raw::text AS amount_raw, max_fee_raw::text AS max_fee_raw, cap_raw::text AS cap_raw, native_fee_cap_wei::text AS native_fee_cap_wei FROM relay_cw_payments WHERE id=$1 AND owner=$2 FOR UPDATE', [id, owner]);

  async function insert(c, owner, w, n, {origin, requestId, status, reason = null, tool = null, allowance = null, fee = null, kind = 'transfer', x402 = null}) {
    const f = fee ?? {asset: feeAsset, maxFeeNativeWei: '0'};
    const binding = paymentBinding({
      origin, requestId, walletId: w.id, walletAddress: w.address, network: net.id, only: net.id, token: 'USDC', service: n.service, destination: n.destination,
      amountRaw: n.amountRaw.toString(), maxFeeRaw: n.maxFeeRaw.toString(), capRaw: n.capRaw.toString(),
      feeAsset: f.asset, maxNativeFeeWei: f.maxFeeNativeWei ?? '0', gasLimit: f.gasLimit, maxFee: f.maxFee, priorityFee: f.priorityFee,
      toolId: tool?.id, allowanceId: allowance?.id ?? 'none', allowanceRevision: allowance?.revision ?? 0, rejected: status === 'rejected',
    });
    const id = randomUUID();
    if (kind === 'x402' && n.maxFeeRaw !== 0n) throw new RangeError('An x402 payment has no Eupova-side fee: the service pays the network fee.');
    await c.query(`INSERT INTO relay_cw_payments(id,owner,wallet_id,origin,tool_id,allowance_id,allowance_revision,request_id,service,destination,network,token,amount_raw,max_fee_raw,cap_raw,status,reject_reason,binding,binding_hash,details_hash,expires_at,fee_asset,native_fee_cap_wei,kind,x402)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'USDC',$12,$13,$14,$15,$16,$17,$18,$19, now() + ($20 || ' minutes')::interval,$21,$22,$23,$24)`,
      [id, owner, w.id, origin, tool?.id ?? null, allowance?.id ?? null, allowance?.revision ?? null, requestId, n.service, n.destination.toLowerCase(), net.id,
        n.amountRaw.toString(), n.maxFeeRaw.toString(), n.capRaw.toString(), status, reason, binding, sha(canonicalPayment(binding)), detailsHash(n), String(WALLET_LIMITS.approvalWindowMinutes), f.asset, (f.maxFeeNativeWei ?? '0').toString(), kind, x402]);
    await note(c, owner, w.id, id, status === 'rejected' ? 'payment_rejected' : 'payment_requested',
      status === 'rejected' ? `${origin === 'tool' ? 'A connected tool' : 'A payment'} was refused: ${rejectReasons[reason] ?? reason}` : `${n.service}: ${units(n.amountRaw)} USDC is waiting for your approval.`);
    return id;
  }

  // The state a payment must still be in at the moment it is approved or run. Returns a reason code when not.
  async function liveProblem(c, owner, p, w) {
    if (w.status !== 'ready' || w.id !== p.wallet_id || String(w.address).toLowerCase() !== p.binding.wallet.address) return 'wallet_not_ready';
    if (p.origin === 'customer') return null;
    const tool = (await c.query("SELECT status FROM relay_cw_tools WHERE id=$1 AND owner=$2 AND wallet_id=$3", [p.tool_id, owner, w.id])).rows[0];
    if (!tool || tool.status !== 'active') return 'tool_revoked';
    const a = (await c.query("SELECT *, amount_raw::text AS amt, spent_raw::text AS spent, reserved_raw::text AS res FROM relay_cw_allowances WHERE id=$1 AND owner=$2 FOR UPDATE", [p.allowance_id, owner])).rows[0];
    if (!a || a.status !== 'active') return 'no_allowance';
    if (a.revision !== p.allowance_revision) return 'allowance_changed';
    if (new Date(a.expires_at) <= clock()) return 'allowance_expired';
    if (big(a.spent) + big(a.res) + big(p.cap_raw) > big(a.amt)) return 'over_allowance';
    return null;
  }

  // Lock order everywhere: owner lock (if any) -> wallet lock -> rows (wallet, payment, allowance). Read the wallet id with a
  // plain select, take the wallet lock, then lock the payment row.
  async function lockPayment(c, owner, id) {
    const pre = (await c.query('SELECT wallet_id FROM relay_cw_payments WHERE id=$1 AND owner=$2', [id, owner])).rows[0];
    if (!pre) return null;
    await lockWallet(c, pre.wallet_id);
    return (await fullRow(c, owner, id)).rows[0] ?? null;
  }
  const nativeReserved = nativeReservedTotal ?? (async (c, walletId) => big((await c.query("SELECT coalesce(sum(native_fee_cap_wei),0)::text AS n FROM relay_cw_payments WHERE wallet_id=$1 AND status IN ('executing','outcome_unknown')", [walletId])).rows[0].n));

  // Read-only network fee work, done BEFORE anything is saved. A failure means no request is made.
  async function estimate(owner, w, n) {
    if (simulated) return null;
    let fee;
    try { fee = await provider.estimateFee({owner, walletRef: w.provider_ref, destination: n.destination, amountRaw: n.amountRaw.toString()}); } catch { throw new InputError(rejectReasons.fee_unavailable, 503); }
    if (fee.asset === 'ETH') {
      let have; try { have = big(await provider.nativeBalanceWei(owner, w.provider_ref)); } catch { throw new InputError(rejectReasons.fee_unavailable, 503); }
      if (have < big(fee.maxFeeNativeWei)) throw new InputError(rejectReasons.insufficient_gas, 409);
    }
    if (fee.asset === 'sponsored' && !(await sponsor.roomNow(1))) throw new InputError(rejectReasons.sponsorship_exhausted, 409);
    return fee;
  }

  async function finish(owner, id, out) {
    return tx(async c => {
      const p = await lockPayment(c, owner, id);
      if (!p || p.status !== 'executing') return p ? view(p) : null;
      const cap = big(p.cap_raw), amount = big(p.amount_raw), maxFee = big(p.max_fee_raw);
      const release = async () => {
        if (p.allowance_id) await c.query('UPDATE relay_cw_allowances SET reserved_raw=reserved_raw-$2,updated_at=now() WHERE id=$1', [p.allowance_id, cap.toString()]);
      };
      const trustedConfirmation = simulated
        ? /^\d{1,18}$/.test(String(out?.feeRaw ?? '')) && big(out.feeRaw) <= maxFee
        : out?.verified === true; // a live payment is never accepted on the provider's say-so alone: it must have been verified field by field
      if (out?.state === 'confirmed' && trustedConfirmation) {
        const fee = simulated ? big(out.feeRaw) : 0n;
        if (simulated) await c.query("INSERT INTO relay_cw_ledger(id,wallet_id,owner,kind,direction,amount_raw,ref,payment_id,label,simulated) VALUES($1,$2,$3,'payment','out',$4,$5,$6,$7,$8)",
          [randomUUID(), p.wallet_id, owner, amount.toString(), 'pay:' + p.id, p.id, `${p.service}: payment`, simulated]);
        if (simulated && fee > 0n) await c.query("INSERT INTO relay_cw_ledger(id,wallet_id,owner,kind,direction,amount_raw,ref,payment_id,label,simulated) VALUES($1,$2,$3,'fee','out',$4,$5,$6,$7,$8)",
          [randomUUID(), p.wallet_id, owner, fee.toString(), 'fee:' + p.id, p.id, `${p.service}: network fee`, simulated]);
        if (p.allowance_id) await c.query('UPDATE relay_cw_allowances SET reserved_raw=reserved_raw-$2, spent_raw=spent_raw+$3, updated_at=now() WHERE id=$1', [p.allowance_id, cap.toString(), (amount + fee).toString()]);
        const nativeFee = !simulated && typeof out.networkFee === 'string' && /^\d+(\.\d{1,18})?$/.test(out.networkFee) ? out.networkFee : null;
        const wei = t => BigInt(t.split('.')[0] + (t.split('.')[1] ?? '').padEnd(18, '0').slice(0, 18));
        const overCap = nativeFee !== null && p.fee_asset === 'ETH' && wei(nativeFee) > big(p.native_fee_cap_wei);
        // A network fee on the record is NOT evidence that the customer paid it: for a sponsored payment it is the network's cost. Who paid is judged
        // only from the wallet's own ETH balance (before the request and after completion); when that cannot be compared, nothing is concluded.
        let payer = null;
        if (p.fee_asset === 'sponsored' && nativeFee !== null && wei(nativeFee) > 0n) {
          const before = p.provider_state?.nativeBeforeWei, after = out.nativeAfterWei;
          payer = (before == null || after == null) ? 'unknown' : (BigInt(before) - BigInt(after) >= (wei(nativeFee) * 9n) / 10n ? 'wallet' : 'not_wallet');
        }
        const receipt = {ref: out.ref, amountUsdc: units(amount), feeUsdc: units(fee), totalUsdc: units(amount + fee), service: p.service, destination: p.destination, network: net.label, token: 'USDC',
          networkFee: p.fee_asset === 'sponsored' || nativeFee === null ? null : `${nativeFee} ${net.nativeSymbol}`,
          networkCostReported: p.fee_asset === 'sponsored' && nativeFee !== null ? `${nativeFee} ${net.nativeSymbol}` : null, feePayer: payer,
          anomaly: payer === 'wallet' ? `Your wallet's ${net.nativeSymbol} balance fell by about the network fee Circle reported (${nativeFee} ${net.nativeSymbol}), so it was charged to your wallet although sponsorship was expected. Sponsored payments are paused for today; please check the Gas Station policy.`
            : overCap ? 'The network fee was above the estimate you were shown. The payment itself matched; please review.' : null,
          at: clock().toISOString(), simulated, verifiedOnChain: !simulated,
          note: simulated ? 'Simulation receipt. This is not a blockchain transaction and no real money moved.' : 'Verified against the network record: wallet, recipient, amount, token and reference all match.'};
        if (p.fee_asset === 'sponsored') { await sponsor.settle(c, 'pay:' + p.id); if (payer === 'wallet') await sponsor.breaker(c); }
        await c.query("UPDATE relay_cw_payments SET status='succeeded',reserved_raw=0,fee_raw=$2,receipt=$3,updated_at=now() WHERE id=$1", [p.id, fee.toString(), receipt]);
        await note(c, owner, p.wallet_id, p.id, 'payment_succeeded', `${p.service}: paid ${units(amount)} USDC${simulated ? ` (fee ${units(fee)})` : ''}.`);
      } else if (out?.state === 'failed') {
        await release();
        if (p.fee_asset === 'sponsored') { if (out.nothingSent === true) await sponsor.release(c, 'pay:' + p.id); else await sponsor.settle(c, 'pay:' + p.id); }
        const gasText = !simulated && p.fee_asset === 'ETH' && typeof out.networkFee === 'string' && /^\d+(\.\d{1,18})?$/.test(out.networkFee) && Number(out.networkFee) > 0 ? out.networkFee : null;
        await c.query("UPDATE relay_cw_payments SET status='failed',reserved_raw=0,reject_reason=$2,receipt=$3,updated_at=now() WHERE id=$1", [p.id, out.reason ?? 'The network did not accept it.', gasText ? {failedOnChain: true, networkFee: `${gasText} ${net.nativeSymbol}`, amountUsdc: units(amount), simulated} : null]);
        await note(c, owner, p.wallet_id, p.id, 'payment_failed', gasText
          ? `${p.service}: the payment failed on the network. No USDC was sent, but the network still charged a fee of ${gasText} ${net.nativeSymbol}.`
          : out.nothingSent === false ? `${p.service}: the network reported a failure.` : `${p.service}: did not send. No USDC left your wallet.`);
      } else if (out?.state === 'pending_challenge' || out?.state === 'pending') {
        // Real provider: waiting for the customer to approve in their wallet. Tokens are never stored.
        await c.query('UPDATE relay_cw_payments SET provider_state=$2,updated_at=now() WHERE id=$1', [p.id, {state: out.state, challengeId: out.challengeId ?? p.provider_state?.challengeId ?? null, tokenId: out.tokenId ?? p.provider_state?.tokenId ?? null, nativeBeforeWei: p.provider_state?.nativeBeforeWei ?? null}]);
        await note(c, owner, p.wallet_id, p.id, 'payment_waiting_wallet', `${p.service}: waiting for you to approve in your wallet.`);
      } else {
        // Uncertain, malformed or UNVERIFIED outcome: keep the reservation, never retry, never guess.
        await c.query("UPDATE relay_cw_payments SET status='outcome_unknown',updated_at=now() WHERE id=$1", [p.id]);
        await note(c, owner, p.wallet_id, p.id, 'payment_unknown', `${p.service}: the result is unknown${out?.reason ? ' (' + out.reason + ')' : ''}. Funds stay reserved and nothing will be retried automatically.`);
      }
      return view((await fullRow(c, owner, id)).rows[0]);
    });
  }

  // The x402 counterpart of finish(): one attempt has been made, and this is what it produced.
  async function finishX402(owner, id, out) {
    return tx(async c => {
      const p = await lockPayment(c, owner, id);
      if (!p) throw new InputError('Not found.', 404);
      if (p.status !== 'approved') return view((await fullRow(c, owner, id)).rows[0]);
      const cap = big(p.cap_raw);
      const release = async () => {
        if (!p.allowance_id) return;
        await c.query('UPDATE relay_cw_allowances SET reserved_raw=greatest(reserved_raw-$2,0),updated_at=now() WHERE id=$1', [p.allowance_id, cap.toString()]);
      };
      if (out.state === 'succeeded') {
        await c.query("UPDATE relay_cw_payments SET status='succeeded',reserved_raw=0,receipt=$2,x402=$3,updated_at=now() WHERE id=$1",
          [id, {source: 'service', claim: out.settledClaim ?? 'none', settlement: out.receipt ?? null, httpStatus: out.httpStatus ?? null},
            {...p.x402, step: 'done', httpStatus: out.httpStatus ?? null, settledClaim: out.settledClaim ?? 'none'}]);
        if (p.allowance_id) {
          await c.query('UPDATE relay_cw_allowances SET reserved_raw=greatest(reserved_raw-$2,0),spent_raw=spent_raw+$2,updated_at=now() WHERE id=$1', [p.allowance_id, cap.toString()]);
        }
        await note(c, owner, p.wallet_id, p.id, 'payment_succeeded', `${p.service}: paid ${units(p.amount_raw)} USDC for one call.${out.settledClaim === 'none' ? ' The service confirmed delivery but sent no settlement receipt.' : ''}`);
      } else if (out.state === 'outcome_unknown') {
        await c.query("UPDATE relay_cw_payments SET status='outcome_unknown',x402=$2,updated_at=now() WHERE id=$1",
          [id, {...p.x402, step: 'unknown', reason: out.reason ?? null}]);
        await note(c, owner, p.wallet_id, p.id, 'payment_unknown', `${p.service}: the result is unknown${out.reason ? ' (' + out.reason + ')' : ''}. Funds stay reserved and nothing will be retried automatically.`);
      } else {
        await release();
        await c.query("UPDATE relay_cw_payments SET status='failed',reserved_raw=0,reject_reason=$2,x402=$3,updated_at=now() WHERE id=$1",
          [id, out.reason ?? 'The service did not deliver.', {...p.x402, step: 'failed', reason: out.reason ?? null, httpStatus: out.httpStatus ?? null}]);
        await note(c, owner, p.wallet_id, p.id, 'payment_failed', `${p.service}: ${out.nothingSent ? 'the payment was refused' : 'the call failed'}. ${out.reason ?? ''} Nothing was delivered.`.trim());
      }
      return view((await fullRow(c, owner, id)).rows[0]);
    });
  }

  // Starts the provider's work for a payment that is ALREADY saved as executing with its reservation committed.
  async function run(owner, id) {
    const p = await tx(async c => (await fullRow(c, owner, id)).rows[0]);
    if (!p || p.kind === 'x402') return null; // x402 is signed and retried, never transferred by Eupova
    if (p.status !== 'executing' || p.provider_state) return null;
    const w = (await query('SELECT provider_ref FROM relay_cw_wallets WHERE id=$1', [p.wallet_id])).rows[0];
    // Live: read the exact USDC token id and save it (and that a submission is starting) BEFORE the request that creates the
    // transaction. If the process dies after that request, the payment can still be found by its reference and checked against this token.
    let tokenId = null;
    if (!simulated) {
      try { tokenId = await provider.resolveUsdcTokenId(owner, w?.provider_ref); } catch { tokenId = null; }
      if (!tokenId) return finish(owner, id, {state: 'failed', reason: 'The wallet\'s USDC could not be identified, so nothing was sent.', nothingSent: true});
      let nativeBeforeWei = null;
      if (p.fee_asset === 'sponsored') { try { nativeBeforeWei = String(await provider.nativeBalanceWei(owner, w?.provider_ref)); } catch { nativeBeforeWei = null; } }
      const saved = await tx(async c => {
        const q = await lockPayment(c, owner, id);
        if (!q || q.status !== 'executing' || q.provider_state) return false;
        await c.query('UPDATE relay_cw_payments SET provider_state=$2,updated_at=now() WHERE id=$1', [id, {phase: 'submitting', tokenId, nativeBeforeWei, startedAt: clock().toISOString()}]);
        return true;
      });
      if (!saved) return null;
    }
    let out;
    try {
      out = await provider.executeTransfer({id: p.id, owner, walletRef: w?.provider_ref, destination: p.destination, amountRaw: p.amount_raw, maxFeeRaw: p.max_fee_raw, service: p.service, fee: p.binding.fee, tokenId});
    } catch { out = {state: 'unknown'}; }
    const done = await finish(owner, id, out);
    if (out?.state === 'pending_challenge' && done) done.challenge = {challengeId: out.challengeId, appId: out.appId, userToken: out.userToken, encryptionKey: out.encryptionKey};
    return done;
  }

  // Field-by-field check of the provider's transaction against what the customer approved. Anything off is NOT success.
  const rawOf = text => (typeof text === 'string' && /^\d{1,12}(\.\d{1,6})?$/.test(text) ? BigInt(text.split('.')[0] + (text.split('.')[1] ?? '').padEnd(6, '0')) : null);
  function verifyTransaction(p, wallet, found) {
    const t = found.tx;
    const bad = [];
    if (t.refId !== p.id) bad.push('reference');
    if (t.walletId !== wallet.provider_ref) bad.push('wallet');
    if (!t.userId || t.userId !== found.expectedUserId) bad.push('owner');
    if (t.blockchain !== net.circleChain) bad.push('network');
    if (String(t.destination ?? '').toLowerCase() !== p.destination) bad.push('recipient');
    if (!(Array.isArray(t.amounts) && t.amounts.length === 1 && rawOf(t.amounts[0]) === big(p.amount_raw))) bad.push('amount');
    if (!p.provider_state?.tokenId || t.tokenId !== p.provider_state.tokenId) bad.push('token');
    if (t.transactionType !== 'OUTBOUND') bad.push('direction');
    return bad;
  }

  return {
    normalise, view, STATUSES, run, finish, liveProblem, insert, detailsHash, sha, estimate, feeAsset,
    // Payments that were approved and reserved, but whose provider call never recorded a result (a crash): never re-sent.
    async sweepStuck(c, owner) {
      const rows = (await c.query("UPDATE relay_cw_payments SET status='outcome_unknown',updated_at=now() WHERE owner=$1 AND kind='transfer' AND status='executing' AND provider_state IS NULL AND updated_at < now() - interval '2 minutes' RETURNING id,wallet_id,service", [owner])).rows;
      for (const r of rows) await note(c, owner, r.wallet_id, r.id, 'payment_unknown', `${r.service}: the app stopped before the result was recorded. Funds stay reserved and nothing will be sent again automatically.`);
    },
    async migrate(c) {
      await c.query(`CREATE TABLE IF NOT EXISTS relay_cw_payments(
        id uuid PRIMARY KEY, owner text NOT NULL, wallet_id uuid NOT NULL REFERENCES relay_cw_wallets(id), origin text NOT NULL CHECK(origin IN ('customer','tool')),
        tool_id uuid REFERENCES relay_cw_tools(id), allowance_id uuid REFERENCES relay_cw_allowances(id), allowance_revision integer,
        request_id text NOT NULL, service text NOT NULL, destination text NOT NULL, network text NOT NULL, token text NOT NULL CHECK(token='USDC'),
        amount_raw numeric(38,0) NOT NULL CHECK(amount_raw>0), max_fee_raw numeric(38,0) NOT NULL CHECK(max_fee_raw>=0), cap_raw numeric(38,0) NOT NULL CHECK(cap_raw=amount_raw+max_fee_raw),
        status text NOT NULL CHECK(status IN (${STATUSES})), reject_reason text, binding jsonb NOT NULL, binding_hash text NOT NULL, details_hash text NOT NULL,
        reserved_raw numeric(38,0) NOT NULL DEFAULT 0 CHECK(reserved_raw>=0), fee_raw numeric(38,0), receipt jsonb, provider_state jsonb,
        expires_at timestamptz NOT NULL, decided_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
        CHECK((origin='tool') = (tool_id IS NOT NULL)))`);
      // Additive upgrades for databases created by the earlier test-only build. Nothing is dropped or rewritten.
      await c.query("ALTER TABLE relay_cw_payments ADD COLUMN IF NOT EXISTS fee_asset text NOT NULL DEFAULT 'USDC'");
      await c.query('ALTER TABLE relay_cw_payments ADD COLUMN IF NOT EXISTS native_fee_cap_wei numeric(38,0) NOT NULL DEFAULT 0');
      await c.query('ALTER TABLE relay_cw_payments ADD COLUMN IF NOT EXISTS last_checked_at timestamptz');
      await c.query('ALTER TABLE relay_cw_payments DROP CONSTRAINT IF EXISTS relay_cw_payments_network_check');
      await c.query("ALTER TABLE relay_cw_payments ADD CONSTRAINT relay_cw_payments_network_check CHECK(network IN ('base_sepolia','base'))");
      await c.query('ALTER TABLE relay_cw_payments DROP CONSTRAINT IF EXISTS relay_cw_payments_fee_asset_check');
      await c.query("ALTER TABLE relay_cw_payments ADD CONSTRAINT relay_cw_payments_fee_asset_check CHECK(fee_asset IN ('USDC','ETH','sponsored') AND (fee_asset='ETH' OR native_fee_cap_wei=0) AND (fee_asset='USDC' OR max_fee_raw=0))");
      // x402 payments are the same ledger with a different kind: the same reservation, the same allowance arithmetic,
      // the same approval. What differs is that the customer signs an EIP-3009 authorization instead of a transfer.
      await c.query("ALTER TABLE relay_cw_payments ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'transfer'");
      await c.query('ALTER TABLE relay_cw_payments DROP CONSTRAINT IF EXISTS relay_cw_payments_kind_check');
      await c.query("ALTER TABLE relay_cw_payments ADD CONSTRAINT relay_cw_payments_kind_check CHECK(kind IN ('transfer','x402'))");
      await c.query('ALTER TABLE relay_cw_payments ADD COLUMN IF NOT EXISTS x402 jsonb');
      // One live authorization per requirement per wallet. Circle's SDK cannot deduplicate a signing request, so the
      // database has to: a second prompt for the same requirement would otherwise be a second signable authorization.
      await c.query("CREATE UNIQUE INDEX IF NOT EXISTS relay_cw_payments_x402_ref ON relay_cw_payments(wallet_id, (x402->>'requirementRef')) WHERE kind='x402' AND status IN ('awaiting_approval','approved','executing')");
      await c.query("CREATE UNIQUE INDEX IF NOT EXISTS relay_cw_payments_request ON relay_cw_payments(owner, origin, coalesce(tool_id::text,''), request_id)");
      await c.query('CREATE INDEX IF NOT EXISTS relay_cw_payments_wallet ON relay_cw_payments(wallet_id, created_at DESC)');
    },

    async list(owner, walletId) {
      return tx(async c => {
        const names = await toolNames(c, owner);
        const rows = (await c.query('SELECT *, amount_raw::text AS amount_raw, max_fee_raw::text AS max_fee_raw, cap_raw::text AS cap_raw, native_fee_cap_wei::text AS native_fee_cap_wei FROM relay_cw_payments WHERE owner=$1 AND wallet_id=$2 ORDER BY created_at DESC LIMIT 50', [owner, walletId])).rows;
        return rows.map(r => view(r, {toolNames: names}));
      });
    },

    // Customer-started payment ("Send"): still individually approved, but needs no allowance.
    async send(owner, input) {
      if (!uuid(input?.requestId)) throw new InputError('Refresh and try again.');
      const w0 = (await query('SELECT * FROM relay_cw_wallets WHERE owner=$1', [owner])).rows[0];
      if (!w0 || w0.status !== 'ready') throw new InputError('Create your wallet first.', 409);
      let n; try { n = normalise({...input, service: input.service ?? 'Send'}, w0); } catch (e) { throw new InputError(e.message); }
      const fee = await estimate(owner, w0, n); // read-only, before anything is saved
      return tx(async c => {
        await lockWallet(c, w0.id);
        const w = (await c.query('SELECT * FROM relay_cw_wallets WHERE id=$1 FOR UPDATE', [w0.id])).rows[0];
        const old = (await c.query("SELECT id,details_hash FROM relay_cw_payments WHERE owner=$1 AND origin='customer' AND request_id=$2", [owner, input.requestId])).rows[0];
        if (old) { if (old.details_hash !== detailsHash(n)) throw new InputError('This request was already used for different details.', 409); return {id: old.id}; }
        const avail = (await balanceOf(c, w)) - (await reservedTotal(c, w.id));
        if (avail < n.capRaw) throw new InputError(rejectReasons.insufficient_balance, 409);
        return {id: await insert(c, owner, w, n, {origin: 'customer', requestId: input.requestId, status: 'awaiting_approval', fee})};
      });
    },

    // The customer's decision. `bindingHash` is the fingerprint they were shown; anything that has changed since refuses.
    async decide(owner, input) {
      if (!uuid(input?.id) || !['approve', 'decline'].includes(input.decision) || typeof input.bindingHash !== 'string') throw new InputError('Check the request.');
      const result = await tx(async c => {
        const p = await lockPayment(c, owner, input.id);
        if (!p) throw new InputError('Not found.', 404);
        if (input.bindingHash !== p.binding_hash) return {error: 'The details on your screen are out of date. Review the request again.', code: 409};
        const wanted = input.decision === 'approve' ? ['executing', 'succeeded', 'outcome_unknown', 'failed'] : ['declined'];
        if (wanted.includes(p.status) && (input.decision === 'decline' || p.decided_at)) return {id: p.id, again: true};
        if (p.status !== 'awaiting_approval') return {error: 'This request can no longer be decided.', code: 409};
        const w = (await c.query('SELECT * FROM relay_cw_wallets WHERE id=$1 FOR UPDATE', [p.wallet_id])).rows[0];
        if (new Date(p.expires_at) <= clock()) {
          await c.query("UPDATE relay_cw_payments SET status='expired',updated_at=now() WHERE id=$1", [p.id]);
          await note(c, owner, p.wallet_id, p.id, 'payment_expired', `${p.service}: the request lapsed before it was approved.`);
          return {error: 'This request lapsed. Ask for a new one.', code: 409};
        }
        if (input.decision === 'decline') {
          // An x402 approval reserves the allowance the moment it starts. Declining has to give that back, or a payment
          // the customer never made quietly eats into what the tool is allowed to ask for.
          if (p.kind === 'x402' && p.allowance_id && big(p.reserved_raw) > 0n) {
            await c.query('UPDATE relay_cw_allowances SET reserved_raw=greatest(reserved_raw-$2,0),updated_at=now() WHERE id=$1', [p.allowance_id, big(p.reserved_raw).toString()]);
          }
          await c.query("UPDATE relay_cw_payments SET status='declined',decided_at=now(),reserved_raw=0,updated_at=now() WHERE id=$1", [p.id]);
          await note(c, owner, p.wallet_id, p.id, 'payment_declined', `${p.service}: you declined. Nothing was paid.`);
          return {id: p.id};
        }
        // An x402 payment is approved by signing an authorization, not by sending a transfer. Same order as a transfer:
        // reserve first, then ask the wallet. The provider call happens outside this transaction, like run() does.
        if (p.kind === 'x402') {
          if (simulated) return {error: 'Agent payments do not exist in the simulated wallet.', code: 409};
          let x = p.x402 ?? {};
          // A challenge that lapsed is not a decision the customer made. Let the authorization be rebuilt rather than
          // trapping the payment in a state nobody can move.
          if (x.step === 'challenged' && Number(x.authorization?.validBefore) <= Math.floor(clock().getTime() / 1000)) {
            const rebuilt = prepareApproval({requirement: x.requirement, walletAddress: w.address, nowSeconds: Math.floor(clock().getTime() / 1000), chainId: net.chainId});
            x = {...rebuilt, step: 'prepared', host: x.host, method: x.method, body: x.body};
          }
          const can = canChallenge({...x, step: x.step ?? 'prepared'});
          if (!can.ok) return {error: can.reason, code: 409};
          const capX = big(p.cap_raw);
          let balX; try { balX = await balanceOf(c, w); } catch { return {error: rejectReasons.fee_unavailable, code: 503}; }
          if (balX - (await reservedTotal(c, w.id)) < capX) return reject('insufficient_balance');
          try {
            if (p.allowance_id) await c.query('UPDATE relay_cw_allowances SET reserved_raw=reserved_raw+$2,updated_at=now() WHERE id=$1', [p.allowance_id, capX.toString()]);
          } catch (e) {
            if (e.code !== '23514') throw e;
            return {error: rejectReasons.over_allowance, code: 409};
          }
          await c.query("UPDATE relay_cw_payments SET x402=$2,reserved_raw=$3,decided_at=now(),updated_at=now() WHERE id=$1", [p.id, {...x, step: 'challenged'}, capX.toString()]);
          await note(c, owner, p.wallet_id, p.id, 'payment_approved', `${p.service}: you approved paying ${units(p.amount_raw)} USDC for one call. Waiting for your signature.`);
          return {id: p.id, signX402: true};
        }
        // Recheck everything now, against the live rows. Fail closed.
        const problem = await liveProblem(c, owner, p, w);
        if (problem) {
          const status = ['over_allowance', 'insufficient_balance'].includes(problem) ? 'rejected' : 'invalidated';
          await c.query('UPDATE relay_cw_payments SET status=$2,reject_reason=$3,updated_at=now() WHERE id=$1', [p.id, status, problem]);
          await note(c, owner, p.wallet_id, p.id, 'payment_' + status, `${p.service}: ${rejectReasons[problem] ?? 'The details changed, so the approval was cancelled.'}`);
          return {error: rejectReasons[problem] ?? 'The details changed, so this approval was cancelled. Nothing was paid.', code: 409};
        }
        const cap = big(p.cap_raw);
        const reject = async code => {
          await c.query('UPDATE relay_cw_payments SET status=$2,reject_reason=$3,updated_at=now() WHERE id=$1', [p.id, 'rejected', code]);
          await note(c, owner, p.wallet_id, p.id, 'payment_rejected', `${p.service}: ${rejectReasons[code]}`);
          return {error: rejectReasons[code], code: 409};
        };
        let bal; try { bal = await balanceOf(c, w); } catch { return {error: rejectReasons.fee_unavailable, code: 503}; }
        if (bal - (await reservedTotal(c, w.id)) < cap) return reject('insufficient_balance');
        if (p.fee_asset === 'ETH') {
          let gas; try { gas = big(await provider.nativeBalanceWei(owner, w.provider_ref)); } catch { return {error: rejectReasons.fee_unavailable, code: 503}; }
          if (gas - (await nativeReserved(c, w.id)) < big(p.native_fee_cap_wei)) return reject('insufficient_gas');
        }
        try {
          if (p.allowance_id) await c.query('UPDATE relay_cw_allowances SET reserved_raw=reserved_raw+$2,updated_at=now() WHERE id=$1', [p.allowance_id, cap.toString()]);
        } catch (e) {
          if (e.code !== '23514') throw e;
          return {error: rejectReasons.over_allowance, code: 409};
        }
        if (p.fee_asset === 'sponsored' && !(await sponsor.reserve(c, 'pay:' + p.id, 1))) return reject('sponsorship_exhausted');
        // Saved BEFORE the provider is asked: the reservation and the executing status commit first.
        await c.query("UPDATE relay_cw_payments SET status='executing',reserved_raw=$2,decided_at=now(),updated_at=now() WHERE id=$1", [p.id, cap.toString()]);
        await note(c, owner, p.wallet_id, p.id, 'payment_approved', `${p.service}: you approved ${units(p.amount_raw)} USDC${p.fee_asset === 'ETH' ? ` plus an estimated network fee of about ${nativeText(p.native_fee_cap_wei)} ${net.nativeSymbol}` : p.fee_asset === 'sponsored' ? ' (network fee sponsored)' : ` (up to ${units(p.cap_raw)} with fees)`}.`);
        return {id: p.id, run: true};
      });
      if (result.error) throw new InputError(result.error, result.code);
      if (result.run) return {id: result.id, ...(await run(owner, result.id) ?? {})};
      if (result.signX402) {
        // Outside the lock, like every other provider call. A challenge, never a signature.
        const row = (await query('SELECT x402, wallet_id, service, amount_raw FROM relay_cw_payments WHERE id=$1', [result.id])).rows[0];
        const w = (await query('SELECT provider_ref FROM relay_cw_wallets WHERE id=$1', [row.wallet_id])).rows[0];
        const challenge = await provider.signTypedData({
          owner, walletRef: w.provider_ref, typedData: row.x402.typedData, refId: result.id,
          memo: `${serviceName(row.service)}: ${units(row.amount_raw)} USDC for one call`,
        });
        return {id: result.id, challenge};
      }
      return {id: result.id};
    },

    // The customer completed the signing step. Verify it against the record we hold, then keep it. The signature is
    // single-use and time-bound, so a failed check is a security event: fail closed, release the reservation, and do
    // not offer a second attempt on the same authorization.
    async completeX402(owner, input) {
      if (!uuid(input?.id) || typeof input.signature !== 'string') throw new InputError('Check the request.');
      const result = await tx(async c => {
        const p = await lockPayment(c, owner, input.id);
        if (!p) throw new InputError('Not found.', 404);
        if (p.kind !== 'x402') throw new InputError('This payment does not use a signature.', 409);
        if (p.x402?.step !== 'challenged') return {error: 'There is no signing step open for this payment.', code: 409};
        const w = (await c.query('SELECT * FROM relay_cw_wallets WHERE id=$1', [p.wallet_id])).rows[0];
        const check = await completeApproval({record: p.x402, signature: input.signature, walletAddress: w.address, nowSeconds: Math.floor(clock().getTime() / 1000)});
        if (!check.ok) {
          await c.query("UPDATE relay_cw_payments SET status='rejected',reject_reason='signature',reserved_raw=0,x402=$2,updated_at=now() WHERE id=$1",
            [p.id, {...p.x402, step: 'rejected', reason: check.reason}]);
          if (p.allowance_id) await c.query("UPDATE relay_cw_allowances SET reserved_raw=greatest(reserved_raw-$2,0),updated_at=now() WHERE id=$1", [p.allowance_id, big(p.cap_raw).toString()]);
          await note(c, owner, p.wallet_id, p.id, 'payment_rejected', `${p.service}: the signature did not match this payment, so it was cancelled. Nothing was paid.`);
          return {error: check.reason, code: 409};
        }
        await c.query("UPDATE relay_cw_payments SET status='approved',x402=$2,updated_at=now() WHERE id=$1",
          [p.id, {...p.x402, step: 'signed', signature: input.signature, ref: check.ref}]);
        await note(c, owner, p.wallet_id, p.id, 'payment_signed', `${p.service}: you signed one authorization for ${units(p.amount_raw)} USDC. It is single-use and expires shortly.`);
        return {id: p.id};
      });
      if (result.error) throw new InputError(result.error, result.code);
      // The signature is saved and the money is reserved. Now the call itself, outside any transaction.
      const row = await tx(async c => (await fullRow(c, owner, result.id)).rows[0]);
      const outcome = await executeX402({payment: row, fetchImpl});
      return finishX402(owner, result.id, outcome);
    },

    // A fresh browser session for a challenge that is already open (the page was closed mid-approval). Started by the customer only.
    // If the process died after the request was made but before the challenge was saved, the same request is replayed with the SAME
    // idempotency key (Circle documents that this returns the original rather than creating a second one: not yet verified live).
    async resumeChallenge(owner, id) {
      if (simulated) throw new InputError('Not found.', 404);
      const p = await tx(async c => (await fullRow(c, owner, id)).rows[0]);
      if (!p) throw new InputError('Not found.', 404);
      if (p.status !== 'executing' || !p.provider_state?.tokenId) throw new InputError('There is nothing to resume for this payment.', 409);
      if (p.provider_state.challengeId) return {id: p.id, challenge: {challengeId: p.provider_state.challengeId, ...(await provider.resumeSession(owner))}};
      const w = (await query('SELECT provider_ref FROM relay_cw_wallets WHERE id=$1', [p.wallet_id])).rows[0];
      let out; try { out = await provider.executeTransfer({id: p.id, owner, walletRef: w?.provider_ref, destination: p.destination, amountRaw: p.amount_raw, maxFeeRaw: p.max_fee_raw, service: p.service, fee: p.binding.fee, tokenId: p.provider_state.tokenId}); } catch { out = null; }
      if (out?.state !== 'pending_challenge' || !out.challengeId) throw new InputError('We could not reopen the approval. Use Check again; nothing has been sent twice.', 409);
      await finish(owner, id, out);
      return {id: p.id, challenge: {challengeId: out.challengeId, appId: out.appId, userToken: out.userToken, encryptionKey: out.encryptionKey}};
    },

    // After "unknown". A live payment is settled only by the network record, never by what the customer says happened.
    async reconcile(owner, input) {
      if (!uuid(input?.id) || !['not_sent', 'sent'].includes(input.outcome)) throw new InputError('Check the request.');
      if (!simulated) {
        if (input.outcome === 'sent') throw new InputError('A real payment is recorded as paid only when the network confirms it. Use Check again.', 409);
        // "Not sent" is NEVER accepted on a live payment because of an empty or failed lookup: lists can lag, and an open approval can
        // still be completed later. Only the network's own terminal FAILED/DENIED/CANCELLED record frees the funds, and that is what Check again does.
        const done = await this.refresh(owner, input.id);
        if (done?.status === 'failed') return {id: done.id};
        throw new InputError('The network has not reported this payment as failed or cancelled, so the funds stay reserved. Use Check again later.', 409);
      }
      return tx(async c => {
        const p = await lockPayment(c, owner, input.id);
        if (!p) throw new InputError('Not found.', 404);
        if (p.status !== 'outcome_unknown') throw new InputError('This payment does not need checking.', 409);
        const cap = big(p.cap_raw);
        if (input.outcome === 'not_sent') {
          if (p.allowance_id) await c.query('UPDATE relay_cw_allowances SET reserved_raw=reserved_raw-$2,updated_at=now() WHERE id=$1', [p.allowance_id, cap.toString()]);
          await c.query("UPDATE relay_cw_payments SET status='failed',reserved_raw=0,reject_reason='You confirmed it was not sent.',updated_at=now() WHERE id=$1", [p.id]);
          await note(c, owner, p.wallet_id, p.id, 'payment_reconciled', `${p.service}: ${simulated ? 'you confirmed' : 'the network record confirms'} nothing was sent. The funds are free again.`);
        } else {
          await c.query("INSERT INTO relay_cw_ledger(id,wallet_id,owner,kind,direction,amount_raw,ref,payment_id,label,simulated) VALUES($1,$2,$3,'payment','out',$4,$5,$6,$7,true)", [randomUUID(), p.wallet_id, owner, cap.toString(), 'pay:' + p.id, p.id, `${p.service}: payment (you confirmed it was sent)`]);
          if (p.allowance_id) await c.query('UPDATE relay_cw_allowances SET reserved_raw=reserved_raw-$2, spent_raw=spent_raw+$2, updated_at=now() WHERE id=$1', [p.allowance_id, cap.toString()]);
          await c.query("UPDATE relay_cw_payments SET status='succeeded',reserved_raw=0,fee_raw=max_fee_raw,receipt=$2,updated_at=now() WHERE id=$1", [p.id, {ref: null, amountUsdc: units(p.amount_raw), feeUsdc: units(p.max_fee_raw), totalUsdc: units(p.cap_raw), service: p.service, destination: p.destination, network: net.label, token: 'USDC', at: clock().toISOString(), simulated: true, note: 'Simulation: you said it was sent. Recorded with the maximum fee.'}]);
          await note(c, owner, p.wallet_id, p.id, 'payment_reconciled', `${p.service}: you confirmed it was sent. Recorded with the maximum fee.`);
        }
        return {id: p.id};
      });
    },

    // Real provider only. Asks the network what happened to a payment the customer approved, and trusts it only after the
    // transaction matches the approval field by field. A mismatch, a duplicate or a doubtful lookup never counts as paid.
    async refresh(owner, id) {
      const p = await tx(async c => (await fullRow(c, owner, id)).rows[0]);
      if (!p) throw new InputError('Not found.', 404);
      if (simulated || !['executing', 'outcome_unknown'].includes(p.status) || !p.provider_state?.tokenId) return view(p);
      const w = (await query('SELECT provider_ref FROM relay_cw_wallets WHERE id=$1', [p.wallet_id])).rows[0];
      let found; try { found = await provider.findTransaction({owner, walletRef: w?.provider_ref, refId: p.id, destination: p.destination}); } catch { return view(p); }
      if (found.uncertain) return p.status === 'executing' ? finish(owner, id, {state: 'unknown', reason: 'the network lookup was not conclusive'}) : view(p);
      if (!found.found) return view(p); // the customer has not approved in their wallet yet
      const bad = verifyTransaction(p, w, found);
      if (bad.length) return p.status === 'executing' ? finish(owner, id, {state: 'unknown', reason: 'the network record did not match: ' + bad.join(', ')}) : view(p);
      const st = found.tx.state;
      if (st === 'COMPLETE') {
        if (p.status === 'outcome_unknown') await tx(async c => { const q = await lockPayment(c, owner, id); if (q?.status === 'outcome_unknown') await c.query("UPDATE relay_cw_payments SET status='executing',updated_at=now() WHERE id=$1", [id]); });
        let nativeAfterWei = null;
        if (p.fee_asset === 'sponsored') { try { nativeAfterWei = String(await provider.nativeBalanceWei(owner, w?.provider_ref)); } catch { nativeAfterWei = null; } }
        return finish(owner, id, {state: 'confirmed', verified: true, ref: found.tx.txHash, networkFee: found.tx.networkFee, nativeAfterWei});
      }
      if (['FAILED', 'DENIED', 'CANCELLED'].includes(st)) {
        if (p.status === 'outcome_unknown') await tx(async c => { const q = await lockPayment(c, owner, id); if (q?.status === 'outcome_unknown') await c.query("UPDATE relay_cw_payments SET status='executing',updated_at=now() WHERE id=$1", [id]); });
        return finish(owner, id, {state: 'failed', reason: 'The network reported ' + st.toLowerCase() + '.', networkFee: found.tx.networkFee, nothingSent: false});
      }
      return view(p); // INITIATED, QUEUED, CLEARED, SENT, CONFIRMED, STUCK: not terminal, keep waiting and keep the reservation
    },

    // Bounded background reconciliation. Called on state reads and tool status reads: at most `max` payments per call, each checked at most
    // once per `gapSeconds` (claimed in one statement, so parallel readers cannot stampede the provider). Read-only toward the network.
    async reconcileOpen(owner, {max = 3, gapSeconds = 8} = {}) {
      if (simulated) return 0;
      const claimed = (await query(`UPDATE relay_cw_payments SET last_checked_at=now() WHERE id IN (SELECT id FROM relay_cw_payments WHERE owner=$1 AND status IN ('executing','outcome_unknown')
        AND provider_state ? 'tokenId' AND (last_checked_at IS NULL OR last_checked_at < now() - ($2 || ' seconds')::interval) ORDER BY created_at LIMIT $3 FOR UPDATE SKIP LOCKED) RETURNING id`, [owner, String(gapSeconds), max])).rows;
      for (const r of claimed) { try { await this.refresh(owner, r.id); } catch { /* a failed lookup changes nothing */ } }
      return claimed.length;
    },

    // Used by tools.mjs: cancels waiting approvals when something they were bound to changes.
    async invalidateOpen(c, owner, where, text) {
      const rows = (await c.query(`UPDATE relay_cw_payments SET status='invalidated',reject_reason=$3,updated_at=now() WHERE owner=$1 AND status='awaiting_approval' AND ${where.column}=$2 RETURNING id,wallet_id,service`, [owner, where.value, where.reason])).rows;
      for (const r of rows) await note(c, owner, r.wallet_id, r.id, 'payment_invalidated', `${r.service}: ${text}`);
      return rows.length;
    },
    get: async (owner, id) => tx(async c => { const r = (await fullRow(c, owner, id)).rows[0]; if (!r) throw new InputError('Not found.', 404); return view(r, {toolNames: await toolNames(c, owner)}); }),
    insertForTool: insert,
    reasons: rejectReasons,
  };
}
