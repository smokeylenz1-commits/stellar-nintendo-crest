import { useCallback, useEffect, useRef, useState } from 'react';

export interface DisputeState {
  marketId: string;
  proposedOutcome: string | null;
  disputeWindowEndsAt: string | null;
  finalized: boolean;
  canChallenge: boolean;
}

export interface UseDisputeStateResult {
  disputeState: DisputeState | null;
  loading: boolean;
  error: Error | null;
  /** Milliseconds remaining in the challenge window (0 when closed/finalized). */
  remainingMs: number;
  /** True while the challenge window is still open. */
  isWindowOpen: boolean;
  /** True when the user holds dispute rights and the window is open. */
  canChallenge: boolean;
  /** Human-readable countdown, e.g. "Challenge Window Closes in 3h 12m". */
  countdownLabel: string;
  refresh: () => Promise<void>;
}

const DEFAULT_POLL_INTERVAL_MS = 30_000;

function formatCountdown(remainingMs: number): string {
  if (remainingMs <= 0) {
    return 'Challenge Window Closed';
  }
  const totalSeconds = Math.floor(remainingMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  return `Challenge Window Closes in ${hours}h ${minutes}m`;
}

function computeRemaining(endsAt: string | null): number {
  if (!endsAt) {
    return 0;
  }
  const end = new Date(endsAt).getTime();
  if (Number.isNaN(end)) {
    return 0;
  }
  return Math.max(0, end - Date.now());
}

/**
 * Fetches optimistic-resolution dispute state for a market and exposes a
 * per-second countdown for the challenge window. When the window reaches zero
 * the market status is auto-refreshed so the UI reflects finalization.
 */
export function useDisputeState(
  marketId: string | null | undefined,
  options: { pollIntervalMs?: number } = {},
): UseDisputeStateResult {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  const [disputeState, setDisputeState] = useState<DisputeState | null>(null);
  const [loading, setLoading] = useState<boolean>(Boolean(marketId));
  const [error, setError] = useState<Error | null>(null);
  const [remainingMs, setRemainingMs] = useState<number>(0);

  const windowEndedRef = useRef<boolean>(false);

  const fetchDisputeState = useCallback(async () => {
    if (!marketId) {
      setDisputeState(null);
      setRemainingMs(0);
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      const response = await fetch(
        `/api/oracle/markets/${encodeURIComponent(marketId)}/dispute-state`,
        { headers: { Accept: 'application/json' } },
      );
      if (!response.ok) {
        throw new Error(`Failed to load dispute state (${response.status})`);
      }
      const data = (await response.json()) as DisputeState;
      setDisputeState(data);
      setRemainingMs(computeRemaining(data.disputeWindowEndsAt));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  }, [marketId]);

  // Initial load + periodic refresh of dispute state.
  useEffect(() => {
    windowEndedRef.current = false;
    void fetchDisputeState();

    if (!marketId) {
      return;
    }

    const interval = setInterval(() => {
      void fetchDisputeState();
    }, pollIntervalMs);

    return () => clearInterval(interval);
  }, [marketId, pollIntervalMs, fetchDisputeState]);

  // Per-second countdown tick.
  useEffect(() => {
    if (!disputeState?.disputeWindowEndsAt) {
      setRemainingMs(0);
      return;
    }

    const tick = () => {
      const next = computeRemaining(disputeState.disputeWindowEndsAt);
      setRemainingMs(next);

      if (next <= 0 && !windowEndedRef.current) {
        windowEndedRef.current = true;
        // Auto-refresh market status once the challenge window closes.
        void fetchDisputeState();
      }
    };

    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [disputeState?.disputeWindowEndsAt, fetchDisputeState]);

  const isWindowOpen = remainingMs > 0 && !disputeState?.finalized;
  const canChallenge = Boolean(disputeState?.canChallenge) && isWindowOpen;

  return {
    disputeState,
    loading,
    error,
    remainingMs,
    isWindowOpen,
    canChallenge,
    countdownLabel: formatCountdown(remainingMs),
    refresh: fetchDisputeState,
  };
}

export default useDisputeState;
