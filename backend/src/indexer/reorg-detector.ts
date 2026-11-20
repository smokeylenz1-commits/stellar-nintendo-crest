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
  /** Parent hash of the ledger header, used to detect forks on incoming headers (#209). */
  parentHash?: string;
}

export interface IncomingLedgerHeader {
  ledger: number;
  hash: string;
  parentHash: string;
}

export interface ReorgResult {
  /** True when the incoming header does not extend the stored checkpoint. */
  reorg: boolean;
  /** Lowest ledger that no longer matches the chain, when a fork was detected. */
  forkPoint?: number;
  /** Refs that were dropped from the window during rollback. */
  rolledBack: LedgerRef[];
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

  /** The most recently recorded ref, i.e. the current checkpoint. */
  checkpoint(): LedgerRef | undefined {
    return this.refs[this.refs.length - 1];
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

  /**
   * Detects a fork on an incoming ledger header by comparing its sequence and parent hash against
   * the stored checkpoint (#209). Returns `reorg: false` when the header extends the checkpoint.
   */
  detectReorg(header: IncomingLedgerHeader): ReorgResult {
    const checkpoint = this.checkpoint();
    if (!checkpoint) {
      return { reorg: false, rolledBack: [] };
    }

    const extendsCheckpoint =
      header.ledger === checkpoint.ledger + 1 && header.parentHash === checkpoint.hash;
    if (extendsCheckpoint) {
      return { reorg: false, rolledBack: [] };
    }

    // The header does not build on our checkpoint: find the last common ancestor in the window.
    const forkPoint = this.findCommonAncestor(header);
    return { reorg: true, forkPoint, rolledBack: [] };
  }

  /**
   * Rolls the window back to the last common ancestor of the incoming header, returning the refs
   * that were dropped so the caller can roll back the corresponding DB transactions (#209).
   */
  reconcile(header: IncomingLedgerHeader): ReorgResult {
    const detection = this.detectReorg(header);
    if (!detection.reorg) {
      return detection;
    }

    const forkPoint = detection.forkPoint ?? header.ledger;
    const rolledBack = this.rollbackFrom(forkPoint);
    return { reorg: true, forkPoint, rolledBack };
  }

  /**
   * Finds the highest stored ledger whose hash matches the incoming header's parent hash, i.e. the
   * last common ancestor. Falls back to the incoming ledger when no ancestor is found.
   */
  private findCommonAncestor(header: IncomingLedgerHeader): number {
    for (let i = this.refs.length - 1; i >= 0; i -= 1) {
      const ref = this.refs[i];
      if (ref.hash === header.parentHash) {
        return ref.ledger + 1;
      }
    }
    return header.ledger;
  }

  /** Drops every ref at or after `fromLedger`, so the next index starts from the fork point. */
  rollbackFrom(fromLedger: number): LedgerRef[] {
    const removed = this.refs.filter((r) => r.ledger >= fromLedger);
    const kept = this.refs.filter((r) => r.ledger < fromLedger);
    this.refs.splice(0, this.refs.length, ...kept);
    return removed;
  }
}
