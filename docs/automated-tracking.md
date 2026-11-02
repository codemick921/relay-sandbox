# Automated settlement tracking

Read-only tracking uses Peer merchant order/payment reads, authenticated webhook hints, a durable per-order queue, and exact Base receipts. It does not create, cancel or release a payment. Live checkout settings and the configured funding contract are unchanged.

## Sources and trust

- Peer Pay payment history binds the merchant order, stable payment ID, fiat intent, fulfilment transaction and net USDC amount. The complete per-order history is read; incomplete or oversized responses remain under review.
- Only native USDC on Base, the saved recipient, exact net amount, canonical block and finalised receipt can complete delivery. Partial payments are reserved uniquely before completion. A previously finalised receipt cannot disappear silently.
- Receipt decoding recognises SDK V3 and the separately pinned V4 deployment at `0x74c55679268FAfB493864915aD16A320AB8c40Ba`. V4 uses an address-valued final event argument, unlike V3's boolean. Every V4 receipt checks deployment block and runtime bytecode hash at the receipt block. This is observation support, not activation of V4 for signing or routing.
- V4 evidence: official [deployment artifact](https://github.com/zkp2p/zkp2p-contracts/blob/70b5414d6aaa417ba9a7dc38c8a2ddd7cc1826e8/deployments/base/OrchestratorV4.json) and [deployment output](https://github.com/zkp2p/zkp2p-contracts/blob/70b5414d6aaa417ba9a7dc38c8a2ddd7cc1826e8/deployments/outputs/orchestrator-v4-base.json). Creation block 53251271; runtime hash pinned in `server/settlement-contracts.mjs`.
- Optional Peerlytics calls only `peerlytics_receipt` for an exact public intent at its fixed MCP URL. It sends no merchant credentials or customer details. One lookup per reconciliation, four-second timeout, 128 KiB response cap, bounded cache and a one-minute outage pause. USD-normalised values, arbitrary returned links and indexer finality claims are not used. A mismatch or outage cannot override Base evidence.

## Scheduling and recovery

The web process owns live tracking; the separate existing worker serves sandbox tracking and mail. Each live tick processes up to five due orders sequentially, with a lease/generation fence per order and a 15-second delay between batches. Manual refreshes and signed wakeups receive durable priority; every fifth claim uses oldest-due order selection so priority traffic cannot starve historical reconciliation. A refresh arriving during a successful check remains queued. Successful checks of inactive requests older than 30 minutes use a five-minute interval, or hourly after a day; active quotes and pending delivery retain 30-second scheduling. These are scheduling targets, not guaranteed latency. Provider cooldown and errors remain respected. Signed, deduplicated webhook hints accelerate known orders, including `PAYMENT_PAYOUT_RELEASED`. Unknown orders are never imported into a customer account automatically. Periodic reconciliation continues even without webhooks, including stopped requests and late settlements. Customer screens refresh saved state automatically.

Provider `x-retry-after` (or standard Retry-After seconds) schedules a durable cooldown; transient failures retain the prior result and use bounded exponential backoff with jitter. Existing review holds stay sticky. Safe diagnostic codes are available to the operator without raw provider bodies or credentials.

HELD means a settled payout is awaiting release, not verified wallet arrival. DISPUTED is separately visible. RELEASED still requires an attributable final receipt; a deferred vault release whose recipient transfer is not in the supplied transaction remains unverified. Adding a new vault/bridge receipt scheme requires independently validated contracts and exact intent linkage. Never match customers by approximate time and amount.

## Restart behaviour

An unpaid stop retries a generation race once with a fresh full provider read. It never reuses stale unpaid evidence. Paid/review requests cannot be stopped through this action. A completed request can start a new funding form, clearing the old URL, while retaining its history. Paid-but-unresolved concurrent funding is not enabled by this release.

## Verification and operations

Tests cover V4 event decoding, unknown/changed contracts, wrong recipients, held-to-released progression, dispute history, indexer failures/mismatches, authenticated release notifications, provider cooldown, durable reconciliation, duplicate receipts, generation races and no-payment guards. No production payment is created by release tests.

Existing review resolution uses the audited store operation with a fresh finalised receipt and a documented operator reason. Never clear a review via a raw status update. Customer account, wallet and funding history tables are not reset or deleted by this release; the tracking queue adds only a nullable operational refresh_requested_at column. This can remain in place during rollback; no customer or payment binding is rewritten.

## 2 November 2026 backlog regression
A production queue held 43 requests, with 38 due while the old one-per-tick observer was healthy. A paid request waited several minutes for the next finality check. Regression tests reproduce this queue size, manual priority, FIFO fairness, restart persistence, a refresh during a check, and receipt idempotency. Arrival is established by the original transfer receipt even if the wallet immediately forwards the USDC elsewhere; it never depends on current wallet balance.

Primary references: [Peer events](https://docs.pay.peer.xyz/webhooks/events), [payment fields](https://docs.pay.peer.xyz/api/payments), [settlement accounting](https://docs.pay.peer.xyz/guides/fees-settlement-refunds). Provider settlement fields may be refined; unsupported changes remain held for reconciliation rather than silently rewriting finalised evidence.
