'use client';

import { useMemo, useState } from 'react';
import {
  Bitcoin,
  Landmark,
  Trophy,
  FlaskConical,
  Clapperboard,
  Cpu,
  type LucideIcon,
} from 'lucide-react';

export type MarketCategory =
  | 'Crypto'
  | 'Politics'
  | 'Sports'
  | 'Science'
  | 'Entertainment'
  | 'Tech';

interface CategoryStyle {
  icon: LucideIcon;
  /** Badge classes tuned for AA contrast in light and dark modes. */
  badge: string;
  active: string;
}

const CATEGORY_STYLES: Record<MarketCategory, CategoryStyle> = {
  Crypto: {
    icon: Bitcoin,
    badge:
      'bg-orange-100 text-orange-800 ring-orange-300 dark:bg-orange-500/20 dark:text-orange-200 dark:ring-orange-500/40',
    active: 'ring-2 ring-orange-500',
  },
  Politics: {
    icon: Landmark,
    badge:
      'bg-blue-100 text-blue-800 ring-blue-300 dark:bg-blue-500/20 dark:text-blue-200 dark:ring-blue-500/40',
    active: 'ring-2 ring-blue-500',
  },
  Sports: {
    icon: Trophy,
    badge:
      'bg-green-100 text-green-800 ring-green-300 dark:bg-green-500/20 dark:text-green-200 dark:ring-green-500/40',
    active: 'ring-2 ring-green-500',
  },
  Science: {
    icon: FlaskConical,
    badge:
      'bg-teal-100 text-teal-800 ring-teal-300 dark:bg-teal-500/20 dark:text-teal-200 dark:ring-teal-500/40',
    active: 'ring-2 ring-teal-500',
  },
  Entertainment: {
    icon: Clapperboard,
    badge:
      'bg-pink-100 text-pink-800 ring-pink-300 dark:bg-pink-500/20 dark:text-pink-200 dark:ring-pink-500/40',
    active: 'ring-2 ring-pink-500',
  },
  Tech: {
    icon: Cpu,
    badge:
      'bg-purple-100 text-purple-800 ring-purple-300 dark:bg-purple-500/20 dark:text-purple-200 dark:ring-purple-500/40',
    active: 'ring-2 ring-purple-500',
  },
};

const CATEGORY_ORDER: MarketCategory[] = [
  'Crypto',
  'Politics',
  'Sports',
  'Science',
  'Entertainment',
  'Tech',
];

interface CategoryBadgeProps {
  category: MarketCategory;
  active?: boolean;
  onClick?: (category: MarketCategory) => void;
}

export function CategoryBadge({ category, active, onClick }: CategoryBadgeProps) {
  const style = CATEGORY_STYLES[category];
  const Icon = style.icon;
  const interactive = typeof onClick === 'function';

  return (
    <button
      type="button"
      onClick={interactive ? () => onClick(category) : undefined}
      disabled={!interactive}
      aria-pressed={interactive ? Boolean(active) : undefined}
      aria-label={`Filter by ${category}`}
      className={[
        'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset transition',
        style.badge,
        active ? style.active : '',
        interactive ? 'cursor-pointer hover:brightness-95' : 'cursor-default',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      <span>{category}</span>
    </button>
  );
}

interface Market {
  id: string;
  title: string;
  category?: MarketCategory;
}

interface MarketListProps {
  markets: Market[];
  renderMarket?: (market: Market) => React.ReactNode;
}

export default function MarketList({ markets, renderMarket }: MarketListProps) {
  const [activeCategory, setActiveCategory] = useState<MarketCategory | null>(null);

  const availableCategories = useMemo(() => {
    const present = new Set(markets.map((m) => m.category).filter(Boolean));
    return CATEGORY_ORDER.filter((c) => present.has(c));
  }, [markets]);

  const filteredMarkets = useMemo(
    () =>
      activeCategory
        ? markets.filter((m) => m.category === activeCategory)
        : markets,
    [markets, activeCategory],
  );

  const handleToggle = (category: MarketCategory) => {
    setActiveCategory((current) => (current === category ? null : category));
  };

  return (
    <div className="flex flex-col gap-4">
      {availableCategories.length > 0 && (
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filter markets by category">
          {availableCategories.map((category) => (
            <CategoryBadge
              key={category}
              category={category}
              active={activeCategory === category}
              onClick={handleToggle}
            />
          ))}
          {activeCategory && (
            <button
              type="button"
              onClick={() => setActiveCategory(null)}
              className="text-xs font-medium text-gray-600 underline-offset-2 hover:underline dark:text-gray-300"
            >
              Clear filter
            </button>
          )}
        </div>
      )}

      {filteredMarkets.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">No markets found.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {filteredMarkets.map((market) => (
            <li key={market.id}>
              {renderMarket ? (
                renderMarket(market)
              ) : (
                <div className="flex items-center justify-between gap-3 rounded-lg border border-gray-200 p-3 dark:border-gray-700">
                  <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                    {market.title}
                  </span>
                  {market.category && <CategoryBadge category={market.category} />}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
