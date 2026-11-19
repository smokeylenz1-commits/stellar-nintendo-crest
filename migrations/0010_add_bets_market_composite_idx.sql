-- Migration 0010: composite index on bets(market_id, is_yes, placed_at DESC)
-- Accelerates odds calculations and market detail queries by avoiding
-- sequential scans over the bets table as it grows past 500k rows.
--
-- NOTE: CREATE INDEX CONCURRENTLY cannot run inside a transaction block.
-- Run this migration with autocommit enabled (e.g. psql without -1, or a
-- migration runner configured to skip the wrapping transaction).

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_bets_market_is_yes_placed_at
    ON bets (market_id, is_yes, placed_at DESC);
