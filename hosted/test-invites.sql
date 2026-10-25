CREATE TABLE IF NOT EXISTS relay_test_invites (
 id uuid PRIMARY KEY, code_hash text NOT NULL UNIQUE, label text NOT NULL,
 allow_live boolean NOT NULL DEFAULT false, created_by text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
 revoked_at timestamptz, claimed_at timestamptz,
 CHECK(length(code_hash)=64), CHECK(length(label) BETWEEN 2 AND 60)
);
CREATE TABLE IF NOT EXISTS relay_test_members (
 customer_id uuid PRIMARY KEY REFERENCES relay_customers(id),
 invite_id uuid NOT NULL UNIQUE REFERENCES relay_test_invites(id),
 mode text NOT NULL DEFAULT 'simulation' CHECK(mode IN ('simulation','live')),
 joined_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS relay_test_access_audit (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, invite_id uuid REFERENCES relay_test_invites(id),
 actor text NOT NULL, event text NOT NULL, at timestamptz NOT NULL DEFAULT now()
);
