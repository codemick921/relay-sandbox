import test from 'node:test';
import assert from 'node:assert/strict';
import {privateKeyToAccount} from 'viem/accounts';
import {requirementFor, checkPayment, settlementReceipt, receiptHeader, TEST_SELLER_AMOUNT} from '../hosted/x402-test-seller.mjs';
import {prepareApproval} from '../hosted/x402-approval.mjs';
import {buildPaymentPayload} from '../hosted/x402-eip3009.mjs';
import {chooseRequirement, decodePaymentRequired, BASE_MAINNET, BASE_USDC} from '../hosted/x402-challenge.mjs';

const wallet = privateKeyToAccount('0x' + '88'.repeat(32));
const payTo = '0x' + '9'.repeat(40);
const URL = 'https://app.eupova.com/x402-test/premium';

test('the seller asks for 0.01 USDC on Base, and the buyer can read it', () => {
  const envelope = requirementFor({payTo, url: URL});
  const parsed = chooseRequirement(decodePaymentRequired(Buffer.from(JSON.stringify(envelope)).toString('base64')));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.requirement.amountRaw, TEST_SELLER_AMOUNT);
  assert.equal(parsed.requirement.network, BASE_MAINNET);
  assert.equal(parsed.requirement.asset, BASE_USDC);
  assert.equal(parsed.requirement.payTo, payTo);
});

const published = () => requirementFor({payTo, url: URL}).accepts[0];
async function header() {
  const req = chooseRequirement(decodePaymentRequired(Buffer.from(JSON.stringify(requirementFor({payTo, url: URL}))).toString('base64'))).requirement;
  const p = prepareApproval({requirement: req, walletAddress: wallet.address, nowSeconds: 1_800_000_000, chainId: 8453});
  const signature = await wallet.signTypedData(p.typedData);
  const payload = buildPaymentPayload({requirement: req, authorization: p.authorization, signature});
  return {header: Buffer.from(JSON.stringify(payload)).toString('base64'), req: published()};
}

test('a correct payment is accepted', async () => {
  const {header: h, req} = await header();
  const out = checkPayment({header: h, requirement: req});
  assert.equal(out.ok, true);
  assert.equal(out.from, wallet.address);
});

test('the wrong amount, payee, network or scheme is refused', async () => {
  const {header: h, req} = await header();
  for (const requirement of [{...req, amount: '20000'}, {...req, payTo: '0x' + '1'.repeat(40)}, {...req, network: 'eip155:84532'}, {...req, scheme: 'upto'}]) {
    assert.equal(checkPayment({header: h, requirement}).ok, false, JSON.stringify(requirement));
  }
});

test('junk, an empty header and a malformed signature are refused', async () => {
  const {header: h, req} = await header();
  assert.equal(checkPayment({header: '', requirement: req}).ok, false);
  assert.equal(checkPayment({header: 'not base64 !!', requirement: req}).ok, false);
  const bad = JSON.parse(Buffer.from(h, 'base64').toString());
  bad.payload.signature = '0x12';
  assert.equal(checkPayment({header: Buffer.from(JSON.stringify(bad)).toString('base64'), requirement: req}).ok, false);
});

test('the receipt says plainly that nothing was settled', async () => {
  const {header: h, req} = await header();
  const checked = checkPayment({header: h, requirement: req});
  const receipt = settlementReceipt(checked);
  assert.equal(receipt.success, true);
  assert.equal(receipt.simulated, true, 'a test seller must never claim a real settlement');
  assert.match(receipt.note, /nothing was submitted on chain/);
  assert.deepEqual(JSON.parse(Buffer.from(receiptHeader(receipt), 'base64').toString()), receipt);
});
