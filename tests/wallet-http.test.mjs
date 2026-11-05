import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createCustomerWallet} from '../hosted/customer-wallet.mjs';
import {ALLOWANCE_CONFIRMATION} from '../hosted/wallet-tools.mjs';
import {fixture} from './fixtures/account-store.mjs';
import {server, DEST} from './fixtures/wallet-server.mjs';

test('create wallet -> displayed wallet -> fund the same wallet -> activity -> tool request -> allowance AND approval -> receipt (over HTTP)', async () => {
  const s = await server();
  try {
    const alice = await s.signup('wallet-a@example.invalid');
    let st = (await s.web('state', undefined, alice)).json;
    assert.equal(st.customerWallet.enabled, true); assert.equal(st.customerWallet.wallet, null);
    // Create inside Eupova (no external wallet involved).
    st = (await s.web('wallet/create', {label: 'My Eupova wallet', requestId: randomUUID()}, alice)).json;
    const w = st.customerWallet.wallet;
    assert.equal(w.label, 'My Eupova wallet'); assert.match(w.address, /^0x51ed/); assert.equal(w.simulated, true); assert.equal(st.customerWallet.balance.usdc, '0.000000');
    // The same address is a saved receiving wallet for the existing Pay on Eupova flow.
    assert.ok(st.agents.some(a => a.address === w.address && a.ownership === 'eupova_customer_wallet'));
    st = (await s.web('wallet/add-money', {requestId: randomUUID(), pence: 2500}, alice)).json;
    assert.equal(st.customerWallet.balance.usdc, '30.625000'); assert.equal(st.customerWallet.activity[0].simulated, true);
    // Pair a tool (device flow), choose an allowance, request a payment.
    const enrol = (await s.tool('POST', 'enrol', {name: 'Eupova CLI'})).json;
    assert.equal((await s.tool('POST', 'enrol/poll', {enrolmentId: enrol.enrolmentId, deviceSecret: enrol.deviceSecret})).json.status, 'pending');
    st = (await s.web('wallet/tools/approve-enrolment', {userCode: enrol.userCode}, alice)).json;
    const toolId = st.customerWallet.tools[0].id;
    const got = (await s.tool('POST', 'enrol/poll', {enrolmentId: enrol.enrolmentId, deviceSecret: enrol.deviceSecret})).json;
    assert.equal(got.status, 'approved');
    const key = randomUUID(), body = {service: 'Weather API', destination: DEST, amount: '1.25', maxFee: '0.05'};
    const none = await s.tool('POST', 'payments', body, got.token, {'idempotency-key': key});
    assert.equal(none.status, 202); assert.equal(none.json.status, 'rejected'); assert.equal(none.json.reasonCode, 'no_allowance');
    st = (await s.web('wallet/tools/allowance', {toolId, amount: '10', hours: 24, confirm: true, confirmation: ALLOWANCE_CONFIRMATION}, alice)).json;
    assert.equal(st.customerWallet.tools[0].allowance.remainingUsdc, '10.000000');
    const key2 = randomUUID();
    const req = await s.tool('POST', 'payments', body, got.token, {'idempotency-key': key2});
    assert.equal(req.status, 202); assert.equal(req.json.status, 'awaiting_approval'); assert.equal(req.json.destination, DEST);
    assert.equal((await s.tool('POST', 'payments', body, got.token, {'idempotency-key': key2})).status, 200, 'replay returns the same request');
    assert.equal((await s.tool('GET', 'payments/' + req.json.id, undefined, got.token)).json.status, 'awaiting_approval', 'allowance alone does not pay');
    st = (await s.web('state', undefined, alice)).json;
    const pending = st.customerWallet.pendingApprovals[0];
    assert.equal(pending.service, 'Weather API'); assert.equal(pending.capUsdc, '1.300000'); assert.equal(pending.tool.name, 'Eupova CLI');
    st = (await s.web('wallet/payments/decide', {id: pending.id, decision: 'approve', bindingHash: pending.fingerprint}, alice)).json;
    assert.equal(st.customerWallet.payments.find(p => p.id === pending.id).status, 'succeeded');
    assert.equal(st.customerWallet.balance.usdc, '29.365000'); assert.equal(st.customerWallet.tools[0].allowance.spentUsdc, '1.260000');
    const done = (await s.tool('GET', 'payments/' + req.json.id, undefined, got.token)).json;
    assert.equal(done.status, 'succeeded'); assert.equal(done.receipt.simulated, true); assert.match(done.receipt.note, /not a blockchain transaction/);
    assert.doesNotMatch(JSON.stringify(st) + JSON.stringify(done), /0x[0-9a-fA-F]{64}/);
    // The tool token appears nowhere in any response the browser or the tool gets back.
    for (const text of [JSON.stringify(st), JSON.stringify(done)]) assert.ok(!text.includes(got.token));
    // Simulated money never shows up as a Base payment record.
    assert.equal((await s.f.store.query("SELECT count(*) FROM relay_live_orders")).rows[0].count.toString(), '0');
  } finally { await s.close(); }
});

