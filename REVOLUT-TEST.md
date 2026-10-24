# Private Revolut test

The web service and simulation worker cannot create live checkouts. General payment routes still return 403. An operator can prepare one Revolut GBP checkout manually using `scripts/revolut-test-operator.mjs` in the existing Render service, with its existing private live credentials.

## Boundaries

- The source and immutable database policy limit the test to one customer, one saved wallet revision, Base USDC, Revolut GBP, £0.01–£10 order principal and a maximum 24-hour approval. A permanent singleton attempt prevents another creation, including after restart or an unknown response.
- The £10 total budget remains a human payment limit. Relay cannot enforce fees charged outside Peer or prevent repeated transfers in Revolut. An available quote is advisory and reserves nothing.
- Merchant-pays fees reduce settlement. Revolut uses buyer verification; follow the checkout's iPhone verification instructions. Seller-only release is not claimed.
- The customer-only `/api/revolut-test/checkout` route releases an already-bound private link after current provider reads, account and wallet checks. It does not create orders. Revocation blocks subsequent release but cannot invalidate a link already copied from Peer.
- Tracking uses the pinned payment rail and independently verifies the exact canonical, finalised Base USDC receipt. A webhook or return URL cannot mark funds received. Existing Wise drafts and simulations remain separate.

## Operator sequence

Use the script with an action and a JSON argument. Keep private checkout URLs, credentials and personal records out of shell output and Git.

1. Confirm the signed-in customer and saved receiving address. Obtain the exact owner and agent IDs from that saved wallet record.
2. Refresh live quote availability for GBP/Revolut and the exact destination. Do not substitute another rail or increase the budget. Stop when no supported offer exists.
3. `prepare`: pass `owner`, `agentId`, a new `requestId`, decimal `amount`, and `confirm: true`. This only saves a draft.
4. `provision`: pass `owner`, draft `id`, exact `walletAddress`, `maxTotalPence: 1000`, `hours: 2`, `approvalRef` and `consentRef` identifying the user's actual approval. This creates the immutable one-shot policy. Never fabricate consent.
5. `create`: pass only `owner` and draft `id`. The script rechecks policy, merchant and liquidity, reserves the permanent attempt atomically and makes at most one order-creation request. It never pays, signs, refunds, cancels a provider order or initiates a bank transfer.
6. Refresh Relay. The owner reviews the private test card and opens the existing checkout. The human checks the final amount, recipient and total fees before making one payment from their existing GBP balance. Do not pay if details differ or the £10 total budget would be exceeded.
7. Keep read-only tracking running until delivery or reconciliation. Do not make a second transfer to resolve a partial, expired or failed state.

`status` reads the policy. `revoke` permanently blocks release for that policy. `reconcile` accepts an independently verified provider order ID and only reads it; it never retries creation or reconstructs a lost private link.

## Recovery

An unknown creation stays unresolved and retains its attempt forever. A provider order may exist even when no link was returned. Do not delete policy or attempt rows, retry creation, change the wallet or seed another policy to work around a hold. Retain records for operator reconciliation.

Rolling back source removes the private release route. Keep read-only receipt tracking available for any order already created. Additive database columns and tables retain audit history and are compatible with older source. Rollback does not reverse a payment, revoke a copied Peer link or refund a service charge.
