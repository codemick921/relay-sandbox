import test from 'node:test';
import {freePort} from './fixtures/free-port.mjs';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {existsSync, readFileSync} from 'node:fs';
import {resolvePkg} from './fixtures/pkg.mjs';
import {pathToFileURL} from 'node:url';
import {fixture} from './fixtures/account-store.mjs';
import {digest} from '../hosted/db.mjs';
import {createArcFunding} from '../hosted/arc-funding.mjs';
import {seedArcFixtures} from '../hosted/arc-fixtures.mjs';
import {ARC_ROUTE, ARC_ROUTES, approvalBinding, arcQuote, assertRoute, environmentOf, units} from '../shared/arc-funding.mjs';
import {pence} from '../server/validation.mjs';

const owner = 'customer:' + randomUUID();
const other = 'customer:' + randomUUID();
const EXT = '0x7e57' + '0'.repeat(35) + '1';
const EXT2 = '0x7e57' + '0'.repeat(35) + '2';
async function setup() {
  const f = await fixture();
  const arc = createArcFunding({store: f.store});
  await arc.migrate();
  return {...f, arc};
}
const wallet = async (arc, who = owner, label = 'Test wallet') => {
  const {id} = await arc.createWallet(who, {label, requestId: randomUUID(), scenario: 'success'});
  await arc.walletAction(who, id, {action: 'advance'});
  return id;
};
const dest = (arc, who = owner, address = EXT, label = 'Agent', extra = {}) =>
  arc.saveDestination(who, {requestId: randomUUID(), label, address, confirmNetwork: true, network: 'arc_testnet', ...extra});
const transfer = async (arc, walletId, destinationId, who = owner, amount = '25') => {
  const {quote} = await arc.quote(who, {walletId, destinationId, amount, speed: 'fast'});
  const {id} = await arc.createTransfer(who, {quoteId: quote.id, requestId: randomUUID(), confirm: true});
  return {id, quote};
};
const read = async (arc, who, id) => (await arc.state(who)).transfers.find(t => t.id === id);
const step = (arc, id, who = owner, action = 'advance') => arc.transferAction(who, id, {action});
const toApproval = async (arc, id, who = owner) => {
  await arc.transferAction(who, id, {action: 'submit', scenario: 'success'});
  await step(arc, id, who); await step(arc, id, who);
};
const settle = (results) => ({ok: results.filter(r => r.status === 'fulfilled').length, no: results.filter(r => r.status === 'rejected').length});
const count = async (f, table, where = '', args = []) => Number((await f.store.query(`SELECT count(*) FROM ${table} ${where}`, args)).rows[0].count);

