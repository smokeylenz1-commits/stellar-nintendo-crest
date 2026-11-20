import {
  ipredictTotalSupply,
  ipredictSupplyCap,
  ipredictCirculatingSupply,
  ipredictRewardsDistributedTotal,
  setGauge,
  incCounter,
} from "./metrics";

export const IPREDICT_MAX_CAP = 100_000_000;

export function updateTokenSupplyMetrics(circulating: number, totalMinted: number): void {
  setGauge(ipredictSupplyCap, IPREDICT_MAX_CAP);
  setGauge(ipredictTotalSupply, totalMinted);
  setGauge(ipredictCirculatingSupply, circulating);
}

export function recordTokenRewardDistribution(amount: number, category: "winner" | "loser" | "referrer"): void {
  incCounter(ipredictRewardsDistributedTotal, amount, { category });
}

export type TokenEventKind = "transfer" | "mint";

export interface RawTokenEvent {
  topics: string[];
  value?: string;
  contractId?: string;
  ledger?: number;
  txHash?: string;
  marketId?: string | null;
}

export interface DecodedTokenEvent {
  kind: TokenEventKind;
  from: string | null;
  to: string;
  amount: bigint;
  marketId: string | null;
  ledger: number | null;
  txHash: string | null;
}

/**
 * Decode a SAC-style token event emitted by the IPREDICT token contract.
 *
 * SAC token events use the topic layout:
 *   transfer: ["transfer", from, to]
 *   mint:     ["mint", admin, to]
 * The amount is carried in the event value as a base-unit integer string.
 * Returns null for unrelated topics or malformed payloads so the indexer can
 * skip them without aborting the batch.
 */
export function decodeTokenEvent(event: RawTokenEvent): DecodedTokenEvent | null {
  const topics = event.topics ?? [];
  if (topics.length < 3) return null;

  const topic = topics[0]?.toLowerCase();
  if (topic !== "transfer" && topic !== "mint") return null;

  const from = topics[1] || null;
  const to = topics[2];
  if (!to) return null;

  let amount: bigint;
  try {
    amount = BigInt(event.value ?? "0");
  } catch {
    return null;
  }
  if (amount < 0n) return null;

  return {
    kind: topic,
    from: topic === "mint" ? null : from,
    to,
    amount,
    marketId: event.marketId ?? null,
    ledger: event.ledger ?? null,
    txHash: event.txHash ?? null,
  };
}

export interface TokenTransferRow {
  kind: TokenEventKind;
  from_wallet: string | null;
  to_wallet: string;
  amount: string;
  market_id: string | null;
  ledger: number | null;
  tx_hash: string | null;
}

/**
 * Map a decoded token event to a `token_transfers` ledger row. Mint events are
 * attributed to the recipient wallet and carry the associated market ID.
 */
export function toTokenTransferRow(event: DecodedTokenEvent): TokenTransferRow {
  return {
    kind: event.kind,
    from_wallet: event.from,
    to_wallet: event.to,
    amount: event.amount.toString(),
    market_id: event.marketId,
    ledger: event.ledger,
    tx_hash: event.txHash,
  };
}
