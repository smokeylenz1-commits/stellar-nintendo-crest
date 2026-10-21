# Runbook Index

This index maps every active operational alert to its exact recovery procedure.
On-call engineers should open the linked runbook directly from the alert and
follow the step-by-step remediation. Each entry includes the alert's meaning,
verification commands, and the CLI scripts used to remediate.

> Keep this file in sync with the Prometheus alert rules. When an alert is added,
> renamed, or removed, update the corresponding row here in the same PR.

## Alert → Runbook mapping

| Alert name | Severity | Runbook | Summary |
| --- | --- | --- | --- |
| `IndexerStalled` | critical | [INDEXER_RUNBOOK.md](./INDEXER_RUNBOOK.md) | Indexer has not advanced its chain head within the expected window. |
| `MarketStuck` | critical | [ORACLE_RUNBOOK.md](./ORACLE_RUNBOOK.md) | A market's oracle price has not updated and the market is stuck. |
| `LeaderboardDrift` | warning | [LEADERBOARD_REBUILD_RUNBOOK.md](./LEADERBOARD_REBUILD_RUNBOOK.md) | Leaderboard totals diverge from source-of-truth aggregates. |
| `RPCHighErrorRate` | warning | [ORACLE_ADAPTER_FRESHNESS.md](./ORACLE_ADAPTER_FRESHNESS.md) | RPC adapter error rate exceeds threshold / data is stale. |

## IndexerStalled → INDEXER_RUNBOOK.md

**Meaning:** The indexer has not advanced its chain head within the expected
window, so downstream data (markets, leaderboards) is stale.

**Verify:**

```bash
# Current indexed height vs. chain head
curl -s localhost:8080/health | jq '.indexer'

# Recent indexer progress in Prometheus
#   indexer_chain_head - indexer_last_indexed_block
```

**Remediate:**

```bash
# Restart the indexer service
./scripts/restart-indexer.sh

# Re-run the stalled range from the last good checkpoint
./scripts/indexer-replay.sh --from "$LAST_GOOD_BLOCK"
```

See [INDEXER_RUNBOOK.md](./INDEXER_RUNBOOK.md) for the full procedure.

## MarketStuck → ORACLE_RUNBOOK.md

**Meaning:** A market's oracle price has not updated within the freshness
window, leaving the market stuck (no valid price to settle against).

**Verify:**

```bash
# Per-market oracle freshness
curl -s localhost:8080/oracle/status | jq '.markets[] | {id, lastUpdate, stale}'

# Prometheus: time() - oracle_last_update_timestamp_seconds
```

**Remediate:**

```bash
# Force an oracle refresh for the affected market
./scripts/oracle-refresh.sh --market "$MARKET_ID"

# If the feed is down, fail over to the backup provider
./scripts/oracle-failover.sh --market "$MARKET_ID"
```

See [ORACLE_RUNBOOK.md](./ORACLE_RUNBOOK.md) for the full procedure.

## LeaderboardDrift → LEADERBOARD_REBUILD_RUNBOOK.md

**Meaning:** Leaderboard totals diverge from the source-of-truth aggregates,
indicating a missed or double-counted event.

**Verify:**

```bash
# Compare leaderboard totals against source aggregates
./scripts/leaderboard-verify.sh --window 24h

# Prometheus: leaderboard_drift_abs
```

**Remediate:**

```bash
# Rebuild the leaderboard from the event log
./scripts/leaderboard-rebuild.sh --from "$START_TS" --to "$END_TS"
```

See [LEADERBOARD_REBUILD_RUNBOOK.md](./LEADERBOARD_REBUILD_RUNBOOK.md) for the
full procedure.

## RPCHighErrorRate → ORACLE_ADAPTER_FRESHNESS.md

**Meaning:** The RPC adapter error rate exceeds threshold and/or oracle data is
stale because upstream RPC calls are failing.

**Verify:**

```bash
# Adapter error rate and freshness
curl -s localhost:8080/adapters/rpc | jq '{errorRate, lastSuccess}'

# Prometheus: rate(rpc_adapter_errors_total[5m]) / rate(rpc_adapter_requests_total[5m])
```

**Remediate:**

```bash
# Rotate to a healthy RPC endpoint
./scripts/rpc-failover.sh --adapter oracle

# Re-check adapter freshness after failover
./scripts/oracle-adapter-check.sh
```

See [ORACLE_ADAPTER_FRESHNESS.md](./ORACLE_ADAPTER_FRESHNESS.md) for the full
procedure.

## Maintenance

- Every active alert MUST have a row in the mapping table above.
- Every linked runbook MUST contain verification commands and remediation CLI
  scripts, and MUST be reviewed by the engineering team.
- When adding a new alert, add its row and runbook link in the same PR.
