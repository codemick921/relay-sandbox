# Relay hosted sandbox

Private test deployment: Render Starter web service, Starter worker and 256 MB PostgreSQL in Frankfurt. Sandbox only; no real payments or wallet transfers. Server binds Render's PORT and serves the built React app. The separate worker independently checks Peer after signed webhooks and on a periodic schedule.

## Configuration

Use render.yaml. Supply the existing Peer sandbox API key, sandbox merchant ID and webhook secret as secret environment values. Never commit credentials. SANDBOX_TESTERS is a JSON array of {label,sha256hex}; each tester uses a unique random code whose SHA-256 hash is stored here. Codes are shared privately. Changing a hash revokes that tester's sessions. No live keys are permitted. PUBLIC_ORIGIN defaults to RENDER_EXTERNAL_URL.

The database has no public IP access, 1 GB storage, and storage autoscaling disabled. Automatic deployment is off. Verify tests before deploying a new commit; deploy both web and worker. Keep the workspace on Hobby and review current charges before creation.

## Validation and operation

npm test uses an embedded PostgreSQL-compatible engine locally. Set TEST_DATABASE_URL to a disposable real PostgreSQL database to enable concurrent-worker tests. GitHub CI starts PostgreSQL 18 and runs the full suite plus the frontend build. Tests create and remove only randomly named schemas in that database.

GET /healthz confirms database reachability. Authenticated /api/state includes worker heartbeat health. Never interpret sandbox_complete as on-chain delivery. Live, practice, RPC proxy and browser-signing endpoints are absent from the hosted server.

Point the existing Peer SANDBOX webhook to https://YOUR_RENDER_HOST/api/webhooks/peer/sandbox only after health and authentication checks pass. Test its delivery, then create and complete a sandbox checkout and verify the worker's independently read status. Preserve the old webhook URL for rollback. Do not create duplicate subscriptions.

Order intents are immutable and persisted before remote creation. Uncertain creation is not automatically repeated: a signed webhook carrying the local order ID can locate the original remote order, which is independently validated. Without that evidence, the order remains held for operator reconciliation. A replay may not recover a private checkout link. Do not delete held orders or create replacements until reconciliation.

Both processes use leased jobs and generation checks; stale workers cannot overwrite newer results. Provider failures retain the last verified state and back off. Signed events are deduplicated by signed event ID and body digest; delivery headers do not establish identity.

## Recovery limits

The Mac's historical JSON sessions are not imported. Hosted data is separate. Source rollback is by redeploying a verified commit compatible with schema version 1; do not drop the database. This initial schema migration is additive. Render database backup availability and retention must be checked in the deployed account before relying on it. The prototype is not approved for public live-money use.

## Tracking sandbox release (24 October 2026)

Hosted entrypoints now start the persistent simulated tracker and require the existing tester sign-in. Real payment creation and all outgoing Peer reads are hard-disabled in this release. No new API keys or permissions are needed. Existing Peer sandbox environment values may remain saved but are unused by the running web/worker path; the existing incoming sandbox webhook route returns a disabled response. Do not run operator payment or webhook scripts while the no-contact instruction applies.

The additive `relay_tracking_sandbox_v1` PostgreSQL schema holds generated examples separately from saved sandbox agents, orders and authentication sessions. Four examples are created once per configured tester; startup and redeploy do not reset their status. HTTP responses and receipt panels label this evidence as simulated. No customer wallet data is used to generate the examples. Manual refresh queues an existing synthetic order and the background worker supplies its result. Existing sandbox history stays readable but cannot create or resume a provider checkout.

Release via the existing private repository, verify the exact commit with PostgreSQL18 CI, deploy the worker first, then the web service. Keep auto-deploy off and retain the same resource plans. Check `/healthz` for the exact release SHA, disabled payments/provider connections and simulated tracking, then verify sign-in, owner isolation, preserved history and receipt access.

Rollback must preserve the no-contact restriction: do not blindly redeploy the older provider-polling worker. Prefer a corrected release that keeps both payment/provider gates disabled. The new schema is additive and must not be dropped during an ordinary rollback; preserve saved records and tester sessions.

## Customer accounts (24 October 2026)

The disabled-payment runtime now offers email/password customer accounts in addition to the separate tester-code entry. Migration2 adds relay_customers and relay_customer_sessions without changing tester records. Owners use customer:<UUID>; no email or name can claim another workspace. New customers start empty and can save up to five Base wallet addresses. Wallet ownership remains self-declared.

Passwords use salted scrypt-v1 (N32768/r8/p3, 32-byte output), with a maximum of two active hashing jobs. Sessions use random 256-bit tokens, hashed at rest, 12-hour absolute and 2-hour idle expiry, Secure/HttpOnly/SameSite cookies. Password change and single-use recovery rotate the recovery code and revoke other sessions. Recovery codes are shown once, never logged or persisted in browser storage. DB-backed global/per-account attempt limits remain deliberately restrictive for this small sandbox.

Email addresses are unverified sign-in names. There is no email delivery, email recovery, identity verification, MFA or live-payment activation. Do not use email alone as an ownership or support-recovery proof. Before customer production launch, connect verified email/authentication, broaden breached-password screening and abuse controls, validate backups/recovery and review the authentication security. Keep all existing payment/provider gates disabled. Do not copy customer records, passwords or recovery codes into deployment exports or logs.

