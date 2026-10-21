/**
 * Hot-wallet XLM reserve monitor (#41).
 *
 * The oracle posts bonds from a hot wallet, so the reserve must stay above the bond needs. This
 * checks the balance against a floor and alerts through a high-priority channel when it drops
 * below. Alerts are raised before the reserve is empty: the warning floor is twice the minimum.
 */

export const MINIMUM_FLOOR_XLM = 500;
const WARNING_MULTIPLIER = 2;

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
