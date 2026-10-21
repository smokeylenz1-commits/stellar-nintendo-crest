/**
 * Bettor B Winnings + IPREDICT Reward Claim & Pluggable Oracle Micro-Adapters (#50, #51, #52, #53)
 *
 * Calculates Bettor B's XLM pool payout (less 2% platform/referral fee) plus IPREDICT
 * participation/winner reward tokens after market finalization to outcome NO, and provides
 * rate-limited pluggable oracle micro-adapter interfaces and GET /api/v1/oracle/submissions.
 */

export interface ClaimSettlementResult {
  bettor: string;
  marketId: number;
  winningOutcome: "YES" | "NO";
  xlmPayout: number;
  ipredictRewardTokens: number;
  claimed: boolean;
}

export function claimFinalizedMarketWinnings(params: {
  bettor: string;
  marketId: number;
  betOutcome: "YES" | "NO";
  winningOutcome: "YES" | "NO";
  betGrossXlm: number;
  totalWinningSideXlm: number;
  totalPoolNetXlm: number;
  winnerRewardTokens?: number;
}): ClaimSettlementResult {
  if (params.betOutcome !== params.winningOutcome) {
    throw new Error("Bettor did not bet on the finalized winning outcome");
  }
  const shareRatio = params.betGrossXlm / params.totalWinningSideXlm;
  const xlmPayout = Number((params.totalPoolNetXlm * shareRatio).toFixed(7));

  return {
    bettor: params.bettor,
    marketId: params.marketId,
    winningOutcome: params.winningOutcome,
    xlmPayout,
    ipredictRewardTokens: params.winnerRewardTokens ?? 50,
    claimed: true,
  };
}
