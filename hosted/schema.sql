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

-- Additive customer accounts. Tester labels and their saved data are not migrated.
CREATE TABLE IF NOT EXISTS relay_customers (
 id uuid PRIMARY KEY, email text UNIQUE NOT NULL, name text NOT NULL,
 password_hash text NOT NULL, recovery_hash text NOT NULL,
 version integer NOT NULL DEFAULT 1, disabled boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS relay_customer_sessions (
 token_hash text PRIMARY KEY, customer_id uuid NOT NULL REFERENCES relay_customers(id),
 version integer NOT NULL, revoked boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL DEFAULT (now()+interval '12 hours')
);
CREATE INDEX IF NOT EXISTS relay_customer_sessions_customer ON relay_customer_sessions(customer_id);
INSERT INTO relay_schema(version) VALUES(2) ON CONFLICT DO NOTHING;

-- No plaintext email tokens or links are persisted, including queued mail.
ALTER TABLE relay_customers ADD COLUMN IF NOT EXISTS email_verified_at timestamptz;
CREATE TABLE IF NOT EXISTS relay_account_mail (
 id uuid PRIMARY KEY, customer_id uuid NOT NULL REFERENCES relay_customers(id),
 purpose text NOT NULL CHECK(purpose IN ('verify','reset','changed')),
 version integer NOT NULL, state text NOT NULL DEFAULT 'queued'
 CHECK(state IN ('queued','sending','accepted','unknown','suppressed')),
 token_hash text UNIQUE, expires_at timestamptz, consumed_at timestamptz,
 provider_id text, created_at timestamptz NOT NULL DEFAULT now(), attempted_at timestamptz
);
CREATE INDEX IF NOT EXISTS relay_account_mail_customer ON relay_account_mail(customer_id,created_at DESC);
INSERT INTO relay_schema(version) VALUES(3) ON CONFLICT DO NOTHING;

-- Public session references are separate from authentication-token hashes.
ALTER TABLE relay_customer_sessions ADD COLUMN IF NOT EXISTS session_id uuid NOT NULL DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX IF NOT EXISTS relay_customer_sessions_public_id ON relay_customer_sessions(session_id);
ALTER TABLE relay_customer_sessions ADD COLUMN IF NOT EXISTS client_label text NOT NULL DEFAULT 'Browser session';
ALTER TABLE relay_customers ADD COLUMN IF NOT EXISTS recovery_saved_at timestamptz;
ALTER TABLE relay_customers ADD COLUMN IF NOT EXISTS recovery_rotated_at timestamptz NOT NULL DEFAULT now();
CREATE TABLE IF NOT EXISTS relay_security_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_id uuid NOT NULL REFERENCES relay_customers(id),
 event text NOT NULL, details jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS relay_security_events_customer ON relay_security_events(customer_id,created_at DESC);
INSERT INTO relay_schema(version) VALUES(4) ON CONFLICT DO NOTHING;

-- Optional profile image only; existing customer credentials and funding records are untouched.
CREATE TABLE IF NOT EXISTS relay_customer_profiles (
 customer_id uuid PRIMARY KEY REFERENCES relay_customers(id),
 picture text CHECK(picture IS NULL OR length(picture)<=110000),
 updated_at timestamptz NOT NULL DEFAULT now()
);
