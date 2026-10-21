/**
 * Bond escrow invariant (#48).
 *
 * Checks `total_bonds_deposited - total_bonds_settled == current_escrow_holdings`, the balance the
 * contract's XLM account must hold. A mismatch means an accounting leak or a rounding error. The
 * check reports the difference and asks the caller to trip the circuit breaker, so automated
 * resolution halts until someone looks.
 */

export interface EscrowFigures {
  totalDeposited: bigint;
  totalSettled: bigint;
  /** The XLM balance the contract actually holds, in stroops. */
  onChainHoldings: bigint;
}

export interface InvariantResult {
  holds: boolean;
  expected: bigint;
  actual: bigint;
  /** `actual - expected`. Zero when the invariant holds. */
  difference: bigint;
}

/** Evaluates the escrow invariant from the recorded figures and the on-chain holdings. */
export function checkEscrowInvariant(figures: EscrowFigures): InvariantResult {
  const expected = figures.totalDeposited - figures.totalSettled;
  const difference = figures.onChainHoldings - expected;
  return {
    holds: difference === 0n,
    expected,
    actual: figures.onChainHoldings,
    difference,
  };
}

export interface EscrowWorkerDeps {
  readFigures(): Promise<EscrowFigures>;
  tripCircuitBreaker(reason: string): Promise<void>;
  alertOps(message: string, fields: Record<string, unknown>): Promise<void>;
}

/** One pass. On a mismatch it alerts ops and trips the breaker. Returns the result. */
export async function runEscrowCheck(deps: EscrowWorkerDeps): Promise<InvariantResult> {
  const result = checkEscrowInvariant(await deps.readFigures());
  if (!result.holds) {
    const reason = `escrow invariant broken by ${result.difference} stroops`;
    await deps.alertOps(reason, {
      expected: result.expected.toString(),
      actual: result.actual.toString(),
    });
    await deps.tripCircuitBreaker(reason);
  }
  return result;
}
