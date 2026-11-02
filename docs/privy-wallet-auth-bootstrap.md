# Buying-wallet authentication check

Status: baseline 4ce5433 was deployed and its restricted test failed at an unknown stage. The diagnostic revision is local, remains disabled by default and has not been deployed or activated.

## Purpose

`/buyer-wallet-auth-test` is a separate development page for recognising the approved account and either an empty wallet inventory or exactly one approved embedded Ethereum buying address. It reuses the existing account's opaque custom-auth subject and pinned Privy DID. It does not create or save a wallet, sign a transaction, request a price, or start a payment.

The existing `/buyer-connection-test` still rejects every wallet. Its client, SDK wrapper, entry page and server handler are unchanged. These screens share the Privy development identity, so a future wallet on that identity will correctly make the old authentication-only test reject it. Separate screens do not create separate provider identities or wallet authorisation scopes.

## Prepared components

- `server/quote-first/wallet-bootstrap-http.mjs`: purpose-specific status, token and verification endpoints; strict secure-cookie, HTTPS, host, Origin and fetch-site checks; consent and context required on POST; bounded body; request rate limits.
- `src/wallet-bootstrap-client.mjs`: separate lifecycle with explicit consent, stable cached JWT and single-flight refresh, bounded operations, cancellation generations, final permission rechecks and recognition expiry.
- `src/PrivyWalletAuthSdk.jsx`: delayed SDK mounting after consent; Ethereum and Solana automatic creation off; automatic migration and external connectors off. Only authentication and access-token methods are used.
- `src/wallet-auth-entry.jsx`: established mint, jade and lavender styling; no wallet creation or payment controls.
- Hosted startup calls the configured handler. Disabled routes return 404 before secret, database or provider reads. Public static routing cannot serve the HTML filename directly.

## Evidence and limits

Verification reads the current user's inventory through the existing fixed-host GET-only server client. Privy access tokens must match the app, issuer, ES256 verification key and pinned DID. Exactly one custom-auth identity must match the enrolled subject. A present wallet must be the exact expected address, embedded Ethereum, non-imported, non-delegated and explicitly user-signable. Unknown account types, missing fields and ambiguity reject the check.

Before and after upstream awaits, the full read-only session/enrolment snapshot is rechecked. No rolling session touch or customer write occurs. Outputs carry `canQuote=false`, `canCreateWallet=false` and `canCreatePayment=false`. The proof is a display-only observation, not a permit. Its lifetime is at most 15 seconds and never beyond the session, access token or enrolment expiry. Expired evidence is cleared; renewal requires Check again. Periodic checks only validate local permission, not automatically renew inventory evidence.

The frontend rejects identity or wallet changes and clears state on cancellation, failed checks, logout broadcasts, page exit or expiry. Late responses cannot restore it. SDK-managed browser session storage still exists during a real Privy login; Eupova stores no JWT or access token in its own persistent storage, URL, diagnostics or React state. Logout failure remains visible.

The same custom JWT is returned while valid because the installed SDK compares tokens during synchronisation. Returning undefined on every second callback would regress the earlier unexpected-disconnection fix. Server context checks still occur before returning a cached JWT.

A session change after the final read, a malicious client calling Privy directly, or an already-issued token cannot be atomically revoked by this display. JWTs remain bounded to 60 seconds, and all later quote/creation operations must independently enforce their own server checks. This module does not grant those capabilities or call the durable wallet-creation guard.

## Activation prerequisites (not performed)

All of these remain separate from this build:

1. Confirm the Privy read-only credential's access level and the real API response fields without exposing the credential. Older full-access keys must not be used for the reader.
2. Verify the real app's access-token public keys and returned claims. Official docs currently contain an inconsistent Ed25519 sentence beside ES256; retain the tested ES256/P-256 verifier and verify actual key material before enabling.
3. Prepare an absolute, at-most-30-minute development enrolment for the already-approved customer, retaining its existing opaque subject and pinned DID. The expected address is null for the empty-account test; it is never guessed or accepted from the browser.
4. Check SDK/dashboard automatic-wallet-creation settings, recovery/re-entry evidence and outstanding SDK advisories. No live settings were inspected or changed in this task.
5. Record the real Render release and settings before any future deployment, then separately authorise and time-limit activation. Use the existing matching signing key, never a new identity namespace.

Feature flags: `EUPOVA_WALLET_AUTH_DEV_ENABLED`, `EUPOVA_BUYER_AUTH_DEV_ENABLED`, and `EUPOVA_BUYER_AUTH_DEV_TOKEN_ENABLED` must all be explicitly true. The new flag is absent/off by default. Enrolment is separately configured via `EUPOVA_WALLET_AUTH_TEST_ENROLLMENT`. Existing development app, signing-key pin, public access JWKS and asserted read-only credential must all validate. Setting a flag alone is insufficient. No environment values were installed.

## Validation and recovery

Tests use sample identities, ephemeral sample keys and fake provider responses. The isolated headless browser replaces the Privy SDK with a fixture and rejects every external URL. This proves our UI lifecycle, not a real provider handshake.

The baseline is b963306924fcd84d34bbf6aca06ed6ff68252c48. No schema migration accompanies this change. Keep the old checkout to recover the local build. A future operational rollback must also disable the new flag/token issuance; reverting code alone does not revoke already-issued provider sessions.


## Diagnostic revision — 2 November 2026

The next restricted test reports fixed stage/reason values for access, token issuance, provider sign-in, client identity, server access-token validation, wallet read, wallet match and final proof. No raw exceptions, provider responses, credentials, account IDs or addresses appear in diagnostics. The server rechecks the same authorised development session/enrolment before releasing failure details; ordinary users and disabled routes still receive generic responses. No diagnostic log endpoint or persistent customer write was added.

SDK callback order matters: its onAuthenticated callback precedes the user/authenticated state commit. The controller now requires both a current authentication callback and matching observed state. A callback alone cannot start the server wallet check.

A resolved SDK logout promise does not prove remote logout. The installed SDK catches remote destroy errors and clears local state. This revision observes ready=true, authenticated=false and user=null for one second, with no pending JWT exchange, before reporting browser disconnect. Late SDK completions remain incapable of issuing tokens or producing wallet proof and trigger bounded local cleanup. Failures expose Retry disconnect. Remote session revocation always remains unconfirmed; this page cannot prove it.

The original live failure root cause is still unknown. This revision fixes misleading disconnect confirmation and exposes the stage for another separately authorised test. All existing identity, signature, consent, origin, expiry and disabled-feature checks remain. There is no wallet, payment or checkout capability.

Primary reference: https://docs.privy.io/authentication/user-authentication/jwt-based-auth/usage
Installed implementation inspected: @privy-io/react-auth 3.51.0 (custom JWT synchronisation and session destroy). Existing upstream SDK advisory families remain unchanged; no dependency upgrade was included.
