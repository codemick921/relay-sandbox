-- Inert metadata only: never a payment ledger, customer binding or work queue.
CREATE TABLE IF NOT EXISTS relay_peer_connection_notifications (
 merchant_id text NOT NULL,
 event_id text NOT NULL,
 digest text NOT NULL CHECK(length(digest)=64),
 event_type text NOT NULL,
 test boolean NOT NULL,
 received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(merchant_id,event_id),
 UNIQUE(merchant_id,digest)
);
