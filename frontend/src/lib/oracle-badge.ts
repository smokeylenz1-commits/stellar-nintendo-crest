/**
 * Status badges for oracle state on market cards (#81).
 *
 * Each oracle state has one label, one colour and one tooltip, so the card, the detail page and
 * the tests all show the same wording.
 */

export type OracleState = "proposed" | "disputed" | "council" | "finalized";

export interface OracleBadge {
  label: string;
  className: string;
  tooltip: string;
}

export const ORACLE_BADGES: Record<OracleState, OracleBadge> = {
  proposed: {
    label: "Outcome Proposed",
    className: "bg-yellow-500/15 text-yellow-400",
    tooltip: "An outcome has been submitted and can still be challenged in the window.",
  },
  disputed: {
    label: "Dispute Active",
    className: "bg-red-500/15 text-red-400",
    tooltip: "The proposed outcome has been challenged. Disputes are open to the council.",
  },
  council: {
    label: "Council Review",
    className: "bg-purple-500/15 text-purple-400",
    tooltip: "Council members are voting on the disputed outcome.",
  },
  finalized: {
    label: "Finalized",
    className: "bg-green-500/15 text-green-400",
    tooltip: "The outcome is final and payouts can be claimed.",
  },
};

/** The badge for a market's oracle state, or `undefined` when no state is set. */
export function oracleBadgeFor(state: OracleState | undefined): OracleBadge | undefined {
  return state ? ORACLE_BADGES[state] : undefined;
}
