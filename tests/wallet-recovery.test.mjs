import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture} from './fixtures/account-store.mjs';
import {createCustomerWallet} from '../hosted/customer-wallet.mjs';
import {WALLET_NETWORKS} from '../shared/wallet-model.mjs';
import {liveProvider, FEE, ETH} from './fixtures/live-provider.mjs';
import {addCustomer} from './fixtures/customers.mjs';

const owner = 'customer:' + randomUUID(), DEST = '0x' + 'd'.repeat(40), ADDR = '0x' + 'a'.repeat(40);
const SPONSORED = {asset: 'sponsored', maxFeeNativeWei: '0', gasLimit: null, maxFee: null, priorityFee: null};

async function setup(over = {}, config = {}) {
  const f = await fixture();
  const st = {calls: [], wallets: {}, usdc: {}, eth: {}, fee: FEE, found: {found: false}, ...over};
  const cw = createCustomerWallet({store: f.store, provider: liveProvider('base', st), config});
  await cw.migrate();
  return {...f, cw, st};
}
async function ready(f, who = owner, usdc = 50_000_000n, eth = ETH) {
  await addCustomer(f, who);
  await f.cw.createWallet(who, {label: 'My Eupova wallet', requestId: randomUUID()});
  f.st.wallets[who] = {providerRef: 'w-' + who.slice(-6), address: ADDR.slice(0, -6) + who.slice(-6).replace(/[^0-9a-f]/g, 'e').padEnd(6, 'e'), state: 'ready'};
  await f.cw.finishSetup(who); f.st.usdc[who] = usdc; f.st.eth[who] = eth;
}
const wref = who => 'w-' + who.slice(-6);
const send = (f, who = owner, over = {}) => f.cw.payments.send(who, {requestId: randomUUID(), destination: DEST, amount: '2.50', service: 'Send', ...over});
const view = async (f, id, who = owner) => (await f.cw.state(who)).payments.find(p => p.id === id);
const row = async (f, id) => (await f.store.query('SELECT * FROM relay_cw_payments WHERE id=$1', [id])).rows[0];
const approve = async (f, id, who = owner) => f.cw.payments.decide(who, {id, decision: 'approve', bindingHash: (await view(f, id, who)).fingerprint});
const txFor = (p, who, over = {}) => ({found: true, expectedUserId: 'uid', tx: {id: 't1', state: 'COMPLETE', userId: 'uid', walletId: wref(who), blockchain: WALLET_NETWORKS.base.circleChain, destination: p.destination, amounts: [p.amountUsdc], tokenId: 'tok-usdc', refId: p.id, transactionType: 'OUTBOUND', txHash: '0x' + '9'.repeat(64), networkFee: '0.0001', ...over}});
const reserved = async (f, who = owner) => (await f.cw.state(who)).balance.reservedUsdc;
async function tool(f, who = owner, amount = '10') {
  const e = await f.cw.tools.enrolStart({name: 'Recovery CLI', ip: '127.0.0.1'});
  await f.cw.tools.approveEnrolment(who, {userCode: e.userCode});
  const g = await f.cw.tools.enrolPoll({enrolmentId: e.enrolmentId, deviceSecret: e.deviceSecret, ip: '127.0.0.1'});
  const t = await f.cw.tools.authenticate(g.token);
  if (amount) await f.cw.tools.setAllowance(who, {toolId: t.id, amount, hours: 24, confirm: true, confirmation: (await f.cw.state(who)).allowanceConfirmation});
  return t;
}

