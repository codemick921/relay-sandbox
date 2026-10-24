ALTER TABLE relay_agents ADD COLUMN IF NOT EXISTS funding_revision bigint NOT NULL DEFAULT 1;
CREATE OR REPLACE FUNCTION relay_funding_wallet_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 NEW.funding_revision := OLD.funding_revision + CASE WHEN NEW.data IS DISTINCT FROM OLD.data OR NEW.owner IS DISTINCT FROM OLD.owner THEN 1 ELSE 0 END;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS relay_funding_wallet_changed ON relay_agents;
CREATE TRIGGER relay_funding_wallet_changed BEFORE UPDATE ON relay_agents FOR EACH ROW EXECUTE FUNCTION relay_funding_wallet_revision();
-- Local intent preparation. No provider call or receipt is represented by a draft.
CREATE TABLE IF NOT EXISTS relay_funding_drafts (
 id uuid PRIMARY KEY, owner text NOT NULL, request_id uuid NOT NULL,
 agent_id uuid NOT NULL, agent_revision bigint NOT NULL, agent jsonb NOT NULL, pence integer NOT NULL CHECK(pence BETWEEN 200 AND 100000),
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','cancelled','creating','unresolved','bound','closed')),
 merchant_id text, attempt_token uuid, attempted_at timestamptz,
 provider_id text, candidate_provider_id text, requested_usdc text, checkout_url text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner,request_id), UNIQUE(merchant_id,provider_id),
 CHECK((attempt_token IS NULL)=(attempted_at IS NULL)),
 CHECK(status NOT IN ('creating','unresolved','bound','closed') OR (attempt_token IS NOT NULL AND merchant_id IS NOT NULL)),
 CHECK(status NOT IN ('bound','closed') OR (provider_id IS NOT NULL AND requested_usdc IS NOT NULL))
);
ALTER TABLE relay_funding_drafts ADD COLUMN IF NOT EXISTS rail text NOT NULL DEFAULT 'wise' CHECK(rail IN ('wise','revolut'));
ALTER TABLE relay_funding_drafts DROP CONSTRAINT IF EXISTS relay_funding_drafts_pence_check;
ALTER TABLE relay_funding_drafts ADD CONSTRAINT relay_funding_drafts_pence_check CHECK((rail='wise' AND pence BETWEEN 200 AND 100000) OR (rail='revolut' AND pence BETWEEN 1 AND 1000));
ALTER TABLE relay_funding_drafts ADD COLUMN IF NOT EXISTS superseded_by uuid REFERENCES relay_funding_drafts(id) DEFERRABLE INITIALLY DEFERRED;
DROP INDEX IF EXISTS relay_funding_one_active;
CREATE UNIQUE INDEX relay_funding_one_active ON relay_funding_drafts(owner) WHERE status NOT IN ('cancelled','closed') AND superseded_by IS NULL;
CREATE TABLE IF NOT EXISTS relay_funding_audit (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, draft_id uuid NOT NULL REFERENCES relay_funding_drafts(id),
 event text NOT NULL, at timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION relay_funding_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.superseded_by IS DISTINCT FROM OLD.superseded_by AND (OLD.superseded_by IS NOT NULL OR OLD.status<>'bound' OR NEW.status<>'bound' OR NEW.superseded_by=OLD.id) THEN RAISE EXCEPTION 'Immutable supersession'; END IF;
 IF NEW.id IS DISTINCT FROM OLD.id OR NEW.owner IS DISTINCT FROM OLD.owner OR NEW.request_id IS DISTINCT FROM OLD.request_id
 OR NEW.rail IS DISTINCT FROM OLD.rail OR NEW.agent_revision IS DISTINCT FROM OLD.agent_revision OR NEW.agent_id IS DISTINCT FROM OLD.agent_id OR NEW.agent IS DISTINCT FROM OLD.agent OR NEW.pence IS DISTINCT FROM OLD.pence
 OR (OLD.attempt_token IS NOT NULL AND (NEW.attempt_token IS DISTINCT FROM OLD.attempt_token OR NEW.merchant_id IS DISTINCT FROM OLD.merchant_id OR NEW.attempted_at IS DISTINCT FROM OLD.attempted_at))
 OR (OLD.provider_id IS NOT NULL AND (NEW.provider_id IS DISTINCT FROM OLD.provider_id OR NEW.requested_usdc IS DISTINCT FROM OLD.requested_usdc))
 THEN RAISE EXCEPTION 'Immutable funding intent'; END IF;
 IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
   (OLD.status='draft' AND NEW.status IN ('cancelled','creating')) OR
   (OLD.status='creating' AND NEW.status IN ('unresolved','bound')) OR
   (OLD.status='unresolved' AND NEW.status='bound') OR
   (OLD.status='bound' AND NEW.status='closed')
 ) THEN RAISE EXCEPTION 'Invalid funding transition'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS relay_funding_guard ON relay_funding_drafts;
CREATE TRIGGER relay_funding_guard BEFORE UPDATE ON relay_funding_drafts FOR EACH ROW EXECUTE FUNCTION relay_funding_immutable();
