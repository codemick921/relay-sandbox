import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture} from './fixtures/account-store.mjs';
import {digest} from '../hosted/db.mjs';
import {createCustomerWallet} from '../hosted/customer-wallet.mjs';
import {WALLET_NETWORKS} from '../shared/wallet-model.mjs';
import {fundingTarget} from '../src/wallet-view.mjs';
import {liveProvider, FEE, ETH} from './fixtures/live-provider.mjs';

const owner = 'customer:' + randomUUID(), other = 'customer:' + randomUUID();
const DEST = '0x' + 'd'.repeat(40), ADDR = '0x' + 'a'.repeat(40);


async function setup(netId = 'base', over = {}) {
  const f = await fixture();
  const st = {calls: [], wallets: {}, usdc: {}, eth: {}, fee: FEE, found: {found: false}, ...over};
  const cw = createCustomerWallet({store: f.store, provider: liveProvider(netId, st)});
  await cw.migrate();
  return {...f, cw, st};
}
// Create the wallet the live way: saved first, PIN step, then read back.
async function ready(f, who = owner, usdc = 50_000_000n, eth = ETH) {
  const made = await f.cw.createWallet(who, {label: 'My Eupova wallet', requestId: randomUUID()});
  f.st.wallets[who] = {providerRef: 'w-' + who.slice(-6), address: ADDR.slice(0, -6) + who.slice(-6).replace(/[^0-9a-f]/g, 'e').padEnd(6, 'e'), state: 'ready'};
  await f.cw.finishSetup(who);
  f.st.usdc[who] = usdc; f.st.eth[who] = eth;
  return made;
}
const send = (f, who = owner, over = {}) => f.cw.payments.send(who, {requestId: randomUUID(), destination: DEST, amount: '2.50', service: 'Send', ...over});
const view = async (f, id, who = owner) => (await f.cw.state(who)).payments.find(p => p.id === id);
const approve = async (f, id, who = owner) => f.cw.payments.decide(who, {id, decision: 'approve', bindingHash: (await view(f, id, who)).fingerprint});
const txFor = (p, w, over = {}) => ({found: true, expectedUserId: 'uid', tx: {id: 't1', state: 'COMPLETE', userId: 'uid', walletId: w, blockchain: WALLET_NETWORKS.base.circleChain, destination: p.destination, amounts: [p.amountUsdc], tokenId: 'tok-usdc', refId: p.id, txHash: '0xrealhash', networkFee: '0.0005', transactionType: 'OUTBOUND', ...over}});

