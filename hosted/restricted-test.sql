-- No policy or attempt is seeded. Only a future separately approved operator action may add a policy.
CREATE TABLE IF NOT EXISTS relay_restricted_policy (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 owner text NOT NULL CHECK(owner ~ '^customer:[a-f0-9-]{36}$'),
 draft_id uuid NOT NULL REFERENCES relay_funding_drafts(id),
 draft_hash text NOT NULL CHECK(length(draft_hash)=64),
 merchant_id text NOT NULL,
 wallet_address text NOT NULL CHECK(wallet_address ~ '^0x[a-f0-9]{40}$'),
 max_total_pence integer NOT NULL CHECK(max_total_pence BETWEEN 200 AND 1000),
 currency text NOT NULL DEFAULT 'GBP' CHECK(currency='GBP'),
 rail text NOT NULL DEFAULT 'wise' CHECK(rail='wise'),
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
 approval_ref text NOT NULL CHECK(length(approval_ref) BETWEEN 1 AND 200),
 wallet_confirmation_ref text NOT NULL CHECK(length(wallet_confirmation_ref) BETWEEN 1 AND 200),
 revoked boolean NOT NULL DEFAULT false,
 CHECK(expires_at>created_at AND expires_at<=created_at+interval '24 hours')
);
CREATE TABLE IF NOT EXISTS relay_restricted_attempt (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 policy_id boolean NOT NULL DEFAULT true REFERENCES relay_restricted_policy(singleton),
 draft_id uuid NOT NULL UNIQUE REFERENCES relay_funding_drafts(id),
 reserved_pence integer NOT NULL CHECK(reserved_pence BETWEEN 200 AND 1000),
 reserved_at timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION relay_restricted_policy_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Restricted policy cannot be deleted'; END IF;
 IF (to_jsonb(NEW)-'revoked') IS DISTINCT FROM (to_jsonb(OLD)-'revoked') OR (OLD.revoked AND NOT NEW.revoked) THEN RAISE EXCEPTION 'Immutable restricted policy'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS restricted_policy_immutable ON relay_restricted_policy;
CREATE TRIGGER restricted_policy_immutable BEFORE UPDATE OR DELETE ON relay_restricted_policy FOR EACH ROW EXECUTE FUNCTION relay_restricted_policy_immutable();
CREATE OR REPLACE FUNCTION relay_restricted_attempt_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Restricted attempt is permanent'; END $$;
DROP TRIGGER IF EXISTS restricted_attempt_immutable ON relay_restricted_attempt;
CREATE TRIGGER restricted_attempt_immutable BEFORE UPDATE OR DELETE ON relay_restricted_attempt FOR EACH ROW EXECUTE FUNCTION relay_restricted_attempt_immutable();