test('concurrent creates are idempotent and bounded: wallets, destinations, transfers', async () => {
  const f = await setup();
  try {
    // Same request id, many parallel callers: one wallet.
    const req = randomUUID();
    const ids = await Promise.all(Array.from({length: 8}, () => f.arc.createWallet(owner, {label: 'Same', requestId: req})));
    assert.equal(new Set(ids.map(x => x.id)).size, 1);
    assert.equal(await count(f, 'relay_arc_wallets', 'WHERE owner=$1', [owner]), 1);
    await f.arc.walletAction(owner, ids[0].id, {action: 'advance'});
    // Distinct requests beyond the limit: exactly the limit is created, the rest are refused.
    const many = await Promise.allSettled(Array.from({length: 10}, (_, i) => f.arc.createWallet(owner, {label: 'W' + i + 'x', requestId: randomUUID()})));
    assert.equal(await count(f, 'relay_arc_wallets', 'WHERE owner=$1', [owner]), 5);
    assert.equal(settle(many).ok, 4);
    assert.ok(many.filter(r => r.status === 'rejected').every(r => r.reason.status === 409));

    // Destinations: same request id once; same address from different requests once; bounded by the limit.
    const dreq = randomUUID();
    const same = await Promise.all(Array.from({length: 8}, () => f.arc.saveDestination(owner, {requestId: dreq, label: 'Agent', address: EXT, confirmNetwork: true, network: 'arc_testnet'})));
    assert.equal(new Set(same.map(x => x.id)).size, 1);
    const dup = settle(await Promise.allSettled(Array.from({length: 6}, () => dest(f.arc, owner, EXT2, 'Dup'))));
    assert.deepEqual(dup, {ok: 1, no: 5}, 'one address is saved once even when six requests race');
    const filler = await Promise.allSettled(Array.from({length: 12}, (_, i) => dest(f.arc, owner, '0x7e57' + String(i + 10).padStart(36, '0'), 'F' + i + 'x')));
    assert.equal(await count(f, 'relay_arc_destinations', 'WHERE owner=$1 AND removed_at IS NULL', [owner]), 10, 'never more than the limit');
    assert.ok(settle(filler).ok >= 7);

    // Transfers: one quote cannot become two transfers, whatever the request ids.
    const w = (await f.arc.state(owner)).wallets.find(x => x.status === 'ready').id;
    const {quote} = await f.arc.quote(owner, {walletId: w, amount: '25', speed: 'fast'});
    const made = await Promise.all(Array.from({length: 8}, () => f.arc.createTransfer(owner, {quoteId: quote.id, requestId: randomUUID(), confirm: true})));
    assert.equal(new Set(made.map(x => x.id)).size, 1);
    assert.equal(await count(f, 'relay_arc_transfers', 'WHERE owner=$1', [owner]), 1);
    const sameReq = randomUUID();
    const q2 = await f.arc.quote(owner, {walletId: w, amount: '26', speed: 'fast'});
    const made2 = await Promise.all(Array.from({length: 8}, () => f.arc.createTransfer(owner, {quoteId: q2.quote.id, requestId: sameReq, confirm: true})));
    assert.equal(new Set(made2.map(x => x.id)).size, 1);
    assert.equal(await count(f, 'relay_arc_transfers', 'WHERE owner=$1', [owner]), 2);
  } finally { await f.close(); }
});

test('concurrent steps and decisions: one approval request, one winner, repeated identical decisions are harmless', async () => {
  const f = await setup();
  try {
    const w = await wallet(f.arc);
    const {id: did} = await dest(f.arc);
    // Racing "run the next step" at the Base receipt creates exactly one approval request.
    const a = await transfer(f.arc, w, did);
    await f.arc.transferAction(owner, a.id, {action: 'submit', scenario: 'success'});
    await step(f.arc, a.id);
    const racing = settle(await Promise.allSettled(Array.from({length: 8}, () => step(f.arc, a.id))));
    assert.equal(racing.ok, 1);
    assert.equal(await count(f, 'relay_arc_approvals', 'WHERE transfer_id=$1', [a.id]), 1);
    assert.equal((await read(f.arc, owner, a.id)).status, 'approval_pending');
    // Approve and decline racing: exactly one wins and the stored state agrees with the winner.
    const t = await read(f.arc, owner, a.id);
    const body = decision => ({id: a.id, approvalId: t.approval.id, bindingHash: t.approval.bindingHash, decision});
    const race = await Promise.allSettled([f.arc.decideApproval(owner, body('approve')), f.arc.decideApproval(owner, body('deny'))]);
    assert.equal(settle(race).ok, 1);
    const after = await read(f.arc, owner, a.id);
    assert.ok(['bridge_burn_pending', 'approval_denied'].includes(after.status));
    assert.equal(after.approval.status, after.status === 'bridge_burn_pending' ? 'approved' : 'denied');
    assert.equal((await f.store.query('SELECT status FROM relay_arc_approvals WHERE transfer_id=$1', [a.id])).rows.length, 1);
    // Six identical approvals: all succeed, one decision is recorded.
    const b = await transfer(f.arc, w, did);
    await toApproval(f.arc, b.id);
    const tb = await read(f.arc, owner, b.id);
    const same = await Promise.allSettled(Array.from({length: 6}, () => f.arc.decideApproval(owner, {id: b.id, approvalId: tb.approval.id, bindingHash: tb.approval.bindingHash, decision: 'approve'})));
    assert.equal(settle(same).ok, 6);
    assert.equal(Number((await f.store.query("SELECT count(*) FROM relay_arc_events WHERE subject_id=$1 AND status='bridge_burn_pending'", [b.id])).rows[0].count), 1);
    // Edits racing on one revision: one wins.
    const edits = settle(await Promise.allSettled(Array.from({length: 5}, (_, i) => dest(f.arc, owner, EXT, 'Edit' + i + 'x', {id: did, expectedRevision: 1}))));
    assert.deepEqual(edits, {ok: 1, no: 4});
    assert.equal((await f.arc.state(owner)).destinations.find(d => d.id === did).revision, 2);
  } finally { await f.close(); }
});

