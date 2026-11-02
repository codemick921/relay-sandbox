# Privy development connection screen

This release prepares the restricted Account security screen and its read-only eligibility check. It does not implement or activate real Privy authentication. No Privy SDK is loaded by this screen, no token is requested, and it cannot create a wallet or payment.

## Runtime defaults

`EUPOVA_BUYER_AUTH_DEV_PANEL_ENABLED` defaults off. With that setting absent, GET `/api/buyer-auth/status` returns 404 before reading configuration, a signing key or the database. Account security omits the card. No environment setting is changed by deployment.

To expose the disabled card in a separately authorised development test, the server would require the panel flag, the existing exact development app ID/environment and a valid `EUPOVA_BUYER_AUTH_TEST_ENROLLMENT` lease. Enrolment must bind the approved existing owner and stable opaque subject, with consent and a maximum 24-hour duration. Do not regenerate the subject or store an email allowlist in client code. The route reads customer/session validity using SELECT only, including email verification, revocation, version, idle timeout and expiry. It checks enrolment and rechecks the session before returning a minimal no-store response.

The two existing issuance flags stay off. If actual token issuance is enabled unexpectedly, this version refuses to present a connection as available. No private key is needed for screen eligibility. The public JWKS remains unchanged.

## UI and local preview

The existing Account security page contains `BuyerConnection`. It shows only a disabled card after an eligible response. A 404, expired lease or session-expired event hides it. Requests are aborted when leaving the screen; errors cannot enable connection.

`BuyerConnectionCard` also accepts sample rendering props for an isolated preview. The sample adapter is under tests/fixtures and the sample entry is untracked and excluded from the production entry. No preview endpoint, scenario picker or sample adapter is included in the production bundle. Sample connection, rejection, failure, expiry and disconnect represent UI behaviour only, not provider acceptance. Cancelling/closing discards pending sample results.

## Required before a real authentication test

1. Integrate Privy's current supported React custom-JWT synchronisation behind explicit tester consent and server authorisation. Load the provider only for the permitted test; keep automatic wallet creation off. Use `useSubscribeToJwtAuthWithFlag` and keep session synchronisation alive for the actual provider lifetime.
2. Implement and verify logout, account-switch and lease-expiry handling, including provider session cleanup. A short-lived Eupova JWT does not itself revoke an already-issued Privy session. Never claim server-side revocation based on local UI removal.
3. Prepare a fresh, bounded test lease and a concrete rollback. Verify the development app audience, issuer and subject restrictions. Enabling token issuance and creating a Privy test identity/session require the user's next explicit approval; wallet creation, signing and payment remain separate.
4. Verify the provider result without logging JWTs or placing credentials in URLs/storage. Peer buyer-token acceptance and signing eligibility remain unproven and need their own checks.

Official integration guidance: https://docs.privy.io/authentication/user-authentication/jwt-based-auth/usage . No private information was sent to a research service for this change.
