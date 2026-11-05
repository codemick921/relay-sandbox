// Customer wallet model shared by the server and the browser. Pure functions only: no I/O, no secrets.
// All money is an integer count of USDC base units (6 decimals) held as a decimal string or BigInt.
// Parsing never uses floating point.
import {units} from './arc-funding.mjs';

export {units};

// The networks a deployment may use, and the exact USDC contract on each. A deployment names ONE of them; a payment
// is accepted only for that network, and a token is identified by chain plus contract address, never by its symbol.
// Addresses and chain ids are the ones in the installed Bridge Kit chain definitions (Base 8453, Base Sepolia 84532).
export const WALLET_NETWORKS = Object.freeze({
  base_sepolia: Object.freeze({
    id: 'base_sepolia', label: 'Base Sepolia (test network)', environment: 'testnet', chainId: 84532, circleChain: 'BASE-SEPOLIA', circleCode: 'BASE-SEPOLIA',
    testnet: true, enabled: true, nativeSymbol: 'ETH', usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  }),
  base: Object.freeze({
    id: 'base', label: 'Base (mainnet, real money)', environment: 'mainnet', chainId: 8453, circleChain: 'BASE', circleCode: 'BASE',
    testnet: false, enabled: true, nativeSymbol: 'ETH', usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  }),
});
export const WALLET_TOKEN = Object.freeze({symbol: 'USDC', decimals: 6});

export const WALLET_LIMITS = Object.freeze({
  maxPaymentRaw: 1_000_000_000n,        // 1,000 USDC per payment or fee cap
  maxAllowanceRaw: 100_000_000n,        // 100 USDC: a modest test ceiling
  minAllowanceHours: 1, maxAllowanceHours: 24 * 30,
  approvalWindowMinutes: 15,            // an unapproved request lapses after this long
  enrolWindowMinutes: 10,
  maxTools: 5, maxOpenRequestsPerTool: 20, maxTestCreditRaw: 100_000_000n, maxTestCredits: 20,
});

// Exact decimal parsing: "12", "12.5", "0.000001". Up to 6 decimals, no signs, exponents, spaces or separators.
export function parseUsdc(text, {allowZero = false, max = WALLET_LIMITS.maxPaymentRaw} = {}) {
  if (typeof text !== 'string' || !/^\d{1,9}(\.\d{1,6})?$/.test(text)) throw new RangeError('Enter an amount in USDC with up to six decimal places, for example 2.50.');
  const [whole, frac = ''] = text.split('.');
  const raw = BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, '0'));
  if (raw === 0n && !allowZero) throw new RangeError('The amount must be more than zero.');
  if (raw > max) throw new RangeError('That amount is above the limit for this wallet.');
  return raw;
}
export const rawText = value => {
  if (typeof value !== 'string' && typeof value !== 'bigint') throw new RangeError('Invalid amount.');
  const s = String(value);
  if (!/^\d{1,30}$/.test(s)) throw new RangeError('Invalid amount.');
  return s;
};

// `only` is the deployment's own network id: any other network, including the other Base network, is refused.
export function checkNetworkToken(network, token, only = null) {
  const n = WALLET_NETWORKS[network];
  if (!n) throw new RangeError('That network is not supported.');
  if (only && n.id !== only) throw new RangeError(`This wallet works on ${WALLET_NETWORKS[only]?.label ?? 'one network'} only.`);
  if (!n.enabled) throw new RangeError(n.reason);
  if (token !== WALLET_TOKEN.symbol) throw new RangeError('Only USDC can be used.');
  return n;
}
// Native-asset amounts (ETH on Base) are 18-decimal integers held as strings. Display only; never mixed with USDC.
export const nativeText = wei => {
  const s = String(wei ?? '0');
  if (!/^\d{1,40}$/.test(s)) return '0';
  const padded = s.padStart(19, '0'), whole = padded.slice(0, -18), frac = padded.slice(-18).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
};

export const serviceName = text => {
  const s = typeof text === 'string' ? text.trim().replace(/\s+/g, ' ') : '';
  if (s.length < 2 || s.length > 60 || /[<>\u0000-\u001f]/.test(s)) throw new RangeError('Give the service a plain name of 2 to 60 characters.');
  return s;
};

