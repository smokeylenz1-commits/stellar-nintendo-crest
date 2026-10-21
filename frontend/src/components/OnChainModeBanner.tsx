'use client';

import { useEffect, useState } from 'react';

/**
 * Non-intrusive banner shown when the frontend has fallen back from the
 * Backend API to querying contract state directly via Soroban RPC.
 *
 * The api-client dispatches a `stellar:onchain-mode` window event whenever
 * the fallback state changes, so this banner stays in sync without polling.
 */
export default function OnChainModeBanner() {
  const [onChainMode, setOnChainMode] = useState(false);

  useEffect(() => {
    const handleModeChange = (event: Event) => {
      const detail = (event as CustomEvent<{ active?: boolean }>).detail;
      setOnChainMode(Boolean(detail?.active));
    };

    window.addEventListener('stellar:onchain-mode', handleModeChange);
    return () => {
      window.removeEventListener('stellar:onchain-mode', handleModeChange);
    };
  }, []);

  if (!onChainMode) {
    return null;
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className="w-full bg-amber-500/10 px-4 py-2 text-center text-sm text-amber-700 dark:text-amber-300"
    >
      Operating in direct on-chain mode
    </div>
  );
}
