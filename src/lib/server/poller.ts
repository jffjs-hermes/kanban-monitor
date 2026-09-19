// Poller (spec §1.2, §3 `createPoller`).
//
// Drives the poll → diff → emit loop: on each tick it reads a fresh snapshot,
// diffs it against the last-known one, and emits the resulting scopes through
// a minimal callback interface. Fan-out to browsers is NOT this module's job —
// that belongs to `sse-hub` (Impl 3). Pure enough to unit-test with fake
// timers and a stubbed snapshot source.

import { readSnapshot } from './snapshot';
import { diffSnapshot } from './differ';
import { resolveStaleMs } from './liveness';
import type { Database } from 'bun:sqlite';
import type { BoardSlug, BoardSnapshot, DeltaScope } from '../types';

/** A delta scoped to a board; carries `slug` so the hub can route it (§3). */
export type PollerDelta = DeltaScope & { slug: BoardSlug };

export interface Poller {
  start(): void;
  stop(): void;
  /**
   * Subscribe to a tick's deltas. Called ONCE per tick, with the full batch of
   * scopes that tick produced (empty ticks are NOT emitted), so the runtime can
   * treat a non-empty batch as exactly one non-trivial change to bump the board
   * revision by +1 (spec §3.1). `PollerDelta` carries the slug for routing.
   */
  onDelta(cb: (deltas: PollerDelta[]) => void): void;
}

/** Default tick interval (spec §5 `POLL_INTERVAL_MS`). */
export const DEFAULT_POLL_INTERVAL_MS = 1000;

export function createPoller(
  getDb: () => Database | null,
  intervalMs?: number /* default 1000 */,
): Poller {
  const tickEvery = intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const staleMs = resolveStaleMs(); // spec §3: STALE_WORKER_MS (default 90_000)
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;
  let prev: BoardSnapshot | null = null;
  // Board slug this poller serves, resolved from the first successful snapshot
  // read (the handle itself carries it). Fallback during a first-tick failure.
  let knownSlug: BoardSlug = 'default';
  const listeners = new Set<(deltas: PollerDelta[]) => void>();

  const emit = (deltas: PollerDelta[]) => {
    for (const cb of listeners) cb(deltas);
  };

  const tick = () => {
    const db = getDb();
    if (db === null) {
      // Board handle not ready (file swapped/missing). Keep polling; hold the
      // last-known snapshot rather than emitting error noise (§1.3 tolerance).
      return;
    }
    let next: BoardSnapshot;
    try {
      next = readSnapshot(db, { staleMs, now: Date.now() / 1000 });
    } catch {
      // Read failed (DB swapped under us). Drop state and signal a full resend.
      prev = null;
      emit([{ kind: 'reset', slug: knownSlug }]);
      return;
    }
    knownSlug = next.slug;
    const deltas = diffSnapshot(prev, next);
    prev = next;
    // A tick that produced no scopes is trivial — emit nothing (no revision bump).
    if (deltas.length === 0) return;
    emit(deltas.map((d) => ({ ...d, slug: next.slug })));
  };

  return {
    start() {
      if (running) return;
      running = true;
      tick(); // emit immediately, then on every interval
      timer = setInterval(tick, tickEvery);
    },
    stop() {
      running = false;
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
    onDelta(cb) {
      listeners.add(cb);
    },
  };
}