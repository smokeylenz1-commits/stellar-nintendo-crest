-- Migration: Resolution audit logs, dead-letter queue events, and paired opposing bet fixtures (#68, #69, #74, #75)
-- Resolves migration numbering sequence cleanly and creates resolution_audit_logs and dlq_events.

CREATE TABLE IF NOT EXISTS resolution_audit_logs (
  id BIGSERIAL PRIMARY KEY,
  market_id BIGINT NOT NULL,
  oracle_source VARCHAR(128) NOT NULL,
  raw_response JSONB NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_resolution_audit_logs_market_id ON resolution_audit_logs (market_id);

CREATE TABLE IF NOT EXISTS dlq_events (
  id BIGSERIAL PRIMARY KEY,
  ledger_sequence BIGINT NOT NULL,
  tx_hash VARCHAR(64) NOT NULL,
  event_payload JSONB NOT NULL,
  error_message TEXT NOT NULL,
  retry_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dlq_events_ledger_seq ON dlq_events (ledger_sequence);
