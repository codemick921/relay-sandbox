CREATE TABLE IF NOT EXISTS relay_agent_callbacks (
 id uuid PRIMARY KEY, request_id uuid NOT NULL UNIQUE REFERENCES relay_agent_funding_requests(id),
 connection_id uuid NOT NULL REFERENCES relay_agent_connections(id), url text NOT NULL,
 enabled boolean NOT NULL DEFAULT true, sequence bigint NOT NULL DEFAULT 0,
 last_digest text, pending jsonb, pending_digest text, attempts integer NOT NULL DEFAULT 0,
 next_at timestamptz NOT NULL DEFAULT now(), delivered_at timestamptz, last_error text,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS relay_agent_callbacks_due ON relay_agent_callbacks(next_at) WHERE enabled;
