/**
 * Lightweight Discord/Slack webhook notification bot for high-severity alerts.
 *
 * Posts rich embed messages to dedicated channels (#alerts-critical,
 * #oracle-disputes, #audit-events) with severity color bars and direct links
 * back to the web UI. Includes a token-bucket rate limiter so alert storms do
 * not flood the channels.
 */

export type AlertSeverity = 'critical' | 'high' | 'medium' | 'low';

export type AlertChannel = 'alerts-critical' | 'oracle-disputes' | 'audit-events';

export interface AlertPayload {
  /** Short headline shown as the embed title. */
  title: string;
  /** Human-readable description of what happened. */
  message: string;
  severity: AlertSeverity;
  /** Logical channel the alert belongs to. */
  channel: AlertChannel;
  /** Optional path (e.g. `/disputes/42`) appended to the web UI base URL. */
  link?: string;
  /** Optional structured fields rendered as embed fields. */
  fields?: Record<string, string | number>;
  /** Optional ISO timestamp; defaults to now. */
  timestamp?: string;
}

export interface NotifierConfig {
  /** Base URL of the web UI used to build direct links. */
  webBaseUrl: string;
  /** Webhook URLs keyed by logical channel. */
  webhooks: Partial<Record<AlertChannel, string>>;
  /** Max alerts allowed per window, per channel. Defaults to 5. */
  rateLimit?: number;
  /** Rate-limit window in milliseconds. Defaults to 60_000. */
  rateLimitWindowMs?: number;
}

/** Severity color bars (decimal RGB) used for the embed side stripe. */
const SEVERITY_COLORS: Record<AlertSeverity, number> = {
  critical: 0xd32f2f, // red
  high: 0xf57c00, // orange
  medium: 0xfbc02d, // amber
  low: 0x388e3c, // green
};

const SEVERITY_LABELS: Record<AlertSeverity, string> = {
  critical: 'CRITICAL',
  high: 'HIGH',
  medium: 'MEDIUM',
  low: 'LOW',
};

interface RateBucket {
  count: number;
  windowStart: number;
}

/**
 * Webhook notifier that formats and dispatches alert embeds to Discord/Slack.
 */
export class AlertNotifier {
  private readonly config: Required<Pick<NotifierConfig, 'webBaseUrl' | 'rateLimit' | 'rateLimitWindowMs'>> &
    Pick<NotifierConfig, 'webhooks'>;
  private readonly buckets = new Map<AlertChannel, RateBucket>();

  constructor(config: NotifierConfig) {
    this.config = {
      webBaseUrl: config.webBaseUrl.replace(/\/$/, ''),
      webhooks: config.webhooks,
      rateLimit: config.rateLimit ?? 5,
      rateLimitWindowMs: config.rateLimitWindowMs ?? 60_000,
    };
  }

