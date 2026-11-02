-- Manual preparation only. Never included in application startup migrations.
-- Apply once using a separate schema owner. Runtime role receives EXECUTE only.
BEGIN;
CREATE SCHEMA eupova_wallet_setup;
REVOKE ALL ON SCHEMA eupova_wallet_setup FROM PUBLIC;
CREATE TABLE eupova_wallet_setup.control (
 singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
 enabled boolean NOT NULL DEFAULT false,
 durability_mode text NOT NULL DEFAULT 'unreviewed' CHECK (durability_mode IN ('unreviewed','single_primary','synchronous_failover')),
 reviewed_until timestamptz
);
INSERT INTO eupova_wallet_setup.control DEFAULT VALUES;
CREATE TABLE eupova_wallet_setup.lease (
 id uuid PRIMARY KEY,
 app_id text NOT NULL CHECK (app_id ~ '^[a-z0-9]{10,80}$'),
 owner_hash text NOT NULL CHECK (owner_hash ~ '^[a-f0-9]{64}$'),
 subject_hash text NOT NULL CHECK (subject_hash ~ '^[a-f0-9]{64}$'),
 did_hash text NOT NULL CHECK (did_hash ~ '^[a-f0-9]{64}$'),
 session_binding text NOT NULL CHECK (session_binding ~ '^[a-f0-9]{64}$'),
 context_hash text NOT NULL CHECK (context_hash ~ '^[a-f0-9]{64}$'),
 consent_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL CHECK (expires_at > consent_at AND expires_at <= consent_at + interval '30 minutes'),
 recovery_hash text NOT NULL CHECK (recovery_hash ~ '^[a-f0-9]{64}$'),
 recovery_expires_at timestamptz NOT NULL,
 revoked_at timestamptz
);
-- Append-only attempt tombstones. No cleanup, retry, reset, delete or update API.
CREATE TABLE eupova_wallet_setup.attempt (
 lease_id uuid PRIMARY KEY REFERENCES eupova_wallet_setup.lease(id),
 app_id text NOT NULL,
 owner_hash text NOT NULL,
 subject_hash text NOT NULL,
 did_hash text NOT NULL,
 session_binding text NOT NULL,
 context_hash text NOT NULL,
 observed_at timestamptz NOT NULL,
 consumed_at timestamptz NOT NULL,
 permit_expires_at timestamptz NOT NULL,
 UNIQUE (app_id,owner_hash), UNIQUE (app_id,subject_hash), UNIQUE (app_id,did_hash)
);
REVOKE ALL ON ALL TABLES IN SCHEMA eupova_wallet_setup FROM PUBLIC;

CREATE FUNCTION eupova_wallet_setup.consume(
 p_app text,p_owner text,p_subject text,p_did text,p_lease uuid,p_context text,p_session text,
 p_observed timestamptz,p_valid_until timestamptz,p_recovery text
) RETURNS TABLE(consumed_at timestamptz,expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,eupova_wallet_setup AS $$
DECLARE cfg eupova_wallet_setup.control%ROWTYPE; l eupova_wallet_setup.lease%ROWTYPE; n timestamptz; until_at timestamptz;
BEGIN
 IF p_app IS NULL OR p_owner IS NULL OR p_subject IS NULL OR p_did IS NULL OR p_lease IS NULL OR p_context IS NULL OR p_session IS NULL OR p_recovery IS NULL THEN
  RAISE EXCEPTION 'wallet_setup_claim_rejected';
 END IF;
 IF has_table_privilege(session_user,'eupova_wallet_setup.attempt','UPDATE,DELETE,TRUNCATE') OR has_table_privilege(session_user,'eupova_wallet_setup.control','UPDATE') OR has_table_privilege(session_user,'eupova_wallet_setup.lease','INSERT,UPDATE,DELETE') THEN
  RAISE EXCEPTION 'wallet_setup_role_too_broad';
 END IF;
 IF current_setting('fsync') <> 'on' OR current_setting('synchronous_commit') NOT IN ('on','remote_apply') OR pg_is_in_recovery() THEN
  RAISE EXCEPTION 'wallet_setup_storage_unavailable';
 END IF;
 SELECT * INTO cfg FROM eupova_wallet_setup.control WHERE singleton FOR SHARE;
 IF NOT FOUND OR NOT cfg.enabled OR cfg.durability_mode='unreviewed' OR cfg.reviewed_until IS NULL OR cfg.reviewed_until<=clock_timestamp() THEN
  RAISE EXCEPTION 'wallet_setup_disabled';
 END IF;
 IF cfg.durability_mode='synchronous_failover' AND current_setting('synchronous_standby_names')='' THEN
  RAISE EXCEPTION 'wallet_setup_storage_unavailable';
 END IF;
 SELECT * INTO l FROM eupova_wallet_setup.lease WHERE id=p_lease FOR UPDATE;
 n:=clock_timestamp();
 IF NOT FOUND OR l.revoked_at IS NOT NULL OR l.app_id<>p_app OR l.owner_hash<>p_owner OR l.subject_hash<>p_subject OR l.did_hash<>p_did OR l.context_hash<>p_context OR l.session_binding<>p_session
  OR l.consent_at>n OR l.expires_at<=n OR l.recovery_hash<>p_recovery OR l.recovery_expires_at<=n
  OR p_observed IS NULL OR p_valid_until IS NULL OR p_observed>n+interval '1 second' OR p_observed<n-interval '10 seconds' OR p_valid_until<=n OR p_valid_until>p_observed+interval '30 seconds' THEN
  RAISE EXCEPTION 'wallet_setup_claim_rejected';
 END IF;
 until_at:=LEAST(n+interval '10 seconds',l.expires_at,l.recovery_expires_at,cfg.reviewed_until,p_valid_until);
 IF until_at<=n+interval '2 seconds' THEN RAISE EXCEPTION 'wallet_setup_claim_expired'; END IF;
 RETURN QUERY INSERT INTO eupova_wallet_setup.attempt AS a
  (lease_id,app_id,owner_hash,subject_hash,did_hash,session_binding,context_hash,observed_at,consumed_at,permit_expires_at)
  VALUES(l.id,l.app_id,l.owner_hash,l.subject_hash,l.did_hash,l.session_binding,l.context_hash,p_observed,n,until_at)
  ON CONFLICT DO NOTHING RETURNING a.consumed_at,a.permit_expires_at;
END;
$$;

CREATE FUNCTION eupova_wallet_setup.status(p_app text,p_owner text)
 RETURNS TABLE(consumed_at timestamptz)
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,eupova_wallet_setup AS $$
  SELECT a.consumed_at FROM eupova_wallet_setup.attempt a WHERE a.app_id=p_app AND a.owner_hash=p_owner;
$$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA eupova_wallet_setup FROM PUBLIC;
-- After separate activation approval, grant USAGE plus EXECUTE on the two exact
-- functions to a non-owner runtime role. Never grant table DML, TRUNCATE or ownership.
COMMIT;
