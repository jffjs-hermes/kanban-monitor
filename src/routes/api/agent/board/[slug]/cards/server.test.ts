// Unit tests: GET /api/agent/board/[slug]/cards (spec §5; M-1 #2).
// Verifies the filtered query over the current snapshot against the shared
// `boardRuntime` singleton. Distinct named slugs per test keep the singleton's
// per-slug state isolated (a fresh HERMES_HOME temp dir per test).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Database } from 'bun:sqlite';
import { GET } from './+server';

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
let slugSeq = 0;

beforeEach(() => {
  vi.useFakeTimers();
  home = resolve(mkdtempSync('cards-'));
  mkdirSync(join(home, 'kanban', 'boards'), { recursive: true });
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

function freshSlug(): string {
  slugSeq += 1;
  return `cb${slugSeq}`;
}

function boardPath(slug: string): string {
  return join(home, 'kanban', 'boards', slug, 'kanban.db');
}

function createBoard(slug: string) {
  const dbPath = boardPath(slug);
  mkdirSync(join(dbPath, '..'), { recursive: true });
  const db = new Database(dbPath);
  db.exec(SCHEMA);
  const ins = db.prepare(
    `INSERT INTO tasks (id, title, body, assignee, status, priority, created_at, started_at, last_heartbeat_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const now = Date.now() / 1000;
  // bob: one todo (non-running), one running+stalled, one running+active.
  ins.run('b1', 'b-todo', '', 'bob', 'todo', 0, 1_000_000_000, null, null);
  ins.run('b2', 'b-stalled', '', 'bob', 'running', 0, 1_000_000_000, now - 500, now - 200_000); // stale
  ins.run('b3', 'b-active', '', 'bob', 'running', 0, 1_000_000_000, now - 500, now - 1); // recent
  // alice: one running+active.
  ins.run('a1', 'a-active', '', 'alice', 'running', 0, 1_000_000_000, now - 500, now - 2);
  // unassigned: one todo.
  ins.run('u1', 'u-todo', '', null, 'todo', 0, 1_000_000_000, null, null);
  db.close();
}

async function callGET(slug: string, qs: string): Promise<Response> {
  const url = new URL(`http://test/api/agent/board/${slug}/cards${qs}`);
  return GET({ params: { slug }, url } as never);
}

const ids = (arr: unknown[]) => (arr as { id: string }[]).map((c) => c.id);

describe('GET /api/agent/board/[slug]/cards', () => {
  it('no params → all cards in snapshot', async () => {
    const slug = freshSlug();
    createBoard(slug);
    const res = await callGET(slug, '');
    expect(res.status).toBe(200);
    const cards = await res.json();
    expect(ids(cards).sort()).toEqual(['a1', 'b1', 'b2', 'b3', 'u1']);
  });

  it('assignee=X → only that assignee’s cards', async () => {
    const slug = freshSlug();
    createBoard(slug);
    const cards = await (await callGET(slug, '?assignee=bob')).json();
    expect(ids(cards).sort()).toEqual(['b1', 'b2', 'b3']);
  });

  it('assignee with no matches → empty array', async () => {
    const slug = freshSlug();
    createBoard(slug);
    const cards = await (await callGET(slug, '?assignee=nobody')).json();
    expect(cards).toEqual([]);
  });

  it('stalled=true → only stalled running cards', async () => {
    const slug = freshSlug();
    createBoard(slug);
    const cards = await (await callGET(slug, '?stalled=true')).json();
    expect(ids(cards)).toEqual(['b2']);
  });

  it('stalled=false → only active running cards (excludes non-running)', async () => {
    const slug = freshSlug();
    createBoard(slug);
    const cards = await (await callGET(slug, '?stalled=false')).json();
    expect(ids(cards).sort()).toEqual(['a1', 'b3']);
  });

  it('combines assignee + stalled (AND)', async () => {
    const slug = freshSlug();
    createBoard(slug);
    const stalled = await (await callGET(slug, '?assignee=bob&stalled=true')).json();
    expect(ids(stalled)).toEqual(['b2']);
    const active = await (await callGET(slug, '?assignee=bob&stalled=false')).json();
    expect(ids(active)).toEqual(['b3']);
    const aliceStalled = await (await callGET(slug, '?assignee=alice&stalled=true')).json();
    expect(aliceStalled).toEqual([]);
  });

  it('unknown slug → 404', async () => {
    const res = await callGET('does-not-exist', '');
    expect(res.status).toBe(404);
  });
});
