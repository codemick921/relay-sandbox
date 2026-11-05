import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {addCustomer} from './fixtures/customers.mjs';
import {fixture} from './fixtures/account-store.mjs';
import {digest} from '../hosted/db.mjs';
import {createCustomerWallet} from '../hosted/customer-wallet.mjs';
import {WALLET_NETWORKS} from '../shared/wallet-model.mjs';
import {fundingTarget} from '../src/wallet-view.mjs';
import {liveProvider, FEE, ETH} from './fixtures/live-provider.mjs';

const owner = 'customer:' + randomUUID(), other = 'customer:' + randomUUID();
const DEST = '0x' + 'd'.repeat(40), ADDR = '0x' + 'a'.repeat(40);


async function setup(netId = 'base', over = {}) {
  const f = await fixture();
  const st = {calls: [], wallets: {}, usdc: {}, eth: {}, fee: FEE, found: {found: false}, ...over};
  const cw = createCustomerWallet({store: f.store, provider: liveProvider(netId, st), config: {cspOrigins: ['https://*.circle.com']}});
  await cw.migrate();
  await addCustomer(f, owner);
  return {...f, cw, st};
}
// Create the wallet the live way: saved first, PIN step, then read back.
async function ready(f, who = owner, usdc = 50_000_000n, eth = ETH) {
  const made = await f.cw.createWallet(who, {label: 'My Eupova wallet', requestId: randomUUID()});
  f.st.wallets[who] = {providerRef: 'w-' + who.slice(-6), address: ADDR.slice(0, -6) + who.slice(-6).replace(/[^0-9a-f]/g, 'e').padEnd(6, 'e'), state: 'ready'};
  await f.cw.finishSetup(who);
  f.st.usdc[who] = usdc; f.st.eth[who] = eth;
  return made;
}
const send = (f, who = owner, over = {}) => f.cw.payments.send(who, {requestId: randomUUID(), destination: DEST, amount: '2.50', service: 'Send', ...over});
const view = async (f, id, who = owner) => (await f.cw.state(who)).payments.find(p => p.id === id);
const approve = async (f, id, who = owner) => f.cw.payments.decide(who, {id, decision: 'approve', bindingHash: (await view(f, id, who)).fingerprint});
const txFor = (p, w, over = {}) => ({found: true, expectedUserId: 'uid', tx: {id: 't1', state: 'COMPLETE', userId: 'uid', walletId: w, blockchain: WALLET_NETWORKS.base.circleChain, destination: p.destination, amounts: [p.amountUsdc], tokenId: 'tok-usdc', refId: p.id, txHash: '0xrealhash', networkFee: '0.0005', transactionType: 'OUTBOUND', ...over}});


// Independent release review: absence is not terminal proof, and a lost reply must remain recoverable.
test('release review: an empty provider search never releases an approved payment reservation', async () => {
  const f = await setup('base', {execError: true});
  try {
    await ready(f);
    const {id} = await send(f);
    await approve(f, id);
    f.st.found = {found: false};
    await assert.rejects(f.cw.payments.reconcile(owner, {id, outcome: 'not_sent'}));
    assert.equal((await f.cw.state(owner)).balance.reservedUsdc, '2.500000');
    assert.equal(f.st.calls.filter(c => c.exec).length, 1);
  } finally { await f.close(); }
});

test('release review: a lost provider reply can settle from its durable payment reference without resending', async () => {
  const f = await setup('base', {execError: true});
  try {
    await ready(f);
    const {id} = await send(f);
    await approve(f, id);
    const p = await view(f, id);
    await f.store.query("UPDATE relay_cw_payments SET updated_at=now()-interval '5 minutes' WHERE id=$1", [id]);
    f.st.found = txFor(p, 'w-' + owner.slice(-6));
    const result = await f.cw.payments.refresh(owner, id);
    assert.equal(result.status, 'succeeded');
    assert.equal((await f.cw.state(owner)).balance.reservedUsdc, '0.000000');
    assert.equal(f.st.calls.filter(c => c.exec).length, 1);
  } finally { await f.close(); }
});

async function connectReviewTool(f) {
  const e = await f.cw.tools.enrolStart({name: 'Release review CLI', ip: '127.0.0.1'});
  await f.cw.tools.approveEnrolment(owner, {userCode: e.userCode});
  const got = await f.cw.tools.enrolPoll({enrolmentId: e.enrolmentId, deviceSecret: e.deviceSecret, ip: '127.0.0.1'});
  return f.cw.tools.authenticate(got.token);
}

test('release review: a live tool without allowance receives a structured refusal and cannot pay', async () => {
  const f = await setup('base');
  try {
    await ready(f);
    const tool = await connectReviewTool(f);
    const request = await f.cw.tools.requestPayment(tool, randomUUID(), {service: 'Test service', destination: DEST, amount: '1'});
    const result = await f.cw.tools.getPayment(tool, request.id);
    assert.equal(result.status, 'rejected');
    assert.equal(result.reasonCode, 'no_allowance');
    assert.equal(f.st.calls.filter(c => c.exec).length, 0);
    assert.equal((await f.cw.state(owner)).balance.reservedUsdc, '0.000000');
  } finally { await f.close(); }
});
