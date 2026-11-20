/**
 * Indexer metrics in the Prometheus text format (#30).
 *
 * Exposes the gauges and counters the operations team watches. `renderMetrics()` produces the
 * body for a `/metrics` endpoint. The format is written by hand so the backend does not need
 * a metrics library yet.
 */

type Labels = Record<string, string>;

interface Series {
  labels: Labels;
  value: number;
}

interface HistogramSeries {
  labels: Labels;
  buckets: number[];
  counts: number[];
  sum: number;
  count: number;
}

interface MetricDef {
  name: string;
  help: string;
  type: "gauge" | "counter";
  series: Map<string, Series>;
}

interface HistogramDef {
  name: string;
  help: string;
  type: "histogram";
  buckets: number[];
  series: Map<string, HistogramSeries>;
}

const registry = new Map<string, MetricDef>();
const histogramRegistry = new Map<string, HistogramDef>();

function define(name: string, help: string, type: "gauge" | "counter"): MetricDef {
  const existing = registry.get(name);
  if (existing) return existing;
  const def: MetricDef = { name, help, type, series: new Map() };
  registry.set(name, def);
  return def;
}

function defineHistogram(name: string, help: string, buckets: number[]): HistogramDef {
  const existing = histogramRegistry.get(name);
  if (existing) return existing;
  const def: HistogramDef = { name, help, type: "histogram", buckets, series: new Map() };
  histogramRegistry.set(name, def);
  return def;
}

