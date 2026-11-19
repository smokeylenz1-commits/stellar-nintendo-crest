'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useMarkets } from '@/hooks/useMarkets';
import { Market } from '@/types/market';

function formatFullDate(dateString: string): string {
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return dateString;
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatRelativeTime(dateString: string): string {
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return dateString;

  const diffMs = date.getTime() - Date.now();
  const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));

  if (diffMs <= 0) return 'Ended';
  if (diffDays === 0) return 'Ends today';
  if (diffDays === 1) return 'Ends in 1 day';
  return `Ends in ${diffDays} days`;
}

function MarketExpiration({ dateString }: { dateString: string }) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const fullDate = formatFullDate(dateString);

  if (!mounted) {
    return (
      <span className="text-sm text-gray-500" title={fullDate}>
        {fullDate}
      </span>
    );
  }

  return (
    <span className="text-sm text-gray-500" title={fullDate}>
      {formatRelativeTime(dateString)}
    </span>
  );
}

function MarketCard({ market }: { market: Market }) {
  return (
    <Link
      href={`/markets/${market.id}`}
      className="block rounded-lg border border-gray-200 p-4 transition hover:shadow-md"
    >
      <h3 className="text-lg font-semibold text-gray-900">{market.question}</h3>
      <div className="mt-2 flex items-center justify-between">
        <span className="text-sm text-gray-500">{market.category}</span>
        <MarketExpiration dateString={market.expirationDate} />
      </div>
    </Link>
  );
}

export default function MarketsPage() {
  const { markets, isLoading, error } = useMarkets();

  if (isLoading) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-8">
        <p className="text-gray-500">Loading markets...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-8">
        <p className="text-red-600">Failed to load markets.</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <h1 className="mb-6 text-2xl font-bold text-gray-900">Markets</h1>
      {markets.length === 0 ? (
        <p className="text-gray-500">No markets available.</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {markets.map((market) => (
            <MarketCard key={market.id} market={market} />
          ))}
        </div>
      )}
    </div>
  );
}
