# Wallet setup and live quote flow

2 November 2026. Built from release `96807b710a098b57dc8167ea64c95853d0c13e8c`.

## Delivered code and default state

Wallet & quotes now exposes a clearly labelled Wallet setup & live quotes entry. The separate `/buyer-wallet-flow` route joins the existing Privy authentication, wallet observer, durable setup permission and personalised direct Peer quote components. Samples remain separate. The route is hidden with HTTP 404 unless the approved-account development gate and all authentication gates are enabled. Ordinary customers see an explanatory access card, not an active creation button.

This deployment does not enable flags, install secrets, create an identity or wallet, change customer records, provision the claim database or contact Peer with customer addresses. The existing merchant checkout and its payment configuration remain unchanged. Direct Peer estimates are not merchant checkout offers and cannot create payments through this flow.

## Flow

1. Explicit connection consent precedes loading the Privy SDK. Automatic Ethereum and Solana wallet creation remains off; external wallet and automatic migration features stay off.
2. The server verifies the current Eupova session, restricted enrolment, Privy access token, identity and wallet inventory. A single supported unpinned wallet can be shown as a candidate, but does not unlock quotes. The old authentication-only route still rejects an unexpected wallet.
3. Creating a wallet needs a separate server capability, a fresh verified empty inventory, a current recovery/export review, a dedicated restricted claim database with a reviewed durability topology, a short lease and an explicit user action. The server commits a permanent one-use attempt before the SDK is called. Unknown outcomes never grant another attempt.
4. Personalised quotes require a separately approved and pinned buying address. Receiving choices use an exact-owner SELECT-only query. The user checks both addresses and consents to sharing them with Peer. Changing a receiving wallet or losing access clears prices and consent.
5. Quote selection is revalidated using current server evidence. The screen can review a funding plan; it cannot pay, sign a transaction or create a checkout. Expired, changed or unavailable offers must be rechecked.

## Separately controlled activation

Do not turn these on as part of a code deployment. Each restricted test requires current user authority and a bounded enrolment (maximum 30 minutes). The previous temporary test is not continuing authority.

- `EUPOVA_BUYER_WALLET_FLOW_DEV_ENABLED` plus the existing wallet-auth, buyer-auth and buyer-auth-token development switches govern access.
- Creation additionally needs matching `EUPOVA_WALLET_SETUP_TEST_ENROLLMENT`, `EUPOVA_WALLET_SETUP_OBSERVE_ENABLED`, `EUPOVA_WALLET_SETUP_CLAIMS_ENABLED`, current recovery evidence and `EUPOVA_WALLET_FLOW_SETUP_LEASE_ID`.
- `EUPOVA_WALLET_SETUP_DATABASE_URL` must use a **separate least-privilege runtime login**. Hosted startup never passes the main customer database writer to the claim service. Manual schema, role, control and lease preparation in `privy-wallet-durable-guard.md` must be completed and verified separately. Startup applies no schema or migration.
- Quote access additionally needs `EUPOVA_PERSONALISED_QUOTE_DEV_ENABLED`, matching personalised-quote enrolment and the verified pinned buying address. Creating a wallet does not automatically pin it or enable quotes.
- The effective session lifetime is capped at the fixed enrolment expiry. A routine idle-session renewal does not invalidate the flow; revocation, identity change or shortening the effective lifetime does.

## Verification and limitations

Offline tests cover disabled-before-read guards, old-route isolation, candidate-wallet restrictions, account and session changes, role/capability separation, acknowledged claim commits and uncertain outcomes. Isolated browser checks use fake SDK and server responses; they are not evidence of a real wallet being created. No new live wallet or personalised quote request is performed during release checks.

Previously recorded upstream SDK advisory families remain unresolved. The deployment does not establish real recovery/export readiness, claim database durability, provider eligibility or quote availability for every payment method. Complete those checks in a separately authorised restricted test before creating one buying wallet. A later payment/signing step needs its own authority.

## Rollback

Retain the newer already-live baseline `61a34ca9fbbff2b008b56e7a7d81740ce05196fc` and its successful Render deployment `dep-dbkepkjl550s73e87l70`. Its tracking improvements are preserved in this release. Roll back code using that exact commit; no data restore or payment-setting change is needed for this release. If setup is enabled in a future test, disable issuance and claims first and preserve all consumed claims across rollback. A created wallet cannot be undone by rolling back Render.
