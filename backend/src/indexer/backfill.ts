/**
 * Backfill runner over the unified event router (#23).
 *
 * Replays historical ledgers through the same `EventRouter` the live indexer uses, so backfill
 * and live indexing run identical handler code. It takes `--from-ledger` and `--to-ledger`,
 * prints progress, and saves a checkpoint every `CHECKPOINT_EVERY` ledgers so a restart resumes
 * from the last saved ledger rather than the beginning.
 */

import type { EventRouter } from "./event-router";
import type { RawContractEvent } from "./event-schema";

export const CHECKPOINT_EVERY = 100;

export interface BackfillOptions {
  fromLedger: number;
  toLedger: number;
}

/** Reads `--from-ledger <N>` and `--to-ledger <M>` from the argument list. */
export function parseBackfillArgs(argv: string[]): BackfillOptions {
  const read = (flag: string): number => {
    const i = argv.indexOf(flag);
    if (i === -1 || i + 1 >= argv.length) {
      throw new Error(`missing ${flag} <N>`);
    }
    const value = Number(argv[i + 1]);
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`${flag} must be a non-negative integer`);
    }
    return value;
  };
  const fromLedger = read("--from-ledger");
  const toLedger = read("--to-ledger");
  if (fromLedger > toLedger) {
    throw new Error("--from-ledger must not be greater than --to-ledger");
  }
  return { fromLedger, toLedger };
}

export interface BackfillDeps {
  router: EventRouter;
  fetchLedgerEvents(ledger: number): Promise<RawContractEvent[]>;
  saveCheckpoint(ledger: number): Promise<void>;
  loadCheckpoint(): Promise<number | undefined>;
  progress(message: string): void;
}

/**
 * Replays every ledger in range. Resumes after the saved checkpoint if one is past `fromLedger`.
 * Returns the last ledger processed.
 */
export async function runBackfill(options: BackfillOptions, deps: BackfillDeps): Promise<number> {
  const saved = await deps.loadCheckpoint();
  const start = saved !== undefined && saved >= options.fromLedger ? saved + 1 : options.fromLedger;
  const total = options.toLedger - start + 1;
  let last = start - 1;

  for (let ledger = start; ledger <= options.toLedger; ledger++) {
    const events = await deps.fetchLedgerEvents(ledger);
    for (const event of events) {
      await deps.router.dispatchContractEvent(event);
    }
    last = ledger;

    const done = ledger - start + 1;
    if (done % CHECKPOINT_EVERY === 0 || ledger === options.toLedger) {
      await deps.saveCheckpoint(ledger);
      deps.progress(`backfill ${done}/${total} ledgers (ledger ${ledger})`);
    }
  }
  return last;
}
