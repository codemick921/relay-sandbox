import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture} from './fixtures/account-store.mjs';
import {createArcFunding} from '../hosted/arc-funding.mjs';
import {POST_BURN_STATUSES} from '../shared/arc-funding.mjs';

// CCTP teaching rule these tests pin: a failure BEFORE the burn leaves the USDC spendable on Base (it may be
// kept there). A failure AFTER the burn leaves a permanent burn record; the USDC can never be claimed on Base
// again and the only way forward is attestation, mint and settlement.
const owner = 'customer:' + randomUUID();
async function setup() {
  const f = await fixture();
  const arc = createArcFunding({store: f.store});
  await arc.migrate();
  return {...f, arc};
}
const read = async (arc, id) => (await arc.state(owner)).transfers.find(t => t.id === id);
const step = (arc, id, action = 'advance') => arc.transferAction(owner, id, {action});
async function failedTransfer(arc, scenario) {
  const {id: walletId} = await arc.createWallet(owner, {label: 'Wallet', requestId: randomUUID()});
  await arc.walletAction(owner, walletId, {action: 'advance'});
  const {quote} = await arc.quote(owner, {walletId, amount: '25'});
  const {id} = await arc.createTransfer(owner, {quoteId: quote.id, requestId: randomUUID(), confirm: true});
  await arc.transferAction(owner, id, {action: 'submit', scenario});
  await step(arc, id); await step(arc, id);
  const t = await read(arc, id);
  await arc.decideApproval(owner, {id, approvalId: t.approval.id, bindingHash: t.approval.bindingHash, decision: 'approve'});
  return {id, quote};
}
const rejectedByDatabase = (f, sql, args) => assert.rejects(f.store.query(sql, args), /check|burn record|violat/i);

test('pre-burn failure: no burn record, USDC still spendable on Base, may retry or keep it on Base', async () => {
  const f = await setup();
  try {
    const {id} = await failedTransfer(f.arc, 'burn_failed');
    await step(f.arc, id); // the burn submission fails before anything is burned
    let t = await read(f.arc, id);
    assert.equal(t.status, 'burn_failed');
    assert.equal(t.failureKind, 'pre_burn');
    assert.equal(t.burn, null, 'no burn record exists');
    assert.equal(t.spendableOnBase, true);
    assert.equal(t.fundsLocation, 'Base');
    assert.match(t.hint, /did not happen/);
    assert.match(t.hint, /still in your wallet on Base/);
    assert.equal(t.canHold, true);
    assert.equal(t.canRetry, true);
    assert.match(t.retryLabel, /Try the burn again/);
    assert.equal(t.approval.status, 'approved', 'the approval is still open because nothing was burned');
    assert.equal(t.approval.executedAt, null);
    // Keeping it on Base is a real, final choice with no burn record.
    await step(f.arc, id, 'hold');
    t = await read(f.arc, id);
    assert.equal(t.status, 'held_on_base');
    assert.equal(t.burn, null);
    assert.equal(t.spendableOnBase, true);
    // The database also refuses to attach a burn record to a transfer that was kept on Base.
    await rejectedByDatabase(f, `UPDATE relay_arc_transfers SET burn_record='{"ref":"x"}'::jsonb WHERE id=$1`, [id]);
  } finally { await f.close(); }
});

