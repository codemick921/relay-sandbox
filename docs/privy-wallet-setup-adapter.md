# Buying-wallet setup adapter: prepared, disabled

2 November 2026. Baseline: `e229957`. This checkout adds preparation code only. It is not deployed, and the sample wallet setup at port 4409 is unchanged.

## Implemented

- An inert Privy SDK adapter, separate from the sample controller and the authentication-only screen. Neither production entry imports it. Its build constant is false. Mounting the hook performs no sign-in, token issuance, wallet creation or provider lookup.
- A read-only server observer at `POST /api/buyer-wallet-setup/observe`. With the default configuration it returns 404 before accessing secrets, the database or Privy.
- If separately configured and authorised later, the observer verifies the approved Eupova session, exact opaque subject, Privy DID and pinned ES256 access token, then reads the Privy user record afresh. It rechecks the session and short test authorisation after the asynchronous lookup.
- The observer accepts zero wallets or reports one eligible embedded Ethereum wallet as an unpinned candidate. Extra account types, multiple wallets, missing required fields, delegated/imported wallets and identity mismatches stop the process. A candidate is not quote authorisation, a signature, or proof of recovery.
- The future SDK call is guarded by explicit consent, a fresh development lease, an independently observed empty inventory, a server-owned durable claim contract, same-browser coordination and a one-attempt journal. SDK callback addresses are ignored. A fresh server observation supplies the candidate.
- Timeouts, rejected creation promises and uncertain dispatch outcomes do not permit a retry. The adapter snapshots the lease before awaiting work and checks identity again immediately before its sole SDK operation.
- No schema migration, customer write, automatic pin, creation endpoint or signing endpoint was added. Existing payment flags and the authentication-only flow's rejection of any wallet remain unchanged.

## Preparation is not activation

The production durable claim is deliberately **not implemented**. The adapter requires a dependency that consumes a one-attempt permit atomically before dispatch; the only current implementation is a test fake. A `durable: true` response is a contract, not proof of a database transaction. Local storage and Web Locks are advisory and cannot prevent attempts from another device. There is no production fallback.

The remaining implementation order is:

1. Build a durable, single-use server claim keyed to the approved identity, with concurrency, restart and multi-device tests. Keep its endpoints disabled. It must fail closed after a consumed or uncertain attempt and have no automatic re-arm path.
2. Prepare the wallet-bearing authentication bootstrap separately. Do not weaken the existing authentication-only screen, which intentionally rejects every wallet. A test must still be restricted by owner, subject, DID, origin, expiry and explicit user consent.
3. Verify a genuinely read-only Privy credential, the pinned access-token public key and the live user-response field meanings. The existing signing secret must not be substituted for a read-only credential. No credential was created, read or installed in this task.
4. Resolve recovery, re-entry and key-export behaviour for this development app and installed SDK. The dashboard shows TEE enabled, but that is not evidence of a user-held backup or independent recovery. With custom JWT authentication, access depends on Eupova's identity provider as well as Privy.
5. Run a separately authorised, time-limited read-only observation test. Keep token issuance disabled until its own restricted activation is approved. Verify the exact approved account and zero existing wallets before considering creation.
6. Only after those checks and explicit wallet-creation approval, enable the guarded one-attempt setup test. Observe the outcome independently, resolve unknown results without retrying, and pin a verified address separately before personalised quote use. Payments, checkouts and signatures are separate actions.

## Disabled configuration contract

No environment variables were set or changed. Future read-only observation requires all of:

- `EUPOVA_WALLET_SETUP_OBSERVE_ENABLED=true`, deliberately absent now;
- the existing approved development app ID, environment, verified read-only credential and pinned public JWT verification key;
- `EUPOVA_WALLET_SETUP_TEST_ENROLLMENT` with one approved owner, subject, Privy DID, recorded consent and an absolute expiry no more than 30 minutes after consent. A buying address is forbidden in this record;
- an exact HTTPS same-origin request, current secure Eupova session, Privy access bearer and an empty JSON body.

Recovery evidence can be attached with `EUPOVA_WALLET_RECOVERY_EVIDENCE` and its SHA-256 hash. It is a dated operator assertion bounded to the app and SDK version, not a machine-verified recovery result. Missing or expired evidence reports `not_verified`.

The observer returns only a classified result, optional candidate address, short validity window, hashed context and inert capability flags. It does not retain or return customer identity, tokens, recovery secrets or the raw Privy response. Requests are bounded by size, time and rate. Provider failures produce a generic unavailable result rather than stale ownership data.

## Verification

- Full offline regression run: 559 tests, 549 passed, 10 PostgreSQL-dependent tests skipped, zero failures. This run preceded the final immutable-lease hardening and two additional tests.
- Final focused run: 29 tests, zero failures; includes the lease mutation check and the hosted listener's default-disabled routing boundary. Existing offline tests cover token forgery, pinned keys, access expiry, ownership and session boundaries.
- Production Vite build passed. A separate build compiles the new React adapter with the installed Privy SDK and confirms both new frontend adapter modules are absent from the production module graph. No bundled code is executed by this check.
- No real Privy session, wallet, recovery, export, mobile-device or multi-device test was performed. Existing upstream SDK advisory families remain unresolved; this preparation does not claim to fix them.

Evidence and the complete action log are in the parent task directory. The original `e229957` checkout is retained. Before any later publication, record the then-current Render web and worker revisions; do not assume a local baseline is the live rollback target.
