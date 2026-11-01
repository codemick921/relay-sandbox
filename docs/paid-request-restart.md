# Start separate funding while a paid request tracks

A customer can explicitly acknowledge a fully paid, bound request and open a separate funding form. The server requires persisted SETTLED payment evidence and a fulfilled provider snapshot, matched to the original merchant, recipient, intent, transaction and amount. Wallet delivery need not be final. Existing review, payout and dispute states remain visible and unchanged.

`tracking_only_at` releases only the local active-draft slot. It is immutable, audited and idempotent. The original request stays bound, is neither stopped nor superseded, and remains eligible for all worker, webhook, history and delivery processing. Old payment links cannot be resumed. No provider request is made by this action. Other drafts, uncertain creation and unrecorded or partially paid requests still block a new draft. Existing unpaid-stop logic is unchanged. Existing checkout creation, permissions and payment configuration remain enforced.

The web startup owns this migration; the separate sandbox worker does not run funding-draft migrations. An older web startup would recreate the pre-change unique index. Rolling back requires retaining the new index predicate and marker-aware request guards; do not blindly deploy an older migration after tracking-only requests exist. No existing row is marked or changed by migration.
