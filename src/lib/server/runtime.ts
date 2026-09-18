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
import { readSnapshot } from './snapshot';
import { createSseHub, type BoardEvent, type SseHub } from './sse-hub';
import type { BoardSlug, BoardSnapshot, SseEvent } from '../types';

/** Default poll interval (spec §5 `POLL_INTERVAL_MS`). */
export const DEFAULT_POLL_INTERVAL_MS = 1000;

export interface BoardRuntimeOptions {
  /** Override the poll tick interval (spec §5, default 1000ms). */
  pollIntervalMs?: number;
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
  const staleMs = resolveStaleMs();
  const snapshots = new Map<BoardSlug, BoardSnapshot>();
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
    poller.onDelta((delta: PollerDelta) => {
      const handle = getDb();
      if (handle) {
        try {
          snapshots.set(slug, readSnapshot(handle, { staleMs, now: Date.now() / 1000 }));
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
      if (delta.kind === 'reset') {
        hub.publish(slug, delta, snapshot);
      } else if (delta.kind === 'summary') {
        hub.publish(slug, delta, snapshot?.summary);
      } else {
        hub.publish(slug, delta);
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
        snapshots.set(slug, readSnapshot(db, { staleMs, now: Date.now() / 1000 }));
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
    staleMs: () => staleMs,
    subscribe: (slug, send) => hub.subscribe(slug, send),
    subscribeAll: (send) => hub.subscribeAll(send),
    hub,
  };
}

/** Default app singleton used by the SSE route (one process, one set of boards). */
export const boardRuntime: BoardRuntime = createBoardRuntime();