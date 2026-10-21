import { describe, expect, it } from "vitest";
import { handleBetPlaced, type BetPlacedEvent, type BetRow, type MarketTotals } from "../src/indexer/bet-placed";
import { EventRouter } from "../src/indexer/event-router";
import type { RawContractEvent } from "../src/indexer/event-schema";

/** In-memory store that behaves like the transactional PostgreSQL store. */
function memoryStore() {
  const bets = new Map<string, BetRow>();
  const totals = new Map<number, MarketTotals>();
  return {
    bets,
    totals,
    transaction: async <T>(work: (tx: any) => Promise<T>): Promise<T> =>
      work({
        findBet: async (txHash: string, eventIndex: number) => bets.get(`${txHash}:${eventIndex}`),
        insertBet: async (row: BetRow) => {
          bets.set(`${row.txHash}:${row.eventIndex}`, row);
        },
        getMarketTotals: async (marketId: number) => totals.get(marketId),
        setMarketTotals: async (t: MarketTotals) => {
          totals.set(t.marketId, t);
        },
      }),
  };
}

const bet = (eventIndex: number, isYes: boolean, net: bigint): BetPlacedEvent => ({
  txHash: "tx-1",
  eventIndex,
  marketId: 7,
  bettor: "GBETTOR",
  isYes,
  grossAmount: net,
  netAmount: net,
  timestamp: new Date(0),
});

describe("indexer lifecycle", () => {
  it("applies a BetPlaced sequence and matches the expected market totals", async () => {
    const store = memoryStore();
    await handleBetPlaced(store, bet(0, true, 100n));
    await handleBetPlaced(store, bet(1, false, 50n));

    expect(store.totals.get(7)).toEqual({ marketId: 7, totalYes: 100n, totalNo: 50n, betCount: 2 });
  });

  it("is idempotent: feeding the same sequence twice changes nothing", async () => {
    const store = memoryStore();
    const sequence = [bet(0, true, 100n), bet(1, false, 50n)];

    for (const e of sequence) await handleBetPlaced(store, e);
    const once = structuredClone(store.totals.get(7));
    for (const e of sequence) await handleBetPlaced(store, e);

    expect(store.totals.get(7)).toEqual(once);
  });

  it("routes each event to exactly one handler through the router", async () => {
    const seen: string[] = [];
    const router = new EventRouter(() => seen.push("unmapped"));
    router.register("bet_placed", async () => {
      seen.push("bet_placed");
    });

    const event = { topic: "bet_placed" } as RawContractEvent;
    await router.dispatchContractEvent(event);
    await router.dispatchContractEvent({ topic: "unknown" } as RawContractEvent);

    expect(seen).toEqual(["bet_placed", "unmapped"]);
  });
});