test('post-burn failure: the burn record is preserved, USDC is not spendable on Base, and only resume is offered', async () => {
  const f = await setup();
  try {
    const {id, quote} = await failedTransfer(f.arc, 'attestation_failed');
    await step(f.arc, id); // burn confirmed
    let t = await read(f.arc, id);
    assert.equal(t.status, 'bridge_attestation_pending');
    const record = t.burn;
    assert.ok(record, 'the burn record is created at the moment the burn is confirmed');
    assert.match(record.ref, /^sim-burn-/);
    assert.equal(record.amountRaw, quote.baseReceiveRaw);
    assert.equal(record.sourceAddress, quote.wallet.address);
    assert.equal(record.destinationAddress, quote.destination.address);
    assert.equal(record.irreversible, true);
    assert.equal(record.simulated, true);
    assert.equal(t.spendableOnBase, false);
    assert.match(t.hint, /cannot be undone/);
    assert.doesNotMatch(t.hint, /still (in your wallet )?on Base/i);

    await step(f.arc, id); // attestation times out AFTER the burn
    t = await read(f.arc, id);
    assert.equal(t.status, 'burned_resume_required');
    assert.equal(t.failureKind, 'post_burn');
    assert.equal(t.failureCode, 'attestation_timeout');
    assert.deepEqual(t.burn, record, 'the burn record is exactly the one made before the failure');
    assert.equal(t.spendableOnBase, false);
    assert.match(t.fundsLocation, /In transit/);
    assert.match(t.hint, /cannot be undone/);
    assert.match(t.hint, /not spendable on Base/);
    assert.match(t.hint, /cannot be kept there/);
    assert.doesNotMatch(t.hint, /still (in your wallet )?on Base|is safe|nothing was burned/i);
    assert.equal(t.canHold, false);
    assert.equal(t.canCancel, false);
    assert.equal(t.canRetry, true);
    assert.match(t.retryLabel, /Resume attestation and mint \(no new burn\)/);
    assert.match(t.events.at(-1).note, /AFTER the burn/);
    assert.match(t.events.at(-1).note, new RegExp(record.ref));
    // No way to keep it on Base, cancel, ask for a new approval, or re-use the spent approval.
    await assert.rejects(step(f.arc, id, 'hold'), e => e.status === 409 && /already confirmed and cannot be undone/.test(e.message));
    for (const action of ['cancel', 'request_approval', 'reapprove']) await assert.rejects(step(f.arc, id, action), e => e.status === 409, action);
    await assert.rejects(f.arc.decideApproval(owner, {id, approvalId: t.approval.id, bindingHash: t.approval.bindingHash, decision: 'deny'}), e => e.status === 409);
    assert.ok(t.approval.executedAt, 'the approval was spent by the burn');

    // Resume continues from the attestation using the same record; there is no second burn.
    await step(f.arc, id, 'retry');
    t = await read(f.arc, id);
    assert.equal(t.status, 'bridge_attestation_pending');
    assert.equal(t.attempt, 2);
    assert.deepEqual(t.burn, record);
    assert.match(t.events.at(-1).note, new RegExp(`burn ${record.ref}`));
    assert.match(t.events.at(-1).note, /not repeated/);
    await step(f.arc, id); await step(f.arc, id);
    t = await read(f.arc, id);
    assert.equal(t.status, 'settled');
    assert.deepEqual(t.burn, record, 'settlement keeps the same burn record');
    assert.equal(t.events.filter(e => /burn confirmed on Base/i.test(e.note)).length, 1, 'exactly one burn in the whole history');
    // Restart: the record and the settled state are durable.
    const again = createArcFunding({store: f.store});
    await again.migrate();
    assert.deepEqual((await again.state(owner)).transfers.find(x => x.id === id).burn, record);
  } finally { await f.close(); }
});

test('the database itself keeps the burn record and the status in step and never lets a burn be removed', async () => {
  const f = await setup();
  try {
    const pre = await failedTransfer(f.arc, 'attestation_failed');
    await step(f.arc, pre.id); await step(f.arc, pre.id); // burned, then stalled
    const burned = pre.id;
    // A burned transfer cannot be relabelled as unburned, kept on Base, or have its record changed or removed.
    for (const status of ['held_on_base', 'burn_failed', 'bridge_burn_pending', 'approval_pending', 'base_received']) {
      await rejectedByDatabase(f, 'UPDATE relay_arc_transfers SET status=$2 WHERE id=$1', [burned, status]);
    }
    await rejectedByDatabase(f, 'UPDATE relay_arc_transfers SET burn_record=NULL WHERE id=$1', [burned]);
    await rejectedByDatabase(f, `UPDATE relay_arc_transfers SET burn_record='{"ref":"forged"}'::jsonb WHERE id=$1`, [burned]);
    // An unburned transfer cannot be moved past the burn without a record.
    const {id: unburned} = await failedTransfer(f.arc, 'success');
    for (const status of POST_BURN_STATUSES) await rejectedByDatabase(f, 'UPDATE relay_arc_transfers SET status=$2 WHERE id=$1', [unburned, status]);
    assert.equal((await read(f.arc, burned)).status, 'burned_resume_required', 'every attempt left the record untouched');
  } finally { await f.close(); }
});

test('rows saved with the old single bridge_failed status are split safely by their failure code', async () => {
  const f = await setup();
  try {
    const pre = await failedTransfer(f.arc, 'burn_failed');
    await step(f.arc, pre.id); // burn_failed
    const post = await failedTransfer(f.arc, 'attestation_failed');
    await step(f.arc, post.id); await step(f.arc, post.id); // burned_resume_required
    // Recreate the old schema state: one shared status, no burn record column semantics.
    await f.store.query('DROP TRIGGER relay_arc_burn_record_immutable ON relay_arc_transfers');
    for (const name of ['status_check', 'burn_record_matches_status']) await f.store.query(`ALTER TABLE relay_arc_transfers DROP CONSTRAINT relay_arc_transfers_${name}`);
    await f.store.query("UPDATE relay_arc_transfers SET status='bridge_failed',burn_record=NULL WHERE id IN ($1,$2)", [pre.id, post.id]);
    await f.store.query("UPDATE relay_arc_transfers SET scenario='bridge_failed' WHERE id=$1", [pre.id]).catch(() => {});
    await f.arc.migrate();
    const a = await read(f.arc, pre.id), b = await read(f.arc, post.id);
    assert.equal(a.status, 'burn_failed');
    assert.equal(a.burn, null);
    assert.equal(a.canHold, true);
    assert.equal(b.status, 'burned_resume_required');
    assert.ok(b.burn, 'a post-burn row gets a burn record so it can never be treated as unburned');
    assert.equal(b.burn.legacy, true);
    assert.equal(b.canHold, false);
    assert.equal(b.spendableOnBase, false);
  } finally { await f.close(); }
});
