// A test seller, so the first live payment can be made against something we own.
//
// It is deliberately honest about what it is. It asks for payment, checks that the signature it receives is a
// well-formed EIP-3009 authorization for exactly what it asked for, and then delivers. It does NOT submit anything to
// the chain: a real seller settles through a facilitator, and building a settle path that holds gas is a separate job.
// So its receipt says `simulated: true`, and the buyer's ledger records the claim as reported rather than as proof.
//
// Nothing here moves money. Its purpose is to prove the buy side in production: a tool asks, Eupova reads the 402,
// the customer signs, the call is made, and the outcome is recorded.
import {USDC_DOMAIN} from './x402-eip3009.mjs';
import {BASE_MAINNET, BASE_USDC} from './x402-challenge.mjs';

export const TEST_SELLER_PATH = '/x402-test/premium';
export const TEST_SELLER_AMOUNT = '10000'; // 0.01 USDC: small enough that a mistake is cheap.

const b64 = v => Buffer.from(JSON.stringify(v), 'utf8').toString('base64');

export function requirementFor({payTo, url, amount = TEST_SELLER_AMOUNT}) {
  return {
    x402Version: 2,
    resource: {url, description: 'Eupova test seller: one call, no settlement', mimeType: 'application/json'},
    accepts: [{
      scheme: 'exact', network: BASE_MAINNET, amount, asset: BASE_USDC, payTo,
      maxTimeoutSeconds: 120,
      extra: {assetTransferMethod: 'eip3009', name: USDC_DOMAIN.name, version: USDC_DOMAIN.version},
    }],
  };
}

// The seller's own check, against the requirement it published (the raw `accepts` entry, not the buyer's normalised
// view of it). Not authoritative for settlement, but it should refuse anything that is not the payment it asked for:
// wrong amount, wrong destination, wrong network, or a signature that is not shaped like one.
export function checkPayment({header, requirement}) {
  if (typeof header !== 'string' || header === '') return {ok: false, reason: 'No payment was offered.'};
  let payload;
  try { payload = JSON.parse(Buffer.from(header, 'base64').toString('utf8')); } catch { return {ok: false, reason: 'The payment could not be read.'}; }
  const accepted = payload?.accepted ?? {};
  const auth = payload?.payload?.authorization ?? {};
  if (payload?.x402Version !== 2) return {ok: false, reason: 'Unsupported payment version.'};
  if (accepted.scheme !== 'exact') return {ok: false, reason: 'Unsupported scheme.'};
  if (String(accepted.scheme) !== String(requirement.scheme)) return {ok: false, reason: 'The payment uses a scheme this seller did not offer.'};
  if (String(accepted.network) !== String(requirement.network)) return {ok: false, reason: 'Wrong network.'};
  if (String(accepted.amount) !== requirement.amount) return {ok: false, reason: 'Wrong amount.'};
  if (String(accepted.payTo).toLowerCase() !== requirement.payTo.toLowerCase()) return {ok: false, reason: 'Wrong payee.'};
  if (String(auth.to).toLowerCase() !== requirement.payTo.toLowerCase()) return {ok: false, reason: 'The authorization pays somebody else.'};
  if (String(auth.value) !== String(requirement.amount)) return {ok: false, reason: 'The authorization is for a different amount.'};
  if (typeof payload?.payload?.signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(payload.payload.signature)) return {ok: false, reason: 'The signature is not shaped like one.'};
  return {ok: true, from: auth.from, nonce: auth.nonce, validBefore: auth.validBefore};
}

// What the buyer gets back. `simulated` is the important field: it is true, and it says why.
export function settlementReceipt({from, nonce}) {
  return {success: true, simulated: true, note: 'Test seller: the authorization was checked but nothing was submitted on chain.', payer: from, nonce};
}

export function receiptHeader(receipt) {
  return b64(receipt);
}
