// BoardRuntime (spec §1.1, §1.2, §3, §4).
//
// One runtime owns the poller + sse-hub for the currently-selected board. It:
//   - resolves a board DB path from a slug (board-discover layout §1.3);
//   - keeps a single open read-only handle for the active board and tolerates
//     the file disappearing/reappearing (§1.3): on a read error the handle is
//     dropped and the next poll tick reopens it;
//   - caches the latest full snapshot per slug so a newly-connected client can
//     get an immediate `reset` (spec §4 reconnect/initial-state) without racing
//     the poller;
//   - on board switch: stops the old poller, starts the new one, and broadcasts
//     a cross-board `board` event on the hub's all-subscribers channel (§1.1).

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';

import { openReadonly } from './data-access';
import { hermesHome } from './board-discover';
import { createPoller, type Poller, type PollerDelta } from './poller';
import { resolveStaleMs } from './liveness';
import { readCardDetail } from './card-detail';
import { readSnapshot } from './snapshot';
import { createSseHub, type BoardEvent, type SseHub } from './sse-hub';
import type {
  BoardSlug,
  BoardSnapshot,
  CardDetail,
  DeltaScope,
  DeltasSinceResult,
  RevisionedDelta,
  SseEvent,
} from '../types';

/** Default poll interval (spec §5 `POLL_INTERVAL_MS`). */
export const DEFAULT_POLL_INTERVAL_MS = 1000;

/** Default per-board delta ring cap (spec §3.2 — last ~256 entries / ~5 min). */
export const DEFAULT_RING_CAP = 256;

export interface BoardRuntimeOptions {
  /** Override the poll tick interval (spec §5, default 1000ms). */
  pollIntervalMs?: number;
  /** Override the per-board delta ring cap (spec §3.2, default 256). */
  ringCap?: number;
}

/** A bounded per-board ring of (revisionAfter, DeltaScope) entries (§3.2). */
interface DeltaRing {
  entries: RevisionedDelta[]; // oldest first, newest last
  /**
   * Minimum `since` value `deltasSince` can serve: every revision in
   * `(readyFrom, currentRev]` is present in `entries`. Raised by eviction and
   * by interleaved `reset` deltas — below it a client must rebuild.
   */
  readyFrom: number;
}

function makeRing(): DeltaRing {
  return { entries: [], readyFrom: 0 };
}

/** Append a scoped delta at `revision`, evicting oldest groups over the cap. */
function ringPush(ring: DeltaRing, revision: number, scope: DeltaScope, cap: number) {
  ring.entries.push({ revision, scope });
  while (ring.entries.length > cap) {
    // Drop whole revision-groups (a tick can store several scopes at one rev).
    const oldestRev = ring.entries[0].revision;
    while (ring.entries.length > 0 && ring.entries[0].revision === oldestRev) {
      ring.entries.shift();
    }
    ring.readyFrom = Math.max(ring.readyFrom, oldestRev - 1);
  }
}

/**
 * A `reset` rebases the board: incremental deltas before it no longer compose,
 * so any client still behind the reset must rebuild too. Clear the ring and
 * raise `readyFrom` to the reset's revision (spec §3.2 "buffer miss → reset").
 */
function ringMarkReset(ring: DeltaRing, revision: number) {
  ring.entries.length = 0;
  ring.readyFrom = Math.max(ring.readyFrom, revision);
}

interface Active {
  slug: BoardSlug;
  poller: Poller;
  close(): void;
}

