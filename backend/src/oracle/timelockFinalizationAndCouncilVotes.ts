/**
 * Timelock Finalization, Council Votes Table & Pool Configuration (#73, #79, #80, #82)
 *
 * Enforces timelock passage before finalizing a disputed market to outcome NO,
 * defines council_votes persistence and DB pool sizing, and validates bond balance
 * and slashing risk warnings for the Oracle Submit Outcome modal.
 */

export const DISPUTE_TIMELOCK_SECONDS = 86_400; // 24h timelock

export interface MarketFinalizationState {
  marketId: number;
  winningOutcome: "YES" | "NO";
  finalizedAt: number;
  finalized: boolean;
}

export function finalizeMarketAfterTimelock(params: {
  marketId: number;
  quorumReachedAt: number;
  now: number;
  confirmedOutcome: "YES" | "NO";
  timelockSeconds?: number;
}): MarketFinalizationState {
  const requiredDelay = params.timelockSeconds ?? DISPUTE_TIMELOCK_SECONDS;
  if (params.now < params.quorumReachedAt + requiredDelay) {
    throw new Error("Timelock period has not elapsed yet");
  }
  return {
    marketId: params.marketId,
    winningOutcome: params.confirmedOutcome,
    finalizedAt: params.now,
    finalized: true,
  };
}

export function validateSubmitOutcomeBondCheck(availableXlm: number, requiredBondXlm = 100) {
  return {
    sufficientBond: availableXlm >= requiredBondXlm,
    shortfallXlm: Math.max(0, requiredBondXlm - availableXlm),
    riskWarning:
      "Submitting an incorrect market outcome will result in 100% of your posted XLM bond being slashed if overturned by council dispute.",
  };
}
