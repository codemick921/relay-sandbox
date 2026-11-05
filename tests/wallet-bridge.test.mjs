import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {fixture} from './fixtures/account-store.mjs';
import {createCustomerWallet} from '../hosted/customer-wallet.mjs';
import {liveProvider, FEE, ETH} from './fixtures/live-provider.mjs';
import {BRIDGE_ROUTES, routeForNetwork} from '../shared/wallet-bridge-route.mjs';
import {WALLET_NETWORKS} from '../shared/wallet-model.mjs';

const owner = 'customer:' + randomUUID(), other = 'customer:' + randomUUID();
const ARC_ADDR = '0x' + 'e'.repeat(40), NONCE = '4242', DEST_TX = '0x' + '3'.repeat(64), BURN_TX = '0x' + '1'.repeat(64);
const R = BRIDGE_ROUTES.mainnet;

// A scripted transport: every answer is whatever the test sets; it records what it was asked to do.
function transport(st) {
  const log = (k, v) => { (st[k] ??= []).push(v); };
  return {
    async quote(q) { log('quotes', q); if (st.quoteFails) throw new Error('down'); return {maxUsdcFeeRaw: st.quoteFee ?? '200000', maxNativeFeeWei: st.quoteNative ?? '0', minFinalityThreshold: st.quoteFinality ?? 1000}; },
    async allowance() { if (st.allowanceThrows) throw new Error('rpc'); return st.allowance ?? '0'; },
    async submitApprove(p) { log('approves', p); if (st.approveThrows) throw new Error('timeout'); return {challengeId: 'approve-' + st.approves.length, appId: 'a', userToken: 'T-USER-TOKEN', encryptionKey: 'E-KEY'}; },
    async submitBurn(p) { log('burns', p); if (st.burnThrows) throw new Error('timeout'); return {challengeId: 'burn-' + st.burns.length, appId: 'a', userToken: 'T-USER-TOKEN', encryptionKey: 'E-KEY'}; },
    async findApprove() { return st.approve ?? {found: false}; },
    async findBurn() { return st.burn ?? {found: false}; },
    async attestation() { return st.att ?? {status: 'pending'}; },
    async verifyDestination() { return st.dest ?? {found: false}; },
  };
}
async function setup(netId = 'base', over = {}) {
  const f = await fixture();
  const st = {calls: [], wallets: {}, usdc: {}, eth: {}, fee: FEE, found: {found: false}, quotes: [], approves: [], burns: [], ...over};
  const cw = createCustomerWallet({store: f.store, provider: liveProvider(netId, st), config: {}, bridgeTransport: transport(st)});
  await cw.migrate();
  return {...f, cw, st};
}
async function ready(f, who = owner, usdc = 50_000_000n, eth = ETH) {
  await f.cw.createWallet(who, {label: 'My Eupova wallet', requestId: randomUUID()});
  f.st.wallets[who] = {providerRef: 'w-' + who.slice(-6), address: '0x' + 'a'.repeat(34) + who.slice(-6).replace(/[^0-9a-f]/g, 'b').padEnd(6, 'b'), state: 'ready'};
  await f.cw.finishSetup(who); f.st.usdc[who] = usdc; f.st.eth[who] = eth;
}
const req = (f, who = owner, over = {}) => f.cw.bridge.request(who, {requestId: randomUUID(), recipient: ARC_ADDR, amount: '10', confirmDestination: true, ...over});
const fp = async (f, id, who = owner) => (await f.cw.bridge.state(who)).items.find(i => i.id === id).fingerprint;
const approve = async (f, id, who = owner) => f.cw.bridge.decide(who, {id, decision: 'approve', bindingHash: await fp(f, id, who)});
const row = async (f, id) => (await f.store.query('SELECT * FROM relay_cw_bridges WHERE id=$1', [id])).rows[0];
async function bindingOf(f, id) { const b = await row(f, id); const w = (await f.store.query('SELECT provider_ref FROM relay_cw_wallets WHERE id=$1', [b.wallet_id])).rows[0]; return {b: b.binding, ref: w.provider_ref}; }
const approveTx = async (f, id, over = {}) => { const {b, ref} = await bindingOf(f, id); return {found: true, expectedUserId: 'u', tx: {state: 'COMPLETE', walletId: ref, contractOk: true, userId: 'u', ...over}}; };
const burnTx = async (f, id, over = {}) => { const {b, ref} = await bindingOf(f, id); return {found: true, expectedUserId: 'u', tx: {walletId: ref, chainId: b.source.chainId, contract: R.source.tokenMessenger, burnToken: b.source.token, amountRaw: b.amountRaw, destinationDomain: 26,
  mintRecipient: b.destination.recipient, from: b.source.address, state: 'COMPLETE', txHash: BURN_TX, eventNonce: NONCE, userId: 'u', ...over}}; };
