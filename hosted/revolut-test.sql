CREATE TABLE IF NOT EXISTS relay_revolut_policy (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 owner text NOT NULL CHECK(owner ~ '^customer:[a-f0-9-]{36}$'),
 draft_id uuid NOT NULL UNIQUE REFERENCES relay_funding_drafts(id),
 draft_hash text NOT NULL CHECK(length(draft_hash)=64),
 merchant_id text NOT NULL,
 wallet_address text NOT NULL CHECK(wallet_address ~ '^0x[a-f0-9]{40}$'),
 max_total_pence integer NOT NULL CHECK(max_total_pence BETWEEN 200 AND 1000),
 rail text NOT NULL DEFAULT 'revolut' CHECK(rail='revolut'),
 funding_source text NOT NULL DEFAULT 'existing_gbp_balance' CHECK(funding_source='existing_gbp_balance'),
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
 approval_ref text NOT NULL CHECK(length(approval_ref) BETWEEN 1 AND 200),
 consent_ref text NOT NULL CHECK(length(consent_ref) BETWEEN 1 AND 200),
 revoked boolean NOT NULL DEFAULT false,
 CHECK(expires_at>created_at AND expires_at<=created_at+interval '24 hours')
);
CREATE TABLE IF NOT EXISTS relay_revolut_attempt (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 policy_id boolean NOT NULL DEFAULT true REFERENCES relay_revolut_policy(singleton),
 draft_id uuid NOT NULL UNIQUE REFERENCES relay_funding_drafts(id),
 reserved_pence integer NOT NULL CHECK(reserved_pence BETWEEN 200 AND 1000),
 reserved_at timestamptz NOT NULL DEFAULT now()
);
DROP TRIGGER IF EXISTS revolut_policy_immutable ON relay_revolut_policy;
CREATE TRIGGER revolut_policy_immutable BEFORE UPDATE OR DELETE ON relay_revolut_policy FOR EACH ROW EXECUTE FUNCTION relay_restricted_policy_immutable();
DROP TRIGGER IF EXISTS revolut_attempt_immutable ON relay_revolut_attempt;
CREATE TRIGGER revolut_attempt_immutable BEFORE UPDATE OR DELETE ON relay_revolut_attempt FOR EACH ROW EXECUTE FUNCTION relay_restricted_attempt_immutable();

-- A separately authorised second test, never a reset of the first reservation.
CREATE TABLE IF NOT EXISTS relay_revolut_replacement_policy (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 parent_policy boolean NOT NULL DEFAULT true REFERENCES relay_revolut_policy(singleton) CHECK(parent_policy),
 parent_attempt boolean NOT NULL DEFAULT true REFERENCES relay_revolut_attempt(singleton) CHECK(parent_attempt),
 old_draft_id uuid NOT NULL UNIQUE REFERENCES relay_funding_drafts(id),
 draft_id uuid NOT NULL UNIQUE REFERENCES relay_funding_drafts(id),
 owner text NOT NULL, draft_hash text NOT NULL CHECK(length(draft_hash)=64),
 merchant_id text NOT NULL, wallet_address text NOT NULL,
 old_exposure_pence integer NOT NULL CHECK(old_exposure_pence=194),
 principal_pence integer NOT NULL CHECK(principal_pence=83),
 max_total_pence integer NOT NULL CHECK(max_total_pence=1000),
 blocked_recipient_hash text NOT NULL CHECK(length(blocked_recipient_hash)=64),
 preflight_hash text NOT NULL CHECK(length(preflight_hash)=64),
 rail text NOT NULL DEFAULT 'revolut' CHECK(rail='revolut'),
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
 approval_ref text NOT NULL CHECK(length(approval_ref) BETWEEN 1 AND 200),
 consent_ref text NOT NULL CHECK(length(consent_ref) BETWEEN 1 AND 200),
 revoked boolean NOT NULL DEFAULT false,
 CHECK(old_draft_id<>draft_id), CHECK(old_exposure_pence+principal_pence<=max_total_pence),
 CHECK(expires_at>created_at AND expires_at<=created_at+interval '24 hours')
);
CREATE TABLE IF NOT EXISTS relay_revolut_replacement_attempt (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 policy_id boolean NOT NULL DEFAULT true REFERENCES relay_revolut_replacement_policy(singleton),
 draft_id uuid NOT NULL UNIQUE REFERENCES relay_funding_drafts(id),
 reserved_pence integer NOT NULL CHECK(reserved_pence=83),
 reserved_at timestamptz NOT NULL DEFAULT now()
);
DROP TRIGGER IF EXISTS revolut_replacement_policy_immutable ON relay_revolut_replacement_policy;
CREATE TRIGGER revolut_replacement_policy_immutable BEFORE UPDATE OR DELETE ON relay_revolut_replacement_policy FOR EACH ROW EXECUTE FUNCTION relay_restricted_policy_immutable();
DROP TRIGGER IF EXISTS revolut_replacement_attempt_immutable ON relay_revolut_replacement_attempt;
CREATE TRIGGER revolut_replacement_attempt_immutable BEFORE UPDATE OR DELETE ON relay_revolut_replacement_attempt FOR EACH ROW EXECUTE FUNCTION relay_restricted_attempt_immutable();
CREATE OR REPLACE FUNCTION relay_check_supersession() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.superseded_by IS DISTINCT FROM OLD.superseded_by AND NOT EXISTS (
  SELECT 1 FROM relay_revolut_replacement_policy r JOIN relay_revolut_policy p ON p.singleton=r.parent_policy
  JOIN relay_funding_drafts n ON n.id=r.draft_id
  WHERE r.old_draft_id=NEW.id AND r.draft_id=NEW.superseded_by AND p.revoked AND p.draft_id=NEW.id
  AND r.owner=NEW.owner AND n.owner=NEW.owner AND n.pence=83 AND NEW.pence=194
  AND n.agent=NEW.agent AND n.agent_revision=NEW.agent_revision
 ) THEN RAISE EXCEPTION 'Supersession needs its replacement authorisation'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS funding_supersession_authorised ON relay_funding_drafts;
CREATE CONSTRAINT TRIGGER funding_supersession_authorised AFTER UPDATE ON relay_funding_drafts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION relay_check_supersession();
