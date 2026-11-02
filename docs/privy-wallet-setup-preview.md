# Buying wallet setup preview

This is a sample-only local implementation, not a live Privy wallet-creation route. Run `node scripts/preview-wallet-setup.mjs` from this checkout, then open http://127.0.0.1:4409/. Vite does not load .env, the normal proxy or hosted routes. No SDK, private keys, auth tokens, database connection or provider request is used. Do not publish the scenario controls as customer navigation.

## Flow
1. Check the sample account for an existing buying wallet.
2. Explicit sample confirmation before an attempt. Existing wallets are reused.
3. Recheck sample account, buying wallet and receiving destination.
4. Review both addresses and opt in to the sample quote comparison.
5. Compare estimates and review the selected funding plan. Payment stays unavailable.

Nine scenarios cover a new wallet, an existing wallet, user cancellation, confirmed creation failure, uncertain result, expired session, account mismatch, verification failure and slow response/reload.

The local server stores fixtures in memory per HttpOnly sample cookie. Multiple tabs share one scenario and creation attempt. Reload checks state, never automatically creates. Restart sample deliberately resets only in-memory sample data. A server restart resets all fixtures. No real recovery promise is made.

## Safety and test design
`wallet-setup-state.mjs` accepts only a sample driver. It prevents double submit, ignores late callbacks, clears consent and quote context on changes and expiry, and reconciles uncertain attempts through a read-only check. The local fixture rejects expired quote contexts, simulates the same quote verification service used by earlier work, and never calls Peer.

The preview middleware binds loopback, checks Host/Origin/content type/size/rate and rejects all /api routes. The page CSP permits local resources only. A separate build inspection confirms the sample build includes no Privy SDK or live authentication module.

## Before a real restricted test
This change alone cannot be enabled by toggling an environment flag. The real SDK adapter is still to be connected. First inspect and document the Privy app's actual recovery options, test-user wallet ownership mode and existing wallet state. Address the remaining upstream dependency advisory risks before broader use.

Then prepare the separate live adapter using the installed SDK's supported public API: keep Ethereum/Solana createOnLogin off; retain Eupova custom-auth subscription; createWallet({createAdditional:false}); omit additional signers and automatic wallet migration. Do not weaken the existing auth-only screen's no-wallet check.

Use the existing disabled backend verifier to independently validate the access token, Privy user links, owner/subject/DID, approved buying address and saved receiving address. Install only the narrowly scoped required credentials, with explicit activation authority; do not expose them in client code. Do not treat the local sample check as proof of provider authentication, ownership or receiving-platform compatibility.

A real test needs explicit approval to create one user-controlled development wallet for the approved account and a bounded authentication window. Creation is persistent: switching flags off or rolling back software does not delete a wallet. No checkout, signature, reservation or payment belongs in that test. A later personalised quote test requires its own approved address-sharing scope.
