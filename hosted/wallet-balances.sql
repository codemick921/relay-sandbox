CREATE TABLE IF NOT EXISTS relay_wallet_balances (
 agent_id uuid PRIMARY KEY REFERENCES relay_agents(id) ON DELETE CASCADE,
 address_key text NOT NULL,
 amount_raw text, block_number text, observed_at timestamptz,
 attempted_at timestamptz, failed boolean NOT NULL DEFAULT false,
 next_check_at timestamptz NOT NULL DEFAULT now(), lease_token uuid, lease_until timestamptz,
 alerts_enabled boolean NOT NULL DEFAULT false,
 threshold_raw text NOT NULL DEFAULT '10000000', target_raw text NOT NULL DEFAULT '50000000',
 CHECK(amount_raw IS NULL OR amount_raw ~ '^[0-9]+$'),
 CHECK(threshold_raw ~ '^[0-9]+$'), CHECK(target_raw ~ '^[0-9]+$')
);
CREATE INDEX IF NOT EXISTS relay_wallet_balances_due ON relay_wallet_balances(next_check_at);
