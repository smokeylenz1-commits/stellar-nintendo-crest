/**
 * Real-time publish of indexed events to Redis (#33).
 *
 * Called only after the database transaction for an event has committed, so subscribers never
 * see an event that was rolled back. A Redis failure is logged and swallowed, so it cannot block
 * or roll back the indexing transaction.
 *
 * The same committed events are also bridged to WebSocket clients (#211) via a per-market topic
 * so frontend feeds can subscribe to only the markets they care about.
 */

export interface PubSubClient {
  publish(channel: string, message: string): Promise<number>;
}

export interface PublishLogger {
  warn(fields: Record<string, unknown>, message: string): void;
}

export interface LedgerEventNotice {
  type: string;
  marketId?: number;
  timestamp: string;
  state: Record<string, unknown>;
}

/** Event types bridged to WebSocket clients (#211). */
export const BROADCAST_EVENT_TYPES = ["bet.placed", "market.resolved", "dispute.created"] as const;

export type BroadcastEventType = (typeof BROADCAST_EVENT_TYPES)[number];

/** Channel name for one topic, `stellar:events:<topic>`. */
export function channelFor(topic: string): string {
  return `stellar:events:${topic}`;
}

/**
 * Channel name for the WebSocket bridge of one market, `stellar:ws:market:<marketId>`.
 * Clients subscribe to this topic to receive only events for that market.
 */
export function wsMarketChannelFor(marketId: number): string {
  return `stellar:ws:market:${marketId}`;
}

/**
 * Publishes one committed event. Returns `true` when the message was sent, and `false` when the
 * publish failed. It never throws.
 */
export async function publishCommittedEvent(
  client: PubSubClient,
  logger: PublishLogger,
  topic: string,
  notice: LedgerEventNotice,
): Promise<boolean> {
  try {
    await client.publish(channelFor(topic), JSON.stringify(notice));
    return true;
  } catch (err) {
    logger.warn(
      { event: "redis_publish_failed", topic, error: err instanceof Error ? err.message : String(err) },
      "Could not publish indexed event; the database commit is unaffected",
    );
    return false;
  }
}

/**
 * Bridges one committed event to WebSocket clients (#211). Only the broadcast event types are
 * forwarded, and only when the event carries a `marketId`, so the WebSocket server can route it
 * to the matching `market_id` topic. Returns `true` when the message was sent, and `false` when
 * the event was skipped or the publish failed. It never throws.
 */
export async function publishToWebSocketBridge(
  client: PubSubClient,
  logger: PublishLogger,
  notice: LedgerEventNotice,
): Promise<boolean> {
  if (!(BROADCAST_EVENT_TYPES as readonly string[]).includes(notice.type)) {
    return false;
  }
  if (typeof notice.marketId !== "number") {
    return false;
  }
  try {
    await client.publish(wsMarketChannelFor(notice.marketId), JSON.stringify(notice));
    return true;
  } catch (err) {
    logger.warn(
      {
        event: "ws_bridge_publish_failed",
        type: notice.type,
        marketId: notice.marketId,
        error: err instanceof Error ? err.message : String(err),
      },
      "Could not bridge indexed event to WebSocket clients; the database commit is unaffected",
    );
    return false;
  }
}
