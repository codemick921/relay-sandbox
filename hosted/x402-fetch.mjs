// Fetching a paid URL on the customer's behalf, without becoming an open proxy.
//
// A connected tool hands Eupova a URL. Everything about that URL is untrusted: it is chosen by the tool, and the
// response is written by a stranger. This module makes exactly one request, follows no redirect, refuses anything
// that is not public https, and returns the 402 requirement for the caller to validate. It never signs, never pays,
// and never hands the response body back until a payment has completed.
import {lookup} from 'node:dns/promises';
import {decodePaymentRequired, chooseRequirement} from './x402-challenge.mjs';

export const X402_HEADERS = Object.freeze({required: 'PAYMENT-REQUIRED', signature: 'PAYMENT-SIGNATURE', response: 'PAYMENT-RESPONSE'});
const MAX_BYTES = 256 * 1024;

// Anything that can reach a machine we are running on, or a network next to it, is refused by address range.
export function isPublicAddress(ip) {
  if (typeof ip !== 'string' || ip === '') return false;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 169 && b === 254) return false;          // link-local, cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
    if (a >= 224) return false;                         // multicast and reserved
    return true;
  }
  const v6 = ip.toLowerCase();
  if (v6 === '::1' || v6 === '::') return false;
  if (/^f[cd][0-9a-f]{2}:/.test(v6)) return false;      // unique local
  if (/^fe[89ab][0-9a-f]:/.test(v6)) return false;      // link-local
  if (v6.startsWith('::ffff:')) return isPublicAddress(v6.slice(7));
  return true;
}

// A URL we are willing to call at all. https only, a real host, no credentials, no odd ports.
export function checkTarget(raw) {
  let url;
  try { url = new URL(String(raw)); } catch { return {ok: false, reason: 'That is not a web address.'}; }
  if (url.protocol !== 'https:') return {ok: false, reason: 'Paid resources must be https.'};
  if (url.username || url.password) return {ok: false, reason: 'That address carries credentials.'};
  if (url.port && url.port !== '443') return {ok: false, reason: 'Only the standard https port is allowed.'};
  if (url.hostname === 'localhost' || url.hostname.endsWith('.localhost') || url.hostname.endsWith('.internal')) return {ok: false, reason: 'That host is not public.'};
  return {ok: true, url};
}

// Resolve the host ourselves so a name cannot point at a private address after we have checked the string.
async function resolvePublic(hostname, resolver) {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(':')) return isPublicAddress(hostname);
  try {
    const rows = await (resolver ?? lookup)(hostname, {all: true});
    const list = Array.isArray(rows) ? rows : [rows];
    return list.length > 0 && list.every(r => isPublicAddress(r.address));
  } catch {
    return false;
  }
}

// One request. No redirects, a byte cap, a timeout, and the requirement normalised only when the service asks for
// payment in a shape this build supports.
export async function fetchPaidResource({url, method = 'GET', body, headers, fetchImpl = fetch, resolver, timeoutMs = 12000, maxAmountRaw, allowedHost}) {
  const target = checkTarget(url);
  if (!target.ok) return {ok: false, reason: target.reason};
  const {url: parsed} = target;
  if (!(await resolvePublic(parsed.hostname, resolver))) return {ok: false, reason: 'That host does not resolve to a public address.'};
  if (allowedHost && parsed.host !== allowedHost) return {ok: false, reason: `That host is not the one the allowance covers.`};
  const verb = String(method ?? 'GET').toUpperCase();
  if (!['GET', 'POST'].includes(verb)) return {ok: false, reason: 'Only GET and POST can be paid for.'};
  if (verb === 'GET' && body !== undefined) return {ok: false, reason: 'A GET request cannot carry a body.'};

  let response;
  try {
    response = await fetchImpl(parsed.toString(), {
      method: verb, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      headers: {...(body !== undefined ? {'Content-Type': 'application/json'} : {}), ...(headers ?? {})},
      ...(body !== undefined ? {body: JSON.stringify(body)} : {}),
    });
  } catch (e) {
    return {ok: false, reason: e?.name === 'TimeoutError' ? 'The service did not answer in time.' : 'The service could not be reached.'};
  }

  const length = Number(response.headers.get('content-length') ?? 0);
  if (length > MAX_BYTES) return {ok: false, reason: 'The service offered a response that is too large.'};

  if (response.status === 402) {
    const header = response.headers.get(X402_HEADERS.required) ?? response.headers.get(X402_HEADERS.required.toLowerCase());
    let decoded;
    try { decoded = decodePaymentRequired(header); } catch (e) { return {ok: false, reason: e.message}; }
    const chosen = chooseRequirement(decoded, {maxAmountRaw, allowedHost: parsed.host});
    if (!chosen.ok) return {ok: false, reason: chosen.problems.join(' '), problems: chosen.problems};
    return {ok: true, status: 402, requirement: chosen.requirement, host: parsed.host};
  }

  if (response.status >= 200 && response.status < 300) {
    const text = await response.text();
    if (text.length > MAX_BYTES) return {ok: false, reason: 'The service sent a response that is too large.'};
    return {ok: true, status: response.status, free: true, body: text, contentType: response.headers.get('content-type') ?? ''};
  }
  return {ok: false, status: response.status, reason: `The service answered ${response.status} and did not ask to be paid.`};
}
