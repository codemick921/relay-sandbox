import test from 'node:test';
import {freePort} from './fixtures/free-port.mjs';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {fixture} from './fixtures/account-store.mjs';
import {digest} from '../hosted/db.mjs';
import {createArcFunding} from '../hosted/arc-funding.mjs';
import {seedArcFixtures} from '../hosted/arc-fixtures.mjs';
import {createSimulatedProviders} from '../hosted/arc-providers.mjs';
import {ARC_ROUTE, arcAddressCheck, arcQuote, settledFigures, units} from '../shared/arc-funding.mjs';
import {createLiveStore} from '../hosted/live-store.mjs';
import {createFundingJourney, journeyMerchant} from '../hosted/funding-journey.mjs';
import {createHostedServer} from '../hosted/server.mjs';

const owner = 'customer:' + randomUUID();
const other = 'customer:' + randomUUID();
async function setup() {
  const f = await fixture();
  const arc = createArcFunding({store: f.store});
  await arc.migrate();
  return {...f, arc};
}
const wallet = async (arc, who = owner, scenario = 'success', advances = 1, label = 'Test agent') => {
  const {id} = await arc.createWallet(who, {label, requestId: randomUUID(), scenario});
  for (let i = 0; i < advances; i++) await arc.walletAction(who, id, {action: 'advance'});
  return id;
};
const transfer = async (arc, walletId, who = owner, amount = '25', speed = 'fast') => {
  const {quote} = await arc.quote(who, {walletId, amount, speed});
  const {id} = await arc.createTransfer(who, {quoteId: quote.id, requestId: randomUUID(), confirm: true});
  return {id, quote};
};
const read = async (arc, who, id) => (await arc.state(who)).transfers.find(t => t.id === id);
const step = (arc, id, who = owner, action = 'advance') => arc.transferAction(who, id, {action});
// Reaches the point where the customer is asked to approve (payment, Base receipt, approval request).
const toApproval = async (arc, id, who = owner, scenario = 'success') => {
  await arc.transferAction(who, id, {action: 'submit', scenario});
  await step(arc, id, who); await step(arc, id, who);
};
const decide = async (arc, id, decision, who = owner) => {
  const t = await read(arc, who, id);
  return arc.decideApproval(who, {id, approvalId: t.approval.id, bindingHash: t.approval.bindingHash, decision});
};

test('quote shows matching pay and receive figures and separates estimated from settled output', async () => {
  const q = arcQuote({pence: 2500, speed: 'fast'});
  // Same example rate and 2% fee as the existing Base test journey: 25.00 GBP -> 30.625000 USDC on Base.
  assert.equal(q.grossUsdc, '31.250000');
  assert.equal(q.peerFeeUsdc, '0.625000');
  assert.equal(q.baseReceiveUsdc, '30.625000');
  assert.equal(BigInt(q.baseReceiveRaw) - BigInt(q.bridge.totalRaw), BigInt(q.estimatedArcRaw));
  assert.equal(q.bridge.basis, 'illustrative estimate');
  const settled = settledFigures(q);
  assert.equal(BigInt(q.baseReceiveRaw) - BigInt(settled.totalFeeRaw), BigInt(settled.arcOutputRaw));
  assert.notEqual(settled.arcOutputRaw, q.estimatedArcRaw, 'settled output must be reported separately from the estimate');
  assert.ok(BigInt(settled.arcOutputRaw) >= BigInt(q.estimatedArcRaw));
  const standard = arcQuote({pence: 2500, speed: 'standard'});
  assert.equal(standard.bridge.protocolFeeRaw, '0', 'Standard CCTP transfers carry no protocol fee (Circle docs)');
  assert.ok(BigInt(standard.estimatedArcRaw) > BigInt(q.estimatedArcRaw));
  assert.equal(units('1'), '0.000001');
  assert.throws(() => arcQuote({pence: 100}), RangeError);
  assert.throws(() => arcQuote({pence: 2500, speed: 'instant'}), RangeError);
});

