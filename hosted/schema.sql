CREATE TABLE IF NOT EXISTS relay_schema(version integer PRIMARY KEY);
CREATE TABLE IF NOT EXISTS relay_sessions (
 token_hash text PRIMARY KEY, owner text NOT NULL, credential_hash text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL DEFAULT (now()+interval '12 hours'), revoked boolean NOT NULL DEFAULT false
);
CREATE TABLE IF NOT EXISTS relay_agents (
 id uuid PRIMARY KEY, owner text NOT NULL, data jsonb NOT NULL,
 address_key text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(owner,address_key)
);
CREATE TABLE IF NOT EXISTS relay_orders (
 id uuid PRIMARY KEY, owner text NOT NULL, request_id uuid NOT NULL,
 request jsonb NOT NULL, result jsonb NOT NULL DEFAULT '{}',
 provider_id text UNIQUE, status text NOT NULL DEFAULT 'checkout_unknown',
 generation bigint NOT NULL DEFAULT 0, lease_token uuid, lease_until timestamptz,
 claimed_at timestamptz, creation_attempted_at timestamptz,
 next_check_at timestamptz, attempts integer NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner,request_id), CHECK(request->>'source'='sandbox'), CHECK(request->>'kind'='checkout')
);
CREATE INDEX IF NOT EXISTS relay_orders_due ON relay_orders(next_check_at);
CREATE INDEX IF NOT EXISTS relay_orders_owner ON relay_orders(owner,created_at DESC);
CREATE OR REPLACE FUNCTION relay_immutable_order() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.id IS DISTINCT FROM OLD.id OR NEW.owner IS DISTINCT FROM OLD.owner
 OR NEW.request_id IS DISTINCT FROM OLD.request_id OR NEW.request IS DISTINCT FROM OLD.request THEN
 RAISE EXCEPTION 'Immutable order intent';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS relay_order_immutable ON relay_orders;
CREATE TRIGGER relay_order_immutable BEFORE UPDATE ON relay_orders FOR EACH ROW EXECUTE FUNCTION relay_immutable_order();
CREATE TABLE IF NOT EXISTS relay_webhooks (
 event_id text PRIMARY KEY, digest text UNIQUE NOT NULL, delivery_id text NOT NULL,
 provider_id text, relay_order_id uuid, event_type text NOT NULL,
 received_at timestamptz NOT NULL DEFAULT now(), processed_at timestamptz,
 CHECK(length(digest)=64)
);
CREATE INDEX IF NOT EXISTS relay_webhooks_pending ON relay_webhooks(provider_id) WHERE processed_at IS NULL;
CREATE TABLE IF NOT EXISTS relay_rate_limits (
 key text PRIMARY KEY, count integer NOT NULL, reset_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS relay_workers (
 id text PRIMARY KEY, beat_at timestamptz NOT NULL DEFAULT now(), version text NOT NULL
);
INSERT INTO relay_schema(version) VALUES(1) ON CONFLICT DO NOTHING;
