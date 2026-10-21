"use client";

import React, { useEffect, useState } from "react";
import { fetchDispute, quorumProgress, type DisputeDetail, type DisputeParty } from "@/services/dispute";

interface DisputePageProps {
  params: { marketId: string };
}

function PartyCard({ title, party }: { title: string; party: DisputeParty | null }) {
  return (
    <div className="rounded-xl border border-surface-border bg-surface-card p-4 space-y-1">
      <h3 className="text-sm font-semibold text-slate-300">{title}</h3>
      {party ? (
        <>
          <p className="font-mono text-xs text-slate-400 break-all">{party.address}</p>
          <p className="text-sm text-slate-200">
            Outcome <strong>{party.outcome}</strong> · Bond <strong>{party.bondXlm} XLM</strong>
          </p>
        </>
      ) : (
        <p className="text-sm text-slate-500">No challenge posted yet.</p>
      )}
    </div>
  );
}

export default function DisputePage({ params }: DisputePageProps) {
  const marketId = Number(params.marketId);
  const [dispute, setDispute] = useState<DisputeDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Refresh every 15 seconds so council votes appear as they are cast.
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetchDispute(marketId)
        .then((d) => !cancelled && setDispute(d))
        .catch((e: Error) => !cancelled && setError(e.message));
    load();
    const id = setInterval(load, 15_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [marketId]);

  if (error) return <p role="alert" className="p-6 text-red-400">{error}</p>;
  if (!dispute) return <p className="p-6 text-slate-400">Loading dispute…</p>;

  const progress = quorumProgress(dispute.council);

  return (
    <main className="mx-auto max-w-3xl space-y-6 p-6">
      <header className="space-y-1">
        <p className="text-xs uppercase tracking-wide text-slate-500">Dispute · market #{dispute.marketId}</p>
        <h1 className="font-heading text-2xl text-slate-100">{dispute.question}</h1>
        <p className="text-sm text-slate-400">Resolution deadline {dispute.resolutionDeadline}</p>
      </header>

      <section className="grid gap-4 md:grid-cols-2">
        <PartyCard title="Submitter" party={dispute.submitter} />
        <PartyCard title="Challenger" party={dispute.challenger} />
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-slate-300">Council vote</h2>
        <div
          role="progressbar"
          aria-valuenow={progress}
          aria-valuemin={0}
          aria-valuemax={100}
          className="h-2 w-full overflow-hidden rounded-full bg-surface-border"
        >
          <div className="h-full bg-purple-500" style={{ width: `${progress}%` }} />
        </div>
        <p className="text-sm text-slate-400">
          {dispute.council.votesCast} of {dispute.council.quorum} votes ·{" "}
          YES {dispute.council.yesVotes} · NO {dispute.council.noVotes}
        </p>
      </section>

      {dispute.evidenceLinks.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-slate-300">Audit evidence</h2>
          <ul className="list-disc pl-5 text-sm text-primary-400">
            {dispute.evidenceLinks.map((href) => (
              <li key={href}>
                <a href={href} target="_blank" rel="noreferrer" className="underline">
                  {href}
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-slate-300">Timeline</h2>
        <ol className="space-y-2 border-l border-surface-border pl-4">
          {dispute.timeline.map((ev) => (
            <li key={`${ev.at}-${ev.label}`} className="text-sm text-slate-300">
              <span className="text-xs text-slate-500">{ev.at}</span> — {ev.label}
            </li>
          ))}
        </ol>
      </section>
    </main>
  );
}
