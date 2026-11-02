# Agent funding-status callbacks

This is an opt-in developer API, not a payment API. Existing connections and requests are unchanged. With no approved destination configured, callback registration is disabled and no delivery occurs. The existing authenticated GET status tool continues working.

## Endpoint approval and registration
An operator must first approve an HTTPS endpoint controlled by the receiving platform in `EUPOVA_AGENT_CALLBACK_URLS` (comma-separated exact URLs). No query strings, credentials, redirects, custom ports or IP-literal URLs. Public IPv4 DNS only for this release; mixed/private or IPv6-only destinations fail closed. Configure this independently of payment settings. No endpoint is configured as part of this release.

With the same bearer connection key used to submit the request:
`POST /api/agent/v1/funding-requests/REQUEST_ID/callback`
JSON: `{"url":"https://your-platform.example/eupova","confirmOwnership":true}`.
Returns callback ID and a signing secret. Store the secret server-side; never put the connection key or secret in URLs. Repeating registration for the same URL returns the same secret and resumes a paused delivery. URL changes are rejected. `GET` at this path returns delivery state without a secret. `DELETE` disables future dispatch. Browser/cookie access and cross-connection access are rejected.

## Delivery contract
The web service observes durable request/payment evidence approximately every 30 seconds (load may delay this). It sends the initial snapshot and meaningful changes, not every tracking timestamp. It does not guarantee capture of every intermediate state between observations. Payload has schema `eupova-funding-callback-v1`, stable event `id`, per-subscription `sequence`, `createdAt`, and `data` containing `requestId`, `requestStatus`, and the existing agent `progress` projection. No purpose, customer email, wallet address, checkout link or connection credential is included.

`paymentConfirmed` is separate from `deliveryConfirmed`. `funding_prepared` does not mean paid. `funds_arrived` means matching confirmed Base USDC delivery under existing evidence checks, not credit/spending readiness inside a hosted platform. Changed, stale or disputed evidence can produce a later `needs_attention` event: do not treat arrival as an irrevocable terminal subscription state.

Verify `Eupova-Signature: t=UNIX_SECONDS,v1=HEX` as HMAC-SHA256 using the hex-decoded signing secret over `timestamp + "." + rawRequestBody`. Reject timestamps over five minutes old in either direction. Use a constant-time comparison. Reference verifier: `hosted/callback-transport.mjs`, `verifyCallback`.

Persist/deduplicate event IDs and sequence numbers before acknowledging with any 2xx. Return promptly; do business work asynchronously. Delivery is at least once, not exactly once. A crash after acceptance but before recording acknowledgement can repeat the same event. Pending payload and ID survive process restarts. Older pending events are retried before a newer snapshot; receivers should apply only increasing sequence numbers. Never automatically authorise payment based on a callback.

## Recovery
Delivery times out after five seconds; DNS after three. Redirects are failures. Retry delay starts at 30 seconds, doubles and caps at one hour. After eight failed attempts the subscription pauses with `delivery_failed`; GET exposes attempts/pending ID. Re-register the identical URL after fixing the receiver. Delivery does not log response bodies, secrets or full endpoint URLs. Connection expiry/revocation, customer security-version changes and wallet revision changes stop delivery. Removed allowlisted endpoints stop delivery. Existing GET status remains the reconciliation path while the connection is valid.

## Operations and rollback
New table `relay_agent_callbacks` is additive and starts empty; no existing customer/payment data is rewritten. Web service owns dispatch; no payment-worker upgrade required. Old code can run with this unused table after rollback. Rollback stops callbacks but cannot unsend delivered messages. Retain receiver deduplication across releases. No external receiver has been tested in production yet; sample events and fake transports cover delivery logic.
