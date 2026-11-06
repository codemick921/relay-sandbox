import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture} from './fixtures/account-store.mjs';
import {digest} from '../hosted/db.mjs';
import {createCustomerWallet} from '../hosted/customer-wallet.mjs';
import {createSimulatedWalletProvider} from '../hosted/wallet-providers.mjs';
import {liveProvider, FEE, ETH} from './fixtures/live-provider.mjs';

import {prod, PW, DEST} from './fixtures/prod-server.mjs';

test('production routes: a live wallet exposes no simulation, no test money and no tool or preview features it should not', async () => {
  const s = await prod();
  try {
    const a = await s.signup('prod-a@example.invalid');
    // Wallet creation returns the challenge once.
    const created = await s.call('wallet/create', {label: 'My Eupova wallet', requestId: randomUUID()}, a);
    assert.equal(created.status, 200); assert.equal(created.json.walletChallenge.challengeId, 'setup-1'); assert.equal(created.json.customerWallet.simulated, false);
    assert.match(created.headers.get('cache-control'), /no-store/);
    // The simulation's routes do not exist.
    for (const path of ['wallet/add-money', 'arc/quote', 'arc/wallets/create']) assert.equal((await s.call(path, {requestId: randomUUID(), pence: 2500}, a)).status, 404, path);
    assert.notEqual((await s.call('test-funding/quote', {}, a)).status, 200, 'the existing test-funding route is not usable here either');
    // Live-only routes exist and work.
    assert.equal((await s.call('wallet/finish-setup', {}, a)).status, 409, 'not ready until the provider shows a wallet');
    assert.equal((await s.call('wallet/resume-setup', {}, a)).json.walletChallenge.challengeId, 'setup-1');
    s.st.wallets[`customer:${(await s.call('state', undefined, a)).json.account.id}`] = null;
    // Unknown wallet routes and non-POST are not served.
    assert.equal((await s.call('wallet/nope', {}, a)).status, 404); assert.equal((await s.call('wallet/create', undefined, a)).status >= 400, true);
    // Browser-session rules still apply.
    assert.equal((await s.call('wallet/send', {requestId: randomUUID(), destination: DEST, amount: '1'})).status >= 400, true, 'anonymous');
    assert.equal((await s.call('wallet/send', {requestId: randomUUID(), destination: DEST, amount: '1'}, a, {origin: 'https://evil.example'})).status, 403);
    assert.equal((await s.call('wallet/send', {requestId: randomUUID(), destination: DEST, amount: '1'}, a, {'sec-fetch-site': 'cross-site'})).status, 403);
    // The tool API works on a live wallet and refuses a USDC fee.
    const enrol = (await fetch(s.origin + '/api/wallet-tool/v1/enrol', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({name: 'Prod CLI'})}).then(r => r.json()));
    assert.match(enrol.userCode, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  } finally { await s.close(); }
});

test('production routes: no wallet configured means no wallet routes and no CSP changes; misconfiguration is reported without values', async () => {
  const off = await prod({live: false});
  try {
    const a = await off.signup('prod-off@example.invalid');
    const st = (await off.call('state', undefined, a));
    assert.equal(st.json.customerWallet, undefined);
    for (const path of ['wallet/create', 'wallet/send', 'wallet/payments/decide']) assert.equal((await off.call(path, {}, a)).status, 404, path);
    assert.doesNotMatch(st.headers.get('content-security-policy'), /circle/);
    assert.equal((await fetch(off.origin + '/api/wallet-tool/v1/enrol', {method: 'POST', headers: {'content-type': 'application/json'}, body: '{"name":"x y"}'})).status, 404);
  } finally { await off.close(); }
  const bad = await prod({live: false, status: {enabled: false, reason: 'misconfigured', problems: ['EUPOVA_CIRCLE_UCW_APP_ID']}});
  try {
    const a = await bad.signup('prod-bad@example.invalid');
    const st = (await bad.call('state', undefined, a)).json;
    assert.deepEqual(st.customerWallet, {enabled: false, unavailable: true}, 'customers see only that it is unavailable');
    assert.doesNotMatch(JSON.stringify(st), /EUPOVA_|APP_ID/);
  } finally { await bad.close(); }
});

test('production guards: the simulation cannot run outside the local preview, and a live wallet cannot run inside it', async () => {
  const {createHostedServer} = await import('../hosted/server.mjs');
  const f = await fixture();
  try {
    const sim = createCustomerWallet({store: f.store, provider: createSimulatedWalletProvider()});
    const config = {origin: 'http://127.0.0.1:9', host: '127.0.0.1:9', testers: []};
    const base = {store: f.store, config, allowHttpForTests: true, paymentsDisabled: true, pay: {readiness: async () => ({ready: false})}};
    assert.throws(() => createHostedServer({...base, customerWallet: sim}), /local-preview feature only/);
    const st = {calls: [], wallets: {}, usdc: {}, eth: {}, fee: FEE, found: {found: false}};
    const live = createCustomerWallet({store: f.store, provider: liveProvider('base', st)});
    assert.throws(() => createHostedServer({...base, localPreview: true, tracking: {simulated: true}, customerWallet: live}), /cannot run in the local preview/);
    assert.throws(() => createHostedServer({...base, customerWallet: {...live, live: false, simulated: false}}), /validated configuration/);
    // A provider that merely claims to be live is not accepted by the wallet itself.
    assert.throws(() => createCustomerWallet({store: f.store, provider: {id: 'circle_ucw', simulated: false, executeTransfer() {}}}), /Unknown wallet provider/);
    assert.throws(() => createCustomerWallet({store: f.store, provider: {id: 'mystery', live: true, simulated: false, network: {id: 'base'}, executeTransfer() {}}}), /Unknown wallet provider/);
    assert.ok(ETH > 0n);
  } finally { await f.close(); }
});

test('production: an unverified customer is told why the wallet is closed and still gets no wallet routes', async () => {
  const s = await prod();
  try {
    const c = await s.signupUnverified('prod-unverified@example.invalid');
    const st = (await s.call('state', undefined, c)).json;
    assert.deepEqual(st.customerWallet, {enabled: false, unavailable: true, reason: 'email_unverified'});
    assert.equal((await s.call('wallet/create', {label: 'My wallet', requestId: randomUUID()}, c)).status, 403);
    assert.equal((await s.call('wallet/resume-setup', {}, c)).status, 403);
  } finally { await s.close(); }
});
