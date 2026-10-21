/**
 * Ledger reorg detection with a sliding window of recent hashes (#25).
 *
 * The indexer keeps the hashes of the last `WINDOW_SIZE` ledgers it processed. On each poll it
 * checks that the stored hashes still match the chain. The first ledger whose hash differs is the
 * fork point. The caller rolls back from that ledger and re-indexes.
 */

export const WINDOW_SIZE = 32;

export interface LedgerRef {
  ledger: number;
  hash: string;
}

export class ReorgWindow {
  private readonly refs: LedgerRef[] = [];

  constructor(private readonly size = WINDOW_SIZE) {}

  /** Records a ledger after it has been indexed, dropping the oldest once the window is full. */
  record(ref: LedgerRef): void {
    this.refs.push(ref);
    while (this.refs.length > this.size) {
      this.refs.shift();
    }
  }

  /** The stored refs, oldest first. */
  snapshot(): readonly LedgerRef[] {
    return this.refs;
  }

  /**
   * Compares every stored ref with the chain. Returns the lowest ledger that no longer matches,
   * or `undefined` when the whole window is still on the chain.
   */
  async findForkPoint(hashAt: (ledger: number) => Promise<string>): Promise<number | undefined> {
    let fork: number | undefined;
    for (const ref of this.refs) {
      const chainHash = await hashAt(ref.ledger);
      if (chainHash !== ref.hash) {
        fork = ref.ledger;
        break;
      }
    }
    return fork;
  }

  /** Drops every ref at or after `fromLedger`, so the next index starts from the fork point. */
  rollbackFrom(fromLedger: number): LedgerRef[] {
    const removed = this.refs.filter((r) => r.ledger >= fromLedger);
    const kept = this.refs.filter((r) => r.ledger < fromLedger);
    this.refs.splice(0, this.refs.length, ...kept);
    return removed;
  }
}
