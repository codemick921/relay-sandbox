// Base -> Arc routes for the customer wallet. Every value below is copied from Circle's Bridge Kit chain data (1.17.0) and
// pinned by a test that compares it with the installed kit, so a drift fails the build. Nothing is guessed.
// Mainnet and testnet are separate routes and are never mixed: a Base wallet can only bridge to the Arc of the same environment.
export const BRIDGE_ROUTES = Object.freeze({
  mainnet: Object.freeze({
    environment: 'mainnet', label: 'Base to Arc (mainnet, real money)',
    source: Object.freeze({networkId: 'base', kitId: 'Base', chainId: 8453, domain: 6, circleChain: 'BASE', usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', tokenMessenger: '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d', messageTransmitter: '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64', rpc: 'https://mainnet.base.org'}),
    destination: Object.freeze({label: 'Arc', kitId: 'Arc', chainId: 5042, domain: 26, circleChain: 'ARC', usdc: '0x3600000000000000000000000000000000000000', messageTransmitter: '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64', rpc: 'https://rpc.mainnet.arc.io/', forwarderDestination: true}),
  }),
  testnet: Object.freeze({
    environment: 'testnet', label: 'Base Sepolia to Arc Testnet (test network)',
    source: Object.freeze({networkId: 'base_sepolia', kitId: 'Base_Sepolia', chainId: 84532, domain: 6, circleChain: 'BASE-SEPOLIA', usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', tokenMessenger: '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA', messageTransmitter: '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275', rpc: 'https://sepolia.base.org'}),
    destination: Object.freeze({label: 'Arc Testnet', kitId: 'Arc_Testnet', chainId: 5042002, domain: 26, circleChain: 'ARC-TESTNET', usdc: '0x3600000000000000000000000000000000000000', messageTransmitter: '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275', rpc: 'https://rpc.testnet.arc.io', forwarderDestination: true}),
  }),
});

export const routeForNetwork = networkId => Object.values(BRIDGE_ROUTES).find(r => r.source.networkId === networkId) ?? null;
export const BRIDGE_LIMITS = Object.freeze({maxAmountUsdc: '1000', openPerWallet: 3});
