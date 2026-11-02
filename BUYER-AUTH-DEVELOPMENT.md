# Disabled buyer authentication endpoints

The default release returns 404 for GET /api/buyer-auth/jwks and POST /api/buyer-auth/token. It does not contact Privy, create users/wallets, or change payment settings.

EUPOVA_BUYER_AUTH_DEV_ENABLED controls the route. EUPOVA_BUYER_AUTH_DEV_TOKEN_ENABLED independently controls token issuance. Both default OFF. Keep both unset/false for the initial deployment. Missing or invalid configuration fails closed on these routes only.

Activation requires the exact approved development app ID, EUPOVA_BUYER_AUTH_ENVIRONMENT=development, a dedicated RSA private signing key in EUPOVA_BUYER_AUTH_SIGNING_KEY_PEM, a stable key ID, and EUPOVA_BUYER_AUTH_TEST_ENROLLMENT containing one owner, distinct opaque subject, explicit consent and a maximum 24-hour timestamp lease. Never commit those secrets or the real enrolment. The subject must remain bound to its original owner across email/key changes. Recheck the Privy dashboard is still in development; the config label is not a remote-mode check.

Session reads use SELECT only and require verified email, current account/session version, no revocation/disablement, unexpired session and recent activity. Shared throttles write only relay_rate_limits. Tokens contain no email, customer ID or receiving wallet; TTL is at most 60 seconds. No frontend wallet SDK is added.

Test the public verification configuration first, with token issuance OFF. Configure issuer and audience restrictions in Privy. Do not assume an expired issuer token revokes an already-created Privy session. No provider session should be created in this deployment task.

Rollback: disable both new flags; if Privy trust is configured later, disable its JWT integration separately. Redeploy the preceding successful release without restoring the customer database or changing payment flags. The pre-release recovery point is commit 4fbb15af14d88471dc9b85a51b28d7c1efe1a51e / Render deploy dep-dbjvaltg1s2s738rnss0. Verify its retained build before rollback.
