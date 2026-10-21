'use client';

import { useEffect, useState } from 'react';

type ConnectionStatus = 'live' | 'reconnecting' | 'offline';

/**
 * Floating network status chip for the app header.
 *
 * Reflects `navigator.onLine` plus the SSE connection state so users on
 * unstable connections can see when their odds may be stale.
 */
export default function Header() {
  const [isOnline, setIsOnline] = useState(true);
  const [sseConnected, setSseConnected] = useState(true);

  useEffect(() => {
    if (typeof navigator !== 'undefined') {
      setIsOnline(navigator.onLine);
    }

    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof EventSource === 'undefined') {
      return;
    }

    let source: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      source = new EventSource('/api/stream');

      source.onopen = () => setSseConnected(true);
      source.onerror = () => {
        setSseConnected(false);
        source?.close();
        retryTimer = setTimeout(connect, 3000);
      };
    };

    connect();

    return () => {
      if (retryTimer) clearTimeout(retryTimer);
      source?.close();
    };
  }, []);

  const status: ConnectionStatus = !isOnline
    ? 'offline'
    : sseConnected
      ? 'live'
      : 'reconnecting';

  const statusConfig: Record<
    ConnectionStatus,
    { label: string; dotClass: string; chipClass: string }
  > = {
    live: {
      label: 'Live',
      dotClass: 'bg-green-500',
      chipClass: 'bg-green-500/10 text-green-400 border-green-500/30',
    },
    reconnecting: {
      label: 'Reconnecting...',
      dotClass: 'bg-yellow-400 animate-pulse',
      chipClass: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/30',
    },
    offline: {
      label: 'Offline',
      dotClass: 'bg-red-500',
      chipClass: 'bg-red-500/10 text-red-400 border-red-500/30',
    },
  };

  const { label, dotClass, chipClass } = statusConfig[status];

  return (
    <header className="sticky top-0 z-50 w-full border-b border-white/10 bg-black/60 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-4">
        <span className="text-sm font-semibold tracking-wide text-white">
          Prediction Market
        </span>

        <div
          role="status"
          aria-live="polite"
          data-connection-status={status}
          className={`flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium ${chipClass}`}
        >
          <span className={`h-2 w-2 rounded-full ${dotClass}`} aria-hidden="true" />
          {label}
        </div>
      </div>
    </header>
  );
}
