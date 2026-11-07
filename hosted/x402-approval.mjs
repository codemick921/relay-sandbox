// The approval half of an x402 payment: turn an accepted requirement into the one thing the customer signs, then
// decide whether what came back is exactly it.
//
// This is a state machine over facts, not a runner. It never signs, never calls a network, and never decides that a
// payment happened. Phase 4 executes; this only decides whether a signature is the one we asked for.
//
// Why the state lives here and not at Circle: SignTypedDataInput has no idempotency key, so the SDK cannot refuse a
// repeated signing request. Every guard against a second prompt or a replayed signature has to be ours.
import {buildAuthorization, buildTypedData, buildPaymentPayload, verifyAuthorizationSignature, checkWindow, newNonce, authorizationRef} from './x402-eip3009.mjs';
import {requirementFingerprint} from './x402-challenge.mjs';

export const APPROVAL_STEPS = Object.freeze(['prepared', 'challenged', 'signed', 'rejected']);
const TERMINAL = new Set(['signed', 'rejected']);

// Build the authorization a customer will be asked to sign. `nowSeconds` is passed in so the window is testable and
// never depends on a clock read buried in here.
export function prepareApproval({requirement, walletAddress, nowSeconds, nonce = newNonce(), chainId}) {
  const authorization = buildAuthorization({
    from: walletAddress, to: requirement.payTo, amountRaw: requirement.amountRaw,
    validAfter: nowSeconds, validBefore: nowSeconds + requirement.maxTimeoutSeconds, nonce,
  });
  const typedData = buildTypedData({chainId, verifyingContract: requirement.asset, authorization});
  return {
    step: 'prepared',
    // The record carries the requirement it was built from, so a later check compares against the facts that were
    // actually signed rather than against whatever the service says now.
    requirement,
    requirementRef: requirementFingerprint(requirement),
    authorization, typedData,
    ref: authorizationRef({typedData, authorization}),
  };
}

// Before asking Circle for a challenge. A record that has already been challenged must not raise a second prompt,
// because nothing downstream will stop it; and a signature that is already held cannot be replaced.
export function canChallenge(record) {
  if (!record) return {ok: false, reason: 'There is no prepared authorization to sign.'};
  if (record.step === 'challenged') return {ok: false, reason: 'A signing step for this payment is already open. Finish it, or start again from the payment.'};
  if (TERMINAL.has(record.step)) return {ok: false, reason: 'This payment already has a signature.'};
  if (record.step !== 'prepared') return {ok: false, reason: 'This payment is not ready to sign.'};
  return {ok: true};
}

// After the customer completes the PIN step. Everything is checked against the record we hold, never against what
// the browser says it signed.
export async function completeApproval({record, signature, walletAddress, nowSeconds}) {
  if (!record) return {ok: false, reason: 'There is no prepared authorization to check.'};
  if (record.step === 'signed') return {ok: false, reason: 'This payment already has a signature.'};
  if (record.step !== 'challenged') return {ok: false, reason: 'No signing step was open for this payment.'};
  const window = checkWindow({authorization: record.authorization, nowSeconds, maxTimeoutSeconds: record.requirement.maxTimeoutSeconds});
  if (!window.ok) return {ok: false, reason: window.reason};
  const verified = await verifyAuthorizationSignature({typedData: record.typedData, signature, expectedFrom: walletAddress});
  if (!verified.ok) return {ok: false, reason: verified.reason};
  return {
    ok: true,
    step: 'signed',
    signature,
    ref: record.ref,
    payload: buildPaymentPayload({requirement: record.requirement, authorization: record.authorization, signature}),
    expiresIn: window.expiresIn,
  };
}

// A requirement that changes after approval must not reuse the approval. Callers compare this before executing.
export function stillMatches(record, requirement) {
  return !!record && record.requirementRef === requirementFingerprint(requirement);
}

// One line for the approval screen, and the same line for the audit record.
export function describeForCustomer(requirement, format) {
  return {
    service: requirement.description || new URL(requirement.resource).host,
    host: new URL(requirement.resource).host,
    resource: requirement.resource,
    amount: format(requirement.amountRaw),
    network: requirement.network,
    payTo: requirement.payTo,
    validForSeconds: requirement.maxTimeoutSeconds,
    note: 'This pays for one call. The authorization is single-use, and the service pays the network fee.',
  };
}