test('owner isolation holds across wallets, destinations, quotes, transfers, approvals and history', async () => {
  const f = await setup();
  try {
    const w = await wallet(f.arc);
    const {id: did} = await dest(f.arc);
    const t = await transfer(f.arc, w, did);
    await toApproval(f.arc, t.id);
    const view = await read(f.arc, owner, t.id);
    const theirs = await f.arc.state(other);
    assert.deepEqual([theirs.wallets, theirs.destinations, theirs.transfers], [[], [], []]);
    const foreign = {id: t.id, approvalId: view.approval.id, bindingHash: view.approval.bindingHash, decision: 'approve'};
    await assert.rejects(f.arc.decideApproval(other, foreign), e => e.status === 404);
    await assert.rejects(f.arc.saveDestination(other, {requestId: randomUUID(), id: did, expectedRevision: 1, label: 'Mine now', address: EXT2, confirmNetwork: true, network: 'arc_testnet'}), e => e.status === 404);
    await assert.rejects(f.arc.removeDestination(other, {id: did}), e => e.status === 404);
    await assert.rejects(f.arc.quote(other, {walletId: w, destinationId: did, amount: '25'}), e => e.status === 404);
    const ow = await wallet(f.arc, other, 'Their wallet');
    await assert.rejects(f.arc.quote(other, {walletId: ow, destinationId: did, amount: '25'}), e => e.status === 404, 'a foreign destination cannot be used with your own wallet');
    for (const action of ['advance', 'hold', 'reapprove', 'request_approval']) await assert.rejects(f.arc.transferAction(other, t.id, {action}), e => e.status === 404);
    assert.equal((await read(f.arc, owner, t.id)).status, 'approval_pending', 'nothing the other owner tried changed this transfer');
    // Same address saved by two owners is two private records.
    const mine = await dest(f.arc, other, EXT, 'Theirs');
    assert.notEqual(mine.id, did);
    // Every approval, transfer, destination and wallet row belongs to one owner.
    const bad = await f.store.query(`SELECT count(*) FROM relay_arc_approvals a JOIN relay_arc_transfers t ON t.id=a.transfer_id WHERE a.owner<>t.owner`);
    assert.equal(Number(bad.rows[0].count), 0);
    const bad2 = await f.store.query(`SELECT count(*) FROM relay_arc_transfers t JOIN relay_arc_wallets w ON w.id=t.wallet_id WHERE w.owner<>t.owner`);
    assert.equal(Number(bad2.rows[0].count), 0);
    const bad3 = await f.store.query(`SELECT count(*) FROM relay_arc_transfers t JOIN relay_arc_destinations d ON d.id=t.destination_id WHERE d.owner<>t.owner`);
    assert.equal(Number(bad3.rows[0].count), 0);
  } finally { await f.close(); }
});

