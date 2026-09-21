// Client-side SSE-consumer reducer tests (spec §7 "vitest component/SSE-consumer").
// Drive the pure `reduceBoard` with the exact wire sequence a live stream
// produces (reset → summary → cards → ping) and assert in-place mutations.

import { describe, expect, it } from 'vitest';
import {
  COLUMN_DEFS,
  DEFAULT_COLUMN_LIMIT,
  formatDuration,
  groupByStatus,
  initialBoardState,
  isStalled,
  PRIMARY_COLUMNS,
  recentTransition,
  reduceBoard,
  sortByNewestFirst,
  sortCards,
  sortStalledToTop,
  stallAgeMs,
  takeNewest,
  TRANSITION_WINDOW_MS,
} from './board-view';
import type {
  AgentHealth,
  BoardSnapshot,
  BoardSummary,
  CardView,
} from './types';

const T = (n: number): number => 1_700_000_000_000 + n;

function healthEntry(over: Partial<AgentHealth> = {}): AgentHealth {
  return {
    profile: 'builder',
    runningCardCount: 1,
    workerPid: 1234,
    workerSessionId: 'sess-1',
    runStartedAt: 1_700_000_000,
    heartbeatAgeSec: 5,
    stale: false,
    ...over,
  };
}

function card(id: string, over: Partial<CardView> = {}): CardView {
  return {
    id,
    title: `Card ${id}`,
    assignee: null,
    priority: 0,
    status: 'ready',
    liveness: null,
    elapsedMs: null,
    createdAt: 1_700_000_000,
    runCount: 0,
    lastOutcome: null,
    lastTransition: null,
    parentIds: [],
    childIds: [],
    ...over,
  };
}

function summary(over: Partial<BoardSummary> = {}): BoardSummary {
  return {
    countsByStatus: { triage: 0, todo: 0, ready: 0, running: 0, review: 0, blocked: 0, done: 0, archived: 0 },
    runningCount: 0,
    stalledCount: 0,
    maxInProgress: null,
    lastSyncedAt: T(0),
    ...over,
  };
}

function snapshot(slug = 'default', cards: CardView[] = [], over: Partial<BoardSnapshot> = {}): BoardSnapshot {
  return { slug, cards, summary: summary(), revision: 0, ...over, health: over.health ?? [] };
}