test('crash right after the request was made: the exact token is already saved, the payment is found again by its reference and settled only by a matching record', async () => {
  const f = await setup({execError: true}); await ready(f);
  const {id} = await send(f); const r = await approve(f, id);
  assert.equal(r.status, 'outcome_unknown'); assert.equal(f.st.calls.filter(c => c.exec).length, 1);
  const saved = (await row(f, id)).provider_state;
  assert.deepEqual([saved.phase, saved.tokenId], ['submitting', 'tok-usdc'], 'token id and "submitting" were saved BEFORE the request');
  assert.equal(await reserved(f), '2.500000');
  // a record for a different token is never accepted, whatever else matches
  f.st.found = txFor(await view(f, id), owner, {tokenId: 'tok-eth'});
  assert.equal((await f.cw.payments.refresh(owner, id)).status, 'outcome_unknown'); assert.equal(await reserved(f), '2.500000');
  f.st.found = {found: false};
  assert.equal((await f.cw.payments.refresh(owner, id)).status, 'outcome_unknown', 'no record yet: nothing changes');
  // the real record turns up (no challenge id was ever saved)
  f.st.found = txFor(await view(f, id), owner);
  const done = await f.cw.payments.refresh(owner, id);
  assert.equal(done.status, 'succeeded'); assert.equal(done.receipt.verifiedOnChain, true); assert.equal(await reserved(f), '0.000000');
  assert.equal(f.st.calls.filter(c => c.exec).length, 1, 'recovery never sent anything again');
});

test('if the wallet\'s USDC cannot be identified, nothing is sent and the reservation is freed', async () => {
  const f = await setup({tokenError: true}); await ready(f);
  const {id} = await send(f); const r = await approve(f, id);
  assert.equal(r.status, 'failed'); assert.equal(f.st.calls.filter(c => c.exec).length, 0); assert.equal(await reserved(f), '0.000000');
  assert.match((await f.store.query("SELECT note FROM relay_cw_events WHERE payment_id=$1 ORDER BY id DESC LIMIT 1", [id])).rows[0].note, /did not send|No USDC left/);
});

test('Continue after a lost challenge replays the SAME idempotent request once, started by the customer only', async () => {
  const f = await setup({execError: true}); await ready(f);
  const {id} = await send(f); await approve(f, id);
  await assert.rejects(f.cw.payments.resumeChallenge(owner, id), e => e.status === 409, 'unknown payments are not resumed blindly');
  await f.store.query("UPDATE relay_cw_payments SET status='executing' WHERE id=$1", [id]);   // as after a restart that lost the answer
  f.st.execError = false;
  const c = await f.cw.payments.resumeChallenge(owner, id);
  assert.ok(c.challenge.challengeId); const execs = f.st.calls.filter(x => x.exec);
  assert.equal(execs.length, 2); assert.equal(execs[0].exec.id, execs[1].exec.id, 'same payment reference'); assert.equal(execs[1].exec.tokenId, 'tok-usdc');
  assert.equal((await row(f, id)).provider_state.challengeId, c.challenge.challengeId);
  await assert.rejects(f.cw.payments.resumeChallenge('customer:' + randomUUID(), id), e => e.status === 404);
});

test('nobody has to press refresh: reading the wallet or a tool status moves an approved payment forward, throttled', async () => {
  const f = await setup(); await ready(f);
  const {id} = await send(f); await approve(f, id);
  const finds = () => f.st.calls.filter(c => c.find).length;
  await f.cw.state(owner); await f.cw.state(owner); await f.cw.state(owner);
  assert.equal(finds(), 1, 'three quick reads, one provider lookup');
  await f.store.query("UPDATE relay_cw_payments SET last_checked_at=now()-interval '1 minute' WHERE id=$1", [id]);
  await f.cw.state(owner); assert.equal(finds(), 2);
  f.st.found = txFor(await view(f, id), owner, {state: 'SENT'});
  await f.store.query("UPDATE relay_cw_payments SET last_checked_at=now()-interval '1 minute' WHERE id=$1", [id]);
  assert.equal((await f.cw.state(owner)).payments[0].status, 'executing', 'in flight stays in flight');
  f.st.found = txFor(await view(f, id), owner);
  await f.store.query("UPDATE relay_cw_payments SET last_checked_at=now()-interval '1 minute' WHERE id=$1", [id]);
  const s = await f.cw.state(owner);
  assert.equal(s.payments[0].status, 'succeeded'); assert.equal(s.balance.reservedUsdc, '0.000000');
  // a tool's status read does the same, for the tool's own payment only
  const t = await tool(f);
  const p = await f.cw.tools.requestPayment(t, 'key-12345678', {service: 'API', destination: DEST, amount: '1'});
  const hp = (await view(f, p.id)).fingerprint;
  await f.cw.payments.decide(owner, {id: p.id, decision: 'approve', bindingHash: hp});
  f.st.found = {found: false}; const pv = await view(f, p.id);          // (reading state polls, so keep the answer neutral while we build the record)
  await f.store.query("UPDATE relay_cw_payments SET last_checked_at=now()-interval '1 minute' WHERE id=$1", [p.id]);
  f.st.found = txFor(pv, owner);
  assert.equal((await f.cw.tools.getPayment(t, p.id)).status, 'succeeded', 'the CLI sees COMPLETE without anyone pressing anything');
  const u = await tool(f, owner, null);
  await assert.rejects(f.cw.tools.getPayment(u, p.id), e => e.status === 404, 'another tool cannot read it');
});

