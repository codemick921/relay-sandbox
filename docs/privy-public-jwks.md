# Public development buyer-auth key

`GET /.well-known/eupova-buyer-auth-jwks.json` (and HEAD) publishes only the approved RSA public verification key for Eupova's Privy development app. It works without a customer session, database call, private key or identity enrolment. Query parameters and writes are rejected. The normal canonical-host and HTTPS checks still apply.

This endpoint does **not** enable either `/api/buyer-auth/jwks` or `/api/buyer-auth/token`. Keep both `EUPOVA_BUYER_AUTH_DEV_ENABLED` and `EUPOVA_BUYER_AUTH_DEV_TOKEN_ENABLED` unset/false. No payment settings or database schemas change.

The matching private key is held offline and is not included in this repository or installed in Render. Public key publication does not issue a JWT or create a Privy user, wallet or checkout.

## Provider configuration
Use the public HTTPS URL in the **development** app, with user ID claim `sub`, exact Eupova issuer, the exact app audience and the separately approved sole test subject. Require claim restrictions. Keep server-side JWT authentication and automatic wallet creation disabled. The private test identity is not committed to this repository. Verify settings after a reload before reporting success.

## Rollback and rotation
Disable JWT authentication in the Privy development dashboard first, then redeploy the preceding successful Render release `1ba2cbee01262c54235be027e9d7301302d624df` (`dep-dbk1b2dg1s2s73910alg`). No data migration or environment rollback is needed. Caches may retain public material; disabling provider trust is the revocation control. The JWK has no intrinsic expiry, so any future rotation needs an explicit key/claim rollout and verification. Do not assume certificate expiry removes JWKS trust.

Future token issuance requires a separate authorised step, a fresh test enrolment, guarded secret installation and the existing opt-in flags. This release deliberately does not perform those steps.
