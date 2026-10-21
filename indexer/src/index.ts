import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { dispatch, warnUnregistered } from "./router/registry.js";
import { logger } from "./logger.js";

interface RawEvent {
  id: string;
  contract_id: string;
  ledger: number;
  type: string;
  topic: string[];
  value: unknown;
  tx_hash: string;
  created_at: string;
}

interface IndexerConfig {
  rpcUrl: string;
  contractIds: string[];
  supabaseUrl: string;
  supabaseKey: string;
  pollIntervalMs: number;
  startLedger: number;
  batchSize: number;
}

function loadConfig(): IndexerConfig {
  const contractIds = (process.env.CONTRACT_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (contractIds.length === 0) {
    throw new Error("CONTRACT_IDS environment variable must list at least one contract id");
  }

  return {
    rpcUrl: process.env.RPC_URL ?? "https://soroban-testnet.stellar.org",
    contractIds,
    supabaseUrl: process.env.SUPABASE_URL ?? "",
    supabaseKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
    pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? 5000),
    startLedger: Number(process.env.START_LEDGER ?? 1),
    batchSize: Number(process.env.BATCH_SIZE ?? 100),
  };
}

function createSupabase(config: IndexerConfig): SupabaseClient {
  if (!config.supabaseUrl || !config.supabaseKey) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
  }
  return createClient(config.supabaseUrl, config.supabaseKey, {
    auth: { persistSession: false },
  });
}

/**
 * Fetches raw contract events from the RPC endpoint for the given ledger range.
 * This function performs no routing or mapping; it only retrieves events.
 */
async function fetchEvents(
  config: IndexerConfig,
  fromLedger: number,
  toLedger: number,
): Promise<RawEvent[]> {
  const response = await fetch(config.rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "indexer-fetch",
      method: "getEvents",
      params: {
        startLedger: fromLedger,
        endLedger: toLedger,
        filters: [
          {
            type: "contract",
            contractIds: config.contractIds,
          },
        ],
        pagination: { limit: config.batchSize },
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`RPC getEvents failed with status ${response.status}`);
  }

  const payload = (await response.json()) as {
    result?: { events?: RawEvent[] };
    error?: { message?: string };
  };

  if (payload.error) {
    throw new Error(`RPC getEvents error: ${payload.error.message ?? "unknown"}`);
  }

  return payload.result?.events ?? [];
}

/**
 * Delegates a batch of raw events to the unified registry dispatcher.
 * All routing decisions live in router/registry.ts.
 */
async function processEvents(
  supabase: SupabaseClient,
  events: RawEvent[],
): Promise<void> {
  for (const event of events) {
    try {
      const handled = await dispatch(supabase, event);
      if (!handled) {
        warnUnregistered(event);
      }
    } catch (err) {
      logger.error("Failed to dispatch event", {
        eventId: event.id,
        type: event.type,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * Backfill runner: processes a fixed ledger range using the shared dispatcher.
 */
export async function runBackfill(
  fromLedger: number,
  toLedger: number,
): Promise<void> {
  const config = loadConfig();
  const supabase = createSupabase(config);

  logger.info("Starting backfill", { fromLedger, toLedger });

  let cursor = fromLedger;
  while (cursor <= toLedger) {
    const batchEnd = Math.min(cursor + config.batchSize - 1, toLedger);
    const events = await fetchEvents(config, cursor, batchEnd);
    await processEvents(supabase, events);
    logger.info("Backfill batch processed", {
      fromLedger: cursor,
      toLedger: batchEnd,
      count: events.length,
    });
    cursor = batchEnd + 1;
  }

  logger.info("Backfill complete", { fromLedger, toLedger });
}

/**
 * Main poller: continuously fetches new events and delegates to the shared dispatcher.
 */
export async function runPoller(): Promise<void> {
  const config = loadConfig();
  const supabase = createSupabase(config);

  let cursor = config.startLedger;
  logger.info("Starting poller", { startLedger: cursor });

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const batchEnd = cursor + config.batchSize - 1;
      const events = await fetchEvents(config, cursor, batchEnd);
      await processEvents(supabase, events);

      if (events.length > 0) {
        const maxLedger = events.reduce(
          (max, e) => (e.ledger > max ? e.ledger : max),
          cursor,
        );
        cursor = maxLedger + 1;
      }
    } catch (err) {
      logger.error("Poller iteration failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
  }
}

async function main(): Promise<void> {
  const mode = process.env.INDEXER_MODE ?? "poll";

  if (mode === "backfill") {
    const from = Number(process.env.BACKFILL_FROM ?? process.env.START_LEDGER ?? 1);
    const to = Number(process.env.BACKFILL_TO ?? from);
    await runBackfill(from, to);
    return;
  }

  await runPoller();
}

if (require.main === module) {
  main().catch((err) => {
    logger.error("Indexer terminated with error", {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  });
}