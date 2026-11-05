// Live Base -> Arc move for the customer's own wallet (CCTP v2 with Circle's Forwarding Service). Provider-neutral state machine: it saves what the customer approved,
// asks the transport to do ONE thing at a time, and accepts a step only when the network's own record equals the approval.
// It never trusts a customer statement, never retries a burn, and never calls a move "completed" before the destination
// chain shows the mint to the approved recipient. Without a transport it reports itself unavailable and refuses everything.
import {createHash, randomUUID} from 'node:crypto';
import {canonicalBinding} from '../shared/arc-funding.mjs';
import {parseUsdc, units} from '../shared/wallet-model.mjs';
import {BRIDGE_LIMITS, routeForNetwork} from '../shared/wallet-bridge-route.mjs';

class BridgeError extends Error { constructor(m, status = 400) { super(m); this.status = status; } }
const hash = o => createHash('sha256').update(canonicalBinding(o)).digest('hex');
const ADDR = /^0x[a-fA-F0-9]{40}$/;
export const BRIDGE_STATUS = Object.freeze({
  awaiting_approval: 'Waiting for your approval', declined: 'You declined', invalidated: 'Approval cancelled: details changed', expired: 'Lapsed',
  executing_burn: 'Waiting for you to approve in your wallet', burn_confirmed: 'Left your Base wallet', awaiting_attestation: 'Circle is confirming it',
  awaiting_destination: 'Arriving on Arc', completed: 'Arrived on Arc', failed_before_burn: 'Did not start. Nothing left your wallet',
  outcome_unknown: 'We could not confirm it. Nothing was repeated', destination_unconfirmed: 'Left Base but the arrival is not confirmed',
});

