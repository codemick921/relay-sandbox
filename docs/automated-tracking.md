# Automated settlement tracking

Read-only tracking uses Peer merchant order/payment reads, authenticated webhook hints, a durable per-order queue, and exact Base receipts. It does not create, cancel or release a payment. Live checkout settings and the configured funding contract are unchanged.

## Sources and trust

- Peer Pay payment history binds the merchant order, stable payment ID, fiat intent, fulfilment transaction and net USDC amount. The complete per-order history is read; incomplete or oversized responses remain under review.
- Only native USDC on Base, the saved recipient, exact net amount, canonical block and finalised receipt can complete delivery. Partial payments are reserved uniquely before completion. A previously finalised receipt cannot disappear silently.
- Receipt decoding recognises SDK V3 and the separately pinned V4 deployment at `0x74c55679268FAfB493864915aD16A320AB8c40Ba`. V4 uses an address-valued final event argument, unlike V3's boolean. Every V4 receipt checks deployment block and runtime bytecode hash at the receipt block. This is observation support, not activation of V4 for signing or routing.
- V4 evidence: official [deployment artifact](https://github.com/zkp2p/zkp2p-contracts/blob/70b5414d6aaa417ba9a7dc38c8a2ddd7cc1826e8/deployments/base/OrchestratorV4.json) and [deployment output](https://github.com/zkp2p/zkp2p-contracts/blob/70b5414d6aaa417ba9a7dc38c8a2ddd7cc1826e8/deployments/outputs/orchestrator-v4-base.json). Creation block 53251271; runtime hash pinned in `server/settlement-contracts.mjs`.
- Optional Peerlytics calls only `peerlytics_receipt` for an exact public intent at its fixed MCP URL. It sends no merchant credentials or customer details. One lookup per reconciliation, four-second timeout, 128 KiB response cap, bounded cache and a one-minute outage pause. USD-normalised values, arbitrary returned links and indexer finality claims are not used. A mismatch or outage cannot override Base evidence.

## Scheduling and recovery

The dedicated tracking worker owns live tracking after cutover; the existing worker serves sandbox tracking, mail and operational monitoring. The web process remains an optional rollback tracker. Each live tick processes up to five due orders sequentially, with a lease/generation fence per order and a 15-second delay between batches. Manual refreshes and signed wakeups receive durable priority; every fifth claim uses oldest-due order selection so priority traffic cannot starve historical reconciliation. A refresh arriving during a successful check remains queued. Successful checks of inactive requests older than 30 minutes use a five-minute interval, or hourly after a day; active quotes and pending delivery retain 30-second scheduling. These are scheduling targets, not guaranteed latency. Provider cooldown and errors remain respected. Signed, deduplicated webhook hints accelerate known orders, including `PAYMENT_PAYOUT_RELEASED`. Unknown orders are never imported into a customer account automatically. Periodic reconciliation continues even without webhooks, including stopped requests and late settlements. Customer screens refresh saved state automatically.

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

## Dedicated worker and operational alerts

The `worker:tracking` entry point reads existing Peer orders and validates exact native-USDC receipts on Base. It cannot create a checkout or execute a wallet transaction. PostgreSQL leases and generation fences remain the source of scheduling ownership; webhooks are wake-up hints, and Peerlytics is optional corroboration only. A 180-second cycle watchdog restarts a stuck process so expired leases can be recovered.

Deploy `tracking.render.yaml` as a separate Blueprint. It creates only `eupova-payment-tracker` and references the existing database and Peer credentials inside Render. No signing, Privy or Resend credentials are assigned to this new process. Verify its heartbeat before setting `EUPOVA_TRACKING_ROLE=dedicated` on the web service. Omitted/`web` retains the existing tracker for rollback.

The existing sandbox/mail worker independently monitors the tracker once configured with `EUPOVA_TRACKING_ALERTS_ENABLED=true`, `EUPOVA_TRACKING_MERCHANT_ID` (optional when exactly one dedicated tracker is registered) and `EUPOVA_TRACKING_ALERT_TO=mickel@eupova.com`. It uses its existing Resend sender/key. These flags do not change account-email or customer payment-email preferences. A worker heartbeat older than three minutes, scheduled checks over five minutes late, or at least three failed attempts opens a durable incident. One email is queued per incident and one on recovery. Ordinary waiting-for-payment is not an overdue-payment alert.

Email acceptance is recorded with the Resend ID. Retries retain the exact payload and idempotency key, and stop after 23 hours to avoid repeating mail beyond Resend's 24-hour deduplication window. Such exhausted items remain in the operational outbox for review. The monitor runs independently of tracker and web restarts, but a total Render/database outage or failed Resend delivery cannot be reliably reported through this same stack; external uptime monitoring remains a separate follow-up.

Rollback: set web tracking role to `web`, redeploy the web service, verify a new tracking heartbeat, then suspend the dedicated tracker. Disable only `EUPOVA_TRACKING_ALERTS_ENABLED` if rolling back the monitor. Retain additive operational tables and all payment evidence. Preserve the newest Privy release; do not revert unrelated customer functionality.

References: https://render.com/docs/background-workers ; https://render.com/docs/blueprint-spec ; https://render.com/docs/health-checks ; https://resend.com/docs/dashboard/emails/idempotency-keys

The monitor logs counts and heartbeat age each cycle for verification through Render tools without exposing database connections or customer details. An ambiguous merchant configuration fails closed.

## One-time operational email delivery test
Set EUPOVA_TRACKING_EMAIL_TEST_ID to a fresh UUID and EUPOVA_TRACKING_EMAIL_TEST_UNTIL to an ISO expiry no more than 24 hours ahead, on the existing alerts worker only. This sends a clearly labelled test alert to the configured operational recipient, then queues a test recovery only after Resend accepts the alert. It uses the existing durable outbox, sender, retry and idempotency logic. Restarting with the same ID cannot create more messages. It does not stop tracking, alter real incidents or write customer/payment records. Clear both test values after verification. Expiry prevents new test queue entries; already queued deliveries retain normal durable retries. Provider acceptance is not inbox delivery: verify the two subjects in the recipient inbox (including Spam) or inspect Resend delivery events.
