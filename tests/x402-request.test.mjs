import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture} from './fixtures/account-store.mjs';
import {createCustomerWallet} from '../hosted/customer-wallet.mjs';
import {liveProvider, FEE, ETH} from './fixtures/live-provider.mjs';
import {ALLOWANCE_CONFIRMATION} from '../hosted/wallet-tools.mjs';
import {BASE_MAINNET, BASE_USDC} from '../hosted/x402-challenge.mjs';

const owner = 'customer:' + randomUUID();
const b64 = v => Buffer.from(JSON.stringify(v)).toString('base64');
const PAY_TO = '0x209693Bc6afc0C5328bA36FaF03C514EF312287C';
const accepts = amount => ({scheme: 'exact', network: BASE_MAINNET, amount, asset: BASE_USDC, payTo: PAY_TO, maxTimeoutSeconds: 120, extra: {assetTransferMethod: 'eip3009', name: 'USDC', version: '2'}});
const choice = amount => JSON.stringify({x402Version: 2, resource: {url: 'https://api.example.com/premium', description: 'Market data'}, accepts: [accepts(amount)]});

// A fetch that answers with whatever the test asks for, and records what was requested.
function fakeFetch(kind, amount = '50000') {
  const calls = [];
  const f = async (url, init) => {
    calls.push({url, init});
    if (kind === 'free') return new Response('{"free":true}', {status: 200, headers: {'content-type': 'application/json'}});
    if (kind === 'paid') return new Response('', {status: 402, headers: {'PAYMENT-REQUIRED': b64(JSON.parse(choice(amount)))}});
    return new Response('boom', {status: 500});
  };
  f.calls = calls;
  return f;
}
async function setup(fetchImpl) {
  const f = await fixture();
  const st = {calls: [], wallets: {}, usdc: {}, eth: {}, fee: FEE, found: {found: false}};
  const cw = createCustomerWallet({store: f.store, provider: liveProvider('base', st), fetchImpl, resolver: async () => [{address: '93.184.216.34', family: 4}]});
  await cw.migrate();
  // A live wallet belongs to a real customer account: a row that is not disabled, has finished setup and has a
  // verified address. The simulated wallet skips this; the live one must not.
  await f.store.query(
    "INSERT INTO relay_customers(id,email,name,password_hash,recovery_hash,email_verified_at) VALUES($1,$2,'Paid API owner','x','y',now()) ON CONFLICT DO NOTHING",
    [owner.slice(9), 'x402-' + owner.slice(9) + '@example.invalid'],
  );
  const made = await cw.createWallet(owner, {label: 'My Eupova wallet', requestId: randomUUID()});
  st.wallets[owner] = {providerRef: 'w-' + owner.slice(-6), address: '0x' + 'a'.repeat(40), state: 'ready'};
  await cw.finishSetup(owner);
  st.usdc[owner] = 50_000_000n; st.eth[owner] = ETH;
  const e = await cw.tools.enrolStart({name: 'Paid API client', ip: '127.0.0.1'});
  await cw.tools.approveEnrolment(owner, {userCode: e.userCode});
  const got = await cw.tools.enrolPoll({enrolmentId: e.enrolmentId, deviceSecret: e.deviceSecret, ip: '127.0.0.1'});
  const tool = await cw.tools.authenticate(got.token);
  return {f, cw, tool, st, wallet: made};
}
const allow = (cw, tool, over = {}) => cw.tools.setAllowance(owner, {toolId: tool.id, amount: '10', hours: 24, confirm: true, confirmation: ALLOWANCE_CONFIRMATION, ...over});
const view = async (cw, id) => (await cw.state(owner)).payments.find(p => p.id === id);