export function createWalletBridge({tx, query, clock, note, lockWallet, balanceOf, reservedTotal, nativeReservedTotal, sponsor, provider, networkId, transport = null}) {
  const route = routeForNetwork(networkId);
  const unavailable = !route ? 'This network has no Arc route.' : !transport ? 'The live Base to Arc transport is not installed in this deployment.' : null;
  const need = () => { if (unavailable) throw new BridgeError(`Moving USDC to Arc is not available yet. ${unavailable}`, 503); };
  const stepLabel = r => r.status !== 'executing_burn' ? null : ({approve: 'Waiting for you to approve USDC use in your wallet', burn_ready: 'USDC use approved. Continue to move it', burn: 'Waiting for you to approve the move in your wallet', allowance_check: 'Getting ready'})[r.provider_state?.step] ?? null;
  const view = r => ({id: r.id, status: r.status, statusLabel: stepLabel(r) ?? BRIDGE_STATUS[r.status] ?? r.status, recipient: r.recipient, amountUsdc: units(r.amount_raw), route: route.label,
    environment: route.environment, fingerprint: r.binding_hash, binding: r.binding, canApprove: r.status === 'awaiting_approval' && new Date(r.expires_at) > clock(),
    canContinue: ['executing_burn', 'outcome_unknown'].includes(r.status) && ['burn_ready', 'approve', 'burn'].includes(r.provider_state?.step) && r.provider_state?.step !== 'allowance_check',
    step: r.provider_state?.step ?? null, burn: r.burn ?? null, attestation: r.attestation ?? null, destination: r.destination ?? null, createdAt: r.created_at});
  const bind = (w, d) => ({v: 2, environment: route.environment,
    source: {walletId: w.id, address: String(w.address).toLowerCase(), networkId: route.source.networkId, chainId: route.source.chainId, domain: route.source.domain, token: route.source.usdc.toLowerCase()},
    destination: {chainId: route.destination.chainId, domain: route.destination.domain, recipient: d.recipient.toLowerCase(), token: route.destination.usdc.toLowerCase(), confirmedByCustomer: true},
    amountRaw: String(d.amountRaw), fees: {maxUsdcFeeRaw: String(d.fees.maxUsdcFeeRaw), maxNativeFeeWei: String(d.fees.maxNativeFeeWei ?? '0'), minFinalityThreshold: Number(d.fees.minFinalityThreshold ?? 2000), basis: 'circle_fee_api_high_plus_protocol_and_gas_estimate'}, requestId: d.requestId});
  const save = async (c, id, status, extra = {}) => { await save0(c, id, status, extra); if (extra.sponsor === 'settle') await sponsor.settle(c, 'bridge:' + id); if (extra.sponsor === 'release') await sponsor.release(c, 'bridge:' + id); };
  const save0 = (c, id, status, extra = {}) => c.query(`UPDATE relay_cw_bridges SET status=$2, burn=COALESCE($3::jsonb,burn), attestation=COALESCE($4::jsonb,attestation), destination=COALESCE($5::jsonb,destination),
    reserved_raw=COALESCE($6::numeric,reserved_raw), native_reserved_wei=COALESCE($7::numeric,native_reserved_wei), provider_state=COALESCE($8::jsonb,provider_state), updated_at=now() WHERE id=$1`,
    [id, status, extra.burn ? JSON.stringify(extra.burn) : null, extra.attestation ? JSON.stringify(extra.attestation) : null, extra.destination ? JSON.stringify(extra.destination) : null, extra.reserved ?? null, extra.native ?? null, extra.state ? JSON.stringify(extra.state) : null]);
  const lockRow = async (c, owner, id) => {
    const pre = (await c.query('SELECT wallet_id FROM relay_cw_bridges WHERE id=$1 AND owner=$2', [id, owner])).rows[0];
    if (!pre) return null;
    await lockWallet(c, pre.wallet_id);                       // the one lock order: wallet lock first, then rows
    return (await c.query('SELECT * FROM relay_cw_bridges WHERE id=$1 AND owner=$2 FOR UPDATE', [id, owner])).rows[0];
  };
  const getRow = async (owner, id) => (await query('SELECT * FROM relay_cw_bridges WHERE id=$1 AND owner=$2', [id, owner])).rows[0];
  // Saves "this step is starting" BEFORE the request that could create a Circle transaction, then the challenge after it. A crash in
  // between leaves phase "submitting": refresh finds the transaction by its durable reference and "Continue" replays the same idempotent request.
  const phase = (owner, id, state) => tx(async c => { const b = await lockRow(c, owner, id); if (!b || !['executing_burn', 'outcome_unknown'].includes(b.status)) return false; await save(c, id, b.status, {state}); return true; });
  async function submitStep(owner, b, which) {
    const walletRef = (await query('SELECT provider_ref FROM relay_cw_wallets WHERE id=$1', [b.wallet_id])).rows[0]?.provider_ref;
    if (!(await phase(owner, b.id, {step: which, phase: 'submitting', startedAt: clock().toISOString()}))) return null;
    let sent = null;
    try { sent = await (which === 'approve' ? transport.submitApprove : transport.submitBurn)({route, bridgeId: b.id, binding: b.binding, walletRef, owner}); } catch { sent = null; }
    if (!sent?.challengeId) {
      await tx(async c => { const q = await lockRow(c, owner, b.id); if (q?.status === 'executing_burn') await save(c, b.id, 'outcome_unknown'); });
      return null;
    }
    await phase(owner, b.id, {step: which, phase: 'waiting', challengeId: sent.challengeId});
    return sent;
  }
  return {
    unavailable, route,
    async migrate(c) {
      await c.query(`CREATE TABLE IF NOT EXISTS relay_cw_bridges(id uuid PRIMARY KEY, owner text NOT NULL, wallet_id uuid NOT NULL REFERENCES relay_cw_wallets(id), request_id text NOT NULL,
        recipient text NOT NULL CHECK(recipient ~ '^0x[a-f0-9]{40}$'), amount_raw numeric(38,0) NOT NULL CHECK(amount_raw>0),
        status text NOT NULL, binding jsonb NOT NULL, binding_hash text NOT NULL, reserved_raw numeric(38,0) NOT NULL DEFAULT 0, burn jsonb, attestation jsonb, destination jsonb,
        provider_state jsonb, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(owner, request_id))`);
      await c.query('ALTER TABLE relay_cw_bridges ADD COLUMN IF NOT EXISTS native_reserved_wei numeric(38,0) NOT NULL DEFAULT 0');
    },
    async state(owner) {
      const rows = (await query('SELECT * FROM relay_cw_bridges WHERE owner=$1 ORDER BY created_at DESC LIMIT 20', [owner])).rows;
      return {available: !unavailable, reason: unavailable, route: route && {label: route.label, environment: route.environment, destination: route.destination.label, chainId: route.destination.chainId}, items: rows.map(view)};
    },
    // Saves the request. The read-only fee quote happens first; nothing is sent anywhere.
    async request(owner, input) {
      need();
      const requestId = String(input?.requestId ?? '');
      if (!/^[0-9a-f-]{36}$/i.test(requestId)) throw new BridgeError('Missing request id.');
      const recipient = String(input?.recipient ?? '').trim();
      if (!ADDR.test(recipient) || /^0x0{40}$/i.test(recipient) || recipient.toLowerCase() === route.destination.usdc.toLowerCase()) throw new BridgeError('Enter a valid Arc address.');
      // A smart-contract (SCA) wallet's address on Base is NOT automatically controlled by the customer on Arc: USDC minted there could be unreachable.
      // The customer must name an Arc address they control; the wallet's own Base address is refused for SCA accounts.
      const w1 = (await query('SELECT address FROM relay_cw_wallets WHERE owner=$1', [owner])).rows[0];
      if (provider?.feeModel?.accountType === 'SCA' && w1 && recipient.toLowerCase() === String(w1.address).toLowerCase()) throw new BridgeError('A smart-account address on Base is not automatically yours on Arc. Enter an Arc address you control.', 409);
      let amountRaw; try { amountRaw = parseUsdc(input?.amount); } catch (e) { throw new BridgeError(e.message); }
      if (amountRaw > parseUsdc(BRIDGE_LIMITS.maxAmountUsdc)) throw new BridgeError('That is more than this wallet allows per move.');
      const w0 = (await query('SELECT * FROM relay_cw_wallets WHERE owner=$1', [owner])).rows[0];
      if (!w0 || w0.status !== 'ready') throw new BridgeError('Finish creating your wallet first.', 409);
      // The destination must be an address the customer says they control on Arc, confirmed explicitly. The Base wallet's own address is refused: it is
      // (for a smart account) a Base contract account, and nothing here establishes that it is deployed on, or controlled from, Arc. Funds minted to an
      // address nobody can use cannot be recovered. (If a supported Arc wallet deployment is ever verified, that path is the only one to add.)
      if (input?.confirmDestination !== true) throw new BridgeError('Confirm that you control this address on Arc before continuing.');
      if (recipient.toLowerCase() === String(w0.address).toLowerCase()) throw new BridgeError('That is your Base wallet\'s address. Control of the same address on Arc has not been set up, so USDC sent there could be out of reach. Enter an Arc address that you control.', 409);
      let fees; try { fees = await transport.quote({route, amountRaw: String(amountRaw), recipient: recipient.toLowerCase(), walletRef: w0.provider_ref, owner}); } catch { throw new BridgeError('Could not work out the fees right now. Nothing was saved.', 503); }
      if (sponsor.enabled && !(await sponsor.roomNow(2))) throw new BridgeError("Today's network-fee sponsorship has been used up, so no new moves can start. Nothing was saved. Try again tomorrow.", 409);
      if (!fees || !/^\d+$/.test(String(fees.maxUsdcFeeRaw)) || BigInt(fees.maxUsdcFeeRaw) >= amountRaw) throw new BridgeError('The fees would take all of that amount. Choose a larger amount.', 409);
      return tx(async c => {
        await lockWallet(c, w0.id);
        const w = (await c.query('SELECT * FROM relay_cw_wallets WHERE id=$1 FOR UPDATE', [w0.id])).rows[0];
        const dup = (await c.query('SELECT * FROM relay_cw_bridges WHERE owner=$1 AND request_id=$2', [owner, requestId])).rows[0];
        if (dup) { if (dup.recipient !== recipient.toLowerCase() || String(dup.amount_raw) !== String(amountRaw)) throw new BridgeError('That request id was already used for a different move.', 409); return {id: dup.id}; }
        const open = Number((await c.query("SELECT count(*) FROM relay_cw_bridges WHERE owner=$1 AND status IN ('awaiting_approval','executing_burn','burn_confirmed','awaiting_attestation','awaiting_destination','outcome_unknown')", [owner])).rows[0].count);
        if (open >= BRIDGE_LIMITS.openPerWallet) throw new BridgeError('Finish or decline your open moves first.', 409);
        const binding = bind(w, {recipient, amountRaw, fees, requestId}); const id = randomUUID();
        await c.query(`INSERT INTO relay_cw_bridges(id,owner,wallet_id,request_id,recipient,amount_raw,status,binding,binding_hash,expires_at) VALUES($1,$2,$3,$4,$5,$6,'awaiting_approval',$7,$8,now()+interval '15 minutes')`,
          [id, owner, w.id, requestId, recipient.toLowerCase(), String(amountRaw), JSON.stringify(binding), hash(binding)]);
        await note(c, owner, w.id, null, 'bridge_requested', `Move ${units(amountRaw)} USDC to ${recipient} on ${route.destination.label} is waiting for your approval.`);
        return {id};
      });
    },
    async decide(owner, input) {
      need();
      // A fresh read-only quote BEFORE the approval is taken. If the fee schedule has risen above what the customer was shown, the approval is refused.
      let fresh = null;
      if (input?.decision === 'approve') {
        const pre = await getRow(owner, input?.id);
        if (pre && pre.status === 'awaiting_approval' && new Date(pre.expires_at) > clock()) {
          const wr = (await query('SELECT provider_ref FROM relay_cw_wallets WHERE id=$1', [pre.wallet_id])).rows[0]?.provider_ref;
          try { fresh = await transport.quote({route, amountRaw: String(pre.amount_raw), recipient: pre.recipient, walletRef: wr, owner}); } catch { throw new BridgeError('Could not check the current fees. Nothing was started.', 503); }
        }
      }
      const out = await tx(async c => {
        const b = await lockRow(c, owner, input?.id); if (!b) throw new BridgeError('Not found.', 404);
        if (!['approve', 'decline'].includes(input.decision)) throw new BridgeError('Choose approve or decline.');
        if (b.status !== 'awaiting_approval') throw new BridgeError('This move is no longer waiting for approval.', 409);
        if (input.bindingHash !== b.binding_hash) throw new BridgeError('The details on your screen are out of date. Reload and review them again.', 409);
        if (new Date(b.expires_at) <= clock()) { await save(c, b.id, 'expired'); return {stale: 'This request lapsed. Make a new one.'}; }
        if (input.decision === 'decline') { await save(c, b.id, 'declined'); return {id: b.id}; }
        if (fresh && (BigInt(fresh.maxUsdcFeeRaw) > BigInt(b.binding.fees.maxUsdcFeeRaw) || Number(fresh.minFinalityThreshold) !== Number(b.binding.fees.minFinalityThreshold))) { await save(c, b.id, 'invalidated'); return {stale: 'The fees changed since you reviewed this move, so it was cancelled. Review the new fees and approve again.'}; }
        const w = (await c.query('SELECT * FROM relay_cw_wallets WHERE id=$1 FOR UPDATE', [b.wallet_id])).rows[0];
        const live = bind(w, {recipient: b.recipient, amountRaw: b.amount_raw, fees: b.binding.fees, requestId: b.request_id});
        if (w.status !== 'ready' || hash(live) !== b.binding_hash) { await save(c, b.id, 'invalidated'); return {stale: 'Your wallet changed, so this approval was cancelled.'}; }
        // ONE reservation ledger for USDC and for ETH, shared with payments in both directions.
        if ((await balanceOf(c, w)) - (await reservedTotal(c, w.id)) < BigInt(b.amount_raw)) { await save(c, b.id, 'failed_before_burn'); return {stale: 'Your wallet does not hold enough USDC for this move.'}; }
        const nativeNeed = BigInt(b.binding.fees.maxNativeFeeWei ?? '0');
        if (nativeNeed > 0n && provider?.feeModel?.asset === 'ETH' && (BigInt(await provider.nativeBalanceWei(w.owner, w.provider_ref)) - (await nativeReservedTotal(c, w.id))) < nativeNeed) { await save(c, b.id, 'failed_before_burn'); return {stale: 'Your wallet does not hold enough ETH for the network fees of this move.'}; }
        if (sponsor.enabled && !(await sponsor.reserve(c, 'bridge:' + b.id, 2))) { await save(c, b.id, 'failed_before_burn'); return {stale: "Today's network-fee sponsorship has been used up, so this move was not started and nothing was charged. Try again tomorrow."}; }
        await save(c, b.id, 'executing_burn', {reserved: b.amount_raw, native: nativeNeed.toString(), state: {step: 'allowance_check', phase: 'submitting', startedAt: clock().toISOString()}});
        await note(c, owner, w.id, null, 'bridge_approved', `You approved moving ${units(b.amount_raw)} USDC to ${b.recipient} on ${route.destination.label}.`);
        return {id: b.id};
      });
      if (out.stale) throw new BridgeError(out.stale, 409);
      if (!out.id || input.decision === 'decline') return {id: out.id};
      // Reserved and saved above. Now (and only now) the outside world: read the allowance, then ask for ONE customer-approved step.
      const b = await getRow(owner, out.id);
      let allowance;
      try { allowance = BigInt(await transport.allowance({route, walletAddress: b.binding.source.address})); }
      catch {
        await tx(async c => { const q = await lockRow(c, owner, out.id); if (q?.status === 'executing_burn') { await save(c, out.id, 'failed_before_burn', {reserved: '0', native: '0', sponsor: 'release'}); await note(c, owner, q.wallet_id, null, 'bridge_failed_before_burn', 'The USDC allowance could not be read, so nothing was started.'); } });
        throw new BridgeError('Could not prepare the move. Nothing was sent.', 503);
      }
      const sent = await submitStep(owner, b, allowance >= BigInt(b.amount_raw) ? 'burn' : 'approve');
      return {id: out.id, challenge: sent};
    },
    // The customer continues after the approval step, or reopens a step whose challenge was lost. Customer-started only; each request is idempotent per step.
    async continue(owner, id) {
      need();
      const b = await getRow(owner, id); if (!b) throw new BridgeError('Not found.', 404);
      const st = b.provider_state;
      if (!['executing_burn', 'outcome_unknown'].includes(b.status) || !['burn_ready', 'approve', 'burn'].includes(st?.step)) throw new BridgeError('There is nothing to continue for this move.', 409);
      if (st.challengeId && st.phase === 'waiting') return {id, challenge: {challengeId: st.challengeId, ...(await provider.resumeSession(owner))}};
      if (b.status === 'outcome_unknown') await tx(async c => { const q = await lockRow(c, owner, id); if (q?.status === 'outcome_unknown') await save(c, id, 'executing_burn'); });
      const sent = await submitStep(owner, b, st.step === 'approve' ? 'approve' : 'burn');
      if (!sent) throw new BridgeError('We could not open the wallet step. Nothing has been sent twice. Use Check status.', 409);
      return {id, challenge: sent};
    },
    // Moves a step forward only on the network's own evidence. Safe to call repeatedly; it never starts a burn or an approval.
    async refresh(owner, id) {
      need();
      const b0 = await getRow(owner, id); if (!b0) throw new BridgeError('Not found.', 404);
      const w = (await query('SELECT * FROM relay_cw_wallets WHERE id=$1', [b0.wallet_id])).rows[0];
      const bd = b0.binding; let next = null;
      try {
        // The saved step says where we were; if it is missing (state lost) every possible step is looked up by its durable reference,
        // the burn first, because a verified burn is the one fact that must never be missed.
        const stepSaved = b0.provider_state?.step, open = ['executing_burn', 'outcome_unknown'].includes(b0.status);
        const seesBurn = async () => { try { const f = await transport.findBurn({route, bridgeId: b0.id, walletRef: w.provider_ref, owner, binding: bd}); return !!(f.found || f.uncertain); } catch { return false; } };
        let step = stepSaved;
        if (open && stepSaved === 'burn_ready') step = (await seesBurn()) ? 'burn' : null;        // approved, waiting for Continue: only a burn can change anything
        else if (open && !['approve', 'burn'].includes(stepSaved)) step = (await seesBurn()) ? 'burn' : 'approve';
        if (['executing_burn', 'outcome_unknown'].includes(b0.status) && step === 'approve') {
          const f = await transport.findApprove({route, bridgeId: b0.id, walletRef: w.provider_ref, owner, binding: bd});
          if (f.found && !f.uncertain) {
            const t = f.tx, ok = t.walletId === w.provider_ref && t.contractOk === true && (!t.userId || !f.expectedUserId || t.userId === f.expectedUserId);
            if (!ok) next = {status: 'outcome_unknown'};
            else if (t.state === 'COMPLETE') next = {status: 'executing_burn', state: {step: 'burn_ready', phase: 'ready'}};
            else if (['FAILED', 'DENIED', 'CANCELLED'].includes(t.state)) next = {status: 'failed_before_burn', reserved: '0', native: '0', sponsor: 'settle'};
          }
        } else if (['executing_burn', 'outcome_unknown'].includes(b0.status) && step === 'burn') {
          const f = await transport.findBurn({route, bridgeId: b0.id, walletRef: w.provider_ref, owner, binding: bd});
          if (f.found && !f.uncertain) {
            const v = f.tx;
            const ok = v.walletId === w.provider_ref && v.chainId === bd.source.chainId && String(v.contract).toLowerCase() === route.source.tokenMessenger.toLowerCase() && String(v.burnToken).toLowerCase() === bd.source.token
              && String(v.amountRaw) === bd.amountRaw && Number(v.destinationDomain) === bd.destination.domain && String(v.mintRecipient).toLowerCase() === bd.destination.recipient && String(v.from).toLowerCase() === bd.source.address
              && (!v.userId || !f.expectedUserId || v.userId === f.expectedUserId) && (v.maxFee === undefined || String(v.maxFee) === bd.fees.maxUsdcFeeRaw) && (v.minFinalityThreshold === undefined || Number(v.minFinalityThreshold) === bd.fees.minFinalityThreshold);
            if (v.state === 'COMPLETE' && !ok) next = {status: 'outcome_unknown', note: 'The network record did not match what you approved.'};
            else if (v.state === 'COMPLETE') next = {status: 'awaiting_attestation', burn: {txHash: v.txHash, eventNonce: v.eventNonce ?? null, confirmedAt: clock().toISOString()}, reserved: '0', native: '0', sponsor: 'settle'};
            else if (['FAILED', 'DENIED', 'CANCELLED'].includes(v.state)) next = {status: 'failed_before_burn', reserved: '0', native: '0', sponsor: 'settle'};
          }
        } else if (b0.status === 'awaiting_attestation') {
          const a = await transport.attestation({route, burnTxHash: b0.burn.txHash, binding: bd});
          if (a?.status === 'complete' && a.destinationTxHash && (!b0.burn.eventNonce || String(a.eventNonce) === String(b0.burn.eventNonce)))
            next = {status: 'awaiting_destination', attestation: {eventNonce: String(a.eventNonce), destinationTxHash: a.destinationTxHash, forwardState: a.forwardState ?? null}};
        } else if (['awaiting_destination', 'destination_unconfirmed'].includes(b0.status)) {
          const d = await transport.verifyDestination({route, destinationTxHash: b0.attestation.destinationTxHash, eventNonce: b0.attestation.eventNonce, binding: bd});
          if (d?.found) {
            const m = d.message, lc = v => String(v ?? '').toLowerCase();
            const credit = (d.credits ?? []).filter(x => lc(x.to) === bd.destination.recipient && /^0x0{40}$/.test(lc(x.from))).reduce((n, x) => n + BigInt(x.amountRaw), 0n);
            // THIS receipt's own MessageReceived must be this message (nonce, domain, sender, burn body) and the mint to the recipient must be exactly amount minus the fee executed.
            const ok = d.success === true && d.finalized === true && d.chainId === bd.destination.chainId && lc(d.token) === bd.destination.token && !!m
              && BigInt(m.nonce) === BigInt(b0.attestation.eventNonce) && Number(m.sourceDomain) === bd.source.domain && lc(m.sender) === lc(route.source.tokenMessenger)
              && lc(m.burnToken) === bd.source.token && lc(m.mintRecipient) === bd.destination.recipient && String(m.amount) === bd.amountRaw && lc(m.messageSender) === bd.source.address
              && BigInt(m.feeExecuted) <= BigInt(bd.fees.maxUsdcFeeRaw) && credit === BigInt(m.amount) - BigInt(m.feeExecuted);
            next = ok ? {status: 'completed', destination: {txHash: d.txHash ?? b0.attestation.destinationTxHash, amountRaw: credit.toString(), feeExecutedRaw: String(m.feeExecuted), nonce: String(m.nonce), finalized: true, confirmedAt: clock().toISOString()}}
              : {status: 'destination_unconfirmed', note: 'The arrival on Arc did not match the approval, or is not final yet.'};
          }
        }
      } catch { next = null; }       // a failed lookup changes nothing
      if (next) await tx(async c => {
        const b = await lockRow(c, owner, id);
        if (b && b.status === b0.status && JSON.stringify(b.provider_state ?? null) === JSON.stringify(b0.provider_state ?? null)) { await save(c, id, next.status, next); await note(c, owner, b.wallet_id, null, 'bridge_' + next.status, next.note ?? `Move to Arc: ${BRIDGE_STATUS[next.status]}.`); }
      });
      return view(await getRow(owner, id));
    },
    // Bounded, throttled catch-up for a customer's open moves (called when their wallet state is read).
    async reconcileOpen(owner, {max = 3} = {}) {
      if (unavailable) return 0;
      const rows = (await query("SELECT id FROM relay_cw_bridges WHERE owner=$1 AND status IN ('executing_burn','outcome_unknown','awaiting_attestation','awaiting_destination','destination_unconfirmed') AND updated_at < now() - interval '8 seconds' ORDER BY created_at LIMIT $2", [owner, max])).rows;
      for (const r of rows) { try { await this.refresh(owner, r.id); await query('UPDATE relay_cw_bridges SET updated_at=now() WHERE id=$1 AND updated_at < now() - interval \'8 seconds\'', [r.id]); } catch { /* unchanged */ } }
      return rows.length;
    },
  };
}
