// x402 payment requirements, read from a 402 response and checked before anything is ever signed.
//
// A 402 body is untrusted input from a stranger's server. Nothing here executes it, follows it, or trusts it:
// it is decoded, normalised into the facts we care about, and then either accepted or refused with reasons.
//
// Only one shape is accepted in this build: the `exact` scheme on Base mainnet, paid with EIP-3009 against the
// USDC contract Eupova's wallet already holds. Everything else is refused by name, so the customer is told why
// rather than shown a generic failure.
import {createHash} from 'node:crypto';

export const BASE_MAINNET = 'eip155:8453';
export const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
export const BASE_CHAIN_ID = 8453;
// The authorization is single-use and the facilitator pays the gas, so a long window buys nothing and only widens
// the time a signature could be replayed by whoever holds it. The spec's own examples use 60 seconds.
export const MAX_TIMEOUT_SECONDS = 600;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const AMOUNT = /^\d{1,30}$/;

const isObject = v => v && typeof v === 'object' && !Array.isArray(v);
const text = v => (typeof v === 'string' ? v.trim() : '');

// base64 JSON, as the v2 spec sends it. Tolerates the unpadded variant some servers emit.
export function decodePaymentRequired(header) {
  const raw = text(header);
  if (!raw) throw new Error('The service did not say what it wants to be paid.');
  let json;
  try {
    json = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  } catch {
    throw new Error('The service sent payment details that could not be read.');
  }
  if (!isObject(json)) throw new Error('The service sent payment details that could not be read.');
  return json;
}

// One entry of `accepts`, reduced to the fields that decide whether we can pay it.
export function normaliseRequirement(accepted, resource) {
  const extra = isObject(accepted?.extra) ? accepted.extra : {};
  return {
    scheme: text(accepted?.scheme),
    network: text(accepted?.network),
    asset: text(accepted?.asset).toLowerCase(),
    payTo: text(accepted?.payTo),
    amountRaw: text(String(accepted?.amount ?? '')),
    maxTimeoutSeconds: Number(accepted?.maxTimeoutSeconds),
    transferMethod: text(extra.assetTransferMethod) || 'eip3009',
    tokenName: text(extra.name),
    tokenVersion: text(extra.version),
    resource: text(resource?.url ?? ''),
    description: text(resource?.description),
    mimeType: text(resource?.mimeType),
  };
}

// Every reason this cannot be paid, in plain words, so the approval screen can show them and the tool can log them.
export function validateRequirement(req, {maxAmountRaw, allowedHost} = {}) {
  const problems = [];
  if (req.scheme !== 'exact') problems.push(`This service asks for the "${req.scheme || 'unknown'}" scheme. Eupova pays "exact" only.`);
  if (req.transferMethod !== 'eip3009') problems.push(`This service asks for "${req.transferMethod}". Eupova signs EIP-3009 authorizations only.`);
  if (req.network !== BASE_MAINNET) problems.push(`This service wants payment on ${req.network || 'an unnamed network'}. Eupova pays on Base mainnet (${BASE_MAINNET}) only.`);
  if (req.asset !== BASE_USDC) problems.push('This service wants to be paid in a token that is not USDC on Base.');
  if (!ADDRESS.test(req.payTo)) problems.push('This service gave no valid payment address.');
  if (!AMOUNT.test(req.amountRaw) || req.amountRaw === '0') problems.push('This service did not give a valid amount.');
  if (maxAmountRaw !== undefined && AMOUNT.test(req.amountRaw) && BigInt(req.amountRaw) > BigInt(maxAmountRaw)) problems.push('This call costs more than the allowance allows for one payment.');
  if (!Number.isInteger(req.maxTimeoutSeconds) || req.maxTimeoutSeconds <= 0 || req.maxTimeoutSeconds > MAX_TIMEOUT_SECONDS) problems.push(`This service asks for a payment window of ${req.maxTimeoutSeconds} seconds. Eupova signs for at most ${MAX_TIMEOUT_SECONDS}.`);
  if (req.resource) {
    let url;
    try { url = new URL(req.resource); } catch { problems.push('This service gave a resource address that is not a URL.'); }
    if (url) {
      if (url.protocol !== 'https:') problems.push('This service does not use https.');
      if (allowedHost && url.host !== allowedHost) problems.push(`This call goes to ${url.host}, which is not the host the allowance covers.`);
    }
  }
  return {ok: problems.length === 0, problems};
}

// Choose the requirement to pay from a decoded 402. Returns the normalised one, or the reasons none fit.
export function chooseRequirement(paymentRequired, options = {}) {
  const accepts = Array.isArray(paymentRequired?.accepts) ? paymentRequired.accepts : [];
  if (accepts.length === 0) return {ok: false, problems: ['This service did not offer any way to pay.']};
  const refusals = [];
  for (const accepted of accepts) {
    const req = normaliseRequirement(accepted, paymentRequired?.resource);
    const check = validateRequirement(req, options);
    if (check.ok) return {ok: true, requirement: req};
    refusals.push(...check.problems);
  }
  return {ok: false, problems: [...new Set(refusals)]};
}

// The same fingerprint discipline the rest of the wallet uses: what the customer approves is a hash of exactly
// these facts, and the request that is sent must match it field for field.
export function requirementFingerprint(req) {
  const canonical = [req.scheme, req.network, req.asset, req.payTo, req.amountRaw, req.maxTimeoutSeconds, req.transferMethod, req.resource].join('\n');
  return createHash('sha256').update(canonical).digest('hex');
}

// Micro-dollars to a readable amount, for the approval screen. Never used to decide anything.
export function formatUsdc6(raw) {
  const s = String(raw ?? '');
  if (!AMOUNT.test(s)) return s;
  const whole = s.slice(0, -6) || '0';
  const frac = s.padStart(7, '0').slice(-6).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}
