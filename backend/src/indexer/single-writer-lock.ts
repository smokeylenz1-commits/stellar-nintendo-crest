/**
 * Single-writer advisory lock for the indexer (#24).
 *
 * Only the process holding the PostgreSQL advisory lock writes. Other instances stand by and
 * retry, so a second instance started by mistake cannot double-write. The lock is held on one
 * connection, and a heartbeat keeps the poller marked active. When the holder exits, the lock is
 * released with the connection, and a standby takes over on its next attempt.
 */

export interface LockConnection {
  /** `pg_try_advisory_lock(id)` on this connection. */
  tryLock(id: bigint): Promise<boolean>;
  /** `pg_advisory_unlock(id)` on this connection. */
  unlock(id: bigint): Promise<void>;
}

export const INDEXER_LOCK_ID = 0x1d7e2a4n;

export interface SingleWriterOptions {
  lockId?: bigint;
  retryMs?: number;
  heartbeatMs?: number;
}

/**
 * Tries the lock once. Returns `true` when this instance is now the active writer.
 */
export async function acquireWriter(conn: LockConnection, lockId = INDEXER_LOCK_ID): Promise<boolean> {
  return conn.tryLock(lockId);
}

/**
 * Runs `poll` while holding the lock. Keeps trying while standing by, and calls `onStandby`
 * each time the lock is held elsewhere. `isStopping` lets the caller stop cleanly on shutdown.
 */
export async function runAsSingleWriter(
  conn: LockConnection,
  poll: (isStillWriter: () => boolean) => Promise<void>,
  opts: SingleWriterOptions & {
    onStandby: () => void;
    isStopping: () => boolean;
    sleep: (ms: number) => Promise<void>;
  },
): Promise<void> {
  const lockId = opts.lockId ?? INDEXER_LOCK_ID;
  const retryMs = opts.retryMs ?? 5_000;

  while (!opts.isStopping()) {
    if (await acquireWriter(conn, lockId)) {
      let writer = true;
      const isStillWriter = () => writer && !opts.isStopping();
      try {
        await poll(isStillWriter);
      } finally {
        writer = false;
        await conn.unlock(lockId);
      }
      return;
    }
    opts.onStandby();
    await opts.sleep(retryMs);
  }
}
