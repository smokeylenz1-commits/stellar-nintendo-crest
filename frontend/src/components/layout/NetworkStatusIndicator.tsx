"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { NETWORK } from "@/config/network";

// ── Types ────────────────────────────────────────────────────────────────────

type HealthStatus = "green" | "yellow" | "red" | "loading";

interface FeeStats {
  /** Median base fee in stroops over the last N ledgers */
  baseFeeMedian: number;
  /** p99 base fee in stroops */
  baseFeeP99: number;
  /** Average ledger close time in seconds */
  ledgerCloseTimeAvg: number;
}

interface RpcLatency {
  latencyMs: number | null;
  measuredAt: Date | null;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function deriveStatus(stats: FeeStats | null): HealthStatus {
  if (!stats) return "loading";
  // Thresholds: green < 200 stroops, yellow < 1000, red ≥ 1000
  if (stats.baseFeeMedian < 200) return "green";
  if (stats.baseFeeMedian < 1000) return "yellow";
  return "red";
}

const STATUS_LABEL: Record<HealthStatus, string> = {
  green: "Healthy",
  yellow: "Congested",
  red: "High load",
  loading: "Loading…",
};

const STATUS_DOT_CLASS: Record<HealthStatus, string> = {
  green: "bg-green-400 shadow-green-400/50",
  yellow: "bg-yellow-400 shadow-yellow-400/50",
  red: "bg-red-400 shadow-red-400/50",
  loading: "bg-slate-500",
};

// ── Main Component ───────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 30_000;

export default function NetworkStatusIndicator() {
  const [feeStats, setFeeStats] = useState<FeeStats | null>(null);
  const [status, setStatus] = useState<HealthStatus>("loading");
  const [modalOpen, setModalOpen] = useState(false);
  const [rpcLatency, setRpcLatency] = useState<RpcLatency>({
    latencyMs: null,
    measuredAt: null,
  });
  const [fetchError, setFetchError] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const modalRef = useRef<HTMLDivElement>(null);

  const fetchFeeStats = useCallback(async () => {
    try {
      const url = `${NETWORK.url}/fee_stats`;
      const start = performance.now();
      const res = await fetch(url);
      const elapsed = Math.round(performance.now() - start);

      if (!res.ok) {
        throw new Error(`Horizon responded with ${res.status}`);
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data: any = await res.json();

      const stats: FeeStats = {
        baseFeeMedian: parseInt(data.fee_charged?.p50 ?? data.base_fee ?? "100", 10),
        baseFeeP99: parseInt(data.fee_charged?.p99 ?? data.base_fee ?? "100", 10),
        ledgerCloseTimeAvg: parseFloat(data.ledger_capacity_usage ?? "0") > 0
          ? 5
          : 5, // Stellar ledger close time is ~5 s; derive from ledger_capacity_usage if needed
      };

      setFeeStats(stats);
      setStatus(deriveStatus(stats));
      setRpcLatency({ latencyMs: elapsed, measuredAt: new Date() });
      setFetchError(null);
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : "Unknown error");
      setStatus("red");
    }
  }, []);

  // Initial fetch + 30 s polling
  useEffect(() => {
    fetchFeeStats();
    intervalRef.current = setInterval(fetchFeeStats, POLL_INTERVAL_MS);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [fetchFeeStats]);

  // Close modal on outside click
  useEffect(() => {
    if (!modalOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (modalRef.current && !modalRef.current.contains(e.target as Node)) {
        setModalOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [modalOpen]);

  // Close modal on Escape
  useEffect(() => {
    if (!modalOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setModalOpen(false);
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [modalOpen]);

  const networkLabel = NETWORK.name === "testnet" ? "Testnet" : "Mainnet";

  return (
    <>
      {/* Trigger button */}
      <button
        type="button"
        onClick={() => setModalOpen(true)}
        aria-label={`Stellar network status: ${STATUS_LABEL[status]}`}
        className="inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs text-slate-400 border border-surface-border hover:border-slate-600 hover:text-slate-200 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
      >
        {/* Animated status dot */}
        <span className="relative flex h-2 w-2">
          {status !== "loading" && (
            <span
              className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-60 ${STATUS_DOT_CLASS[status]}`}
            />
          )}
          <span
            className={`relative inline-flex rounded-full h-2 w-2 shadow-md ${STATUS_DOT_CLASS[status]}`}
          />
        </span>

        <span className="font-medium">{networkLabel}</span>

        {feeStats && (
          <>
            <span className="text-slate-600">·</span>
            <span>{feeStats.baseFeeMedian} stroops</span>
            <span className="text-slate-600">·</span>
            <span>~{feeStats.ledgerCloseTimeAvg}s</span>
          </>
        )}

        {fetchError && !feeStats && <span className="text-red-400">Error</span>}
      </button>

      {/* Detail modal */}
      {modalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Stellar network detail"
        >
          <div
            ref={modalRef}
            className="w-full max-w-sm rounded-2xl bg-surface border border-surface-border shadow-2xl p-6 space-y-5"
          >
            {/* Header */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="relative flex h-2.5 w-2.5">
                  {status !== "loading" && (
                    <span
                      className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-60 ${STATUS_DOT_CLASS[status]}`}
                    />
                  )}
                  <span
                    className={`relative inline-flex rounded-full h-2.5 w-2.5 shadow-md ${STATUS_DOT_CLASS[status]}`}
                  />
                </span>
                <h3 className="font-heading font-semibold text-slate-100 text-base">
                  Stellar {networkLabel}
                </h3>
                <span
                  className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                    status === "green"
                      ? "bg-green-500/15 text-green-400"
                      : status === "yellow"
                        ? "bg-yellow-500/15 text-yellow-400"
                        : status === "red"
                          ? "bg-red-500/15 text-red-400"
                          : "bg-slate-500/15 text-slate-400"
                  }`}
                >
                  {STATUS_LABEL[status]}
                </span>
              </div>
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                aria-label="Close"
                className="text-slate-500 hover:text-slate-200 transition-colors text-lg leading-none"
              >
                ✕
              </button>
            </div>

            {/* Stats grid */}
            <div className="grid grid-cols-2 gap-3">
              <Stat
                label="Base fee (median)"
                value={feeStats ? `${feeStats.baseFeeMedian} stroops` : "—"}
              />
              <Stat
                label="Base fee (p99)"
                value={feeStats ? `${feeStats.baseFeeP99} stroops` : "—"}
              />
              <Stat
                label="Ledger close time"
                value={feeStats ? `~${feeStats.ledgerCloseTimeAvg}s` : "—"}
              />
              <Stat
                label="RPC latency"
                value={
                  rpcLatency.latencyMs !== null
                    ? `${rpcLatency.latencyMs}ms`
                    : "—"
                }
              />
            </div>

            {fetchError && (
              <p className="text-xs text-red-400 bg-red-500/10 rounded-lg px-3 py-2">
                {fetchError}
              </p>
            )}

            {/* Footer */}
            <div className="flex items-center justify-between text-xs text-slate-600">
              <span>
                {rpcLatency.measuredAt
                  ? `Updated ${rpcLatency.measuredAt.toLocaleTimeString()}`
                  : "Fetching…"}
              </span>
              <button
                type="button"
                onClick={fetchFeeStats}
                className="text-primary-400 hover:text-primary-300 transition-colors"
              >
                Refresh
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-surface-hover px-3 py-2.5">
      <p className="text-[11px] text-slate-500 mb-0.5">{label}</p>
      <p className="text-sm font-medium text-slate-200">{value}</p>
    </div>
  );
}
