import { SorobanRpc } from '@stellar/stellar-sdk';
import { logger } from './logger';
import { metrics } from './metrics';

const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 10_000;
const BACKOFF_FACTOR = 1.5;
const JITTER_RATIO = 0.2;

const RETRYABLE_STATUS_CODES = new Set([429, 503]);

export interface PollerConfig {
  rpcUrl: string;
  pollIntervalMs: number;
  startLedger: number;
  onLedger: (ledger: SorobanRpc.Api.GetLatestLedgerResponse) => Promise<void>;
}

function isRetryableError(error: unknown): boolean {
  if (error instanceof SorobanRpc.Api.ResponseError) {
    return RETRYABLE_STATUS_CODES.has(error.response?.status ?? 0);
  }
  // Network/connection errors (ECONNRESET, ETIMEDOUT, fetch failures, etc.)
  return true;
}

function computeBackoff(attempt: number): number {
  const base = Math.min(
    INITIAL_BACKOFF_MS * Math.pow(BACKOFF_FACTOR, attempt),
    MAX_BACKOFF_MS,
  );
  const jitter = base * JITTER_RATIO * (Math.random() * 2 - 1);
  return Math.max(0, Math.min(base + jitter, MAX_BACKOFF_MS));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class LedgerPoller {
  private readonly server: SorobanRpc.Server;
  private readonly config: PollerConfig;
  private running = false;
  private lastLedger: number;

  constructor(config: PollerConfig) {
    this.config = config;
    this.server = new SorobanRpc.Server(config.rpcUrl);
    this.lastLedger = config.startLedger;
  }

  async start(): Promise<void> {
    this.running = true;
    let attempt = 0;

    while (this.running) {
      try {
        const latest = await this.server.getLatestLedger();

        if (attempt > 0) {
          logger.info('RPC recovered, resuming normal polling', { attempt });
          metrics.increment('indexer.rpc.recovered');
          attempt = 0;
        }

        if (latest.sequence > this.lastLedger) {
          await this.config.onLedger(latest);
          this.lastLedger = latest.sequence;
        }

        await sleep(this.config.pollIntervalMs);
      } catch (error) {
        if (!this.running) break;

        if (!isRetryableError(error)) {
          logger.error('Non-retryable RPC error, terminating poller', { error });
          throw error;
        }

        const backoffMs = computeBackoff(attempt);
        attempt += 1;

        metrics.increment('indexer.rpc.retry_attempt');
        metrics.observe('indexer.rpc.backoff_ms', backoffMs);
        logger.warn('RPC error, backing off before retry', {
          attempt,
          backoffMs,
          error: error instanceof Error ? error.message : String(error),
        });

        await sleep(backoffMs);
      }
    }
  }

  stop(): void {
    this.running = false;
  }
}