const ZERO = '0x' + '0'.repeat(40);
const arrival = async (f, id, over = {}) => { const {b} = await bindingOf(f, id); return {found: true, success: true, finalized: true, chainId: 5042, token: R.destination.usdc, txHash: DEST_TX,
  message: {nonce: NONCE, sourceDomain: 6, sender: R.source.tokenMessenger.toLowerCase(), burnToken: b.source.token, mintRecipient: b.destination.recipient, amount: b.amountRaw, messageSender: b.source.address, feeExecuted: '100000'},
  credits: [{from: ZERO, to: b.destination.recipient, amountRaw: '9900000'}], ...over}; };
const attested = {status: 'complete', eventNonce: NONCE, destinationTxHash: DEST_TX, forwardState: 'COMPLETE'};

test('route table is pinned to Circle Bridge Kit data and never mixes mainnet with testnet', async () => {
  assert.equal(routeForNetwork('base').destination.chainId, 5042);
  assert.equal(routeForNetwork('base_sepolia').destination.chainId, 5042002);
  assert.equal(BRIDGE_ROUTES.mainnet.destination.circleChain, 'ARC'); assert.equal(BRIDGE_ROUTES.testnet.destination.circleChain, 'ARC-TESTNET');
  for (const [env, r] of Object.entries(BRIDGE_ROUTES)) {
    assert.equal(r.environment, env); assert.equal(WALLET_NETWORKS[r.source.networkId].environment, env); assert.equal(WALLET_NETWORKS[r.source.networkId].chainId, r.source.chainId);
  }
  // Resolve the package the way Node does from this file, so a normal install at the repo root is found. A missing dependency FAILS.
  const resolved = createRequire(import.meta.url).resolve('@circle-fin/bridge-kit');
  const kit = new (await import(pathToFileURL(resolved).href)).BridgeKit(); const chains = Object.fromEntries(kit.getSupportedChains().map(c => [c.chain, c]));
  for (const r of Object.values(BRIDGE_ROUTES)) {
    const s = chains[r.source.kitId], d = chains[r.destination.kitId];
    assert.equal(s.chainId, r.source.chainId); assert.equal(s.cctp.domain, r.source.domain); assert.equal(s.usdcAddress.toLowerCase(), r.source.usdc.toLowerCase());
    assert.equal(s.cctp.contracts.v2.tokenMessenger.toLowerCase(), r.source.tokenMessenger.toLowerCase());
    assert.equal(d.chainId, r.destination.chainId); assert.equal(d.cctp.domain, r.destination.domain); assert.equal(d.usdcAddress.toLowerCase(), r.destination.usdc.toLowerCase());
    assert.equal(d.cctp.contracts.v2.messageTransmitter.toLowerCase(), r.destination.messageTransmitter.toLowerCase());
    assert.equal(s.isTestnet, r.environment === 'testnet'); assert.equal(d.isTestnet, r.environment === 'testnet'); assert.equal(d.cctp.forwarderSupported.destination, true);
  }
});

test('without an installed transport the move is unavailable, says why, and refuses everything', async () => {
  const f = await fixture(); const st = {calls: [], wallets: {}, usdc: {}, eth: {}, fee: FEE, found: {found: false}};
  const cw = createCustomerWallet({store: f.store, provider: liveProvider('base', st), config: {}});
  await cw.migrate();
  const s = await cw.bridge.state(owner);
  assert.equal(s.available, false); assert.match(s.reason, /transport/i);
  for (const call of [() => cw.bridge.request(owner, {requestId: randomUUID(), recipient: ARC_ADDR, amount: '1'}), () => cw.bridge.decide(owner, {id: randomUUID(), decision: 'approve', bindingHash: 'x'}),
    () => cw.bridge.continue(owner, randomUUID()), () => cw.bridge.refresh(owner, randomUUID())]) await assert.rejects(call(), e => e.status === 503);
});