test('precision: all USDC maths is exact integer maths, with no floating point and no rounding drift', () => {
  // 1. units() renders any raw amount exactly, with six decimals.
  for (const [raw, out] of [['0', '0.000000'], ['1', '0.000001'], ['999999', '0.999999'], ['1000000', '1.000000'], ['30625000', '30.625000'], ['123456789012', '123456.789012']]) assert.equal(units(raw), out);
  // 2. Every whole-pence amount in range: the parts add up to the whole, to the last unit.
  let checked = 0;
  for (let pence = 200; pence <= 100000; pence += pence < 5000 ? 1 : 37) {
    for (const speed of ['fast', 'standard']) {
      const q = arcQuote({pence, speed});
      const gross = BigInt(pence) * 12500n, fee = BigInt(Math.trunc(0)) + gross / 50n;
      assert.equal(units(gross), q.grossUsdc);
      assert.equal(units(fee), q.peerFeeUsdc);
      assert.equal(BigInt(q.baseReceiveRaw), gross - fee, 'receive = gross - fee, exactly');
      const b = q.bridge;
      assert.equal(BigInt(b.protocolFeeRaw) + BigInt(b.serviceFeeRaw) + BigInt(b.gasFeeRaw), BigInt(b.totalRaw), 'bridge fee parts sum exactly');
      assert.equal(BigInt(q.baseReceiveRaw) - BigInt(b.totalRaw), BigInt(q.estimatedArcRaw), 'estimate = receive - bridge fees, exactly');
      assert.ok(BigInt(q.estimatedArcRaw) > 0n);
      for (const v of [q.grossUsdc, q.peerFeeUsdc, q.baseReceiveUsdc, q.estimatedArcUsdc, b.totalUsdc]) assert.match(v, /^\d+\.\d{6}$/);
      assert.ok(BigInt(q.baseReceiveRaw) < BigInt(Number.MAX_SAFE_INTEGER), 'every amount is exactly representable even if a display layer converts it');
      checked++;
    }
  }
  assert.ok(checked > 1000);
  // 3. Fast fees round up to the next unit, never down: never under-quote the protocol fee.
  const q = arcQuote({pence: 201, speed: 'fast'});
  assert.ok(BigInt(q.bridge.protocolFeeRaw) * 10000n >= BigInt(q.baseReceiveRaw) * 5n);
  // 4. Pound amounts are parsed as exact pence; ambiguous or lossy text is refused.
  assert.throws(() => arcQuote({pence: 12.5}), RangeError);
  assert.throws(() => arcQuote({pence: '2500'}), RangeError);
  assert.throws(() => arcQuote({pence: NaN}), RangeError);
  assert.throws(() => arcQuote({pence: 100001}), RangeError);
  for (const bad of ['12.345', '1e2', '-1', '0x10', '12,5', '', ' 25', '25 ', '٢٥', '99999', '0.01', '1.99', '1000.01']) assert.throws(() => pence(bad), bad);
  for (const [text, p] of [['2', 200], ['12.5', 1250], ['25', 2500], ['1000', 100000], ['2.01', 201]]) assert.equal(pence(text), p);
  // 5. No floating-point conversion of money in any Arc server module or the shared maths.
  for (const file of ['../shared/arc-funding.mjs', '../hosted/arc-funding.mjs', '../hosted/arc-approvals.mjs', '../hosted/arc-destinations.mjs', '../src/arc-customer-signing.mjs']) {
    const src = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /parseFloat|toFixed\(|Math\.(round|ceil)\([^)]*(usdc|raw|amount)/i, file);
  }
});

