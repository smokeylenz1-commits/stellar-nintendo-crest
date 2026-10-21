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

interface MetricDef {
  name: string;
  help: string;
  type: "gauge" | "counter";
  series: Map<string, Series>;
}

const registry = new Map<string, MetricDef>();

function define(name: string, help: string, type: "gauge" | "counter"): MetricDef {
  const existing = registry.get(name);
  if (existing) return existing;
  const def: MetricDef = { name, help, type, series: new Map() };
  registry.set(name, def);
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

/** Lag is recomputed whenever either input changes. */
export function updateLedgerLag(currentLedger: number, chainHeadLedger: number): void {
  setGauge(indexerCurrentLedger, currentLedger);
  setGauge(indexerChainHeadLedger, chainHeadLedger);
  setGauge(indexerLagLedgers, Math.max(0, chainHeadLedger - currentLedger));
}

function formatLabels(labels: Labels): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return "";
  return `{${keys.map((k) => `${k}="${labels[k].replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(",")}}`;
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
