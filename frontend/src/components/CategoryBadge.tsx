'use client';

import {
  Bitcoin,
  Landmark,
  Trophy,
  FlaskConical,
  Clapperboard,
  Cpu,
  Tag,
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
  /** Badge classes tuned for accessible contrast in light and dark modes. */
  className: string;
}

const CATEGORY_STYLES: Record<MarketCategory, CategoryStyle> = {
  Crypto: {
    icon: Bitcoin,
    className:
      'bg-orange-100 text-orange-800 ring-orange-300 dark:bg-orange-500/15 dark:text-orange-300 dark:ring-orange-500/40',
  },
  Politics: {
    icon: Landmark,
    className:
      'bg-blue-100 text-blue-800 ring-blue-300 dark:bg-blue-500/15 dark:text-blue-300 dark:ring-blue-500/40',
  },
  Sports: {
    icon: Trophy,
    className:
      'bg-green-100 text-green-800 ring-green-300 dark:bg-green-500/15 dark:text-green-300 dark:ring-green-500/40',
  },
  Science: {
    icon: FlaskConical,
    className:
      'bg-teal-100 text-teal-800 ring-teal-300 dark:bg-teal-500/15 dark:text-teal-300 dark:ring-teal-500/40',
  },
  Entertainment: {
    icon: Clapperboard,
    className:
      'bg-pink-100 text-pink-800 ring-pink-300 dark:bg-pink-500/15 dark:text-pink-300 dark:ring-pink-500/40',
  },
  Tech: {
    icon: Cpu,
    className:
      'bg-purple-100 text-purple-800 ring-purple-300 dark:bg-purple-500/15 dark:text-purple-300 dark:ring-purple-500/40',
  },
};

const FALLBACK_STYLE: CategoryStyle = {
  icon: Tag,
  className:
    'bg-gray-100 text-gray-800 ring-gray-300 dark:bg-gray-500/15 dark:text-gray-300 dark:ring-gray-500/40',
};

function resolveStyle(category: string): CategoryStyle {
  return (
    CATEGORY_STYLES[category as MarketCategory] ?? FALLBACK_STYLE
  );
}

interface CategoryBadgeProps {
  category: string;
  /** When provided, the badge becomes an interactive filter button. */
  onSelect?: (category: string) => void;
  /** Marks the badge as the active filter. */
  active?: boolean;
  className?: string;
}

export default function CategoryBadge({
  category,
  onSelect,
  active = false,
  className = '',
}: CategoryBadgeProps) {
  const { icon: Icon, className: colorClassName } = resolveStyle(category);

  const baseClassName = [
    'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset transition-colors',
    colorClassName,
    active ? 'ring-2' : '',
    onSelect
      ? 'cursor-pointer hover:brightness-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 dark:focus-visible:ring-offset-gray-900'
      : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  const content = (
    <>
      <Icon aria-hidden="true" className="h-3 w-3 shrink-0" />
      <span>{category}</span>
    </>
  );

  if (onSelect) {
    return (
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          event.preventDefault();
          onSelect(category);
        }}
        aria-pressed={active}
        aria-label={`Filter markets by ${category}`}
        className={baseClassName}
      >
        {content}
      </button>
    );
  }

  return (
    <span className={baseClassName} aria-label={`Category: ${category}`}>
      {content}
    </span>
  );
}
