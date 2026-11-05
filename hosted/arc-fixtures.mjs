// Synthetic Arc funding fixtures for the local preview and tests. Simulated data only: no wallet,
// key or network exists behind any of these records, and every approval is a recorded click.
import {randomUUID} from 'node:crypto';

const FIXTURE_DESTINATION = '0x7e57000000000000000000000000000000000001'; // 0x7e57 = "test"; exists on no network
const FIXTURE_DESTINATION_2 = '0x7e57000000000000000000000000000000000002';

export async function seedArcFixtures(arc, owner, {tag = 'Fixture', full = true} = {}) {
  const wallet = async (label, scenario, advances) => {
    const {id} = await arc.createWallet(owner, {label, requestId: randomUUID(), scenario});
    for (let i = 0; i < advances; i++) await arc.walletAction(owner, id, {action: 'advance'});
    return id;
  };
  const destination = async (label, address) => (await arc.saveDestination(owner, {requestId: randomUUID(), label, address, confirmNetwork: true, network: 'arc_testnet'})).id;
  const decide = async (id, decision) => {
    const t = (await arc.state(owner)).transfers.find(x => x.id === id);
    await arc.decideApproval(owner, {id, approvalId: t.approval.id, bindingHash: t.approval.bindingHash, decision});
  };
  // steps: advances before the decision (2 reaches the approval request), the decision, advances after.
  const transfer = async (walletId, amount, speed, scenario, {destinationId = null, before = 0, decision = null, after = 0} = {}) => {
    const {quote} = await arc.quote(owner, {walletId, destinationId, amount, speed});
    const {id} = await arc.createTransfer(owner, {quoteId: quote.id, requestId: randomUUID(), confirm: true});
    if (scenario) await arc.transferAction(owner, id, {action: 'submit', scenario});
    for (let i = 0; i < before; i++) await arc.transferAction(owner, id, {action: 'advance'});
    if (decision) await decide(id, decision);
    for (let i = 0; i < after; i++) await arc.transferAction(owner, id, {action: 'advance'});
    return id;
  };
  const ready = await wallet(`${tag} wallet`, 'success', 1);
  const external = await destination(`${tag} agent`, FIXTURE_DESTINATION);
  if (!full) { await transfer(ready, '10', 'fast', 'success', {before: 2, decision: 'approve', after: 3}); return; }
  await wallet(`${tag} pending setup`, 'slow', 1);
  await wallet(`${tag} failed setup`, 'failure', 1);
  await transfer(ready, '25', 'fast', 'success', {before: 2, decision: 'approve', after: 3}); // settled, same address
  await transfer(ready, '18', 'fast', 'success', {destinationId: external, before: 2, decision: 'approve', after: 3}); // settled to an external test destination
  await transfer(ready, '40', 'standard', 'slow', {before: 2, decision: 'approve', after: 2}); // attestation pending
  await transfer(ready, '15', 'fast', 'burn_failed', {before: 2, decision: 'approve', after: 1}); // PRE-burn failure: nothing burned, USDC still on Base, approval still applies
  await transfer(ready, '30', 'fast', 'attestation_failed', {before: 2, decision: 'approve', after: 2}); // POST-burn failure: burn record kept, cannot be undone, resume only
  await transfer(ready, '20', 'fast', 'payment_failed'); // declined payment
  await transfer(ready, '12.50', 'fast', null); // awaiting payment
  await transfer(ready, '22', 'fast', 'success', {destinationId: external, before: 2}); // waiting for your approval
  await transfer(ready, '35', 'fast', 'success', {before: 2, decision: 'deny'}); // you declined
  // An approval that an edit cancelled: the second destination is saved, a transfer asks for approval, then it is edited.
  const edited = await destination(`${tag} second agent`, FIXTURE_DESTINATION_2);
  await transfer(ready, '27', 'fast', 'success', {destinationId: edited, before: 2});
  await arc.saveDestination(owner, {requestId: randomUUID(), id: edited, expectedRevision: 1, label: `${tag} second agent (renamed)`, address: FIXTURE_DESTINATION_2, confirmNetwork: true, network: 'arc_testnet'});
}
