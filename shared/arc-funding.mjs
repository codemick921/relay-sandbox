// Arc agentic-wallet funding: pure helpers shared by the server and the browser.
// Test-data simulation only. Nothing here contacts a network, signs, or holds a key.
//
// Custody decision (Mickel, 5 Nov 2026): "The customer approves transfers in their wallet."
// The SOURCE signer is the customer's own wallet on Base. Eupova never holds a key, never signs,
// and has no authority to move funds. The DESTINATION is only a receiving address on Arc and
// needs no signature, so it can be the customer's own address or any saved external address.
import {walletAddressCheck} from './wallet-address.mjs';

export const ARC_USDC_CONTRACT = '0x3600000000000000000000000000000000000000';

// Documented sources for the figures below (checked 5 Nov 2026):
//  - CCTP fees: Standard transfers are free; Fast transfers cost 0-13 bps by source chain,
//    deducted at mint. https://developers.circle.com/cctp/concepts/fees.md
//  - Forwarding Service: CCTP protocol fee plus a Forwarding fee covering destination gas and
//    a $0.05 service fee for ordinary destinations.
//    https://developers.circle.com/cctp/concepts/forwarding-service.md
// The numbers used for estimates are ILLUSTRATIVE and are labelled as such everywhere.
export const ARC_ROUTE = Object.freeze({
  simulated: true,
  label: 'Simulated test route',
  source: Object.freeze({chain: 'Base Sepolia', kitId: 'Base_Sepolia', environment: 'testnet', chainId: 84532, domain: 6}),
  destination: Object.freeze({chain: 'Arc Testnet', kitId: 'Arc_Testnet', environment: 'testnet', chainId: 5042002, domain: 26}),
  token: 'USDC',
  decimals: 6,
  live: Object.freeze({
    available: false,
    reasons: Object.freeze([
      'Peer checkout delivers USDC on Base mainnet. Mainnet USDC cannot be bridged to Arc Testnet; testnet and mainnet are separate networks.',
      'A live route would be Base mainnet to Arc mainnet. It is not enabled: it needs the customer-wallet signing integration configured and reviewed first.',
      'No wallet is created, no signature or wallet permission is requested, and no provider credential is configured by this build.',
    ]),
  }),
});

// Both environments exist for both chains (verified 5 Nov 2026):
//  - Arc docs, "App Kits supported blockchains": Arc (mainnet) and Arc Testnet, Base, Bridge capability.
//    https://docs.arc.io/app-kit/references/supported-blockchains
//  - Circle Wallets supported blockchains: ARC / ARC-TESTNET and BASE / BASE-SEPOLIA (EOA, user-controlled).
//    https://developers.circle.com/wallets/supported-blockchains
//  - Installed Bridge Kit 1.17.0 getSupportedChains(): Base 8453 (domain 6), Base_Sepolia 84532 (6),
//    Arc 5042 (26), Arc_Testnet 5042002 (26); CCTP v2 on all four; forwarder supported as a DESTINATION on all four.
//    Its bridge() throws NetworkMismatchError when source and destination are different network types.
// Only the testnet route is enabled in this build. The mainnet route is listed so that code can refuse it
// explicitly, and so that nothing treats Arc as testnet-only.
export const ARC_ROUTES = Object.freeze({
  testnet: Object.freeze({
    environment: 'testnet', enabled: true,
    source: Object.freeze({chain: 'Base Sepolia', kitId: 'Base_Sepolia', chainId: 84532, domain: 6, walletCode: 'BASE-SEPOLIA'}),
    destination: Object.freeze({chain: 'Arc Testnet', kitId: 'Arc_Testnet', chainId: 5042002, domain: 26, walletCode: 'ARC-TESTNET'}),
  }),
  mainnet: Object.freeze({
    environment: 'mainnet', enabled: false,
    source: Object.freeze({chain: 'Base', kitId: 'Base', chainId: 8453, domain: 6, walletCode: 'BASE'}),
    destination: Object.freeze({chain: 'Arc', kitId: 'Arc', chainId: 5042, domain: 26, walletCode: 'ARC'}),
    disabledReason: 'Mainnet bridging is not enabled in this build. It needs the customer-wallet signing integration configured and an independent review first.',
  }),
});
const ENV_BY_CHAIN = new Map(Object.values(ARC_ROUTES).flatMap(r => [r.source, r.destination].flatMap(c => [[c.chain, r.environment], [c.kitId, r.environment]])));
export const environmentOf = chain => ENV_BY_CHAIN.get(chain) ?? null;
// Throws unless both chains are known, on the same network type, and that route is enabled here.
export function assertRoute(sourceChain, destinationChain) {
  const a = environmentOf(sourceChain), b = environmentOf(destinationChain);
  if (!a || !b) throw new RangeError('Unknown chain for this route.');
  if (a !== b) throw new RangeError('Testnet and mainnet cannot be mixed: source and destination must be on the same network type.');
  const route = ARC_ROUTES[a];
  if (route.source.chain !== sourceChain && route.source.kitId !== sourceChain) throw new RangeError('Unsupported source chain for this route.');
  if (route.destination.chain !== destinationChain && route.destination.kitId !== destinationChain) throw new RangeError('Unsupported destination chain for this route.');
  if (!route.enabled) throw new RangeError(route.disabledReason);
  return route;
}