test('the full move: approve USDC use, continue, burn verified, attested, arrival verified on Arc by its own message and finality', async () => {
  const f = await setup(); await ready(f);
  const {id} = await req(f);
  assert.equal(f.st.approves.length + f.st.burns.length, 0, 'nothing is sent before approval');
  const item = (await f.cw.bridge.state(owner)).items[0];
  assert.equal(item.environment, 'mainnet'); assert.equal(item.binding.destination.chainId, 5042); assert.equal(item.binding.fees.minFinalityThreshold, 1000); assert.equal(item.binding.destination.recipient, ARC_ADDR);
  await assert.rejects(f.cw.bridge.decide(owner, {id, decision: 'approve', bindingHash: 'stale'}), e => e.status === 409);
  const r = await approve(f, id);
  assert.equal(f.st.approves.length, 1, 'allowance is 0, so the approval step comes first'); assert.equal(f.st.burns.length, 0); assert.ok(r.challenge.challengeId);
  assert.equal((await f.cw.state(owner)).balance.reservedUsdc, '10.000000');
  assert.equal((await f.cw.bridge.refresh(owner, id)).status, 'executing_burn', 'no record yet: unchanged');
  f.st.approve = await approveTx(f, id);
  let v = await f.cw.bridge.refresh(owner, id);
  assert.equal(v.step, 'burn_ready'); assert.equal(v.canContinue, true); assert.equal(f.st.burns.length, 0, 'the burn is never started automatically');
  const c = await f.cw.bridge.continue(owner, id);
  assert.ok(c.challenge.challengeId); assert.equal(f.st.burns.length, 1);
  assert.equal(f.st.burns[0].binding.fees.maxUsdcFeeRaw, '200000');
  f.st.burn = await burnTx(f, id);
  v = await f.cw.bridge.refresh(owner, id);
  assert.equal(v.status, 'awaiting_attestation'); assert.equal(v.burn.eventNonce, NONCE);
  assert.equal((await f.cw.state(owner)).balance.reservedUsdc, '0.000000', 'released once the burn is confirmed');
  assert.equal((await f.cw.bridge.refresh(owner, id)).status, 'awaiting_attestation');
  f.st.att = attested;
  assert.equal((await f.cw.bridge.refresh(owner, id)).status, 'awaiting_destination');
  f.st.dest = await arrival(f, id);
  const done = await f.cw.bridge.refresh(owner, id);
  assert.equal(done.status, 'completed'); assert.equal(done.destination.amountRaw, '9900000'); assert.equal(done.destination.nonce, NONCE); assert.equal(done.destination.feeExecutedRaw, '100000');
  assert.equal(f.st.burns.length, 1, 'exactly one burn challenge was ever created');
});

test('enough allowance already: the move goes straight to the burn step', async () => {
  const f = await setup('base', {allowance: '10000000'}); await ready(f);
  const {id} = await req(f); const r = await approve(f, id);
  assert.equal(f.st.approves.length, 0); assert.equal(f.st.burns.length, 1); assert.ok(r.challenge.challengeId);
});

test('a burn that does not match the approval is never accepted, and nothing is repeated', async () => {
  const f = await setup(); let n = 0;
  for (const bad of [{amountRaw: '10000001'}, {mintRecipient: '0x' + 'f'.repeat(40)}, {destinationDomain: 7}, {burnToken: '0x' + '9'.repeat(40)}, {from: '0x' + '9'.repeat(40)}, {walletId: 'other'}, {chainId: 1}, {contract: '0x' + '8'.repeat(40)}, {userId: 'someone-else'}]) {
    const o = 'customer:' + randomUUID(); await ready(f, o); const {id} = await req(f, o);
    f.st.allowance = '10000000'; await approve(f, id, o); n++;
    f.st.burn = await burnTx(f, id, bad);
    assert.equal((await f.cw.bridge.refresh(o, id)).status, 'outcome_unknown', JSON.stringify(bad));
    assert.equal(f.st.burns.length, n, 'nothing was repeated');
    assert.equal((await f.cw.state(o)).balance.reservedUsdc, '10.000000', 'reservation kept on uncertainty');
  }
});