export interface BoardRuntime {
  /**
   * Make `slug` the active board (idempotent). Stops the previous poller on a
   * real switch, starts the new one, broadcasts the cross-board `board` event,
   * and returns the board's latest snapshot (or null if the DB is not readable
   * yet — the poller tolerates a board that appears later).
   */
  select(slug: BoardSlug): BoardSnapshot | null;
  /** Latest cached snapshot for `slug`, or null. */
  snapshotOf(slug: BoardSlug): BoardSnapshot | null;
  /**
   * The board's current monotonic revision (spec §3.1) — 0 for a board the
   * runtime has never polled a non-trivial change for.
   */
  currentRevision(slug: BoardSlug): number;
  /**
   * Resumable catch-up from a past `revision` (spec §3.2). When `since` falls
   * inside the ring (no gap/eviction since) it replays exactly the deltas
   * published after `since` without re-reading the DB; on a buffer miss, DB
   * swap, or an unknown board it degrades to a `reset` full-snapshot rebuild.
   */
  deltasSince(slug: BoardSlug, since: number): DeltasSinceResult;
  /**
   * Full typed detail for one card on `slug` (spec §2 `CardDetail`), or null
   * when the board is missing/unreadable or the task id does not exist. Uses a
   * short-lived read-only handle; safe to call from the detail endpoint on
   * every open/refresh (§1.4 long-lived readers also fine).
   */
  detailOf(slug: BoardSlug, taskId: string): CardDetail | null;
  /** Resolved staleness threshold (spec §5 `STALE_WORKER_MS`). */
  staleMs(): number;
  /** Subscribe to `slug`'s deltas (delegates to the owned hub). */
  subscribe(slug: BoardSlug, send: (evt: SseEvent) => void): () => void;
  /** Subscribe to the cross-board channel (delegates to the owned hub). */
  subscribeAll(send: (evt: BoardEvent) => void): () => void;
  /** The owned hub — the app's single fan-out registry (spec §1.1). */
  hub: SseHub;
}

/** Resolve a board DB path from a slug using the board-discover layout (§1.3). */
function boardDbPathFor(slug: BoardSlug): string {
  const home = hermesHome();
  return slug === 'default'
    ? join(home, 'kanban.db')
    : join(home, 'kanban', 'boards', slug, 'kanban.db');
}

function tryOpen(slug: BoardSlug): Database | null {
  const path = boardDbPathFor(slug);
  if (!existsSync(path)) return null;
  try {
    return openReadonly(path);
  } catch {
    return null; // unreadable/swapped — poller will keep trying next tick
  }
}

/**
 * Create a BoardRuntime. `staleMs` comes from env `STALE_WORKER_MS` (spec §5)
 * at construction time — set it before creating the runtime in tests.
 */