describe('reduceBoard — realtime sequence', () => {
  it('ignores non-reset events before the baseline snapshot exists', () => {
    let s = initialBoardState('default');
    s = reduceBoard(s, 'cards', { upserts: [card('a')], removedIds: [] }, 1, T(1));
    expect(s.snapshot).toBeNull();
  });

  it('replaces full state on reset', () => {
    let s = initialBoardState('default');
    const snap = snapshot('default', [card('a', { status: 'running' })]);
    s = reduceBoard(s, 'reset', snap, 1, T(1));
    expect(s.snapshot).not.toBeNull();
    expect(s.snapshot!.cards).toHaveLength(1);
    expect(s.snapshot!.cards[0].id).toBe('a');
    expect(s.connected).toBe(true);
    expect(s.seq).toBe(1);
  });

  it('merges a summary delta into the existing snapshot', () => {
    let s = initialBoardState('default');
    s = reduceBoard(s, 'reset', snapshot('default', [card('a')]), 1, T(1));
    const sum = summary({ runningCount: 2, stalledCount: 1, lastSyncedAt: T(5) });
    s = reduceBoard(s, 'summary', sum, 2, T(6));
    expect(s.snapshot!.summary.runningCount).toBe(2);
    expect(s.snapshot!.summary.stalledCount).toBe(1);
    expect(s.seq).toBe(2);
  });

  it('merges a health delta into the existing snapshot, preserving other fields', () => {
    let s = initialBoardState('default');
    const base = snapshot('default', [card('a')]);
    s = reduceBoard(s, 'reset', base, 1, T(1));
    // A worker starts: health arrives as a delta, no full reset.
    s = reduceBoard(s, 'health', [healthEntry()], 2, T(6));
    expect(s.snapshot!.health).toEqual([healthEntry()]);
    expect(s.snapshot!.cards).toHaveLength(1); // cards untouched
    expect(s.snapshot!.cards[0].id).toBe('a');
    expect(s.snapshot!.summary).toBe(base.summary); // summary untouched
    expect(s.seq).toBe(2);
    expect(s.lastEventAt).toBe(T(6));
  });

  it('merges a health delta to empty when a worker stops (panel disappears)', () => {
    let s = initialBoardState('default');
    s = reduceBoard(s, 'reset', snapshot('default', [card('a')], { health: [healthEntry()] }), 1, T(1));
    s = reduceBoard(s, 'health', [], 2, T(7));
    expect(s.snapshot!.health).toEqual([]);
    expect(s.snapshot!.cards).toHaveLength(1); // no reset
  });

  it('upserts and removes cards in place on cards delta', () => {
    let s = initialBoardState('default');
    s = reduceBoard(s, 'reset', snapshot('default', [card('a'), card('b')], { summary: summary({ runningCount: 1 }) }), 1, T(1));
    // 'b' moved running; 'a' removed; 'c' added ready.
    s = reduceBoard(
      s,
      'cards',
      {
        upserts: [
          card('b', { status: 'running', liveness: 'active', elapsedMs: 3000 }),
          card('c', { status: 'ready', priority: 5 }),
        ],
        removedIds: ['a'],
      },
      2,
      T(2),
    );
    const ids = s.snapshot!.cards.map((c) => c.id).sort();
    expect(ids).toEqual(['b', 'c']);
    expect(s.snapshot!.cards.find((c) => c.id === 'b')!.status).toBe('running');
  });

  it('sorts cards status → priority → age after a delta', () => {
    let s = initialBoardState('default');
    // Prev order from a reset is already sorted; deltas must preserve ordering.
    s = reduceBoard(
      s,
      'reset',
      snapshot('default', [
        card('p0', { status: 'ready' }),
        card('hi', { status: 'running' }),
        card('rev', { status: 'review' }),
      ]),
      1,
      T(1),
    );
    // New high-priority ready card + a done card appear via delta.
    s = reduceBoard(
      s,
      'cards',
      {
        upserts: [
          card('p9', { status: 'ready', priority: 9 }),
          card('d1', { status: 'done' }),
        ],
        removedIds: [],
      },
      2,
      T(2),
    );
    const order = s.snapshot!.cards.map((c) => c.id);
    // status order: ready(index0) < running < review < done; within ready, p9 (priority 9) before p0.
    expect(order.indexOf('p9')).toBeLessThan(order.indexOf('p0'));
    expect(order.indexOf('p0')).toBeLessThan(order.indexOf('hi'));
    expect(order.indexOf('hi')).toBeLessThan(order.indexOf('rev'));
    expect(order.indexOf('rev')).toBeLessThan(order.indexOf('d1'));
  });

  it('does not drop a cards delta when a reset arrived first and summary is untouched', () => {
    const snap = snapshot('default', [card('x')]);
    let s = reduceBoard(initialBoardState(), 'reset', snap, 1, T(1));
    s = reduceBoard(s, 'cards', { upserts: [card('y')], removedIds: [] }, 2, T(2));
    expect(s.snapshot!.cards).toHaveLength(2);
  });

  it('tracks ping keep-alives and preserves the snapshot', () => {
    let s = initialBoardState('default');
    s = reduceBoard(s, 'reset', snapshot('default', [card('a')]), 1, T(1));
    s = reduceBoard(s, 'ping', { at: T(20) }, 3, T(20));
    expect(s.seq).toBe(3);
    expect(s.lastEventAt).toBe(T(20));
    expect(s.snapshot!.cards).toHaveLength(1);
  });

  it('surfaces connection loss and recovers on the next open', () => {
    let s = initialBoardState('default');
    s = reduceBoard(s, 'reset', snapshot('default', [card('a')]), 1, T(1));
    s = reduceBoard(s, 'error', null, null);
    expect(s.connected).toBe(false);
    s = reduceBoard(s, 'open', null, null);
    expect(s.connected).toBe(true);
  });

  it('captures staleMs from hello', () => {
    let s = initialBoardState('default');
    s = reduceBoard(s, 'hello', { slug: 'default', staleMs: 90_000 }, 1, T(1));
    expect(s.staleMs).toBe(90_000);
  });
});

