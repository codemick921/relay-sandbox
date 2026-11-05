import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {prod, DEST} from './fixtures/prod-server.mjs';
import {createWalletFlow} from '../src/wallet-flow.mjs';
import {runCircleChallenge} from '../src/circle-challenge.mjs';
import {WALLET_NETWORKS} from '../shared/wallet-model.mjs';

// The browser sequences end to end: the real flow controller and the real challenge runner (with a fake Circle SDK in place of
// Circle's iframe) talking over HTTP to a production-shaped server whose live provider is under test control.
const AT = String.fromCharCode(64);
const net = WALLET_NETWORKS.base_sepolia;

async function rig() {
  const s = await prod({live: true});
  const cookie = await s.signup('flow.test' + AT + 'example.test');
  const sdkLog = [];
  const hooks = {execute: async () => null};          // what the "customer" does in Circle's step; null = completes, Error = closes early
  class FakeSdk {
    constructor(cfg) { sdkLog.push(['new', cfg.appSettings.appId]); }
    async getDeviceId() { sdkLog.push(['device']); return 'device-1'; }
    setAuthentication(a) { sdkLog.push(['auth', typeof a.userToken, typeof a.encryptionKey]); }
    execute(id, cb) { sdkLog.push(['execute', id]); Promise.resolve(hooks.execute(id)).then(e => (e ? cb(e) : cb(undefined, {type: 'PIN', status: 'COMPLETE'}))); }
  }
  const errors = [];
  const act = async (path, body) => { const r = await s.call(path, body, cookie); if (r.status >= 400) { errors.push(r.json?.error ?? r.status); return null; } return r.json; };
  const notes = [];
  const flow = createWalletFlow({act, runChallenge: c => runCircleChallenge(c, async () => ({W3SSdk: FakeSdk})), onProblem: t => notes.push(t)});
  const state = async () => (await s.call('state', undefined, cookie)).json.customerWallet;
  const dummy = {wallet: {providerRef: 'w-1', address: '0x' + 'a'.repeat(40), state: 'ready'}};
  s.st.wallets = new Proxy({}, {get: (_, o) => (s.st.pinDone && typeof o === 'string' && o.startsWith('customer:') ? dummy.wallet : undefined)});
  s.st.usdc = new Proxy({}, {get: () => 50_000_000}); s.st.eth = new Proxy({}, {get: () => 10n ** 17n});
  return {s, flow, act, state, sdkLog, hooks, notes, errors, cookie};
}
const txFor = (p, over = {}, tx = {}) => ({found: true, expectedUserId: 'uid', tx: {id: 't1', state: 'COMPLETE', userId: 'uid', walletId: 'w-1', blockchain: net.circleChain, destination: p.destination, amounts: [p.amountUsdc], tokenId: 'tok-usdc', refId: p.id, txHash: '0xrealhash', networkFee: '0.0005', transactionType: 'OUTBOUND', ...tx}, ...over});

test('create: saved first, the PIN step runs in Circle\'s order (device id, then authentication, then execute), and only a read-back opens the wallet', async () => {
  const r = await rig();
  try {
    r.hooks.execute = async () => { r.s.st.pinDone = true; const w = (await r.state()).wallet; assert.equal(w.status, 'pending_setup', 'still saved-but-not-open while the PIN step is up'); return null; };
    const out = await r.flow.create('My Eupova wallet');
    assert.deepEqual(out, {ok: true});
    assert.deepEqual(r.sdkLog.map(x => x[0]), ['new', 'device', 'auth', 'execute'], 'getDeviceId before setAuthentication before execute');
    assert.deepEqual(r.sdkLog[2], ['auth', 'string', 'string']);
    const w = (await r.state()).wallet;
    assert.equal(w.status, 'ready'); assert.equal(w.address, '0x' + 'a'.repeat(40)); assert.equal(w.environment, 'testnet');
    assert.deepEqual(r.notes.filter(Boolean), []);
  } finally { await r.s.close(); }
});

test('create: closing the PIN step early leaves a resumable pending wallet with a friendly message; continuing finishes it', async () => {
  const r = await rig();
  try {
    r.hooks.execute = async () => new Error('closed by the customer');
    const first = await r.flow.create('My Eupova wallet');
    assert.deepEqual(first, {ok: false, step: 'challenge', resumable: true});
    assert.match(r.notes.at(-1), /nothing has been sent/i);
    assert.equal((await r.state()).wallet.status, 'pending_setup');
    // "Check again" before the PIN step is done does not open anything.
    assert.deepEqual(await r.flow.checkSetup(), {ok: false}); assert.equal((await r.state()).wallet.status, 'pending_setup');
    r.hooks.execute = async () => { r.s.st.pinDone = true; return null; };
    assert.deepEqual(await r.flow.resumeSetup(), {ok: true});
    assert.equal((await r.state()).wallet.status, 'ready');
    assert.equal((await r.state()).payments.length, 0);
  } finally { await r.s.close(); }
});

