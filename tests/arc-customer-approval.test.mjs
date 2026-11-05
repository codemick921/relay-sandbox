import test from 'node:test';
import {freePort} from './fixtures/free-port.mjs';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {fixture} from './fixtures/account-store.mjs';
import {createSimulatedProviders} from '../hosted/arc-providers.mjs';
import {createArcFunding} from '../hosted/arc-funding.mjs';
import {ARC_CUSTODY, ARC_USDC_CONTRACT, NETWORK_CONFIRMATION, approvalBinding, canonicalBinding} from '../shared/arc-funding.mjs';
import {hashBinding} from '../hosted/arc-approvals.mjs';

const owner = 'customer:' + randomUUID();
const other = 'customer:' + randomUUID();
const EXTERNAL = '0x7e57000000000000000000000000000000000abc';
const EXTERNAL_2 = '0x7e57000000000000000000000000000000000def';

async function setup() {
  const f = await fixture();
  const arc = createArcFunding({store: f.store});
  await arc.migrate();
  return {...f, arc};
}
const wallet = async (arc, who = owner) => {
  const {id} = await arc.createWallet(who, {label: 'My Base wallet', requestId: randomUUID()});
  await arc.walletAction(who, id, {action: 'advance'});
  return id;
};
const dest = (arc, who = owner, address = EXTERNAL, label = 'Agent test wallet', extra = {}) =>
  arc.saveDestination(who, {requestId: randomUUID(), label, address, confirmNetwork: true, network: 'arc_testnet', ...extra});
const transfer = async (arc, walletId, destinationId = null, who = owner) => {
  const {quote} = await arc.quote(who, {walletId, destinationId, amount: '25', speed: 'fast'});
  const {id} = await arc.createTransfer(who, {quoteId: quote.id, requestId: randomUUID(), confirm: true});
  return {id, quote};
};
const read = async (arc, who, id) => (await arc.state(who)).transfers.find(t => t.id === id);
const step = (arc, id, who = owner, action = 'advance') => arc.transferAction(who, id, {action});
const toApproval = async (arc, id, who = owner) => {
  await arc.transferAction(who, id, {action: 'submit', scenario: 'success'});
  await step(arc, id, who); await step(arc, id, who);
};
const decide = async (arc, id, decision, who = owner, over = {}) => {
  const t = await read(arc, who, id);
  return arc.decideApproval(who, {id, approvalId: t.approval.id, bindingHash: t.approval.bindingHash, decision, ...over});
};

