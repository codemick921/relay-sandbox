-- Manual activation only. Never imported by startup migrations.
-- Separate registry: no updates to relay_customers, wallets, payments or sessions.
BEGIN;
CREATE SCHEMA IF NOT EXISTS eupova_native_auth;
REVOKE ALL ON SCHEMA eupova_native_auth FROM PUBLIC;
CREATE TABLE IF NOT EXISTS eupova_native_auth.intents (
 nonce_hash text PRIMARY KEY CHECK(nonce_hash ~ '^[a-f0-9]{64}$'),
 app_id text NOT NULL, owner text NOT NULL, binding text NOT NULL,
 expires_at timestamptz NOT NULL, consumed_at timestamptz,
 did text, sid_hash text, fingerprint text, address text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(expires_at > created_at AND expires_at <= created_at + interval '5 minutes')
);
CREATE TABLE IF NOT EXISTS eupova_native_auth.links (
 app_id text NOT NULL, owner text NOT NULL, did text NOT NULL,
 sid_hash text NOT NULL, fingerprint text NOT NULL, address text,
 consent_version text NOT NULL, linked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(app_id,owner), UNIQUE(app_id,did)
);
REVOKE ALL ON ALL TABLES IN SCHEMA eupova_native_auth FROM PUBLIC;
COMMIT;
-- Dedicated runtime role: schema USAGE; SELECT/INSERT on links (no UPDATE/DELETE);
-- SELECT/INSERT and UPDATE(did,sid_hash,fingerprint,address,consumed_at) on intents.
-- No customer/payment table write privileges. Do not grant a broad owner role.
