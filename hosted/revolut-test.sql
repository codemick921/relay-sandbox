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
