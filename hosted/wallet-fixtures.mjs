// Synthetic customer-wallet fixtures for the offline preview. Test money only; no credential exists for the
// fixture tool, so nothing outside this process can use it. Idempotent per owner.
import {randomUUID} from 'node:crypto';
import {ALLOWANCE_CONFIRMATION} from './wallet-tools.mjs';

export async function seedWalletFixtures(cw, owner, {tag = 'Fixture', full = true} = {}) {
  if ((await cw.state(owner)).wallet) return;
  await cw.createWallet(owner, {label: `${tag} Eupova wallet`, requestId: randomUUID()});
  await cw.addTestMoney(owner, {requestId: randomUUID(), pence: 5000});
  if (!full) return;
  const dest = '0x' + 'd'.repeat(40);
  const wallet = (await cw.state(owner)).wallet;
  // One finished customer payment.
  const done = await cw.payments.send(owner, {requestId: randomUUID(), destination: dest, amount: '1.25', maxFee: '0.05', service: 'Coffee for the team'});
  const fp = id => cw.state(owner).then(s => s.payments.find(p => p.id === id).fingerprint);
  await cw.payments.decide(owner, {id: done.id, decision: 'approve', bindingHash: await fp(done.id)});
  // One declined, one waiting.
  const no = await cw.payments.send(owner, {requestId: randomUUID(), destination: dest, amount: '3', maxFee: '0.05', service: 'Declined example'});
  await cw.payments.decide(owner, {id: no.id, decision: 'decline', bindingHash: await fp(no.id)});
  await cw.payments.send(owner, {requestId: randomUUID(), destination: '0x' + 'e'.repeat(40), amount: '2.40', maxFee: '0.05', service: 'Waiting example'});
  // A connected tool with a modest allowance (10 USDC for 24 hours) and a request waiting for approval.
  const e = await cw.tools.enrolStart({name: `${tag} CLI (fixture, no credential)`, ip: 'fixture'});
  const t = await cw.tools.approveEnrolment(owner, {userCode: e.userCode});
  await cw.tools.setAllowance(owner, {toolId: t.id, amount: '10', hours: 24, confirm: true, confirmation: ALLOWANCE_CONFIRMATION});
  await cw.tools.requestPayment({id: t.id, owner, wallet_id: wallet.id, name: 'fixture'}, `fixture-${randomUUID()}`.slice(0, 60), {service: 'Weather API (fixture)', destination: '0x' + 'f'.repeat(40), amount: '0.75', maxFee: '0.05'});
}