describe('column formation helpers', () => {
  it('exposes the five primary columns in order', () => {
    expect(PRIMARY_COLUMNS).toEqual(['ready', 'running', 'review', 'blocked', 'done']);
  });

  it('marks triage/todo/archived as collapsed in the column defs', () => {
    const collapsed = COLUMN_DEFS.filter((d) => d.collapsed).map((d) => d.status);
    expect(collapsed).toContain('triage');
    expect(collapsed).toContain('todo');
    expect(collapsed).toContain('archived');
    expect(COLUMN_DEFS).toHaveLength(8); // all statuses present
  });

  it('groups cards by status', () => {
    const ready = [card('r1'), card('r2')];
    const running = [card('run', { status: 'running' })];
    const g = groupByStatus([...ready, ...running, card('done', { status: 'done' })]);
    expect(g.ready).toHaveLength(2);
    expect(g.running).toHaveLength(1);
    expect(g.done).toHaveLength(1);
    expect(g.blocked).toEqual([]);
  });

  it('sorts cards status → priority(desc) → age(asc)', () => {
    const cards: CardView[] = [
      card('old-low', { status: 'ready', priority: 1, createdAt: 100 }),
      card('new-high', { status: 'ready', priority: 9, createdAt: 300 }),
      card('mid', { status: 'ready', priority: 5, createdAt: 100 }),
      card('running-one', { status: 'running', createdAt: 50 }),
    ];
    const s = sortCards(cards).map((c) => c.id);
    expect(s).toEqual(['new-high', 'mid', 'old-low', 'running-one']);
  });
});

describe('Impl 12 — per-column newest-first sort + limit', () => {
  it('orders a column newest-first by created_at regardless of input order', () => {
    const cards: CardView[] = [
      card('oldest', { status: 'ready', createdAt: 100 }),
      card('newest', { status: 'ready', createdAt: 300 }),
      card('middle', { status: 'ready', createdAt: 200 }),
    ];
    expect(sortByNewestFirst(cards).map((c) => c.id)).toEqual(['newest', 'middle', 'oldest']);
  });

  it('groups each column newest-first (does not rely on array order)', () => {
    const cards: CardView[] = [
      card('o', { status: 'ready', createdAt: 100 }),
      card('n', { status: 'ready', createdAt: 300 }),
      card('m', { status: 'ready', createdAt: 200 }),
      card('run-old', { status: 'running', createdAt: 50 }),
      card('run-new', { status: 'running', createdAt: 400 }),
    ];
    const g = groupByStatus(cards);
    expect(g.ready!.map((c) => c.id)).toEqual(['n', 'm', 'o']);
    expect(g.running!.map((c) => c.id)).toEqual(['run-new', 'run-old']);
  });

  it('slices a column down to the newest N cards by default', () => {
    const cards: CardView[] = Array.from({ length: 25 }, (_, i) =>
      card(`c${i}`, { status: 'ready', createdAt: 1_000 + i }),
    );
    // Callers pass a newest-first list (from groupByStatus); slice keeps the newest 10.
    const limit = takeNewest(sortByNewestFirst(cards));
    expect(limit).toHaveLength(DEFAULT_COLUMN_LIMIT);
    expect(limit).toHaveLength(10);
    expect(limit.map((c) => c.id)).toEqual(Array.from({ length: 10 }, (_, i) => `c${24 - i}`)); // newest 10
  });

  it('leaves a column with ≤10 cards untouched', () => {
    const cards = [card('a', { createdAt: 3 }), card('b', { createdAt: 2 }), card('c', { createdAt: 1 })];
    expect(takeNewest(cards).map((c) => c.id)).toEqual(['a', 'b', 'c']);
  });

  it('takeNewest never grows a list and clamps a negative limit', () => {
    const cards = [card('a', { createdAt: 1 })];
    expect(takeNewest(cards, 5)).toHaveLength(1);
    expect(takeNewest(cards, -1)).toHaveLength(0);
  });
});

describe('Impl — recentTransition window derivation', () => {
  // `at` is unix seconds (as stored in task_events); `now` is unix ms.
  const at = 1_700_000_005; // 5s after the 1_700_000_000 epoch

  it('returns null when the card has no recorded transition', () => {
    expect(recentTransition(card('a'), 1_700_000_010_000)).toBeNull();
  });

  it('annotates a transition inside the window (incl. the exact boundary)', () => {
    const c = card('a', { lastTransition: { to: 'review', at } });
    expect(recentTransition(c, at * 1000)).toEqual({ to: 'review', at }); // age 0
    expect(recentTransition(c, at * 1000 + TRANSITION_WINDOW_MS)).toEqual({ to: 'review', at }); // age == window
    expect(recentTransition(c, at * 1000 + 4_000)).toEqual({ to: 'review', at });
  });

  it('clears once the transition ages out of the window', () => {
    const c = card('a', { lastTransition: { to: 'review', at } });
    expect(recentTransition(c, at * 1000 + TRANSITION_WINDOW_MS + 1)).toBeNull();
    expect(recentTransition(c, at * 1000 + 10_000)).toBeNull();
  });

  it('ignores a transition timestamped in the future', () => {
    const c = card('a', { lastTransition: { to: 'running', at: 1_700_000_010 } });
    expect(recentTransition(c, at * 1000)).toBeNull(); // now is before the move
  });

  it('honors an explicit window override and survives a reload (state-derived)', () => {
    const c = card('a', { lastTransition: { to: 'done', at } });
    expect(recentTransition(c, at * 1000 + 3_000, 2_000)).toBeNull(); // outside custom window
    expect(recentTransition(c, at * 1000 + 1_500, 2_000)).toEqual({ to: 'done', at });
  });
});

