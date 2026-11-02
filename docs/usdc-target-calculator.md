# USDC target calculator

A read-only direct Peer quote comparison. It does not create payments, checkouts, wallets, intents or Privy sessions.

## Default state
Disabled unless EUPOVA_TARGET_CALCULATOR_ENABLED=true. No production setting is changed by this release. Existing payment flags, merchant behaviour and customer schemas remain unchanged. When enabled, verified signed-in customers can open it from Funding options. The quote endpoint uses SELECT-only customer authentication and persisted rate counters.

## Public evidence
Uses the documented POST /v3/quote/exact-token endpoint at api.zkp2p.xyz, example buyer/recipient addresses, Base native USDC, no API keys. Customers must not interpret these estimates as personal eligibility or reserved offers.

Current docs allow public quotes with maker identity omitted; published SDK 0.14.11 still filters these. The HTTP adapter intentionally avoids importing wallet SDK code. It checks the exact asset, target, currency, method, approved contracts, gross/net and fee arithmetic, rate and expiry.

Quotes expire locally after 60 seconds or provider expiry, whichever is earlier. Input changes discard the old result. Refresh compares a fingerprint of economic terms. Fiat estimates round upward to the currency minor unit. Unknown spread/bank charges are not fabricated. Internally inconsistent offers are withheld.

The current merchant checkout is a different route and its price is not bound to these direct quotes. No Pay action is supplied in this calculator.

## Validation
Run npm run test:offline and npm run build. The focused tests use saved public sample responses; no live customer data is used. Start the isolated preview with node scripts/preview-target-calculator.mjs on port 4406. Preview application actions are blocked; public quote reads are enabled only in its Live scenario. Other scenarios are explicitly labelled fabricated samples.

## Rollback
Disable EUPOVA_TARGET_CALCULATOR_ENABLED and restart, or redeploy pre-change commit d0e67a37f98a9c51bc5c7e50a9ae90a5c6a08d3c (deployment dep-dbk6a42jnfac739nghi0). No database rollback is needed.