test('the tool credential cannot approve itself, use the browser API, or ride a browser session; the browser session cannot use the tool API', async () => {
  const s = await server();
  try {
    const cookie = await s.signup('wallet-b@example.invalid');
    await s.web('wallet/create', {label: 'Second wallet', requestId: randomUUID()}, cookie);
    await s.web('wallet/add-money', {requestId: randomUUID(), pence: 2500}, cookie);
    const enrol = (await s.tool('POST', 'enrol', {name: 'CLI'})).json;
    const st0 = (await s.web('wallet/tools/approve-enrolment', {userCode: enrol.userCode}, cookie)).json;
    const token = (await s.tool('POST', 'enrol/poll', {enrolmentId: enrol.enrolmentId, deviceSecret: enrol.deviceSecret})).json.token;
    const toolId = st0.customerWallet.tools[0].id;
    await s.web('wallet/tools/allowance', {toolId, amount: '5', hours: 2, confirm: true, confirmation: ALLOWANCE_CONFIRMATION}, cookie);
    const r = (await s.tool('POST', 'payments', {service: 'Svc', destination: DEST, amount: '1', maxFee: '0'}, token, {'idempotency-key': randomUUID()})).json;
    const fp = (await s.web('state', undefined, cookie)).json.customerWallet.pendingApprovals[0].fingerprint;
    // The tool has no approval route at all, and its bearer token is not a session.
    for (const path of ['wallet/payments/decide', 'wallet/tools/allowance', 'wallet/send', 'wallet/tools/revoke']) {
      const res = await fetch(s.origin + '/api/' + path, {method: 'POST', headers: {'content-type': 'application/json', origin: s.origin, authorization: 'Bearer ' + token}, body: JSON.stringify({id: r.id, decision: 'approve', bindingHash: fp, toolId, amount: '1', hours: 1, confirm: true})});
      assert.ok([401, 403].includes(res.status) || (await res.json().catch(() => ({}))).customerWallet === undefined, path + ' ' + res.status);
      assert.notEqual(res.status, 200, path);
    }
    for (const [method, path] of [['POST', 'payments/decide'], ['POST', 'tools/allowance'], ['GET', 'payments/' + r.id + '/approve']]) {
      assert.equal((await s.tool(method, path, method === 'POST' ? {id: r.id} : undefined, token)).status, 404, 'no approval or allowance route exists on the tool API: ' + path);
    }
    assert.equal((await s.web('state', undefined, cookie)).json.customerWallet.payments.find(p => p.id === r.id).status, 'awaiting_approval', 'still waiting for the customer');
    // The browser session is refused on the tool API (cookie, origin and fetch-metadata headers all rejected).
    assert.equal((await s.tool('GET', 'allowance', undefined, token, {cookie})).status, 403);
    assert.equal((await s.tool('GET', 'allowance', undefined, token, {origin: s.origin})).status, 403);
    assert.equal((await s.tool('GET', 'allowance', undefined, undefined, {cookie})).status, 403);
    assert.equal((await s.tool('GET', 'allowance')).status, 401);
    assert.equal((await s.tool('GET', 'allowance', undefined, 'eut_' + 'A'.repeat(43))).status, 401);
    // Browser routes need a customer session, the right origin, JSON and POST.
    assert.equal((await s.web('wallet/send', {requestId: randomUUID(), destination: DEST, amount: '1'})).status >= 400, true, 'anonymous');
    assert.equal((await s.web('wallet/payments/decide', {id: r.id, decision: 'approve', bindingHash: fp}, cookie, {origin: 'https://evil.example'})).status, 403, 'foreign origin');
    assert.equal((await s.web('wallet/payments/decide', {id: r.id, decision: 'approve', bindingHash: fp}, cookie, {'sec-fetch-site': 'cross-site'})).status, 403);
    assert.ok([401, 404].includes((await s.web('wallet/state')).status), 'GET is never a wallet route');
    assert.equal((await s.web('wallet/nope', {}, cookie)).status, 404);
    // Revoking the tool ends its credential immediately.
    await s.web('wallet/tools/revoke', {toolId}, cookie);
    assert.equal((await s.tool('GET', 'allowance', undefined, token)).status, 401);
    assert.equal((await s.tool('GET', 'payments/' + r.id, undefined, token)).status, 401);
  } finally { await s.close(); }
});

