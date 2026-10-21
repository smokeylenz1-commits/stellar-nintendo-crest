import React, { useMemo, useState } from 'react';

const PROTOCOL_FEE = 0.02;

export interface BetSlipProps {
  /** Current total amount already staked in the pool (excluding this bet). */
  pool?: number;
  /** Total size of the parimutuel pool used for payout estimation. */
  totalPool?: number;
  /** Optional initial stake value. */
  initialStake?: number;
  /** Called when the user confirms the bet with the chosen stake. */
  onPlaceBet?: (stake: number) => void;
}

/**
 * Bet placement widget with an interactive ROI / payout calculator.
 *
 * Estimated payout follows the parimutuel formula:
 *   payout = (stake / (pool + stake)) * totalPool * (1 - PROTOCOL_FEE)
 */
export default function BetSlip({
  pool = 0,
  totalPool = 0,
  initialStake = 0,
  onPlaceBet,
}: BetSlipProps) {
  const [stake, setStake] = useState<number>(initialStake);

  const { payout, profit, multiplier, netReturn } = useMemo(() => {
    const safeStake = Number.isFinite(stake) && stake > 0 ? stake : 0;
    const safePool = Number.isFinite(pool) && pool > 0 ? pool : 0;
    const safeTotalPool = Number.isFinite(totalPool) && totalPool > 0 ? totalPool : 0;

    const share = safePool + safeStake > 0 ? safeStake / (safePool + safeStake) : 0;
    const grossPayout = share * safeTotalPool;
    const netPayout = grossPayout * (1 - PROTOCOL_FEE);
    const netProfit = netPayout - safeStake;
    const mult = safeStake > 0 ? netPayout / safeStake : 0;
    const roi = safeStake > 0 ? (netProfit / safeStake) * 100 : 0;

    return {
      payout: netPayout,
      profit: netProfit,
      multiplier: mult,
      netReturn: roi,
    };
  }, [stake, pool, totalPool]);

  const handleStakeChange = (value: number) => {
    if (Number.isNaN(value)) {
      setStake(0);
      return;
    }
    setStake(Math.max(0, value));
  };

  const format = (value: number) =>
    value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  return (
    <div className="bet-slip">
      <h3 className="bet-slip__title">Place Bet</h3>

      <label className="bet-slip__field">
        <span>Stake</span>
        <input
          type="number"
          min={0}
          step="0.01"
          value={stake}
          onChange={(e) => handleStakeChange(parseFloat(e.target.value))}
          aria-label="Stake amount"
        />
      </label>

      <input
        type="range"
        min={0}
        max={Math.max(1000, stake * 2)}
        step="1"
        value={stake}
        onChange={(e) => handleStakeChange(parseFloat(e.target.value))}
        aria-label="Stake slider"
      />

      <div className="bet-slip__calculator">
        <div className="bet-slip__row">
          <span>Potential payout</span>
          <strong>{format(payout)}</strong>
        </div>
        <div className="bet-slip__row">
          <span>Potential profit</span>
          <strong className={profit >= 0 ? 'positive' : 'negative'}>{format(profit)}</strong>
        </div>
        <div className="bet-slip__row">
          <span>Multiplier</span>
          <strong>{multiplier.toFixed(2)}x</strong>
        </div>
        <div className="bet-slip__row">
          <span>Net return (after fees)</span>
          <strong>{netReturn.toFixed(2)}%</strong>
        </div>
        <p className="bet-slip__fee-note">
          Includes a {(PROTOCOL_FEE * 100).toFixed(0)}% protocol fee deduction.
        </p>
      </div>

      <button
        type="button"
        className="bet-slip__submit"
        disabled={stake <= 0}
        onClick={() => onPlaceBet?.(stake)}
      >
        Place Bet
      </button>
    </div>
  );
}