  /**
   * Dispatch an alert to its channel. Returns true when the alert was sent,
   * false when it was dropped by the rate limiter or no webhook is configured.
   */
  async notify(alert: AlertPayload): Promise<boolean> {
    const webhookUrl = this.config.webhooks[alert.channel];
    if (!webhookUrl) {
      return false;
    }

    if (!this.allow(alert.channel)) {
      return false;
    }

    const body = this.buildPayload(alert);

    try {
      const res = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Token-bucket style limiter: at most `rateLimit` alerts per window. */
  private allow(channel: AlertChannel): boolean {
    const now = Date.now();
    const bucket = this.buckets.get(channel);

    if (!bucket || now - bucket.windowStart >= this.config.rateLimitWindowMs) {
      this.buckets.set(channel, { count: 1, windowStart: now });
      return true;
    }

    if (bucket.count >= this.config.rateLimit) {
      return false;
    }

    bucket.count += 1;
    return true;
  }

  /** Build a Discord-compatible webhook payload (also accepted by Slack). */
  private buildPayload(alert: AlertPayload): Record<string, unknown> {
    const url = alert.link ? `${this.config.webBaseUrl}${alert.link}` : this.config.webBaseUrl;

    const fields = Object.entries(alert.fields ?? {}).map(([name, value]) => ({
      name,
      value: String(value),
      inline: true,
    }));

    fields.push({ name: 'Channel', value: `#${alert.channel}`, inline: true });
    fields.push({ name: 'Details', value: `[Open in dashboard](${url})`, inline: false });

    return {
      username: 'HandsOff Alerts',
      embeds: [
        {
          title: `[${SEVERITY_LABELS[alert.severity]}] ${alert.title}`,
          description: alert.message,
          url,
          color: SEVERITY_COLORS[alert.severity],
          fields,
          timestamp: alert.timestamp ?? new Date().toISOString(),
        },
      ],
    };
  }
}

/** Convenience factory for a configured notifier instance. */
export function createAlertNotifier(config: NotifierConfig): AlertNotifier {
  return new AlertNotifier(config);
}

/**
 * Minimum oracle relayer wallet XLM reserve before a low-balance alert fires.
 * Below this the relayer may not be able to pay gas for automated submissions.
 */
export const ORACLE_MIN_XLM_RESERVE = 100;

/**
 * Minimum escrowed challenge bond capacity (in XLM) before a depletion alert
 * fires. When the escrow can no longer cover new challenge bonds, disputes
 * cannot be opened and resolutions stall.
 */
export const ORACLE_MIN_BOND_CAPACITY = 100;

/** Snapshot of the oracle treasury balances used by the monitor. */
export interface OracleTreasurySnapshot {
  /** Relayer wallet XLM balance available for gas fees. */
  walletXlm: number;
  /** Escrowed challenge bond capacity remaining, in XLM. */
  bondCapacityXlm: number;
  /** Optional ISO timestamp of when the snapshot was taken. */
  timestamp?: string;
}

/** Result of a single treasury balance evaluation. */
export interface OracleTreasuryEvaluation {
  walletLow: boolean;
  bondDepleted: boolean;
  /** True when either the wallet or bond capacity is below threshold. */
  needsReplenishment: boolean;
  /** XLM required to restore the wallet to the minimum reserve (0 if healthy). */
  walletTopUpXlm: number;
  /** XLM required to restore bond capacity to the minimum (0 if healthy). */
  bondTopUpXlm: number;
}

/**
 * Evaluate a treasury snapshot against the configured thresholds. Pure helper
 * so it can be reused by the periodic monitor and by metrics endpoints.
 */
export function evaluateOracleTreasury(
  snapshot: OracleTreasurySnapshot,
  thresholds: { minWalletXlm?: number; minBondCapacityXlm?: number } = {},
): OracleTreasuryEvaluation {
  const minWallet = thresholds.minWalletXlm ?? ORACLE_MIN_XLM_RESERVE;
  const minBond = thresholds.minBondCapacityXlm ?? ORACLE_MIN_BOND_CAPACITY;

  const walletLow = snapshot.walletXlm < minWallet;
  const bondDepleted = snapshot.bondCapacityXlm < minBond;

  return {
    walletLow,
    bondDepleted,
    needsReplenishment: walletLow || bondDepleted,
    walletTopUpXlm: walletLow ? Math.max(0, minWallet - snapshot.walletXlm) : 0,
    bondTopUpXlm: bondDepleted ? Math.max(0, minBond - snapshot.bondCapacityXlm) : 0,
  };
}

/**
 * Hook invoked when the treasury needs replenishment. Implementations may
 * trigger an automated top-up transfer; the monitor awaits the result so
 * failures can be surfaced to the monitoring channel.
 */
export type AutoReplenishHook = (
  evaluation: OracleTreasuryEvaluation,
  snapshot: OracleTreasurySnapshot,
) => Promise<void> | void;

/**
 * Periodic oracle treasury monitor. Checks the relayer wallet XLM balance and
 * escrowed challenge bond capacity, dispatches alerts to the monitoring
 * channel when either drops below threshold, and invokes the auto-replenish
 * hook so automated top-ups can be triggered.
 */
export class OracleTreasuryMonitor {
  private readonly notifier: AlertNotifier;
  private readonly getSnapshot: () => Promise<OracleTreasurySnapshot>;
  private readonly onReplenish?: AutoReplenishHook;
  private readonly minWalletXlm: number;
  private readonly minBondCapacityXlm: number;
  private timer?: ReturnType<typeof setInterval>;
  private lastEvaluation?: OracleTreasuryEvaluation;

  constructor(options: {
    notifier: AlertNotifier;
    getSnapshot: () => Promise<OracleTreasurySnapshot>;
    onReplenish?: AutoReplenishHook;
    minWalletXlm?: number;
    minBondCapacityXlm?: number;
  }) {
    this.notifier = options.notifier;
    this.getSnapshot = options.getSnapshot;
    this.onReplenish = options.onReplenish;
    this.minWalletXlm = options.minWalletXlm ?? ORACLE_MIN_XLM_RESERVE;
    this.minBondCapacityXlm = options.minBondCapacityXlm ?? ORACLE_MIN_BOND_CAPACITY;
  }

  /** Run a single balance check, alerting and triggering top-ups as needed. */
  async check(): Promise<OracleTreasuryEvaluation> {
    const snapshot = await this.getSnapshot();
    const evaluation = evaluateOracleTreasury(snapshot, {
      minWalletXlm: this.minWalletXlm,
      minBondCapacityXlm: this.minBondCapacityXlm,
    });
    this.lastEvaluation = evaluation;

    if (evaluation.walletLow) {
      await this.notifier.notify({
        title: 'Oracle relayer wallet low on XLM',
        message: `Relayer wallet holds ${snapshot.walletXlm} XLM, below the ${this.minWalletXlm} XLM reserve. Automated submissions may stall.`,
        severity: 'critical',
        channel: 'alerts-critical',
        fields: {
          'Wallet XLM': snapshot.walletXlm,
          'Min reserve': this.minWalletXlm,
          'Top-up needed': evaluation.walletTopUpXlm,
        },
        timestamp: snapshot.timestamp,
      });
    }

    if (evaluation.bondDepleted) {
      await this.notifier.notify({
        title: 'Oracle challenge bond capacity depleted',
        message: `Escrowed challenge bond capacity is ${snapshot.bondCapacityXlm} XLM, below the ${this.minBondCapacityXlm} XLM minimum. New disputes cannot be bonded.`,
        severity: 'high',
        channel: 'oracle-disputes',
        fields: {
          'Bond capacity': snapshot.bondCapacityXlm,
          'Min capacity': this.minBondCapacityXlm,
          'Top-up needed': evaluation.bondTopUpXlm,
        },
        timestamp: snapshot.timestamp,
      });
    }

    if (evaluation.needsReplenishment && this.onReplenish) {
      try {
        await this.onReplenish(evaluation, snapshot);
      } catch (err) {
        await this.notifier.notify({
          title: 'Oracle auto-replenishment failed',
          message: `Auto-replenishment hook threw: ${err instanceof Error ? err.message : String(err)}`,
          severity: 'critical',
          channel: 'alerts-critical',
          timestamp: snapshot.timestamp,
        });
      }
    }

    return evaluation;
  }

  /** Start periodic balance checks. No-op if already running. */
  start(intervalMs = 60_000): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      void this.check().catch(() => undefined);
    }, intervalMs);
    // Do not keep the process alive solely for the monitor.
    if (typeof this.timer === 'object' && this.timer && 'unref' in this.timer) {
      (this.timer as { unref: () => void }).unref();
    }
  }

  /** Stop periodic balance checks. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Latest evaluation, exposed for the metrics endpoint. */
  getLastEvaluation(): OracleTreasuryEvaluation | undefined {
    return this.lastEvaluation;
  }
}
