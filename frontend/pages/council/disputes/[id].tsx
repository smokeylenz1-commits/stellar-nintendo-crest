import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/router';
import Head from 'next/head';
import { useWallet } from '../../../hooks/useWallet';
import { fetchDispute, castCouncilVote } from '../../../lib/oracleApi';

type VoteChoice = 'YES' | 'NO' | 'CANCEL';

interface TimelineEvent {
  id: string;
  type: 'MARKET' | 'SUBMISSION' | 'CHALLENGE' | 'BOND' | 'VOTE';
  label: string;
  actor?: string;
  amount?: string;
  timestamp: string;
  txHash?: string;
}

interface VoteTally {
  yes: number;
  no: number;
  cancel: number;
}

interface DisputeDetail {
  id: string;
  marketId: string;
  marketQuestion: string;
  marketTerms: string;
  status: string;
  quorum: { required: number; total: number };
  tally: VoteTally;
  councilMembers: string[];
  timeline: TimelineEvent[];
}

const EVENT_STYLES: Record<TimelineEvent['type'], string> = {
  MARKET: 'border-blue-500',
  SUBMISSION: 'border-emerald-500',
  CHALLENGE: 'border-amber-500',
  BOND: 'border-purple-500',
  VOTE: 'border-slate-500',
};

function formatTimestamp(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

export default function CouncilDisputePage() {
  const router = useRouter();
  const { id } = router.query;
  const { address, connected, connect } = useWallet();
  const [dispute, setDispute] = useState<DisputeDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<VoteChoice | null>(null);
  const [voteError, setVoteError] = useState<string | null>(null);

  const loadDispute = useCallback(async () => {
    if (typeof id !== 'string') return;
    try {
      const data = await fetchDispute(id);
      setDispute(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load dispute');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    loadDispute();
  }, [loadDispute]);

  useEffect(() => {
    if (typeof id !== 'string') return;
    const interval = setInterval(loadDispute, 10000);
    return () => clearInterval(interval);
  }, [id, loadDispute]);

  const isCouncilMember = useMemo(() => {
    if (!dispute || !address) return false;
    return dispute.councilMembers.some((m) => m.toLowerCase() === address.toLowerCase());
  }, [dispute, address]);

  const quorumReached = useMemo(() => {
    if (!dispute) return false;
    const cast = dispute.tally.yes + dispute.tally.no + dispute.tally.cancel;
    return cast >= dispute.quorum.required;
  }, [dispute]);

  const handleVote = async (choice: VoteChoice) => {
    if (!dispute || !address) return;
    setSubmitting(choice);
    setVoteError(null);
    try {
      await castCouncilVote(dispute.id, choice, address);
      await loadDispute();
    } catch (err) {
      setVoteError(err instanceof Error ? err.message : 'Failed to submit vote');
    } finally {
      setSubmitting(null);
    }
  };

  if (loading) {
    return <div className="p-8 text-slate-400">Loading dispute…</div>;
  }

  if (error || !dispute) {
    return <div className="p-8 text-red-400">{error ?? 'Dispute not found'}</div>;
  }

  const castVotes = dispute.tally.yes + dispute.tally.no + dispute.tally.cancel;

  return (
    <>
      <Head>
        <title>Council Dispute {dispute.id} | Oracle</title>
      </Head>
      <main className="mx-auto max-w-4xl p-6 space-y-8">
        <header className="space-y-2">
          <p className="text-sm text-slate-400">Market {dispute.marketId}</p>
          <h1 className="text-2xl font-semibold">{dispute.marketQuestion}</h1>
          <span className="inline-block rounded bg-slate-800 px-2 py-1 text-xs uppercase tracking-wide text-slate-300">
            {dispute.status}
          </span>
        </header>

        <section className="rounded-lg border border-slate-700 p-4">
          <h2 className="mb-2 text-lg font-medium">Market Terms</h2>
          <p className="whitespace-pre-wrap text-sm text-slate-300">{dispute.marketTerms}</p>
        </section>

        <section className="rounded-lg border border-slate-700 p-4">
          <h2 className="mb-4 text-lg font-medium">Dispute Timeline</h2>
          <ol className="space-y-4">
            {dispute.timeline.map((event) => (
              <li key={event.id} className={`border-l-4 pl-4 ${EVENT_STYLES[event.type]}`}>
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">{event.label}</span>
                  <span className="text-xs text-slate-400">{formatTimestamp(event.timestamp)}</span>
                </div>
                {event.actor && <p className="text-xs text-slate-400">Actor: {event.actor}</p>}
                {event.amount && <p className="text-xs text-slate-400">Amount: {event.amount}</p>}
                {event.txHash && <p className="text-xs text-slate-500 break-all">Tx: {event.txHash}</p>}
              </li>
            ))}
          </ol>
        </section>

        <section className="rounded-lg border border-slate-700 p-4">
          <h2 className="mb-4 text-lg font-medium">Vote Tally</h2>
          <div className="grid grid-cols-3 gap-4 text-center">
            <div>
              <p className="text-2xl font-semibold text-emerald-400">{dispute.tally.yes}</p>
              <p className="text-xs text-slate-400">YES</p>
            </div>
            <div>
              <p className="text-2xl font-semibold text-red-400">{dispute.tally.no}</p>
              <p className="text-xs text-slate-400">NO</p>
            </div>
            <div>
              <p className="text-2xl font-semibold text-amber-400">{dispute.tally.cancel}</p>
              <p className="text-xs text-slate-400">CANCEL</p>
            </div>
          </div>
          <p className="mt-4 text-sm text-slate-300">
            Quorum: {castVotes} / {dispute.quorum.required} required ({dispute.quorum.total} council members)
            {quorumReached && <span className="ml-2 text-emerald-400">Quorum reached</span>}
          </p>
        </section>

        <section className="rounded-lg border border-slate-700 p-4 space-y-3">
          <h2 className="text-lg font-medium">Cast Vote</h2>
          {!connected ? (
            <button
              type="button"
              onClick={connect}
              className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500"
            >
              Connect Wallet
            </button>
          ) : !isCouncilMember ? (
            <p className="text-sm text-amber-400">Connected wallet is not a council member for this dispute.</p>
          ) : (
            <div className="flex flex-wrap gap-3">
              {(['YES', 'NO', 'CANCEL'] as VoteChoice[]).map((choice) => (
                <button
                  key={choice}
                  type="button"
                  disabled={submitting !== null}
                  onClick={() => handleVote(choice)}
                  className="rounded bg-slate-700 px-4 py-2 text-sm font-medium text-white hover:bg-slate-600 disabled:opacity-50"
                >
                  {submitting === choice ? 'Submitting…' : `Vote ${choice}`}
                </button>
              ))}
            </div>
          )}
          {voteError && <p className="text-sm text-red-400">{voteError}</p>}
        </section>
      </main>
    </>
  );
}
