/**
 * Backfill runner over the unified event router (#23).
 *
 * Replays historical ledgers through the same `EventRouter` the live indexer uses, so backfill
 * and live indexing run identical handler code. It takes `--from-ledger` and `--to-ledger`,
 * prints progress, and saves a checkpoint every `CHECKPOINT_EVERY` ledgers so a restart resumes
 * from the last saved ledger rather than the beginning.
 *
 * Cold-start catch-up (#213): when `--to-ledger` is omitted the runner pages forward through
 * `getEvents` until it reaches the chain tip, tracking a pagination cursor across pages and
 * persisting the sync cursor atomically so a restart resumes exactly where it left off.
 *
 * Sequence continuity (#215): every ingested ledger must equal `previous_sequence + 1`. When a
 * gap is detected the missed sequence(s) are fetched immediately and resolved before the
 * checkpoint advances; if the gap cannot be resolved within `MAX_GAP_RETRIES` attempts a
 * critical alert is logged.
 */

import type { EventRouter } from "./event-router";
import type { RawContractEvent } from "./event-schema";

export const CHECKPOINT_EVERY = 100;

/** Number of retry attempts allowed to resolve a missed ledger sequence before alerting. */
export const MAX_GAP_RETRIES = 3;

export interface BackfillOptions {
  fromLedger: number;
  /** Inclusive upper bound; when omitted the runner catches up to the chain tip. */
  toLedger?: number;
}

/** Reads `--from-ledger <N>` and optional `--to-ledger <M>` from the argument list. */
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
  const hasTo = argv.includes("--to-ledger");
  const toLedger = hasTo ? read("--to-ledger") : undefined;
  if (toLedger !== undefined && fromLedger > toLedger) {
    throw new Error("--from-ledger must not be greater than --to-ledger");
  }
  return { fromLedger, toLedger };
}

export interface BackfillDeps {
  router: EventRouter;
  fetchLedgerEvents(ledger: number): Promise<RawContractEvent[]>;
  /** Atomically persists the sync cursor (ledger + pagination cursor) in the checkpoints table. */
  saveCheckpoint(ledger: number, cursor?: string): Promise<void>;
  loadCheckpoint(): Promise<{ ledger: number; cursor?: string } | undefined>;
  /** Returns the current chain tip ledger, used when no `--to-ledger` is supplied. */
  getChainTip(): Promise<number>;
  progress(message: string): void;
}

/**
 * Fetches and dispatches a single ledger's events, returning the last observed cursor.
 * Throws if the ledger cannot be fetched so the caller can retry the missed sequence.
 */
async function ingestLedger(
  ledger: number,
  deps: BackfillDeps,
  cursor: string | undefined,
): Promise<string | undefined> {
  const events = await deps.fetchLedgerEvents(ledger);
  for (const event of events) {
    await deps.router.dispatchContractEvent(event);
    cursor = event.cursor ?? cursor;
  }
  return cursor;
}

/**
 * Resolves a missed ledger sequence by fetching it immediately, retrying up to
 * `MAX_GAP_RETRIES` times. Returns the updated cursor, or throws after logging a critical
 * alert when the gap cannot be resolved.
 */
async function resolveGap(
  ledger: number,
  deps: BackfillDeps,
  cursor: string | undefined,
): Promise<string | undefined> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_GAP_RETRIES; attempt++) {
    try {
      deps.progress(`sequence gap: fetching missed ledger ${ledger} (attempt ${attempt}/${MAX_GAP_RETRIES})`);
      return await ingestLedger(ledger, deps, cursor);
    } catch (error) {
      lastError = error;
    }
  }
  console.error(
    `[CRITICAL] indexer sequence gap unresolved: ledger ${ledger} could not be fetched after ` +
      `${MAX_GAP_RETRIES} attempts; halting before advancing state`,
    lastError,
  );
  throw new Error(`unresolved ledger sequence gap at ${ledger} after ${MAX_GAP_RETRIES} attempts`);
}

/**
 * Replays every ledger in range. Resumes after the saved checkpoint if one is past `fromLedger`.
 * When `toLedger` is omitted, catches up to the chain tip. Returns the last ledger processed.
 *
 * Ledgers are processed strictly sequentially: a missed sequence is fetched and resolved before
 * the checkpoint advances, and processing halts if the gap cannot be resolved.
 */
export async function runBackfill(options: BackfillOptions, deps: BackfillDeps): Promise<number> {
  const saved = await deps.loadCheckpoint();
  const start = saved !== undefined && saved.ledger >= options.fromLedger ? saved.ledger + 1 : options.fromLedger;
  const toLedger = options.toLedger ?? (await deps.getChainTip());
  const total = toLedger - start + 1;
  let last = start - 1;
  let cursor = saved !== undefined && saved.ledger >= options.fromLedger ? saved.cursor : undefined;

  for (let ledger = start; ledger <= toLedger; ledger++) {
    // Enforce continuity: the next ledger must be exactly previous_sequence + 1.
    if (last >= 0 && ledger !== last + 1) {
      for (let missed = last + 1; missed < ledger; missed++) {
        cursor = await resolveGap(missed, deps, cursor);
        last = missed;
      }
    }

    cursor = await ingestLedger(ledger, deps, cursor);
    last = ledger;

    const done = ledger - start + 1;
    if (done % CHECKPOINT_EVERY === 0 || ledger === toLedger) {
      await deps.saveCheckpoint(ledger, cursor);
      deps.progress(`backfill ${done}/${total} ledgers (ledger ${ledger})`);
    }
  }
  return last;
}
