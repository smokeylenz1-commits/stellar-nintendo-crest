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
