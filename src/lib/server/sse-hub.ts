// Subscriber registry + delta fan-out (spec §1.2, §3 `createSseHub`, §4, §2.2).
//
// Per the spec boundary rule (§1.2) this is the ONLY module that knows about
// live connections. It:
//   - keeps a subscriber registry keyed by board slug;
//   - tracks an independent monotonic cursor (`SseEvent.seq`) per subscription
//     so each client gets its own sequence (spec §1.2 "per-client cursors");
//   - skips fan-out when a board has no subscribers (spec §3: idle boards cost
//     one sqlite read/s, no I/O to browsers);
//   - broadcasts cross-board `board` events on a separate "all subscribers"
//     channel so a board switch can re-target every connected client (§1.1).
//
// The hub never touches SQL and never drives the poller — it only routes
// already-computed deltas to connected clients. The wire-encoding helpers
// (`encodeSseFrame`, `sseWireEvent`) live here because framing a connection's
// bytes is connection knowledge (§1.2 boundary rule).

import type { BoardSlug, BoardSnapshot, DeltaScope, SseEvent } from '../types';

/** Idle ping interval for SSE connections (spec §4: every 15s). */
export const PING_INTERVAL_MS = 15_000;

/** Cross-board board-switch notification (spec §1.1). */
export interface BoardEvent {
  type: 'board';
  at: number; // unix ms
  slug: BoardSlug; // the newly-selected / now-active board
}

export interface SseHub {
  /** Subscribe to a board's deltas. Returns an unsubscribe function. */
  subscribe(slug: BoardSlug, send: (evt: SseEvent) => void): () => void;
  /** Subscribe to the cross-board channel (board switch notifications). */
  subscribeAll(send: (evt: BoardEvent) => void): () => void;
  /** Fan a board-scoped delta out to that board's subscribers. No-op when idle. */
  publish(slug: BoardSlug, scope: DeltaScope, data?: unknown): void;
  /** Broadcast a board switch to every subscriber regardless of board (§1.1). */
  publishBoard(slug: BoardSlug): void;
  /** Number of subscribed clients for a board (spec §3). */
  clientCount(slug: BoardSlug): number;
}

interface Sub {
  slug: BoardSlug;
  seq: number; // per-client cursor
  send: (evt: SseEvent) => void;
}

interface AllSub {
  seq: number;
  send: (evt: BoardEvent) => void;
}

export function createSseHub(): SseHub {
  const subs = new Set<Sub>();
  const alls = new Set<AllSub>();

  return {
    subscribe(slug, send) {
      const sub: Sub = { slug, seq: 0, send };
      subs.add(sub);
      return () => subs.delete(sub);
    },
    subscribeAll(send) {
      const sub: AllSub = { seq: 0, send };
      alls.add(sub);
      return () => alls.delete(sub);
    },
    publish(slug, scope, data) {
      if (subs.size === 0) return;
      for (const sub of subs) {
        if (sub.slug !== slug) continue;
        sub.seq += 1;
        sub.send({ seq: sub.seq, at: Date.now(), scope, data });
      }
    },
    publishBoard(slug) {
      if (alls.size === 0) return;
      for (const all of alls) {
        all.seq += 1;
        all.send({ type: 'board', at: Date.now(), slug });
      }
    },
    clientCount(slug) {
      let n = 0;
      for (const s of subs) if (s.slug === slug) n++;
      return n;
    },
  };
}

/**
 * Translate a fan-out `SseEvent` into the wire event name + JSON `data:` payload
 * defined by spec §4. Falls back to the full snapshot / it's summary when the
 * scope requires it (`reset` and `summary` — the differ emits bare scopes, the
 * snapshot data lives on the runtime). Returns `null` when the payload cannot be
 * resolved (e.g. a `reset` before any snapshot exists), which the caller skips.
 *
 * Wire shapes (§4):
 *   reset   -> full BoardSnapshot
 *   summary -> BoardSummary
 *   health  -> AgentHealth[] (scope carries the array itself)
 *   cards   -> { upserts, removedIds }
 *   card    -> { taskId }
 */
export function sseWireEvent(
  evt: SseEvent,
  snapshot: BoardSnapshot | null,
): { name: 'reset' | 'summary' | 'health' | 'cards' | 'card'; data: unknown } | null {
  const s = evt.scope;
  switch (s.kind) {
    case 'reset':
      return snapshot ? { name: 'reset', data: snapshot } : null;
    case 'summary':
      return snapshot ? { name: 'summary', data: snapshot.summary } : null;
    case 'health':
      return { name: 'health', data: s.health };
    case 'cards':
      return { name: 'cards', data: { upserts: s.upserts, removedIds: s.removedIds } };
    case 'card':
      return { name: 'card', data: { taskId: s.taskId } };
  }
}

/**
 * Encode one SSE frame. `seq` (when given) rides in the standard SSE `id:` field
 * so the client can show a monotonic per-connection sequence in the footer
 * (spec §4 "each event's seq") without polluting the spec-§4 JSON payload.
 * `data` is always the exact §4 payload.
 */
export function encodeSseFrame(eventName: string, data: unknown, seq?: number): string {
  const prefix = seq === undefined ? `event: ${eventName}` : `id: ${seq}\nevent: ${eventName}`;
  return `${prefix}\ndata: ${JSON.stringify(data)}\n\n`;
}