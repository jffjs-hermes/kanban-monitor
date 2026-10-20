// Client-side SSE-consumer reducer tests (spec §7 "vitest component/SSE-consumer").
// Drive the pure `reduceBoard` with the exact wire sequence a live stream
// produces (reset → summary → cards → ping) and assert in-place mutations.

import { describe, expect, it } from 'vitest';
import {
  cardElId,
  COLUMN_DEFS,
  columnSummary,
  DEFAULT_COLUMN_LIMIT,
  distinctAssignees,
  filterByAssignee,
  formatDuration,
  groupByStatus,
  initialBoardState,
  isStalled,
  moveFocus,
  PRIMARY_COLUMNS,
  recentTransition,
  reduceBoard,
  relativeAge,
  sortByNewestFirst,
  sortCards,
  sortStalledToTop,
  stallAgeMs,
  takeNewest,
  TRANSITION_WINDOW_MS,
  visibleCardIds,
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

describe('Impl — relativeAge footer', () => {
  // `at` is unix seconds on the card wire; `relativeAge` takes unix ms.
  const at = 1_700_000_005;

  it('floors at "just now" for the first minute (and clamps clock skew)', () => {
    expect(relativeAge(at * 1000, at * 1000)).toBe('just now'); // age 0
    expect(relativeAge(at * 1000, at * 1000 + 59_999)).toBe('just now'); // 59s boundary
    expect(relativeAge(at * 1000, at * 1000 - 5_000)).toBe('just now'); // now before the move
  });

  it('rolls 59s → "1m ago" at exactly 60s', () => {
    expect(relativeAge(at * 1000, at * 1000 + 60_000)).toBe('1m ago');
  });

  it('counts minutes as a single unit up to 59m', () => {
    expect(relativeAge(at * 1000, at * 1000 + 3 * 60_000)).toBe('3m ago');
    expect(relativeAge(at * 1000, at * 1000 + 59 * 60_000)).toBe('59m ago'); // 59m boundary
    expect(relativeAge(at * 1000, at * 1000 + 3_599_999)).toBe('59m ago'); // 59m 59.999s
  });

  it('rolls 59m → "1h ago" at exactly 1h', () => {
    expect(relativeAge(at * 1000, at * 1000 + 3_600_000)).toBe('1h ago');
  });

  it('counts hours as a single unit up to 23h', () => {
    expect(relativeAge(at * 1000, at * 1000 + 2 * 3_600_000)).toBe('2h ago');
    expect(relativeAge(at * 1000, at * 1000 + 23 * 3_600_000)).toBe('23h ago'); // 23h boundary
    expect(relativeAge(at * 1000, at * 1000 + 86_399_999)).toBe('23h ago'); // 23h 59m 59.999s
  });

  it('rolls 23h → "1d ago" at exactly 24h and keeps counting days', () => {
    expect(relativeAge(at * 1000, at * 1000 + 86_400_000)).toBe('1d ago');
    expect(relativeAge(at * 1000, at * 1000 + 2 * 86_400_000)).toBe('2d ago');
    expect(relativeAge(at * 1000, at * 1000 + 30 * 86_400_000)).toBe('30d ago');
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

describe('per-column summary strip (Card D) — columnSummary', () => {
  // Wire timestamps (`createdAt`, `lastTransition.at`) are unix seconds;
  // `lastUpdatedMs` is unix ms — the helper converts like the card footer does.
  const s = (n: number): number => 1_700_000_000 + n; // unix seconds

  const by = (sum: ReturnType<typeof columnSummary>) =>
    Object.fromEntries(sum.map((e) => [e.status, e]));

  it('returns one entry per status in column order, empty columns included', () => {
    const sum = columnSummary([card('r1', { status: 'ready' }), card('d1', { status: 'done' })]);
    expect(sum.map((e) => e.status)).toEqual([
      'triage', 'todo', 'ready', 'running', 'review', 'blocked', 'done', 'archived',
    ]);
    const b = by(sum);
    expect(b.ready).toMatchObject({ status: 'ready', count: 1, stalled: 0 });
    expect(b.done).toMatchObject({ status: 'done', count: 1, stalled: 0 });
    expect(b.running).toMatchObject({ count: 0, stalled: 0 }); // absent column still present
    expect(b.archived).toMatchObject({ count: 0, stalled: 0 });
  });

  it('counts cards per column', () => {
    const sum = columnSummary([
      card('r1', { status: 'ready' }),
      card('r2', { status: 'ready' }),
      card('x', { status: 'running' }),
      card('b1', { status: 'blocked' }),
    ]);
    const b = by(sum);
    expect(b.ready.count).toBe(2);
    expect(b.running.count).toBe(1);
    expect(b.blocked.count).toBe(1);
    expect(b.review.count).toBe(0);
  });

  it('extracts per-column stalled counts — stalled running cards only (isStalled semantics)', () => {
    const running = (over: Partial<CardView> = {}): CardView =>
      card('r', { status: 'running', liveness: 'active', elapsedMs: 0, ...over });
    const sum = columnSummary([
      running({ id: 's1', liveness: 'stalled' }),
      running({ id: 's2', liveness: 'stalled' }),
      running({ id: 'a1', liveness: 'active' }),
      card('d1', { status: 'done', liveness: 'stalled' }), // non-running liveness is never stalled
    ]);
    const b = by(sum);
    expect(b.running).toMatchObject({ count: 3, stalled: 2 });
    expect(b.done).toMatchObject({ count: 1, stalled: 0 });
  });

  it('dates a column from its newest lastTransition (unix seconds → ms)', () => {
    const sum = columnSummary([
      card('old', { status: 'ready', lastTransition: { to: 'ready', at: s(100) } }),
      card('new', { status: 'ready', lastTransition: { to: 'ready', at: s(500) } }),
      card('other', { status: 'review', lastTransition: { to: 'review', at: s(900) } }),
    ]);
    const b = by(sum);
    expect(b.ready.lastUpdatedMs).toBe(s(500) * 1000);
    expect(b.review.lastUpdatedMs).toBe(s(900) * 1000);
  });

  it('falls back to createdAt when a card has no recorded transition (missing/null timestamps)', () => {
    const sum = columnSummary([
      card('never-moved', { status: 'ready', createdAt: s(999), lastTransition: null }),
      card('moved', { status: 'ready', createdAt: s(1), lastTransition: { to: 'ready', at: s(100) } }),
      // Default factory card: createdAt s(0), lastTransition null — must not crash.
      card('bare', { status: 'blocked' }),
    ]);
    const b = by(sum);
    expect(b.ready.lastUpdatedMs).toBe(s(999) * 1000); // creation outdates the older transition
    expect(b.blocked.lastUpdatedMs).toBe(s(0) * 1000);
    // A bare card (null transition, default createdAt) still dates its column.
    expect(by(columnSummary([card('bare2')])).ready.lastUpdatedMs).toBe(s(0) * 1000);
  });

  it('yields null lastUpdatedMs for empty columns and never errors on zero cards', () => {
    const empty = columnSummary([]);
    expect(empty).toHaveLength(8);
    expect(empty.every((e) => e.count === 0 && e.stalled === 0 && e.lastUpdatedMs === null)).toBe(true);
    // A cardless column among populated ones still renders a placeholder.
    const b = by(columnSummary([card('r1', { status: 'ready', lastTransition: { to: 'ready', at: s(10) } })]));
    expect(b.triage).toMatchObject({ count: 0, stalled: 0, lastUpdatedMs: null });
  });
});

describe('assignee filter (Card B)', () => {
  it('distinctAssignees dedupes and sorts, ignoring unassigned cards', () => {
    const cards = [
      card('a', { assignee: 'reviewer' }),
      card('b', { assignee: 'builder' }),
      card('c', { assignee: 'reviewer' }), // duplicate
      card('d'), // null assignee
      card('e', { assignee: '' }), // empty assignee
    ];
    expect(distinctAssignees(cards)).toEqual(['builder', 'reviewer']);
    expect(distinctAssignees([])).toEqual([]);
  });

  it('filterByAssignee with null ("All") returns every card, incl. unassigned', () => {
    const cards = [card('a', { assignee: 'builder' }), card('b'), card('c', { assignee: 'reviewer' })];
    expect(filterByAssignee(cards, null).map((c) => c.id)).toEqual(['a', 'b', 'c']);
  });

  it('keeps only cards matching the named assignee, across statuses', () => {
    const cards = [
      card('r1', { assignee: 'builder', status: 'ready' }),
      card('run', { assignee: 'builder', status: 'running' }),
      card('rev', { assignee: 'reviewer', status: 'review' }),
      card('d1', { assignee: 'builder', status: 'done' }),
    ];
    const kept = filterByAssignee(cards, 'builder').map((c) => c.id);
    expect(kept).toEqual(['r1', 'run', 'd1']);
  });

  it('excludes null-assignee cards when a specific assignee is selected', () => {
    const cards = [card('a', { assignee: 'builder' }), card('b')];
    expect(filterByAssignee(cards, 'builder').map((c) => c.id)).toEqual(['a']);
    expect(filterByAssignee(cards, 'nobody')).toEqual([]);
  });

  it('feeds groupByStatus: column membership reflects the filter', () => {
    const cards = [
      card('ra', { assignee: 'builder', status: 'ready' }),
      card('rb', { assignee: 'reviewer', status: 'ready' }),
      card('d1', { assignee: 'builder', status: 'done' }),
    ];
    // The page calls `groupByStatus(filterByAssignee(cards, filter))`, so column
    // lists (and thus the count badges + empty states) follow the filter.
    const g = groupByStatus(filterByAssignee(cards, 'builder'));
    expect(g.ready!.map((c) => c.id)).toEqual(['ra']);
    expect(g.done!.map((c) => c.id)).toEqual(['d1']);
    expect(g.review).toEqual([]);
  });
});

describe('keyboard navigation — focus movement + wrap-around (Card A)', () => {
  // Board layout as the page feeds `moveFocus`: one array of visible card ids
  // per rendered column, in render order. ready(3) running(2) review(1)
  // blocked(0 — empty) done(5).
  const BOARD = [
    ['r1', 'r2', 'r3'],
    ['run1', 'run2'],
    ['rev1'],
    [],
    ['d1', 'd2', 'd3', 'd4', 'd5'],
  ];

  it('returns null when the board has no cards at all', () => {
    expect(moveFocus([], null, 'down')).toBeNull();
    expect(moveFocus([[], []], null, 'up')).toBeNull();
    expect(moveFocus([], 'ghost', 'right')).toBeNull();
  });

  it('starts at the first card of the first non-empty column when nothing is focused', () => {
    expect(moveFocus(BOARD, null, 'down')).toBe('r1');
    expect(moveFocus(BOARD, null, 'up')).toBe('r1');
    expect(moveFocus(BOARD, null, 'left')).toBe('r1'); // any direction anchors
    // Leading empty columns are skipped to reach the first card.
    expect(moveFocus([[], ['a']], null, 'down')).toBe('a');
  });

  it('treats a focused id that is no longer rendered as unset (card removed/collapsed)', () => {
    expect(moveFocus(BOARD, 'ghost', 'down')).toBe('r1');
    expect(moveFocus(BOARD, 'gone', 'left')).toBe('r1');
  });

  it('moves down within a column, wrapping at the bottom edge', () => {
    expect(moveFocus(BOARD, 'r1', 'down')).toBe('r2');
    expect(moveFocus(BOARD, 'r2', 'down')).toBe('r3');
    expect(moveFocus(BOARD, 'r3', 'down')).toBe('r1'); // wrap
    expect(moveFocus(BOARD, 'd5', 'down')).toBe('d1'); // wrap (tall column)
  });

  it('moves up within a column, wrapping at the top edge', () => {
    expect(moveFocus(BOARD, 'r2', 'up')).toBe('r1');
    expect(moveFocus(BOARD, 'r1', 'up')).toBe('r3'); // wrap
    expect(moveFocus(BOARD, 'd1', 'up')).toBe('d5'); // wrap
  });

  it('stays put in a single-card column', () => {
    expect(moveFocus(BOARD, 'rev1', 'down')).toBe('rev1');
    expect(moveFocus(BOARD, 'rev1', 'up')).toBe('rev1');
  });

  it('moves right across columns, preserving the row (clamped)', () => {
    expect(moveFocus(BOARD, 'r1', 'right')).toBe('run1'); // row 0
    expect(moveFocus(BOARD, 'r2', 'right')).toBe('run2'); // row 1
    expect(moveFocus(BOARD, 'r3', 'right')).toBe('run2'); // row 2 clamps to the 2-card column
    expect(moveFocus(BOARD, 'run2', 'right')).toBe('rev1'); // row 1 clamps to the single review card
  });

  it('moves left across columns, preserving the row (clamped)', () => {
    expect(moveFocus(BOARD, 'run1', 'left')).toBe('r1');
    expect(moveFocus(BOARD, 'run2', 'left')).toBe('r2');
    expect(moveFocus(BOARD, 'd3', 'left')).toBe('rev1'); // row 2 clamps to the single review card
  });

  it('skips empty columns when moving sideways', () => {
    // blocked column (index 3) is empty: right from review lands on done.
    expect(moveFocus(BOARD, 'rev1', 'right')).toBe('d1');
    expect(moveFocus(BOARD, 'rev1', 'left')).toBe('run1');
  });

  it('wraps right from the last column to the first', () => {
    expect(moveFocus(BOARD, 'd1', 'right')).toBe('r1');
    expect(moveFocus(BOARD, 'd4', 'right')).toBe('r3'); // row 3 clamps to the 3-card column
  });

  it('wraps left from the first column to the last', () => {
    expect(moveFocus(BOARD, 'r1', 'left')).toBe('d1');
    expect(moveFocus(BOARD, 'r2', 'left')).toBe('d2');
  });

  it('stays put when no other column has cards', () => {
    expect(moveFocus([['a', 'b'], []], 'a', 'right')).toBe('a');
    expect(moveFocus([['a', 'b'], []], 'b', 'left')).toBe('b');
  });

  it('visibleCardIds mirrors the rendered column (limit unless expanded)', () => {
    const fifteen = Array.from({ length: 15 }, (_, i) => card(`c${i}`, { createdAt: i }));
    const ids = fifteen.map((c) => c.id);
    expect(visibleCardIds(fifteen, false)).toEqual(ids.slice(0, DEFAULT_COLUMN_LIMIT));
    expect(visibleCardIds(fifteen, true)).toEqual(ids);
    expect(visibleCardIds([], false)).toEqual([]);
  });

  it('cardElId is the DOM id contract between Card and the drawer focus restore', () => {
    expect(cardElId('t_abc')).toBe('card-t_abc');
  });
});