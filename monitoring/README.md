# Monitoring

This directory contains the monitoring and alerting configuration for the
Stellar prediction-market stack.

## Alerting rules

Prometheus alerting rules live in `prometheus/alerts.yml` and are loaded by the
Prometheus instance configured in `infra/monitoring/prometheus.yml`.

### IndexerStalled

Fires when the indexer falls more than 100 ledgers behind the Stellar network
head for 3 minutes.

- Expression: `indexer_lag_ledgers > 100`
- For: `3m`
- Severity: `critical`

### RPCHighErrorRate

Fires when the RPC node returns an elevated error rate over a 5 minute window.

- Expression: `rate(rpc_errors_total[5m]) > 0.05`
- For: `5m`
- Severity: `high`

Both alerts carry annotations with a dashboard link and a runbook link so that
on-call engineers can jump straight to the relevant tooling.

## Runbooks

- Indexer stall: `docs/runbooks/indexer-stall.md`
- RPC failures: `docs/runbooks/rpc-failures.md`

## Dashboards

- Indexer lag: Grafana dashboard `indexer-overview`
- RPC health: Grafana dashboard `rpc-health`
