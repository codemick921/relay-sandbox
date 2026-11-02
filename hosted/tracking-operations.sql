-- Operational metadata only; never rewrites customer or payment evidence.
CREATE TABLE IF NOT EXISTS eupova_tracking_runtime (
 merchant_id text PRIMARY KEY, beat_at timestamptz, started_at timestamptz NOT NULL DEFAULT now(), revision text
);
CREATE TABLE IF NOT EXISTS eupova_tracking_incidents (
 merchant_id text NOT NULL, kind text NOT NULL, active boolean NOT NULL DEFAULT false,
 episode uuid, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(merchant_id,kind)
);
CREATE TABLE IF NOT EXISTS eupova_tracking_alerts (
 id uuid PRIMARY KEY, merchant_id text NOT NULL, kind text NOT NULL, recovery boolean NOT NULL,
 payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 first_attempt_at timestamptz, next_attempt_at timestamptz NOT NULL DEFAULT now(),
 lease_until timestamptz, lease_token uuid, attempts integer NOT NULL DEFAULT 0,
 sent_at timestamptz, provider_id text, abandoned_at timestamptz
);
