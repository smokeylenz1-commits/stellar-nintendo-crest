/**
 * Dispute detail data for the public dispute page (#84).
 *
 * The page reads one object per market: both parties, the bonds, the council tally, the evidence
 * links and the dispute timeline. No backend route serves this yet, so `fetchDispute` calls
 * `/api/disputes/:marketId` and expects this shape.
 */

export interface DisputeParty {
  address: string;
  outcome: "YES" | "NO";
  bondXlm: number;
}

export interface CouncilTally {
  votesCast: number;
  quorum: number;
  yesVotes: number;
  noVotes: number;
}

export interface DisputeEvent {
  at: string;
  label: string;
}

export interface DisputeDetail {
  marketId: number;
  question: string;
  submitter: DisputeParty;
  challenger: DisputeParty | null;
  council: CouncilTally;
  evidenceLinks: string[];
  resolutionDeadline: string;
  timeline: DisputeEvent[];
}

export async function fetchDispute(marketId: number): Promise<DisputeDetail> {
  const res = await fetch(`/api/disputes/${marketId}`, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`Dispute ${marketId} could not be loaded (HTTP ${res.status})`);
  }
  return (await res.json()) as DisputeDetail;
}

/** Percentage of the quorum reached, capped at 100. */
export function quorumProgress(council: CouncilTally): number {
  if (council.quorum <= 0) return 0;
  return Math.min(100, Math.round((council.votesCast / council.quorum) * 100));
}
