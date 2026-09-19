// Unit tests: GET /api/agent/board/[slug]/changes (spec §5; M-1 #2).
// Drives the real route handler against a fake board DB using the
// board-discover layout, exercising since=0→reset, since=rev→deltas,
// idempotence, empty board, unknown slug 404, and buffer-miss→reset.
//
// The route calls the shared `boardRuntime` singleton. To keep each test
// isolated the tests use distinct named board slugs; the singleton resolves a
// board DB path from the current HERMES_HOME at select-time, so a fresh temp
// dir per test gives each slug its own revision/ring state.

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

/** Board DB path for a per-test named slug, using the board-discover layout. */
function boardPath(slug: string): string {
  return join(home, 'kanban', 'boards', slug, 'kanban.db');
}

beforeEach(() => {
  vi.useFakeTimers();
  home = resolve(mkdtempSync('chg-'));
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

/** Derive a unique board slug so the shared singleton never reuses state. */
function freshSlug(): string {
  slugSeq += 1;
  return `b${slugSeq}`;
}

function createBoard(slug: string, rows: { id: string; title: string; assignee?: string | null; status?: string }[]) {
  const dbPath = boardPath(slug);
  mkdirSync(join(dbPath, '..'), { recursive: true });
  const db = new Database(dbPath);
  db.exec(SCHEMA);
  const ins = db.prepare(
    `INSERT INTO tasks (id, title, body, assignee, status, priority, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  rows.forEach((r) => ins.run(r.id, r.title, '', r.assignee ?? null, r.status ?? 'todo', 0, 1_000_000_000));
  db.close();
}

function addTask(slug: string, id: string, title: string) {
  const db = new Database(boardPath(slug));
  db.prepare(
    `INSERT INTO tasks (id, title, body, assignee, status, priority, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, title, '', null, 'todo', 0, 1_000_000_000);
  db.close();
}

async function callGET(slug: string, since?: string | number): Promise<Response> {
  const qs = since === undefined ? '' : `?since=${since}`;
  const url = new URL(`http://test/api/agent/board/${slug}/changes${qs}`);
  return GET({ params: { slug }, url } as never);
}

describe('GET /api/agent/board/[slug]/changes', () => {
  it('since=0 → full snapshot reset with all cards, no dups', async () => {
    const slug = freshSlug();
    createBoard(slug, [
      { id: 'a', title: 'alpha' },
      { id: 'b', title: 'beta' },
    ]);
    const res = await callGET(slug, 0);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.revision).toBeGreaterThan(0);
    expect(body.changes).toEqual([
      { kind: 'reset', cards: [
        expect.objectContaining({ id: 'a', title: 'alpha' }),
        expect.objectContaining({ id: 'b', title: 'beta' }),
      ] },
    ]);
    const cardIds = body.changes[0].cards.map((c: { id: string }) => c.id);
    expect(new Set(cardIds).size).toBe(cardIds.length); // no dups
  });

  it('omitted since → snapshot init (same as since=0)', async () => {
    const slug = freshSlug();
    createBoard(slug, [{ id: 'a', title: 'alpha' }]);
    const body = await (await callGET(slug)).json();
    expect(body.changes).toHaveLength(1);
    expect(body.changes[0].kind).toBe('reset');
  });

  it('since=prev → deltas only and revision+1', async () => {
    const slug = freshSlug();
    createBoard(slug, [{ id: 'a', title: 'alpha' }]);
    const first = await (await callGET(slug, 0)).json();
    const prevRev = first.revision as number;

    addTask(slug, 'c1', 'one more');
    vi.advanceTimersByTime(1000);

    const res = await callGET(slug, prevRev);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.revision).toBe(prevRev + 1); // monotonic +1
    expect(body.changes.some((c: { kind: string }) => c.kind === 'cards')).toBe(true);
    const cardsScope = body.changes.find((c: { kind: string }) => c.kind === 'cards');
    expect(cardsScope.upserts.map((c: { id: string }) => c.id)).toContain('c1');
    expect(body.changes.some((c: { kind: string }) => c.kind === 'reset')).toBe(false);
  });

  it('idempotence: same since → identical batch', async () => {
    const slug = freshSlug();
    createBoard(slug, [{ id: 'a', title: 'alpha' }]);
    const first = await (await callGET(slug, 0)).json();
    const prevRev = first.revision as number;

    addTask(slug, 'c1', 'one more');
    vi.advanceTimersByTime(1000);

    const r1 = await (await callGET(slug, prevRev)).json();
    const r2 = await (await callGET(slug, prevRev)).json();
    expect(r2).toEqual(r1);
  });

  it('no-change poll → 200 with empty changes and unchanged revision', async () => {
    const slug = freshSlug();
    createBoard(slug, [{ id: 'a', title: 'alpha' }]);
    const first = await (await callGET(slug, 0)).json();
    const rev = first.revision as number;

    vi.advanceTimersByTime(4000); // idle — nothing changes

    const res = await callGET(slug, rev);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.revision).toBe(rev);
    expect(body.changes).toEqual([]);
  });

  it('unknown slug → 404', async () => {
    const res = await callGET('does-not-exist', 0);
    expect(res.status).toBe(404);
  });

  it('buffer miss (since far behind evicted ring) → reset full snapshot', async () => {
    const slug = freshSlug();
    createBoard(slug, [{ id: 'a', title: 'alpha' }]);
    await callGET(slug, 0); // prime snapshot at revision ≥ 1

    // Many changes push past the default ring cap (256) → eviction.
    for (let i = 0; i < 300; i++) {
      addTask(slug, 'ev' + i, 'ev' + i);
      vi.advanceTimersByTime(1000);
    }

    // A cursor at the very beginning is far behind the evicted floor → reset.
    const body = await (await callGET(slug, 1)).json();
    expect(body.changes).toHaveLength(1);
    expect(body.changes[0].kind).toBe('reset');
    expect(body.changes[0].cards.length).toBe(301); // all cards
  });

  it('empty board → empty reset cards', async () => {
    const slug = freshSlug();
    createBoard(slug, []);
    const res = await callGET(slug, 0);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.revision).toBeGreaterThanOrEqual(0);
    expect(body.changes).toEqual([{ kind: 'reset', cards: [] }]);
  });
});
