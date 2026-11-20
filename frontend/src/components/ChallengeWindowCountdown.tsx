import { useCallback, useEffect, useMemo, useState } from 'react';

export interface ChallengeWindowCountdownProps {
  /** ISO timestamp (or epoch ms) when the challenge window closes. */
  disputeWindowEndsAt: string | number | Date;
  /** Whether the proposed outcome has already been finalized. */
  isFinalized?: boolean;
  /** Whether the current user holds dispute rights for this market. */
  canChallenge?: boolean;
  /** Called once when the countdown reaches zero so the parent can refresh status. */
  onWindowExpired?: () => void;
  /** Invoked when the user clicks the challenge call-to-action. */
  onChallenge?: () => void;
  className?: string;
}

function toMillis(value: string | number | Date): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  return new Date(value).getTime();
}

function formatRemaining(msRemaining: number): string {
  const totalSeconds = Math.max(0, Math.floor(msRemaining / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  return `${hours}h ${minutes}m`;
}

export default function ChallengeWindowCountdown({
  disputeWindowEndsAt,
  isFinalized = false,
  canChallenge = false,
  onWindowExpired,
  onChallenge,
  className,
}: ChallengeWindowCountdownProps) {
  const endMs = useMemo(() => toMillis(disputeWindowEndsAt), [disputeWindowEndsAt]);
  const [now, setNow] = useState<number>(() => Date.now());

  const remainingMs = Math.max(0, endMs - now);
  const isExpired = remainingMs <= 0;

  useEffect(() => {
    if (isFinalized || isExpired) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [isFinalized, isExpired]);

  const handleExpired = useCallback(() => {
    if (onWindowExpired) onWindowExpired();
  }, [onWindowExpired]);

  useEffect(() => {
    if (isFinalized) return;
    if (isExpired) handleExpired();
  }, [isFinalized, isExpired, handleExpired]);

  if (isFinalized) {
    return (
      <div
        className={className}
        role="status"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 12px',
          borderRadius: 999,
          background: '#e6f4ea',
          color: '#1e7e34',
          fontWeight: 600,
          fontSize: 14,
        }}
      >
        Outcome finalized
      </div>
    );
  }

  return (
    <div className={className} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div
        role="status"
        aria-live="polite"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 12px',
          borderRadius: 999,
          background: isExpired ? '#fdecea' : '#fff4e5',
          color: isExpired ? '#b3261e' : '#8a5300',
          fontWeight: 600,
          fontSize: 14,
        }}
      >
        {isExpired
          ? 'Challenge window closed'
          : `Challenge Window Closes in ${formatRemaining(remainingMs)}`}
      </div>

      {canChallenge && !isExpired && (
        <button
          type="button"
          onClick={onChallenge}
          style={{
            alignSelf: 'flex-start',
            padding: '8px 16px',
            borderRadius: 8,
            border: 'none',
            background: '#d97706',
            color: '#fff',
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          Challenge Outcome
        </button>
      )}
    </div>
  );
}
