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


## 24 October 2026: customer live-payment activation

The later user instruction supersedes earlier payment-disable requirements. The web service now supports `RELAY_LIVE_PAYMENTS=enabled` with its existing distinct live Peer credentials and receive-only webhook connection. Default is disabled. Do not set this on the simulation worker. Customer creation requires authentication, same-origin POST, explicit checkout/data-sharing consent, immutable saved-wallet binding and a durable idempotent attempt. The prior one-account/one-attempt £10 policy is not used for customer creation. Product input bounds remain £0.01–£1,000 for Revolut and £2–£1,000 for Wise; provider availability still applies. Unknown attempts cannot be retried as new orders. No bank debit is executed by Relay.

The existing web-process live tracker independently verifies provider payment records and finalised native Base USDC transfers. The separate worker continues to process simulations and email jobs. An order being created or a customer returning from checkout is not evidence of wallet receipt. Live funds have not been tested as part of this release.

Ramp appears as a separate simulation option. No Ramp key, provider account, hosted widget or webhook is connected. The demo-contract adapter is tested with injected responses only. Real Ramp activation still needs approved configuration and a trusted purchase-to-customer binding, quote refresh, notification replay storage and scheduled reconciliation. Do not expose the adapter or treat the generated receipt as a live integration.

Activation procedure: test the exact source, deploy with the switch disabled, verify the release, then enable the web-service switch under the user’s live-payment authority and verify health plus customer screens. Rollback switch to disabled preserves all history and read-only wallet tracking. Existing unresolved customer orders must be reconciled, not deleted to bypass duplicate protection.

## Settlement currency reconciliation

Live tracking records GBP/USD/EUR payment currency and validated CROSS_CURRENCY adjustments separately from the immutable GBP request. A provider FULFILLED order may retain a remaining amount; the UI displays that amount while confirming only the exact net native Base USDC transfer. This does not authorise a different currency or amount for a new payment. Unknown adjustments and conflicting receipts remain held.

Existing review holds stay sticky. An operator can inspect one existing order on the web service with `node scripts/reconcile-live-order.mjs <relay-order-id> --check`. After diagnosing the cause, `--resolve "specific operator reason"` performs a fresh API and canonical finalised receipt check, validates unchanged bindings and globally unique receipt evidence, then records an audit entry and closes only the matching funding draft. It refuses pending delivery, chargebacks, stale evidence and concurrent conflicts. There is no browser endpoint for resolution. Never manually mark an order received based only on a merchant badge or webhook.


## Automatic settlement updates

Future successful Peer payments use the existing durable webhook inbox and periodic web-process tracker. The customer screen reads saved state every 15 seconds while visible and when returning to the tab; it does not have to request reconciliation. Backend polling continues with the browser closed and reconciles missed notifications. An active order is normally checked again after 30 seconds, subject to the queue and provider availability.

Normal fulfilment/history lag, changing read snapshots and unavailable finalised-block data now use a typed pending-evidence retry after 15 seconds, without creating a review hold or counting towards the outage circuit breaker. Missing receipts and unfinalised blocks continue through the existing pending/confirming states. The last verified state is retained, and unknown or conflicting destination, amount, intent, merchant, token or settlement data still cannot establish arrival. Existing security review holds are never cleared by this retry path.

Regression coverage exercises signed hint deduplication, repeated convergence delays, missing receipt, finality wait, restart, customer state and receipt reads, draft closure and zero operator-resolution events, using injected provider/RPC responses and actual PostgreSQL. This is an automatic tracking test, not a new real payment. The separate simulation worker and payment-creation permissions remain unchanged.


## Stop an unpaid request and start again

User correction, 24 October 2026: customers should be able to stop an unpaid request in Relay and choose another amount without waiting for Peer cancellation or merchant action. This supersedes the merchant-assisted cancellation UX. Stopping locally does not cancel a Peer order, bank transfer or refund funds; do not claim otherwise.

