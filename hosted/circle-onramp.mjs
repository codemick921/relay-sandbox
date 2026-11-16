// Circle Onramp (App Kit) for customer accounts: buy USDC with a card or bank transfer, delivered to a wallet the customer already saved.
//
// SANDBOX ONLY in this release. The browser never sees the Circle API key: this module mints a short-lived checkout session on the server and
// returns only that session. The receiving address is never taken from the browser. The browser names one of the customer's own saved
// wallets (by id); the address comes from the saved record, so a request cannot redirect funds to another address.
//
// Nothing here changes the Peer, Ramp or wallet flows, and it adds no frame or connect origin to the page policy: the checkout opens in a
// separate window.
import {InputError,address} from '../server/validation.mjs';

// Exact sandbox origins from Circle's documentation. A production origin or a mainnet key is refused on purpose: going live is a separate,
// deliberate step (mainnet key, Circle business verification, review) and must not happen through an environment variable by accident.
export const ONRAMP_SANDBOX = Object.freeze({baseUrl: 'https://api-test.circle.com', widgetBaseUrl: 'https://onramp-sandbox.arc.io'});
// The saved wallets are Base wallets. Funds are scoped to USDC on Base so a purchase cannot be sent to a network the wallet is not set up for.
export const ONRAMP_ASSETS = Object.freeze({tokens: ['USDC'], chains: ['base']});

const uuid = v => typeof v === 'string' && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(v);

// Returns null when the feature is not configured. Throws on a configuration that must never be accepted.
export function circleOnrampConfig(env = process.env) {
  const apiKey = env.EUPOVA_CIRCLE_ONRAMP_API_KEY;
  if (!apiKey) return null;
  if (env.EUPOVA_CIRCLE_ONRAMP_ENV && env.EUPOVA_CIRCLE_ONRAMP_ENV !== 'sandbox') throw new Error('Circle onramp supports the sandbox only in this release.');
  if (!/^TEST_API_KEY:[^\s:]{1,256}:[^\s:]{1,256}$/.test(apiKey)) throw new Error('Circle onramp needs a Circle testnet API key.');
  return {apiKey, ...ONRAMP_SANDBOX};
}

export function createCircleOnramp({store, server}) {
  return Object.freeze({
    environment: 'sandbox',
    widgetBaseUrl: ONRAMP_SANDBOX.widgetBaseUrl,
    async createSession(owner, input) {
      if (typeof owner !== 'string' || !owner.startsWith('customer:')) throw new InputError('Customer sign-in required.', 403);
      if (!input || Object.keys(input).some(k => k !== 'agentId') || !uuid(input.agentId)) throw new InputError('Choose one of your saved wallets.');
      await store.rate('circle-onramp:' + owner, 10, 60);
      const customer = (await store.query('SELECT 1 FROM relay_customers WHERE id=$1 AND NOT disabled AND NOT setup_pending', [owner.slice(9)])).rows[0];
      if (!customer) throw new InputError('Customer sign-in required.', 403);
      const agent = (await store.query('SELECT data FROM relay_agents WHERE owner=$1 AND id=$2', [owner, input.agentId])).rows[0]?.data;
      if (!agent || agent.network !== 'Base' || agent.token !== 'USDC') throw new InputError('Choose your saved Base USDC wallet.');
      const destinationAddress = address(agent.address);
      try {
        // appUserId is the opaque internal account id: stable for the customer, no email or other personal data.
        return await server.onramp.createSession({appUserId: owner, destinationAddress, assets: {tokens: [...ONRAMP_ASSETS.tokens], chains: [...ONRAMP_ASSETS.chains]}});
      } catch {
        throw new InputError('The checkout could not be started. Try again shortly.', 502);
      }
    },
  });
}

// Wiring used at startup. An unset key leaves the feature off; a rejected configuration logs a reason (never the key) and leaves it off.
export async function configuredCircleOnramp({store, env = process.env, loadKit = () => import('@circle-fin/app-kit/server'), log = m => console.error(m)}) {
  let config;
  try { config = circleOnrampConfig(env); } catch (e) { log('Circle onramp disabled: ' + e.message); return null; }
  if (!config) return null;
  try {
    const {createAppServerKit} = await loadKit();
    return createCircleOnramp({store, server: createAppServerKit({onramp: {apiKey: config.apiKey, baseUrl: config.baseUrl, widgetBaseUrl: config.widgetBaseUrl}})});
  } catch {
    log('Circle onramp disabled: the App Kit server module could not be loaded.');
    return null;
  }
}
