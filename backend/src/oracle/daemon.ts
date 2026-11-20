/**
 * Oracle scheduler daemon (#35).
 *
 * Runs on a fixed interval. Each tick finds markets whose `ends_at` has passed while still open,
 * and hands each one to the resolution step. Every tick emits a heartbeat with its health
 * numbers. `stop()` ends the loop after the current tick finishes, and is wired to SIGTERM and
 * SIGINT, so shutdown is clean.
 *
 * Treasury monitoring (#227): each tick also checks the relayer wallet XLM balance and the
 * escrowed challenge bond capacity, emitting alerts when either drops below threshold and
 * invoking an auto-replenishment hook when configured.
 */

export interface ExpiredMarket {
  id: number;
  category: string;
  endsAt: Date;
}

/** Minimum relayer wallet XLM reserve before an alert fires (#227). */
export const MIN_WALLET_XLM = 100;

/** Minimum escrowed challenge bond capacity before an alert fires (#227). */
export const MIN_BOND_CAPACITY = 1;

export interface TreasurySnapshot {
  /** Relayer wallet XLM balance. */
  walletXlm: number;
  /** Remaining escrowed challenge bond capacity (in bonds). */
  bondCapacity: number;
}

export type TreasuryAlertKind = "wallet-low" | "bond-depleted";

export interface TreasuryAlert {
  kind: TreasuryAlertKind;
  message: string;
  snapshot: TreasurySnapshot;
}

export interface DaemonDeps {
  findExpiredOpenMarkets(now: Date): Promise<ExpiredMarket[]>;
  resolveMarket(market: ExpiredMarket): Promise<void>;
  heartbeat(stats: DaemonHealth): void;
  /** Reads the current treasury balances. Optional; monitoring is skipped when absent. */
  readTreasury?(): Promise<TreasurySnapshot>;
  /** Reports a treasury alert to the monitoring channel / metrics endpoint. */
  reportTreasuryAlert?(alert: TreasuryAlert): void;
  /** Auto-replenishment trigger hook, invoked when the wallet is below threshold. */
  autoReplenish?(snapshot: TreasurySnapshot): Promise<void> | void;
  now?: () => Date;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface DaemonHealth {
  lastTickAt: string;
  marketsSeen: number;
  marketsResolved: number;
  failures: number;
  walletXlm?: number;
  bondCapacity?: number;
  treasuryAlerts: number;
}

export class OracleDaemon {
  private timer: unknown;
  private stopped = false;
  private running: Promise<void> | undefined;
  private health: DaemonHealth = {
    lastTickAt: "",
    marketsSeen: 0,
    marketsResolved: 0,
    failures: 0,
    treasuryAlerts: 0,
  };

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

    await this.checkTreasury();
    this.deps.heartbeat({ ...this.health });
  }

  /**
   * Reads treasury balances, reports alerts below threshold, and triggers auto-replenishment
   * when the relayer wallet is low. Failures are counted, not thrown, so a monitoring hiccup
   * never stalls market resolution.
   */
  private async checkTreasury(): Promise<void> {
    if (!this.deps.readTreasury) return;
    let snapshot: TreasurySnapshot;
    try {
      snapshot = await this.deps.readTreasury();
    } catch {
      this.health.failures++;
      return;
    }

    this.health.walletXlm = snapshot.walletXlm;
    this.health.bondCapacity = snapshot.bondCapacity;

    if (snapshot.walletXlm < MIN_WALLET_XLM) {
      this.emitAlert({
        kind: "wallet-low",
        message: `Oracle relayer wallet XLM balance ${snapshot.walletXlm} is below ${MIN_WALLET_XLM}`,
        snapshot,
      });
      if (this.deps.autoReplenish) {
        try {
          await this.deps.autoReplenish(snapshot);
        } catch {
          this.health.failures++;
        }
      }
    }

    if (snapshot.bondCapacity < MIN_BOND_CAPACITY) {
      this.emitAlert({
        kind: "bond-depleted",
        message: `Escrowed challenge bond capacity ${snapshot.bondCapacity} is depleted`,
        snapshot,
      });
    }
  }

  private emitAlert(alert: TreasuryAlert): void {
    this.health.treasuryAlerts++;
    this.deps.reportTreasuryAlert?.(alert);
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