export const ARC_CUSTODY = Object.freeze({
  model: 'customer-controlled',
  headline: 'You approve every transfer in your own wallet.',
  statements: Object.freeze([
    'The customer approves each transfer in their own wallet. Eupova holds no keys and has no authority to sign or move funds.',
    'The source signer is your wallet on Base. The destination only receives on Arc, so it needs no signature from Eupova or from you.',
    'In this simulation the approval is a recorded click. A live route would ask your wallet for a real signature.',
  ]),
  eupovaCanSign: false,
  eupovaHoldsKeys: false,
});

export const ARC_LIMITS = Object.freeze({wallets: 5, destinations: 10, transfers: 50, minPence: 200, maxPence: 100000, quoteSeconds: 600});

// Illustrative estimate inputs (raw USDC, 6 decimals; bps = basis points).
const FAST_PROTOCOL_BPS = 5n; // docs: 0-13 bps depending on source chain
const FORWARD_SERVICE_RAW = 50000n; // docs: $0.05 service fee
const FORWARD_GAS_ESTIMATE_RAW = 20000n; // illustrative; docs say gas is quoted dynamically
// What the simulation "settles" at, so estimated and settled output visibly differ.
const FAST_PROTOCOL_SETTLED_PERCENT = 60n;
const FORWARD_GAS_SETTLED_RAW = 15000n;

export const speeds = Object.freeze({
  fast: {label: 'Fast', timing: 'about 8 to 20 seconds on a live route (Circle docs)'},
  standard: {label: 'Standard', timing: 'about 15 to 19 minutes on a live route (Circle docs)'},
});

export const units = raw => {
  const n = BigInt(raw);
  return `${n / 1000000n}.${String(n % 1000000n).padStart(6, '0')}`;
};

export function arcQuote({pence, speed = 'fast'}) {
  if (!Number.isInteger(pence) || pence < ARC_LIMITS.minPence || pence > ARC_LIMITS.maxPence) throw new RangeError('Amount out of range.');
  if (!speeds[speed]) throw new RangeError('Unknown transfer speed.');
  // Same example rate and 2% fee as the existing Base test journey, so figures match across screens.
  const gross = BigInt(pence) * 12500n;
  const peerFee = gross / 50n;
  const baseReceive = gross - peerFee;
  const protocol = speed === 'fast' ? (baseReceive * FAST_PROTOCOL_BPS + 9999n) / 10000n : 0n;
  const bridgeTotal = protocol + FORWARD_SERVICE_RAW + FORWARD_GAS_ESTIMATE_RAW;
  const estimatedArc = baseReceive - bridgeTotal;
  return {
    pence, speed, rate: '1.25', simulated: true,
    grossUsdc: units(gross), peerFeeUsdc: units(peerFee), baseReceiveRaw: String(baseReceive), baseReceiveUsdc: units(baseReceive),
    bridge: {
      protocolFeeRaw: String(protocol), serviceFeeRaw: String(FORWARD_SERVICE_RAW), gasFeeRaw: String(FORWARD_GAS_ESTIMATE_RAW),
      totalRaw: String(bridgeTotal), totalUsdc: units(bridgeTotal), basis: 'illustrative estimate',
    },
    estimatedArcRaw: String(estimatedArc), estimatedArcUsdc: units(estimatedArc),
  };
}

// What the simulation reports once the mint is final.
export function settledFigures(quote) {
  const base = BigInt(quote.baseReceiveRaw);
  const protocol = quote.speed === 'fast' ? BigInt(quote.bridge.protocolFeeRaw) * FAST_PROTOCOL_SETTLED_PERCENT / 100n : 0n;
  const total = protocol + FORWARD_SERVICE_RAW + FORWARD_GAS_SETTLED_RAW;
  const out = base - total;
  return {
    protocolFeeRaw: String(protocol), serviceFeeRaw: String(FORWARD_SERVICE_RAW), gasFeeRaw: String(FORWARD_GAS_SETTLED_RAW),
    totalFeeRaw: String(total), totalFeeUsdc: units(total), arcOutputRaw: String(out), arcOutputUsdc: units(out),
  };
}