test('requests the allowance refuses are saved as clean rejections even when fees are in ETH', async () => {
  const f = await setup(); await ready(f);
  const none = await tool(f, owner, null);
  const a = await f.cw.tools.requestPayment(none, 'key-aaaaaaaa', {service: 'API', destination: DEST, amount: '1'});
  assert.equal((await f.cw.tools.getPayment(none, a.id)).status, 'rejected'); assert.equal((await f.cw.tools.getPayment(none, a.id)).reasonCode, 'no_allowance');
  const small = await tool(f, owner, '1');
  const b = await f.cw.tools.requestPayment(small, 'key-bbbbbbbb', {service: 'API', destination: DEST, amount: '2'});
  assert.equal((await f.cw.tools.getPayment(small, b.id)).status, 'rejected'); assert.equal((await f.cw.tools.getPayment(small, b.id)).reasonCode, 'over_allowance');
  assert.equal((await f.cw.tools.requestPayment(none, 'key-aaaaaaaa', {service: 'API', destination: DEST, amount: '1'})).id, a.id, 'replay returns the same rejection');
});

test('a payment that failed on the network is not described as costing nothing when gas was charged', async () => {
  const f = await setup(); await ready(f);
  let r = await send(f); await approve(f, r.id);
  f.st.found = txFor(await view(f, r.id), owner, {state: 'FAILED', networkFee: '0.00005'});
  const done = await f.cw.payments.refresh(owner, r.id);
  assert.equal(done.status, 'failed'); assert.match(done.receipt.networkFee, /0\.00005 ETH/); assert.equal(done.receipt.failedOnChain, true);
  const note = (await f.store.query("SELECT note FROM relay_cw_events WHERE payment_id=$1 AND kind='payment_failed'", [r.id])).rows[0].note;
  assert.match(note, /still charged a fee of 0\.00005 ETH/); assert.doesNotMatch(note, /Nothing was taken|did not send/);
  r = await send(f); await approve(f, r.id);
  f.st.found = txFor(await view(f, r.id), owner, {state: 'DENIED', networkFee: '0'});
  await f.cw.payments.refresh(owner, r.id);
  assert.doesNotMatch((await f.store.query("SELECT note FROM relay_cw_events WHERE payment_id=$1 AND kind='payment_failed'", [r.id])).rows[0].note, /Nothing was taken/);
});

