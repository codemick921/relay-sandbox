# Optional payment emails: disabled sample implementation

## Current boundary
This release contains a pure event planner, HTML/plain-text templates, a read-only payment-detail deep link and a Notifications email-preview section. It does **not** register a payment-email worker, provider transport, customer preference API, database migration or live sending job. `PAYMENT_EMAIL_SENDING_ENABLED` is false; changing that constant alone cannot send anything.

The local fixture server sets `paymentEmailPreview: true`. Only it exposes `/api/payment-email-preview` and its sample preference/event endpoints. Production does not expose those routes. Sample preferences are held in temporary memory, scoped to an unpredictable preview session ID, and reset when the preview is reloaded/remounted. POST requests require the local origin. No real customer data is read. Sample messages use `sample@example.test`; no mail is sent. Email HTML has no external images, fonts, pixels or active sample links.

## Event contract
`planPaymentEmail` receives a trusted saved order, its owner, current account status, explicit preferences, the previous observation and a clock. It calls the existing `paymentRecord` evidence projection. Do not pass a client-supplied status as evidence.

- Arrival requires the existing validated/finalised native USDC receipt on Base with the matching recipient, amount and fulfilled payment. Peer payment confirmation alone is insufficient.
- Attention covers review, dispute, part payment and uncertain checkout states. A routine pending state or tracking outage by itself is not an attention event.
- Simulations, foreign owners, disabled accounts and unverified addresses are suppressed.
- Both options default off. Opt-in time is recorded per type. Baselines and transitions predating opt-in do not create a backlog.
- Fresh saved evidence is required. Temporarily unavailable evidence retains the previous observation so a later successful check can reconsider the transition.
- Repeated observations produce no event. Stable event keys include owner, request and evidence/reason fingerprint. An already recorded arrival is not reannounced when a dispute resolves or receipt details change.
- A plan is **not** a queued, accepted, delivered or read email. `preview_ready` means only that a template can be inspected.

## Templates and links
Templates contain the event amount only for a verified arrival, a wallet label, a request reference and a next step. They omit full wallet addresses, bank details, login links and provider checkout tokens. Dynamic HTML is escaped. The payment link uses `/#payment=<UUID>`, requires customer sign-in and opens the existing read-only payment detail route. That route's server-side owner checks remain the authority; knowing a UUID grants no access. Templates have inline styles and system-font fallbacks for email clients.

## Work required before live activation
1. Add owner-scoped persistent email preferences with authenticated same-origin updates, opt-in timestamps and a simple disable control. Do not copy in-app notification defaults into email consent.
2. Add a durable outbox and observation store. Persist observation changes and the unique event key atomically. Recheck opt-in, verified email, account status and current payment evidence immediately before delivery. Cancel superseded attention messages and queued messages after opt-out. Define retention and rate limits.
3. Run the planner from the existing background tracking flow, not from a customer opening Notifications. Baseline existing orders on first activation; do not mail historical receipts.
4. Add the separately disabled Resend adapter and an idempotency key derived from the durable job. Retain unknown submission outcomes for reconciliation; never blindly retry. Keep account verification/reset sending independent.
5. Record accepted, delivered, bounced and complained events separately. Authenticate provider webhooks and suppress further mail to unsuitable recipients. Add a signed preference-management route without exposing account tokens in payment links.
6. Test concurrent workers, restart recovery, revoked preference/account state, old queues and uncertain delivery using a disposable PostgreSQL database. Validate HTML in actual email clients before sending to customers.
7. Obtain explicit activation and delivery-test authority. Payment settings need no change. No customer email is authorised by this sample task.

## Design
Reuse Eupova forest, mint and lavender, the existing type families and generous button targets. Choices and message preview sit side by side on desktop and stack on narrow screens. On mobile the selected message is brought into view. A visible disabled badge and sample labels keep local review separate from delivery. Real email uses fallback fonts and table layout for compatibility; rendering in actual Gmail/Outlook/iPhone mail apps is not yet verified.
