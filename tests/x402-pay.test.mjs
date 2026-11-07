import test from 'node:test';
import assert from 'node:assert/strict';
import {privateKeyToAccount} from 'viem/accounts';
import {buildSignedRequest, executeX402, encodeSignatureHeader, decodeSettlementHeader} from '../hosted/x402-pay.mjs';
import {prepareApproval} from '../hosted/x402-approval.mjs';
import {chooseRequirement, decodePaymentRequired, BASE_MAINNET, BASE_USDC} from '../hosted/x402-challenge.mjs';

const wallet = privateKeyToAccount('0x' + '77'.repeat(32));
const now = 1_800_000_000;
const b64 = v => Buffer.from(JSON.stringify(v)).toString('base64');
const requirement = () => chooseRequirement(decodePaymentRequired(b64({
  x402Version: 2,
  resource: {url: 'https://api.example.com/premium', description: 'Market data'},
  accepts: [{scheme: 'exact', network: BASE_MAINNET, amount: '10000', asset: BASE_USDC,
    payTo: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C', maxTimeoutSeconds: 120,
    extra: {assetTransferMethod: 'eip3009', name: 'USDC', version: '2'}}],
}))).requirement;

async function signedPayment(over = {}) {
  const p = prepareApproval({requirement: requirement(), walletAddress: wallet.address, nowSeconds: now, chainId: 8453});
  const signature = await wallet.signTypedData(p.typedData);
  return {x402: {...p, step: 'signed', signature, host: 'api.example.com', ...over}};
}
const answer = (status, headers = {}, body = '') => () => new Response(body, {status, headers});

test('the retry carries the signature in the header the spec names, and nothing signs again', async () => {
  const payment = await signedPayment();
  const request = buildSignedRequest({payment});
  assert.equal(request.ok, true);
  assert.equal(request.method, 'GET');
  assert.equal(request.url, 'https://api.example.com/premium');
  const header = request.headers['PAYMENT-SIGNATURE'];
  const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
  assert.equal(decoded.x402Version, 2);
  assert.equal(decoded.accepted.amount, '10000');
  assert.equal(decoded.accepted.payTo, '0x209693Bc6afc0C5328bA36FaF03C514EF312287C');
  assert.equal(decoded.payload.signature, payment.x402.signature);
});

test('a payment without a signature is refused before any request is made', () => {
  assert.equal(buildSignedRequest({payment: {x402: {step: 'prepared'}}}).ok, false);
  assert.equal(buildSignedRequest({payment: null}).ok, false);
});

test('a delivered resource comes back with its settlement claim, and the claim is labelled rather than trusted', async () => {
  const payment = await signedPayment();
  const receipt = {success: true, transaction: '0xabc', network: 'eip155:8453'};
  const fetchImpl = answer(200, {'content-type': 'application/json', 'PAYMENT-RESPONSE': b64(receipt)}, '{"data":42}');
  const out = await executeX402({payment, fetchImpl});
  assert.equal(out.state, 'succeeded');
  assert.equal(out.body, '{"data":42}');
  assert.deepEqual(out.receipt, receipt);
  assert.equal(out.settledClaim, 'reported', 'a header from the service is a claim, not proof of settlement');
});

test('a 200 with no settlement header is still delivered, and says so plainly', async () => {
  const out = await executeX402({payment: await signedPayment(), fetchImpl: answer(200, {}, 'ok')});
  assert.equal(out.state, 'succeeded');
  assert.equal(out.receipt, null);
  assert.equal(out.settledClaim, 'none');
});

test('a service that refuses the signature is a definite failure, not an unknown', async () => {
  const out = await executeX402({payment: await signedPayment(), fetchImpl: answer(402, {}, '')});
  assert.equal(out.state, 'failed');
  assert.equal(out.httpStatus, 402);
});

test('a timeout is unknown: the money stays reserved and nothing is retried', async () => {
  const timeout = async () => { const e = new Error('timed out'); e.name = 'TimeoutError'; throw e; };
  const out = await executeX402({payment: await signedPayment(), fetchImpl: timeout});
  assert.equal(out.state, 'outcome_unknown');
  assert.match(out.reason, /in time/);
});

test('a server error after the signature was sent is unknown, because the service may still settle', async () => {
  const out = await executeX402({payment: await signedPayment(), fetchImpl: answer(500, {}, 'boom')});
  assert.equal(out.state, 'outcome_unknown');
  assert.equal(out.httpStatus, 500);
});

test('a client error that is not a payment refusal is reported plainly', async () => {
  const out = await executeX402({payment: await signedPayment(), fetchImpl: answer(404, {}, 'nope')});
  assert.equal(out.state, 'failed');
  assert.equal(out.httpStatus, 404);
});

test('an unsafe resource address is refused before a request is sent', async () => {
  const payment = await signedPayment({requirement: {...requirement(), resource: 'http://api.example.com/x'}});
  const out = await executeX402({payment, fetchImpl: () => { throw new Error('should not be called'); }});
  assert.equal(out.state, 'failed');
  assert.match(out.reason, /https/);
});

test('the header encoders round-trip, and junk decodes to null rather than throwing', () => {
  assert.deepEqual(decodeSettlementHeader(encodeSignatureHeader({a: 1})), {a: 1});
  assert.equal(decodeSettlementHeader('not base64 !!'), null);
  assert.equal(decodeSettlementHeader(''), null);
  assert.equal(decodeSettlementHeader(undefined), null);
});
