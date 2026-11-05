// Customer-wallet signing for the Base-to-Arc bridge. PREPARED AND GATED: nothing imports this file
// in the app, it imports no SDK, reads no configuration and opens no connection. Everything it needs
// is passed in, and the gate below is closed in this build.
//
// Custody model: "The customer approves transfers in their wallet." The SOURCE signer is the
// customer's own Privy embedded wallet on Base, which already exists in Eupova's Privy architecture
// (see docs/privy-wallet-setup-adapter.md). The DESTINATION is only a recipient address on Arc; it
// signs nothing, so it can differ from the source. Eupova never holds a key or signs.
//
// Documented calls this follows (checked 5 Nov 2026):
//  - Privy (installed 3.51.0 type definitions): useWallets() -> { wallets, ready }; a ConnectedWallet has
//    switchChain(chainId) and getEthereumProvider(): Promise<EIP1193Provider>; PrivyProvider config takes
//    supportedChains and defaultChain.
//  - Circle Bridge Kit with a browser (EIP-1193) wallet: the Viem provider adapter, built from the
//    wallet's provider with createViemAdapterFromProvider({ provider }); then
//    kit.bridge({ from: { adapter, chain }, to: { chain, recipientAddress, useForwarder: true }, amount }).
//    A destination adapter is not needed when the Forwarding Service mints, which is how a different
//    recipientAddress is supported. kit.estimate(...) quotes the fees; kit.retry(result, ...) resumes a
//    failed transfer without repeating a completed burn. Chain ids are "Base_Sepolia" and "Arc_Testnet".
//    https://docs.arc.io/app-kit/bridge and https://developers.circle.com/cctp
//  - Bridge Kit >= 1.16.0 and the Viem adapter >= 1.19.2 are required for Arc Testnet (Circle bridge skill).
import {ARC_ROUTE, ARC_ROUTES, assertRoute, canonicalBinding, units} from '../shared/arc-funding.mjs';

export class SigningGatedError extends Error {
  constructor(message) { super(message); this.name = 'SigningGatedError'; }
}

// Closed by default. Opening it is a reviewed code change, not a runtime setting.
export const customerSigningGate = Object.freeze({approved: false, reviewed: Object.freeze({dependencies: false, permissions: false, custody: false, privyConfig: false})});
const open = g => g?.approved === true && ['dependencies', 'permissions', 'custody', 'privyConfig'].every(k => g.reviewed?.[k] === true);

export const BASE_SEPOLIA_CHAIN_ID = ARC_ROUTES.testnet.source.chainId; // 84532, from the verified route table
export const bridgeChains = Object.freeze({source: ARC_ROUTE.source.kitId, destination: ARC_ROUTE.destination.kitId});

// PrivyProvider config for customer-wallet signing. Mirrors the existing wallet-setup config
// (no automatic wallet creation, no external wallets) and adds the source chain, which Privy needs in
// supportedChains before an embedded wallet can switch to it. Pass viem's baseSepolia.
export function arcSigningPrivyConfig({baseSepolia}) {
  if (baseSepolia?.id !== BASE_SEPOLIA_CHAIN_ID) throw new SigningGatedError('Pass the Base Sepolia chain definition.');
  return {
    embeddedWallets: {ethereum: {createOnLogin: 'off'}, solana: {createOnLogin: 'off'}, disableAutomaticMigration: true},
    externalWallets: {disableAllExternalWallets: true},
    supportedChains: [baseSepolia], defaultChain: baseSepolia,
  };
}

export async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// The approval the customer made must still describe exactly what is about to be signed.
export async function verifyApproval(approval, {resume = false} = {}) {
  if (approval?.status !== 'approved') throw new SigningGatedError('Only an approval you made can be used. It is ' + (approval?.status ?? 'missing') + '.');
  if (approval.executedAt && !resume) throw new SigningGatedError('This approval was already used.');
  if (await sha256Hex(canonicalBinding(approval.binding)) !== approval.bindingHash) throw new SigningGatedError('The approval details do not match what you approved.');
  assertBindingRoute(approval.binding);
  return approval.binding;
}

// Same network type on both ends, an enabled route, and the exact chain ids from the verified table.
// Mainnet bindings, and any mix of testnet and mainnet, are refused here as well as by the SDK.
export function assertBindingRoute(binding) {
  const route = assertRoute(binding?.source?.chain, binding?.destination?.chain);
  if (binding.environment !== route.environment || binding.source.chainId !== route.source.chainId || binding.destination.chainId !== route.destination.chainId) {
    throw new SigningGatedError('The approval names chains that do not match the verified route.');
  }
  return route;
}

// The approved speed, mapped explicitly onto Bridge Kit's TransferSpeed ("fast" -> FAST, "standard" -> SLOW).
// Any other value fails closed instead of silently falling back to the SDK default (FAST).
export const transferSpeedFor = Object.freeze({fast: 'FAST', standard: 'SLOW'});

