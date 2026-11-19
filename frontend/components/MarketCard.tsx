'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { Market } from '@/lib/types';

interface MarketCardProps {
  market: Market;
}

function formatFullDate(date: Date): string {
  return date.toLocaleString(undefined, {
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
  const relativeTime = mounted ? formatRelativeTime(expirationDate, now) : null;

  return (
    <Link
      href={`/markets/${market.id}`}
      className="block rounded-lg border border-gray-200 bg-white p-4 shadow-sm transition hover:shadow-md"
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-base font-semibold text-gray-900">{market.title}</h3>
        {market.category && (
          <span className="shrink-0 rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600">
            {market.category}
          </span>
        )}
      </div>

      {market.description && (
        <p className="mt-2 line-clamp-2 text-sm text-gray-600">
          {market.description}
        </p>
      )}

      <div className="mt-3 flex items-center justify-between text-sm text-gray-500">
        <span
          className="tabular-nums"
          title={fullDate}
          suppressHydrationWarning
        >
          {relativeTime ?? fullDate}
        </span>
        <span className="font-medium text-gray-700">
          {market.volume != null ? `${market.volume} vol.` : null}
        </span>
      </div>
    </Link>
  );
}