The customer confirms they have not sent or scheduled payment and will not use the old checkout. A fresh read of the bound live order must show CREATED, no settlement or dispute, its full remaining amount and only unpaid attempts. A per-owner transaction checks the observation generation and durable settlement records before setting immutable `stopped_at`. This releases the active-request slot. Authentication, ownership, same-origin checks and explicit consent for each new checkout remain. Conflicting evidence, unknown creation and unavailable reads do not release the slot.

Old order IDs, amount, wallet snapshot and payment evidence remain unchanged. Relay no longer exposes their checkout links, but the read-only tracker keeps checking for late funds and attributes them to the original order. History labels them Stopped in Relay. New requests get new IDs and separately reviewed amounts; stopping never creates a new provider order itself. Legacy cancellation requests can use the new local stop flow when eligible, and genuine provider cancellations still reconcile normally.

Regression checks must cover immediate replacement, concurrent stops/new requests, old-link rejection, restart persistence, ownership, stale observations, disputes, outage holds and late funds on the original order. Do not cancel or create real orders to test this feature.

## 24 October 2026: wallet dashboard and phone resume

Wallet balances, low-balance preferences and repeat funding are deployed at commit `1c97de98f97e35a1a655c46d8aa5cf6535549ca2`. Render deployment `dep-dbehfcss728c73c8ghd0` is Live. Existing live payment flags are unchanged.

The next local release adds clearer per-stage payment instructions and a phone handoff for saved customer funding requests. The locally generated QR/copy link contains only a Relay request UUID in `/#funding=<uuid>`. It contains no session, private Peer checkout token, wallet address or payment amount. Sign-in is required, and the owner-scoped state must contain that request. Opening or scanning the link only displays the existing request; provider checkout creation/resume retains explicit existing controls and server checks. Stopped, cancelled, completed and held requests do not gain payment controls from a link.

The current provider checkout remains authoritative for recipient, amount, currency, reference and deadline. The user must complete any payment/verification steps required there. Relay's phone handoff does not alter provider verification requirements or guarantee extension-free verification. No provider was contacted during implementation.

Validation: 170/170 offline regression tests with actual local PostgreSQL, including five phone-resume tests; production build; signed-out link then customer sign-in restores the same request; local QR/copy verification and 390px mobile layout check. No real phone camera scan or provider payment was used. Phone changes are locally prepared, not yet deployed. Logs: `development/2026-10-24-payment-handoff/`.

Deployment update: the phone-resume release described above is now live at6fae62964d41ac60fa286d5a910adb8500392152 (Render dep-dbehkfq9lscs73b6dd2g). Hosted QR and saved-request screens verified; actual iPhone readback pending. Payment settings unchanged.


## Account security release — built locally, 24 October 2026

The local security release adds a recovery checklist, public session identifiers and approximate browser/device labels, password-confirmed revocation of other sessions, recovery-code confirmation/replacement, and password confirmation for customer wallet additions and edits. Existing requests retain their original destination snapshots; stale unsubmitted drafts must be replaced after a wallet edit. A saved address remains self-declared, not proof of wallet ownership. Password confirmation is not MFA. Email recovery is labelled unavailable unless sending is enabled and the address verified; local previews remain test-only.

Schema version 4 is additive. It preserves existing accounts/sessions and adds session labels/IDs, recovery readiness timestamps and private security-event records. Password and recovery changes reset the readiness check. The current session cannot be revoked through the other-session controls. Existing two-hour idle and twelve-hour absolute limits remain. No payment configuration change or provider contact is part of this release. It has not been deployed to Render.

Validation: 178 offline tests pass against disposable PostgreSQL on the portable drive, with no skips. Browser checks cover session revocation, password rejection/acceptance for a synthetic wallet edit, persisted destination after reload, and a mobile security layout without horizontal overflow. Recovery-code rotation and race conditions are covered by backend tests. No real customer account was modified. See `development/2026-10-24-account-security/action-log.md`.