describe('Impl — stalled / credit-burn alerting', () => {
  // Helper: a running card. The `frameAt` (snapshot lastSyncedAt) is the anchor
  // stallAgeMs adds the client-clock delta onto.
  const frameAt = 1_700_000_000 * 1000; // unix ms
  const running = (over: Partial<CardView> = {}): CardView =>
    card('r', { status: 'running', liveness: 'active', elapsedMs: 0, runCount: 1, ...over });

  it('isStalled is exactly running + liveness=stalled (reuses server semantics)', () => {
    expect(isStalled(running({ liveness: 'stalled' }))).toBe(true);
    expect(isStalled(running({ liveness: null }))).toBe(false); // not running is not stalled
    expect(isStalled(running({ liveness: 'active' }))).toBe(false);
    expect(isStalled(card('x', { status: 'done', liveness: 'stalled' }))).toBe(false);
  });

  it('sorts stalled cards to the top of a column, preserving relative order', () => {
    const active1 = running({ id: 'a1', liveness: 'active', createdAt: 400 });
    const stalled1 = running({ id: 's1', liveness: 'stalled', createdAt: 200 });
    const active2 = running({ id: 'a2', liveness: 'active', createdAt: 300 });
    const stalled2 = running({ id: 's2', liveness: 'stalled', createdAt: 500 });
    const sorted = sortStalledToTop([active1, stalled1, active2, stalled2]).map((c) => c.id);
    expect(sorted.slice(0, 2).sort()).toEqual(['s1', 's2']); // stalled at the top
    expect(sorted.slice(2).sort()).toEqual(['a1', 'a2']);
  });

  it('groupByStatus pins stalled Running cards above active ones', () => {
    const activeNew = running({ id: 'aN', liveness: 'active', createdAt: 400 });
    const stalledNew = running({ id: 'sN', liveness: 'stalled', createdAt: 500 });
    const stalledOld = running({ id: 'sO', liveness: 'stalled', createdAt: 100 });
    const o = groupByStatus([activeNew, stalledNew, stalledOld]).running.map((c) => c.id);
    // Within running: stalled first (newest-first within stalled), then active newest-first.
    expect(o).toEqual(['sN', 'sO', 'aN']);
  });

  it('stallAgeMs grows across consecutive polls (monotone burn), from frameAt + tick', () => {
    const st = running({ liveness: 'stalled', elapsedMs: 3_000 }); // running 3s at frameAt
    const t0 = frameAt; // the snapshot timestamp
    // Immediately after the frame the age is elapsedMs + 0.
    expect(stallAgeMs(st, t0, frameAt)).toBe(3_000);
    // Two polls later the client clock advanced ~ the age keeps growing.
    expect(stallAgeMs(st, t0 + 20_000, frameAt)).toBe(23_000);
    // A fresh snapshot bumps the base elapsed; still monotone total.
    const newerFrame = frameAt + 60_000;
    const st2 = running({ liveness: 'stalled', elapsedMs: 63_000 });
    expect(stallAgeMs(st2, newerFrame, newerFrame)).toBe(63_000);
  });

  it('stallAgeMs is null (badge clears) when the heartbeat resumes or the card leaves Running', () => {
    // Resume: liveness flips to active → no stall badge, even though still running.
    expect(stallAgeMs(running({ liveness: 'active', elapsedMs: 5_000 }), frameAt, frameAt)).toBeNull();
    // Leaves Running: status changes → no stall badge.
    expect(stallAgeMs(card('x', { status: 'review' }), frameAt, frameAt)).toBeNull();
    // No elapsed available → nothing to badge.
    expect(stallAgeMs(running({ liveness: 'stalled', elapsedMs: null }), frameAt, frameAt)).toBeNull();
  });

  it('formatDuration renders compact stall ages', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(45_000)).toBe('45s');
    expect(formatDuration(185_000)).toBe('3m 5s');
    expect(formatDuration(3 * 3600_000 + 5 * 60_000)).toBe('3h 5m');
  });
});