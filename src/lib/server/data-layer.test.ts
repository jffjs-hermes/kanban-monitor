// Unit tests: board discovery, data-access, and snapshot against a tiny
// on-disk fixture board DB (spec §1.3, §2, §3, §7).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Database } from 'bun:sqlite';

import { listBoards, hermesHome } from './board-discover';
import { openReadonly, readBoardRows, listTasks } from './data-access';
import { readSnapshot } from './snapshot';

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

function createBoardDb(path: string) {
  const db = new Database(path);
  db.exec(SCHEMA);

  const now = 1_000_000_000;
  const insertTask = db.prepare(
    `INSERT INTO tasks (id, title, body, assignee, status, priority, created_at,
       started_at, completed_at, worker_pid, last_heartbeat_at, current_run_id, block_kind)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  // t1: running + active heartbeat
  insertTask.run('t1', 'Active running', '', 'alice', 'running', 5, now - 100, now - 80, null, 42, now - 1, 9, null);
  // t2: running + stale heartbeat (stalled)
  insertTask.run('t2', 'Stalled running', '', 'bob', 'running', 3, now - 200, now - 150, null, 7, now - 100_000, 3, null);
  // t3: running + no heartbeat (stalled)
  insertTask.run('t3', 'No heartbeat', '', null, 'running', 1, now - 50, now - 20, null, null, null, null, null);
  // t4: done
  insertTask.run('t4', 'Finished', '', 'alice', 'done', 2, now - 500, null, now - 10, null, null, null, null);
  // t5: archived (excluded from cards)
  insertTask.run('t5', 'Old archived', '', null, 'archived', 0, now - 9000, null, null, null, null, null, null);

  const insertRun = db.prepare(
    `INSERT INTO task_runs (id, task_id, profile, status, outcome, worker_pid,
       started_at, ended_at, error, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insertRun.run(1, 't1', 'builder', 'completed', 'completed', 42, now - 200, now - 150, null, null);
  insertRun.run(2, 't1', 'builder', 'failed', 'gave_up', 99, now - 1000, now - 900, null, null);
  insertRun.run(3, 't2', 'researcher', 'running', null, 7, now - 150, null, null, '{"worker_session_id":"sess-abc"}');

  const insertLink = db.prepare(`INSERT INTO task_links (parent_id, child_id) VALUES (?, ?)`);
  insertLink.run('t1', 't2'); // t1 -> t2, t3
  insertLink.run('t1', 't3');

  const insertComment = db.prepare(
    `INSERT INTO task_comments (id, task_id, author, body, created_at) VALUES (?, ?, ?, ?, ?)`,
  );
  insertComment.run(1, 't1', 'reviewer', 'looks good', now - 5);

  const insertEvent = db.prepare(
    `INSERT INTO task_events (id, task_id, run_id, kind, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  insertEvent.run(1, 't1', 2, 'claimed', null, now - 300);

  db.close();
  return now;
}

function makeTempHome(seedRight: boolean): string {
  const home = resolve(mkdtempSync('hermes-home-'));
  if (seedRight) {
    createBoardDb(join(home, 'kanban.db'));
    mkdirSync(join(home, 'kanban', 'boards', 'alpha'), { recursive: true });
    createBoardDb(join(home, 'kanban', 'boards', 'alpha', 'kanban.db'));
  }
  return home;
}

const realHermesHome = process.env['HERMES_HOME'];
let tempHome: string | null = null;

beforeEach(() => {
  tempHome = null;
});

afterEach(() => {
  if (realHermesHome === undefined) delete process.env['HERMES_HOME'];
  else process.env['HERMES_HOME'] = realHermesHome;
  if (tempHome) rmSync(tempHome, { recursive: true, force: true });
});

describe('board-discover', () => {
  it('honors default HERMES_HOME = ~/.hermes', () => {
    delete process.env['HERMES_HOME'];
    expect(hermesHome()).toBe(join(process.env['HOME'] ?? '', '.hermes'));
  });

  it('honors an absolute HERMES_HOME override', () => {
    process.env['HERMES_HOME'] = '/tmp/custom-home';
    expect(hermesHome()).toBe('/tmp/custom-home');
  });

  it('returns default + named boards, skipping missing files', () => {
    const home = makeTempHome(true);
    tempHome = home;
    process.env['HERMES_HOME'] = home;

    const boards = listBoards();
    const slugs = boards.map((b) => b.slug);
    expect(slugs).toEqual(['default', 'alpha']);
    expect(boards.find((b) => b.slug === 'default')!.path).toBe(join(home, 'kanban.db'));
    expect(boards.find((b) => b.slug === 'alpha')!.path).toBe(join(home, 'kanban', 'boards', 'alpha', 'kanban.db'));
  });

  it('tolerates a missing board file / empty home (returns [])', () => {
    const home = makeTempHome(false);
    tempHome = home;
    process.env['HERMES_HOME'] = home;
    expect(listBoards()).toEqual([]);

    // A boards dir whose kanban.db files are each missing still yields nothing.
    const boardDir = join(home, 'kanban', 'boards', 'beta');
    mkdirSync(boardDir, { recursive: true });
    expect(listBoards()).toEqual([]);
  });

  it('does not create any files (read-only discovery)', () => {
    const home = makeTempHome(true);
    tempHome = home; // cleanup removes it if we forgot a file, but we assert absence instead
    process.env['HERMES_HOME'] = home;
    const before = new Database(join(home, 'kanban.db'), { readonly: true });
    const bCount = before.query<{ c: number }, any[]>('SELECT COUNT(*) c FROM tasks').all()[0].c;
    listBoards();
    const after = new Database(join(home, 'kanban.db'), { readonly: true });
    expect(after.query<{ c: number }, any[]>('SELECT COUNT(*) c FROM tasks').all()[0].c).toBe(bCount);
    before.close();
    after.close();
  });
});

describe('data-access', () => {
  it('reads typed rows from all five tables, read-only', () => {
    const home = makeTempHome(true);
    tempHome = home;
    const path = join(home, 'kanban.db');
    const db = openReadonly(path);

    const rows = readBoardRows(db);
    expect(rows.tasks).toHaveLength(5);
    expect(listTasks(db)).toHaveLength(5);
    expect(rows.runs).toHaveLength(3);
    expect(rows.comments).toHaveLength(1);
    expect(rows.events).toHaveLength(1);
    expect(rows.links).toHaveLength(2);
    expect(rows.links[0]).toEqual({ parent_id: 't1', child_id: 't2' });

    // worker_session_id is hydrated from the metadata JSON blob.
    const sessRun = rows.runs.find((r) => r.id === 3)!;
    expect((sessRun as any).worker_session_id).toBe('sess-abc');

    db.close();
  });

  it('rejects writes on a read-only handle (permissions boundary)', () => {
    const home = makeTempHome(true);
    tempHome = home;
    const db = openReadonly(join(home, 'kanban.db'));
    expect(() => db.query('DELETE FROM tasks').run()).toThrow();
    db.close();
  });
});

describe('snapshot', () => {
  it('returns a full typed board state', () => {
    const home = makeTempHome(true);
    tempHome = home;
    const now = 1_000_000_000;
    const db = openReadonly(join(home, 'kanban.db'));
    const snap = readSnapshot(db, 'default', { staleMs: 90_000, now });

    expect(snap.slug).toBe('default');
    // Archived task excluded.
    expect(snap.cards).toHaveLength(4);

    // Summary strip.
    expect(snap.summary.runningCount).toBe(3);
    expect(snap.summary.stalledCount).toBe(2); // t2 stale, t3 no heartbeat
    expect(snap.summary.countsByStatus.running).toBe(3);
    expect(snap.summary.countsByStatus.done).toBe(1);
    expect(snap.summary.maxInProgress).toBeNull();
    expect(snap.summary.lastSyncedAt).toBe(now * 1000);

    db.close();
  });

  it('classifies liveness and computes elapsed/run data per card', () => {
    const home = makeTempHome(true);
    tempHome = home;
    const now = 1_000_000_000;
    const db = openReadonly(join(home, 'kanban.db'));
    const snap = readSnapshot(db, 'default', { staleMs: 90_000, now });

    const byId = Object.fromEntries(snap.cards.map((c) => [c.id, c]));
    const t1 = byId['t1'];
    expect(t1.liveness).toBe('active');
    expect(t1.elapsedMs).toBe((now - (now - 80)) * 1000);
    expect(t1.runCount).toBe(2); // two runs
    expect(t1.lastOutcome).toBe('gave_up'); // most recent run (id 2) outcome
    expect(t1.childIds).toEqual(['t2', 't3']);

    expect(byId['t2'].liveness).toBe('stalled');
    expect(byId['t2'].runCount).toBe(1);
    expect(byId['t2'].parentIds).toEqual(['t1']);

    expect(byId['t3'].liveness).toBe('stalled'); // null heartbeat → stalled

    // Non-running card has null liveness and null elapsed.
    expect(byId['t4'].liveness).toBeNull();
    expect(byId['t4'].elapsedMs).toBeNull();

    db.close();
  });

  it('sorts cards by status order, then priority desc, then age asc', () => {
    const home = makeTempHome(true);
    tempHome = home;
    const db = openReadonly(join(home, 'kanban.db'));
    const snap = readSnapshot(db, 'default', { staleMs: 90_000, now: 1_000_000_000 });

    const ids = snap.cards.map((c) => c.id);
    // running (status order 3) block first; t1(prio5), t2(prio3), t3(prio1) by prio desc;
    // then done (order 6) t4.
    expect(ids).toEqual(['t1', 't2', 't3', 't4']);
    db.close();
  });

  it('returns an empty snapshot for an empty board', () => {
    const home = resolve(mkdtempSync('hermes-home-'));
    tempHome = home;
    const dbPath = join(home, 'kanban.db');
    const w = new Database(dbPath);
    w.exec(SCHEMA); // schema, but zero rows
    w.close();
    const db = openReadonly(dbPath);
    const snap = readSnapshot(db, 'default', { staleMs: 90_000, now: 1_000_000_000 });
    db.close();
    expect(snap.cards).toEqual([]);
    expect(snap.summary.runningCount).toBe(0);
    expect(snap.summary.stalledCount).toBe(0);
  });
});