test('arrival must match THIS message: its own MessageReceived (nonce, domain, sender, burn body) and an exact mint to the recipient', async () => {
  const f = await setup('base', {allowance: '10000000'});
  const m = async (id, over) => (await arrival(f, id)).message && {...(await arrival(f, id)).message, ...over};
  const cases = [
    ['other nonce', async id => ({message: await m(id, {nonce: '999'})})], ['other source domain', async id => ({message: await m(id, {sourceDomain: 7})})],
    ['other sender', async id => ({message: await m(id, {sender: '0x' + '5'.repeat(40)})})], ['other burn token', async id => ({message: await m(id, {burnToken: '0x' + '6'.repeat(40)})})],
    ['other mint recipient', async id => ({message: await m(id, {mintRecipient: '0x' + '7'.repeat(40)})})], ['other amount', async id => ({message: await m(id, {amount: '10000001'})})],
    ['other depositor', async id => ({message: await m(id, {messageSender: '0x' + '8'.repeat(40)})})], ['fee above the approved maximum', async id => ({message: await m(id, {feeExecuted: '300000'}), credits: [{from: ZERO, to: ARC_ADDR, amountRaw: '9700000'}]})],
    ['no MessageReceived in the receipt (an unrelated transaction)', async () => ({message: null})], ['not final', async () => ({finalized: false})], ['transaction failed', async () => ({success: false})],
    ['wrong chain', async () => ({chainId: 8453})], ['wrong token', async () => ({token: '0x' + '4'.repeat(40)})], ['no credit', async () => ({credits: []})],
    ['credit to someone else', async () => ({credits: [{from: ZERO, to: '0x' + '7'.repeat(40), amountRaw: '9900000'}]})], ['credit not minted (from a holder)', async () => ({credits: [{from: '0x' + '1'.repeat(40), to: ARC_ADDR, amountRaw: '9900000'}]})],
    ['credit larger than the mint', async () => ({credits: [{from: ZERO, to: ARC_ADDR, amountRaw: '9900001'}]})], ['credit smaller than the mint', async () => ({credits: [{from: ZERO, to: ARC_ADDR, amountRaw: '9000000'}]})],
  ];
  for (const [name, mk] of cases) {
    const o = 'customer:' + randomUUID(); await ready(f, o); const {id} = await req(f, o);
    await approve(f, id, o); f.st.burn = await burnTx(f, id); await f.cw.bridge.refresh(o, id);
    f.st.att = attested; await f.cw.bridge.refresh(o, id);
    f.st.dest = await arrival(f, id, await mk(id));
    assert.equal((await f.cw.bridge.refresh(o, id)).status, 'destination_unconfirmed', name);
    f.st.dest = await arrival(f, id);                                     // the right record later: it recovers
    assert.equal((await f.cw.bridge.refresh(o, id)).status, 'completed', name);
  }
  // an attestation whose nonce differs from the burn's own never moves past attestation
  const o = 'customer:' + randomUUID(); await ready(f, o); const {id} = await req(f, o); await approve(f, id, o);
  f.st.burn = await burnTx(f, id); await f.cw.bridge.refresh(o, id); f.st.att = {...attested, eventNonce: '1'};
  assert.equal((await f.cw.bridge.refresh(o, id)).status, 'awaiting_attestation');
});

