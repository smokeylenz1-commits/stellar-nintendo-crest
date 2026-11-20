import { describe, expect, it } from "vitest";
import { handleBetPlaced, type BetPlacedEvent, type BetRow, type MarketTotals } from "../src/indexer/bet-placed";
import { EventRouter } from "../src/indexer/event-router";
import type { RawContractEvent } from "../src/indexer/event-schema";
import { parseScValTopics } from "../src/indexer/scval-parser";

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

describe("ScVal topic parsing", () => {
  it("parses Symbol topics into strings", () => {
    const topics = parseScValTopics([{ type: "symbol", value: "bet_placed" }]);
    expect(topics).toEqual(["bet_placed"]);
  });

  it("parses account and contract Address variants without throwing", () => {
    const account = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
    const contract = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
    const topics = parseScValTopics([
      { type: "address", value: account },
      { type: "address", value: contract },
    ]);
    expect(topics).toEqual([account, contract]);
  });

  it("parses muxed addresses into their base account id", () => {
    const muxed = "MAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const topics = parseScValTopics([{ type: "address", value: muxed }]);
    expect(topics[0]).toBe(muxed);
  });

  it("parses I128 and U64 numeric topics into bigints", () => {
    const topics = parseScValTopics([
      { type: "i128", value: 12345678901234567890n },
      { type: "u64", value: 42n },
    ]);
    expect(topics).toEqual([12345678901234567890n, 42n]);
  });

  it("parses nested Vec topics recursively", () => {
    const topics = parseScValTopics([
      { type: "vec", value: [{ type: "symbol", value: "yes" }, { type: "u64", value: 1n }] },
    ]);
    expect(topics).toEqual([["yes", 1n]]);
  });

  it("logs the raw hex payload and returns null for unexpected shapes", () => {
    const errors: unknown[] = [];
    const topics = parseScValTopics([{ type: "mystery", value: "0xdeadbeef" }], (msg, raw) =>
      errors.push({ msg, raw }),
    );
    expect(topics).toEqual([null]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ raw: "0xdeadbeef" });
  });
});
