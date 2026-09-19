// Unit tests: SSE hub + wire framing (spec §1.2, §3 `createSseHub`, §2.2, §4, §7).
//
// Covers the subscriber registry, per-client cursors, delta fan-out, the
// idle/no-subscriber no-op, unsubscribe, cross-board board events, and the
// §4 wire encoding helpers.

import { describe, expect, it } from 'vitest';
import type { SseEvent } from '../types';
import {
  createSseHub,
  encodeSseFrame,
  sseWireEvent,
  type BoardEvent,
} from './sse-hub';

describe('createSseHub', () => {
  it('fans a delta out to every subscriber of that board with its own cursor', () => {
    const hub = createSseHub();
    const a: SseEvent[] = [];
    const b: SseEvent[] = [];
    hub.subscribe('board-a', (e) => a.push(e));
    hub.subscribe('board-a', (e) => b.push(e));

    hub.publish('board-a', { kind: 'cards', upserts: [], removedIds: ['x'] }, { upserts: [], removedIds: ['x'] });
    hub.publish('board-a', { kind: 'card', taskId: 't1' });

    // Both subscribers received both events, each with an independent cursor.
    expect(a.map((e) => e.seq)).toEqual([1, 2]);
    expect(b.map((e) => e.seq)).toEqual([1, 2]);
    expect(a[0].scope).toEqual({ kind: 'cards', upserts: [], removedIds: ['x'] });
    expect(a[1].scope).toEqual({ kind: 'card', taskId: 't1' });
    expect(a[0].at).toBeTypeOf('number');
  });

  it('does not deliver a board delta to subscribers of a different board', () => {
    const hub = createSseHub();
    const got: SseEvent[] = [];
    hub.subscribe('board-a', (e) => got.push(e));
    hub.publish('board-b', { kind: 'summary' });
    expect(got).toEqual([]);
  });

  it('is a no-op when the target board has no subscribers (spec §3 idle)', () => {
    const hub = createSseHub();
    expect(() => hub.publish('board-a', { kind: 'summary' })).not.toThrow();
    expect(hub.clientCount('board-a')).toBe(0);
  });

  it('tracks clientCount per board', () => {
    const hub = createSseHub();
    const un1 = hub.subscribe('a', () => {});
    const un2 = hub.subscribe('a', () => {});
    const un3 = hub.subscribe('b', () => {});
    expect(hub.clientCount('a')).toBe(2);
    expect(hub.clientCount('b')).toBe(1);
    expect(hub.clientCount('c')).toBe(0);
    un1();
    expect(hub.clientCount('a')).toBe(1);
    un2();
    un3();
    expect(hub.clientCount('a')).toBe(0);
  });

  it('unsubscribe stops delivery', () => {
    const hub = createSseHub();
    const got: SseEvent[] = [];
    const un = hub.subscribe('a', (e) => got.push(e));
    hub.publish('a', { kind: 'summary' });
    expect(got).toHaveLength(1);
    un();
    hub.publish('a', { kind: 'summary' });
    expect(got).toHaveLength(1);
  });

  it('publishBoard broadcasts the cross-board board event to all subscribers regardless of board', () => {
    const hub = createSseHub();
    const all: BoardEvent[] = [];
    hub.subscribeAll((e) => all.push(e));
    hub.subscribe('alpha', () => {}); // board-scoped subscriber, no subscribeAll
    hub.publishBoard('beta');
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ type: 'board', slug: 'beta' });
    expect(all[0].at).toBeTypeOf('number');
  });
});

describe('wire framing (§4)', () => {
  it('encodeSseFrame renders event name, data and optional id', () => {
    const raw = encodeSseFrame('ping', { at: 123 }, 7);
    expect(raw).toBe('id: 7\nevent: ping\ndata: {"at":123}\n\n');
    expect(encodeSseFrame('hello', { seq: 1 }, undefined)).toBe('event: hello\ndata: {"seq":1}\n\n');
  });

  const fakeCardView = {
    id: 't1', title: 'T', assignee: null, priority: 0, status: 'todo' as const,
    liveness: null, elapsedMs: null, createdAt: 1, runCount: 0, lastOutcome: null,
    lastTransition: null,
    parentIds: [] as string[], childIds: [] as string[],
  };
  const fakeSummary = {
    countsByStatus: {
      triage: 0, todo: 1, ready: 0, running: 0, review: 0, blocked: 0, done: 0, archived: 0,
    },
    runningCount: 0, stalledCount: 0, maxInProgress: null, lastSyncedAt: 1,
  };
  const fakeSnapshot = { slug: 'default', summary: fakeSummary, cards: [fakeCardView] };

  it('sseWireEvent maps scopes to spec-§4 wire names + payload shapes', () => {
    expect(sseWireEvent({ seq: 1, at: 1, scope: { kind: 'reset' } }, fakeSnapshot))
      .toEqual({ name: 'reset', data: fakeSnapshot });
    expect(sseWireEvent({ seq: 1, at: 1, scope: { kind: 'summary' } }, fakeSnapshot))
      .toEqual({ name: 'summary', data: fakeSummary });
    expect(sseWireEvent(
      { seq: 1, at: 1, scope: { kind: 'cards', upserts: [fakeCardView], removedIds: ['t2'] } },
      null,
    )).toEqual({ name: 'cards', data: { upserts: [fakeCardView], removedIds: ['t2'] } });
    expect(sseWireEvent({ seq: 1, at: 1, scope: { kind: 'card', taskId: 't9' } }, fakeSnapshot))
      .toEqual({ name: 'card', data: { taskId: 't9' } });
  });

  it('sseWireEvent returns null when a reset payload cannot be resolved', () => {
    expect(sseWireEvent({ seq: 1, at: 1, scope: { kind: 'reset' } }, null)).toBeNull();
    expect(sseWireEvent({ seq: 1, at: 1, scope: { kind: 'summary' } }, null)).toBeNull();
  });
});