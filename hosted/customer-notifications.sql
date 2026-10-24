-- Account-owned in-app records only. No email, webhook or payment jobs.
CREATE TABLE IF NOT EXISTS relay_notice_preferences (
 owner text PRIMARY KEY, payments boolean NOT NULL DEFAULT true, balances boolean NOT NULL DEFAULT true,
 simulations boolean NOT NULL DEFAULT false, last_sync timestamptz
);
CREATE TABLE IF NOT EXISTS relay_notice_seen (
 owner text NOT NULL, subject text NOT NULL, fingerprint text NOT NULL, generation integer NOT NULL DEFAULT 1,
 PRIMARY KEY(owner,subject)
);
CREATE TABLE IF NOT EXISTS relay_customer_notices (
 id uuid PRIMARY KEY, owner text NOT NULL, event_key text NOT NULL, kind text NOT NULL,
 simulated boolean NOT NULL DEFAULT false, data jsonb NOT NULL, created_at timestamptz NOT NULL,
 read_at timestamptz, UNIQUE(owner,event_key)
);
CREATE INDEX IF NOT EXISTS relay_customer_notices_owner ON relay_customer_notices(owner,created_at DESC,id DESC);
CREATE TABLE IF NOT EXISTS relay_funding_reminders (
 id uuid PRIMARY KEY, owner text NOT NULL, agent_id uuid NOT NULL REFERENCES relay_agents(id) ON DELETE CASCADE,
 revision integer NOT NULL DEFAULT 1,
 enabled boolean NOT NULL, frequency text NOT NULL CHECK(frequency IN('weekly','monthly')),
 anchor_date date NOT NULL, next_due date NOT NULL, UNIQUE(owner,agent_id)
);
INSERT INTO relay_schema(version) VALUES(5) ON CONFLICT DO NOTHING;
