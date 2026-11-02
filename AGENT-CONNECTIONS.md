# Agent funding requests (v1)

An authorised agent can submit a request to Eupova. This is not a payment API. The customer reviews the request and separately chooses whether to create/pay a Peer checkout. Tempo and other platforms are not automatically connected: their developer must support these server-to-server calls.

## Customer setup
My agents → Agent connections → New agent connection. Choose a name, per-request USDC limit, rolling 24-hour request count (1–10), and expiry (1/7/30 days). Confirm the pinned Base USDC wallet and current Eupova password. Store the one-time key in the agent platform's secret settings. The service stores only its SHA-256 hash. Never embed it in frontend code, URLs or public prompts.

## Submit
`POST https://app.eupova.com/api/agent/v1/funding-requests`
Headers: `Authorization: Bearer YOUR_CONNECTION_KEY`, `Content-Type: application/json`, `Idempotency-Key: UUID`.

```json
{"purpose":"Weekly industry briefing","targetUsdc":"25","expiresInHours":24}
```

Amounts are decimal strings with up to six fractional places, positive and within the owner-defined cap (absolute maximum 100,000 USDC). Review duration is 1, 24 or 168 hours. No destination parameter is accepted. The immutable wallet/revision comes from the connection. Retries must reuse the UUID and identical normalised details; a changed payload returns 409. Rate/quota failures return 429; inactive/invalid credentials return 401. Do not automatically retry with a fresh key after an uncertain response.

Response includes ID, purpose, targetUsdc, asset, network, timestamps and request status. `awaiting_review`, `funding_prepared`, `dismissed`, `expired` describe the request lifecycle only. **funding_prepared does not mean paid or delivered.**

## Read one submitted request
`GET https://app.eupova.com/api/agent/v1/funding-requests/REQUEST_ID` with the same bearer key. A connection can read only requests it created. It cannot read customer records, checkout URLs, balances or payment endpoints. Browser-origin/cookie requests are rejected. No webhooks or remote callback URLs are accepted in this version.

## Lifecycle and safety
- New requests appear in Payments → Funding requests, attributed to the saved connection name. Purpose text is untrusted agent content, rendered as text.
- Customer approval remains in the existing funding flow; target amount is not a fiat quote, guaranteed receipt or spend approval.
- Revoke access from My agents. Expiry, customer disable/password-version changes and changed saved-wallet revisions also invalidate access.
- Both draft preparation and new checkout claim validate the connection. Revocation does not stop already-started payments or remove history.
- At most 20 saved connections and 100 funding requests per customer in v1. Limits include inactive records; no deletion or history purge endpoint is exposed. Request count is a request-volume control, not a spending limit.
- Customer and agent requests share an idempotency namespace; keys cannot be reused across origins.
- Schema changes are additive; old releases can run with the extra tables untouched. The payment worker needs no new code for this feature.

## Not yet covered
No third-party agent platform has been connected or tested live. There is no automatic payment, wallet connection/signing, target-to-fiat conversion, push callback or guaranteed external platform credit. Actual iPhone and screen-reader testing are separate from browser viewport checks.
