import { EventEmitter } from 'events';

export interface PriceSource {
  name: string;
  fetchPrice: () => Promise<number>;
}

export interface AggregatedPrice {
  median: number;
  sources: { name: string; price: number; accepted: boolean }[];
  proof: PriceProofPayload;
}

export interface PriceProofPayload {
  median: number;
  timestamp: number;
  acceptedSources: { name: string; price: number }[];
  rejectedSources: { name: string; price: number; deviation: number }[];
}

export interface MarketSubmitter {
  submitPrice: (price: number, proof: PriceProofPayload) => Promise<void>;
}

const MIN_SOURCES = 3;
const MAX_DEVIATION = 0.03;

export class PriceAggregator {
  private sources: PriceSource[];

  constructor(sources: PriceSource[]) {
    this.sources = sources;
  }

  private static median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid];
  }

  async aggregate(): Promise<AggregatedPrice> {
    const results = await Promise.allSettled(
      this.sources.map(async (source) => ({
        name: source.name,
        price: await source.fetchPrice(),
      })),
    );

    const collected = results
      .filter(
        (r): r is PromiseFulfilledResult<{ name: string; price: number }> =>
          r.status === 'fulfilled' && Number.isFinite(r.value.price) && r.value.price > 0,
      )
      .map((r) => r.value);

    if (collected.length < MIN_SOURCES) {
      throw new Error(
        `PriceAggregator: need at least ${MIN_SOURCES} valid sources, got ${collected.length}`,
      );
    }

    const median = PriceAggregator.median(collected.map((c) => c.price));

    const accepted: { name: string; price: number }[] = [];
    const rejected: { name: string; price: number; deviation: number }[] = [];

    for (const entry of collected) {
      const deviation = Math.abs(entry.price - median) / median;
      if (deviation > MAX_DEVIATION) {
        rejected.push({ name: entry.name, price: entry.price, deviation });
      } else {
        accepted.push({ name: entry.name, price: entry.price });
      }
    }

    if (accepted.length < MIN_SOURCES) {
      throw new Error(
        `PriceAggregator: only ${accepted.length} sources within ${MAX_DEVIATION * 100}% of median`,
      );
    }

    const verifiedMedian = PriceAggregator.median(accepted.map((a) => a.price));

    const proof: PriceProofPayload = {
      median: verifiedMedian,
      timestamp: Date.now(),
      acceptedSources: accepted,
      rejectedSources: rejected,
    };

    return {
      median: verifiedMedian,
      sources: collected.map((c) => ({
        name: c.name,
        price: c.price,
        accepted: accepted.some((a) => a.name === c.name),
      })),
      proof,
    };
  }
}

export interface OracleDaemonConfig {
  aggregator: PriceAggregator;
  submitter: MarketSubmitter;
  intervalMs: number;
}

export class OracleDaemon extends EventEmitter {
  private config: OracleDaemonConfig;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(config: OracleDaemonConfig) {
    super();
    this.config = config;
  }

  async tick(): Promise<void> {
    const aggregated = await this.config.aggregator.aggregate();
    await this.config.submitter.submitPrice(aggregated.median, aggregated.proof);
    this.emit('submitted', aggregated);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const loop = async () => {
      if (!this.running) return;
      try {
        await this.tick();
      } catch (err) {
        this.emit('error', err);
      }
      if (this.running) {
        this.timer = setTimeout(loop, this.config.intervalMs);
      }
    };
    void loop();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

export interface ProposedOutcome {
  marketId: string;
  proposedPrice: number;
  proposedAt: number;
}

export interface OutcomeChallenger {
  challengeOutcome: (marketId: string, bond: number) => Promise<void>;
}

export interface DisputeWebhook {
  notify: (payload: DisputeAlertPayload) => Promise<void>;
}

export interface DisputeAlertPayload {
  marketId: string;
  proposedPrice: number;
  canonicalPrice: number;
  deviation: number;
  bond: number;
  challengedAt: number;
}

export interface DisputeBotConfig {
  aggregator: PriceAggregator;
  challenger: OutcomeChallenger;
  webhook: DisputeWebhook;
  intervalMs: number;
  discrepancyThreshold: number;
  challengeBond: number;
}

export class DisputeBot extends EventEmitter {
  private config: DisputeBotConfig;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(config: DisputeBotConfig) {
    super();
    this.config = config;
  }

  async evaluate(proposal: ProposedOutcome): Promise<boolean> {
    const aggregated = await this.config.aggregator.aggregate();
    const canonicalPrice = aggregated.median;
    const deviation =
      Math.abs(proposal.proposedPrice - canonicalPrice) / canonicalPrice;

    if (deviation <= this.config.discrepancyThreshold) {
      return false;
    }

    await this.config.challenger.challengeOutcome(
      proposal.marketId,
      this.config.challengeBond,
    );

    const alert: DisputeAlertPayload = {
      marketId: proposal.marketId,
      proposedPrice: proposal.proposedPrice,
      canonicalPrice,
      deviation,
      bond: this.config.challengeBond,
      challengedAt: Date.now(),
    };

    try {
      await this.config.webhook.notify(alert);
    } catch (err) {
      this.emit('error', err);
    }

    this.emit('challenged', alert);
    return true;
  }

  start(fetchProposals: () => Promise<ProposedOutcome[]>): void {
    if (this.running) return;
    this.running = true;
    const loop = async () => {
      if (!this.running) return;
      try {
        const proposals = await fetchProposals();
        for (const proposal of proposals) {
          await this.evaluate(proposal);
        }
      } catch (err) {
        this.emit('error', err);
      }
      if (this.running) {
        this.timer = setTimeout(loop, this.config.intervalMs);
      }
    };
    void loop();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