// Exact decimal-string USDC to raw 6-decimal units. Anything unreadable, or with more than six
// decimals, throws: the caller treats an amount it cannot read exactly as a quote it cannot honour.
export function parseUsdcRaw(text) {
  if (typeof text !== 'string' || !/^\d+(\.\d{1,6})?$/.test(text)) throw new SigningGatedError('A fee or amount from the bridge could not be read exactly, so the approved quote cannot be honoured.');
  const [whole, fraction = ''] = text.split('.');
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
}

// The numbers the customer approved, validated for internal consistency (fail closed if not).
function approvedTerms(binding) {
  const speed = transferSpeedFor[binding?.quote?.speed];
  if (!speed) throw new SigningGatedError('The approved transfer speed is not one this build can run, so nothing was started.');
  let amount, maxFee, minOutput;
  try { amount = BigInt(binding.amountRaw); maxFee = BigInt(binding.quote.bridgeFeeRaw); minOutput = BigInt(binding.quote.estimatedArcRaw); } catch { throw new SigningGatedError('The approval amounts are unreadable.'); }
  if (amount <= 0n || maxFee < 0n || minOutput <= 0n || amount - maxFee !== minOutput) throw new SigningGatedError('The approved amount, fee cap and minimum received do not add up.');
  return {speed, amount, maxFee, minOutput};
}

// Parameters for kit.bridge, built only from the verified binding. The recipient is the approved
// destination (it may differ from the source address); the approved speed and fee cap are passed to the
// SDK as config.transferSpeed and config.maxFee (a human USDC string; for a forwarded transfer it must
// cover the burn and forwarding fees). No customFee is ever set, so nothing is added on top of the amount.
/**
 * @param {any} binding the verified approval binding
 * @param {any} adapter a Viem provider adapter built from the customer's wallet
 * @returns {{from: {adapter: any, chain: 'Base_Sepolia'}, to: {chain: 'Arc_Testnet', recipientAddress: string, useForwarder: true}, amount: string, config: {transferSpeed: 'FAST' | 'SLOW', maxFee: string, batchTransactions: false}}}
 */
export function bridgeParams(binding, adapter) {
  assertBindingRoute(binding);
  if (!adapter) throw new SigningGatedError('A wallet adapter is required.');
  const {speed, maxFee} = approvedTerms(binding);
  return {
    from: {adapter, chain: bridgeChains.source},
    to: {chain: bridgeChains.destination, recipientAddress: binding.destination.address, useForwarder: true},
    amount: units(binding.amountRaw),
    config: {transferSpeed: speed, maxFee: units(maxFee), batchTransactions: false},
  };
}

// Parameters for kit.estimate: the same as bridgeParams but WITHOUT config.maxFee. Bridge Kit uses a
// supplied maxFee as the provider fee directly (provider-cctp-v2 getMaxFee), so an estimate that carries our
// cap would only echo the cap back. Without it the SDK asks for the current burn and forwarding fees,
// which is the live quote the cap is checked against.
/**
 * @param {any} binding the verified approval binding
 * @param {any} adapter a Viem provider adapter built from the customer's wallet
 * @returns {{from: {adapter: any, chain: 'Base_Sepolia'}, to: {chain: 'Arc_Testnet', recipientAddress: string, useForwarder: true}, amount: string, config: {transferSpeed: 'FAST' | 'SLOW', batchTransactions: false}}}
 */
export function estimateParams(binding, adapter) {
  const {config, ...rest} = bridgeParams(binding, adapter);
  const {maxFee: _cap, ...quoteConfig} = config;
  return {...rest, config: quoteConfig};
}

// Bridge Kit has no minimum-output setting, so the cap is enforced twice: config.maxFee goes to the SDK,
// and the SDK's own fee estimate is checked here BEFORE any wallet prompt. If the live fees exceed what the
// customer approved, or any fee cannot be read exactly, nothing is signed. Network gas on Base is paid in ETH
// by the customer's wallet and is reported by the SDK separately, so it is not part of this USDC cap.
export function checkEstimate(binding, estimate) {
  const {amount, maxFee, minOutput} = approvedTerms(binding);
  if (!Array.isArray(estimate?.fees) || estimate.fees.length === 0) throw new SigningGatedError('The bridge returned no fee quote, so the approved quote cannot be honoured.');
  let total = 0n;
  for (const fee of estimate.fees) {
    if (fee?.error || fee?.token !== 'USDC' || !['provider', 'forwarder', 'kit'].includes(fee.type)) throw new SigningGatedError('The bridge returned a fee that cannot be checked, so nothing was signed.');
    const raw = parseUsdcRaw(fee.amount);
    if (fee.type === 'kit' && raw !== 0n) throw new SigningGatedError('The bridge added an application fee that you did not approve.');
    total += raw;
  }
  if (total > maxFee) throw new SigningGatedError(`The bridge fee is now ${units(total)} USDC, above the ${units(maxFee)} USDC you approved. Nothing was signed.`);
  if (amount - total < minOutput) throw new SigningGatedError('You would receive less than the minimum you approved. Nothing was signed.');
  if (estimate.amount !== undefined && parseUsdcRaw(estimate.amount) !== amount) throw new SigningGatedError('The bridge quoted a different amount than you approved.');
  const to = estimate.destination?.recipientAddress;
  if (to !== undefined && String(to).toLowerCase() !== binding.destination.address) throw new SigningGatedError('The bridge quoted a different recipient than you approved.');
  return {feesRaw: total, feesUsdc: units(total), outputRaw: amount - total, outputUsdc: units(amount - total)};
}