async function readyWallet(r) {
  r.s.st.pinDone = true; r.hooks.execute = async () => null;
  assert.deepEqual(await r.flow.create('My Eupova wallet'), {ok: true});
}
const sendRequest = async (r, amount = '2.5') => (await r.act('wallet/send', {requestId: randomUUID(), destination: DEST, amount})).customerWallet.payments[0];

test('approve: the reservation is saved BEFORE the PIN step; settlement comes only from a matching network record', async () => {
  const r = await rig();
  try {
    await readyWallet(r);
    const p = await sendRequest(r);
    assert.equal(p.status, 'awaiting_approval'); assert.equal(p.canApprove, true);
    let during;
    r.hooks.execute = async () => { during = await r.state(); r.s.st.found = txFor(p); return null; };
    const out = await r.flow.decide(p, 'approve');
    assert.deepEqual(out, {ok: true});
    assert.equal(during.payments[0].status, 'executing', 'saved as executing before Circle\'s step ran');
    assert.equal(during.balance.reservedUsdc, '2.500000'); assert.equal(during.balance.availableUsdc, '47.500000');
    const after = (await r.state()).payments[0];
    assert.equal(after.status, 'succeeded'); assert.equal(after.receipt.verifiedOnChain, true);
    assert.equal((await r.state()).balance.reservedUsdc, '0.000000', 'the reservation is released once settled');
    assert.equal(r.sdkLog.filter(x => x[0] === 'execute' && String(x[1]).startsWith('pay-')).length, 1, 'one payment step (the other execute was the wallet setup)');
  } finally { await r.s.close(); }
});

test('approve: abandoning the PIN step keeps the reservation; continuing resumes the same payment; nothing is sent twice', async () => {
  const r = await rig();
  try {
    await readyWallet(r);
    const p = await sendRequest(r, '1');
    r.hooks.execute = async () => new Error('closed');
    const out = await r.flow.decide(p, 'approve');
    assert.deepEqual(out, {ok: false, step: 'challenge', resumable: true});
    assert.match(r.notes.at(-1), /continue where you left off/i);
    const mid = await r.state();
    assert.equal(mid.payments[0].status, 'executing'); assert.equal(mid.payments[0].canResume, true); assert.equal(mid.balance.reservedUsdc, '1.000000');
    r.hooks.execute = async () => { r.s.st.found = txFor(p); return null; };
    assert.deepEqual(await r.flow.resumePayment(mid.payments[0]), {ok: true});
    assert.equal((await r.state()).payments[0].status, 'succeeded');
    assert.equal(r.s.st.calls.filter(c => c.exec).length, 1, 'the provider was asked to create the transaction exactly once');
  } finally { await r.s.close(); }
});

test('approve: a network record that differs from the approval never settles; "Check again" cannot be talked into it', async () => {
  const r = await rig();
  try {
    await readyWallet(r);
    const p = await sendRequest(r, '3');
    r.hooks.execute = async () => { r.s.st.found = txFor(p, {}, {amounts: ['30']}); return null; };
    await r.flow.decide(p, 'approve');
    let now = (await r.state()).payments[0];
    assert.equal(now.status, 'outcome_unknown'); assert.equal((await r.state()).balance.reservedUsdc, '3.000000', 'funds stay reserved');
    for (const over of [{destination: '0x' + 'e'.repeat(40)}, {tokenId: 'tok-other'}, {refId: randomUUID()}, {walletId: 'w-2'}, {blockchain: 'BASE'}]) {
      r.s.st.found = txFor(p, {}, over); await r.flow.check(now);
      assert.notEqual((await r.state()).payments[0].status, 'succeeded', JSON.stringify(over));
    }
    r.s.st.found = txFor(p);                       // the matching record finally appears
    await r.flow.check(now);
    assert.equal((await r.state()).payments[0].status, 'succeeded');
  } finally { await r.s.close(); }
});

test('decline never opens the PIN step; a lapsed or someone else\'s request cannot be driven through the flow', async () => {
  const r = await rig(), other = await rig();
  try {
    await readyWallet(r);
    const steps = () => r.sdkLog.filter(x => x[0] === 'execute' && String(x[1]).startsWith('pay-')).length;
    const p = await sendRequest(r);
    assert.deepEqual(await r.flow.decide(p, 'decline'), {ok: true});
    assert.equal(steps(), 0);
    assert.equal((await r.state()).payments[0].status, 'declined');
    // A stale fingerprint is refused and no step runs.
    const q = await sendRequest(r, '1');
    const stale = await r.flow.decide({...q, fingerprint: 'f'.repeat(64)}, 'approve');
    assert.deepEqual(stale, {ok: false, step: 'decide'}); assert.equal(steps(), 0);
    // Another customer's flow against this payment id finds nothing.
    await readyWallet(other);
    assert.deepEqual(await other.flow.decide(q, 'approve'), {ok: false, step: 'decide'});
    assert.equal(other.sdkLog.filter(x => x[0] === 'execute' && String(x[1]).startsWith('pay-')).length, 0);
    assert.ok(other.errors.length > 0);
  } finally { await r.s.close(); await other.s.close(); }
});
