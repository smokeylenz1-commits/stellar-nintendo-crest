'use client';

import React from 'react';

interface ChartSkeletonProps {
  /** Height of the chart placeholder. Should match the lazy-loaded chart's height to avoid layout shift. */
  height?: number | string;
  /** Optional label describing what is loading, used for accessibility. */
  label?: string;
  /** Additional class names for layout/spacing parity with the real chart. */
  className?: string;
}

/**
 * Lightweight placeholder rendered while a heavy chart chunk (Chart.js / Recharts)
 * is being lazy-loaded via next/dynamic. It reserves the same vertical space as the
 * real chart so the swap does not cause layout shift.
 */
export default function ChartSkeleton({
  height = 320,
  label = 'Loading chart',
  className = '',
}: ChartSkeletonProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={label}
      className={`flex w-full animate-pulse items-center justify-center rounded-lg bg-gray-100 dark:bg-gray-800 ${className}`}
      style={{ height }}
    >
      <span className="sr-only">{label}</span>
      <svg
        aria-hidden="true"
        className="h-8 w-8 text-gray-300 dark:text-gray-600"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M3 3v18h18" />
        <path d="M7 15l3-4 3 3 4-6" />
      </svg>
    </div>
  );
}
