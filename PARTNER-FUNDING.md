# Fund with Eupova: hosted partner integration

Visit https://app.eupova.com/#partners for the interactive sample, button generator and guide. This is a hosted-review integration with a plain HTML launch button. The approval/payment UI is not embedded in third-party iframes.

## Contract
1. The customer creates an expiring request-only connection under My agents for one saved Base USDC wallet. Store the one-time key in your server's secret manager. Do not share keys across customers.
2. Your authenticated backend calls POST /api/agent/v1/funding-requests using that key, a persisted UUID Idempotency-Key, purpose, targetUsdc decimal string and expiresInHours (1,24,168). Pin the idempotency key to your own authenticated task/customer before calling Eupova. After a timeout, reuse that key and identical body. Never create another logical request as a blind retry. Existing daily quotas and expiry apply.
3. The additive response field reviewUrl is https://app.eupova.com/#request=UUID. Store the returned ID against your task. The fragment carries no credential, amount or destination and is not an access token. Only the signed-in owner can read the request. Wrong-account links show unavailable.
4. Render a plain link labelled Fund with Eupova; announce that it opens a new tab. Use target=_blank and rel=noopener noreferrer. A link click does not approve a request or create a payment. Normal Eupova review and payment confirmations remain required.
5. Use authenticated GET status with the same connection key for reconciliation; do not expose it to browsers. Optional signed callbacks follow AGENT-CALLBACKS.md. Respect 429, back off, stop on 401/403 and preserve unresolved state. Keep an opaque partner task ID server-side; do not place personal details in URLs.

A dependency-free server client is in examples/partner-client.mjs. It has no executable entrypoint and no checkout, payment or wallet method. Persist your idempotency key before calling request(). Its 10-second timeout does not prove that submission failed.

## Returning to the platform
The optional EUPOVA_PARTNER_RETURNS web-service setting is a JSON object keyed by the existing agent connection UUID:

```json
{"11111111-1111-4111-8111-111111111111":{"name":"Your platform","url":"https://your-platform.example/funding"}}
```

An operator must verify control of the destination and approve its association with that connection. Exact HTTPS URL only: no credentials, custom port, query or fragment; no localhost/IP literal. The setting is absent by default. No destination was configured in this release. The mapping is read server-side; only an owned request's matching connection supplies the optional Return to platform link. Customers see the hostname before clicking. No automatic redirect, request ID or status is sent to that URL; the platform reconciles using its server-side request/task mapping. Query parameters cannot override it. Keep approved domains under review and remove stale entries.

A return is navigation, never evidence of payment. The original request remains accessible in Payments. A new key/connection requires a separately approved mapping. Browser pages use existing no-referrer/frame restrictions.

## Status and receipts
awaiting_review/funding_prepared describe the request, not payment. progress.paymentConfirmed and progress.deliveryConfirmed are separate. deliveryConfirmed records attributable native USDC arrival on Base; it does not establish credit inside Tempo or another platform, permission to spend, or task completion. Status can later require attention. Use freshness/nextAction and signed sequence numbers; do not overwrite newer evidence with an older event.

## First platform pilot
No external platform pilot has been completed. The sample page has no API calls or account writes and uses fictional records. Automated tests additionally exercise real request handlers against a disposable database with sample customers/keys.

For an external pilot select a consenting platform, one customer-owned destination, request-only key, owner-defined limits and a verified HTTPS return address. Start with request creation, duplicate retry, sign-in/review, wrong-account, expired/revoked connection and return navigation. Register a separately approved callback receiver or use authenticated polling. Test signed/replayed/out-of-order events with sample payloads. No payment is needed to validate this integration stage. Any real settlement test is a separate approval and cannot be inferred from the sample. Confirm provider permission and destination requirements before accepting partner traffic.

## Release and rollback
No schema migration, new service, new credential or payment setting is required. Existing requests gain a review URL; stored customer records are not rewritten. Roll back the web service to its preceding successful revision to remove these surfaces. Leave records and workers intact.
