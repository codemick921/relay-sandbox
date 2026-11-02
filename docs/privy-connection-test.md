# Restricted Privy development connection

This route tests sign-in only. It cannot create wallets, sign messages, send funds, create a Peer checkout or change a customer record. It is off by default. No schema migration is required.

The server requires all three flags: `EUPOVA_BUYER_AUTH_DEV_CONNECTION_ENABLED`, `EUPOVA_BUYER_AUTH_DEV_ENABLED`, and `EUPOVA_BUYER_AUTH_DEV_TOKEN_ENABLED`. Each must be exactly `true`. The existing general token route remains disabled in hosted production. The new route alone issues session-bound tokens after explicit consent.

Use the approved development app ID in `EUPOVA_BUYER_AUTH_APP_ID`, `EUPOVA_BUYER_AUTH_ENVIRONMENT=development`, the approved `EUPOVA_BUYER_AUTH_KEY_ID` and private PKCS8 PEM in Render secret settings only. The private key must match the existing public JWKS. Never put it in source, screenshots, logs or chat. No Privy app secret is used by this browser integration.

`EUPOVA_BUYER_AUTH_TEST_ENROLLMENT` is a private JSON record with owner, subject, consent=true, consentRecordedAt and expiresAt (Unix milliseconds). Use only the previously approved customer and opaque subject. Lease maximum: 30 minutes. Generate it immediately before an agreed test; do not extend it automatically. The external JWT lasts at most 60 seconds, with issuer/audience/subject restricted by Privy development JWT settings.

## Activation checks

1. Deploy the tested commit with flags off. Record exact prior successful web deployment and rollback SHA. Leave worker and every payment/email flag unchanged.
2. Verify public JWKS and disabled routes, health, test count, and no migrations/customer writes. Record the protected-settings fingerprint without displaying values.
3. Recheck Privy development app, issuer, audience, exact subject, allowed origin and automatic-wallet creation off. Obtain required action-time approval for the authentication enablement; explain that a Privy development identity/session may be created.
4. Securely install the already approved matching signing key in web Render secrets; enable only the three new flags and fresh enrolment. No customer allowlist in source code; no worker changes.
5. From the approved signed-in Eupova account open Account security → Open connection test. Before consent, the Privy SDK does not load. Connect, check the matching identity and no wallet linked, then disconnect. No wallet UI/action is offered.
6. Disable connection/token flags after the bounded test and verify 404 responses. Expiry prevents new external tokens. It does not prove immediate remote revocation of credentials previously issued by Privy. Report failed/unconfirmed logout clearly; do not delete users as a rollback shortcut.

## Boundaries

The connection uses SELECT-only customer/session reads; shared rate-limit rows are operational data. No customer login/session last-seen update is performed by these new routes. Status polling is every 15 seconds plus focus/visibility/online. Every token checks the current session and test lease before and after signing. Cross-tab logout broadcasts stop this screen. Browser closure/offline cleanup is best effort, not guaranteed remote revocation.

The new Privy bundle is isolated in a separate HTML entry with an auth-only CSP. Normal application CSP remains unchanged. SDK-managed browser credentials can exist after authentication; Eupova does not write the external JWT to storage, URLs or logs.

Peer live quotes, buyer signing and any later wallet setup require separate implementation and testing. Successful Privy sign-in does not mean those capabilities are ready.
