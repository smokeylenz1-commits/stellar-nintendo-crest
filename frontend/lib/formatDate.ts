// Date formatting helpers.
//
// IMPORTANT: relative/locale-formatted strings (e.g. "Ends in 2 days") depend on
// the current time and the browser timezone. Rendering them during SSR produces
// output that diverges from the client render and triggers React hydration
// mismatch warnings. Use `useMounted` (or the `ClientOnlyDate` component) to
// defer these strings until after mount.

import { useEffect, useState } from 'react';

/**
 * Returns true only after the component has mounted on the client.
 * Use this to gate any timezone/locale-dependent rendering so the server and
 * the first client render produce identical markup.
 */
export function useMounted(): boolean {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);
  return mounted;
}

/**
 * Formats a date as a stable, timezone-independent absolute string.
 * Safe to render on both server and client (uses UTC).
 */
export function formatAbsoluteDate(date: Date | string | number): string {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * Formats a date as a relative string (e.g. "Ends in 2 days").
 * This is timezone/time dependent and MUST only be called on the client
 * (after mount) to avoid hydration mismatches.
 */
export function formatRelativeDate(date: Date | string | number): string {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '';

  const diffMs = d.getTime() - Date.now();
  const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));

  if (diffMs <= 0) return 'Ended';
  if (diffDays === 0) return 'Ends today';
  if (diffDays === 1) return 'Ends in 1 day';
  return `Ends in ${diffDays} days`;
}
