-- Additive only. Never rewrites account, payment or saved-wallet data.
CREATE TABLE IF NOT EXISTS relay_agent_funding_requests (
 id uuid PRIMARY KEY,
 owner text NOT NULL,
 request_key uuid NOT NULL,
 agent_id uuid NOT NULL,
 agent jsonb NOT NULL,
 agent_revision bigint NOT NULL,
 purpose text NOT NULL CHECK (length(purpose) BETWEEN 3 AND 240),
 target_raw numeric(18,0) NOT NULL CHECK (target_raw > 0 AND target_raw <= 100000000000),
 expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 cancelled_at timestamptz,
 draft_id uuid UNIQUE REFERENCES relay_funding_drafts(id),
 UNIQUE(owner,request_key),
 CHECK (NOT (cancelled_at IS NOT NULL AND draft_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS relay_agent_requests_owner ON relay_agent_funding_requests(owner,created_at DESC);
CREATE OR REPLACE FUNCTION relay_agent_request_immutable() RETURNS trigger AS $$
BEGIN
 IF (to_jsonb(NEW)->'source_connection_id') IS DISTINCT FROM (to_jsonb(OLD)->'source_connection_id') OR (to_jsonb(NEW)->'source_name') IS DISTINCT FROM (to_jsonb(OLD)->'source_name') OR ROW(NEW.id,NEW.owner,NEW.request_key,NEW.agent_id,NEW.agent,NEW.agent_revision,NEW.purpose,NEW.target_raw,NEW.expires_at,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.owner,OLD.request_key,OLD.agent_id,OLD.agent,OLD.agent_revision,OLD.purpose,OLD.target_raw,OLD.expires_at,OLD.created_at)
 OR (OLD.draft_id IS NOT NULL AND NEW.draft_id IS DISTINCT FROM OLD.draft_id)
 OR (OLD.cancelled_at IS NOT NULL AND NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at)
 THEN RAISE EXCEPTION 'Immutable agent funding request'; END IF;
 RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS relay_agent_request_immutable_trigger ON relay_agent_funding_requests;
CREATE TRIGGER relay_agent_request_immutable_trigger BEFORE UPDATE ON relay_agent_funding_requests FOR EACH ROW EXECUTE FUNCTION relay_agent_request_immutable();
