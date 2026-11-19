'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { Market } from '@/types/market';

interface MarketCardProps {
  market: Market;
}

function formatFullDate(date: Date): string {
  return date.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatRelativeTime(date: Date, now: number): string {
  const diffMs = date.getTime() - now;
  const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));

  if (diffMs <= 0) {
    return 'Ended';
  }

  if (diffDays >= 1) {
    return `Ends in ${diffDays} ${diffDays === 1 ? 'day' : 'days'}`;
  }

  const diffHours = Math.round(diffMs / (1000 * 60 * 60));
  if (diffHours >= 1) {
    return `Ends in ${diffHours} ${diffHours === 1 ? 'hour' : 'hours'}`;
  }

  const diffMinutes = Math.max(1, Math.round(diffMs / (1000 * 60)));
  return `Ends in ${diffMinutes} ${diffMinutes === 1 ? 'minute' : 'minutes'}`;
}

export default function MarketCard({ market }: MarketCardProps) {
  const [mounted, setMounted] = useState(false);
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    setMounted(true);
    setNow(Date.now());
  }, []);

  const expirationDate = new Date(market.expirationDate);
  const fullDate = formatFullDate(expirationDate);
  const relativeTime = formatRelativeTime(expirationDate, now);

  return (
    <Link
      href={`/markets/${market.id}`}
      className="block rounded-lg border border-gray-200 p-4 transition hover:shadow-md"
    >
      <h3 className="text-lg font-semibold text-gray-900">{market.title}</h3>
      {market.description && (
        <p className="mt-1 line-clamp-2 text-sm text-gray-600">
          {market.description}
        </p>
      )}
      <div className="mt-3 flex items-center justify-between text-sm text-gray-500">
        <span title={fullDate}>
          {mounted ? relativeTime : fullDate}
        </span>
        {typeof market.volume === 'number' && (
          <span>Vol: {market.volume.toLocaleString()}</span>
        )}
      </div>
    </Link>
  );
}
