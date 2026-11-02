# Native Privy sign-in and account links

This release installs a separate native email-code/passkey sign-in and account-linking path at `/buying-wallet-connect`, reachable from Wallet & quotes. The existing Eupova login and custom-auth development flow remain intact. Nothing is enabled by default. Deployment does not send codes, link identities, create wallets, sign, fetch personalised quotes or create checkouts.

## Enable only after configuration review
Use a separate Privy app with native email/passkey enabled and its Free eligibility confirmed in the dashboard. Do not disable custom auth in the existing development app. Exact allowed origin: https://app.eupova.com. Automatic Ethereum/Solana wallet creation, external connectors and additional signers stay off.

Required deployment secrets/settings: EUPOVA_PRIVY_NATIVE_ENABLED (default false), EUPOVA_PRIVY_NATIVE_APP_ID (must differ from existing custom-auth app), EUPOVA_PRIVY_NATIVE_PUBLIC_JWKS (public ES256 verification keys), EUPOVA_PRIVY_NATIVE_READONLY_SECRET, EUPOVA_PRIVY_NATIVE_CREDENTIAL_ACCESS=read-only, EUPOVA_PRIVY_NATIVE_DATABASE_URL (dedicated restricted PostgreSQL credentials). Never put secrets in a frontend build variable. No key is included in this release.

Apply migrations/manual/native-privy-links.sql separately to the designated registry database after review. It is intentionally absent from startup migrations. Use a dedicated role with USAGE on eupova_native_auth, SELECT/INSERT on links, SELECT/INSERT and UPDATE(did,sid_hash,fingerprint,address,consumed_at) on intents. No ownership, schema CREATE, table DELETE, link UPDATE or customer/payment write privileges. Pin a matching least-privilege database role and verify actual grants before activation. Existing customer/payment rows are never copied or rewritten by this migration.

## Linking
The server verifies the current active/verified Eupova session with SELECT-only reads and a Privy ES256 access token (issuer, audience, expiry, DID/session). It fetches fresh Privy inventory using a read-only credential. A five-minute, random, single-use review intent is bound to the local session, Privy identity/session and wallet fingerprint. A masked email hint is returned for review, never used to associate accounts and never stored in the link table.

Explicit confirmation atomically consumes the reviewed intent and inserts a unique (app, Eupova owner)/(app, Privy DID) association. The registry has no unlink/reassign endpoint. Session or inventory changes, replay, concurrent attempts and wrong identity fail closed. Existing links are retained on browser logout. Commit acknowledgement loss is reported as unavailable; the next status read reconciles the saved link instead of claiming success.

## Recovery checks
A fresh server lookup must match the saved identity and wallet fingerprint. A different Privy session ID demonstrates a new sign-in, not proof of a cleared-browser recovery or key export. No wallet reports no_wallet, never recovered. Missing, multiple, imported, delegated, external or changed wallets require review. Access checks expire after at most 15 seconds. No creation or signing SDK method is imported.

An identity linked while no wallet exists cannot silently acquire a different wallet fingerprint. Future explicit wallet setup will need a separate consented binding step; this release intentionally does not implement it. Similarly, this flow does not yet route native links into personalised quotes.

The current TEE design uses reauthentication rather than user-managed cloud recovery. Before enabling real wallet setup, test fresh browser/device, blocked storage, expired and revoked sessions, two-tab account changes, and user-controlled export without observing private key material. Passkey sign-in is supported for existing passkeys; passkey enrolment, wallet MFA enforcement and export are separate activation work. This release makes no claim those operations have passed.

## Rollback
Pre-release baseline: commit 16aa92fc303fb70a6691b8a60b6246439b0c609f, Render dep-dbkfj9qfngtc73f5h4cg. Restore its retained build through Render rollback, or deploy that exact commit. Keep native flags off. No live migration is applied by this release, so code rollback needs no database restore. If activated later, preserve links and consumed intents; code rollback cannot undo external identities/wallets. A database restore must disable new links/setup until durable state is reconciled.

## Verification
Run npm run test:offline, npm run build and scripts/test-native-privy-browser.mjs (sample SDK only, external requests blocked). Hosted CI also runs the linking suite on native PostgreSQL using disposable TEST_DATABASE_URL. Never supply a production database URL to tests.
