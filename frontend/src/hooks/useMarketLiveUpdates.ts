import { useCallback, useEffect, useRef, useState } from 'react';

export interface MarketBet {
  id: string;
  marketId: string;
  outcome: string;
  amount: number;
  bettor?: string;
  timestamp: number;
}

export interface MarketPool {
  outcome: string;
  balance: number;
}

export interface MarketOdds {
  outcome: string;
  odds: number;
}

export type OddsDirection = 'up' | 'down' | 'flat';

export interface MarketLiveState {
  bets: MarketBet[];
  pools: MarketPool[];
  odds: MarketOdds[];
  oddsDirections: Record<string, OddsDirection>;
  connected: boolean;
  error: string | null;
}

interface UseMarketLiveUpdatesResult extends MarketLiveState {
  reconnect: () => void;
}

const INITIAL_STATE: MarketLiveState = {
  bets: [],
  pools: [],
  odds: [],
  oddsDirections: {},
  connected: false,
  error: null,
};

const MAX_BETS = 100;
const BASE_RECONNECT_DELAY = 1000;
const MAX_RECONNECT_DELAY = 30000;

function resolveStreamUrl(marketId: string): string {
  const base =
    typeof process !== 'undefined' && process.env && process.env.NEXT_PUBLIC_API_URL
      ? process.env.NEXT_PUBLIC_API_URL
      : '';
  return `${base}/api/markets/${encodeURIComponent(marketId)}/live`;
}

function computeDirections(
  previous: MarketOdds[],
  next: MarketOdds[],
): Record<string, OddsDirection> {
  const prevMap = new Map(previous.map((o) => [o.outcome, o.odds]));
  const directions: Record<string, OddsDirection> = {};
  for (const item of next) {
    const before = prevMap.get(item.outcome);
    if (before === undefined || before === item.odds) {
      directions[item.outcome] = 'flat';
    } else {
      directions[item.outcome] = item.odds > before ? 'up' : 'down';
    }
  }
  return directions;
}

/**
 * Subscribes to live market updates over Server-Sent Events.
 *
 * Streams incoming bets, pool balance shifts, and odds changes directly into
 * React state so odds update instantly when bets land on-chain, replacing the
 * 5s polling delay of `useVisiblePoll`. Reconnects automatically with
 * exponential backoff if the connection drops.
 */
export function useMarketLiveUpdates(marketId: string): UseMarketLiveUpdatesResult {
  const [state, setState] = useState<MarketLiveState>(INITIAL_STATE);
  const sourceRef = useRef<EventSource | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptRef = useRef(0);
  const closedRef = useRef(false);

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const connect = useCallback(() => {
    if (!marketId || typeof EventSource === 'undefined') {
      return;
    }

    clearReconnectTimer();
    sourceRef.current?.close();

    const source = new EventSource(resolveStreamUrl(marketId));
    sourceRef.current = source;

    source.onopen = () => {
      attemptRef.current = 0;
      setState((prev) => ({ ...prev, connected: true, error: null }));
    };

    source.onmessage = (event: MessageEvent<string>) => {
      try {
        const payload = JSON.parse(event.data) as Partial<MarketLiveState> & {
          type?: string;
        };
        setState((prev) => {
          const nextOdds = payload.odds ?? prev.odds;
          return {
            ...prev,
            bets: payload.bets
              ? [...payload.bets, ...prev.bets].slice(0, MAX_BETS)
              : prev.bets,
            pools: payload.pools ?? prev.pools,
            odds: nextOdds,
            oddsDirections: computeDirections(prev.odds, nextOdds),
          };
        });
      } catch {
        setState((prev) => ({ ...prev, error: 'Malformed live update payload' }));
      }
    };

    source.onerror = () => {
      source.close();
      sourceRef.current = null;
      setState((prev) => ({ ...prev, connected: false }));

      if (closedRef.current) {
        return;
      }

      const delay = Math.min(
        BASE_RECONNECT_DELAY * 2 ** attemptRef.current,
        MAX_RECONNECT_DELAY,
      );
      attemptRef.current += 1;
      reconnectTimerRef.current = setTimeout(connect, delay);
    };
  }, [marketId, clearReconnectTimer]);

  useEffect(() => {
    closedRef.current = false;
    attemptRef.current = 0;
    setState(INITIAL_STATE);
    connect();

    return () => {
      closedRef.current = true;
      clearReconnectTimer();
      sourceRef.current?.close();
      sourceRef.current = null;
    };
  }, [connect, clearReconnectTimer]);

  const reconnect = useCallback(() => {
    attemptRef.current = 0;
    connect();
  }, [connect]);

  return { ...state, reconnect };
}

export default useMarketLiveUpdates;