test('address-format check never claims network support or ownership', () => {
  const ok = arcAddressCheck('0x1111111111111111111111111111111111111111');
  assert.equal(ok.valid, true);
  assert.equal(ok.networkChecked, false);
  assert.equal(ok.ownershipChecked, false);
  assert.match(ok.message, /format checked only/i);
  assert.match(ok.message, /not confirmed this address on Arc/i);
  assert.doesNotMatch(ok.message, /supported|verified|owned by you|valid on arc/i);
  for (const bad of ['', 'nope', '0x123', '0x' + '0'.repeat(40), '0x3600000000000000000000000000000000000000']) {
    const r = arcAddressCheck(bad);
    assert.equal(r.valid, false, bad);
    assert.equal(r.networkChecked, false);
    assert.equal(r.ownershipChecked, false);
  }
});

test('simulated agentic wallets: pending, failure, retry, limits and clear simulated labelling', async () => {
  const f = await setup();
  try {
    const slow = await wallet(f.arc, owner, 'slow', 1);
    let w = (await f.arc.state(owner)).wallets.find(x => x.id === slow);
    assert.equal(w.status, 'provisioning');
    assert.equal(w.address, null);
    await f.arc.walletAction(owner, slow, {action: 'advance'});
    w = (await f.arc.state(owner)).wallets.find(x => x.id === slow);
    assert.equal(w.status, 'ready');
    assert.match(w.address, /^0x51ed[0-9a-f]{36}$/, 'synthetic, recognisable address');
    assert.equal(w.simulated, true);
    assert.equal(w.provider, 'simulated');

    const bad = await wallet(f.arc, owner, 'failure', 1, 'Failing');
    w = (await f.arc.state(owner)).wallets.find(x => x.id === bad);
    assert.equal(w.status, 'failed');
    assert.equal(w.canRetry, true);
    await f.arc.walletAction(owner, bad, {action: 'retry'});
    await f.arc.walletAction(owner, bad, {action: 'advance'});
    w = (await f.arc.state(owner)).wallets.find(x => x.id === bad);
    assert.equal(w.status, 'ready');
    assert.equal(w.attempt, 2);
    assert.ok(w.events.length >= 4);

    await assert.rejects(f.arc.walletAction(owner, bad, {action: 'retry'}), e => e.status === 409);
    await assert.rejects(f.arc.createWallet(owner, {label: 'x', requestId: randomUUID()}), /2 to 40/);
    await assert.rejects(f.arc.createWallet(owner, {label: 'Fine', requestId: randomUUID(), scenario: 'chaos'}), /outcome/);
    // idempotent request id
    const req = randomUUID();
    const a = await f.arc.createWallet(owner, {label: 'Same', requestId: req});
    const b = await f.arc.createWallet(owner, {label: 'Same', requestId: req});
    assert.equal(a.id, b.id);
    await assert.rejects(f.arc.createWallet(owner, {label: 'Different', requestId: req}), e => e.status === 409);
    for (let i = 0; i < 2; i++) await wallet(f.arc, owner, 'success', 0, 'Filler ' + i);
    await assert.rejects(wallet(f.arc, owner, 'success', 0, 'Over limit'), /up to 5/);
  } finally { await f.close(); }
});

test('Base-to-Arc bridge: pending to settled, with estimate then settled output and a full history', async () => {
  const f = await setup();
  try {
    const w = await wallet(f.arc);
    const {id, quote} = await transfer(f.arc, w);
    let t = await read(f.arc, owner, id);
    assert.equal(t.status, 'awaiting_payment');
    assert.equal(t.settled, null);
    assert.equal(t.estimatedArcUsdc, quote.estimatedArcUsdc);
    await f.arc.transferAction(owner, id, {action: 'submit', scenario: 'success', amount: '1', walletId: 'evil', quote: {}});
    const seen = [];
    for (let i = 0; i < 2; i++) { await step(f.arc, id); seen.push((await read(f.arc, owner, id)).status); }
    assert.deepEqual(seen, ['base_received', 'approval_pending'], 'nothing is burned until the customer approves');
    await assert.rejects(step(f.arc, id), e => e.status === 409, 'advancing cannot skip the approval');
    await decide(f.arc, id, 'approve');
    seen.push((await read(f.arc, owner, id)).status);
    for (let i = 0; i < 3; i++) { await step(f.arc, id); seen.push((await read(f.arc, owner, id)).status); }
    assert.deepEqual(seen, ['base_received', 'approval_pending', 'bridge_burn_pending', 'bridge_attestation_pending', 'bridge_mint_pending', 'settled']);
    t = await read(f.arc, owner, id);
    assert.equal(t.terminal, true);
    assert.equal(t.baseReceivedUsdc, quote.baseReceiveUsdc, 'Base receipt matches the quoted figure');
    assert.equal(t.settled.arcOutputUsdc, settledFigures(quote).arcOutputUsdc);
    assert.notEqual(t.settled.arcOutputUsdc, t.estimatedArcUsdc);
    assert.equal(t.fundsLocation, 'Arc');
    assert.equal(t.events.length, 8, 'created, payment, receipt, approval requested, approved, attestation, mint pending, settled');
    assert.match(t.events.at(-1).note, /estimate was/);
    await assert.rejects(step(f.arc, id), e => e.status === 409);
    await assert.rejects(f.arc.transferAction(owner, id, {action: 'cancel'}), e => e.status === 409);
    // Restart: a fresh module instance over the same database keeps everything.
    const again = createArcFunding({store: f.store});
    await again.migrate();
    const kept = await read(again, owner, id);
    assert.equal(kept.status, 'settled');
    assert.equal(kept.events.length, 8);
    assert.equal(kept.approval.status, 'approved', 'the approval survives a restart');
  } finally { await f.close(); }
});

