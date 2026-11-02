# Funding requests: first release

Requests live in Payments → Funding requests. A signed-in customer saves the task purpose, a target in net USDC, one of their saved Base USDC wallets, and a deadline (one hour, one day or seven days). This is a plan, not a payment or spending authorisation.

## Behaviour

- A request is visible only in its owner's authenticated account. It retains an immutable destination and wallet revision.
- Replaying the same request key and details returns the same record. Changed details under that key are refused.
- Review opens the existing three-step funding flow with its destination fixed. The customer chooses a fiat amount; no exchange rate is guessed from the USDC target.
- Final confirmation creates one existing funding draft and links it to the request in the same database transaction. Duplicate clicks cannot create a second linked draft.
- Expiry or a changed destination blocks preparation. Expiry is checked again before a new Peer checkout can be created. Once a checkout has started, its existing tracking/recovery rules continue.
- Cancelling an unprepared request never calls Peer. Linked requests retain their draft and payment history.
- The target comparison uses the existing validated selected-offer/settlement display. It distinguishes an estimate, a recorded settlement and a final matching Base receipt. Stale estimates are withheld. A platform credit or permission for an agent to spend is never inferred from a transfer.

## Internal HTTP contract

Both mutations require the existing customer session, same-origin JSON POST and existing request/rate limits. They return refreshed owner-scoped application state. No API key or machine-agent authentication is added.

`POST /api/agent-funding-requests/create`

Fields: requestKey (UUID), agentId (owned saved wallet UUID), purpose (3–240 characters), targetUsdc (decimal string, positive, up to six decimal places and 100,000 USDC), expiresInHours (1, 24 or 168), confirmDestination (true).

`POST /api/agent-funding-requests/cancel`

Field: id (owned request UUID). Only unlinked requests can be cancelled here.

`GET /api/state` includes agentFundingRequests for authenticated customers when funding drafts are configured. `POST /api/funding/drafts` accepts an optional fundingRequestId; owner, expiry, exact destination and saved wallet revision are checked server-side. A request cannot be rebound to a second draft.

## Deliberate limits and next integration work

- This first version supports customer-created requests. Machine-agent credentials, scoped tokens, external request links and callbacks are not enabled. Do not give agents a customer's login/session cookie. Those need a separate scoped-access design and review.
- Automatic exact-net-USDC → fiat pricing remains unavailable. The current preflight returns availability, not the selected offer's net price. Keep the target distinct from the chosen fiat amount until a verified offer is available.
- No Tempo bridge, deposit API or wallet connection is implemented. Deposits with memo/extra-data requirements that the checkout cannot carry must not use this route.
- No automatic payments, customer emails or provider messages are introduced.

## Storage and rollback

The migration adds relay_agent_funding_requests, its index and immutable-field trigger. Existing customers, wallets and payments are not rewritten. It runs with the existing draft migration. Production migration has not been run in this task. Roll back application code to 054ef65f4ba8b220fdabfe91090a0eebc02acfd3 if needed; retain the new table and records. Never drop request data as part of code rollback.

## Preview and tests

The standalone loopback preview lives outside the deployment source in ../evidence/preview.mjs. It uses an isolated in-memory database, sample identities and synthetic receipt examples. It never imports a live payment writer or credentials. Production does not include its data or toolbar.

Offline tests cover owner isolation, same-origin access, changed wallets, duplicate keys, concurrent draft binding, immutable fields, expiry before checkout and target evidence. Real PostgreSQL concurrency and live end-to-end payment settlement remain separate release checks; neither is claimed by an in-memory test.