test('crash recovery: a lost response is found again by the durable step reference, and nothing is sent twice', async () => {
  // approval step: the request was sent but the answer was lost
  let f = await setup(); await ready(f); let {id} = await req(f);
  f.st.approveThrows = true; await approve(f, id);
  let r = await row(f, id);
  assert.equal(r.status, 'outcome_unknown'); assert.deepEqual([r.provider_state.step, r.provider_state.phase], ['approve', 'submitting']);
  assert.equal((await f.store.query("SELECT count(*) c FROM relay_cw_bridges WHERE reserved_raw>0")).rows[0].c * 1, 1, 'reservation kept');
  f.st.approve = await approveTx(f, id);                                 // Circle did create and complete it
  let v = await f.cw.bridge.refresh(owner, id);
  assert.equal(v.step, 'burn_ready'); assert.equal(f.st.approves.length, 1, 'refresh never re-sends');
  // burn step: same, found without the customer pressing anything
  f = await setup('base', {allowance: '10000000'}); await ready(f); ({id} = await req(f));
  f.st.burnThrows = true; await approve(f, id);
  assert.equal((await row(f, id)).status, 'outcome_unknown');
  f.st.burn = await burnTx(f, id);
  assert.equal((await f.cw.bridge.refresh(owner, id)).status, 'awaiting_attestation'); assert.equal(f.st.burns.length, 1);
  // a lost response with no record: Continue replays the SAME idempotent request, once
  f = await setup('base', {allowance: '10000000'}); await ready(f); ({id} = await req(f));
  f.st.burnThrows = true; await approve(f, id); f.st.burnThrows = false;
  const c = await f.cw.bridge.continue(owner, id);
  assert.ok(c.challenge.challengeId); assert.equal(f.st.burns.length, 2); assert.equal(f.st.burns[0].bridgeId, f.st.burns[1].bridgeId, 'same bridge reference');
  // failed record releases; unreadable allowance starts nothing
  f.st.burn = await burnTx(f, id, {state: 'FAILED'}); assert.equal((await f.cw.bridge.refresh(owner, id)).status, 'failed_before_burn');
  f = await setup(); await ready(f); ({id} = await req(f)); f.st.allowanceThrows = true;
  await assert.rejects(approve(f, id), e => e.status === 503);
  assert.equal((await row(f, id)).status, 'failed_before_burn'); assert.equal(f.st.approves.length + f.st.burns.length, 0);
});

test('one reservation ledger: an Arc move and a payment cannot both spend one balance, in either order', async () => {
  for (const first of ['payment', 'bridge']) {
    const f = await setup('base', {allowance: '10000000'}); await ready(f, owner, 15_000_000n);
    const pay = await f.cw.payments.send(owner, {requestId: randomUUID(), destination: '0x' + 'd'.repeat(40), amount: '10', service: 'Send'});
    const mv = await req(f);
    const payFp = (await f.cw.state(owner)).payments.find(p => p.id === pay.id).fingerprint, mvFp = await fp(f, mv.id);
    const doPay = () => f.cw.payments.decide(owner, {id: pay.id, decision: 'approve', bindingHash: payFp}), doMove = () => f.cw.bridge.decide(owner, {id: mv.id, decision: 'approve', bindingHash: mvFp});
    const out = await Promise.allSettled(first === 'payment' ? [doPay(), doMove()] : [doMove(), doPay()]);
    assert.equal(out.filter(o => o.status === 'fulfilled').length, 1, `15 USDC covers one 10 USDC use only (${first} first)`);
  }
});

test('ETH is one ledger too: the wallet can pay the network fee of only one open thing', async () => {
  const f = await setup('base', {allowance: '10000000', quoteNative: '600000000000000'}); await ready(f, owner, 50_000_000n, 1_000_000_000_000_000n);
  const pay = await f.cw.payments.send(owner, {requestId: randomUUID(), destination: '0x' + 'd'.repeat(40), amount: '2', service: 'Send'});   // estimate 0.001 ETH
  const mv = await req(f);                                                                                                                       // 0.0006 ETH
  await f.cw.payments.decide(owner, {id: pay.id, decision: 'approve', bindingHash: (await f.cw.state(owner)).payments.find(p => p.id === pay.id).fingerprint});
  await assert.rejects(approve(f, mv.id), e => e.status === 409 && /ETH/.test(e.message));
  assert.equal(f.st.burns.length, 0);
});

