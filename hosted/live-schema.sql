-- Separate from sandbox tables. Installed only by the explicit tracking store.
CREATE TABLE IF NOT EXISTS relay_live_orders (
 id uuid PRIMARY KEY, owner text NOT NULL, merchant_id text NOT NULL,
 provider_id text NOT NULL, request jsonb NOT NULL, result jsonb NOT NULL DEFAULT '{}',
 status text NOT NULL DEFAULT 'checkout_ready', review_required boolean NOT NULL DEFAULT false,
 generation bigint NOT NULL DEFAULT 0, lease_token uuid, lease_until timestamptz,
 claimed_at timestamptz, claimed_event_ids text[] NOT NULL DEFAULT '{}',
 next_check_at timestamptz NOT NULL DEFAULT now(),
 attempts integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(merchant_id,provider_id),
 CHECK ((request->>'source') IS NOT DISTINCT FROM 'live'),
 CHECK ((request->>'kind') IS NOT DISTINCT FROM 'checkout'),
 CHECK ((request->>'id') IS NOT DISTINCT FROM id::text),
 CHECK ((request->>'merchantId') IS NOT DISTINCT FROM merchant_id),
 CHECK ((request->>'providerOrderId') IS NOT DISTINCT FROM provider_id)
);
CREATE OR REPLACE FUNCTION relay_live_immutable_order() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.id IS DISTINCT FROM OLD.id OR NEW.owner IS DISTINCT FROM OLD.owner
 OR NEW.merchant_id IS DISTINCT FROM OLD.merchant_id OR NEW.provider_id IS DISTINCT FROM OLD.provider_id
 OR NEW.request IS DISTINCT FROM OLD.request THEN RAISE EXCEPTION 'Immutable live order binding'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS relay_live_order_immutable ON relay_live_orders;
CREATE TRIGGER relay_live_order_immutable BEFORE UPDATE ON relay_live_orders FOR EACH ROW EXECUTE FUNCTION relay_live_immutable_order();
CREATE INDEX IF NOT EXISTS relay_live_due ON relay_live_orders(next_check_at);
CREATE INDEX IF NOT EXISTS relay_live_owner ON relay_live_orders(owner,created_at DESC);
CREATE TABLE IF NOT EXISTS relay_live_payments (
 merchant_id text NOT NULL, payment_id text NOT NULL, order_id uuid NOT NULL REFERENCES relay_live_orders(id),
 chain_id integer NOT NULL CHECK(chain_id=8453), token_address text NOT NULL,
 recipient text NOT NULL, amount_raw bigint NOT NULL CHECK(amount_raw>0),
 intent_hash text NOT NULL, transaction_hash text NOT NULL,
 receipt jsonb, finalized boolean NOT NULL DEFAULT false,
 PRIMARY KEY(merchant_id,payment_id), UNIQUE(chain_id,intent_hash), UNIQUE(chain_id,transaction_hash)
);
CREATE TABLE IF NOT EXISTS relay_live_webhooks (
 merchant_id text NOT NULL, event_id text NOT NULL, digest text NOT NULL CHECK(length(digest)=64),
 delivery_id text NOT NULL, provider_id text, event_type text NOT NULL,
 received_at timestamptz NOT NULL DEFAULT clock_timestamp(), processed_at timestamptz,
 PRIMARY KEY(merchant_id,event_id), UNIQUE(merchant_id,digest)
);
CREATE INDEX IF NOT EXISTS relay_live_inbox ON relay_live_webhooks(merchant_id,provider_id) WHERE processed_at IS NULL;
CREATE TABLE IF NOT EXISTS relay_live_audit (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 order_id uuid NOT NULL REFERENCES relay_live_orders(id), at timestamptz NOT NULL DEFAULT now(),
 event text NOT NULL, data jsonb NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS relay_live_workers (
 merchant_id text NOT NULL, id text NOT NULL, beat_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(merchant_id,id)
);

ALTER TABLE relay_live_webhooks ADD COLUMN IF NOT EXISTS unmatched boolean NOT NULL DEFAULT false;
