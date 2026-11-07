// Making the paid call: retry the resource with the signature, and treat the answer as evidence rather than proof.
//
// Eupova is the buyer here. It does not settle anything on chain: the service's facilitator does that. What Eupova
// holds afterwards is a receipt header from the service and, at best, that. So this module never writes "paid" from a
// 200 alone. A 200 means the resource arrived; the settlement evidence is whatever PAYMENT-RESPONSE says, and only the
// chain can settle the argument.
import {buildPaymentPayload} from './x402-eip3009.mjs';
import {decodePaymentRequired} from './x402-challenge.mjs';
import {checkTarget, X402_HEADERS} from './x402-fetch.mjs';

const MAX_BODY = 256 * 1024;

// A stable base64 of the payload, exactly as the v2 spec carries it in the header.
export function encodeSignatureHeader(payload) {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

export function decodeSettlementHeader(value) {
  if (typeof value !== 'string' || value === '') return null;
  try { return JSON.parse(Buffer.from(value, 'base64').toString('utf8')); } catch { return null; }
}

// What the retry carries. Kept separate so a test can assert the exact bytes that would go over the wire.
export function buildSignedRequest({payment}) {
  const x = payment?.x402;
  if (!x || x.step !== 'signed' || typeof x.signature !== 'string') return {ok: false, reason: 'This payment has no signature yet.'};
  const payload = buildPaymentPayload({requirement: x.requirement, authorization: x.authorization, signature: x.signature});
  const target = checkTarget(x.requirement.resource);
  if (!target.ok) return {ok: false, reason: target.reason};
  const method = (x.method ?? 'GET').toUpperCase();
  return {
    ok: true, url: target.url.toString(), method,
    headers: {'Content-Type': 'application/json', [X402_HEADERS.signature]: encodeSignatureHeader(payload)},
    ...(x.body !== undefined && method === 'POST' ? {body: JSON.stringify(x.body)} : {}),
    payload,
  };
}

// One attempt. There is no retry loop on purpose: a second attempt with the same authorization would either be
// rejected by the service or, worse, accepted twice if the first response was lost.
export async function executeX402({payment, fetchImpl = fetch, timeoutMs = 15000}) {
  const request = buildSignedRequest({payment});
  if (!request.ok) return {state: 'failed', reason: request.reason, nothingSent: true};
  let response;
  try {
    response = await fetchImpl(request.url, {
      method: request.method, headers: request.headers, redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs), ...(request.body !== undefined ? {body: request.body} : {}),
    });
  } catch (e) {
    // The request may or may not have reached the service. Nothing is retried, and the money stays reserved.
    return {state: 'outcome_unknown', reason: e?.name === 'TimeoutError' ? 'The service did not answer in time.' : 'The call could not be completed.'};
  }

  const settlement = decodeSettlementHeader(response.headers.get(X402_HEADERS.response) ?? response.headers.get('x-payment-response'));
  let body = '';
  try { body = (await response.text()).slice(0, MAX_BODY); } catch { body = ''; }

  if (response.status === 402) {
    // The service refused the signature. That is a definite failure: nothing was delivered and nothing was settled.
    let why = 'The service refused the payment.';
    const fresh = response.headers.get(X402_HEADERS.required);
    if (fresh) { try { decodePaymentRequired(fresh); } catch { /* the reason is not readable; the refusal still stands */ } }
    return {state: 'failed', reason: why, nothingSent: true, httpStatus: 402};
  }
  if (response.status >= 200 && response.status < 300) {
    return {
      state: 'succeeded', httpStatus: response.status, body,
      contentType: response.headers.get('content-type') ?? '',
      receipt: settlement,
      // Delivered is not settled. Say so rather than pretending the header is a proof of funds moved.
      settledClaim: settlement?.success === true ? 'reported' : settlement ? 'reported_failure' : 'none',
    };
  }
  if (response.status === 429 || response.status >= 500) {
    return {state: 'outcome_unknown', reason: `The service answered ${response.status} after the signature was sent.`, httpStatus: response.status, receipt: settlement};
  }
  return {state: 'failed', reason: `The service answered ${response.status}.`, httpStatus: response.status, receipt: settlement};
}