test('request safety: idempotent, precise, bounded, owner-scoped, balance-checked, decline and expiry', async () => {
  const f = await setup(); await ready(f); await ready(f, other);
  const rid = randomUUID(); const a = await req(f, owner, {requestId: rid}); const b = await req(f, owner, {requestId: rid});
  assert.equal(a.id, b.id);
  await assert.rejects(req(f, owner, {requestId: rid, amount: '11'}), e => e.status === 409);
  for (const amount of ['0', '1.1234567', '1e2', '-1', '1001', '', 'abc']) await assert.rejects(req(f, owner, {amount}), /./, amount);
  for (const recipient of ['0x123', '0x' + '0'.repeat(40), R.destination.usdc, 'not-an-address']) await assert.rejects(req(f, owner, {recipient}), /Arc address/, recipient);
  await assert.rejects(f.cw.bridge.decide(other, {id: a.id, decision: 'approve', bindingHash: 'x'}), e => e.status === 404);
  await assert.rejects(f.cw.bridge.refresh(other, a.id), e => e.status === 404); await assert.rejects(f.cw.bridge.continue(other, a.id), e => e.status === 404);
  assert.equal((await f.cw.bridge.state(other)).items.length, 0);
  const d = await req(f); await f.cw.bridge.decide(owner, {id: d.id, decision: 'decline', bindingHash: await fp(f, d.id)});
  assert.equal((await f.cw.bridge.state(owner)).items.find(i => i.id === d.id).status, 'declined');
  f.st.usdc[owner] = 5_000_000n; const big = await req(f);
  await assert.rejects(approve(f, big.id), e => e.status === 409);
  assert.equal(f.st.approves.length + f.st.burns.length, 0);
  f.st.usdc[owner] = 50_000_000n; const x = await req(f, owner, {requestId: randomUUID()});
  await f.store.query("UPDATE relay_cw_bridges SET expires_at=now()-interval '1 minute' WHERE id=$1", [x.id]);
  await assert.rejects(approve(f, x.id), e => e.status === 409);
  f.st.quoteFails = true; await assert.rejects(req(f), e => e.status === 503);
  assert.equal((await f.store.query("SELECT count(*) c FROM relay_cw_bridges WHERE owner=$1", [owner])).rows[0].c * 1, 4, 'a failed quote saved nothing');
});

test('concurrency: parallel approvals of one move start one step; two moves cannot spend one balance', async () => {
  const f = await setup('base', {allowance: '10000000'}); await ready(f, owner, 15_000_000n);
  const one = await req(f); const h = await fp(f, one.id);
  const par = await Promise.allSettled(Array.from({length: 6}, () => f.cw.bridge.decide(owner, {id: one.id, decision: 'approve', bindingHash: h})));
  assert.equal(f.st.burns.length, 1, 'one burn challenge'); assert.ok(par.some(p => p.status === 'fulfilled'));
  const m = await Promise.all([req(f, other), req(f, other), req(f, other)].map(async p => p.catch(() => null))); void m;
  const f2 = await setup('base', {allowance: '10000000'}); await ready(f2, owner, 15_000_000n);
  const ms = await Promise.all([req(f2), req(f2), req(f2)]); const hs = await Promise.all(ms.map(x => fp(f2, x.id)));
  const out = await Promise.allSettled(ms.map((x, i) => f2.cw.bridge.decide(owner, {id: x.id, decision: 'approve', bindingHash: hs[i]})));
  assert.equal(out.filter(o => o.status === 'fulfilled').length, 1, '15 USDC covers one 10 USDC move only'); assert.equal(f2.st.burns.length, 1);
});

test('secrets from the transport are returned once and never stored or logged', async () => {
  const f = await setup('base', {allowance: '10000000'}); await ready(f); const {id} = await req(f);
  const r = await approve(f, id);
  assert.equal(r.challenge.userToken, 'T-USER-TOKEN');
  const dump = JSON.stringify((await f.store.query('SELECT * FROM relay_cw_bridges')).rows) + JSON.stringify((await f.store.query('SELECT * FROM relay_cw_events')).rows) + JSON.stringify(await f.cw.state(owner));
  assert.doesNotMatch(dump, /T-USER-TOKEN|E-KEY/);
});

