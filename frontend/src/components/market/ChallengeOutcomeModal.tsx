"use client";

import React, { useEffect, useState } from "react";

/** Bond needed to challenge a proposed outcome, in XLM. */
export const CHALLENGE_BOND_XLM = 200;

interface ChallengeOutcomeModalProps {
  marketId: number;
  proposedOutcome: "YES" | "NO";
  /** Unix time in milliseconds at which the challenge window closes. */
  deadlineMs: number;
  /** Payout reward on a successful challenge, in XLM. */
  rewardXlm: number;
  onClose: () => void;
  /** Signs and submits the challenge. Resolve when the transaction is confirmed. */
  onChallenge: (marketId: number, bondXlm: number) => Promise<void>;
}

/** Formats the time left as HH:MM:SS, or "Closed" once the deadline has passed. */
export function formatRemaining(deadlineMs: number, nowMs: number): string {
  const remaining = Math.max(0, deadlineMs - nowMs);
  if (remaining === 0) return "Closed";
  const total = Math.floor(remaining / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h, m, s].map((n) => String(n).padStart(2, "0")).join(":");
}

export default function ChallengeOutcomeModal({
  marketId,
  proposedOutcome,
  deadlineMs,
  rewardXlm,
  onClose,
  onChallenge,
}: ChallengeOutcomeModalProps) {
  const [now, setNow] = useState(() => Date.now());
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Tick once a second so the countdown stays live until the deadline.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const closed = now >= deadlineMs;
  const challengedOutcome = proposedOutcome === "YES" ? "NO" : "YES";

  const submit = async () => {
    setPending(true);
    setError(null);
    try {
      await onChallenge(marketId, CHALLENGE_BOND_XLM);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Challenge failed");
    } finally {
      setPending(false);
    }
  };

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="challenge-title" className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-md rounded-2xl border border-surface-border bg-surface-card p-6 space-y-4">
        <h2 id="challenge-title" className="font-heading text-lg text-slate-100">
          Challenge the proposed outcome
        </h2>

        <p className="text-sm text-slate-400">
          The proposed outcome is <strong>{proposedOutcome}</strong>. To contest it, post a bond of{" "}
          <strong>{CHALLENGE_BOND_XLM} XLM</strong> and dispute it to <strong>{challengedOutcome}</strong>.
          A successful challenge pays <strong>{rewardXlm} XLM</strong>.
        </p>

        <div className="text-center" aria-live="polite">
          <p className="text-xs uppercase tracking-wide text-slate-500">Time left to challenge</p>
          <p className="font-mono text-3xl text-amber-300">{formatRemaining(deadlineMs, now)}</p>
        </div>

        {error && <p role="alert" className="text-sm text-red-400">{error}</p>}

        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="px-4 py-2 rounded-lg text-slate-300 hover:bg-white/5">
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={closed || pending}
            className="px-4 py-2 rounded-lg bg-red-500 text-white disabled:opacity-50"
          >
            {pending ? "Signing…" : `Post ${CHALLENGE_BOND_XLM} XLM bond`}
          </button>
        </div>
      </div>
    </div>
  );
}
