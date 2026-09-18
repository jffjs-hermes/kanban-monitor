// Unit tests: BoardRuntime (spec §1.1 — wires poller+differ+sseHub per board,
// board switch re-targets the runtime & broadcasts a `board` event; §3; §7).
// Runs against a fake 2-board temp dir using the board-discover layout.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Database } from 'bun:sqlite';

import { createBoardRuntime } from './runtime';
import type { BoardEvent } from './sse-hub';

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

let home: string;
let envBackup: { HERMES_HOME?: string; STALE_WORKER_MS?: string };

beforeEach(() => {
  vi.useFakeTimers();
  home = resolve(mkdtempSync('rt-'));

  const boardsRoot = join(home, 'kanban', 'boards');
  mkdirSync(boardsRoot, { recursive: true });

  envBackup = { HERMES_HOME: process.env.HERMES_HOME, STALE_WORKER_MS: process.env.STALE_WORKER_MS };
  process.env.HERMES_HOME = home;
  process.env.STALE_WORKER_MS = '90000';
});

afterEach(() => {
  vi.useRealTimers();
  if (envBackup.HERMES_HOME === undefined) delete process.env.HERMES_HOME;
  else process.env.HERMES_HOME = envBackup.HERMES_HOME;
  if (envBackup.STALE_WORKER_MS === undefined) delete process.env.STALE_WORKER_MS;
  else process.env.STALE_WORKER_MS = envBackup.STALE_WORKER_MS;
  rmSync(home, { recursive: true, force: true });
});

function createBoard(dbPath: string, titles: string[]) {
  mkdirSync(join(dbPath, '..'), { recursive: true });
  const db = new Database(dbPath);
  db.exec(SCHEMA);
  const ins = db.prepare(
    `INSERT INTO tasks (id, title, body, assignee, status, priority, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  titles.forEach((t, i) => ins.run('c' + i, t, '', null, 'todo', 0, 1_000_000_000));
  db.close();
}

function addTask(dbPath: string, id: string, title: string) {
  const db = new Database(dbPath);
  db.prepare(
    `INSERT INTO tasks (id, title, body, assignee, status, priority, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, title, '', null, 'todo', 0, 1_000_000_000);
  db.close();
}

describe('BoardRuntime', () => {
  it('select primes a snapshot and reports staleMs from the environment', () => {
    createBoard(join(home, 'kanban.db'), ['one', 'two']);
    const rt = createBoardRuntime();
    const snap = rt.select('default');
    expect(snap?.slug).toBe('default');
    expect(snap?.cards.map((c) => c.title)).toEqual(['one', 'two']);
    expect(rt.snapshotOf('default')?.slug).toBe('default');
    expect(rt.staleMs()).toBe(90_000);
  });

  it('fans deltas to subscribers after a board change', () => {
    createBoard(join(home, 'kanban.db'), ['one']);
    const rt = createBoardRuntime();
    rt.select('default');

    const events: string[] = [];
    const un = rt.subscribe('default', (evt) => {
      const s = evt.scope;
      events.push(s.kind + (s.kind === 'cards' ? ':' + (s as { upserts?: unknown[] }).upserts?.length : ''));
    });

    addTask(join(home, 'kanban.db'), 'c9', 'nine');
    vi.advanceTimersByTime(1000);

    const ids = events.join(',');
    expect(ids).toContain('cards:1');
    expect(ids).toContain('card');
    expect(ids).toContain('summary'); // todo count changed

    // snapshot cache refreshed after the change
    expect(rt.snapshotOf('default')?.cards.map((c) => c.id)).toContain('c9');
    un();
  });

  it('board switch stops the old poller, starts the new one, and broadcasts a board event', () => {
    createBoard(join(home, 'kanban.db'), ['a']);
    createBoard(join(home, 'kanban', 'boards', 'alpha', 'kanban.db'), ['alpha1']);
    createBoard(join(home, 'kanban', 'boards', 'beta', 'kanban.db'), ['beta1']);

    const rt = createBoardRuntime();
    rt.select('default');

    const boardEvents: BoardEvent[] = [];
    const defaultDeltas: string[] = [];
    const unAll = rt.subscribeAll((e) => boardEvents.push(e));
    const unDefault = rt.subscribe('default', (e) => defaultDeltas.push(e.scope.kind));

    // First switch away from default → broadcasts a `board` event.
    const alphaSnap = rt.select('alpha');
    expect(alphaSnap?.cards.map((c) => c.title)).toEqual(['alpha1']);
    expect(boardEvents).toEqual([{ type: 'board', slug: 'alpha', at: expect.any(Number) }]);

    // Old board is no longer polled: mutating `default` produces no deltas.
    addTask(join(home, 'kanban.db'), 'z', 'zulu');
    vi.advanceTimersByTime(1000);
    expect(defaultDeltas).toEqual([]);

    const betaSnap = rt.select('beta');
    expect(betaSnap?.cards.map((c) => c.title)).toEqual(['beta1']);
    expect(boardEvents.map((e) => e.slug)).toEqual(['alpha', 'beta']);

    unAll();
    unDefault();
  });

  it('tolerates a missing board DB (returns null) and recovers when it appears', () => {
    const rt = createBoardRuntime();
    expect(rt.select('nope')).toBeNull();
    expect(rt.snapshotOf('nope')).toBeNull();

    // Board file appears later — the poller picks it up and the snapshot recovers.
    createBoard(join(home, 'kanban', 'boards', 'nope', 'kanban.db'), ['late']);
    vi.advanceTimersByTime(2000);
    expect(rt.snapshotOf('nope')?.cards.map((c) => c.title)).toEqual(['late']);
  });

  it('keeps selecting the same board idempotent (does not broadcast a board event)', () => {
    createBoard(join(home, 'kanban.db'), ['x']);
    const rt = createBoardRuntime();
    rt.select('default');
    const boardEvents: BoardEvent[] = [];
    rt.subscribeAll((e) => boardEvents.push(e));
    const again = rt.select('default');
    expect(again?.cards.map((c) => c.title)).toEqual(['x']);
    expect(boardEvents).toEqual([]);
  });
});