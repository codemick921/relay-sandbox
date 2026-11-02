# New Privy buying wallet — preparation, not activation

2 November 2026. User chose “Plan a new Privy wallet”. No wallet has been created. Privy dashboard read-only checks showed the Eupova development app has one Custom Auth identity and zero wallets. No live account or payment configuration was changed.

## What each wallet does

- Buying wallet: a user-controlled embedded Ethereum wallet in the existing Privy development identity, for a future Peer direct-protocol buyer flow. Its EVM address can be used on Base; an address alone does not prove Base eligibility, ownership or recipient-platform support.
- Receiving wallet: the existing user-selected agentic receiving address saved in Eupova, owner scoped and restricted to the supported USDC-on-Base route. It stays separate. No replacement or migration of customer wallet records.
- Nothing in this build can sign, reserve an offer, create an intent, open a checkout or send funds. Linked-wallet checks are not a signing test or a guarantee that Peer will offer a route.

## Sequence and action boundaries

1. **Prepared now:** default-disabled server checks, current Privy user lookup, saved-recipient SELECT, before/after quote verification, and offline failure tests. Existing sample preview remains sample-only.
2. **Prepare the creation screen:** a separate, test-account-only frontend using the installed Privy React SDK's user-controlled embedded-wallet workflow. Do not reuse the old authentication-only test as it deliberately rejects linked wallets. Automatic wallet creation stays off. Confirm the SDK's current creation and recovery behaviour before implementing this screen.
3. **Restricted authentication and creation approval:** show the approved account, development app, one Ethereum embedded wallet, user-controlled recovery method, and no delegated signer or server spending authority. Request explicit permission immediately before enabling the timed auth test and creating the wallet. A wallet address cannot be treated as fully reversible: it remains on-chain if later funded even if UI access is removed. No funding or signing during this test.
4. **Verify and pin:** read the created wallet through Privy, confirm the same approved DID/custom-auth subject and user_can_sign=true, no delegation/import. Confirm the address with the user. Put the chosen address in the short-lived test enrollment, never select a different linked wallet automatically.
5. **Read-only credential setup:** obtain a separate Privy read-only app secret and its access-token public verification key. Confirm the secret's access level in Privy; code cannot prove its scope from the secret string. Do not reuse the full-access app secret. Secret stays only in Render secret settings; public key must be Privy's ES256 access-token key, not Eupova's RSA key used to authenticate into Privy. This credential setup requires its own concrete access approval.
6. **Restricted quote test:** with separate approval for address sharing, show both full addresses, then use only read-only Peer quote endpoints. Test available/unavailable offers, refresh, changed terms, expiry, session exit and unlink. Keep the result non-executable. No quote guarantees acceptance or a payment amount until the provider's actual execution requirements are met.
7. **Disable and review:** disable both the new quote flag and token issuance, verify the endpoints fail closed, keep a rollback record, and report observed results before planning any signing or checkout test.

A future request to create the wallet does not authorise payments, deposits, key export, delegation, paid-plan upgrades, general customer access or provider support contact.

## Configuration prepared but not installed

All new values remain absent in Render. The only enable flag is EUPOVA_PERSONALISED_QUOTE_DEV_ENABLED; missing or false hides all three new routes.

- EUPOVA_PRIVY_QUOTE_APP_ID: existing pinned development app.
- EUPOVA_PRIVY_QUOTE_ENVIRONMENT: development.
- EUPOVA_PRIVY_QUOTE_CREDENTIAL_ACCESS: read-only (operator assertion, verify in dashboard).
- EUPOVA_PRIVY_QUOTE_READONLY_SECRET: a new restricted secret, not the prior full-access secret.
- EUPOVA_PRIVY_ACCESS_PUBLIC_JWKS: independently obtained public ES256/P-256 verification key, with pinned key ID.
- EUPOVA_PERSONALISED_QUOTE_TEST_ENROLLMENT: exactly one owner, existing opaque subject, verified Privy DID, explicit buying address, consent timestamp and absolute expiry. Maximum 30 minutes; plan a 10-minute first test.

The quote flag cannot issue authentication tokens. Existing token-issuance switches are separate and stay disabled.

## What is still unverified

- Actual new wallet creation and recovery under the existing custom-auth identity.
- Real Privy access JWT/header/key format and exact linked-account fields for this new wallet.
- Read-only secret availability, installation and live GET behaviour/rate limits.
- Peer personalised quote eligibility and pricing for the actual buying/receiving pair.
- Signing, reservation, payment, settlement and recipient-platform spendability.
- Privy session logout/revocation is not instantaneously visible to offline JWT verification. The resolver rechecks the Eupova session, current Privy links and a 60-second proof window, but does not claim atomic upstream revocation. An authenticated wallet link is not proof of current possession.
- Browser access and physical iPhone behaviour for a new real-wallet screen: not tested because that screen is not built or enabled yet.

No migration, customer reset, email send, wallet mutation or payment-settings change is part of this preparation.

## Prepared route contract

POST /api/funding-calculator/personalised/context accepts only receivingWalletId. Quotes and review accept the existing calculator fields plus the reviewed contextId and shareAddresses:true; review also requires offerId. Browser-submitted owners, subjects, DIDs and wallet addresses are rejected.

Requests require the current Eupova secure session cookie, an independently verified Privy access token in Authorization: Bearer, HTTPS and same-origin browser headers. The access token is not persisted or logged. Context resolution uses current-user GET on every check, without provider retries. A read error clears the session's in-memory proof. Unchanged polling does not extend the 60-second window. Token refresh, wallet/session/recipient changes require a new address review. A fresh quote still has eligibility:not_verified, reserved:false and canCreatePayment:false.

No frontend was switched to these routes in this preparation. The existing sample preview continues to use sample responses. No migration is added.