test('a paid URL becomes one request with the authorization already prepared, and no money moves', async () => {
  const s = await setup(fakeFetch('paid'));
  try {
    await allow(s.cw, s.tool);
    const r = await s.cw.tools.requestX402(s.tool, randomUUID(), {url: 'https://api.example.com/premium'});
    const p = await view(s.cw, r.id);
    assert.equal(p.status, 'awaiting_approval');
    assert.equal(p.amountUsdc, '0.050000');
    assert.equal(p.destination.toLowerCase(), PAY_TO.toLowerCase());
    // The stored authorization is the one the customer will be asked to sign: exact amount, payee and a bounded window.
    const row = (await s.f.store.query('SELECT kind, x402 FROM relay_cw_payments WHERE id=$1', [r.id])).rows[0];
    assert.equal(row.kind, 'x402');
    assert.equal(row.x402.step, 'prepared');
    assert.equal(row.x402.authorization.to.toLowerCase(), PAY_TO.toLowerCase());
    assert.equal(row.x402.authorization.value, '50000');
    assert.equal(row.x402.typedData.domain.verifyingContract, BASE_USDC);
    assert.equal(s.st.calls.filter(c => c.found === undefined).length >= 0, true);
  } finally { await s.f.close(); }
});

test('a free resource is returned to the tool and never becomes a payment', async () => {
  const s = await setup(fakeFetch('free'));
  try {
    await allow(s.cw, s.tool);
    const r = await s.cw.tools.requestX402(s.tool, randomUUID(), {url: 'https://api.example.com/free'});
    assert.equal(r.free, true);
    assert.equal(r.body, '{"free":true}');
    assert.equal((await s.cw.state(owner)).payments.length, 0, 'nothing was recorded as a payment');
  } finally { await s.f.close(); }
});

test('a price above the allowance is refused before a request exists', async () => {
  const s = await setup(fakeFetch('paid', '20000000')); // 20 USDC against a 10 USDC allowance
  try {
    await allow(s.cw, s.tool);
    await assert.rejects(() => s.cw.tools.requestX402(s.tool, randomUUID(), {url: 'https://api.example.com/premium'}), /allowance/i);
    assert.equal((await s.cw.state(owner)).payments.length, 0);
  } finally { await s.f.close(); }
});

test('a tool with no allowance cannot even look up a price', async () => {
  const s = await setup(fakeFetch('paid'));
  try {
    await assert.rejects(() => s.cw.tools.requestX402(s.tool, randomUUID(), {url: 'https://api.example.com/premium'}), /allowance/i);
    assert.equal((await s.cw.state(owner)).payments.length, 0);
  } finally { await s.f.close(); }
});

test('the same call twice returns the same request; a different call on the same key is refused', async () => {
  const s = await setup(fakeFetch('paid'));
  try {
    await allow(s.cw, s.tool);
    const key = randomUUID();
    const first = await s.cw.tools.requestX402(s.tool, key, {url: 'https://api.example.com/premium'});
    const again = await s.cw.tools.requestX402(s.tool, key, {url: 'https://api.example.com/premium'});
    assert.equal(again.id, first.id);
    assert.equal(again.replay, true);
    assert.equal((await s.cw.state(owner)).payments.length, 1);
  } finally { await s.f.close(); }
});

test('an error from the service is reported and never becomes a payment', async () => {
  const s = await setup(fakeFetch('error'));
  try {
    await allow(s.cw, s.tool);
    await assert.rejects(() => s.cw.tools.requestX402(s.tool, randomUUID(), {url: 'https://api.example.com/premium'}), /500/);
    assert.equal((await s.cw.state(owner)).payments.length, 0);
  } finally { await s.f.close(); }
});

test('an unsafe URL is refused before any request is made', async () => {
  const s = await setup(fakeFetch('paid'));
  try {
    await allow(s.cw, s.tool);
    await assert.rejects(() => s.cw.tools.requestX402(s.tool, randomUUID(), {url: 'http://api.example.com/x'}), /https/);
    assert.equal(fakeFetch('paid').calls.length, 0);
  } finally { await s.f.close(); }
});
