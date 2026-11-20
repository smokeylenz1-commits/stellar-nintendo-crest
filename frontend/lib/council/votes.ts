export type CouncilVote = "YES" | "NO" | "CANCEL";

export interface CouncilVoteRecord {
  voter: string;
  vote: CouncilVote;
  weight?: number;
  castAt?: string;
  txHash?: string;
}

export interface CouncilVoteTally {
  yes: number;
  no: number;
  cancel: number;
  total: number;
  quorum: number;
  thresholdMet: boolean;
  remaining: number;
}

/**
 * Aggregate individual council vote records into a tally against the
 * required M-of-N quorum threshold.
 *
 * `quorum` is the minimum number of participating votes required for the
 * tally to be considered decisive. Each voter contributes their `weight`
 * (defaulting to 1) to the bucket matching their vote.
 */
export function tallyCouncilVotes(
  votes: CouncilVoteRecord[],
  quorum: number,
): CouncilVoteTally {
  let yes = 0;
  let no = 0;
  let cancel = 0;

  for (const record of votes) {
    const weight = record.weight ?? 1;
    switch (record.vote) {
      case "YES":
        yes += weight;
        break;
      case "NO":
        no += weight;
        break;
      case "CANCEL":
        cancel += weight;
        break;
    }
  }

  const total = yes + no + cancel;
  const safeQuorum = Math.max(0, quorum);

  return {
    yes,
    no,
    cancel,
    total,
    quorum: safeQuorum,
    thresholdMet: total >= safeQuorum,
    remaining: Math.max(0, safeQuorum - total),
  };
}

/**
 * Determine whether a given wallet address has already cast a vote in the
 * current dispute, so the UI can disable duplicate submissions.
 */
export function hasVoted(
  votes: CouncilVoteRecord[],
  address: string | null | undefined,
): boolean {
  if (!address) return false;
  const normalized = address.trim().toUpperCase();
  return votes.some((record) => record.voter.trim().toUpperCase() === normalized);
}

export const COUNCIL_VOTE_OPTIONS: CouncilVote[] = ["YES", "NO", "CANCEL"];
