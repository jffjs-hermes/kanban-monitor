// Stale-worker classification (spec §1.2, §3 `classify`).
//
// A running card is `active` while its last heartbeat is fresh; it becomes
// `stalled` once the heartbeat goes stale (or was never recorded). Non-running
// cards are `null`. Pure and unit-testable against fixture timestamps (§7).

import type { Liveness, TaskRow } from '../types';

/** Default staleness threshold (spec §5 `STALE_WORKER_MS`, env-overridable). */
export const DEFAULT_STALE_MS = 90_000;

/**
 * Classify a task's worker liveness as of `now` (unix seconds).
 *
 * Boundary rule: `now - last_heartbeat_at < staleMs` is active; exactly at the
 * threshold the heartbeat is stale, so the card is `stalled`. A running card
 * with no recorded heartbeat is `stalled`. Non-running cards are `null`.
 */
export function classify(task: TaskRow, now: number, staleMs: number): Liveness | null {
  if (task.status !== 'running') return null;
  if (task.last_heartbeat_at === null) return 'stalled';
  return now - task.last_heartbeat_at < staleMs ? 'active' : 'stalled';
}