test('no mainnet and testnet crossover: one network type per route, mainnet disabled, and the SDK agrees', async t => {
  assert.equal(environmentOf('Base Sepolia'), 'testnet');
  assert.equal(environmentOf('Arc_Testnet'), 'testnet');
  assert.equal(environmentOf('Base'), 'mainnet');
  assert.equal(environmentOf('Arc'), 'mainnet');
  assert.equal(assertRoute('Base Sepolia', 'Arc Testnet').environment, 'testnet');
  for (const [a, b] of [['Base', 'Arc Testnet'], ['Base Sepolia', 'Arc'], ['Base_Sepolia', 'Arc'], ['Base', 'Arc_Testnet']]) assert.throws(() => assertRoute(a, b), /cannot be mixed/, `${a} -> ${b}`);
  for (const [a, b] of [['Base', 'Arc'], ['Base', 'Arc']]) assert.throws(() => assertRoute(a, b), /not enabled in this build/);
  assert.throws(() => assertRoute('Ethereum', 'Arc Testnet'), /Unknown chain/);
  assert.equal(ARC_ROUTES.mainnet.enabled, false);
  assert.equal(ARC_ROUTE.source.environment, 'testnet');
  assert.equal(ARC_ROUTE.destination.environment, 'testnet');
  // A binding cannot even be built for mainnet or a mixed route.
  const quote = {id: randomUUID(), speed: 'fast', baseReceiveRaw: '30625000', bridge: {totalRaw: '85000'}, estimatedArcRaw: '30540000'};
  const src = (chain) => ({walletId: randomUUID(), address: '0x' + 'a'.repeat(40), chain});
  const dst = (chain) => ({mode: 'external_test', id: randomUUID(), revision: 1, label: 'x', address: EXT, chain});
  assert.equal(approvalBinding({source: src('Base Sepolia'), destination: dst('Arc Testnet'), quote}).environment, 'testnet');
  assert.throws(() => approvalBinding({source: src('Base'), destination: dst('Arc'), quote}), /not enabled/);
  assert.throws(() => approvalBinding({source: src('Base'), destination: dst('Arc Testnet'), quote}), /cannot be mixed/);
  // Destinations are Arc Testnet only, however the network is spelled.
  const f = await setup();
  try {
    for (const network of ['arc_mainnet', 'arc', 'Arc', 'mainnet', 5042, '', undefined]) {
      await assert.rejects(f.arc.saveDestination(owner, {requestId: randomUUID(), label: 'Agent', address: EXT, confirmNetwork: true, network}), e => e.status === 400, String(network));
    }
    const state = await f.arc.state(owner);
    assert.equal(state.route.destination.chainId, 5042002);
    assert.equal(state.route.source.chainId, 84532);
    assert.equal(state.route.live.available, false);
    // The USDC contract on Arc (same address on both networks) is never accepted as a recipient.
    await assert.rejects(dest(f.arc, owner, '0x3600000000000000000000000000000000000000'), e => e.status === 400);
  } finally { await f.close(); }
  // Browser signing refuses mainnet and mixed bindings even if they carry a valid-looking fingerprint.
  const signing = await import('../src/arc-customer-signing.mjs');
  const good = approvalBinding({source: src('Base Sepolia'), destination: dst('Arc Testnet'), quote});
  assert.equal(signing.bridgeParams(good, {a: 1}).to.chain, 'Arc_Testnet');
  assert.equal(signing.bridgeParams(good, {a: 1}).from.chain, 'Base_Sepolia');
  for (const mutate of [b => { b.destination.chain = 'Arc'; }, b => { b.source.chain = 'Base'; }, b => { b.environment = 'mainnet'; }, b => { b.source.chainId = 8453; }, b => { b.destination.chainId = 5042; }]) {
    const bad = structuredClone(good); mutate(bad);
    assert.throws(() => signing.bridgeParams(bad, {a: 1}), /./);
  }
  assert.throws(() => signing.arcSigningPrivyConfig({baseSepolia: {id: 8453, name: 'Base'}}));
  // Verify the chosen route against the installed Bridge Kit (the Arc project's copy), when it is present.
  // Found the way Node finds it from this file. If it is not installed at all the dependency is broken, which must fail, not skip.
  const {BridgeKit} = await import(pathToFileURL(resolvePkg('@circle-fin/bridge-kit')).href);
  const chains = new BridgeKit().getSupportedChains();
  for (const env of ['testnet', 'mainnet']) {
    const r = ARC_ROUTES[env];
    for (const side of [r.source, r.destination]) {
      const c = chains.find(x => x.chain === side.kitId);
      assert.ok(c, `${side.kitId} is a supported chain`);
      assert.equal(c.chainId, side.chainId, side.kitId);
      assert.equal(c.isTestnet, env === 'testnet', side.kitId);
      assert.equal(c.cctp.domain, side.domain, side.kitId);
    }
    assert.equal(chains.find(x => x.chain === r.destination.kitId).cctp.forwarderSupported.destination, true, 'the forwarder is a destination feature');
  }
});