test('two customers: each sees only their own wallet, tools and requests', async () => {
  const s = await server();
  try {
    const a = await s.signup('iso-a@example.invalid'), b = await s.signup('iso-b@example.invalid');
    await s.web('wallet/create', {label: 'A wallet', requestId: randomUUID()}, a); await s.web('wallet/add-money', {requestId: randomUUID(), pence: 2500}, a);
    await s.web('wallet/create', {label: 'B wallet', requestId: randomUUID()}, b); await s.web('wallet/add-money', {requestId: randomUUID(), pence: 1000}, b);
    const sa = (await s.web('wallet/send', {requestId: randomUUID(), destination: DEST, amount: '1'}, a)).json;
    const pa = sa.customerWallet.pendingApprovals[0];
    const sb = (await s.web('state', undefined, b)).json.customerWallet;
    assert.equal(sb.wallet.label, 'B wallet'); assert.equal(sb.balance.usdc, '12.250000'); assert.equal(sb.payments.length, 0);
    assert.ok(!JSON.stringify(sb).includes(pa.id));
    const steal = await s.web('wallet/payments/decide', {id: pa.id, decision: 'approve', bindingHash: pa.fingerprint}, b);
    assert.equal(steal.status, 404);
    assert.equal((await s.web('state', undefined, a)).json.customerWallet.payments[0].status, 'awaiting_approval');
    // Another customer's code cannot be used to connect a tool to the wrong wallet.
    const enrol = (await s.tool('POST', 'enrol', {name: 'CLI'})).json;
    const mine = (await s.web('wallet/tools/approve-enrolment', {userCode: enrol.userCode}, a)).json;
    assert.equal((await s.web('state', undefined, b)).json.customerWallet.tools.length, 0);
    assert.equal(mine.customerWallet.tools.length, 1);
  } finally { await s.close(); }
});

test('production guard: the customer wallet exists only as a simulated local preview feature', async () => {
  const {createHostedServer} = await import('../hosted/server.mjs');
  const f = await fixture();
  try {
    const cw = createCustomerWallet({store: f.store});
    const config = {origin: 'https://example.invalid', host: 'example.invalid', testers: []};
    assert.throws(() => createHostedServer({store: f.store, config, customerWallet: cw, pay: {readiness: async () => ({ready: false})}}), /local-preview feature only/i);
    const real = {...cw, simulated: false};
    assert.throws(() => createHostedServer({store: f.store, config: {origin: 'http://127.0.0.1:1', host: '127.0.0.1:1', testers: []}, paymentsDisabled: true, localPreview: true, tracking: {simulated: true}, customerWallet: real, pay: {readiness: async () => ({ready: false})}}));
    assert.throws(() => createCustomerWallet({store: f.store, provider: {id: 'mystery', simulated: false, executeTransfer() {}}}), /Unknown wallet provider/);
  } finally { await f.close(); }
});

test("a disabled account's connected tool stops working at once, and works again only when the account does", async () => {
  const s = await server();
  try {
    const email = 'cli-' + randomUUID().slice(0, 8) + '@example.test', alice = await s.signup(email);
    await s.web('wallet/create', {label: 'My Eupova wallet', requestId: randomUUID()}, alice);
    await s.web('wallet/add-money', {requestId: randomUUID(), pence: 2500}, alice);
    const enrol = (await s.tool('POST', 'enrol', {name: 'Eupova CLI'})).json;
    await s.web('wallet/tools/approve-enrolment', {userCode: enrol.userCode}, alice);
    const got = (await s.tool('POST', 'enrol/poll', {enrolmentId: enrol.enrolmentId, deviceSecret: enrol.deviceSecret})).json;
    const toolId = (await s.web('state', undefined, alice)).json.customerWallet.tools[0].id;
    await s.web('wallet/tools/allowance', {toolId, amount: '10', hours: 24, confirm: true, confirmation: ALLOWANCE_CONFIRMATION}, alice);
    const body = {service: 'Weather API', destination: DEST, amount: '1.25', maxFee: '0.05'};
    assert.equal((await s.tool('GET', 'allowance', undefined, got.token)).status, 200);
    assert.equal((await s.tool('POST', 'payments', body, got.token, {'idempotency-key': randomUUID()})).status, 202);
    await s.f.store.query('UPDATE relay_customers SET disabled=true WHERE lower(email)=lower($1)', [email]);
    assert.equal((await s.tool('GET', 'allowance', undefined, got.token)).status, 403, 'the allowance is no longer readable');
    const key = randomUUID();
    assert.equal((await s.tool('POST', 'payments', body, got.token, {'idempotency-key': key})).status, 403, 'no new request can be made');
    assert.equal((await s.f.store.query("SELECT count(*) c FROM relay_cw_payments WHERE request_id=$1", [key])).rows[0].c * 1, 0, 'nothing was saved for it');
    assert.equal((await s.web('state', undefined, alice)).status, 401, 'the customer\'s own session is refused too');
    await s.f.store.query('UPDATE relay_customers SET disabled=false WHERE lower(email)=lower($1)', [email]);
    assert.equal((await s.tool('GET', 'allowance', undefined, got.token)).status, 200, 'only the account being active again restores it');
  } finally { await s.close(); }
});