test('bridge recovery: failure before the burn can resume or stay on Base; after the burn only resume', async () => {
  const f = await setup();
  try {
    const w = await wallet(f.arc);
    // Failure before burn: USDC is still on Base.
    let { id } = await transfer(f.arc, w);
    await toApproval(f.arc, id, owner, 'burn_failed');
    await decide(f.arc, id, 'approve');
    await step(f.arc, id);
    let t = await read(f.arc, owner, id);
    assert.equal(t.status, 'burn_failed');
    assert.equal(t.failureCode, 'burn_submission_failed');
    assert.equal(t.fundsLocation, 'Base');
    assert.equal(t.canHold, true);
    assert.match(t.hint, /still in your wallet on Base/);
    await step(f.arc, id, owner, 'retry');
    t = await read(f.arc, owner, id);
    assert.equal(t.status, 'bridge_burn_pending');
    assert.equal(t.attempt, 2);
    for (let i = 0; i < 3; i++) await step(f.arc, id);
    assert.equal((await read(f.arc, owner, id)).status, 'settled');

    // Keep on Base.
    ({ id } = await transfer(f.arc, w));
    await toApproval(f.arc, id, owner, 'burn_failed');
    await decide(f.arc, id, 'approve');
    await step(f.arc, id);
    await step(f.arc, id, owner, 'hold');
    t = await read(f.arc, owner, id);
    assert.equal(t.status, 'held_on_base');
    assert.equal(t.terminal, true);
    assert.equal(t.settled, null);

    // Failure after the burn: funds in transit; cannot be "kept on Base".
    ({ id } = await transfer(f.arc, w));
    await toApproval(f.arc, id, owner, 'attestation_failed');
    await decide(f.arc, id, 'approve');
    for (let i = 0; i < 2; i++) await step(f.arc, id);
    t = await read(f.arc, owner, id);
    assert.equal(t.status, 'burned_resume_required');
    assert.equal(t.failureCode, 'attestation_timeout');
    assert.match(t.fundsLocation, /In transit/);
    assert.equal(t.canHold, false);
    await assert.rejects(step(f.arc, id, owner, 'hold'), e => e.status === 409);
    await step(f.arc, id, owner, 'retry');
    t = await read(f.arc, owner, id);
    assert.equal(t.status, 'bridge_attestation_pending');
    assert.match(t.events.at(-1).note, /burn is not repeated/);

    // Declined payment and cancellation.
    ({ id } = await transfer(f.arc, w));
    await f.arc.transferAction(owner, id, {action: 'submit', scenario: 'payment_failed'});
    t = await read(f.arc, owner, id);
    assert.equal(t.status, 'payment_failed');
    assert.equal(t.terminal, true);
    ({ id } = await transfer(f.arc, w));
    await f.arc.transferAction(owner, id, {action: 'cancel'});
    assert.equal((await read(f.arc, owner, id)).status, 'cancelled');
  } finally { await f.close(); }
});

