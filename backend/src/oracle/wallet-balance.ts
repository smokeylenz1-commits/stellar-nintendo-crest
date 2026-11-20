/**
 * Hot-wallet XLM reserve monitor (#41).
 *
 * The oracle posts bonds from a hot wallet, so the reserve must stay above the bond needs. This
 * checks the balance against a floor and alerts through a high-priority channel when it drops
 * below. Alerts are raised before the reserve is empty: the warning floor is twice the minimum.
 *
 * #227 extends this into a periodic treasury monitor: it reports the relayer wallet XLM reserve
 * to the monitoring channel and metrics endpoint, alerts when the reserve drops below 100 XLM,
 * alerts when escrowed challenge bond capacity is depleted, and exposes an auto-replenishment
 * trigger hook.
 */

export const MINIMUM_FLOOR_XLM = 500;
const WARNING_MULTIPLIER = 2;

/** Relayer wallet XLM reserve below which a treasury alert fires (#227). */
export const RELAYER_ALERT_THRESHOLD_XLM = 100;

export type ReserveStatus = "ok" | "warning" | "critical";

export interface ReserveReading {
  status: ReserveStatus;
  balanceXlm: number;
  floorXlm: number;
}

/** Classifies a balance. Below the floor is critical; below twice the floor is a warning. */
export function classifyReserve(balanceXlm: number, floorXlm = MINIMUM_FLOOR_XLM): ReserveReading {
  let status: ReserveStatus = "ok";
  if (balanceXlm < floorXlm) {
    status = "critical";
  } else if (balanceXlm < floorXlm * WARNING_MULTIPLIER) {
    status = "warning";
  }
  return { status, balanceXlm, floorXlm };
}

export interface WalletMonitorDeps {
  balanceXlm(): Promise<number>;
  alertHighPriority(message: string, fields: Record<string, unknown>): Promise<void>;
  floorXlm?: number;
}

/** One check. Sends a high-priority alert when the reserve is in warning or critical. */
export async function checkHotWallet(deps: WalletMonitorDeps): Promise<ReserveReading> {
  const reading = classifyReserve(await deps.balanceXlm(), deps.floorXlm ?? MINIMUM_FLOOR_XLM);
  if (reading.status !== "ok") {
    await deps.alertHighPriority(
      `Oracle hot wallet reserve is ${reading.status}: ${reading.balanceXlm} XLM (floor ${reading.floorXlm})`,
      { ...reading },
    );
  }
  return reading;
}

/** Escrowed challenge bond capacity reading (#227). */
export interface BondCapacityReading {
  depleted: boolean;
  availableXlm: number;
  requiredXlm: number;
}

/** A bond capacity is depleted when the available escrow cannot cover the required bond. */
export function classifyBondCapacity(
  availableXlm: number,
  requiredXlm: number,
): BondCapacityReading {
  return { depleted: availableXlm < requiredXlm, availableXlm, requiredXlm };
}

/** Hook invoked to trigger automated auto-replenishment of the relayer wallet (#227). */
export type ReplenishHook = (shortfallXlm: number) => Promise<void>;

export interface TreasuryMonitorDeps {
  /** Current relayer wallet XLM balance. */
  relayerBalanceXlm(): Promise<number>;
  /** Current escrowed challenge bond capacity in XLM. */
  bondCapacityXlm(): Promise<number>;
  /** XLM required to keep challenge bonds funded. */
  requiredBondXlm(): number;
  /** Reports a reading to the monitoring channel. */
  report(message: string, fields: Record<string, unknown>): Promise<void>;
  /** Publishes a reading to the metrics endpoint. */
  publishMetrics(metrics: Record<string, number>): Promise<void>;
  /** High-priority alert channel. */
  alertHighPriority(message: string, fields: Record<string, unknown>): Promise<void>;
  /** Optional auto-replenishment trigger hook. */
  replenish?: ReplenishHook;
  /** Relayer XLM threshold below which an alert fires. Defaults to 100 XLM. */
  relayerThresholdXlm?: number;
}

export interface TreasuryReading {
  relayerBalanceXlm: number;
  relayerBelowThreshold: boolean;
  bondCapacity: BondCapacityReading;
}

/**
 * One periodic treasury check (#227). Reports the relayer XLM reserve and bond capacity to the
 * monitoring channel and metrics endpoint, alerts when the relayer reserve drops below the
 * threshold or the escrowed bond capacity is depleted, and triggers auto-replenishment when a
 * hook is configured.
 */
export async function checkTreasury(deps: TreasuryMonitorDeps): Promise<TreasuryReading> {
  const threshold = deps.relayerThresholdXlm ?? RELAYER_ALERT_THRESHOLD_XLM;
  const relayerBalanceXlm = await deps.relayerBalanceXlm();
  const bondCapacity = classifyBondCapacity(await deps.bondCapacityXlm(), deps.requiredBondXlm);
  const relayerBelowThreshold = relayerBalanceXlm < threshold;

  const reading: TreasuryReading = { relayerBalanceXlm, relayerBelowThreshold, bondCapacity };

  await deps.report(
    `Oracle treasury: relayer ${relayerBalanceXlm} XLM, bond capacity ${bondCapacity.availableXlm}/${bondCapacity.requiredXlm} XLM`,
    { ...reading },
  );
  await deps.publishMetrics({
    oracle_relayer_balance_xlm: relayerBalanceXlm,
    oracle_relayer_threshold_xlm: threshold,
    oracle_bond_capacity_xlm: bondCapacity.availableXlm,
    oracle_bond_required_xlm: bondCapacity.requiredXlm,
  });

  if (relayerBelowThreshold) {
    await deps.alertHighPriority(
      `Oracle relayer wallet reserve is below threshold: ${relayerBalanceXlm} XLM (threshold ${threshold})`,
      { relayerBalanceXlm, threshold },
    );
  }

  if (bondCapacity.depleted) {
    await deps.alertHighPriority(
      `Oracle escrowed challenge bond capacity is depleted: ${bondCapacity.availableXlm}/${bondCapacity.requiredXlm} XLM`,
      { ...bondCapacity },
    );
  }

  if (deps.replenish && (relayerBelowThreshold || bondCapacity.depleted)) {
    const shortfallXlm = Math.max(
      threshold - relayerBalanceXlm,
      bondCapacity.requiredXlm - bondCapacity.availableXlm,
      0,
    );
    await deps.replenish(shortfallXlm);
  }

  return reading;
}
