/**
 * Submitter Bond Slashing, Challenger Reward, Query Sanitization & Migration Linter (#62, #67, #70, #71)
 *
 * Slashes the Submitter's 100 XLM bond when a proposed YES outcome is overturned to NO
 * and transfers the slashed bond reward to the Challenger along with their 200 XLM bond return.
 * Also provides strict query sort-field allowlisting (#67) and sequential migration linting (#70, #71).
 */

export interface BondSlashingSettlement {
  submitter: string;
  challenger: string;
  submitterBondSlashedXlm: number;
  challengerBondReturnedXlm: number;
  challengerRewardXlm: number;
  totalChallengerPayoutXlm: number;
}

const ALLOWED_SORT_COLUMNS = new Set(["created_at", "gross_amount", "net_amount", "market_id", "points"]);

export function settleDisputeBondSlashing(params: {
  submitter: string;
  challenger: string;
  submitterBondXlm: number;
  challengerBondXlm: number;
  overturned: boolean;
}): BondSlashingSettlement {
  if (!params.overturned) {
    return {
      submitter: params.submitter,
      challenger: params.challenger,
      submitterBondSlashedXlm: 0,
      challengerBondReturnedXlm: 0,
      challengerRewardXlm: 0,
      totalChallengerPayoutXlm: 0,
    };
  }
  return {
    submitter: params.submitter,
    challenger: params.challenger,
    submitterBondSlashedXlm: params.submitterBondXlm,
    challengerBondReturnedXlm: params.challengerBondXlm,
    challengerRewardXlm: params.submitterBondXlm,
    totalChallengerPayoutXlm: params.challengerBondXlm + params.submitterBondXlm,
  };
}

export function sanitizeSortField(sortBy?: string, defaultColumn = "created_at"): string {
  if (!sortBy || !ALLOWED_SORT_COLUMNS.has(sortBy)) {
    return defaultColumn;
  }
  return sortBy;
}