test('slow scenario needs an extra step; submit is idempotent only for the same outcome', async () => {
  const f = await setup();
  try {
    const w = await wallet(f.arc);
    const {id} = await transfer(f.arc, w, owner, '40', 'standard');
    await f.arc.transferAction(owner, id, {action: 'submit', scenario: 'slow'});
    await f.arc.transferAction(owner, id, {action: 'submit', scenario: 'slow'});
    await assert.rejects(f.arc.transferAction(owner, id, {action: 'submit', scenario: 'success'}), e => e.status === 409);
    for (let i = 0; i < 2; i++) await step(f.arc, id);
    await decide(f.arc, id, 'approve');
    await step(f.arc, id);
    assert.equal((await read(f.arc, owner, id)).status, 'bridge_attestation_pending');
    await step(f.arc, id);
    assert.equal((await read(f.arc, owner, id)).status, 'bridge_attestation_pending', 'one extra pending step');
    await step(f.arc, id);
    assert.equal((await read(f.arc, owner, id)).status, 'bridge_mint_pending');
  } finally { await f.close(); }
});

test('owner isolation, quote replay protection, expiry and wallet-ready guard', async () => {
  const f = await setup();
  try {
    const mine = await wallet(f.arc);
    const pending = await wallet(f.arc, owner, 'slow', 0, 'Not ready');
    await assert.rejects(f.arc.quote(owner, {walletId: pending, amount: '25'}), /not ready/);
    await assert.rejects(f.arc.quote(other, {walletId: mine, amount: '25'}), e => e.status === 404);
    await assert.rejects(f.arc.quote(owner, {walletId: mine, amount: '1'}), /£2/);
    await assert.rejects(f.arc.quote(owner, {walletId: mine, amount: '25', speed: 'instant'}), /Fast or Standard/);
    const {id, quote} = await transfer(f.arc, mine);
    assert.equal((await f.arc.state(other)).wallets.length, 0);
    assert.equal((await f.arc.state(other)).transfers.length, 0);
    for (const action of ['advance', 'cancel']) await assert.rejects(f.arc.transferAction(other, id, {action}), e => e.status === 404);
    await assert.rejects(f.arc.walletAction(other, mine, {action: 'advance'}), e => e.status === 404);
    await assert.rejects(f.arc.createTransfer(other, {quoteId: quote.id, requestId: randomUUID(), confirm: true}), /expired/);
    // Same request twice is one transfer; a different request on the same quote returns the original.
    const req = randomUUID();
    const one = await f.arc.createTransfer(owner, {quoteId: quote.id, requestId: req, confirm: true});
    const two = await f.arc.createTransfer(owner, {quoteId: quote.id, requestId: randomUUID(), confirm: true});
    assert.equal(one.id, id);
    assert.equal(two.id, id);
    assert.equal((await f.arc.state(owner)).transfers.length, 1);
    await assert.rejects(f.arc.createTransfer(owner, {quoteId: quote.id, requestId: randomUUID(), confirm: false}), /confirm/);
    // Expired quote.
    const fresh = await f.arc.quote(owner, {walletId: mine, amount: '30'});
    await f.store.query("UPDATE relay_arc_quotes SET expires_at=now()-interval '1 second' WHERE id=$1", [fresh.quote.id]);
    await assert.rejects(f.arc.createTransfer(owner, {quoteId: fresh.quote.id, requestId: randomUUID(), confirm: true}), /expired/);
    // Expired unpaid transfer cannot take a payment but can be cancelled.
    const late = await transfer(f.arc, mine, owner, '31');
    await f.store.query("UPDATE relay_arc_transfers SET quote=jsonb_set(quote,'{expiresAt}',to_jsonb(($2::timestamptz)::text)) WHERE id=$1", [late.id, new Date(Date.now() - 1000).toISOString()]);
    const view = await read(f.arc, owner, late.id);
    assert.equal(view.expired, true);
    assert.equal(view.canSubmit, false);
    await assert.rejects(f.arc.transferAction(owner, late.id, {action: 'submit', scenario: 'success'}), /expired/);
    await f.arc.transferAction(owner, late.id, {action: 'cancel'});
  } finally { await f.close(); }
});

