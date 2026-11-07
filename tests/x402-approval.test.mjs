import test from 'node:test';
import assert from 'node:assert/strict';
import {privateKeyToAccount} from 'viem/accounts';
import {prepareApproval, canChallenge, completeApproval, stillMatches, describeForCustomer} from '../hosted/x402-approval.mjs';
import {chooseRequirement, decodePaymentRequired, formatUsdc6, BASE_MAINNET, BASE_USDC} from '../hosted/x402-challenge.mjs';

const wallet = privateKeyToAccount('0x' + '33'.repeat(32));
const other = privateKeyToAccount('0x' + '44'.repeat(32));
const now = 1_800_000_000;
const b64 = v => Buffer.from(JSON.stringify(v)).toString('base64');
const requirement = () => chooseRequirement(decodePaymentRequired(b64({
  x402Version: 2,
  resource: {url: 'https://api.example.com/premium', description: 'Market data'},
  accepts: [{scheme: 'exact', network: BASE_MAINNET, amount: '25000', asset: BASE_USDC,
    payTo: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C', maxTimeoutSeconds: 120,
    extra: {assetTransferMethod: 'eip3009', name: 'USDC', version: '2'}}],
}))).requirement;

const prepared = () => prepareApproval({requirement: requirement(), walletAddress: wallet.address, nowSeconds: now, chainId: 8453});

test('a prepared authorization is bound to the wallet, the payee, the exact amount and a bounded window', () => {
  const p = prepared();
  assert.equal(p.step, 'prepared');
  assert.equal(p.authorization.from, wallet.address);
  assert.equal(p.authorization.to, '0x209693Bc6afc0C5328bA36FaF03C514EF312287C');
  assert.equal(p.authorization.value, '25000');
  assert.equal(Number(p.authorization.validAfter), now);
  assert.equal(Number(p.authorization.validBefore), now + 120);
  assert.match(p.authorization.nonce, /^0x[0-9a-f]{64}$/);
  assert.equal(p.typedData.domain.verifyingContract, BASE_USDC);
  assert.match(p.ref, /^0x[0-9a-f]{64}$/);
});

test('a record can be challenged once, and never again until it is finished or replaced', () => {
  const p = prepared();
  assert.equal(canChallenge(p).ok, true);
  assert.equal(canChallenge({...p, step: 'challenged'}).ok, false);
  assert.match(canChallenge({...p, step: 'challenged'}).reason, /already open/);
  assert.equal(canChallenge({...p, step: 'signed'}).ok, false);
  assert.equal(canChallenge(null).ok, false);
});

test('the customer\'s signature completes the approval, and the payload echoes what was approved', async () => {
  const p = prepared();
  const signature = await wallet.signTypedData(p.typedData);
  const done = await completeApproval({record: {...p, step: 'challenged'}, signature, walletAddress: wallet.address, nowSeconds: now + 5});
  assert.equal(done.ok, true);
  assert.equal(done.step, 'signed');
  assert.equal(done.payload.accepted.amount, '25000');
  assert.equal(done.payload.accepted.payTo, p.authorization.to);
  assert.equal(done.payload.payload.signature, signature);
  assert.ok(done.expiresIn > 0);
});

test('a signature from another wallet, or over other facts, never completes an approval', async () => {
  const p = prepared();
  const challenged = {...p, step: 'challenged'};
  const wrongWallet = await other.signTypedData(p.typedData);
  assert.equal((await completeApproval({record: challenged, signature: wrongWallet, walletAddress: wallet.address, nowSeconds: now})).ok, false);

  const goodSignature = await wallet.signTypedData(p.typedData);
  const different = prepared(); // same requirement, different nonce and window
  assert.equal((await completeApproval({record: {...different, step: 'challenged'}, signature: goodSignature, walletAddress: wallet.address, nowSeconds: now})).ok, false, 'a signature for another authorization does not carry over');
});

test('an expired authorization cannot be completed, even with a valid signature', async () => {
  const p = prepared();
  const signature = await wallet.signTypedData(p.typedData);
  const late = await completeApproval({record: {...p, step: 'challenged'}, signature, walletAddress: wallet.address, nowSeconds: now + 121});
  assert.equal(late.ok, false);
  assert.match(late.reason, /expired/);
});

test('completion is refused unless a challenge is actually open', async () => {
  const p = prepared();
  const signature = await wallet.signTypedData(p.typedData);
  assert.equal((await completeApproval({record: p, signature, walletAddress: wallet.address, nowSeconds: now})).ok, false);
  const done = await completeApproval({record: {...p, step: 'challenged'}, signature, walletAddress: wallet.address, nowSeconds: now});
  assert.equal(done.ok, true);
  assert.equal((await completeApproval({record: {...p, step: 'signed', signature}, signature, walletAddress: wallet.address, nowSeconds: now})).ok, false);
});

test('a requirement that changes after approval no longer matches the approval', () => {
  const p = prepared();
  const same = requirement();
  assert.equal(stillMatches(p, same), true);
  const dearer = {...same, amountRaw: '25001'};
  assert.equal(stillMatches(p, dearer), false);
  const elsewhere = {...same, payTo: '0x1111111111111111111111111111111111111111'};
  assert.equal(stillMatches(p, elsewhere), false);
});

test('the approval screen shows the service, the price and the single-use promise, not a spec sheet', () => {
  const shown = describeForCustomer(requirement(), formatUsdc6);
  assert.equal(shown.service, 'Market data');
  assert.equal(shown.host, 'api.example.com');
  assert.equal(shown.amount, '0.025');
  assert.equal(shown.validForSeconds, 120);
  assert.match(shown.note, /single-use/);
});
