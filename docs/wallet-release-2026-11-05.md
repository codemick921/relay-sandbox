# Customer wallet release — 5 November 2026

Adds a visible Circle user-controlled Base wallet, same-wallet Pay on Eupova funding, USDC send/receive and activity, individually approved CLI payment requests with customer allowances, and Base-to-Arc CCTP forwarding to an explicit destination. Existing Eupova navigation, branding and funding components are preserved; wallet controls are added separately.

Arc Studio produced the implementation through R8. After its daily limit, the owner authorised Codex completion. Final corrections bind smart-account transaction events and provider identity, refuse an unverified Base smart-account address as an Arc destination, and deny disabled/unverified customer CLI access. TypeScript is pinned to 5.9.3 to satisfy the existing dependencies. Production credentials remain in Render.

Validation: full isolated PostgreSQL run: 859 tests; 857 passed, 1 failed, 1 existing native guard skipped. The sole failure was a positive test missing the new explicit destination confirmation; corrected fixture and all 18 bridge tests passed. Focused 32-test review and 10 transport tests passed. Production Vite build passed. Read-only deploy check rejects incomplete live settings. No production wallet, payment or bridge transaction was performed by these tests.

Render pre-deploy checks the configured Circle key with a read-only API request, without printing secrets. On failure the running release remains. Source rollback baseline: 4fd9dc9080e035e2cc0cfe5b83cf078db18fe379. Code rollback cannot undo database records or on-chain actions.

Still requiring production verification: Circle browser/PIN setup, owner-created live wallet, funding receipt, customer-approved send, CLI request/approval and Base-to-Arc arrival. Deployment alone is not evidence these flows succeeded.
