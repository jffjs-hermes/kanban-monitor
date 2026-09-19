// Unit tests: card detail reader + transition-trail derivation (spec §2
// `CardDetail`, §2.1 drawer fetch, §7). Runs against a tiny on-disk fixture
// board DB so the trail's event fold and the detail payload are exercised
// against real rows (created → promoted → claimed → review_requested → done).

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Database } from 'bun:sqlite';

import { openReadonly } from './data-access';
import { readCardDetail, deriveTransitions, statusAfterEvent } from './card-detail';

const SCHEMA = `
CREATE TABLE tasks (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT, assignee TEXT,
  status TEXT NOT NULL, priority INTEGER DEFAULT 0, created_at INTEGER NOT NULL,
  started_at INTEGER, completed_at INTEGER, worker_pid INTEGER,
  last_heartbeat_at INTEGER, current_run_id INTEGER, block_kind TEXT
);
CREATE TABLE task_runs (
  id INTEGER PRIMARY KEY, task_id TEXT NOT NULL, profile TEXT, step_key TEXT,
  status TEXT NOT NULL, claim_lock TEXT, claim_expires INTEGER, worker_pid INTEGER,
  max_runtime_seconds INTEGER, last_heartbeat_at INTEGER, started_at INTEGER,
  ended_at INTEGER, outcome TEXT, summary TEXT, metadata TEXT, error TEXT
);
CREATE TABLE task_events (
  id INTEGER PRIMARY KEY, task_id TEXT NOT NULL, run_id INTEGER,
  kind TEXT NOT NULL, payload TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE task_comments (
  id INTEGER PRIMARY KEY, task_id TEXT NOT NULL, author TEXT NOT NULL,
  body TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE task_links (
  parent_id TEXT NOT NULL, child_id TEXT NOT NULL
);
`;

interface Fixture {
  home: string;
  dbPath: string;
}