test('a live wallet is created the live way: saved first, PIN challenge returned once and never stored, read back before it is ready', async () => {
  const f = await setup('base');
  try {
    const made = await f.cw.createWallet(owner, {label: 'My Eupova wallet', requestId: randomUUID()});
    assert.equal(made.challenge.challengeId, 'setup-1');
    let s = await f.cw.state(owner);
    assert.equal(s.wallet.status, 'pending_setup'); assert.equal(s.live, true); assert.equal(s.simulated, false);
    assert.equal(s.network.id, 'base'); assert.equal(s.network.mainnet, true); assert.equal(s.wallet.environment, 'mainnet'); assert.match(s.network.label, /real money/i);
    assert.doesNotMatch(JSON.stringify(s), /SECRET-USER-TOKEN|SECRET-KEY|SECRET-2/);
    assert.equal((await f.store.query('SELECT count(*) FROM relay_agents WHERE owner=$1', [owner])).rows[0].count.toString(), '0');
    await assert.rejects(f.cw.finishSetup(owner), e => e.status === 409);
    await assert.rejects(send(f), e => e.status === 409, 'no payments before the wallet is ready');
    const resumed = await f.cw.resumeSetup(owner);
    assert.equal(resumed.challenge.challengeId, 'setup-1', 'a closed page can resume the same step');
    f.st.wallets[owner] = {providerRef: 'w-1', address: ADDR, state: 'ready'};
    await f.cw.finishSetup(owner); await f.cw.finishSetup(owner);
    s = await f.cw.state(owner);
    assert.equal(s.wallet.status, 'ready'); assert.equal(s.wallet.address, ADDR); assert.match(s.wallet.addressNote, /Base \(mainnet/);
    const agents = (await f.store.query('SELECT id,data FROM relay_agents WHERE owner=$1', [owner])).rows;
    assert.equal(agents.length, 1); assert.equal(s.wallet.savedWalletId, agents[0].id); assert.equal(agents[0].data.address, ADDR);
    // Idempotent creation: the same request id returns the same wallet; a second wallet is refused.
    await assert.rejects(f.cw.createWallet(owner, {label: 'Another', requestId: randomUUID()}), e => e.status === 409);
    // The simulation's test money does not exist here.
    await assert.rejects(f.cw.addTestMoney(owner, {requestId: randomUUID(), pence: 2500}), e => e.status === 404);
    // "Already initialised" means no PIN step, only a read-back.
    const g = await setup('base_sepolia', {initialized: true});
    try { assert.equal((await g.cw.createWallet(owner, {label: 'Existing user', requestId: randomUUID()})).challenge, null); } finally { await g.close(); }
  } finally { await f.close(); }
});

test('exact network and token identity: only this deployment\'s network, USDC by contract address, Base mainnet and Sepolia never mix', async () => {
  for (const [net, wrong] of [['base', 'base_sepolia'], ['base_sepolia', 'base']]) {
    const f = await setup(net);
    try {
      await ready(f);
      await assert.rejects(send(f, owner, {network: wrong}), e => e.status === 400 && /works on/.test(e.message), `${net} deployment refuses ${wrong}`);
      for (const bad of ['ethereum', 'arc_testnet', 'BASE', '']) await assert.rejects(send(f, owner, {network: bad}), e => e.status === 400);
      await assert.rejects(send(f, owner, {token: 'EURC'}), e => e.status === 400);
      await assert.rejects(send(f, owner, {token: 'usdc'}), e => e.status === 400);
      const { id } = await send(f, owner, {network: net});
      const p = await view(f, id);
      assert.equal(p.networkId, net); assert.equal(p.environment, WALLET_NETWORKS[net].environment); assert.equal(p.tokenAddress, WALLET_NETWORKS[net].usdc);
      assert.equal(p.binding.token.address, WALLET_NETWORKS[net].usdc.toLowerCase()); assert.equal(p.binding.token.chainId, WALLET_NETWORKS[net].chainId); assert.equal(p.binding.network.chainId, WALLET_NETWORKS[net].chainId);
      assert.notEqual(WALLET_NETWORKS.base.usdc.toLowerCase(), WALLET_NETWORKS.base_sepolia.usdc.toLowerCase());
    } finally { await f.close(); }
  }
  assert.equal(WALLET_NETWORKS.base.chainId, 8453); assert.equal(WALLET_NETWORKS.base_sepolia.chainId, 84532);
  assert.equal(WALLET_NETWORKS.base.usdc, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'); assert.equal(WALLET_NETWORKS.base_sepolia.usdc, '0x036CbD53842c5426634e7929541eC2318f3dCF7e');
});

test('the network fee is honest: ETH with its own ceiling in the approval, never a USDC amount; failures save nothing', async () => {
  const f = await setup('base');
  try {
    await ready(f);
    await assert.rejects(send(f, owner, {maxFee: '0.05'}), e => e.status === 400 && /paid in ETH/.test(e.message), 'a USDC fee cannot be asked for');
    const { id } = await send(f, owner);
    const p = await view(f, id);
    assert.equal(p.maxFeeUsdc, '0.000000'); assert.equal(p.capUsdc, '2.500000', 'the USDC cap is the amount alone');
    assert.deepEqual({asset: p.fee.asset, nativeMax: p.fee.nativeMax, nativeSymbol: p.fee.nativeSymbol}, {asset: 'ETH', nativeMax: '0.001', nativeSymbol: 'ETH'});
    assert.deepEqual(p.binding.fee, {asset: 'ETH', usdcMaxRaw: '0', nativeMaxWei: String(ETH / 1000n), gasLimit: '65000', maxFee: '2.5', priorityFee: '0.1'});
    assert.equal(p.binding.v, 2);
    // Not enough ETH: refused up front, and nothing is saved.
    f.st.eth[owner] = ETH / 10000n;
    await assert.rejects(send(f, owner, {amount: '1'}), e => e.status === 409 && /ETH/.test(e.message));
    // The fee cannot be worked out: no request is made.
    f.st.eth[owner] = ETH; f.st.feeError = true;
    await assert.rejects(send(f, owner, {amount: '1'}), e => e.status === 503);
    f.st.feeError = false;
    assert.equal((await f.store.query('SELECT count(*) FROM relay_cw_payments WHERE owner=$1', [owner])).rows[0].count.toString(), '1');
    // A sponsored deployment says so and has no ETH ceiling.
    const g = await setup('base_sepolia', {feeAsset: 'sponsored', fee: {asset: 'sponsored', maxFeeNativeWei: '0', gasLimit: null, maxFee: null, priorityFee: null}});
    try {
      await ready(g);
      const q = await view(g, (await send(g)).id);
      assert.deepEqual({asset: q.fee.asset, sponsored: q.fee.sponsored, nativeMax: q.fee.nativeMax}, {asset: 'sponsored', sponsored: true, nativeMax: null});
      assert.equal(q.capUsdc, '2.500000');
    } finally { await g.close(); }
  } finally { await f.close(); }
});

test('approval saves the reservation before the provider is asked; the challenge goes back once and is never stored or logged', async () => {
  const f = await setup('base');
  try {
    await ready(f);
    const { id } = await send(f);
    const before = f.st.calls.length;
    const r = await approve(f, id);
    assert.equal(r.status, 'executing'); assert.equal(r.challenge.userToken, 'SECRET-USER-TOKEN');
    const exec = f.st.calls.filter(c => c.exec); assert.equal(exec.length, 1); assert.equal(f.st.calls.length, before + 1);
    assert.deepEqual(exec[0].exec.fee, {asset: 'ETH', usdcMaxRaw: '0', nativeMaxWei: String(ETH / 1000n), gasLimit: '65000', maxFee: '2.5', priorityFee: '0.1'}, 'the approved gas limits are what is sent');
    const s = await f.cw.state(owner);
    assert.equal(s.balance.reservedUsdc, '2.500000'); assert.equal(s.balance.usdc, '50.000000', 'the balance is the provider\'s, not ours');
    assert.equal((await f.store.query('SELECT count(*) FROM relay_cw_ledger')).rows[0].count.toString(), '0');
    const dump = JSON.stringify(s) + JSON.stringify((await f.store.query('SELECT * FROM relay_cw_payments')).rows) + JSON.stringify((await f.store.query('SELECT * FROM relay_cw_events')).rows);
    assert.doesNotMatch(dump, /SECRET-USER-TOKEN|SECRET-KEY|SECRET-2/);
    // Resuming asks for a fresh session for the same open challenge, for the owner only.
    const again = await f.cw.payments.resumeChallenge(owner, id);
    assert.equal(again.challenge.challengeId, 'pay-' + (before + 1)); assert.equal(again.challenge.userToken, 'SECRET-2');
    await assert.rejects(f.cw.payments.resumeChallenge(other, id), e => e.status === 404);
    // A second approval of the same payment does not call the provider again.
    await approve(f, id); assert.equal(f.st.calls.filter(c => c.exec).length, 1);
    // Native fees are reserved too: ETH for two such payments is not there.
    f.st.eth[owner] = ETH / 1000n + ETH / 2000n;
    const second = await send(f, owner, {amount: '1'});
    await assert.rejects(approve(f, second.id), e => e.status === 409 && /ETH/.test(e.message));
  } finally { await f.close(); }
});

test('a payment is paid only when the network record matches the approval field by field; anything else is unknown, with funds held', async () => {
  const f = await setup('base');
  try {
    await ready(f);
    const w = 'w-' + owner.slice(-6);
    const pay = async amount => { const { id } = await send(f, owner, {amount}); await approve(f, id); return view(f, id); };
    const p = await pay('2.5');
    // Not approved in the wallet yet: nothing found, nothing changes.
    f.st.found = {found: false};
    assert.equal((await f.cw.payments.refresh(owner, p.id)).status, 'executing');
    // Still in flight at the network: not terminal, funds stay reserved.
    for (const st of ['INITIATED', 'QUEUED', 'CLEARED', 'SENT', 'CONFIRMED', 'STUCK']) { f.st.found = txFor(p, w, {state: st}); assert.equal((await f.cw.payments.refresh(owner, p.id)).status, 'executing', st); }
    assert.equal((await f.cw.state(owner)).balance.reservedUsdc, '2.500000');
    // Each mismatch is refused as unknown: wrong reference, wallet, owner, network, recipient, amount, token, direction.
    const wrongs = [{refId: 'x'}, {walletId: 'w-other'}, {userId: 'someone-else'}, {userId: null}, {blockchain: 'BASE-SEPOLIA'}, {destination: '0x' + '1'.repeat(40)}, {destination: null}, {amounts: ['2.6']}, {amounts: ['2.5', '1']}, {amounts: []}, {tokenId: 'tok-other'}, {tokenId: null}, {transactionType: 'INBOUND'}];
    for (const over of wrongs) {
      const q = await pay('1'); f.st.found = txFor(q, w, over);
      const r = await f.cw.payments.refresh(owner, q.id);
      assert.equal(r.status, 'outcome_unknown', JSON.stringify(over));
      assert.equal((await f.cw.state(owner)).payments.find(x => x.id === q.id).receipt, null);
    }
    const reservedBefore = (await f.cw.state(owner)).balance.reservedUsdc;
    // A doubtful lookup (duplicates, full page) is unknown and keeps the reservation.
    const u = await pay('1'); f.st.found = {uncertain: true};
    assert.equal((await f.cw.payments.refresh(owner, u.id)).status, 'outcome_unknown');
    // A thrown lookup changes nothing.
    f.st.found = () => { throw new Error('network'); };
    assert.equal((await f.cw.payments.refresh(owner, p.id)).status, 'executing');
    // The real thing: COMPLETE and every field matching.
    f.st.found = txFor(p, w, {userId: 'uid'});
    const done = await f.cw.payments.refresh(owner, p.id);
    assert.equal(done.status, 'succeeded'); assert.equal(done.receipt.ref, '0xrealhash'); assert.equal(done.receipt.verifiedOnChain, true); assert.equal(done.receipt.simulated, false);
    assert.equal(done.receipt.networkFee, '0.0005 ETH'); assert.equal(done.receipt.anomaly, null); assert.equal(done.receipt.feeUsdc, '0.000000');
    assert.ok(reservedBefore.length > 0);
    // An unknown one recovers when the network record later matches; failure releases.
    const v = await pay('1');
    f.st.found = txFor(v, w, {amounts: ['9']}); assert.equal((await f.cw.payments.refresh(owner, v.id)).status, 'outcome_unknown');
    f.st.found = txFor(v, w); assert.equal((await f.cw.payments.refresh(owner, v.id)).status, 'succeeded');
    const fl = await pay('1'); f.st.found = txFor(fl, w, {state: 'FAILED'});
    assert.equal((await f.cw.payments.refresh(owner, fl.id)).status, 'failed');
    for (const st of ['DENIED', 'CANCELLED']) { const x = await pay('1'); f.st.found = txFor(x, w, {state: st}); assert.equal((await f.cw.payments.refresh(owner, x.id)).status, 'failed', st); }
    // A fee above what was approved: the payment matched, the surprise is flagged.
    const hi = await pay('1'); f.st.found = txFor(hi, w, {networkFee: '0.5'});
    assert.match((await f.cw.payments.refresh(owner, hi.id)).anomaly, /above the estimate/);
    // The wrong customer cannot refresh someone else's payment.
    await assert.rejects(f.cw.payments.refresh(other, p.id), e => e.status === 404);
    // Another customer's lookup is never mixed in: the provider is always asked with the owner of the payment.
    assert.ok(f.st.calls.filter(c => c.find).every(c => c.find.owner === owner));
  } finally { await f.close(); }
});

test('the customer cannot declare a real payment settled; "not sent" is accepted only when the network positively shows nothing', async () => {
  const f = await setup('base', {execError: true});
  try {
    await ready(f);
    const w = 'w-' + owner.slice(-6);
    const { id } = await send(f); const r = await approve(f, id);
    assert.equal(r.status, 'outcome_unknown', 'a provider crash is unknown, not a failure');
    assert.equal(f.st.calls.filter(c => c.exec).length, 1, 'no automatic retry');
    await assert.rejects(f.cw.payments.reconcile(owner, {id, outcome: 'sent'}), e => e.status === 409 && /network confirms/.test(e.message));
    f.st.found = {uncertain: true};
    await assert.rejects(f.cw.payments.reconcile(owner, {id, outcome: 'not_sent'}), e => e.status === 409);
    f.st.found = txFor(await view(f, id), w, {state: 'SENT'});
    await assert.rejects(f.cw.payments.reconcile(owner, {id, outcome: 'not_sent'}), e => e.status === 409, 'a transaction exists and is in flight, so it cannot be called unsent');
    f.st.found = () => { throw new Error('down'); };
    await assert.rejects(f.cw.payments.reconcile(owner, {id, outcome: 'not_sent'}), e => e.status === 409);
    assert.equal((await f.cw.state(owner)).balance.reservedUsdc, '2.500000', 'funds stay reserved throughout');
    // An EMPTY list is not evidence: lists lag, and an open approval could still be completed later. The funds stay reserved.
    f.st.found = {found: false};
    await assert.rejects(f.cw.payments.reconcile(owner, {id, outcome: 'not_sent'}), e => e.status === 409 && /failed or cancelled/.test(e.message));
    assert.equal((await f.cw.state(owner)).balance.reservedUsdc, '2.500000', 'absence from the list never frees funds');
    // Only the network's own terminal record does, and it must match the approval like any other.
    f.st.found = txFor(await view(f, id), w, {state: 'CANCELLED'});
    assert.equal((await f.cw.payments.reconcile(owner, {id, outcome: 'not_sent'})).id, id);
    assert.equal((await f.cw.state(owner)).balance.reservedUsdc, '0.000000');
    assert.equal((await view(f, id)).status, 'failed');
    await assert.rejects(f.cw.payments.reconcile(other, {id, outcome: 'not_sent'}), e => e.status === 404);
    assert.equal((await f.store.query("SELECT count(*) FROM relay_cw_ledger")).rows[0].count.toString(), '0', 'no invented ledger entries');
  } finally { await f.close(); }
});

test('crash recovery: an approved payment whose provider call never recorded a result becomes unknown, is never re-sent, and stays reserved', async () => {
  const f = await setup('base');
  try {
    await ready(f);
    const { id } = await send(f); await approve(f, id);
    await f.store.query("UPDATE relay_cw_payments SET provider_state=NULL, updated_at=now()-interval '5 minutes' WHERE id=$1", [id]);
    const s = await f.cw.state(owner);
    assert.equal(s.payments.find(p => p.id === id).status, 'outcome_unknown'); assert.equal(s.balance.reservedUsdc, '2.500000');
    assert.equal(f.st.calls.filter(c => c.exec).length, 1, 'not sent a second time');
    // A fresh one (still within the window) is left alone.
    const b = await send(f, owner, {amount: '1'}); await approve(f, b.id);
    await f.store.query("UPDATE relay_cw_payments SET provider_state=NULL, updated_at=now() WHERE id=$1", [b.id]);
    assert.equal((await view(f, b.id)).status, 'executing');
  } finally { await f.close(); }
});

test('live concurrency: parallel approvals reserve under one lock, call the provider once each, and never exceed the balance', async () => {
  const f = await setup('base');
  try {
    await ready(f, owner, 3_000_000n, ETH);
    const ids = [];
    for (let i = 0; i < 6; i++) ids.push((await send(f, owner, {amount: '1', service: 'S' + i})).id);
    const fp = Object.fromEntries((await f.cw.state(owner)).payments.map(p => [p.id, p.fingerprint]));
    const res = await Promise.allSettled(ids.map(id => f.cw.payments.decide(owner, {id, decision: 'approve', bindingHash: fp[id]})));
    assert.equal(res.filter(r => r.status === 'fulfilled').length, 3, '3 USDC covers three one-USDC payments');
    assert.equal(f.st.calls.filter(c => c.exec).length, 3, 'exactly one provider call per accepted payment');
    const s = await f.cw.state(owner);
    assert.equal(s.balance.reservedUsdc, '3.000000'); assert.equal(s.payments.filter(p => p.status === 'rejected' && p.reasonCode === 'insufficient_balance').length, 3);
    // The same approval six times at once calls the provider once.
    const g = await setup('base');
    try {
      await ready(g);
      const one = (await send(g)).id, h = (await view(g, one)).fingerprint;
      const par = await Promise.allSettled(Array.from({length: 6}, () => g.cw.payments.decide(owner, {id: one, decision: 'approve', bindingHash: h})));
      assert.ok(par.every(r => r.status === 'fulfilled')); assert.equal(g.st.calls.filter(c => c.exec).length, 1);
    } finally { await g.close(); }
    // Concurrent creates with one request id make one payment.
    f.st.usdc[owner] = 100_000_000n;
    const reqId = randomUUID();
    const dup = await Promise.allSettled(Array.from({length: 6}, () => f.cw.payments.send(owner, {requestId: reqId, destination: DEST, amount: '0.5', service: 'Dup'})));
    assert.equal(new Set(dup.filter(r => r.status === 'fulfilled').map(r => r.value.id)).size, 1);
  } finally { await f.close(); }
});

test('tenancy: another customer can neither see, decide, refresh, resume nor reconcile a live payment or read its wallet', async () => {
  const f = await setup('base');
  try {
    await ready(f); await ready(f, other);
    const { id } = await send(f); const fp = (await view(f, id)).fingerprint;
    assert.equal((await f.cw.state(other)).payments.length, 0);
    await assert.rejects(f.cw.payments.decide(other, {id, decision: 'approve', bindingHash: fp}), e => e.status === 404);
    await assert.rejects(f.cw.payments.refresh(other, id), e => e.status === 404);
    await assert.rejects(f.cw.payments.resumeChallenge(other, id), e => e.status === 404);
    await assert.rejects(f.cw.payments.reconcile(other, {id, outcome: 'not_sent'}), e => e.status === 404);
    assert.notEqual((await f.cw.state(owner)).wallet.address, (await f.cw.state(other)).wallet.address);
    assert.equal((await view(f, id)).status, 'awaiting_approval');
  } finally { await f.close(); }
});

test('activity: only money that moved shows an amount; waiting, declined, lapsed and failed requests show their status', async () => {
  const f = await setup('base');
  try {
    await ready(f);
    const mk = async (service, amount) => (await send(f, owner, {service, amount})).id;
    const waiting = await mk('Waiting one', '1'), declined = await mk('Declined one', '2'), lapsed = await mk('Lapsed one', '3');
    await f.cw.payments.decide(owner, {id: declined, decision: 'decline', bindingHash: (await view(f, declined)).fingerprint});
    await f.store.query("UPDATE relay_cw_payments SET expires_at=now()-interval '1 second' WHERE id=$1", [lapsed]);
    const paid = await mk('Paid one', '4'); await approve(f, paid);
    f.st.found = txFor(await view(f, paid), 'w-' + owner.slice(-6)); await f.cw.payments.refresh(owner, paid);
    const act = (await f.cw.state(owner)).activity;
    const by = name => act.find(r => r.label.startsWith(name));
    for (const n of ['Waiting one', 'Declined one', 'Lapsed one']) { assert.equal(by(n).moved, false, n); assert.equal(by(n).amountUsdc, null, n); }
    assert.equal(by('Paid one').moved, true); assert.equal(by('Paid one').amountUsdc, '4.000000');
    assert.ok(waiting);
  } finally { await f.close(); }
});

test('Add money opens this wallet\'s own saved-wallet record; an already open request is offered separately, never substituted', () => {
  assert.deepEqual(fundingTarget({kind: 'peer-fund', label: 'Fund'}, 'saved-1'), {mode: 'new', kind: 'peer-fund', id: 'saved-1'});
  assert.deepEqual(fundingTarget({kind: 'peer-fund', id: 'other-agent', existing: true}, 'saved-1'), {mode: 'existing', kind: 'peer-fund', id: 'other-agent'});
  assert.deepEqual(fundingTarget({kind: 'peer-fund'}, null), {mode: 'unlinked'});
  assert.deepEqual(fundingTarget({kind: 'peer-fund'}, ''), {mode: 'unlinked'});
  assert.equal(fundingTarget({kind: null}, 'saved-1'), null); assert.equal(fundingTarget(null, 'saved-1'), null); assert.equal(fundingTarget({kind: 'x', disabled: true}, 's'), null);
  // A new request never takes the id of an existing draft or order.
  assert.notEqual(fundingTarget({kind: 'funding-draft', id: 'draft-9', existing: true}, 'saved-1').mode, 'new');
});

test('the saved wallet record is reused when the customer already saved that exact address', async () => {
  const f = await setup('base');
  try {
    const existing = randomUUID();
    await f.store.query("INSERT INTO relay_agents(id,owner,data,address_key) VALUES($1,$2,$3,$4)", [existing, owner, {id: existing, name: 'Mine', address: ADDR, network: 'Base', token: 'USDC'}, ADDR.toLowerCase()]);
    await f.cw.createWallet(owner, {label: 'My Eupova wallet', requestId: randomUUID()});
    f.st.wallets[owner] = {providerRef: 'w-1', address: ADDR, state: 'ready'};
    await f.cw.finishSetup(owner);
    assert.equal((await f.cw.state(owner)).wallet.savedWalletId, existing);
  } finally { await f.close(); }
});