export const walletStatusLabels = {
  provisioning: 'Setting up (simulated)', ready: 'Ready (simulated)', failed: 'Setup failed (simulated)',
};
export const transferStatusLabels = {
  awaiting_payment: 'Waiting for the simulated payment',
  payment_failed: 'Payment failed. No money moved',
  payment_recorded: 'Payment recorded. Checking Base receipt',
  base_received: 'USDC received on Base',
  approval_pending: 'Waiting for your approval',
  approval_denied: 'You declined. Nothing was burned',
  approval_invalidated: 'Approval cancelled: details changed',
  bridge_burn_pending: 'Bridge: burning on Base',
  bridge_attestation_pending: 'Bridge: waiting for Circle attestation',
  bridge_mint_pending: 'Bridge: minting on Arc',
  settled: 'Settled on Arc',
  burn_failed: 'Burn did not happen: USDC still on Base',
  burned_resume_required: 'Burned on Base: resume to finish on Arc',
  held_on_base: 'Kept on Base',
  cancelled: 'Cancelled before payment',
};
// Statuses at which the burn on Base is confirmed. The USDC is no longer spendable on Base, the burn
// record must exist, and the only way forward is attestation, mint and settlement.
export const POST_BURN_STATUSES = Object.freeze(['bridge_attestation_pending', 'bridge_mint_pending', 'settled', 'burned_resume_required']);
export const transferTerminal = new Set(['payment_failed', 'settled', 'held_on_base', 'cancelled']);
export const transferScenarios = {
  success: 'Successful payment, bridge and Arc delivery',
  slow: 'Bridge stays pending for an extra step',
  burn_failed: 'Burn fails before anything is burned (USDC stays on Base), then can be retried',
  attestation_failed: 'Attestation times out AFTER the burn (burn cannot be undone), then must be resumed',
  payment_failed: 'Payment is declined',
};
export const walletScenarios = {success: 'Set up successfully', slow: 'Setup stays pending for an extra step', failure: 'Setup fails once, then can be retried'};

// Format check only. It deliberately does not claim the address works on Arc, that it can receive
// USDC, or who controls it.
export function arcAddressCheck(value) {
  const base = walletAddressCheck(value);
  const flags = {networkChecked: false, ownershipChecked: false};
  if (!base.valid) return {...base, ...flags};
  if (value.toLowerCase() === ARC_USDC_CONTRACT) {
    return {valid: false, code: 'token', message: 'This is the USDC token contract on Arc, not a receiving wallet.', ...flags};
  }
  return {
    valid: true, code: 'format-checked', ...flags,
    message: 'Address format checked only. Eupova has not confirmed this address on Arc, that it can receive USDC, or who controls it.',
  };
}

export const approvalStatusLabels = {
  pending: 'Waiting for your approval',
  approved: 'Approved by you',
  denied: 'Declined by you',
  invalidated: 'Cancelled because details changed',
};

// Everything the customer approves. The same object is shown on screen, hashed on the server, and
// would be re-checked before any real signature. Changing ANY field makes the hash different, so an
// approval can never be reused for a different source, destination, amount or quote.
// `source` = { walletId, address, chain }, `destination` = { mode, id, revision, label, address, chain, chainId },
// `quote` = a stored quote.
export function approvalBinding({source, destination, quote}) {
  const sourceChain = source.chain ?? ARC_ROUTE.source.chain, destinationChain = destination.chain ?? ARC_ROUTE.destination.chain;
  const route = assertRoute(sourceChain, destinationChain); // same network type, enabled route only
  return {
    version: 2,
    environment: route.environment,
    source: {walletId: source.walletId, address: String(source.address).toLowerCase(), chain: route.source.chain, chainId: route.source.chainId, signer: 'customer-wallet'},
    destination: {
      mode: destination.mode, id: destination.id ?? null, revision: destination.revision ?? 0, label: destination.label,
      address: String(destination.address).toLowerCase(), chain: route.destination.chain, chainId: route.destination.chainId,
      delivery: 'circle-forwarding-service',
    },
    token: 'USDC',
    amountRaw: String(quote.baseReceiveRaw),
    quote: {id: quote.id, speed: quote.speed, bridgeFeeRaw: String(quote.bridge.totalRaw), estimatedArcRaw: String(quote.estimatedArcRaw)},
  };
}
// Stable text for hashing. Keys are sorted at every level, because PostgreSQL's jsonb does not keep
// key order and the browser re-hashes the binding it receives.
const sortKeys = v => (Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sortKeys(v[k])])) : v);
export const canonicalBinding = binding => JSON.stringify(sortKeys(binding));

// Test destinations are always labelled as such, wherever they are shown.
export const destinationLabel = d => (d.mode === 'same_as_source' ? `${d.label} (same address as your wallet)` : `TEST destination: ${d.label}`);
export const NETWORK_CONFIRMATION = 'I confirm this address is on Arc Testnet (chain id 5042002), a test network. It is not an Arc mainnet address.';
