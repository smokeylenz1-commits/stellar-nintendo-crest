import { useEffect, useRef, useState } from 'react';

/**
 * Live market updates over Server-Sent Events.
 *
 * Streams incoming bets, pool balance shifts, and odds changes for a market
 * directly into React state so the UI reflects on-chain activity instantly
 * instead of waiting on the 5s `useVisiblePoll` interval.
 */
export interface MarketLiveUpdate {
  type: 'bet' | 'pool' | 'odds';
  marketId: string;
  /** Odds for the home outcome, expressed as a decimal multiplier. */
  homeOdds?: number;
  /** Odds for the away outcome, expressed as a decimal multiplier. */
  awayOdds?: number;
  /** Total pool balance in the market's base currency. */
  poolBalance?: number;
  /** Amount of the incoming bet, when `type === 'bet'`. */
  amount?: number;
  /** Outcome the incoming bet was placed on, when `type === 'bet'`. */
  outcome?: 'home' | 'away';
  timestamp?: number;
}

export interface MarketLiveState {
  homeOdds: number | null;
  awayOdds: number | null;
  poolBalance: number | null;
  /** Direction of the most recent odds move, used for color transitions. */
  homeTrend: 'up' | 'down' | 'flat';
  awayTrend: 'up' | 'down' | 'flat';
  connected: boolean;
  lastUpdate: number | null;
}

const INITIAL_STATE: MarketLiveState = {
  homeOdds: null,
  awayOdds: null,
  poolBalance: null,
  homeTrend: 'flat',
  awayTrend: 'flat',
  connected: false,
  lastUpdate: null,
};

const MAX_RECONNECT_DELAY = 15000;

function trend(prev: number | null, next: number | undefined): 'up' | 'down' | 'flat' {
  if (prev === null || next === undefined || next === prev) return 'flat';
  return next > prev ? 'up' : 'down';
}

/**
 * Subscribes to live market updates for `marketId` via SSE and returns the
 * latest odds/pool state. Reconnects automatically with exponential backoff
 * if the connection drops.
 */
export function useMarketLiveUpdates(marketId: string | undefined): MarketLiveState {
  const [state, setState] = useState<MarketLiveState>(INITIAL_STATE);
  const sourceRef = useRef<EventSource | null>(null);
  const retryRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!marketId || typeof window === 'undefined' || typeof EventSource === 'undefined') {
      return;
    }

    let cancelled = false;

    const connect = () => {
      if (cancelled) return;

      const source = new EventSource(`/api/markets/${encodeURIComponent(marketId)}/live`);
      sourceRef.current = source;

      source.onopen = () => {
        retryRef.current = 0;
        setState((prev) => ({ ...prev, connected: true }));
      };

      source.onmessage = (event: MessageEvent<string>) => {
        let update: MarketLiveUpdate;
        try {
          update = JSON.parse(event.data) as MarketLiveUpdate;
        } catch {
          return;
        }

        setState((prev) => ({
          ...prev,
          homeOdds: update.homeOdds ?? prev.homeOdds,
          awayOdds: update.awayOdds ?? prev.awayOdds,
          poolBalance: update.poolBalance ?? prev.poolBalance,
          homeTrend: trend(prev.homeOdds, update.homeOdds),
          awayTrend: trend(prev.awayOdds, update.awayOdds),
          lastUpdate: update.timestamp ?? Date.now(),
        }));
      };

      source.onerror = () => {
        source.close();
        sourceRef.current = null;
        setState((prev) => ({ ...prev, connected: false }));

        if (cancelled) return;

        const delay = Math.min(1000 * 2 ** retryRef.current, MAX_RECONNECT_DELAY);
        retryRef.current += 1;
        timerRef.current = setTimeout(connect, delay);
      };
    };

    connect();

    return () => {
      cancelled = true;
      if (timerRef.current) clearTimeout(timerRef.current);
      sourceRef.current?.close();
      sourceRef.current = null;
    };
  }, [marketId]);

  return state;
}

interface MarketOddsProps {
  marketId?: string;
  homeLabel?: string;
  awayLabel?: string;
}

/**
 * Displays live odds for a market, animating each move with a smooth color
 * transition: green when odds increase, red when they decrease.
 */
export default function MarketOdds({ marketId, homeLabel = 'Home', awayLabel = 'Away' }: MarketOddsProps) {
  const { homeOdds, awayOdds, poolBalance, homeTrend, awayTrend, connected } =
    useMarketLiveUpdates(marketId);

  const formatOdds = (value: number | null) => (value === null ? '—' : value.toFixed(2));
  const formatPool = (value: number | null) =>
    value === null ? '—' : value.toLocaleString(undefined, { maximumFractionDigits: 2 });

  return (
    <div className="market-odds">
      <div className="market-odds__status" aria-live="polite">
        <span className={`market-odds__dot market-odds__dot--${connected ? 'live' : 'offline'}`} />
        {connected ? 'Live' : 'Reconnecting…'}
      </div>

      <div className="market-odds__row">
        <span className="market-odds__label">{homeLabel}</span>
        <span className={`market-odds__value market-odds__value--${homeTrend}`}>
          {formatOdds(homeOdds)}
        </span>
      </div>

      <div className="market-odds__row">
        <span className="market-odds__label">{awayLabel}</span>
        <span className={`market-odds__value market-odds__value--${awayTrend}`}>
          {formatOdds(awayOdds)}
        </span>
      </div>

      <div className="market-odds__pool">
        <span className="market-odds__label">Pool</span>
        <span className="market-odds__value">{formatPool(poolBalance)}</span>
      </div>
    </div>
  );
}
