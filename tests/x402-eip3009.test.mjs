import test from 'node:test';
import assert from 'node:assert/strict';
import {privateKeyToAccount} from 'viem/accounts';
import {
  TRANSFER_WITH_AUTHORIZATION, USDC_DOMAIN, newNonce, buildAuthorization, buildTypedData,
  buildPaymentPayload, verifyAuthorizationSignature, checkWindow, authorizationRef,
} from '../hosted/x402-eip3009.mjs';
import {BASE_MAINNET, BASE_USDC} from '../hosted/x402-challenge.mjs';

// A real key, used only here, to produce signatures this module must accept or refuse.
const wallet = privateKeyToAccount('0x' + '11'.repeat(32));
const other = privateKeyToAccount('0x' + '22'.repeat(32));
const now = 1_800_000_000;
const requirement = {
  scheme: 'exact', network: BASE_MAINNET, asset: BASE_USDC,
  payTo: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C', amountRaw: '10000',
  maxTimeoutSeconds: 60, transferMethod: 'eip3009', resource: 'https://api.example.com/premium',
};
const make = over => {
  const authorization = buildAuthorization({
    from: wallet.address, to: requirement.payTo, amountRaw: requirement.amountRaw,
    validAfter: now, validBefore: now + 60, nonce: newNonce(), ...over,
  });
  return {authorization, typedData: buildTypedData({chainId: 8453, verifyingContract: BASE_USDC, authorization})};
};
const sign = (typedData, account = wallet) => account.signTypedData(typedData);

test('the typed data is the EIP-3009 domain and field order USDC on Base expects', () => {
  const {typedData} = make();
  assert.equal(typedData.domain.name, 'USDC');
  assert.equal(typedData.domain.version, '2');
  assert.equal(typedData.domain.chainId, 8453);
  assert.equal(typedData.domain.verifyingContract, BASE_USDC);
  assert.equal(typedData.primaryType, 'TransferWithAuthorization');
  assert.deepEqual(typedData.types.TransferWithAuthorization.map(f => f.name), ['from', 'to', 'value', 'validAfter', 'validBefore', 'nonce']);
  assert.deepEqual(typedData.types.TransferWithAuthorization.map(f => f.type), ['address', 'address', 'uint256', 'uint256', 'uint256', 'bytes32']);
});

test('a signature from the customer wallet is accepted, and recovers to them', async () => {
  const {authorization, typedData} = make();
  const signature = await sign(typedData);
  const out = await verifyAuthorizationSignature({typedData, signature, expectedFrom: wallet.address});
  assert.equal(out.ok, true);
  assert.equal(out.recovered.toLowerCase(), wallet.address.toLowerCase());
});

test('a signature from any other wallet is refused, even when everything else matches', async () => {
  const {typedData} = make();
  const signature = await sign(typedData, other);
  const out = await verifyAuthorizationSignature({typedData, signature, expectedFrom: wallet.address});
  assert.equal(out.ok, false);
  assert.match(out.reason, /different wallet/);
});

test('a signature over a different amount, destination or nonce no longer matches what we hold', async () => {
  const {typedData} = make();
  const signature = await sign(typedData);
  const tampered = [
    {...typedData, message: {...typedData.message, value: '999999'}},
    {...typedData, message: {...typedData.message, to: '0x1111111111111111111111111111111111111111'}},
    {...typedData, message: {...typedData.message, nonce: newNonce()}},
  ];
  for (const bad of tampered) {
    const out = await verifyAuthorizationSignature({typedData: bad, signature, expectedFrom: wallet.address});
    assert.equal(out.ok, false, JSON.stringify(bad.message));
  }
});

test('a malformed or empty signature is refused without throwing', async () => {
  const {typedData} = make();
  for (const sig of ['', '0x', 'not-a-signature', '0x' + '11'.repeat(64)]) {
    const out = await verifyAuthorizationSignature({typedData, signature: sig, expectedFrom: wallet.address});
    assert.equal(out.ok, false, sig);
  }
});

test('the window must be live, bounded and not already expired', () => {
  const base = {validAfter: String(now), validBefore: String(now + 60), from: wallet.address, to: requirement.payTo, value: '10000', nonce: newNonce()};
  assert.equal(checkWindow({authorization: base, nowSeconds: now, maxTimeoutSeconds: 60}).ok, true);
  assert.equal(checkWindow({authorization: base, nowSeconds: now + 61, maxTimeoutSeconds: 60}).ok, false, 'expired');
  assert.equal(checkWindow({authorization: {...base, validAfter: String(now + 30)}, nowSeconds: now, maxTimeoutSeconds: 60}).ok, false, 'not yet valid');
  assert.equal(checkWindow({authorization: {...base, validBefore: String(now + 86400)}, nowSeconds: now, maxTimeoutSeconds: 60}).ok, false, 'far too long');
  assert.equal(checkWindow({authorization: {...base, validBefore: base.validAfter}, nowSeconds: now, maxTimeoutSeconds: 60}).ok, false, 'zero length');
  assert.equal(checkWindow({authorization: {}, nowSeconds: now, maxTimeoutSeconds: 60}).ok, false, 'no window');
});

test('the retry payload echoes exactly the requirement we validated', async () => {
  const {authorization, typedData} = make();
  const signature = await sign(typedData);
  const payload = buildPaymentPayload({requirement, authorization, signature});
  assert.equal(payload.x402Version, 2);
  assert.deepEqual(payload.accepted, {
    scheme: 'exact', network: BASE_MAINNET, amount: '10000', asset: BASE_USDC,
    payTo: requirement.payTo, maxTimeoutSeconds: 60,
    extra: {assetTransferMethod: 'eip3009', name: 'USDC', version: '2'},
  });
  assert.equal(payload.resource.url, requirement.resource);
  assert.equal(payload.payload.signature, signature);
  assert.deepEqual(payload.payload.authorization, authorization);
});

test('the same authorization always produces the same reference, and a change produces a new one', () => {
  const a = make(), b = make();
  assert.equal(authorizationRef(a), authorizationRef({...a}));
  const moved = {...a, authorization: {...a.authorization, value: '10001'}};
  assert.notEqual(authorizationRef(a), authorizationRef(moved));
  assert.match(authorizationRef(a), /^0x[0-9a-f]{64}$/);
});

test('the frozen type definition cannot be edited by a caller', () => {
  assert.throws(() => { TRANSFER_WITH_AUTHORIZATION.TransferWithAuthorization.push({name: 'x', type: 'uint256'}); });
  assert.equal(USDC_DOMAIN.name, 'USDC');
});