test('simulation records never contain a fabricated transaction hash', async () => {
  const f = await setup();
  try {
    await seedArcFixtures(f.arc, owner, {tag: 'Hash'});
    const w = await wallet(f.arc);
    const {id: did} = await dest(f.arc, owner, '0x7e57' + '0'.repeat(35) + '9', 'Another');
    const {id} = await transfer(f.arc, w, did);
    await toApproval(f.arc, id);
    const view = await read(f.arc, owner, id);
    await f.arc.decideApproval(owner, {id, approvalId: view.approval.id, bindingHash: view.approval.bindingHash, decision: 'approve'});
    for (let i = 0; i < 3; i++) await step(f.arc, id);
    assert.equal((await read(f.arc, owner, id)).status, 'settled');
    const hashLike = /0x[0-9a-fA-F]{64}\b/;
    const state = JSON.stringify(await f.arc.state(owner));
    assert.doesNotMatch(state, hashLike, 'no 32-byte hash anywhere in the customer-facing state');
    assert.doesNotMatch(state, /"(tx|transaction)_?[hH]ash"|"txid"|"signature":\s*"0x/);
    // And none in any stored text column (events, quotes, approvals, burn records, destinations, wallets).
    for (const table of ['relay_arc_wallets', 'relay_arc_quotes', 'relay_arc_transfers', 'relay_arc_events', 'relay_arc_destinations', 'relay_arc_approvals']) {
      const rows = (await f.store.query(`SELECT row_to_json(t)::text AS j FROM ${table} t`)).rows;
      assert.ok(rows.length > 0, table);
      for (const r of rows) assert.doesNotMatch(r.j, hashLike, table);
    }
    // Approval fingerprints are SHA-256 of the binding, shown without a 0x prefix so they cannot pass for a transaction hash.
    const t = await read(f.arc, owner, id);
    assert.match(t.approval.bindingHash, /^[0-9a-f]{64}$/);
    // Simulated records are labelled as such.
    assert.ok(t.simulated);
  } finally { await f.close(); }
});

async function previewServer() {
  const { createLiveStore } = await import('../hosted/live-store.mjs');
  const { createFundingJourney, journeyMerchant } = await import('../hosted/funding-journey.mjs');
  const { createHostedServer } = await import('../hosted/server.mjs');
  const f = await setup();
  const live = createLiveStore(f.pool, {merchantId: journeyMerchant});
  await live.migrate();
  const journey = createFundingJourney({baseStore: f.store, store: live});
  await journey.migrate();
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const config = {origin, host: `127.0.0.1:${port}`, testers: [{label: 'alice', sha256hex: digest('code-alice')}]};
  const server = createHostedServer({store: f.store, config, paymentsDisabled: true, localPreview: true, tracking: {store: live, journey, simulated: true}, arcFunding: f.arc, pay: {readiness: async () => ({ready: false})}});
  await new Promise(r => server.listen(port, '127.0.0.1', r));
  const call = async (path, body, cookie) => {
    const r = await fetch(origin + '/api/' + path, body === undefined ? {headers: {cookie: cookie ?? ''}} : {method: 'POST', headers: {'content-type': 'application/json', origin, cookie: cookie ?? ''}, body: JSON.stringify(body)});
    return {status: r.status, text: await r.text(), cookie: (r.headers.get('set-cookie') ?? '').split(';')[0]};
  };
  return {f, call, close: async () => { await new Promise(r => server.close(r)); await f.close(); }};
}

test('simulated Arc funds never enter Base payment receipts, history, statements, balances or notifications', async () => {
  const p = await previewServer();
  try {
    const signup = await p.call('account/signup', {email: 'integrity@example.invalid', name: 'Integrity', password: 'synthetic harbour lantern 4821', acceptSandbox: true});
    assert.equal(signup.status, 200);
    const cookie = signup.cookie;
    const json = r => JSON.parse(r.text);
    const j = async (path, body) => { const r = await p.call(path, body, cookie); assert.equal(r.status, 200, path + ' ' + r.text.slice(0, 120)); return json(r); };
    // Money tables are everything that is not an Arc simulation table, session, rate-limit or email-queue table.
    const tables = (await p.f.store.query("SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema() AND table_type='BASE TABLE'")).rows.map(r => r.table_name)
      .filter(n => !n.startsWith('relay_arc_') && /order|receipt|payment|settle|draft|balance|notice|notif|history|quote|checkout|record|intent|attempt|wallet|agent|funding|delivery|observ/.test(n));
    assert.ok(tables.length >= 5, 'money-related tables were found: ' + tables.join(','));
    const snapshot = async () => Object.fromEntries(await Promise.all(tables.map(async n => [n, Number((await p.f.store.query(`SELECT count(*) FROM ${n}`)).rows[0].count)])));
    // Saving a Base wallet is a real Base-side record; take the snapshot after it so only Arc activity is measured.
    await j('agents', {name: 'Base agent', address: '0x' + '2'.repeat(40), own: true, network: 'base', currentPassword: 'synthetic harbour lantern 4821'});
    const before = await snapshot();
    const baseState = await j('state');
    const ordersBefore = JSON.stringify(baseState.orders);
    // Run a complete simulated Arc journey.
    const made = await j('arc/wallets/create', {label: 'Arc source', requestId: randomUUID(), scenario: 'success'});
    const wid = made.selectedArcId;
    await j('arc/wallets/action', {id: wid, action: 'advance'});
    const d = await j('arc/destinations/save', {requestId: randomUUID(), label: 'Agent', address: EXT, confirmNetwork: true, network: 'arc_testnet'});
    const q = await j('arc/quote', {walletId: wid, destinationId: d.selectedArcId, amount: '25', speed: 'fast'});
    const t = await j('arc/transfers/create', {quoteId: q.quote.id, requestId: randomUUID(), confirm: true});
    const tid = t.selectedArcId;
    await j('arc/transfers/action', {id: tid, action: 'submit', scenario: 'success'});
    await j('arc/transfers/action', {id: tid, action: 'advance'});
    const asked = await j('arc/transfers/action', {id: tid, action: 'advance'});
    const tv = asked.arcFunding.transfers.find(x => x.id === tid);
    await j('arc/approvals/decide', {id: tid, approvalId: tv.approval.id, bindingHash: tv.approval.bindingHash, decision: 'approve'});
    for (let i = 0; i < 3; i++) await j('arc/transfers/action', {id: tid, action: 'advance'});
    const done = await j('state');
    assert.equal(done.arcFunding.transfers.find(x => x.id === tid).status, 'settled');
    // 1. No Base-side table changed.
    assert.deepEqual(await snapshot(), before, 'no Base order, receipt, draft, balance, notification or payment row was created');
    // 2. The Base orders in the customer state are untouched and the Base journey is unaffected.
    assert.equal(JSON.stringify(done.orders), ordersBefore);
    assert.equal(done.paymentsDisabled, true);
    assert.equal(done.fundingJourneyEnabled, true);
    // 3. No Base-facing endpoint mentions the Arc transfer, its amounts, the burn record or the simulated Base receipt.
    const needles = [tid, wid, q.quote.id, 'sim-burn', 'Simulated Base receipt', 'relay_arc', EXT];
    for (const path of ['funding-history', 'funding-overview', 'payment-records', 'notifications']) {
      const r = await p.call(path, undefined, cookie);
      for (const n of needles) assert.ok(!r.text.includes(n), `${path} must not contain ${n}`);
    }
    const sync = await p.call('notifications/sync', {}, cookie);
    for (const n of needles) assert.ok(!sync.text.includes(n), `notifications/sync must not contain ${n}`);
    const walletBalances = JSON.stringify(done.walletBalances ?? {});
    for (const n of needles) assert.ok(!walletBalances.includes(n));
    // 4. The reverse is also true: the Arc state is labelled simulated and carries no Base order or receipt.
    const arcOnly = JSON.stringify(done.arcFunding);
    assert.ok(done.arcFunding.simulated && done.arcFunding.transfers.every(x => x.simulated));
    assert.doesNotMatch(arcOnly, /"receipt"|"orderId"|"providerOrderId"|"checkoutUrl"/);
  } finally { await p.close(); }
});

test('docs name the verified route sources and do not call Arc testnet-only', () => {
  const doc = readFileSync(new URL('../docs/arc-agentic-wallets.md', import.meta.url), 'utf8');
  for (const needle of ['docs.arc.io/app-kit/quickstarts/bridge-tokens-across-blockchains', 'docs.arc.io/app-kit/references/supported-blockchains', 'developers.circle.com/wallets/supported-blockchains', 'Bridge Kit 1.17.0', 'NetworkMismatchError', 'ARC-TESTNET']) assert.ok(doc.includes(needle), needle);
  assert.doesNotMatch(doc, /Arc is (a )?testnet.only|Arc (has|is) no mainnet|Arc mainnet (does not|doesn.t) exist/i);
});
