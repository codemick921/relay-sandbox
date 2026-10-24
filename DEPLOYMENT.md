# Relay hosted sandbox

Private test deployment: Render Starter web service, Starter worker and 256 MB PostgreSQL in Frankfurt. Sandbox only; no real payments or wallet transfers. Server binds Render's PORT and serves the built React app. The separate worker independently checks Peer after signed webhooks and on a periodic schedule.

## Configuration

Use render.yaml. Supply the existing Peer sandbox API key, sandbox merchant ID and webhook secret as secret environment values. Never commit credentials. SANDBOX_TESTERS is a JSON array of {label,sha256hex}; each tester uses a unique random code whose SHA-256 hash is stored here. Codes are shared privately. Changing a hash revokes that tester's sessions. No live keys are permitted. PUBLIC_ORIGIN defaults to RENDER_EXTERNAL_URL.

The database has no public IP access, 1 GB storage, and storage autoscaling disabled. Automatic deployment is off. Verify tests before deploying a new commit; deploy both web and worker. Keep the workspace on Hobby and review current charges before creation.

## Validation and operation

npm test uses an embedded PostgreSQL-compatible engine locally. Set TEST_DATABASE_URL to a disposable real PostgreSQL database to enable concurrent-worker tests. GitHub CI starts PostgreSQL 18 and runs the full suite plus the frontend build. Tests create and remove only randomly named schemas in that database.

GET /healthz confirms database reachability. Authenticated /api/state includes worker heartbeat health. Never interpret sandbox_complete as on-chain delivery. Live, practice, RPC proxy and browser-signing endpoints are absent from the hosted server.

Point the existing Peer SANDBOX webhook to https://YOUR_RENDER_HOST/api/webhooks/peer/sandbox only after health and authentication checks pass. Test its delivery, then create and complete a sandbox checkout and verify the worker's independently read status. Preserve the old webhook URL for rollback. Do not create duplicate subscriptions.

Order intents are immutable and persisted before remote creation. Uncertain creation is not automatically repeated: a signed webhook carrying the local order ID can locate the original remote order, which is independently validated. Without that evidence, the order remains held for operator reconciliation. A replay may not recover a private checkout link. Do not delete held orders or create replacements until reconciliation.

Both processes use leased jobs and generation checks; stale workers cannot overwrite newer results. Provider failures retain the last verified state and back off. Signed events are deduplicated by signed event ID and body digest; delivery headers do not establish identity.

## Recovery limits

The Mac's historical JSON sessions are not imported. Hosted data is separate. Source rollback is by redeploying a verified commit compatible with schema version 1; do not drop the database. This initial schema migration is additive. Render database backup availability and retention must be checked in the deployed account before relying on it. The prototype is not approved for public live-money use.
