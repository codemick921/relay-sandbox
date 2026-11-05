// Production wiring for the customer wallet. Reads the deployment configuration, validates it field by field, and either
// returns a live wallet or returns nothing and says why. There is no reviewer flag and no fallback to the simulation:
// missing or inconsistent configuration means the wallet is simply not offered, and the log names exactly what to fix.
import {walletConfigFromEnv, validateWalletConfig, createCircleUserControlledProvider, walletEnvNames} from './wallet-providers.mjs';
import {createCustomerWallet} from './customer-wallet.mjs';
import {createCctpUcwTransport} from './wallet-bridge-transport.mjs';

export async function configuredCustomerWallet({store, env = process.env, loadSdk = () => import('@circle-fin/user-controlled-wallets'), log = m => console.error(m)}) {
  const config = walletConfigFromEnv(env);
  const check = validateWalletConfig(config);
  if (!check.requested) return {wallet: null, status: {enabled: false, reason: 'off'}};
  if (!check.ready) {
    // Names and reasons only, never values.
    log(`Customer wallet is NOT started. Fix: ${check.problems.map(p => `${p.env} (${p.why})`).join('; ')}`);
    return {wallet: null, status: {enabled: false, reason: 'misconfigured', problems: check.problems.map(p => p.env)}};
  }
  let sdk;
  try { sdk = await loadSdk(); } catch {
    log('Customer wallet is NOT started: the @circle-fin/user-controlled-wallets package is not installed.');
    return {wallet: null, status: {enabled: false, reason: 'misconfigured', problems: ['@circle-fin/user-controlled-wallets']}};
  }
  const provider = createCircleUserControlledProvider({config, sdkFactory: c => sdk.initiateUserControlledWalletsClient(c)});
  // The Base to Arc move uses the SAME provider (the customer's own wallet and PIN). Optional https RPC overrides are validated; a bad one
  // means the move is not offered (the wallet itself is unaffected). The defaults are the endpoints in Circle's Bridge Kit chain data.
  const rpcUrls = {};
  for (const [kitId, name] of [['Base', 'EUPOVA_BRIDGE_BASE_RPC_URL'], ['Base_Sepolia', 'EUPOVA_BRIDGE_BASE_RPC_URL'], ['Arc', 'EUPOVA_BRIDGE_ARC_RPC_URL'], ['Arc_Testnet', 'EUPOVA_BRIDGE_ARC_RPC_URL']]) {
    const v = env[name]; if (v === undefined || v === '') continue;
    if (!/^https:\/\/[^\s]+$/.test(v)) { log(`The Base to Arc move is NOT offered: ${name} must be an https URL.`); rpcUrls.invalid = true; break; }
    rpcUrls[kitId] = v;
  }
  const bridgeTransport = rpcUrls.invalid ? null : createCctpUcwTransport({provider, rpcUrls});
  const wallet = createCustomerWallet({store, provider, config, bridgeTransport});
  await wallet.migrate();
  log(`Customer wallet started on ${check.network.label} (${config.accountType} accounts, ${config.gasModel === 'sponsored' ? 'sponsored' : 'wallet-paid'} network fees).`);
  return {wallet, status: {enabled: true, reason: 'live'}, env: walletEnvNames};
}
