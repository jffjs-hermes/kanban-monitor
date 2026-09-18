// Unit tests: poller loop (spec §1.2, §3 `createPoller`, §7).
// Drives snapshot → diff → emit cycles against a real fixture board DB with
// fake timers, verifying the immediate first tick, change propagation, the
// idle no-op, read-error reset, and stop().

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Database } from 'bun:sqlite';

import { createPoller, type Poller, type PollerDelta } from './poller';
import { openReadonly } from './data-access';

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

let tmp: string | null = null;
afterEach(() => {
  vi.useRealTimers();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

function makeBoard(withCards: number): Database {
  tmp = resolve(mkdtempSync('poller-'));
  const w = new Database(join(tmp!, 'kanban.db'));
  w.exec(SCHEMA);
  const insert = w.prepare(
    `INSERT INTO tasks (id, title, body, assignee, status, priority, created_at,
       started_at, completed_at, worker_pid, last_heartbeat_at, current_run_id, block_kind)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (let i = 0; i < withCards; i++) {
    insert.run('t' + i, 'Task ' + i, '', null, 'todo', 0, 1_000_000_000, null, null, null, null, null, null);
  }
  w.close();
  return openReadonly(join(tmp!, 'kanban.db'));
}

function kinds(deltas: PollerDelta[]): string[] {
  return deltas.map((d) => d.kind);
}

describe('createPoller', () => {
  it('emits an immediate reset on the first tick, then propagates a change', () => {
    vi.useFakeTimers();
    const db = makeBoard(12);
    const deltas: PollerDelta[] = [];
    const poller: Poller = createPoller(() => db, 1000);
    poller.onDelta((d) => deltas.push(d));
    poller.start();

    // First tick: prev === null → reset.
    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toEqual({ kind: 'reset', slug: 'default' });

    // Insert a 13th card through a sibling writable handle.
    const w = new Database(join(tmp!, 'kanban.db'));
    w.prepare(
      `INSERT INTO tasks (id, title, body, assignee, status, priority, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('t12', 'Task 12', '', null, 'todo', 0, 1_000_000_000);
    w.close();

    deltas.length = 0;
    vi.advanceTimersByTime(1000);

    // 1/13 ≈ 7.7% changed → scoped deltas: summary (todo count) + cards + card.
    expect(deltas.length).toBeGreaterThan(0);
    const kindsNow = kinds(deltas);
    expect(kindsNow).toContain('cards');
    expect(kindsNow).toContain('card');
    const cs = deltas.find((d) => d.kind === 'cards') as Extract<PollerDelta, { kind: 'cards' }>;
    expect(cs.upserts.map((c) => c.id)).toEqual(['t12']);
    poller.stop();
    db.close();
  });

  it('emits nothing on ticks where the board is unchanged', () => {
    vi.useFakeTimers();
    const db = makeBoard(12);
    const deltas: PollerDelta[] = [];
    const poller: Poller = createPoller(() => db);
    poller.onDelta((d) => deltas.push(d));
    poller.start();

    deltas.length = 0; // clear the initial reset
    vi.advanceTimersByTime(5_000);
    expect(deltas).toEqual([]);

    poller.stop();
    db.close();
  });

  it('stop() halts further ticks', () => {
    vi.useFakeTimers();
    const db = makeBoard(12);
    const deltas: PollerDelta[] = [];
    const poller: Poller = createPoller(() => db);
    poller.onDelta((d) => deltas.push(d));
    poller.start();
    deltas.length = 0;

    poller.stop();
    vi.advanceTimersByTime(4_000);
    expect(deltas).toEqual([]);

    db.close();
  });

  it('holds state (no emission) when the db handle is unavailable', () => {
    vi.useFakeTimers();
    const deltas: PollerDelta[] = [];
    const poller: Poller = createPoller(() => null);
    poller.onDelta((d) => deltas.push(d));
    poller.start();
    vi.advanceTimersByTime(4_000);
    expect(deltas).toEqual([]);
    poller.stop();
  });

  it('emits a reset after a read error and keeps ticking', () => {
    vi.useFakeTimers();
    const db = makeBoard(12);
    const deltas: PollerDelta[] = [];
    const poller: Poller = createPoller(() => db);
    poller.onDelta((d) => deltas.push(d));
    poller.start();
    deltas.length = 0;

    db.close(); // force readSnapshot to throw next tick
    vi.advanceTimersByTime(1000);
    expect(deltas).toContainEqual({ kind: 'reset', slug: 'default' });

    poller.stop();
  });
});