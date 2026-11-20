import React, { useEffect, useState, useMemo } from 'react';

export interface MarketItem {
  id: string | number;
  title: string;
  category?: string;
}

interface MarketSearchModalProps {
  markets?: MarketItem[];
  isOpen: boolean;
  onClose: () => void;
  onSelectMarket: (market: MarketItem) => void;
}

export function MarketSearchModal({
  markets = [],
  isOpen,
  onClose,
  onSelectMarket,
}: MarketSearchModalProps) {
  const [query, setQuery] = useState('');

  // Handle Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  const filtered = useMemo(() => {
    if (!query.trim()) return markets.slice(0, 8);
    const q = query.toLowerCase();
    return markets.filter(
      (m) => m.title.toLowerCase().includes(q) || m.category?.toLowerCase().includes(q)
    ).slice(0, 8);
  }, [markets, query]);

  if (!isOpen) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-4 pt-20 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-xl rounded-xl border border-white/10 bg-neutral-900 p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="relative flex items-center border-b border-white/10 pb-3">
          <input
            type="text"
            autoFocus
            placeholder="Search markets (press Esc to exit)..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full bg-transparent px-3 py-1.5 text-sm text-white placeholder-neutral-500 focus:outline-none"
          />
        </div>
        <div className="mt-3 max-h-72 overflow-y-auto">
          {filtered.length === 0 ? (
            <p className="py-6 text-center text-xs text-neutral-500">No markets found</p>
          ) : (
            filtered.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => {
                  onSelectMarket(m);
                  onClose();
                }}
                className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm text-neutral-200 transition-colors hover:bg-white/10 hover:text-white"
              >
                <span>{m.title}</span>
                {m.category && (
                  <span className="rounded bg-white/5 px-2 py-0.5 text-xs text-neutral-400">
                    {m.category}
                  </span>
                )}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

export function useMarketSearchShortcut(onToggle: () => void) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        onToggle();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onToggle]);
}

export default MarketSearchModal;