test('fixtures seed every state, stay isolated per owner and keep only simulated records', async () => {
  const f = await setup();
  try {
    await seedArcFixtures(f.arc, owner, {tag: 'A'});
    await seedArcFixtures(f.arc, other, {tag: 'B', full: false});
    const s = await f.arc.state(owner);
    assert.deepEqual([...new Set(s.transfers.map(t => t.status))].sort(), ['approval_denied', 'approval_invalidated', 'approval_pending', 'awaiting_payment', 'bridge_attestation_pending', 'burn_failed', 'burned_resume_required', 'payment_failed', 'settled']);
    assert.deepEqual(s.wallets.map(w => w.status).sort(), ['failed', 'provisioning', 'ready']);
    assert.ok(s.wallets.every(w => w.simulated && w.provider === 'simulated'));
    assert.ok(s.transfers.every(t => t.simulated));
    assert.equal(s.providers.live, 'gated');
    assert.equal(s.route.live.available, false);
    assert.equal((await f.arc.state(other)).transfers.length, 1);
    assert.ok((await f.arc.state(other)).wallets.every(w => w.label.startsWith('B ')));
    const rows = (await f.store.query('SELECT count(*) FROM relay_arc_wallets WHERE simulated AND provider=$1', ['simulated'])).rows[0];
    assert.equal(Number(rows.count), 4);
    await assert.rejects(f.store.query("INSERT INTO relay_arc_wallets(id,owner,request_id,label,provider,status,scenario) VALUES($1,$2,$3,'x','circle','ready','success')", [randomUUID(), owner, randomUUID()]));
  } finally { await f.close(); }
});