test('history lists only the exact USDC token, shows incoming money only once it arrived, keeps other-app payments and never doubles our own', async () => {
  const at = n => new Date(Date.now() - n * 1000).toISOString(), chain = WALLET_NETWORKS.base.circleChain;
  const f = await setup(); await ready(f);
  const mine = await send(f); await approve(f, mine.id);
  f.st.history = [
    {id: 'h1', state: 'COMPLETE', at: at(1), direction: 'in', amounts: ['3'], tokenId: 'tok-usdc', blockchain: chain, refId: null},
    {id: 'h2', state: 'COMPLETE', at: at(2), direction: 'in', amounts: ['5'], tokenId: 'tok-eth', blockchain: chain, refId: null},          // ETH deposit: never shown as USDC
    {id: 'h3', state: 'COMPLETE', at: at(3), direction: 'in', amounts: ['7'], tokenId: 'tok-usdc', blockchain: 'ETH', refId: null},           // wrong chain
    {id: 'h4', state: 'INITIATED', at: at(4), direction: 'in', amounts: ['9'], tokenId: 'tok-usdc', blockchain: chain, refId: null},         // pending: no amount
    {id: 'h5', state: 'COMPLETE', at: at(5), direction: 'out', amounts: ['1.5'], tokenId: 'tok-usdc', blockchain: chain, refId: 'from-another-app'},
    {id: 'h6', state: 'FAILED', at: at(6), direction: 'out', amounts: ['2'], tokenId: 'tok-usdc', blockchain: chain, refId: 'x', networkFee: '0.0002'},
    {id: 'h7', state: 'COMPLETE', at: at(7), direction: 'out', amounts: ['2.5'], tokenId: 'tok-usdc', blockchain: chain, refId: mine.id},   // our own payment
  ];
  const rows = (await f.cw.state(owner)).activity, byId = id => rows.find(r => r.id === 'h:' + id);
  assert.equal(byId('h1').amountUsdc, '3.000000'); assert.equal(byId('h1').label, 'Received');
  assert.equal(byId('h2'), undefined); assert.equal(byId('h3'), undefined);
  assert.equal(byId('h4').amountUsdc, null); assert.match(byId('h4').label, /pending/i);
  assert.equal(byId('h5').amountUsdc, '1.500000'); assert.match(byId('h5').label, /Sent from your wallet/);
  assert.equal(byId('h6').amountUsdc, null); assert.match(byId('h6').label, /0\.0002 ETH/);
  assert.equal(byId('h7'), undefined, 'our own payment is listed from our row only');
  assert.equal(rows.filter(r => r.id === 'p:' + mine.id).length, 1);
  assert.equal(rows.find(r => r.id === 'p:' + mine.id).amountUsdc, null, 'in flight: no spent amount');
});

test('sponsored network fees: Eupova\'s daily brake, no ETH needed, no silent fallback, honest when it runs out', async () => {
  const cfg = {gasDailyUsd: '0.20', gasPerTxUsd: '0.05'};
  const f = await setup({feeAsset: 'sponsored', fee: SPONSORED}, cfg); await ready(f, owner, 100_000_000n, 0n);       // the wallet holds NO ETH
  const ids = []; for (let i = 0; i < 5; i++) ids.push((await send(f, owner, {amount: '1'})).id);
  const p0 = await view(f, ids[0]); assert.equal(p0.fee.asset, 'sponsored'); assert.equal(p0.fee.nativeMax, null);
  for (let i = 0; i < 4; i++) assert.equal((await approve(f, ids[i])).status, 'executing', 'no ETH needed when sponsored');
  await assert.rejects(approve(f, ids[4]), e => e.status === 409 && /daily limit for sponsored network fees/.test(e.message));
  assert.equal((await view(f, ids[4])).status, 'rejected'); assert.equal((await view(f, ids[4])).reasonCode, 'sponsorship_exhausted');
  assert.equal(f.st.calls.filter(c => c.exec).length, 4, 'the fifth was never started');
  await assert.rejects(send(f, owner, {amount: '1'}), e => e.status === 409 && /daily limit/.test(e.message), 'new requests are refused up front too');
  // a new UTC day starts a new budget
  await f.store.query("UPDATE relay_cw_sponsor SET day=day-1");
  const next = await send(f, owner, {amount: '1'}); assert.equal((await approve(f, next.id)).status, 'executing');
  // nothing sent => the reservation is released, so it does not use up the day
  const g = await setup({feeAsset: 'sponsored', fee: SPONSORED, tokenError: true}, cfg); await ready(g, owner, 100_000_000n, 0n);
  for (let i = 0; i < 6; i++) { const x = await send(g, owner, {amount: '1'}); assert.equal((await approve(g, x.id)).status, 'failed'); }
  assert.equal((await g.store.query("SELECT count(*) c FROM relay_cw_sponsor WHERE state='reserved'")).rows[0].c * 1, 0);
});

