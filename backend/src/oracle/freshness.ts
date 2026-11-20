import { EventEmitter } from 'events';
import { logger } from '../utils/logger';
import type { PriceFeedArchive, PricePoint } from './types';

export interface FreshnessConfig {
  /** Maximum age (ms) a price point may have to be considered fresh. */
  maxAgeMs: number;
  /** Discrepancy threshold (basis points) above which a challenge is warranted. */
  discrepancyThresholdBps: number;
  /** Challenge bond amount posted when a discrepancy is detected. */
  challengeBond: bigint;
  /** Webhook URL for operations team alerts. */
  opsWebhookUrl?: string;
}

export interface ProposedOutcome {
  marketId: string;
  proposedOutcome: string;
  proposedPrice: bigint;
  proposedAt: number;
}

export interface ChallengeDecision {
  shouldChallenge: boolean;
  reason: string;
  canonicalPrice?: bigint;
  discrepancyBps?: number;
}

export const DEFAULT_FRESHNESS_CONFIG: FreshnessConfig = {
  maxAgeMs: 5 * 60 * 1000,
  discrepancyThresholdBps: 100,
  challengeBond: 0n,
};

/**
 * Computes the discrepancy between two prices in basis points.
 * Returns 0 when the canonical price is zero to avoid division by zero.
 */
export function computeDiscrepancyBps(
  proposedPrice: bigint,
  canonicalPrice: bigint,
): number {
  if (canonicalPrice === 0n) {
    return proposedPrice === 0n ? 0 : Number.MAX_SAFE_INTEGER;
  }
  const diff = proposedPrice > canonicalPrice
    ? proposedPrice - canonicalPrice
    : canonicalPrice - proposedPrice;
  // Scale to basis points: (diff / canonical) * 10_000
  return Number((diff * 10_000n) / canonicalPrice);
}

/**
 * Selects the freshest price point from the archive for a given market.
 */
export function selectCanonicalPrice(
  archive: PriceFeedArchive,
  marketId: string,
  now: number,
  config: FreshnessConfig = DEFAULT_FRESHNESS_CONFIG,
): PricePoint | undefined {
  const points = archive.get(marketId);
  if (!points || points.length === 0) {
    return undefined;
  }
  let freshest: PricePoint | undefined;
  for (const point of points) {
    if (now - point.timestamp > config.maxAgeMs) {
      continue;
    }
    if (!freshest || point.timestamp > freshest.timestamp) {
      freshest = point;
    }
  }
  return freshest;
}

/**
 * Evaluates a proposed outcome against the canonical price feed archive and
 * decides whether the bot should challenge it.
 */
export function evaluateProposedOutcome(
  proposal: ProposedOutcome,
  archive: PriceFeedArchive,
  now: number,
  config: FreshnessConfig = DEFAULT_FRESHNESS_CONFIG,
): ChallengeDecision {
  const canonical = selectCanonicalPrice(archive, proposal.marketId, now, config);
  if (!canonical) {
    return {
      shouldChallenge: false,
      reason: 'no fresh canonical price available',
    };
  }

  const discrepancyBps = computeDiscrepancyBps(
    proposal.proposedPrice,
    canonical.price,
  );

  if (discrepancyBps > config.discrepancyThresholdBps) {
    return {
      shouldChallenge: true,
      reason: `discrepancy ${discrepancyBps}bps exceeds threshold ${config.discrepancyThresholdBps}bps`,
      canonicalPrice: canonical.price,
      discrepancyBps,
    };
  }

  return {
    shouldChallenge: false,
    reason: `discrepancy ${discrepancyBps}bps within threshold`,
    canonicalPrice: canonical.price,
    discrepancyBps,
  };
}

/**
 * Minimal interface for the on-chain oracle client used to post challenges.
 */
export interface ChallengeClient {
  challengeOutcome(marketId: string, bond: bigint): Promise<string>;
}

export interface DisputeBotDeps {
  archive: PriceFeedArchive;
  client: ChallengeClient;
  config: FreshnessConfig;
  now?: () => number;
  fetchImpl?: typeof fetch;
}

/**
 * Automated dispute response bot. Watches proposed outcomes, compares them
 * against the canonical price feed archive, posts a challenge bond when the
 * discrepancy exceeds the configured threshold, and alerts ops via webhook.
 */
export class DisputeResponseBot extends EventEmitter {
  private readonly archive: PriceFeedArchive;
  private readonly client: ChallengeClient;
  private readonly config: FreshnessConfig;
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;

  constructor(deps: DisputeBotDeps) {
    super();
    this.archive = deps.archive;
    this.client = deps.client;
    this.config = deps.config;
    this.now = deps.now ?? (() => Date.now());
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  /**
   * Handles a single proposed outcome. Returns the challenge tx hash when a
   * challenge was posted, otherwise undefined.
   */
  async handleProposal(proposal: ProposedOutcome): Promise<string | undefined> {
    const decision = evaluateProposedOutcome(
      proposal,
      this.archive,
      this.now(),
      this.config,
    );

    if (!decision.shouldChallenge) {
      logger.debug(
        `[dispute-bot] market ${proposal.marketId}: no challenge (${decision.reason})`,
      );
      return undefined;
    }

    logger.warn(
      `[dispute-bot] market ${proposal.marketId}: challenging (${decision.reason})`,
    );

    let txHash: string;
    try {
      txHash = await this.client.challengeOutcome(
        proposal.marketId,
        this.config.challengeBond,
      );
    } catch (err) {
      logger.error(
        `[dispute-bot] failed to post challenge for market ${proposal.marketId}: ${String(err)}`,
      );
      throw err;
    }

    this.emit('challenge', { proposal, decision, txHash });
    await this.alertOps(proposal, decision, txHash);
    return txHash;
  }

  private async alertOps(
    proposal: ProposedOutcome,
    decision: ChallengeDecision,
    txHash: string,
  ): Promise<void> {
    if (!this.config.opsWebhookUrl) {
      return;
    }
    const payload = {
      event: 'oracle.challenge.submitted',
      marketId: proposal.marketId,
      proposedOutcome: proposal.proposedOutcome,
      proposedPrice: proposal.proposedPrice.toString(),
      canonicalPrice: decision.canonicalPrice?.toString(),
      discrepancyBps: decision.discrepancyBps,
      challengeBond: this.config.challengeBond.toString(),
      txHash,
      timestamp: this.now(),
    };
    try {
      const res = await this.fetchImpl(this.config.opsWebhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        logger.warn(
          `[dispute-bot] ops webhook returned ${res.status} for market ${proposal.marketId}`,
        );
      }
    } catch (err) {
      logger.warn(
        `[dispute-bot] ops webhook failed for market ${proposal.marketId}: ${String(err)}`,
      );
    }
  }
}
