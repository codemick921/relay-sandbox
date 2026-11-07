import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decodePaymentRequired, normaliseRequirement, validateRequirement, chooseRequirement,
  requirementFingerprint, formatUsdc6, BASE_MAINNET, BASE_USDC, MAX_TIMEOUT_SECONDS,
} from '../hosted/x402-challenge.mjs';

const b64 = v => Buffer.from(JSON.stringify(v)).toString('base64');
const resource = {url: 'https://api.example.com/premium', description: 'Market data', mimeType: 'application/json'};
const good = {
  scheme: 'exact', network: BASE_MAINNET, amount: '10000', asset: BASE_USDC,
  payTo: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C', maxTimeoutSeconds: 60,
  extra: {assetTransferMethod: 'eip3009', name: 'USDC', version: '2'},
};
const envelope = accepts => ({x402Version: 2, resource, accepts});

test('a well-formed requirement is accepted and normalised exactly as the spec describes', () => {
  const decoded = decodePaymentRequired(b64(envelope([good])));
  const {ok, requirement} = chooseRequirement(decoded);
  assert.equal(ok, true);
  assert.equal(requirement.network, BASE_MAINNET);
  assert.equal(requirement.asset, BASE_USDC.toLowerCase());
  assert.equal(requirement.amountRaw, '10000');
  assert.equal(requirement.transferMethod, 'eip3009');
  assert.equal(requirement.maxTimeoutSeconds, 60);
  assert.equal(requirement.resource, resource.url);
});

test('the assetTransferMethod defaults to eip3009 when the service omits it', () => {
  const {assetTransferMethod, ...noMethod} = good.extra;
  const {requirement} = chooseRequirement(decodePaymentRequired(b64(envelope([{...good, extra: noMethod}]))));
  assert.equal(requirement.transferMethod, 'eip3009');
});

test('everything we cannot pay is refused by name, not silently', () => {
  const cases = [
    [{...good, scheme: 'upto'}, /"upto"/],
    [{...good, network: 'eip155:84532'}, /Base mainnet/],
    [{...good, asset: '0x1111111111111111111111111111111111111111'}, /not USDC on Base/],
    [{...good, payTo: '0x123'}, /valid payment address/],
    [{...good, amount: '0'}, /valid amount/],
    [{...good, amount: '1.5'}, /valid amount/],
    [{...good, maxTimeoutSeconds: 86400}, new RegExp(String(MAX_TIMEOUT_SECONDS))],
    [{...good, extra: {assetTransferMethod: 'permit2'}}, /EIP-3009/],
  ];
  for (const [accepted, why] of cases) {
    const {ok, problems} = chooseRequirement(decodePaymentRequired(b64(envelope([accepted]))));
    assert.equal(ok, false, JSON.stringify(accepted));
    assert.match(problems.join(' '), why);
  }
});

test('a requirement above the allowance, or for another host, is refused', () => {
  const {requirement} = chooseRequirement(decodePaymentRequired(b64(envelope([good]))));
  assert.equal(validateRequirement(requirement, {maxAmountRaw: '9999'}).ok, false);
  assert.equal(validateRequirement(requirement, {maxAmountRaw: '10000'}).ok, true);
  assert.equal(validateRequirement(requirement, {allowedHost: 'api.other.com'}).ok, false);
  assert.equal(validateRequirement(requirement, {allowedHost: 'api.example.com'}).ok, true);
});

test('an insecure or malformed resource address is refused', () => {
  const bad = decodePaymentRequired(b64({...envelope([good]), resource: {...resource, url: 'http://api.example.com/x'}}));
  assert.match(chooseRequirement(bad).problems.join(' '), /https/);
  const nonsense = decodePaymentRequired(b64({...envelope([good]), resource: {...resource, url: 'not a url'}}));
  assert.match(chooseRequirement(nonsense).problems.join(' '), /not a URL/);
});

test('the first acceptable option wins when a service offers several', () => {
  const unpayable = {...good, network: 'eip155:84532'};
  const {ok, requirement} = chooseRequirement(decodePaymentRequired(b64(envelope([unpayable, good]))));
  assert.equal(ok, true);
  assert.equal(requirement.network, BASE_MAINNET);
});

test('junk in the header is refused, never parsed into something payable', () => {
  for (const junk of ['', 'not-base64-!!', Buffer.from('[]').toString('base64'), Buffer.from('"x"').toString('base64')]) {
    assert.throws(() => decodePaymentRequired(junk), /paid|read/i, junk);
  }
  const empty = decodePaymentRequired(b64({x402Version: 2, accepts: []}));
  assert.equal(chooseRequirement(empty).ok, false);
});

test('the fingerprint changes if any fact the customer approves changes', () => {
  const {requirement} = chooseRequirement(decodePaymentRequired(b64(envelope([good]))));
  const base = requirementFingerprint(requirement);
  for (const over of [{amountRaw: '10001'}, {payTo: '0x1111111111111111111111111111111111111111'}, {resource: 'https://api.example.com/other'}]) {
    assert.notEqual(requirementFingerprint({...requirement, ...over}), base, JSON.stringify(over));
  }
  assert.equal(requirementFingerprint({...requirement}), base);
});

test('amounts read back for a human without ever rounding', () => {
  assert.equal(formatUsdc6('10000'), '0.01');
  assert.equal(formatUsdc6('1'), '0.000001');
  assert.equal(formatUsdc6('1000000'), '1');
  assert.equal(formatUsdc6('1500000'), '1.5');
  assert.equal(formatUsdc6('nonsense'), 'nonsense');
});