test('sponsored: a reported network fee is NOT evidence the customer paid; only the wallet\'s own ETH balance falling is, and only that pauses sponsorship', async () => {
  const cfg = {gasDailyUsd: '5', gasPerTxUsd: '0.05'}, FEE_ETH = 300_000_000_000_000n;                                          // 0.0003 ETH
  const one = async (setupEth, afterEth, fee = '0.0003') => {
    const f = await setup({feeAsset: 'sponsored', fee: SPONSORED}, cfg); await ready(f, owner, 100_000_000n, setupEth ?? 1_000_000_000_000_000n);
    const a = await send(f, owner, {amount: '1'});
    if (setupEth === null) { const real = f.st.eth; f.st.eth = null; await approve(f, a.id); f.st.eth = real; } else await approve(f, a.id);
    f.st.found = txFor(await view(f, a.id), owner, {networkFee: fee}); if (afterEth !== undefined) f.st.eth[owner] = afterEth;
    return {f, done: await f.cw.payments.refresh(owner, a.id), id: a.id};
  };
  // 1. Circle reports the network's cost, the wallet's ETH did not move: sponsorship worked. No anomaly, no pause, and the receipt says only what is known.
  let r = await one(1_000_000_000_000_000n, 1_000_000_000_000_000n);
  assert.equal(r.done.status, 'succeeded'); assert.equal(r.done.anomaly, null); assert.equal(r.done.receipt.feePayer, 'not_wallet');
  assert.equal(r.done.receipt.networkCostReported, '0.0003 ETH'); assert.equal(r.done.receipt.networkFee, null, 'a sponsored payment never shows a fee as the customer\'s');
  assert.ok(await send(r.f, owner, {amount: '1'}), 'a normal sponsored transfer does not pause sponsorship');
  // 2. The wallet\'s own ETH balance fell by the reported fee: the wallet paid. Flagged, and sponsorship pauses for the day.
  r = await one(1_000_000_000_000_000n, 1_000_000_000_000_000n - FEE_ETH);
  assert.equal(r.done.status, 'succeeded'); assert.equal(r.done.receipt.feePayer, 'wallet'); assert.match(r.done.anomaly, /charged to your wallet although sponsorship was expected/);
  await assert.rejects(send(r.f, owner, {amount: '1'}), e => e.status === 409 && /daily limit/.test(e.message));
  // 3. The balance could not be compared: nothing is concluded, nothing pauses.
  r = await one(null, undefined);
  assert.equal(r.done.receipt.feePayer, 'unknown'); assert.equal(r.done.anomaly, null); assert.ok(await send(r.f, owner, {amount: '1'}));
  // 4. A clean sponsored payment (no reported cost) neither flags nor pauses.
  r = await one(1_000_000_000_000_000n, 1_000_000_000_000_000n, '0');
  assert.equal(r.done.anomaly, null); assert.equal(r.done.receipt.feePayer, null); assert.ok(await send(r.f, owner, {amount: '1'}));
  // 5. A failed sponsored payment is never described as costing the customer a fee.
  const f = await setup({feeAsset: 'sponsored', fee: SPONSORED}, cfg); await ready(f, owner, 100_000_000n, 1_000_000_000_000_000n);
  const x = await send(f, owner, {amount: '1'}); await approve(f, x.id); f.st.found = txFor(await view(f, x.id), owner, {state: 'FAILED', networkFee: '0.0003'});
  const failed = await f.cw.payments.refresh(owner, x.id); assert.equal(failed.status, 'failed');
  assert.doesNotMatch(JSON.stringify((await f.store.query("SELECT note FROM relay_cw_events WHERE payment_id=$1", [x.id])).rows), /still charged a fee/);
});

test('sponsorship accounting under real concurrency: ten parallel approvals against a budget for four start exactly four', async () => {
  const f = await setup({feeAsset: 'sponsored', fee: SPONSORED}, {gasDailyUsd: '0.20', gasPerTxUsd: '0.05'}); await ready(f, owner, 500_000_000n, 0n);
  const ids = []; for (let i = 0; i < 10; i++) ids.push((await send(f, owner, {amount: '1'})).id);
  const hashes = await Promise.all(ids.map(async id => (await view(f, id)).fingerprint));
  const out = await Promise.allSettled(ids.map((id, i) => f.cw.payments.decide(owner, {id, decision: 'approve', bindingHash: hashes[i]})));
  assert.equal(out.filter(o => o.status === 'fulfilled').length, 4); assert.equal(f.st.calls.filter(c => c.exec).length, 4);
  assert.equal((await f.store.query("SELECT count(*) c FROM relay_cw_sponsor WHERE state='reserved'")).rows[0].c * 1, 4);
});

