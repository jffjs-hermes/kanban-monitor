// Unit tests: snapshot differ (spec §2.1, §3 `diffSnapshot`, §7).
// Pure fixture tests comparing synthetic snapshots.

import { describe, expect, it } from 'vitest';
import { diffSnapshot } from './differ';
import type { BoardSnapshot, BoardSummary, CardView } from '../types';

function card(id: string, over: Partial<CardView> = {}): CardView {
  return {
    id,
    title: 'Task ' + id,
    assignee: null,
    priority: 0,
    status: 'todo',
    liveness: null,
    elapsedMs: null,
    createdAt: 0,
    runCount: 0,
    lastOutcome: null,
    parentIds: [],
    childIds: [],
    ...over,
  };
}

function summary(over: Partial<BoardSummary> = {}): BoardSummary {
  return {
    countsByStatus: {
      triage: 0,
      todo: 0,
      ready: 0,
      running: 0,
      review: 0,
      blocked: 0,
      done: 0,
      archived: 0,
    },
    runningCount: 0,
    stalledCount: 0,
    maxInProgress: null,
    lastSyncedAt: 0,
    ...over,
  };
}

function snap(slug: string, cards: CardView[], over: Partial<BoardSummary> = {}): BoardSnapshot {
  return { slug, summary: summary(over), cards };
}

function cardsScope(scopes: any[]) {
  return scopes.find((s) => s.kind === 'cards');
}

describe('diffSnapshot', () => {
  it('resets when there is no previous snapshot (first tick)', () => {
    expect(diffSnapshot(null, snap('default', []))).toEqual([{ kind: 'reset' }]);
  });

  it('resets when the board slug changed', () => {
    const prev = snap('default', [card('a')]);
    const next = snap('alpha', [card('a')]);
    expect(diffSnapshot(prev, next)).toEqual([{ kind: 'reset' }]);
  });

  it('emits nothing for an unchanged board (stable card set + summary)', () => {
    const prev = snap('default', [card('a'), card('b')]);
    const next = snap('default', [card('a'), card('b')]);
    expect(diffSnapshot(prev, next)).toEqual([]);
  });

  it('ignores heartbeat-only freshness within the same liveness class', () => {
    // Only liveness is compared, not the raw heartbeat timestamp, so two
    // 'active' cards at different ticks produce no delta (§2.1).
    const prev = snap('default', [card('a', { status: 'running', liveness: 'active' })]);
    const next = snap('default', [card('a', { status: 'running', liveness: 'active' })]);
    expect(diffSnapshot(prev, next)).toEqual([]);
  });

  it('emits a cards upsert + card scope when a card is added', () => {
    const prev = snap('default', [card('a')]);
    const next = snap('default', [card('a'), card('b')]);
    const scopes = diffSnapshot(prev, next);

    const cs = cardsScope(scopes);
    expect(cs).toBeTruthy();
    expect(cs.upserts.map((c: CardView) => c.id)).toEqual(['b']);
    expect(cs.removedIds).toEqual([]);
    expect(scopes.some((s) => s.kind === 'card' && s.taskId === 'b')).toBe(true);
  });

  it('emits a cards removal + card scope when a card disappears', () => {
    const prev = snap('default', [card('a'), card('b')]);
    const next = snap('default', [card('b')]);
    const scopes = diffSnapshot(prev, next);

    const cs = cardsScope(scopes);
    expect(cs.upserts).toEqual([]);
    expect(cs.removedIds).toEqual(['a']);
    expect(scopes.some((s) => s.kind === 'card' && s.taskId === 'a')).toBe(true);
  });

  it('emits an upsert when a card field (status/title/priority/assignee) changes', () => {
    const prev = snap('default', [card('a', { status: 'todo' })]);
    const next = snap('default', [card('a', { status: 'running', liveness: 'active' })]);
    const scopes = diffSnapshot(prev, next);

    const cs = cardsScope(scopes);
    expect(cs.upserts).toHaveLength(1);
    expect(cs.upserts[0].status).toBe('running');
  });

  it('emits a cards upsert when a running card flips from active to stalled', () => {
    const prev = snap('default', [card('a', { status: 'running', liveness: 'active' })]);
    const next = snap('default', [card('a', { status: 'running', liveness: 'stalled' })]);
    const scopes = diffSnapshot(prev, next);
    expect(cardsScope(scopes).upserts).toHaveLength(1);
  });

  it('emits only a summary scope when only the summary changed', () => {
    const prev = snap('default', [card('a')], { runningCount: 0 });
    const next = snap('default', [card('a')], { runningCount: 1 });
    expect(diffSnapshot(prev, next)).toEqual([{ kind: 'summary' }]);
  });

  it('treats lastSyncedAt churn as a non-change (no summary scope)', () => {
    const c = card('a');
    const prev = snap('default', [c], { lastSyncedAt: 111 });
    const next = snap('default', [c], { lastSyncedAt: 222 });
    expect(diffSnapshot(prev, next)).toEqual([]);
  });

  it('keeps scoped deltas at the 30% reset boundary', () => {
    const ten = Array.from({ length: 10 }, (_, i) => card('c' + i));
    // Change exactly 3 of 10 (30%) → NOT a reset, keep scoped deltas.
    const changed = ten.map((c, i) => (i < 3 ? { ...c, title: 'Changed ' + c.id } : c));
    const scopes = diffSnapshot(snap('default', ten), snap('default', changed));
    expect(scopes.some((s) => s.kind === 'reset')).toBe(false);
    expect(cardsScope(scopes).upserts).toHaveLength(3);
  });

  it('resets when more than 30% of cards changed', () => {
    const ten = Array.from({ length: 10 }, (_, i) => card('c' + i));
    // Change 4 of 10 (40%) → exceeds 30% → reset.
    const changed = ten.map((c, i) => (i < 4 ? { ...c, title: 'Changed ' + c.id } : c));
    expect(diffSnapshot(snap('default', ten), snap('default', changed))).toEqual([{ kind: 'reset' }]);
  });
});