function labelKey(labels: Labels): string {
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}=${labels[k]}`)
    .join(",");
}

export const indexerCurrentLedger = define("indexer_current_ledger", "Last ledger the indexer processed.", "gauge");
export const indexerChainHeadLedger = define("indexer_chain_head_ledger", "Latest ledger reported by the chain.", "gauge");
export const indexerLagLedgers = define("indexer_lag_ledgers", "Chain head minus the indexer's current ledger.", "gauge");
export const indexerEventsProcessedTotal = define("indexer_events_processed_total", "Contract events processed.", "counter");
export const indexerErrorsTotal = define("indexer_errors_total", "Indexer errors.", "counter");
export const indexerUnmappedEventsTotal = define("indexer_unmapped_events_total", "Contract events with no handler.", "counter");
export const stellarTxConfirmationSeconds = define("stellar_tx_confirmation_seconds", "Stellar transaction confirmation latency in seconds.", "gauge");

/** Sequence continuity (#215): detected gaps and unresolved critical gaps. */
export const indexerSequenceGapsTotal = define("indexer_sequence_gaps_total", "Ledger sequence gaps detected during ingestion.", "counter");
export const indexerSequenceGapUnresolvedTotal = define("indexer_sequence_gap_unresolved_total", "Ledger sequence gaps that could not be resolved within the retry budget.", "counter");
export const indexerSequenceGapRetriesTotal = define("indexer_sequence_gap_retries_total", "Retry attempts made to fetch missed ledger sequences.", "counter");

export const pgPoolActiveConnections = define("pg_pool_active_connections", "Number of active connections.", "gauge");
export const pgPoolIdleConnections = define("pg_pool_idle_connections", "Number of idle connections.", "gauge");
export const pgPoolWaitingQueries = define("pg_pool_waiting_queries", "Number of queries waiting for a connection.", "gauge");

export const ipredictTotalSupply = define("ipredict_total_supply", "Total minted IPREDICT tokens.", "gauge");
export const ipredictSupplyCap = define("ipredict_supply_cap", "Maximum supply cap for IPREDICT token.", "gauge");
export const ipredictCirculatingSupply = define("ipredict_circulating_supply", "Circulating supply of IPREDICT tokens.", "gauge");
export const ipredictRewardsDistributedTotal = define("ipredict_rewards_distributed_total", "Cumulative reward tokens distributed.", "counter");

/** Per-contract-event-type ingestion duration histogram, in seconds. */
export const indexerEventIngestionSeconds = defineHistogram(
  "indexer_event_ingestion_seconds",
  "Contract event ingestion duration in seconds, by event type.",
  [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
);

/** Sets a gauge to `value` for the given labels. */
export function setGauge(def: MetricDef, value: number, labels: Labels = {}): void {
  def.series.set(labelKey(labels), { labels, value });
}

/** Adds `by` to a counter for the given labels. */
export function incCounter(def: MetricDef, by = 1, labels: Labels = {}): void {
  const key = labelKey(labels);
  const current = def.series.get(key)?.value ?? 0;
  def.series.set(key, { labels, value: current + by });
}

/** Records an observation into a histogram for the given labels. */
export function observeHistogram(def: HistogramDef, value: number, labels: Labels = {}): void {
  const key = labelKey(labels);
  let s = def.series.get(key);
  if (!s) {
    s = { labels, buckets: def.buckets, counts: def.buckets.map(() => 0), sum: 0, count: 0 };
    def.series.set(key, s);
  }
  for (let i = 0; i < s.buckets.length; i++) {
    if (value <= s.buckets[i]) s.counts[i]++;
  }
  s.sum += value;
  s.count++;
}

/** Records the ingestion duration (in seconds) for a contract event type. */
export function observeEventIngestion(eventType: string, durationSeconds: number): void {
  observeHistogram(indexerEventIngestionSeconds, durationSeconds, { event_type: eventType });
}

/** Lag is recomputed whenever either input changes. */
export function updateLedgerLag(currentLedger: number, chainHeadLedger: number): void {
  setGauge(indexerCurrentLedger, currentLedger);
  setGauge(indexerChainHeadLedger, chainHeadLedger);
  setGauge(indexerLagLedgers, Math.max(0, chainHeadLedger - currentLedger));
}

/** Records a detected ledger sequence gap (#215). */
export function recordSequenceGap(expected: number, received: number): void {
  incCounter(indexerSequenceGapsTotal, 1, { expected: String(expected), received: String(received) });
}

/** Records a retry attempt to fetch a missed ledger sequence (#215). */
export function recordSequenceGapRetry(sequence: number, attempt: number): void {
  incCounter(indexerSequenceGapRetriesTotal, 1, { sequence: String(sequence), attempt: String(attempt) });
}

/** Records a gap that could not be resolved within the retry budget (#215). */
export function recordSequenceGapUnresolved(sequence: number): void {
  incCounter(indexerSequenceGapUnresolvedTotal, 1, { sequence: String(sequence) });
}

function formatLabels(labels: Labels): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return "";
  return `{${keys.map((k) => `${k}="${labels[k].replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(",")}}`;
}

function formatHistogram(def: HistogramDef): string[] {
  const lines: string[] = [];
  lines.push(`# HELP ${def.name} ${def.help}`);
  lines.push(`# TYPE ${def.name} histogram`);
  if (def.series.size === 0) {
    for (const b of def.buckets) {
      lines.push(`${def.name}_bucket{le="${b}"} 0`);
    }
    lines.push(`${def.name}_bucket{le="+Inf"} 0`);
    lines.push(`${def.name}_sum 0`);
    lines.push(`${def.name}_count 0`);
    return lines;
  }
  for (const s of def.series.values()) {
    for (let i = 0; i < s.buckets.length; i++) {
      const labels = { ...s.labels, le: String(s.buckets[i]) };
      lines.push(`${def.name}_bucket${formatLabels(labels)} ${s.counts[i]}`);
    }
    const infLabels = { ...s.labels, le: "+Inf" };
    lines.push(`${def.name}_bucket${formatLabels(infLabels)} ${s.count}`);
    lines.push(`${def.name}_sum${formatLabels(s.labels)} ${s.sum}`);
    lines.push(`${def.name}_count${formatLabels(s.labels)} ${s.count}`);
  }
  return lines;
}

/** Renders every metric in the Prometheus text exposition format. */
export function renderMetrics(): string {
  const lines: string[] = [];
  for (const def of registry.values()) {
    lines.push(`# HELP ${def.name} ${def.help}`);
    lines.push(`# TYPE ${def.name} ${def.type}`);
    if (def.series.size === 0) {
      lines.push(`${def.name} 0`);
    }
    for (const s of def.series.values()) {
      lines.push(`${def.name}${formatLabels(s.labels)} ${s.value}`);
    }
  }
  for (const def of histogramRegistry.values()) {
    lines.push(...formatHistogram(def));
  }
  return lines.join("\n") + "\n";
}

/** Handler body for `GET /metrics`. */
export function metricsResponse(): { status: number; headers: Record<string, string>; body: string } {
  return {
    status: 200,
    headers: { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" },
    body: renderMetrics(),
  };
}