test('one lock order: revoking, re-granting and approving at the same moment never deadlocks and never leaks a reservation', async () => {
  const f = await setup(); await ready(f, owner, 500_000_000n);
  for (let round = 0; round < 4; round++) {
    const t = await tool(f);
    const reqs = []; for (let i = 0; i < 3; i++) reqs.push(await f.cw.tools.requestPayment(t, `key-${round}-${i}-xxxxxxxx`, {service: 'API', destination: DEST, amount: '1'}));
    const hs = await Promise.all(reqs.map(async r => (await view(f, r.id)).fingerprint));
    const confirmation = (await f.cw.state(owner)).allowanceConfirmation;      // everything awaited BEFORE the race starts
    // Every promise gets its handler in the same tick it is made: nothing can reject unattended, and the timer is always cleared.
    let timer;
    const guard = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('deadlock: operations did not finish')), 30_000); });
    const moves = [...reqs.map((r, i) => f.cw.payments.decide(owner, {id: r.id, decision: 'approve', bindingHash: hs[i]})), f.cw.tools.revokeAllowance(owner, {toolId: t.id}), f.cw.tools.revokeTool(owner, {toolId: t.id}),
      f.cw.tools.setAllowance(owner, {toolId: t.id, amount: '9', hours: 24, confirm: true, confirmation})];
    const settled = Promise.allSettled(moves);
    try { assert.equal((await Promise.race([settled, guard])).length, moves.length); } finally { clearTimeout(timer); await settled; }
    const leak = (await f.store.query(`SELECT (SELECT coalesce(sum(reserved_raw),0) FROM relay_cw_allowances)::text a, (SELECT coalesce(sum(cap_raw),0) FROM relay_cw_payments WHERE status='executing' AND origin='tool')::text p`)).rows[0];
    assert.ok(BigInt(leak.a) <= BigInt(leak.p), 'allowance reservations never exceed the open payments they belong to');
  }
});

test('a live tool belongs to a customer who may still use the wallet: disabled, unfinished or unverified owners lose the CLI at once', async () => {
  const f = await setup(); await ready(f);
  const e = await f.cw.tools.enrolStart({name: 'CLI', ip: '127.0.0.1'}); await f.cw.tools.approveEnrolment(owner, {userCode: e.userCode});
  await addCustomer(f, owner, {verified: false});
  await assert.rejects(f.cw.tools.enrolPoll({enrolmentId: e.enrolmentId, deviceSecret: e.deviceSecret, ip: '127.0.0.1'}), x => x.status === 403, 'no credential is collected for an unverified owner');
  await addCustomer(f, owner);
  const g = await f.cw.tools.enrolPoll({enrolmentId: e.enrolmentId, deviceSecret: e.deviceSecret, ip: '127.0.0.1'});
  assert.equal(g.status, 'approved');
  const t = await f.cw.tools.authenticate(g.token); await f.cw.tools.setAllowance(owner, {toolId: t.id, amount: '10', hours: 24, confirm: true, confirmation: (await f.cw.state(owner)).allowanceConfirmation});
  const p = await f.cw.tools.requestPayment(t, 'key-12345678', {service: 'API', destination: DEST, amount: '1'});
  for (const [name, state] of [['disabled', {disabled: true}], ['setup unfinished', {setupPending: true}], ['unverified', {verified: false}]]) {
    await addCustomer(f, owner, state);
    await assert.rejects(f.cw.tools.authenticate(g.token), x => x.status === 401, name);
    await assert.rejects(f.cw.tools.requestPayment(t, 'key-87654321', {service: 'API', destination: DEST, amount: '1'}), x => x.status === 401, name);
    await assert.rejects(f.cw.tools.getPayment(t, p.id), x => x.status === 401, name);
  }
  await addCustomer(f, owner); assert.ok(await f.cw.tools.authenticate(g.token), 'restored when the account is again in good standing');
  // a customer with no account row at all (a tester code) never reaches a live tool
  const ghost = 'customer:' + randomUUID(); await assert.equal(await f.cw.tools.customerOk(ghost), false); assert.equal(await f.cw.tools.customerOk('alice'), false);
});
