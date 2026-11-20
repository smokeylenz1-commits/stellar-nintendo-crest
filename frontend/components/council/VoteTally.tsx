import { useMemo } from 'react';

export type CouncilVote = 'YES' | 'NO' | 'CANCEL';

export interface VoteRecord {
  voter: string;
  vote: CouncilVote;
  weight?: number;
  castAt?: string;
}

export interface VoteTallyProps {
  votes: VoteRecord[];
  /** Required M-of-N quorum threshold. */
  threshold: number;
  /** Total number of council members (N). */
  councilSize?: number;
  /** Optional: highlight the connected member's own vote. */
  connectedAddress?: string | null;
}

const VOTE_ORDER: CouncilVote[] = ['YES', 'NO', 'CANCEL'];

const VOTE_STYLES: Record<CouncilVote, { bar: string; text: string; label: string }> = {
  YES: { bar: 'bg-emerald-500', text: 'text-emerald-400', label: 'YES' },
  NO: { bar: 'bg-rose-500', text: 'text-rose-400', label: 'NO' },
  CANCEL: { bar: 'bg-amber-500', text: 'text-amber-400', label: 'CANCEL' },
};

function shortAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/**
 * Real-time vote tally for a disputed market arbitration.
 * Shows per-option counts and progress against the required M-of-N quorum.
 */
export default function VoteTally({
  votes,
  threshold,
  councilSize,
  connectedAddress,
}: VoteTallyProps) {
  const tally = useMemo(() => {
    const counts: Record<CouncilVote, number> = { YES: 0, NO: 0, CANCEL: 0 };
    for (const record of votes) {
      if (record.vote in counts) {
        counts[record.vote] += record.weight ?? 1;
      }
    }
    return counts;
  }, [votes]);

  const totalCast = tally.YES + tally.NO + tally.CANCEL;
  const quorumReached = totalCast >= threshold;
  const quorumPct = threshold > 0 ? Math.min(100, (totalCast / threshold) * 100) : 0;

  return (
    <section className="rounded-lg border border-slate-700 bg-slate-900/60 p-5">
      <header className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-slate-100">Vote Tally</h2>
        <span
          className={
            'rounded-full px-3 py-1 text-xs font-medium ' +
            (quorumReached
              ? 'bg-emerald-500/15 text-emerald-400'
              : 'bg-slate-700/60 text-slate-300')
          }
        >
          {quorumReached ? 'Quorum reached' : 'Quorum pending'}
        </span>
      </header>

      <div className="mb-4">
        <div className="mb-1 flex items-center justify-between text-sm text-slate-300">
          <span>
            {totalCast} / {threshold} required
            {typeof councilSize === 'number' ? ` (of ${councilSize} members)` : ''}
          </span>
          <span>{Math.round(quorumPct)}%</span>
        </div>
        <div className="h-2 w-full overflow-hidden rounded-full bg-slate-800">
          <div
            className={
              'h-full rounded-full transition-all ' +
              (quorumReached ? 'bg-emerald-500' : 'bg-sky-500')
            }
            style={{ width: `${quorumPct}%` }}
          />
        </div>
      </div>

      <ul className="space-y-3">
        {VOTE_ORDER.map((option) => {
          const count = tally[option];
          const pct = totalCast > 0 ? (count / totalCast) * 100 : 0;
          const style = VOTE_STYLES[option];
          return (
            <li key={option}>
              <div className="mb-1 flex items-center justify-between text-sm">
                <span className={`font-medium ${style.text}`}>{style.label}</span>
                <span className="text-slate-300">{count}</span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
                <div
                  className={`h-full rounded-full transition-all ${style.bar}`}
                  style={{ width: `${pct}%` }}
                />
              </div>
            </li>
          );
        })}
      </ul>

      {votes.length > 0 && (
        <div className="mt-5 border-t border-slate-800 pt-4">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
            Cast votes
          </h3>
          <ul className="space-y-1 text-sm">
            {votes.map((record, index) => {
              const isSelf =
                !!connectedAddress &&
                record.voter.toLowerCase() === connectedAddress.toLowerCase();
              return (
                <li
                  key={`${record.voter}-${index}`}
                  className="flex items-center justify-between text-slate-300"
                >
                  <span className={isSelf ? 'font-medium text-slate-100' : ''}>
                    {shortAddress(record.voter)}
                    {isSelf ? ' (you)' : ''}
                  </span>
                  <span className={VOTE_STYLES[record.vote]?.text ?? 'text-slate-300'}>
                    {record.vote}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}
