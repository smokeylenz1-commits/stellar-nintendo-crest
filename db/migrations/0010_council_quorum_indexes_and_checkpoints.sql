-- Migration: Composite bet indexes, indexer checkpoint_state, archival policy, and council quorum tally (#72, #76, #77, #78)

CREATE INDEX IF NOT EXISTS idx_bets_market_bettor ON bets (market_id, bettor);
CREATE INDEX IF NOT EXISTS idx_bets_created_at_desc ON bets (created_at DESC);

CREATE TABLE IF NOT EXISTS checkpoint_state (
  service_name VARCHAR(64) PRIMARY KEY,
  last_ledger_sequence BIGINT NOT NULL DEFAULT 0,
  cursor_token VARCHAR(128),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS archived_bets (
  LIKE bets INCLUDING ALL
);

-- Materialized view for optimized leaderboard ranking queries (#78)
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_leaderboard_rankings AS
SELECT
  bettor,
  COUNT(*) AS total_bets,
  SUM(gross_amount) AS total_volume,
  MAX(created_at) AS last_bet_at
FROM bets
GROUP BY bettor;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_leaderboard_bettor ON mv_leaderboard_rankings (bettor);
