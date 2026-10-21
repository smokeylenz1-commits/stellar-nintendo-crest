/**
 * Oracle scheduler daemon (#35).
 *
 * Runs on a fixed interval. Each tick finds markets whose `ends_at` has passed while still open,
 * and hands each one to the resolution step. Every tick emits a heartbeat with its health
 * numbers. `stop()` ends the loop after the current tick finishes, and is wired to SIGTERM and
 * SIGINT, so shutdown is clean.
 */

export interface ExpiredMarket {
  id: number;
  category: string;
  endsAt: Date;
}

export interface DaemonDeps {
  findExpiredOpenMarkets(now: Date): Promise<ExpiredMarket[]>;
  resolveMarket(market: ExpiredMarket): Promise<void>;
  heartbeat(stats: DaemonHealth): void;
  now?: () => Date;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface DaemonHealth {
  lastTickAt: string;
  marketsSeen: number;
  marketsResolved: number;
  failures: number;
}

export class OracleDaemon {
  private timer: unknown;
  private stopped = false;
  private running: Promise<void> | undefined;
  private health: DaemonHealth = { lastTickAt: "", marketsSeen: 0, marketsResolved: 0, failures: 0 };

  constructor(
    private readonly deps: DaemonDeps,
    private readonly intervalMs: number,
  ) {}

  /** Starts the schedule. The first tick runs immediately. */
  start(): void {
    this.stopped = false;
    this.running = this.tick();
    const set = this.deps.setTimer ?? ((fn, ms) => setInterval(fn, ms));
    this.timer = set(() => {
      if (!this.running) {
        this.running = this.tick().finally(() => {
          this.running = undefined;
        });
      }
    }, this.intervalMs);
  }

  /** Stops scheduling and waits for the tick in progress to finish. */
  async stop(): Promise<void> {
    this.stopped = true;
    const clear = this.deps.clearTimer ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
    clear(this.timer);
    await this.running;
  }

  /** One pass: find expired markets and resolve each one. A failure is counted, not thrown. */
  async tick(): Promise<void> {
    if (this.stopped) return;
    const now = (this.deps.now ?? (() => new Date()))();
    const markets = await this.deps.findExpiredOpenMarkets(now);
    this.health.lastTickAt = now.toISOString();
    this.health.marketsSeen = markets.length;

    for (const market of markets) {
      if (this.stopped) break;
      try {
        await this.deps.resolveMarket(market);
        this.health.marketsResolved++;
      } catch {
        this.health.failures++;
      }
    }
    this.deps.heartbeat({ ...this.health });
  }
}

/** Wires SIGTERM and SIGINT to a clean stop. Returns a function that removes the handlers. */
export function installShutdown(daemon: OracleDaemon, signals: NodeJS.Signals[] = ["SIGTERM", "SIGINT"]): () => void {
  const handler = () => {
    void daemon.stop();
  };
  for (const s of signals) process.on(s, handler);
  return () => {
    for (const s of signals) process.off(s, handler);
  };
}