test('custody model: the customer approves; Eupova holds no keys and the server has no bridge or wallet-creation adapter', () => {
  assert.equal(ARC_CUSTODY.model, 'customer-controlled');
  assert.equal(ARC_CUSTODY.eupovaCanSign, false);
  assert.equal(ARC_CUSTODY.eupovaHoldsKeys, false);
  assert.match(ARC_CUSTODY.statements[0], /customer approves each transfer in their own wallet/i);
  const providers = readFileSync(new URL('../hosted/arc-providers.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(providers.replace(/\/\/.*$/gm, ''), /createWallets|developer-controlled|kit\.bridge|\.bridge\(|entity|apiKey/i, 'no custodial or server-side bridging code remains');
});

test('destinations: format-only validation, explicit network confirmation, owner-scoped and persistent', async () => {
  const f = await setup();
  try {
    const bad = (input, pattern) => assert.rejects(f.arc.saveDestination(owner, {requestId: randomUUID(), label: 'Agent', address: EXTERNAL, confirmNetwork: true, network: 'arc_testnet', ...input}), pattern);
    await bad({confirmNetwork: false}, /Confirm the network/);
    await bad({confirmNetwork: undefined}, /Confirm the network/);
    await bad({network: 'arc_mainnet'}, /Confirm the network/);
    await bad({address: 'nope'}, /./);
    await bad({address: ARC_USDC_CONTRACT}, /token contract/);
    await bad({address: '0x' + '0'.repeat(40)}, /./);
    await bad({label: 'x'}, /2 to 40/);
    await bad({requestId: 'nope'}, /request id/);
    const saved = await dest(f.arc);
    const state = await f.arc.state(owner);
    const d = state.destinations[0];
    assert.equal(d.id, saved.id);
    assert.equal(d.testLabel, true);
    assert.equal(d.mode, 'external_test');
    assert.equal(d.formatChecked, true);
    assert.equal(d.networkChecked, false, 'the network is confirmed by the customer, never checked by Eupova');
    assert.equal(d.ownershipChecked, false);
    assert.ok(d.networkConfirmedAt);
    assert.equal(state.networkConfirmation, NETWORK_CONFIRMATION);
    assert.match(d.events[0].note, /TEST destination/);
    assert.match(d.events[0].note, /Format checked only/);
    // Idempotent request id; the same address twice is refused.
    const req = randomUUID();
    const a = await f.arc.saveDestination(owner, {requestId: req, label: 'Second', address: EXTERNAL_2, confirmNetwork: true, network: 'arc_testnet'});
    const b = await f.arc.saveDestination(owner, {requestId: req, label: 'Second', address: EXTERNAL_2, confirmNetwork: true, network: 'arc_testnet'});
    assert.equal(a.id, b.id);
    await assert.rejects(f.arc.saveDestination(owner, {requestId: req, label: 'Other', address: EXTERNAL_2, confirmNetwork: true, network: 'arc_testnet'}), e => e.status === 409);
    await assert.rejects(dest(f.arc, owner, EXTERNAL_2, 'Duplicate'), /already saved/);
    // Owner scope: another customer sees none, cannot edit or remove, and may save the same address.
    assert.deepEqual((await f.arc.state(other)).destinations, []);
    await assert.rejects(dest(f.arc, other, EXTERNAL, 'Hijack', {id: saved.id, expectedRevision: 1}), e => e.status === 404);
    await assert.rejects(f.arc.removeDestination(other, {id: saved.id}), e => e.status === 404);
    await dest(f.arc, other, EXTERNAL, 'Theirs');
    assert.equal((await f.arc.state(other)).destinations.length, 1);
    // A fresh module over the same database keeps it (persistence across restarts).
    const again = createArcFunding({store: f.store});
    await again.migrate();
    assert.equal((await again.state(owner)).destinations.length, 2);
    // Limit.
    for (let i = 0; i < 8; i++) await dest(f.arc, owner, '0x7e57' + String(i).padStart(36, '0'), 'Filler ' + i);
    await assert.rejects(dest(f.arc, owner, '0x7e57' + '9'.repeat(36), 'Over'), /up to 10/);
  } finally { await f.close(); }
});

test('SOURCE signs, DESTINATION only receives: a different Arc recipient is approved against the source wallet', async () => {
  const f = await setup();
  try {
    const w = await wallet(f.arc);
    const {id: did} = await dest(f.arc);
    const same = await transfer(f.arc, w);
    const ext = await transfer(f.arc, w, did);
    const s = await f.arc.state(owner);
    const source = s.wallets[0];
    assert.equal(ext.quote.wallet.address, source.address);
    assert.equal(ext.quote.destination.address, EXTERNAL);
    assert.notEqual(ext.quote.destination.address, source.address, 'destination differs from the source signer');
    assert.equal(same.quote.destination.mode, 'same_as_source');
    assert.equal(same.quote.destination.address, source.address);
    await toApproval(f.arc, ext.id);
    const t = await read(f.arc, owner, ext.id);
    assert.equal(t.status, 'approval_pending');
    const b = t.approval.binding;
    assert.deepEqual([b.source.address, b.source.chain, b.source.signer], [source.address, 'Base Sepolia', 'customer-wallet']);
    assert.deepEqual([b.destination.address, b.destination.chain, b.destination.chainId, b.destination.mode], [EXTERNAL, 'Arc Testnet', 5042002, 'external_test']);
    assert.equal(b.amountRaw, ext.quote.baseReceiveRaw);
    assert.equal(b.quote.id, ext.quote.id);
    assert.equal(b.token, 'USDC');
    assert.match(t.destination.displayLabel, /^TEST destination: /);
    // The stored binding re-hashes to the stored fingerprint even after a jsonb round trip (browser does this).
    assert.equal(hashBinding(b), t.approval.bindingHash);
    // Changing any bound field produces a different fingerprint.
    for (const mutate of [x => { x.source.address = '0x' + '1'.repeat(40); }, x => { x.destination.address = EXTERNAL_2; }, x => { x.amountRaw = '1'; }, x => { x.quote.id = randomUUID(); }, x => { x.source.chain = 'Base'; }, x => { x.destination.chain = 'Arc'; }]) {
      const copy = structuredClone(b); mutate(copy);
      assert.notEqual(hashBinding(copy), t.approval.bindingHash);
    }
    const reversed = o => (Array.isArray(o) ? o.map(reversed) : o && typeof o === 'object' ? Object.fromEntries(Object.keys(o).reverse().map(k => [k, reversed(o[k])])) : o);
    assert.equal(canonicalBinding(reversed(b)), canonicalBinding(b), 'key order does not matter');
    assert.deepEqual(approvalBinding({source: {walletId: b.source.walletId, address: b.source.address}, destination: ext.quote.destination, quote: ext.quote}), b);
  } finally { await f.close(); }
});

test('approval: nothing burns until approved; decline is kept; ask again; stale hashes and strangers are refused', async () => {
  const f = await setup();
  try {
    const w = await wallet(f.arc);
    const {id} = await transfer(f.arc, w);
    await toApproval(f.arc, id);
    let t = await read(f.arc, owner, id);
    assert.equal(t.status, 'approval_pending');
    assert.equal(t.fundsLocation, 'Base');
    assert.equal(t.canApprove, true);
    assert.equal(t.canDecline, true);
    assert.equal(t.canAdvance, false);
    assert.equal(t.approval.status, 'pending');
    assert.match(t.hint, /Nothing has been burned/);
    // Refusals.
    await assert.rejects(decide(f.arc, id, 'approve', owner, {bindingHash: 'a'.repeat(64)}), /out of date/);
    await assert.rejects(decide(f.arc, id, 'approve', owner, {bindingHash: 'nope'}), /details you reviewed/);
    await assert.rejects(decide(f.arc, id, 'maybe'), /Approve or Decline/);
    await assert.rejects(f.arc.decideApproval(other, {id, approvalId: t.approval.id, bindingHash: t.approval.bindingHash, decision: 'approve'}), e => e.status === 404);
    await assert.rejects(f.arc.decideApproval(owner, {id, approvalId: randomUUID(), bindingHash: t.approval.bindingHash, decision: 'approve'}), e => e.status === 404);
    assert.equal((await read(f.arc, owner, id)).status, 'approval_pending', 'refusals change nothing');
    // Decline: kept, nothing burned, can ask again or keep on Base.
    await decide(f.arc, id, 'deny');
    t = await read(f.arc, owner, id);
    assert.equal(t.status, 'approval_denied');
    assert.equal(t.approval.status, 'denied');
    assert.ok(t.approval.decidedAt);
    assert.equal(t.fundsLocation, 'Base');
    assert.equal(t.canApprove, false);
    assert.equal(t.canRequestApproval, true);
    assert.equal(t.canHold, true);
    assert.equal(t.terminal, false);
    await decide(f.arc, id, 'deny', owner, {approvalId: t.approval.id, bindingHash: t.approval.bindingHash}); // repeat of the same decision is a no-op
    await assert.rejects(decide(f.arc, id, 'approve', owner, {approvalId: t.approval.id, bindingHash: t.approval.bindingHash}), e => e.status === 409);
    await assert.rejects(step(f.arc, id), e => e.status === 409);
    // Ask again: a new pending approval, the declined one stays in the history.
    await step(f.arc, id, owner, 'request_approval');
    t = await read(f.arc, owner, id);
    assert.equal(t.status, 'approval_pending');
    assert.deepEqual(t.approvals.map(a => a.status), ['denied', 'pending']);
    await decide(f.arc, id, 'approve');
    t = await read(f.arc, owner, id);
    assert.equal(t.status, 'bridge_burn_pending');
    assert.deepEqual(t.approvals.map(a => a.status), ['denied', 'approved']);
    await decide(f.arc, id, 'approve', owner, {approvalId: t.approval.id, bindingHash: t.approval.bindingHash}); // repeat is a no-op
    assert.equal((await read(f.arc, owner, id)).status, 'bridge_burn_pending');
    for (let i = 0; i < 3; i++) await step(f.arc, id);
    t = await read(f.arc, owner, id);
    assert.equal(t.status, 'settled');
    assert.ok(t.approval.executedAt, 'the approval is marked used once the burn is confirmed');
    // Keep on Base while pending withdraws the request.
    const two = await transfer(f.arc, w);
    await toApproval(f.arc, two.id);
    await step(f.arc, two.id, owner, 'hold');
    t = await read(f.arc, owner, two.id);
    assert.equal(t.status, 'held_on_base');
    assert.equal(t.approval.status, 'invalidated');
    await assert.rejects(decide(f.arc, two.id, 'approve', owner, {approvalId: t.approval.id, bindingHash: t.approval.bindingHash}), e => e.status === 409);
    // Not approvable before USDC is on Base.
    const early = await transfer(f.arc, w);
    assert.equal((await read(f.arc, owner, early.id)).approval, null);
    await assert.rejects(f.arc.decideApproval(owner, {id: early.id, approvalId: randomUUID(), bindingHash: 'a'.repeat(64), decision: 'approve'}), e => e.status === 404);
  } finally { await f.close(); }
});

test('edits invalidate approvals: pending, approved-but-not-burned, and stale quotes; a burned transfer is unaffected', async () => {
  const f = await setup();
  try {
    const w = await wallet(f.arc);
    const {id: did} = await dest(f.arc);
    // 1. Edit while the approval is pending.
    const a = await transfer(f.arc, w, did);
    await toApproval(f.arc, a.id);
    const before = await read(f.arc, owner, a.id);
    const stale = {approvalId: before.approval.id, bindingHash: before.approval.bindingHash};
    await assert.rejects(dest(f.arc, owner, EXTERNAL_2, 'Edited', {id: did, expectedRevision: 5}), /changed since you opened it/, 'edits need the revision the customer saw');
    await assert.rejects(dest(f.arc, owner, EXTERNAL_2, 'Edited', {id: did, expectedRevision: 1, confirmNetwork: false}), /Confirm the network/, 'edits need the network confirmation again');
    const edited = await dest(f.arc, owner, EXTERNAL_2, 'Edited', {id: did, expectedRevision: 1});
    assert.equal(edited.invalidated, 1);
    let t = await read(f.arc, owner, a.id);
    assert.equal(t.status, 'approval_invalidated');
    assert.equal(t.approval.status, 'invalidated');
    assert.equal(t.fundsLocation, 'Base');
    assert.equal(t.destinationChanged, true);
    assert.equal(t.canApprove, false);
    assert.match(t.approval.reason, /edited the destination/);
    await assert.rejects(f.arc.decideApproval(owner, {id: a.id, decision: 'approve', ...stale}), e => e.status === 409, 'the old approval can never be used');
    await assert.rejects(step(f.arc, a.id), e => e.status === 409);
    // Unchanged re-save is not an edit.
    assert.equal((await dest(f.arc, owner, EXTERNAL_2, 'Edited', {id: did, expectedRevision: 2})).changed, false);
    // Renew: snapshot updated, new fingerprint bound to the new destination, then approve and settle there.
    await step(f.arc, a.id, owner, 'reapprove');
    t = await read(f.arc, owner, a.id);
    assert.equal(t.status, 'approval_pending');
    assert.equal(t.destinationChanged, false);
    assert.equal(t.approval.binding.destination.address, EXTERNAL_2);
    assert.equal(t.approval.binding.destination.revision, 2);
    assert.notEqual(t.approval.bindingHash, before.approval.bindingHash);
    assert.deepEqual(t.approvals.map(x => x.status), ['invalidated', 'pending']);
    await decide(f.arc, a.id, 'approve');
    for (let i = 0; i < 3; i++) await step(f.arc, a.id);
    t = await read(f.arc, owner, a.id);
    assert.equal(t.status, 'settled');
    assert.equal(t.destination.address, EXTERNAL_2);

    // 2. Approved but not yet burned, then edited: the burn is blocked.
    const b = await transfer(f.arc, w, did);
    await toApproval(f.arc, b.id);
    await decide(f.arc, b.id, 'approve');
    assert.equal((await read(f.arc, owner, b.id)).status, 'bridge_burn_pending');
    await dest(f.arc, owner, EXTERNAL, 'Back again', {id: did, expectedRevision: 2});
    t = await read(f.arc, owner, b.id);
    assert.equal(t.status, 'approval_invalidated');
    assert.equal(t.approval.status, 'invalidated');
    await assert.rejects(step(f.arc, b.id), e => e.status === 409, 'no burn without a valid approval');

    // 3. A transfer that has already burned keeps its destination; the edit does not touch it.
    const c = await transfer(f.arc, w, did);
    await toApproval(f.arc, c.id);
    await decide(f.arc, c.id, 'approve');
    await step(f.arc, c.id); // burn confirmed: attestation pending
    await dest(f.arc, owner, EXTERNAL_2, 'Again', {id: did, expectedRevision: 3});
    t = await read(f.arc, owner, c.id);
    assert.equal(t.status, 'bridge_attestation_pending');
    assert.equal(t.destination.address, EXTERNAL, 'the burned transfer keeps the recipient it was approved for');
    assert.equal(t.destinationChanged, false);
    for (let i = 0; i < 2; i++) await step(f.arc, c.id);
    assert.equal((await read(f.arc, owner, c.id)).status, 'settled');

    // 4. Quoted but not yet at approval, then edited: the approval request is refused and must be renewed.
    const d = await transfer(f.arc, w, did);
    await f.arc.transferAction(owner, d.id, {action: 'submit', scenario: 'success'});
    await step(f.arc, d.id);
    await dest(f.arc, owner, EXTERNAL, 'Third', {id: did, expectedRevision: 4});
    assert.equal((await read(f.arc, owner, d.id)).destinationChanged, true);
    await step(f.arc, d.id);
    t = await read(f.arc, owner, d.id);
    assert.equal(t.status, 'approval_invalidated');
    assert.equal(t.approval, null, 'no approval was ever created for the stale details');
    await step(f.arc, d.id, owner, 'reapprove');
    assert.equal((await read(f.arc, owner, d.id)).status, 'approval_pending');
    // A new quote cannot use a destination that changed after the quote was made.
    const q = await f.arc.quote(owner, {walletId: w, destinationId: did, amount: '30'});
    await dest(f.arc, owner, EXTERNAL_2, 'Fourth', {id: did, expectedRevision: 5});
    await assert.rejects(f.arc.createTransfer(owner, {quoteId: q.quote.id, requestId: randomUUID(), confirm: true}), /destination changed/);
  } finally { await f.close(); }
});

test('the approval is re-checked against the stored rows: tampering, removal and in-use protection', async () => {
  const f = await setup();
  try {
    const w = await wallet(f.arc);
    const {id: did} = await dest(f.arc);
    const a = await transfer(f.arc, w, did);
    await toApproval(f.arc, a.id);
    await assert.rejects(f.arc.removeDestination(owner, {id: did}), /still in progress/);
    // Change the stored destination behind the application's back (no revision, no invalidation).
    await f.store.query('UPDATE relay_arc_destinations SET address=$2 WHERE id=$1', [did, EXTERNAL_2]);
    await assert.rejects(decide(f.arc, a.id, 'approve'), /changed|cancelled/);
    let t = await read(f.arc, owner, a.id);
    assert.equal(t.status, 'approval_invalidated', 'the invalidation is saved even though the request is refused');
    assert.equal(t.approval.status, 'invalidated');
    await f.store.query('UPDATE relay_arc_destinations SET address=$2 WHERE id=$1', [did, EXTERNAL]);
    // Same tampering after approval, before the burn.
    await step(f.arc, a.id, owner, 'reapprove');
    await decide(f.arc, a.id, 'approve');
    await f.store.query("UPDATE relay_arc_destinations SET label='Sneaky' WHERE id=$1", [did]);
    await step(f.arc, a.id);
    t = await read(f.arc, owner, a.id);
    assert.equal(t.status, 'approval_invalidated', 'the burn step re-checks the binding');
    await f.store.query("UPDATE relay_arc_destinations SET label='Agent test wallet' WHERE id=$1", [did]);
    // Removal: allowed once nothing is in progress; a removed destination cannot be quoted or approved.
    await step(f.arc, a.id, owner, 'hold');
    await f.arc.removeDestination(owner, {id: did});
    assert.deepEqual((await f.arc.state(owner)).destinations, []);
    await assert.rejects(f.arc.quote(owner, {walletId: w, destinationId: did, amount: '25'}), e => e.status === 404);
    await assert.rejects(f.arc.removeDestination(owner, {id: did}), e => e.status === 404);
    // The held transfer keeps its record.
    assert.equal((await read(f.arc, owner, a.id)).status, 'held_on_base');
  } finally { await f.close(); }
});

test('browser signing integration is gated, injected, and signs only what the customer approved', async () => {
  const signing = await import('../src/arc-customer-signing.mjs');
  const {SigningGatedError, customerSigningGate, createCustomerBridgeSigner, bridgeParams, arcSigningPrivyConfig, verifyApproval, BASE_SEPOLIA_CHAIN_ID} = signing;
  // Closed by default; a half-open gate is still closed.
  const fakeKit = () => { const calls = []; return {calls, bridge: async p => { calls.push(['bridge', p]); return {state: 'success'}; }, estimate: async p => { calls.push(['estimate', p]); return {amount: p.amount, fees: [{type: 'provider', token: 'USDC', amount: '0.000001'}]}; }, retry: async (r, c) => { calls.push(['retry', r, c]); return {state: 'success'}; }}; };
  const fakeWallet = address => { const calls = []; return {calls, address, walletClientType: 'privy', switchChain: async id => { calls.push(['switchChain', id]); }, getEthereumProvider: async () => { calls.push(['provider']); return {id: 'eip1193'}; }}; };
  const adapterFactory = async ({provider}) => ({adapterFor: provider});
  assert.throws(() => createCustomerBridgeSigner({wallet: fakeWallet('0x1'), createAdapterFromProvider: adapterFactory, kit: fakeKit()}), SigningGatedError);
  const reviewed = {dependencies: true, permissions: true, custody: true, privyConfig: true};
  assert.throws(() => createCustomerBridgeSigner({gate: {approved: true, reviewed: {...reviewed, custody: false}}, wallet: fakeWallet('0x1'), createAdapterFromProvider: adapterFactory, kit: fakeKit()}), SigningGatedError);
  assert.equal(customerSigningGate.approved, false);
  const gate = {approved: true, reviewed};

  const f = await setup();
  try {
    const w = await wallet(f.arc);
    const {id: did} = await dest(f.arc);
    const {id} = await transfer(f.arc, w, did);
    await toApproval(f.arc, id);
    const pending = (await read(f.arc, owner, id)).approval;
    const source = (await f.arc.state(owner)).wallets[0].address;
    const kit = fakeKit();
    const privy = fakeWallet(source);
    const signer = createCustomerBridgeSigner({gate, wallet: privy, createAdapterFromProvider: adapterFactory, kit});
    assert.equal(kit.calls.length + privy.calls.length, 0, 'building the signer moves nothing and touches no wallet');
    await assert.rejects(signer.execute(pending), /Only an approval you made/, 'a pending approval cannot sign');
    await decide(f.arc, id, 'approve');
    const approved = (await read(f.arc, owner, id)).approval;
    assert.equal(await verifyApproval(approved) !== undefined, true, 'the binding the browser receives re-hashes to the fingerprint the customer saw');
    await signer.estimate(approved);
    assert.equal(kit.calls.length, 1);
    assert.equal(kit.calls[0][0], 'estimate');
    const out = await signer.execute(approved);
    assert.equal(out.state, 'success');
    const [, params] = kit.calls.at(-1);
    assert.equal(params.from.chain, 'Base_Sepolia');
    assert.deepEqual(params.from.adapter, {adapterFor: {id: 'eip1193'}}, 'the adapter is built from the customer wallet provider');
    assert.deepEqual(params.to, {chain: 'Arc_Testnet', recipientAddress: EXTERNAL, useForwarder: true});
    assert.notEqual(params.to.recipientAddress, source, 'the recipient differs from the source signer: no destination signature is needed');
    assert.equal(params.amount, approved.binding.amountRaw.replace(/(\d+)(\d{6})$/, '$1.$2'));
    assert.deepEqual(privy.calls.filter(c => c[0] === 'switchChain'), [['switchChain', BASE_SEPOLIA_CHAIN_ID]]);
    assert.equal(kit.calls.filter(c => c[0] === 'bridge').length, 1, 'one explicit call, one bridge');
    // Resume is allowed after the burn; a used approval cannot start a second bridge.
    for (let i = 0; i < 1; i++) await step(f.arc, id);
    const used = (await read(f.arc, owner, id)).approval;
    assert.ok(used.executedAt);
    await assert.rejects(signer.execute(used), /already used/);
    const human = raw => `${BigInt(raw) / 1000000n}.${String(BigInt(raw) % 1000000n).padStart(6, '0')}`;
    const ub = used.binding;
    await signer.retry(used, {token: 'USDC', state: 'error', amount: human(ub.amountRaw), source: {address: ub.source.address, chain: {chain: 'Base_Sepolia', chainId: 84532}}, destination: {address: ub.destination.address, recipientAddress: ub.destination.address, useForwarder: true, chain: {chain: 'Arc_Testnet', chainId: 5042002}}, config: {transferSpeed: ub.quote.speed === 'fast' ? 'FAST' : 'SLOW', maxFee: human(ub.quote.bridgeFeeRaw)}});
    assert.deepEqual(kit.calls.at(-1)[2].from, {adapterFor: {id: 'eip1193'}});
    // Tampering and wrong-wallet refusals.
    const tampered = structuredClone(approved); tampered.binding.destination.address = EXTERNAL_2;
    await assert.rejects(signer.execute(tampered), /do not match what you approved/);
    const stranger = createCustomerBridgeSigner({gate, wallet: fakeWallet('0x' + 'a'.repeat(40)), createAdapterFromProvider: adapterFactory, kit});
    await assert.rejects(stranger.execute(approved), /not the source account you approved/);
    assert.throws(() => createCustomerBridgeSigner({gate, wallet: {...fakeWallet(source), walletClientType: 'metamask'}, createAdapterFromProvider: adapterFactory, kit}), /own embedded wallet/);
    assert.throws(() => bridgeParams(approved.binding), /adapter is required/);
  } finally { await f.close(); }
  // Privy configuration mirrors the existing wallet-setup config: no auto-creation, no external wallets.
  const cfg = arcSigningPrivyConfig({baseSepolia: {id: 84532, name: 'Base Sepolia'}});
  assert.equal(cfg.embeddedWallets.ethereum.createOnLogin, 'off');
  assert.equal(cfg.externalWallets.disableAllExternalWallets, true);
  assert.equal(cfg.defaultChain.id, 84532);
  assert.throws(() => arcSigningPrivyConfig({baseSepolia: {id: 8453}}), SigningGatedError);
  // No file imports the signing module: it is prepared, not wired.
  const wired = ['App.jsx', 'ArcWallets.jsx', 'main.jsx'].filter(n => /arc-customer-signing/.test(readFileSync(new URL('../src/' + n, import.meta.url), 'utf8')));
  assert.deepEqual(wired, []);
});

async function previewServer() {
  const { createLiveStore } = await import('../hosted/live-store.mjs');
  const { createFundingJourney, journeyMerchant } = await import('../hosted/funding-journey.mjs');
  const { createHostedServer } = await import('../hosted/server.mjs');
  const { digest } = await import('../hosted/db.mjs');
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
  return {call, login, close: async () => { await new Promise(r => server.close(r)); await f.close(); }};
}

test('HTTP: destinations and approvals work for the signed-in owner only, over same-origin JSON', async () => {
  const p = await previewServer();
  try {
    assert.equal((await p.call('arc/destinations/save', {})).status, 401);
    assert.equal((await p.call('arc/approvals/decide', {})).status, 401);
    const alice = await p.login('alice'), bob = await p.login('bob');
    const made = await p.call('arc/wallets/create', {label: 'Alice wallet', requestId: randomUUID()}, alice);
    const wid = made.body.selectedArcId;
    await p.call('arc/wallets/action', {id: wid, action: 'advance'}, alice);
    const noConfirm = await p.call('arc/destinations/save', {requestId: randomUUID(), label: 'Agent', address: EXTERNAL, network: 'arc_testnet'}, alice);
    assert.equal(noConfirm.status, 400);
    assert.match(noConfirm.body.error, /Confirm the network/);
    const saved = await p.call('arc/destinations/save', {requestId: randomUUID(), label: 'Agent', address: EXTERNAL, confirmNetwork: true, network: 'arc_testnet'}, alice);
    assert.equal(saved.status, 200);
    const did = saved.body.selectedArcId;
    assert.equal(saved.body.arcFunding.destinations[0].testLabel, true);
    assert.deepEqual((await p.call('state', undefined, bob)).body.arcFunding.destinations, []);
    assert.equal((await p.call('arc/destinations/remove', {id: did}, bob)).status, 404);
    const q = await p.call('arc/quote', {walletId: wid, destinationId: did, amount: '25', speed: 'fast'}, alice);
    assert.equal(q.body.quote.destination.address, EXTERNAL);
    assert.equal((await p.call('arc/quote', {walletId: wid, destinationId: did, amount: '25'}, bob)).status, 404);
    const created = await p.call('arc/transfers/create', {quoteId: q.body.quote.id, requestId: randomUUID(), confirm: true}, alice);
    const tid = created.body.selectedArcId;
    await p.call('arc/transfers/action', {id: tid, action: 'submit', scenario: 'success'}, alice);
    await p.call('arc/transfers/action', {id: tid, action: 'advance'}, alice);
    const asked = await p.call('arc/transfers/action', {id: tid, action: 'advance'}, alice);
    const t = asked.body.arcFunding.transfers.find(x => x.id === tid);
    assert.equal(t.status, 'approval_pending');
    const body = {id: tid, approvalId: t.approval.id, bindingHash: t.approval.bindingHash, decision: 'approve'};
    assert.equal((await p.call('arc/approvals/decide', body, bob)).status, 404);
    assert.equal((await p.call('arc/approvals/decide', body, alice, {origin: 'https://evil.example'})).status, 403);
    assert.equal((await p.call('arc/approvals/decide', body, alice, {'content-type': 'text/plain'})).status, 403);
    assert.equal((await p.call('arc/approvals/decide', {...body, bindingHash: 'b'.repeat(64)}, alice)).status, 409);
    const edit = await p.call('arc/destinations/save', {requestId: randomUUID(), id: did, expectedRevision: 1, label: 'Agent', address: EXTERNAL_2, confirmNetwork: true, network: 'arc_testnet'}, alice);
    assert.equal(edit.status, 200);
    assert.equal(edit.body.arcFunding.transfers.find(x => x.id === tid).status, 'approval_invalidated');
    assert.equal((await p.call('arc/approvals/decide', body, alice)).status, 409, 'the cancelled approval cannot be used');
    const reasked = await p.call('arc/transfers/action', {id: tid, action: 'reapprove'}, alice);
    const t2 = reasked.body.arcFunding.transfers.find(x => x.id === tid);
    const ok = await p.call('arc/approvals/decide', {id: tid, approvalId: t2.approval.id, bindingHash: t2.approval.bindingHash, decision: 'approve'}, alice);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.arcFunding.transfers.find(x => x.id === tid).status, 'bridge_burn_pending');
    const st = await p.call('state', undefined, alice);
    assert.equal(st.body.paymentsDisabled, true);
    assert.equal((await p.call('checkouts', {}, alice)).status, 403);
  } finally { await p.close(); }
});

test('docs: custody is decided, source signing is separate from destination receiving, and the old claims are gone', () => {
  const doc = readFileSync(new URL('../docs/arc-agentic-wallets.md', import.meta.url), 'utf8');
  assert.match(doc, /The customer approves transfers in their wallet/);
  assert.match(doc, /## Source signing is separate from destination receiving/);
  assert.match(doc, /burn to a \*\*different\*\* recipient address/);
  assert.match(doc, /useForwarder: true/);
  assert.match(doc, /Editing a saved destination/);
  assert.doesNotMatch(doc, /never answered|No provider is chosen|blocked on the custody decision|Decide the custody model|Only Eupova agentic wallets can be funded|cannot bridge to a pasted Arc address\./i);
  assert.doesNotMatch(doc, /developer-controlled adapter written|Circle developer-controlled wallet adapter \|/i);
  // Only files inside this repository are read, so the deployable checkout is self-contained.
  for (const f of ['../docs/customer-wallet.md', '../docs/arc-agentic-wallets.md']) assert.doesNotMatch(readFileSync(new URL(f, import.meta.url), 'utf8'), /custody (is )?(still )?(undecided|open)|cannot sign for/i, f);
});

test('no wallet-provisioning or bridge adapter exists in any Arc module, so a one-chain wallet response can never pass', () => {
  const read = p => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\/\/.*$/gm, '');
  const files = ['../hosted/arc-funding.mjs', '../hosted/arc-providers.mjs', '../hosted/arc-approvals.mjs', '../hosted/arc-destinations.mjs', '../hosted/arc-fixtures.mjs', '../shared/arc-funding.mjs', '../src/arc-customer-signing.mjs'];
  for (const file of files) {
    const src = read(file);
    assert.doesNotMatch(src, /createWallets|createCircleWalletProvider|createCircleBridgeProvider|blockchains\s*:|walletSetId|accountType|provision\(\{idempotencyKey/, file);
    assert.doesNotMatch(src, /wallets\.length|new Set\(wallets/, file);
  }
  // The only wallet provisioning is the simulated stand-in for the customer's own wallet: one identity, no per-chain list.
  const made = createSimulatedProviders().wallet.provision();
  assert.deepEqual(Object.keys(made).sort(), ['address', 'providerRef']);
  assert.match(made.address, /^0x51ed[0-9a-f]{36}$/);
});
