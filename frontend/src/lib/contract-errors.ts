/**
 * Human-friendly mapping for Soroban contract error codes (21-28).
 *
 * Soroban surfaces failures as raw numeric codes, e.g. `Error(Contract, #21)`.
 * These helpers translate those codes into plain-language messages plus
 * actionable resolution advice so end users never see raw numbers.
 */

export interface ContractErrorInfo {
  /** Plain-language description of what went wrong. */
  message: string;
  /** Actionable advice on how the user can resolve the failure. */
  resolution: string;
}

/**
 * Contract error codes emitted by the prediction-market contract.
 */
export const CONTRACT_ERRORS: Record<number, ContractErrorInfo> = {
  21: {
    message: "Market has already expired",
    resolution: "This market is closed. Browse open markets to place a new bet.",
  },
  22: {
    message: "Market is not open for betting",
    resolution: "Wait for the market to open, or choose a market that is currently accepting bets.",
  },
  23: {
    message: "Bet amount is below the 1 XLM minimum",
    resolution: "Increase your bet to at least 1 XLM and try again.",
  },
  24: {
    message: "Outcome has already been submitted",
    resolution: "An outcome is already recorded for this market. No further submission is needed.",
  },
  25: {
    message: "Challenge deadline has passed",
    resolution: "The window to challenge this outcome has closed. You can no longer dispute it.",
  },
  26: {
    message: "Insufficient bond provided",
    resolution: "Provide the full required bond amount and retry the transaction.",
  },
  27: {
    message: "Unauthorized caller",
    resolution: "Connect the wallet that owns this action and try again.",
  },
  28: {
    message: "Payout already claimed",
    resolution: "This payout has already been claimed. Check your wallet balance for the funds.",
  },
};

/**
 * Extract a numeric contract error code from a Soroban error string.
 *
 * Handles the common shapes returned by the SDK, e.g.
 * `Error(Contract, #21)`, `HostError: Error(Contract, #21)`,
 * and bare `#21` / `21` fragments.
 */
export function extractContractErrorCode(error: unknown): number | null {
  if (error == null) {
    return null;
  }

  const text =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : String(error);

  const match = text.match(/#(\d+)/) ?? text.match(/\b(\d+)\b/);
  if (!match) {
    return null;
  }

  const code = Number.parseInt(match[1], 10);
  return Number.isNaN(code) ? null : code;
}

/**
 * Resolve a Soroban error into a human-friendly message and resolution advice.
 *
 * Returns `null` when the error is not one of the known contract codes so
 * callers can fall back to their existing handling.
 */
export function getContractErrorInfo(error: unknown): ContractErrorInfo | null {
  const code = extractContractErrorCode(error);
  if (code == null) {
    return null;
  }

  return CONTRACT_ERRORS[code] ?? null;
}

/**
 * Format a contract error into a single toast-ready string.
 *
 * Returns `null` when the error is not a recognized contract code.
 */
export function formatContractError(error: unknown): string | null {
  const info = getContractErrorInfo(error);
  if (!info) {
    return null;
  }

  return `${info.message}. ${info.resolution}`;
}
