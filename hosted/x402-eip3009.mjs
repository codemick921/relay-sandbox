// EIP-3009 `TransferWithAuthorization` for x402 `exact` payments.
//
// The whole point of this file is that Eupova never trusts a signature it did not check against exactly the facts
// the customer approved. It builds the typed data, it recovers the signer, and it refuses anything that does not
// match: a different wallet, a different amount, a different destination, an expired window, or a signature that
// recovers to somebody else.
//
// Nothing here holds a key. The signing happens in the customer's wallet, behind their PIN, and comes back as a
// signature that must survive the checks below.
import {recoverTypedDataAddress, keccak256, toHex} from 'viem';
import {randomBytes} from 'node:crypto';

// The message fields, in the order the EIP-3009 type hash fixes them. Order is part of the signed payload.
export const TRANSFER_WITH_AUTHORIZATION = Object.freeze({
  TransferWithAuthorization: Object.freeze([
    {name: 'from', type: 'address'},
    {name: 'to', type: 'address'},
    {name: 'value', type: 'uint256'},
    {name: 'validAfter', type: 'uint256'},
    {name: 'validBefore', type: 'uint256'},
    {name: 'nonce', type: 'bytes32'},
  ]),
});

// USDC on Base publishes its own EIP-712 domain. A service may state a name and version in its 402, but the
// contract is the authority: if they disagree, the contract's values are what will verify on chain, so those win.
export const USDC_DOMAIN = Object.freeze({name: 'USDC', version: '2'});

export function newNonce() {
  return toHex(randomBytes(32));
}

export function buildAuthorization({from, to, amountRaw, validAfter, validBefore, nonce}) {
  return {from, to, value: String(amountRaw), validAfter: String(validAfter), validBefore: String(validBefore), nonce};
}

export function buildTypedData({chainId, verifyingContract, authorization}) {
  return {
    domain: {name: USDC_DOMAIN.name, version: USDC_DOMAIN.version, chainId: Number(chainId), verifyingContract},
    types: {TransferWithAuthorization: [...TRANSFER_WITH_AUTHORIZATION.TransferWithAuthorization]},
    primaryType: 'TransferWithAuthorization',
    message: {...authorization},
  };
}

// The header the retry carries. `accepted` echoes the requirement we validated, so the service can see exactly
// what we think we are paying for.
export function buildPaymentPayload({requirement, authorization, signature, description, mimeType}) {
  return {
    x402Version: 2,
    resource: {url: requirement.resource, ...(description ? {description} : {}), ...(mimeType ? {mimeType} : {})},
    accepted: {
      scheme: requirement.scheme,
      network: requirement.network,
      amount: requirement.amountRaw,
      asset: requirement.asset,
      payTo: requirement.payTo,
      maxTimeoutSeconds: requirement.maxTimeoutSeconds,
      extra: {assetTransferMethod: 'eip3009', name: USDC_DOMAIN.name, version: USDC_DOMAIN.version},
    },
    payload: {signature, authorization},
  };
}

// A signature is only ours if it recovers to the customer's wallet, over exactly the typed data we hold.
export async function verifyAuthorizationSignature({typedData, signature, expectedFrom}) {
  if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signature)) return {ok: false, reason: 'The wallet did not return a usable signature.'};
  let recovered;
  try {
    recovered = await recoverTypedDataAddress({...typedData, signature});
  } catch {
    return {ok: false, reason: 'The signature could not be read.'};
  }
  if (String(recovered).toLowerCase() !== String(expectedFrom ?? '').toLowerCase()) {
    return {ok: false, reason: 'That signature belongs to a different wallet.', recovered};
  }
  return {ok: true, recovered};
}

// The authorization must be live now, must not outlive the window we agreed to, and must not already be dead.
export function checkWindow({authorization, nowSeconds, maxTimeoutSeconds}) {
  const after = Number(authorization?.validAfter);
  const before = Number(authorization?.validBefore);
  if (!Number.isInteger(after) || !Number.isInteger(before)) return {ok: false, reason: 'The authorization has no usable validity window.'};
  if (before <= after) return {ok: false, reason: 'The authorization expires before it starts.'};
  if (before <= nowSeconds) return {ok: false, reason: 'The authorization has already expired.'};
  if (after > nowSeconds + 5) return {ok: false, reason: 'The authorization is not valid yet.'};
  const window = before - nowSeconds;
  const limit = Math.min(Number(maxTimeoutSeconds) || 0, before - after);
  if (limit > 0 && window > limit + 5) return {ok: false, reason: `The authorization lasts ${window} seconds, longer than the ${limit} agreed with the service.`};
  return {ok: true, expiresIn: before - nowSeconds};
}

// A stable reference for one authorization, so a replay can be recognised before it reaches the chain.
export function authorizationRef({typedData, authorization}) {
  return keccak256(toHex([typedData.domain.chainId, authorization.from, authorization.to, authorization.value, authorization.validAfter, authorization.validBefore, authorization.nonce].join('|')));
}
