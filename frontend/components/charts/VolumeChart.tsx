'use client';

import dynamic from 'next/dynamic';
import { useMemo } from 'react';

const ChartSkeleton = ({ height = 240 }: { height?: number }) => (
  <div
    className="w-full animate-pulse rounded-lg bg-gray-200 dark:bg-gray-700"
    style={{ height }}
    aria-hidden="true"
  />
);

const VolumeChartInner = dynamic(
  () => import('./VolumeChartInner'),
  {
    ssr: false,
    loading: () => <ChartSkeleton />,
  }
);

export interface VolumeChartProps {
  data: { label: string; value: number }[];
  height?: number;
  className?: string;
}

export default function VolumeChart({ data, height = 240, className }: VolumeChartProps) {
  const hasData = useMemo(() => Array.isArray(data) && data.length > 0, [data]);

  if (!hasData) {
    return (
      <div
        className={`flex w-full items-center justify-center rounded-lg border border-dashed border-gray-300 text-sm text-gray-500 dark:border-gray-600 dark:text-gray-400 ${className ?? ''}`}
        style={{ height }}
      >
        No volume data available
      </div>
    );
  }

  return (
    <div className={className} style={{ minHeight: height }}>
      <VolumeChartInner data={data} height={height} />
    </div>
  );
}