function makeBoard(): Fixture {
  const home = resolve(mkdtempSync('cdetail-'));
  const dbPath = join(home, 'kanban.db');
  const db = new Database(dbPath);
  db.exec(SCHEMA);

  const ins = db.prepare(
    `INSERT INTO tasks (id, title, body, assignee, status, priority, created_at,
       started_at, completed_at, worker_pid, last_heartbeat_at, current_run_id, block_kind)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  // "a": done card with a full lifecycle.
  ins.run('a', 'Alpha', 'Body of A', 'builder', 'done', 3, 1000, 1100, 2000, 42, 1900, 7, null);
  // "b": running child of a.
  ins.run('b', 'Beta', '', 'researcher', 'running', 1, 1500, 1600, null, 7, 1650, null, null);
  // "c": archived card (should still produce a card view, not be dropped).
  ins.run('c', 'Gamma', 'archived body', null, 'archived', 0, 500, null, null, null, null, null, null);

  const run = db.prepare(
    `INSERT INTO task_runs (id, task_id, profile, status, outcome, started_at, ended_at, summary, error, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  run.run(1, 'a', 'builder', 'completed', 'completed', 1100, 1200, 'first ok', null, null);
  run.run(2, 'a', 'builder', 'failed', 'gave_up', 1500, 1600, null, 'boom', null);
  run.run(3, 'b', 'researcher', 'running', null, 1600, null, null, null, '{"worker_session_id":"s-1"}');

  db.prepare(`INSERT INTO task_links (parent_id, child_id) VALUES (?, ?)`).run('a', 'b');

  const comment = db.prepare(
    `INSERT INTO task_comments (id, task_id, author, body, created_at) VALUES (?, ?, ?, ?, ?)`,
  );
  comment.run(1, 'a', 'reviewer', 'approved', 1900);
  comment.run(2, 'b', 'lead', 'please finish', 1700);

  const ev = db.prepare(
    `INSERT INTO task_events (id, task_id, run_id, kind, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  ev.run(1, 'a', null, 'created', JSON.stringify({ status: 'todo' }), 1000);
  ev.run(2, 'a', null, 'promoted', null, 1050);
  ev.run(3, 'a', 1, 'claimed', JSON.stringify({ run_id: 1 }), 1100);
  ev.run(4, 'a', 1, 'heartbeat', null, 1150);
  ev.run(5, 'a', null, 'review_requested', JSON.stringify({ summary: 'done' }), 1800);
  ev.run(6, 'a', null, 'completed', null, 2000);
  ev.run(7, 'b', 3, 'created', JSON.stringify({ status: 'todo' }), 1500);

  db.close();
  return { home, dbPath };
}

let fixture: Fixture | null = null;

afterEach(() => {
  if (fixture) rmSync(fixture.home, { recursive: true, force: true });
  fixture = null;
});

describe('statusAfterEvent', () => {
  it('maps known status-bearing kinds, and null for the rest', () => {
    expect(statusAfterEvent('created', JSON.stringify({ status: 'ready' }))).toBe('ready');
    expect(statusAfterEvent('created', null)).toBe('todo'); // fallback
    expect(statusAfterEvent('claimed', null)).toBe('running');
    expect(statusAfterEvent('promoted', null)).toBe('ready');
    expect(statusAfterEvent('blocked', null)).toBe('blocked');
    expect(statusAfterEvent('review_requested', null)).toBe('review');
    expect(statusAfterEvent('completed', null)).toBe('done');
    expect(statusAfterEvent('archived', null)).toBe('archived');
    // No reliable status signal → skipped by the fold.
    expect(statusAfterEvent('heartbeat', null)).toBeNull();
    expect(statusAfterEvent('spawned', null)).toBeNull();
    expect(statusAfterEvent('commented', null)).toBeNull();
  });

  it('honors payload.status for changes_requested', () => {
    expect(statusAfterEvent('changes_requested', JSON.stringify({ status: 'ready' }))).toBe('ready');
  });
});

describe('deriveTransitions', () => {
  it('folds chronological events into from→to transitions, deduping repeats', () => {
    const events = [
      { id: 1, task_id: 'a', kind: 'created', payload: JSON.stringify({ status: 'todo' }), created_at: 1000, run_id: null },
      { id: 2, task_id: 'a', kind: 'promoted', payload: null, created_at: 1050, run_id: null },
      { id: 3, task_id: 'a', kind: 'claimed', payload: null, created_at: 1100, run_id: 1 },
      { id: 4, task_id: 'a', kind: 'heartbeat', payload: null, created_at: 1150, run_id: 1 }, // skipped
      { id: 5, task_id: 'a', kind: 'review_requested', payload: null, created_at: 1800, run_id: null },
      { id: 6, task_id: 'a', kind: 'completed', payload: null, created_at: 2000, run_id: null },
    ];
    expect(deriveTransitions(events)).toEqual([
      { from: null, to: 'todo', at: 1000 },
      { from: 'todo', to: 'ready', at: 1050 },
      { from: 'ready', to: 'running', at: 1100 },
      { from: 'running', to: 'review', at: 1800 },
      { from: 'review', to: 'done', at: 2000 },
    ]);
  });

  it('dedups consecutive same-status transitions (re-review round-trip compacted)', () => {
    const seq = (kind: string, at: number) => ({ id: at, task_id: 'x', kind, payload: null, created_at: at, run_id: null });
    // created → repeated claimed (same running) → review
    const events = [seq('created', 1), seq('claimed', 2), seq('claimed', 3), seq('review_requested', 4)];
    expect(deriveTransitions(events)).toEqual([
      { from: null, to: 'todo', at: 1 },
      { from: 'todo', to: 'running', at: 2 },
      { from: 'running', to: 'review', at: 4 },
    ]);
  });
});

describe('readCardDetail', () => {
  it('returns the full typed detail for a card', () => {
    fixture = makeBoard();
    const db = openReadonly(fixture!.dbPath);
    const d = readCardDetail(db, 'a', { staleMs: 90_000, now: 3000 })!;

    expect(d.card.title).toBe('Alpha');
    expect(d.body).toBe('Body of A');
    expect(d.card.status).toBe('done');
    expect(d.card.runCount).toBe(2);
    expect(d.card.lastOutcome).toBe('gave_up'); // most recent run
    expect(d.card.childIds).toEqual(['b']);
    // Board flash field: most recent status move from the same fold.
    expect(d.card.lastTransition).toEqual({ to: 'done', at: 2000 });

    // Runs filtered + ordered by id.
    expect(d.runs.map((r) => r.id)).toEqual([1, 2]);

    // Comments filtered to this card.
    expect(d.comments.map((c) => c.id)).toEqual([1]);

    // Trail folded from this card's events only.
    expect(d.transitions).toEqual([
      { from: null, to: 'todo', at: 1000 },
      { from: 'todo', to: 'ready', at: 1050 },
      { from: 'ready', to: 'running', at: 1100 },
      { from: 'running', to: 'review', at: 1800 },
      { from: 'review', to: 'done', at: 2000 },
    ]);

    db.close();
  });

  it('excludes other cards data and computes parent links', () => {
    fixture = makeBoard();
    const db = openReadonly(fixture!.dbPath);
    const d = readCardDetail(db, 'b', { staleMs: 90_000, now: 3000 })!;
    expect(d.runs.map((r) => r.id)).toEqual([3]);
    expect(d.comments.map((c) => c.id)).toEqual([2]);
    expect(d.card.parentIds).toEqual(['a']);
    // running card carries liveness + elapsed.
    expect(d.card.liveness).toBe('active');
    db.close();
  });

  it('sets lastTransition from the latest status move (or null when none)', () => {
    fixture = makeBoard();
    const db = openReadonly(fixture!.dbPath);
    // 'b' has only a `created` event → its last move is → todo at creation.
    expect(readCardDetail(db, 'b', { staleMs: 90_000, now: 3000 })!.card.lastTransition)
      .toEqual({ to: 'todo', at: 1500 });
    // 'c' has no events at all → no last transition to annotate.
    expect(readCardDetail(db, 'c', { staleMs: 90_000, now: 3000 })!.card.lastTransition)
      .toBeNull();
    db.close();
  });

  it('returns detail for an archived card (kept in the drawer)', () => {
    fixture = makeBoard();
    const db = openReadonly(fixture!.dbPath);
    const d = readCardDetail(db, 'c', { staleMs: 90_000, now: 3000 })!;
    expect(d.card.status).toBe('archived');
    expect(d.body).toBe('archived body');
    db.close();
  });

  it('returns null for an unknown task id', () => {
    fixture = makeBoard();
    const db = openReadonly(fixture!.dbPath);
    expect(readCardDetail(db, 'does-not-exist', { staleMs: 90_000, now: 3000 })).toBeNull();
    db.close();
  });
});
