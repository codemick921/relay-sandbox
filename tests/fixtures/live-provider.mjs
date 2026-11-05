import {WALLET_NETWORKS} from '../../shared/wallet-model.mjs';

export const ETH = 10n ** 18n;
// A provider shaped like the live one (non-simulated, ETH fees, challenge-based) with every answer under test control.
export function liveProvider(netId, st) {
  const network = WALLET_NETWORKS[netId];
  return {
    id: 'circle_ucw', live: true, simulated: false, mode: network.environment, label: 'Live-shaped test provider', custody: 'The customer holds the key.', network,
    feeModel: {asset: st.feeAsset ?? 'ETH'},
    wallets: new Map(),
    async beginWalletSetup() { st.calls.push('setup'); return st.initialized ? {alreadyInitialized: true} : {challengeId: 'setup-1', appId: 'app', userToken: 'SECRET-USER-TOKEN', encryptionKey: 'SECRET-KEY'}; },
    async findWallet(o) { return st.wallets[o] ?? null; },
    async balance(o) { if (st.balanceError) throw new Error('down'); return String(st.usdc[o] ?? 0); },
    async nativeBalanceWei(o) { return String(st.eth[o] ?? 0n); },
    async resolveUsdcTokenId() { if (st.tokenError) throw new Error('down'); return st.tokenId ?? 'tok-usdc'; },
    async estimateFee() { if (st.feeError) throw new Error('down'); return st.fee; },
    async executeTransfer(p) { st.calls.push({exec: p}); if (st.execError) throw new Error('crash'); return {state: 'pending_challenge', challengeId: 'pay-' + st.calls.length, tokenId: 'tok-usdc', appId: 'app', userToken: 'SECRET-USER-TOKEN', encryptionKey: 'SECRET-KEY'}; },
    async resumeSession() { return {appId: 'app', userToken: 'SECRET-2', encryptionKey: 'SECRET-KEY-2'}; },
    async history() { return st.history ?? []; },
    async findTransaction(q) { st.calls.push({find: q}); return typeof st.found === 'function' ? st.found(q) : st.found; },
  };
}
export const FEE = {asset: 'ETH', gasLimit: '65000', maxFee: '2.5', priorityFee: '0.1', maxFeeNativeWei: String(ETH / 1000n)}; // 0.001 ETH