export const paymentStatusLabels = Object.freeze({
  awaiting_approval: 'Waiting for your approval', declined: 'You declined', rejected: 'Refused', invalidated: 'Approval cancelled: details changed',
  expired: 'Request lapsed', approved: 'Approved', executing: 'Sending', succeeded: 'Paid', failed: 'Did not send',
  outcome_unknown: 'Outcome unknown: needs your check', cancelled: 'Cancelled',
});
export const paymentTerminal = new Set(['declined', 'rejected', 'invalidated', 'expired', 'succeeded', 'failed', 'cancelled']);
export const rejectReasons = Object.freeze({
  no_allowance: 'This tool has no active allowance, so the request was refused.',
  allowance_expired: 'The tool\'s allowance has ended.',
  over_allowance: 'The request is more than the allowance has left.',
  insufficient_balance: 'The wallet does not have enough USDC for this payment and its maximum fee.',
  insufficient_gas: 'The wallet does not have enough ETH to pay the network fee for this payment.',
  sponsorship_exhausted: "Eupova's own daily limit for sponsored network fees has been reached, so this was not started and nothing was charged. Try again tomorrow.",
  fee_unavailable: 'The network fee could not be worked out just now, so the request was not made. Try again shortly.',
  tool_revoked: 'This tool was disconnected.',
  wallet_not_ready: 'The wallet is not ready.',
});

// What a customer approves, in a fixed order, so the same details always give the same fingerprint input.
// Anything that would change what is paid, from where, to whom or under which permission is inside it.
export function paymentBinding(p) {
  const n = checkNetworkToken(p.network, p.token, p.only ?? null);
  const addr = /^0x[0-9a-fA-F]{40}$/.test(p.destination) ? p.destination.toLowerCase() : null;
  if (!addr || /^0x0{40}$/.test(addr)) throw new RangeError('Check the destination address.');
  const amount = BigInt(rawText(p.amountRaw)), fee = BigInt(rawText(p.maxFeeRaw)), cap = BigInt(rawText(p.capRaw));
  if (amount <= 0n || cap !== amount + fee) throw new RangeError('The total cap must equal the amount plus the maximum fee.');
  // The network fee is part of what is approved, in its own asset. On Base it is ETH paid from the wallet, never USDC.
  const asset = p.feeAsset ?? 'USDC';
  if (!['USDC', 'ETH', 'sponsored'].includes(asset)) throw new RangeError('Unknown fee asset.');
  const nativeMax = BigInt(rawText(p.maxNativeFeeWei ?? '0'));
  if (asset !== 'USDC' && fee !== 0n) throw new RangeError('A network fee paid in ETH or by sponsorship cannot also be charged in USDC.');
  if (asset === 'ETH' && nativeMax <= 0n && p.rejected !== true) throw new RangeError('An ETH network fee needs an estimate.');
  if (asset !== 'ETH' && nativeMax !== 0n) throw new RangeError('Only an ETH fee has an ETH maximum.');
  return {
    v: 2, origin: p.origin === 'tool' ? 'tool' : 'customer', requestId: String(p.requestId),
    wallet: {id: String(p.walletId), address: String(p.walletAddress).toLowerCase()},
    network: {id: n.id, chainId: n.chainId, environment: n.environment}, token: {symbol: WALLET_TOKEN.symbol, address: n.usdc.toLowerCase(), chainId: n.chainId},
    service: serviceName(p.service), destination: addr,
    amountRaw: amount.toString(), maxFeeRaw: fee.toString(), capRaw: cap.toString(),
    fee: {asset, usdcMaxRaw: fee.toString(), nativeMaxWei: nativeMax.toString(), gasLimit: asset === 'ETH' ? String(p.gasLimit) : null, maxFee: asset === 'ETH' ? String(p.maxFee) : null, priorityFee: asset === 'ETH' ? String(p.priorityFee) : null},
    tool: p.origin === 'tool' ? {id: String(p.toolId), allowanceId: String(p.allowanceId), allowanceRevision: Number(p.allowanceRevision)} : null,
  };
}
const sortKeys = v => Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sortKeys(v[k])])) : v;
export const canonicalPayment = binding => JSON.stringify(sortKeys(binding));

// Short human-readable form of a fingerprint (the full value is what is compared).
export const shortFingerprint = hex => (typeof hex === 'string' && hex.length >= 16 ? `${hex.slice(0, 8)}…${hex.slice(-6)}` : '');

// Simulated Pay on Eupova credit: whole pence in, USDC base units out, integer maths. Peer fee 2% kept back.
export function simulatedPayCredit(pence) {
  if (!Number.isInteger(pence) || pence < 200 || pence > 100000) throw new RangeError('Choose between £2 and £1,000.');
  const gross = BigInt(pence) * 12500n; // £1 = 1.25 USDC
  return gross - gross / 50n;
}