test('a payment\'s reservation counts against a move: 8 of 10 USDC reserved leaves too little for 5', async () => {
  const f = await setup('base', {allowance: '10000000'}); await ready(f, owner, 10_000_000n);
  const pay = await f.cw.payments.send(owner, {requestId: randomUUID(), destination: '0x' + 'd'.repeat(40), amount: '8', service: 'Send'});
  await f.cw.payments.decide(owner, {id: pay.id, decision: 'approve', bindingHash: (await f.cw.state(owner)).payments.find(p => p.id === pay.id).fingerprint});
  const mv = await req(f, owner, {amount: '5'});
  await assert.rejects(approve(f, mv.id), e => e.status === 409 && /enough USDC/.test(e.message));
  assert.equal(f.st.approves.length + f.st.burns.length, 0);
  assert.equal((await row(f, mv.id)).status, 'failed_before_burn');
});

test('a lost saved step does not hide a completed burn: it is found by the durable bridge reference', async () => {
  const f = await setup('base', {allowance: '10000000'}); await ready(f);
  const {id} = await req(f); await approve(f, id);
  await f.store.query('UPDATE relay_cw_bridges SET provider_state=NULL WHERE id=$1', [id]);                      // the saved step is gone
  f.st.burn = await burnTx(f, id);
  const v = await f.cw.bridge.refresh(owner, id);
  assert.equal(v.status, 'awaiting_attestation'); assert.equal(f.st.burns.length, 1, 'found, not re-sent');
  assert.equal((await f.cw.state(owner)).balance.reservedUsdc, '0.000000');
  // and with nothing found, a lost step just waits; the reservation stays
  const g = await setup('base', {allowance: '10000000'}); await ready(g);
  const m = await req(g); await approve(g, m.id); await g.store.query('UPDATE relay_cw_bridges SET provider_state=NULL WHERE id=$1', [m.id]);
  assert.equal((await g.cw.bridge.refresh(owner, m.id)).status, 'executing_burn'); assert.equal((await g.cw.state(owner)).balance.reservedUsdc, '10.000000');
});

test('fees are re-quoted fresh at approval: a higher fee schedule cancels the approval instead of being accepted', async () => {
  const f = await setup('base', {allowance: '10000000'}); await ready(f);
  const {id} = await req(f); const h = await fp(f, id);
  f.st.quoteFee = '300000';
  await assert.rejects(f.cw.bridge.decide(owner, {id, decision: 'approve', bindingHash: h}), e => e.status === 409 && /fees changed/.test(e.message));
  assert.equal((await row(f, id)).status, 'invalidated'); assert.equal(f.st.burns.length + f.st.approves.length, 0);
  const g = await setup('base', {allowance: '10000000'}); await ready(g);
  const m = await req(g); const hm = await fp(g, m.id); g.st.quoteFee = '100000';                                    // cheaper is fine
  assert.ok((await g.cw.bridge.decide(owner, {id: m.id, decision: 'approve', bindingHash: hm})).challenge);
  const k = await setup('base', {allowance: '10000000'}); await ready(k);
  const n = await req(k); const hn = await fp(k, n.id); k.st.quoteFinality = 2000;                                     // a different finality is a different product
  await assert.rejects(k.cw.bridge.decide(owner, {id: n.id, decision: 'approve', bindingHash: hn}), e => e.status === 409);
  const d = await setup('base', {allowance: '10000000'}); await ready(d);
  const q = await req(d); const hq = await fp(d, q.id); d.st.quoteFails = true;
  await assert.rejects(d.cw.bridge.decide(owner, {id: q.id, decision: 'approve', bindingHash: hq}), e => e.status === 503);
  assert.equal((await row(d, q.id)).status, 'awaiting_approval', 'an unreadable quote starts nothing and keeps the request');
});