For this task, large test data, release output and logs use `/Volumes/WD Elements 1TB/Relay/`. The development evidence directory and old disposable database path are verified symlinks to that drive; it must remain connected for these local resources. Production hosting is unaffected. Browser screenshots briefly use private temporary files before being copied to the drive because the browser file API cannot write there directly. Existing app source stays at its established workspace path; the prepared release copy and its build output are on the portable drive.


### Account-security deployment confirmed

The account-security release was deployed on 24 October 2026 as `7af3e435de0d2b0ba30892e058b56ae129f8dafa` (Render `dep-dbej1mnavr4c73b365kg`). All live payment flags remained unchanged. GitHub passed 178 tests and build; existing-session, recovery-checklist and protected-wallet-editor screens were verified in production without changing customer details. Full evidence and the current deployment checkout are under `/Volumes/WD Elements 1TB/Relay/development/2026-10-24-account-security/render-deployment/`. Earlier local-only entries are historical.

### Optional read-only payment-health access

`RELAY_PAYMENT_HEALTH_ADMINS` defaults to `[]`. A future authorised activation can name specific existing `SANDBOX_TESTERS` labels, for example `["designated-operator"]`; do not enable all testers or reuse a publicly known preview code. The labels must exist in the configured tester list. This permission exposes saved cross-customer tracking records for the server-pinned merchant. Removing a label removes its access on the next request. Customer sessions cannot gain this permission. Changing this setting requires a service restart/redeploy and is independent of all payment switches.

The 25 October dashboard build does not activate this variable on Render or change live payment settings. Browser activation should be reviewed as a separate access grant. Existing runtime guards, provider calls and background scheduling remain unchanged.

## Customer notifications and reminders

The customer-only Notifications screen reads saved payment and wallet-balance evidence. It never calls payment providers or creates a checkout. Schema migration `customer-notifications.sql` runs with the existing base migration lock and transaction; retain its tables when rolling back code so inbox history and preferences survive.

The authenticated app synchronises on opening, returning to a visible tab, and every minute while visible. Due reminders are delivered on the next visit; this release has no closed-app scheduler, email or push delivery. Weekly/monthly schedules use Europe/London calendar dates, keep the original monthly day through shorter months, and produce one catch-up notice after missed dates. Preferences and read status belong to the customer account. Operator/tester sessions cannot use this inbox.

Arrival notices require the same verified delivery evidence as customer receipts. Disputes/review/unavailable checks receive attention notices. Simulation notices are off by default and explicitly labelled when enabled; the local preview opts in for synthetic testing. Low-balance notices require fresh, successful evidence for the currently saved wallet address and an enabled wallet alert. Unknown/stale checks do not reset a low-balance episode or treat an unknown amount as zero.

No new environment variable, provider credential, webhook, live-payment flag or worker change is required. Do not alter live settings when deploying this feature. All new APIs use the existing authenticated same-origin protections; PostgreSQL tests are included in `test:postgres` and `test:offline`.

## Payment reliability update — local build, 25 October 2026

No environment or live-payment setting changes are required. This release projects saved current-payment status and quote expiry without introducing an EXPIRED checkout-order status. Expiry hides stale payment links/instructions but does not cancel the provider checkout or release a funding request automatically. Existing stop-unpaid checks and late settlement tracking remain in force. Older saved evidence without a current attempt only projects expiry when all saved attempts are EXPIRED.

Customers see tracking outages, pending evidence, overdue scheduled checks (five minutes), and stale non-terminal evidence (15 minutes) separately from the payment result. Successful verification clears the transient tracking-pending/failure markers. Existing review holds, immutable receipts, worker schedules and live payment access remain unchanged.

Payment health adds the latest 25 saved unmatched/unprocessed notification diagnostics scoped to the pinned merchant, using existing operator permissions. It exposes friendly event descriptions, timestamps and an existing Relay request link only; no payload, notification identifier, credential, replay action or provider call. More than 25 is explicitly flagged. No schema migration or admin access expansion is needed.

Validated locally against disposable PostgreSQL with offline transports: 255 tests pass (nine new reliability cases) and production build passes. Browser QA used synthetic local examples only. Production/provider outcomes remain unverified for this release.
