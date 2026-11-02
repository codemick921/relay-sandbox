CREATE TABLE IF NOT EXISTS relay_agent_connections (
 id uuid PRIMARY KEY, owner text NOT NULL, customer_version integer NOT NULL,
 agent_id uuid NOT NULL, agent_revision bigint NOT NULL, agent jsonb NOT NULL,
 name text NOT NULL CHECK(length(name) BETWEEN 2 AND 60), secret_hash text NOT NULL,
 max_target_raw numeric(18,0) NOT NULL CHECK(max_target_raw>0 AND max_target_raw<=100000000000),
 daily_limit integer NOT NULL CHECK(daily_limit BETWEEN 1 AND 10),
 created_at timestamptz NOT NULL, expires_at timestamptz NOT NULL, revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS relay_agent_connections_owner ON relay_agent_connections(owner);
ALTER TABLE relay_agent_funding_requests ADD COLUMN IF NOT EXISTS source_connection_id uuid REFERENCES relay_agent_connections(id);
ALTER TABLE relay_agent_funding_requests ADD COLUMN IF NOT EXISTS source_name text;
CREATE INDEX IF NOT EXISTS relay_agent_requests_source ON relay_agent_funding_requests(source_connection_id,created_at);