export function createBoardRuntime(opts?: BoardRuntimeOptions): BoardRuntime {
  const hub = createSseHub();
  const pollIntervalMs = opts?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const ringCap = opts?.ringCap ?? DEFAULT_RING_CAP;
  const staleMs = resolveStaleMs();
  const snapshots = new Map<BoardSlug, BoardSnapshot>();
  // Per-board revision counter + delta ring (spec §3.1, §3.2). These persist
  // across board switches so a previously-polled board resumes from its cursor.
  const revisions = new Map<BoardSlug, number>();
  const rings = new Map<BoardSlug, DeltaRing>();
  let active: Active | null = null;

  /**
   * Build the poller for one board. `getDb` returns the persistent handle or —
   * once it has been dropped after a read error — reopens the board so a
   * re-created/swapped DB file is picked up (§1.3). On every delta the runtime
   * re-reads a fresh snapshot to keep the cache current for late connectors.
   */
  function startPoller(slug: BoardSlug, initialDb: Database | null): Active {
    let db: Database | null = initialDb;

    const getDb = (): Database | null => {
      if (db) return db;
      db = tryOpen(slug); // reopen after a drop/board reappearance
      return db;
    };

    const poller = createPoller(getDb, pollIntervalMs);
    poller.onDelta((batch: PollerDelta[]) => {
      // A non-empty batch is exactly one non-trivial change → bump +1 (§3.1).
      const newRev = (revisions.get(slug) ?? 0) + 1;
      revisions.set(slug, newRev);

      // Record resumable deltas in the ring; a reset rebases and is not stored.
      const ring = rings.get(slug) ?? makeRing();
      let sawReset = false;
      for (const d of batch) {
        if (d.kind === 'reset') {
          sawReset = true;
        } else {
          ringPush(ring, newRev, d, ringCap);
        }
      }
      if (sawReset) ringMarkReset(ring, newRev);
      rings.set(slug, ring);

      // Refresh the cached snapshot, stamped with the bumped revision.
      const handle = getDb();
      if (handle) {
        try {
          snapshots.set(
            slug,
            readSnapshot(handle, { staleMs, now: Date.now() / 1000, revision: newRev }),
          );
        } catch {
          // Read failed (DB swapped under us). Drop the handle so the next tick
          // reopens it; the poller has already emitted a `reset`, which the hub
          // will publish once a payload snapshot exists (§1.3 tolerance).
          try {
            db?.close();
          } catch {
            /* already closed */
          }
          db = null;
        }
      }
      const snapshot = snapshots.get(slug);
      for (const d of batch) {
        if (d.kind === 'reset') {
          hub.publish(slug, d, snapshot);
        } else if (d.kind === 'summary') {
          hub.publish(slug, d, snapshot?.summary);
        } else {
          hub.publish(slug, d);
        }
      }
    });

    poller.start();
    return {
      slug,
      poller,
      close() {
        poller.stop();
        if (db) {
          try {
            db.close();
          } catch {
            /* already closed */
          }
          db = null;
        }
      },
    };
  }

  function select(slug: BoardSlug): BoardSnapshot | null {
    if (active && active.slug === slug) return snapshots.get(slug) ?? null;

    const switching = active !== null;
    if (active) {
      active.close();
      active = null;
    }

    const db = tryOpen(slug);
    if (db) {
      // Prime the cached snapshot synchronously so a just-connected client gets
      // an immediate `reset` rather than waiting for the first poll tick.
      try {
        snapshots.set(
          slug,
          readSnapshot(db, { staleMs, now: Date.now() / 1000, revision: revisions.get(slug) ?? 0 }),
        );
      } catch {
        /* unreadable — poller will emit a reset when it recovers */
      }
    } else {
      snapshots.delete(slug);
    }
    active = startPoller(slug, db);

    if (switching) hub.publishBoard(slug);

    return snapshots.get(slug) ?? null;
  }

  return {
    select,
    snapshotOf: (slug) => snapshots.get(slug) ?? null,
    currentRevision: (slug) => revisions.get(slug) ?? 0,
    deltasSince(slug, since) {
      const rev = revisions.get(slug);
      const snapshot = snapshots.get(slug) ?? null;
      // Board never polled a non-trivial change — nothing resumable; rebuild.
      if (rev === undefined) return { reset: true, snapshot };
      // Client is current — idle, ~0 cost, no ring access.
      if (since >= rev) return { revision: rev, deltas: [] };
      // Buffer miss (eviction, interleaved reset) or unknown → full rebuild.
      const ring = rings.get(slug);
      if (!ring || since < ring.readyFrom) return { reset: true, snapshot };
      const deltas = ring.entries.filter((e) => e.revision > since).map((e) => e.scope);
      return { revision: rev, deltas };
    },
    detailOf(slug, taskId) {
      const db = tryOpen(slug);
      if (!db) return null;
      try {
        return readCardDetail(db, taskId, { staleMs, now: Date.now() / 1000 });
      } catch {
        return null; // board swapped/unreadable mid-read
      } finally {
        try {
          db.close();
        } catch {
          /* already closed */
        }
      }
    },
    staleMs: () => staleMs,
    subscribe: (slug, send) => hub.subscribe(slug, send),
    subscribeAll: (send) => hub.subscribeAll(send),
    hub,
  };
}

/** Default app singleton used by the SSE route (one process, one set of boards). */
export const boardRuntime: BoardRuntime = createBoardRuntime();