Verify signup, saved-wallet persistence, logout/login, account isolation, recovery code single-use and old-session revocation. Existing tester records must remain readable. A source rollback must retain customer tables and records; the previous release will hide customer access until a compatible release is restored.

## Account emails (built locally; delivery remains off)

Email verification and password reset use migration 3, which adds a verification timestamp and a durable email queue without changing existing accounts, sessions or saved wallets. Both services may apply the idempotent migration on startup. The web service queues requests; the worker processes them. Tokens are random, stored only as hashes, single-use and bound to the account's credential version. Verification links expire after one hour; password reset links after 20 minutes. Links use a URL fragment, are removed from the address bar when opened, and require an explicit POST. Verification also requires sign-in to the matching account.

Email-based recovery is available only after the address was verified. Existing unverified accounts retain their saved recovery code; an emailed reset cannot take over an unverified account. A reset revokes every old session and recovery code, preserves wallets and creates a new recovery code. Unknown, unverified and disabled email addresses receive the same reset-request response. Requests are rate-limited and email sends are processed outside the HTTP response.

Default: `ACCOUNT_EMAIL_ENABLED` is absent or `false`. No email requests leave the service, and the screens explain that recovery codes remain necessary. Keep `RELAY_PAYMENTS_DISABLED=true` and the existing simulated tracking configuration. Email settings do not enable payments or Peer access.

The optional Resend adapter is prepared but has not been connected or tested with a real inbox. Future activation needs the same `ACCOUNT_EMAIL_ENABLED=true`, `ACCOUNT_EMAIL_FROM=Relay <accounts@your-domain>`, `RESEND_API_KEY` and HTTPS `PUBLIC_ORIGIN` on web and worker, plus a verified sender at the provider. Credentials belong in private environment settings only. Do not activate until the user resumes sender setup. Confirm provider acceptance and actual inbox delivery separately. Uncertain sends remain `unknown` (or `sending` following a crash) and are not automatically retried; a new user request may issue a new link. Queue metadata is retained for seven days by maintenance. Provider acceptance alone is not proof of delivery.

### Offline email preview

Run the existing `preview:tracking` command with a dedicated local `RELAY_PREVIEW_DATABASE_URL` and optional `RELAY_PREVIEW_PORT`. It now includes an in-memory test mailbox in Account security. Create a disposable account, save its recovery code, then use **View local test emails** to open the verification preview. After confirming the address, create a password reset preview. No email is sent, no external network connection is allowed, and the database schema is dropped when the runner shuts down. This is a development tool, not a public recovery mechanism. The public server refuses the preview transport and returns 404 for the mailbox endpoint.

User direction, 24 October: defer domain selection, purchase and email-provider onboarding; continue completing the application locally. Real payments remain disabled and Peer must not be contacted.

## Connected customer test funding (24 October 2026, local release)

Customer accounts now have **Try test funding**: choose a saved Base wallet, enter GBP, review an illustrative quote, create a test checkout, record a simulated payment and follow it to a simulated receipt. This adds no Peer connection. The fixed example rate (£1 = 1.25 USDC) and 2% example USDC fee are not real offers or provider pricing. The quote and checkout expire ten minutes after quoting if no test payment has been submitted.

`funding-journey.mjs` stores quotes and checkout controls in the existing isolated tracking namespace. Creating the immutable tracking intent and the checkout is one transaction; owner-scoped request IDs and unique quote IDs prevent duplicate creation. Customer identity comes only from the server session. A quote cannot name another account's wallet; browser-supplied amounts, owners, destinations or success states cannot rewrite the reviewed order. Customer sign-in is now independently configured from payment availability. Hosted configuration still hard-disables real payments and provider connections, and rejects live credentials.

The background worker uses the existing receipt validation and fenced writes with synthetic provider records and RPC evidence. Successful test payment goes through payment recorded, receipt pending, finality pending and simulated arrival. Partial payment preserves its original receipt when the remainder is simulated. Review holds block replacement orders; they do not invite another payment. Cancellation is allowed only before submission. Returning, reloading or adding a checkout ID to a URL cannot establish payment. Orders can be resumed from Activity; normal hosted PostgreSQL persists across service restarts. The disposable local preview still drops its isolated schema when stopped.

Routes `/api/test-funding/quote`, `/create` and `/action` are same-origin authenticated POSTs available only to customer accounts when the injected journey and tracking are explicitly simulated and payments are disabled. Existing `/api/checkouts`, provider refresh and sandbox webhooks remain blocked. Live webhooks remain unconfigured. The UI and public verification payloads label fixture evidence SIMULATED; no simulated receipt is exported as a real transfer or current balance.

Separate web/worker startup is covered by PostgreSQL concurrency tests. Source is prepared locally; no deployment or live environment change occurs as part of this build. On a future approved Render deployment, deploy both processes from the same verified source. No additional keys, services, payment permissions or email domain are required for this test journey. Actual Peer checkout/webhook/network validation and UK route eligibility remain future activation work; this test does not prove them.