// A result handed to retry() must be the transfer the customer approved, in every respect that matters,
// and is checked before any wallet or SDK action. Another account, route, recipient, amount, speed or fee
// cap, a custom fee, or an already-completed transfer is refused.
export function assertResultMatches(binding, result) {
  const {speed, amount, maxFee} = approvedTerms(binding);
  const route = assertBindingRoute(binding);
  const bad = what => { throw new SigningGatedError(`This is not the transfer you approved (${what}). Nothing was retried.`); };
  if (!result || typeof result !== 'object') bad('missing result');
  if (result.token !== 'USDC') bad('token');
  if (result.state === 'success') throw new SigningGatedError('This transfer already completed. Nothing was retried.');
  if (result.state !== 'error' && result.state !== 'pending') bad('state');
  let resultAmount; try { resultAmount = parseUsdcRaw(result.amount); } catch { bad('amount'); }
  if (resultAmount !== amount) bad('amount');
  if (String(result.source?.address).toLowerCase() !== binding.source.address) bad('source account');
  if (result.source?.chain?.chain !== bridgeChains.source || result.source.chain.chainId !== route.source.chainId) bad('source chain');
  if (result.destination?.chain?.chain !== bridgeChains.destination || result.destination.chain.chainId !== route.destination.chainId) bad('destination chain');
  if (String(result.destination?.recipientAddress).toLowerCase() !== binding.destination.address) bad('recipient');
  if (result.destination?.useForwarder !== true) bad('delivery method');
  if (result.config?.transferSpeed !== speed) bad('speed');
  let cap; try { cap = parseUsdcRaw(result.config?.maxFee); } catch { bad('fee cap'); }
  if (cap > maxFee) bad('fee cap');
  if (result.config?.customFee && result.config.customFee.value !== undefined && String(result.config.customFee.value) !== '0') bad('custom fee');
  return true;
}

// Everything is injected: the Privy wallet, createAdapterFromProvider (Viem adapter, from the wallet's
// EIP-1193 provider) and a Bridge Kit instance. Building the signer performs no wallet or network call.
// Nothing here runs a transfer except execute(), which the caller may invoke only from the customer's own
// click on an Approve button.
/**
 * @param {{gate?: any, wallet: any, createAdapterFromProvider: any, kit: any}} options
 */
export function createCustomerBridgeSigner({gate = customerSigningGate, wallet, createAdapterFromProvider, kit} = {}) {
  if (!open(gate)) throw new SigningGatedError('Customer-wallet signing is gated. It needs reviewed dependencies, wallet permissions, custody setup and Privy configuration first.');
  if (typeof wallet?.getEthereumProvider !== 'function' || typeof wallet.switchChain !== 'function' || typeof createAdapterFromProvider !== 'function'
    || typeof kit?.bridge !== 'function' || typeof kit.estimate !== 'function' || typeof kit.retry !== 'function') {
    throw new SigningGatedError('Signing needs an injected customer wallet, a Viem provider adapter factory and a Bridge Kit instance.');
  }
  if (wallet.walletClientType !== 'privy') throw new SigningGatedError('Use the customer\'s own embedded wallet.');
  async function adapterFor(binding, {switchToSource = true} = {}) {
    if (String(wallet.address).toLowerCase() !== binding.source.address) throw new SigningGatedError('The connected wallet is not the source account you approved.');
    if (switchToSource) await wallet.switchChain(BASE_SEPOLIA_CHAIN_ID); // a wallet prompt, so only when signing
    return createAdapterFromProvider({provider: await wallet.getEthereumProvider()});
  }
  async function checkedEstimate(binding) {
    const estimate = await kit.estimate(estimateParams(binding, await adapterFor(binding, {switchToSource: false})));
    return {estimate, ...checkEstimate(binding, estimate)};
  }
  return Object.freeze({
    mode: 'customer-wallet',
    // Quotes the live fees and refuses (throws) if they are beyond what the customer approved.
    async estimate(approval) { return checkedEstimate(await verifyApproval(approval)); },
    // Estimate first, fail closed, and only then prompt the wallet (chain switch, approve, burn).
    async execute(approval) {
      const b = await verifyApproval(approval);
      await checkedEstimate(b);
      return kit.bridge(bridgeParams(b, await adapterFor(b)));
    },
    // Resumes from the failed step; a completed burn is not repeated. RetryContext.to is optional for
    // forwarder-only destinations in the SDK types, so only the source adapter is passed.
    async retry(approval, result) {
      const b = await verifyApproval(approval, {resume: true});
      assertResultMatches(b, result); // before the wallet or the SDK is touched
      return kit.retry(result, {from: await adapterFor(b)});
    },
  });
}
