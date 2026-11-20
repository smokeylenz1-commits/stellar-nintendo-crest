import React from 'react';

export type DisputeEventKind =
  | 'market'
  | 'submission'
  | 'challenge'
  | 'bond'
  | 'vote';

export interface DisputeEvent {
  id: string;
  kind: DisputeEventKind;
  title: string;
  description?: string;
  actor?: string;
  amount?: string;
  timestamp: string;
  txHash?: string;
}

interface DisputeTimelineProps {
  events: DisputeEvent[];
  className?: string;
}

const KIND_META: Record<
  DisputeEventKind,
  { label: string; dot: string; badge: string }
> = {
  market: {
    label: 'Market',
    dot: 'bg-slate-400',
    badge: 'bg-slate-100 text-slate-700',
  },
  submission: {
    label: 'Submission',
    dot: 'bg-blue-500',
    badge: 'bg-blue-100 text-blue-700',
  },
  challenge: {
    label: 'Challenge',
    dot: 'bg-amber-500',
    badge: 'bg-amber-100 text-amber-700',
  },
  bond: {
    label: 'Bond',
    dot: 'bg-purple-500',
    badge: 'bg-purple-100 text-purple-700',
  },
  vote: {
    label: 'Vote',
    dot: 'bg-emerald-500',
    badge: 'bg-emerald-100 text-emerald-700',
  },
};

function formatTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return timestamp;
  }
  return date.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

export default function DisputeTimeline({
  events,
  className = '',
}: DisputeTimelineProps) {
  if (!events || events.length === 0) {
    return (
      <div className={`rounded-lg border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500 ${className}`}>
        No dispute events recorded yet.
      </div>
    );
  }

  const ordered = [...events].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );

  return (
    <ol className={`relative space-y-6 border-l border-slate-200 pl-6 ${className}`}>
      {ordered.map((event) => {
        const meta = KIND_META[event.kind] ?? KIND_META.market;
        return (
          <li key={event.id} className="relative">
            <span
              className={`absolute -left-[31px] top-1 h-3 w-3 rounded-full ring-4 ring-white ${meta.dot}`}
              aria-hidden="true"
            />
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={`rounded-full px-2 py-0.5 text-xs font-medium ${meta.badge}`}
              >
                {meta.label}
              </span>
              <span className="text-sm font-semibold text-slate-900">
                {event.title}
              </span>
              <time
                className="ml-auto text-xs text-slate-500"
                dateTime={event.timestamp}
              >
                {formatTimestamp(event.timestamp)}
              </time>
            </div>
            {event.description ? (
              <p className="mt-1 text-sm text-slate-600">{event.description}</p>
            ) : null}
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
              {event.actor ? (
                <span>
                  Actor:{' '}
                  <span className="font-mono text-slate-700">{event.actor}</span>
                </span>
              ) : null}
              {event.amount ? (
                <span>
                  Amount:{' '}
                  <span className="font-medium text-slate-700">{event.amount}</span>
                </span>
              ) : null}
              {event.txHash ? (
                <span>
                  Tx:{' '}
                  <span className="font-mono text-slate-700">
                    {event.txHash.slice(0, 10)}…
                  </span>
                </span>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
