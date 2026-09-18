// Poller (spec §1.2, §3 `createPoller`).
//
// Drives the poll → diff → emit loop: on each tick it reads a fresh snapshot,
// diffs it against the last-known one, and emits the resulting scopes through
// a minimal callback interface. Fan-out to browsers is NOT this module's job —
// that belongs to `sse-hub` (Impl 3). Pure enough to unit-test with fake
// timers and a stubbed snapshot source.

import { readSnapshot } from './snapshot';
import { diffSnapshot } from './differ';
import type { Database } from 'bun:sqlite';
import type { BoardSlug, BoardSnapshot, DeltaScope } from '../types';

/** A delta scoped to a board; carries `slug` so the hub can route it (§3). */
export type PollerDelta = DeltaScope & { slug: BoardSlug };

export interface Poller {
  start(): void;
  stop(): void;
  onDelta(cb: (delta: PollerDelta) => void): void;
}

export interface PollerOptions {
  /** Board slug this poller watches (attached to every emitted delta). */
  slug: BoardSlug;
  /** Heartbeat staleness threshold for liveness classification (spec §5). */
  staleMs: number;
  /** Tick interval in ms (spec §5 `POLL_INTERVAL_MS`, default 1000). */
  intervalMs?: number;
}

/** Default tick interval (spec §5 `POLL_INTERVAL_MS`). */
export const DEFAULT_POLL_INTERVAL_MS = 1000;

export function createPoller(
  getDb: () => Database | null,
  opts: PollerOptions,
): Poller {
  const intervalMs = opts.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;
  let prev: BoardSnapshot | null = null;
  const listeners = new Set<(delta: PollerDelta) => void>();

  const emit = (delta: PollerDelta) => {
    for (const cb of listeners) cb(delta);
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
      next = readSnapshot(db, opts.slug, { staleMs: opts.staleMs, now: Date.now() / 1000 });
    } catch {
      // Read failed (DB swapped under us). Drop state and signal a full resend.
      prev = null;
      emit({ kind: 'reset', slug: opts.slug });
      return;
    }
    const deltas = diffSnapshot(prev, next);
    prev = next;
    for (const d of deltas) emit({ ...d, slug: opts.slug });
  };

  return {
    start() {
      if (running) return;
      running = true;
      tick(); // emit immediately, then on every interval
      timer = setInterval(tick, intervalMs);
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