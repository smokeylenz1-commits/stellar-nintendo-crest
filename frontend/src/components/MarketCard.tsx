'use client';

import Link from 'next/link';
import {
  Bitcoin,
  Landmark,
  Trophy,
  FlaskConical,
  Clapperboard,
  Cpu,
  Tag,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export type MarketCategory =
  | 'Crypto'
  | 'Politics'
  | 'Sports'
  | 'Science'
  | 'Entertainment'
  | 'Tech';

interface CategoryStyle {
  icon: LucideIcon;
  badge: string;
}

const CATEGORY_STYLES: Record<MarketCategory, CategoryStyle> = {
  Crypto: {
    icon: Bitcoin,
    badge:
      'bg-orange-100 text-orange-800 ring-orange-300 hover:bg-orange-200 dark:bg-orange-500/20 dark:text-orange-200 dark:ring-orange-500/40 dark:hover:bg-orange-500/30',
  },
  Politics: {
    icon: Landmark,
    badge:
      'bg-blue-100 text-blue-800 ring-blue-300 hover:bg-blue-200 dark:bg-blue-500/20 dark:text-blue-200 dark:ring-blue-500/40 dark:hover:bg-blue-500/30',
  },
  Sports: {
    icon: Trophy,
    badge:
      'bg-green-100 text-green-800 ring-green-300 hover:bg-green-200 dark:bg-green-500/20 dark:text-green-200 dark:ring-green-500/40 dark:hover:bg-green-500/30',
  },
  Science: {
    icon: FlaskConical,
    badge:
      'bg-teal-100 text-teal-800 ring-teal-300 hover:bg-teal-200 dark:bg-teal-500/20 dark:text-teal-200 dark:ring-teal-500/40 dark:hover:bg-teal-500/30',
  },
  Entertainment: {
    icon: Clapperboard,
    badge:
      'bg-pink-100 text-pink-800 ring-pink-300 hover:bg-pink-200 dark:bg-pink-500/20 dark:text-pink-200 dark:ring-pink-500/40 dark:hover:bg-pink-500/30',
  },
  Tech: {
    icon: Cpu,
    badge:
      'bg-purple-100 text-purple-800 ring-purple-300 hover:bg-purple-200 dark:bg-purple-500/20 dark:text-purple-200 dark:ring-purple-500/40 dark:hover:bg-purple-500/30',
  },
};

interface CategoryBadgeProps {
  category: MarketCategory | string;
  className?: string;
}

/**
 * Non-interactive category badge with color coding and an icon indicator.
 * Used inside market cards where the whole card is already a link.
 */
export function CategoryBadge({ category, className = '' }: CategoryBadgeProps) {
  const style = CATEGORY_STYLES[category as MarketCategory];
  const Icon = style?.icon ?? Tag;
  const badgeClass =
    style?.badge ??
    'bg-gray-100 text-gray-800 ring-gray-300 dark:bg-gray-500/20 dark:text-gray-200 dark:ring-gray-500/40';

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${badgeClass} ${className}`}
    >
      <Icon className="h-3 w-3" aria-hidden="true" />
      {category}
    </span>
  );
}

interface CategoryFilterBadgeProps {
  category: MarketCategory | string;
  active?: boolean;
  className?: string;
}

/**
 * Interactive category badge that links to the filtered market list.
 */
export function CategoryFilterBadge({
  category,
  active = false,
  className = '',
}: CategoryFilterBadgeProps) {
  const style = CATEGORY_STYLES[category as MarketCategory];
  const Icon = style?.icon ?? Tag;
  const badgeClass =
    style?.badge ??
    'bg-gray-100 text-gray-800 ring-gray-300 dark:bg-gray-500/20 dark:text-gray-200 dark:ring-gray-500/40';

  return (
    <Link
      href={`/markets?category=${encodeURIComponent(category)}`}
      aria-pressed={active}
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset transition-colors ${badgeClass} ${
        active ? 'ring-2' : ''
      } ${className}`}
    >
      <Icon className="h-3 w-3" aria-hidden="true" />
      {category}
    </Link>
  );
}

export interface MarketCardProps {
  id: string;
  title: string;
  category?: MarketCategory | string;
  yesPrice?: number;
  volume?: number;
  endDate?: string;
}

export default function MarketCard({
  id,
  title,
  category,
  yesPrice,
  volume,
  endDate,
}: MarketCardProps) {
  return (
    <Link
      href={`/markets/${id}`}
      className="block rounded-lg border border-gray-200 bg-white p-4 transition-shadow hover:shadow-md dark:border-gray-700 dark:bg-gray-900"
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
          {title}
        </h3>
        {category ? <CategoryBadge category={category} /> : null}
      </div>
      <div className="mt-3 flex items-center gap-4 text-xs text-gray-600 dark:text-gray-400">
        {typeof yesPrice === 'number' ? (
          <span>
            Yes:{' '}
            <span className="font-medium text-gray-900 dark:text-gray-100">
              {Math.round(yesPrice * 100)}%
            </span>
          </span>
        ) : null}
        {typeof volume === 'number' ? (
          <span>
            Vol:{' '}
            <span className="font-medium text-gray-900 dark:text-gray-100">
              {volume.toLocaleString()}
            </span>
          </span>
        ) : null}
        {endDate ? <span>Ends: {endDate}</span> : null}
      </div>
    </Link>
  );
}