test('isolation: no secrets, network access or production wiring in the Arc modules', () => {
  const read = p => readFileSync(new URL(p, import.meta.url), 'utf8');
  for (const file of ['../hosted/arc-funding.mjs', '../hosted/arc-providers.mjs', '../hosted/arc-fixtures.mjs', '../hosted/arc-approvals.mjs', '../hosted/arc-destinations.mjs', '../shared/arc-funding.mjs', '../src/arc-customer-signing.mjs']) {
    const src = read(file);
    assert.doesNotMatch(src, /process\.env|fetch\(|node:net|node:http|node:https|CIRCLE_API_KEY|ENTITY_SECRET|PRIVATE_KEY|privateKey|@circle-fin/, file);
    assert.doesNotMatch(src, /^\s*import .*(from)? ['"]viem['"]/m, file);
  }
  const server = read('../hosted/server.mjs');
  assert.doesNotMatch(server, /arc-funding|arc-providers|arc-fixtures/, 'the hosted server imports nothing from the Arc modules; they are injected');
  assert.match(server, /Arc agentic-wallet funding is a simulated, local-preview-only feature/);
  const preview = read('../hosted/tracking-preview.mjs');
  assert.match(preview, /createArcFunding\(\{store\}\)/);
  assert.doesNotMatch(read('../hosted/config.mjs'), /arc-funding|arcFunding|ARC_|arc_live/i, 'no production configuration switch exists');
});

async function previewServer() {
  const f = await setup();
  const live = createLiveStore(f.pool, {merchantId: journeyMerchant});
  await live.migrate();
  const journey = createFundingJourney({baseStore: f.store, store: live});
  await journey.migrate();
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const config = {origin, host: `127.0.0.1:${port}`, testers: ['alice', 'bob'].map(label => ({label, sha256hex: digest('code-' + label)}))};
  const server = createHostedServer({store: f.store, config, paymentsDisabled: true, localPreview: true, tracking: {store: live, journey, simulated: true}, arcFunding: f.arc, pay: {readiness: async () => ({ready: false})}});
  await new Promise(r => server.listen(port, '127.0.0.1', r));
  const call = async (path, body, cookie, headers = {}) => {
    const r = await fetch(origin + '/api/' + path, body === undefined ? {headers: {cookie: cookie ?? ''}} : {method: 'POST', headers: {'content-type': 'application/json', origin, cookie: cookie ?? '', ...headers}, body: JSON.stringify(body)});
    return {status: r.status, body: await r.json().catch(() => ({})), cookie: (r.headers.get('set-cookie') ?? '').split(';')[0]};
  };
  const login = async label => (await call('login', {code: 'code-' + label})).cookie;
  return {f, server, call, login, origin, close: async () => { await new Promise(r => server.close(r)); await f.close(); }};
}

test('HTTP: Arc routes work for the signed-in owner only, over same-origin JSON, and nothing else changes', async () => {
  const p = await previewServer();
  try {
    assert.equal((await p.call('arc/quote', {})).status, 401);
    const alice = await p.login('alice'), bob = await p.login('bob');
    const made = await p.call('arc/wallets/create', {label: 'Alice Arc agent', requestId: randomUUID(), scenario: 'success'}, alice);
    assert.equal(made.status, 200);
    assert.equal(made.body.arcFunding.wallets.length, 1);
    const id = made.body.selectedArcId;
    assert.equal((await p.call('arc/wallets/action', {id, action: 'advance'}, alice)).body.arcFunding.wallets[0].status, 'ready');
    const addr = await p.call('arc/address-check', {address: '0x1111111111111111111111111111111111111111'}, alice);
    assert.equal(addr.body.check.networkChecked, false);
    const q = await p.call('arc/quote', {walletId: id, amount: '25', speed: 'fast'}, alice);
    assert.equal(q.body.quote.baseReceiveUsdc, '30.625000');
    const created = await p.call('arc/transfers/create', {quoteId: q.body.quote.id, requestId: randomUUID(), confirm: true}, alice);
    const tid = created.body.selectedArcId;
    assert.equal(created.body.arcFunding.transfers[0].status, 'awaiting_payment');
    const state = await p.call('state', undefined, alice);
    assert.equal(state.body.arcFunding.simulated, true);
    // The existing Base funding surface is untouched and payments stay disabled.
    assert.equal(state.body.paymentsDisabled, true);
    assert.equal(state.body.fundingJourneyEnabled, true);
    assert.equal((await p.call('checkouts', {}, alice)).status, 403);
    // Isolation and request hygiene.
    assert.equal((await p.call('arc/transfers/action', {id: tid, action: 'cancel'}, bob)).status, 404);
    assert.equal((await p.call('arc/quote', {walletId: id, amount: '25'}, bob)).status, 404);
    assert.deepEqual((await p.call('state', undefined, bob)).body.arcFunding.wallets, []);
    assert.equal((await p.call('arc/transfers/action', {id: tid, action: 'cancel'}, alice, {origin: 'https://evil.example'})).status, 403);
    assert.equal((await p.call('arc/transfers/action', {id: tid, action: 'cancel'}, alice, {'content-type': 'text/plain'})).status, 403);
    const get = await fetch(p.origin + '/api/arc/quote', {headers: {cookie: alice}});
    assert.equal(get.status, 404);
    assert.equal((await p.call('arc/unknown', {}, alice)).status, 404);
  } finally { await p.close(); }
});

test('production guard: the hosted server refuses Arc simulation outside local preview and exposes no Arc routes without it', async () => {
  const f = await setup();
  try {
    const config = {origin: 'https://relay.example', host: 'relay.example', testers: []};
    assert.throws(() => createHostedServer({store: f.store, config, paymentsDisabled: true, arcFunding: f.arc}), /local-preview-only/);
    assert.throws(() => createHostedServer({store: f.store, config, paymentsDisabled: true, localPreview: true, arcFunding: {...f.arc, simulated: false}}), /simulated|Local preview/);
  } finally { await f.close(); }
  const p = await previewServer();
  try {
    // Without injection (production wiring) the same routes do not exist.
    const f2 = await setup();
    const port = await freePort(), origin = `http://127.0.0.1:${port}`;
    const live = createLiveStore(f2.pool, {merchantId: journeyMerchant});
    await live.migrate();
    const journey = createFundingJourney({baseStore: f2.store, store: live});
    await journey.migrate();
    const server = createHostedServer({store: f2.store, config: {origin, host: `127.0.0.1:${port}`, testers: [{label: 'alice', sha256hex: digest('code-alice')}]}, paymentsDisabled: true, localPreview: true, tracking: {store: live, journey, simulated: true}, pay: {readiness: async () => ({ready: false})}});
    await new Promise(r => server.listen(port, '127.0.0.1', r));
    try {
      const login = await fetch(origin + '/api/login', {method: 'POST', headers: {'content-type': 'application/json', origin}, body: JSON.stringify({code: 'code-alice'})});
      const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
      const r = await fetch(origin + '/api/arc/quote', {method: 'POST', headers: {'content-type': 'application/json', origin, cookie}, body: '{}'});
      assert.equal(r.status, 404);
      const st = await (await fetch(origin + '/api/state', {headers: {cookie}})).json();
      assert.equal(st.arcFunding, undefined);
    } finally { await new Promise(r => server.close(r)); await f2.close(); }
  } finally { await p.close(); }
});
