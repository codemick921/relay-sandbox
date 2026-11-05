// Providers for Arc funding. Customer-controlled custody model.
//
// "The customer approves transfers in their wallet." Eupova holds no keys and has no signing
// authority, so this server module contains NO bridge or wallet-creation adapter that could move
// funds: the only provider is the simulated one. Real wallet creation and real signing happen in
// the customer's browser through their own wallet; the gated browser integration is in
// src/arc-customer-signing.mjs and the activation steps are in docs/arc-agentic-wallets.md.
import {randomBytes} from 'node:crypto';
import {settledFigures} from '../shared/arc-funding.mjs';

export class ProviderGatedError extends Error {
  constructor(message) { super(message); this.name = 'ProviderGatedError'; this.status = 403; }
}

// Always closed in this build. Opening it takes a code change after review of the browser signing
// dependencies, the wallet permissions and the customer-controlled custody setup.
export const closedProviderGate = Object.freeze({approved: false, reviewed: Object.freeze({dependencies: false, permissions: false, custody: false})});

export function createSimulatedProviders() {
  return Object.freeze({
    mode: 'simulated',
    custody: 'customer-controlled',
    wallet: Object.freeze({
      mode: 'simulated',
      // Stands in for the customer's own wallet. Recognisable synthetic address (0x51ed prefix);
      // it exists on no network and no key exists for it anywhere.
      provision: () => ({providerRef: 'sim-' + randomBytes(6).toString('hex'), address: '0x51ed' + randomBytes(18).toString('hex')}),
    }),
    // Stands in for the customer approving in their wallet. It records a decision and returns no
    // signature, because none exists.
    approval: Object.freeze({mode: 'simulated', signature: () => null}),
    bridge: Object.freeze({mode: 'simulated', settle: quote => settledFigures(quote)}),
  });
}