test('sponsored network fees: a move reserves two sponsored transactions and is refused when today\'s budget cannot cover them', async () => {
  const f = await fixture(); const st = {calls: [], wallets: {}, usdc: {}, eth: {}, fee: {asset: 'sponsored', maxFeeNativeWei: '0'}, feeAsset: 'sponsored', found: {found: false}, quotes: [], approves: [], burns: [], allowance: '10000000'};
  const cw = createCustomerWallet({store: f.store, provider: liveProvider('base', st), config: {gasDailyUsd: '0.25', gasPerTxUsd: '0.05'}, bridgeTransport: transport(st)}); await cw.migrate();
  const g = {...f, cw, st}; await ready(g, owner, 100_000_000n, 0n);
  const ids = []; for (let i = 0; i < 3; i++) ids.push((await req(g, owner, {amount: '5'})).id);
  assert.equal((await approve(g, ids[0])).challenge.challengeId, 'burn-1');                                  // 0.10 of 0.25 reserved
  assert.equal((await approve(g, ids[1])).challenge.challengeId, 'burn-2');                                  // 0.20
  await assert.rejects(approve(g, ids[2]), e => e.status === 409 && /sponsorship has been used up/.test(e.message));
  assert.equal(st.burns.length, 2);
  await assert.rejects(req(g, owner, {amount: '5'}), e => e.status === 409 && /used up/.test(e.message));
  assert.equal((await g.store.query("SELECT count(*) c FROM relay_cw_sponsor WHERE ref LIKE 'bridge:%' AND state='reserved'")).rows[0].c * 1, 2);
});

test('a smart-account wallet cannot send to its own Base address on Arc: that address is not automatically the customer\'s there', async () => {
  const f = await fixture(); const st = {calls: [], wallets: {}, usdc: {}, eth: {}, fee: FEE, found: {found: false}, quotes: [], approves: [], burns: []};
  const prov = liveProvider('base', st); prov.feeModel = {asset: 'ETH', accountType: 'SCA'};
  const cw = createCustomerWallet({store: f.store, provider: prov, config: {}, bridgeTransport: transport(st)}); await cw.migrate();
  await cw.createWallet(owner, {label: 'My Eupova wallet', requestId: randomUUID()});
  st.wallets[owner] = {providerRef: 'w1', address: '0x' + 'a'.repeat(40), state: 'ready'}; await cw.finishSetup(owner); st.usdc[owner] = 50_000_000n; st.eth[owner] = ETH;
  await assert.rejects(cw.bridge.request(owner, {requestId: randomUUID(), recipient: '0x' + 'a'.repeat(40), amount: '5'}), e => e.status === 409 && /not automatically yours on Arc/.test(e.message));
  await assert.rejects(cw.bridge.request(owner, {requestId: randomUUID(), recipient: '', amount: '5'}), /Arc address/);
  assert.ok((await cw.bridge.request(owner, {requestId: randomUUID(), recipient: ARC_ADDR, amount: '5', confirmDestination:true})).id, 'an explicit Arc address is accepted');
});

test('the destination is an explicit, confirmed Arc address; the Base wallet\'s own address is never accepted', async () => {
  const f = await setup(); await ready(f);
  const own = f.st.wallets[owner].address;
  // Not the same address in any spelling, and not by default: a Base smart-account address is not established as deployed or controlled on Arc.
  for (const recipient of [own, own.toUpperCase().replace('0X', '0x'), ' ' + own + ' ']) await assert.rejects(req(f, owner, {recipient}), e => e.status === 409 && /Base wallet/.test(e.message), recipient);
  await assert.rejects(req(f, owner, {recipient: ''}), /Arc address/);
  await assert.rejects(req(f, owner, {recipient: undefined}), /Arc address/);
  await assert.rejects(req(f, owner, {confirmDestination: false}), /Confirm that you control/);
  await assert.rejects(req(f, owner, {confirmDestination: 'true'}), /Confirm that you control/);
  await assert.rejects(f.cw.bridge.request(owner, {requestId: randomUUID(), recipient: ARC_ADDR, amount: '10'}), /Confirm that you control/);
  assert.equal((await f.store.query('SELECT count(*) c FROM relay_cw_bridges')).rows[0].c * 1, 0, 'nothing was saved by any refused request');
  const ok = await req(f);                                                                                  // an explicit, different, confirmed address
  assert.equal((await row(f, ok.id)).binding.destination.confirmedByCustomer, true);
  assert.equal(f.st.approves.length + f.st.burns.length, 0);
  // Another customer's wallet address is no different: it is simply some other address and is the customer's own responsibility to confirm.
  await ready(f, other);
  assert.ok(await req(f, owner, {recipient: f.st.wallets[other].address}));
});
