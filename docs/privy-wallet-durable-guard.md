# Durable buying-wallet setup guard

2 November 2026. Prepared locally from `8a28bcb`; disabled and not deployed.

The guard records one attempted wallet setup per approved identity before Eupova's adapter can call the wallet SDK. A second browser, a new session or a new lease cannot obtain another dispatch permission for the same app and owner, subject or Privy DID. This protects the supported Eupova flow. It does not control someone calling Privy's SDK directly.

## Implemented behaviour

Each claim requires a fresh server verification of the Eupova session, approved development enrolment, pinned Privy access token and empty wallet inventory. Browser-supplied wallet observations are rejected. Recovery review must be recorded and current. The session, enrolment, disable flag and recovery evidence are checked again around database work.

The manual SQL schema contains control, lease and permanent attempt records. Unique constraints cover the app plus each of the owner, subject and DID hashes. A transaction locks the controls and lease, checks expiry against the database clock after waiting, and inserts the attempt. Only the inserted row can produce a dispatch permission, and the server waits for acknowledged COMMIT before returning it. Permission lasts at most ten seconds and is shortened by the other expiries.

If a response is lost after COMMIT, the attempt remains consumed. A status read reports consumption but cannot reconstruct permission. The system may therefore stop a setup that never reached Privy. An operator must reconcile an uncertain result; there is no automatic reset or retry.

The HTTP routes require HTTPS, the exact app origin, a current secure session and a Privy bearer. Request bodies, read time and request rates are bounded. Responses are not cached. Errors do not expose provider responses, tokens or customer identity.

## Default state and integration

`POST /api/buyer-wallet-setup/claim` and `POST /api/buyer-wallet-setup/claim-status` return 404 while `EUPOVA_WALLET_SETUP_CLAIMS_ENABLED` is absent or false. This check precedes secret, database or provider access.

Hosted startup deliberately supplies no `claimDb`. Setting the flag alone therefore cannot activate claims. A later integration must inject a dedicated restricted database adapter whose `tx` promise resolves only after COMMIT acknowledgement. It must also supply the verified observation configuration documented in `privy-wallet-setup-adapter.md`.

The manual schema is `migrations/manual/wallet-setup-guard.sql`. Application startup does not apply it. No schema, role, enrolment, recovery record, key or environment setting was installed in Render during this task. The frontend adapter remains absent from the production entry graph and its build constant remains false. The authentication-only screen continues to reject every wallet.

## Database preparation before a restricted test

Use a separate schema owner and an ordinary runtime login. The runtime login must have only schema USAGE and EXECUTE on these exact functions:

```sql
GRANT USAGE ON SCHEMA eupova_wallet_setup TO restricted_runtime;
GRANT EXECUTE ON FUNCTION eupova_wallet_setup.consume(text,text,text,text,uuid,text,text,timestamptz,timestamptz,text) TO restricted_runtime;
GRANT EXECUTE ON FUNCTION eupova_wallet_setup.status(text,text) TO restricted_runtime;
```

Replace the example role name with the reviewed runtime role. Do not grant schema creation, table writes, ownership, superuser or membership that permits switching to a privileged role. The consume function also rejects a session user with broad table privileges. Keep its SECURITY DEFINER owner out of application credentials.

Controls start disabled with an unreviewed storage topology. Setup requires fsync and synchronous commit, an unexpired operator review of the database topology, and a short lease entered through a separately approved administrative process. This build adds no lease-enrolment UI or automatic activation command.

The database refuses asynchronous commit and replica execution. The synchronous-failover mode also requires configured synchronous standbys, but this check does not establish that every possible failover target has the claim. Review the actual hosting topology, failover policy and storage durability before activation. Do not declare a replicated service to be a single primary merely to pass the check.

## Rollback and recovery

Keep the original `8a28bcb` checkout. Before publishing later, capture the actual live web and worker revisions and verify the rollback destination.

Disable new claims and token issuance before rollback. Keep all consumed attempts and their leases across code rollback, database restore and deployment changes. Deleting or restoring away those rows can permit duplicate setup. If a database restore or failover may have lost an acknowledged attempt, leave setup disabled and reconcile every affected identity with Privy before considering reactivation.

A server disable cannot recall a permission already returned to a browser. Its short lifetime bounds that window; the frontend also checks its lease and permission expiry immediately before dispatch. An empty inventory read can become stale if the account changes concurrently outside Eupova. These limits prevent claiming end-to-end exactly-once wallet creation.

## Validation and remaining work

Tests use sample identities in a new loopback PostgreSQL cluster and fake SDK responses. They cover concurrent claims, independent browser journals, new leases, privilege boundaries, expiry while waiting for locks, disable/revocation, unknown COMMIT outcomes and retained claims after immediate shutdown and recovery. The task action log records final counts and the failed test-harness attempts.

No real recovery, key export, wallet creation or browser-to-Privy operation was tested. Three previously recorded SDK advisory families remain unresolved. No current Render database topology or read-only Privy credential was verified here.

Next, prepare the separate wallet-bearing authentication bootstrap, keeping the existing authentication-only path unchanged. Then verify the read-only credential and access-token key, review recovery and re-entry, and run an explicitly authorised short observation test. Real wallet creation needs its own approval after those checks; payment and signing capabilities remain separate.

Final local verification: 593 regression tests passed, zero failed or skipped; the final focused run passed 61 tests. Production build passed. The isolated sample database was stopped, and its evidence was retained.
