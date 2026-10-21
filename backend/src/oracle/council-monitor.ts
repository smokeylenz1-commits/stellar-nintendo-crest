/**
 * Council inactivity monitor (#47).
 *
 * A dispute gives the council 72 hours to vote. Each hour, the monitor checks every open dispute
 * that still lacks a quorum. It pages the council roster at the 24-hour, 48-hour and 60-hour marks,
 * and sends each escalation once. The paging client is injected, so PagerDuty is one
 * implementation of it.
 */

export const VOTING_WINDOW_HOURS = 72;
export const ESCALATION_HOURS = [24, 48, 60] as const;

export interface OpenDispute {
  marketId: number;
  openedAt: Date;
  votesCast: number;
  quorum: number;
}

export interface PagingClient {
  page(roster: string[], summary: string, severity: "warning" | "critical"): Promise<void>;
}

export interface MonitorDeps {
  openDisputes(): Promise<OpenDispute[]>;
  roster: string[];
  pager: PagingClient;
  /** Escalation levels already paged for each market, so each one fires once. */
  alreadyPaged: Map<number, Set<number>>;
  now: () => Date;
}

/** Hours elapsed since the dispute opened. */
export function hoursOpen(dispute: OpenDispute, now: Date): number {
  return (now.getTime() - dispute.openedAt.getTime()) / (60 * 60 * 1000);
}

/** One monitor pass. Returns the escalation levels paged on this pass. */
export async function runCouncilMonitor(deps: MonitorDeps): Promise<Array<{ marketId: number; hours: number }>> {
  const now = deps.now();
  const paged: Array<{ marketId: number; hours: number }> = [];

  for (const dispute of await deps.openDisputes()) {
    if (dispute.votesCast >= dispute.quorum) continue;

    const elapsed = hoursOpen(dispute, now);
    const sent = deps.alreadyPaged.get(dispute.marketId) ?? new Set<number>();
    for (const level of ESCALATION_HOURS) {
      if (elapsed >= level && !sent.has(level)) {
        const severity = level >= 60 ? "critical" : "warning";
        await deps.pager.page(
          deps.roster,
          `Dispute on market ${dispute.marketId} has no council quorum after ${level} hours (window ${VOTING_WINDOW_HOURS}h)`,
          severity,
        );
        sent.add(level);
        paged.push({ marketId: dispute.marketId, hours: level });
      }
    }
    deps.alreadyPaged.set(dispute.marketId, sent);
  }
  return paged;
}
