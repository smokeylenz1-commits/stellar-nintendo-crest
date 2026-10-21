/**
 * Circuit breaker for auto-submissions (#42).
 *
 * Counts submissions that were disputed or overturned. Two losses inside 24 hours, without a
 * win in between, trip the breaker. A tripped breaker blocks auto-submission until an operator
 * resets it, and raises a high-severity alert. State lives in a store so it survives restarts;
 * Redis is the intended store.
 */

export const TRIP_THRESHOLD = 2;
export const WINDOW_MS = 24 * 60 * 60 * 1000;

export interface BreakerState {
  tripped: boolean;
  /** Timestamps (ms) of recent losses, oldest first. */
  losses: number[];
}

export interface BreakerStore {
  load(): Promise<BreakerState>;
  save(state: BreakerState): Promise<void>;
}

export interface BreakerDeps {
  store: BreakerStore;
  alertOps(message: string): Promise<void>;
  now?: () => number;
}

/** Whether auto-submissions may run right now. */
export async function canAutoSubmit(deps: BreakerDeps): Promise<boolean> {
  return !(await deps.store.load()).tripped;
}

/** Records a lost submission and trips the breaker when the threshold is reached. */
export async function recordLoss(deps: BreakerDeps): Promise<BreakerState> {
  const now = (deps.now ?? Date.now)();
  const state = await deps.store.load();
  const losses = [...state.losses, now].filter((t) => now - t <= WINDOW_MS);
  const tripped = state.tripped || losses.length >= TRIP_THRESHOLD;
  const next = { tripped, losses };
  await deps.store.save(next);
  if (tripped && !state.tripped) {
    await deps.alertOps(
      `Auto-submission circuit breaker tripped: ${losses.length} losses within 24 hours. Manual reset required.`,
    );
  }
  return next;
}

/** Records a won or upheld submission. A win clears the streak of losses. */
export async function recordWin(deps: BreakerDeps): Promise<BreakerState> {
  const state = await deps.store.load();
  const next = { tripped: state.tripped, losses: [] as number[] };
  await deps.store.save(next);
  return next;
}

/** Operator action. Re-enables auto-submission after a trip. */
export async function resetBreaker(store: BreakerStore): Promise<void> {
  await store.save({ tripped: false, losses: [] });
}
