'use client';

import { useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';

const ChartSkeleton = ({ height = 280 }: { height?: number }) => (
  <div
    className="animate-pulse rounded-lg bg-gray-200 dark:bg-gray-700"
    style={{ height }}
    aria-hidden="true"
  />
);

const OddsHistoryChartInner = dynamic(
  () => import('./OddsHistoryChartInner'),
  {
    ssr: false,
    loading: () => <ChartSkeleton />,
  }
);

export interface OddsHistoryChartProps {
  data: { timestamp: string | number; odds: number }[];
  height?: number;
  className?: string;
}

/**
 * Lazy-loads the heavy charting library chunk only when the chart scrolls
 * into view, keeping it out of the initial JavaScript bundle.
 */
export default function OddsHistoryChart({
  data,
  height = 280,
  className,
}: OddsHistoryChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    const node = containerRef.current;
    if (!node || isVisible) return;

    if (typeof IntersectionObserver === 'undefined') {
      setIsVisible(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setIsVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '200px' }
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, [isVisible]);

  return (
    <div ref={containerRef} className={className} style={{ minHeight: height }}>
      {isVisible ? (
        <OddsHistoryChartInner data={data} height={height} />
      ) : (
        <ChartSkeleton height={height} />
      )}
    </div>
  );
}
