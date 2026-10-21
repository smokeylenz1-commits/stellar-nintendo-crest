import { useEffect, useState } from 'react';
import { useMarketLiveUpdates } from './hooks/useMarketLiveUpdates';
import { MarketOdds } from './components/MarketOdds';
import { useBet } from './hooks/useBet';

type ConnectionStatus = 'live' | 'reconnecting' | 'offline';

function useNetworkStatus(): ConnectionStatus {
  const [online, setOnline] = useState<boolean>(
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );
  const { connected } = useMarketLiveUpdates();

  useEffect(() => {
    const handleOnline = () => setOnline(true);
    const handleOffline = () => setOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  if (!online) return 'offline';
  return connected ? 'live' : 'reconnecting';
}

function NetworkStatusChip({ status }: { status: ConnectionStatus }) {
  const label =
    status === 'live' ? 'Live' : status === 'reconnecting' ? 'Reconnecting...' : 'Offline';
  const dotClass =
    status === 'live'
      ? 'bg-green-500'
      : status === 'reconnecting'
      ? 'bg-yellow-400 animate-pulse'
      : 'bg-red-500';

  return (
    <div
      className="fixed top-4 right-4 z-50 flex items-center gap-2 rounded-full bg-gray-900/90 px-3 py-1.5 text-xs font-medium text-white shadow-lg"
      role="status"
      aria-live="polite"
    >
      <span className={`h-2.5 w-2.5 rounded-full ${dotClass}`} aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export default function App() {
  const status = useNetworkStatus();
  const { placeBet } = useBet();
  const bettingDisabled = status !== 'live';

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <header className="flex items-center justify-between border-b border-gray-800 px-4 py-3">
        <h1 className="text-lg font-semibold">Prediction Market</h1>
      </header>

      <NetworkStatusChip status={status} />

      <main className="mx-auto max-w-3xl px-4 py-6">
        <MarketOdds />

        <button
          type="button"
          disabled={bettingDisabled}
          onClick={() => placeBet()}
          className="mt-4 w-full rounded-lg bg-indigo-600 px-4 py-2 font-medium text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-gray-700 disabled:text-gray-400"
        >
          {bettingDisabled ? 'Betting unavailable' : 'Place Bet'}
        </button>
      </main>
    </div>
  );
}
