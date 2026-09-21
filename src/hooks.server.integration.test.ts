// Integration tests: AGENT_TOKEN gate over the *actual* agent REST routes
// through the SvelteKit request path (spec §6.1–6.3; M-1 #4).
//
// Unlike hooks.server.test.ts (which drives handle() with a mocked resolve
// returning a synthetic 200) and the per-route server.test.ts files (which call
// the GET handlers directly, bypassing the hook), these tests chain the real
// handle() gate to the real /api/agent/board/[slug]/changes and /cards route
// handlers through a router that mimics SvelteKit's resolve(event). That proves
// the gate and the endpoints work TOGETHER on the wire:
//   - valid Bearer HEADER succeeds and returns real endpoint data,
//   - ?token= query fallback succeeds and returns real endpoint data,
//   - missing / wrong credentials → uniform 401, and the route handler is never
//     reached,
//   - ordinary UI / REST endpoints stay accessible with no credentials even
//     when AGENT_TOKEN is set,
//   - default-open (AGENT_TOKEN unset) lets agent endpoints through,
//   - endpoint semantics (since=0 reset, since=rev deltas, filters, unknown
//     slug 404) are unchanged at the hook level.
//
// Route handlers and the shared runtime are token-unaware; the gate lives only
// in the hook. That means these tests need no per-route auth logic — they just
// compose the existing handle() with the existing GET handlers.

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Database } from 'bun:sqlite';
import { handle } from './hooks.server';
import { setAgentHostForTest, setAgentTokenForTest } from '$lib/server/agent-auth';
import { GET as changesGET } from './routes/api/agent/board/[slug]/changes/+server';
import { GET as cardsGET } from './routes/api/agent/board/[slug]/cards/+server';
import { GET as boardsGET } from './routes/api/boards.json/+server';
import type { RequestEvent } from '@sveltejs/kit';

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
  home = resolve(mkdtempSync('hookint-'));
  mkdirSync(join(home, 'kanban', 'boards'), { recursive: true });
  envBackup = { HERMES_HOME: process.env.HERMES_HOME, STALE_WORKER_MS: process.env.STALE_WORKER_MS };
  process.env.HERMES_HOME = home;
  process.env.STALE_WORKER_MS = '90000';
  setAgentTokenForTest(undefined);
  // Developer default: loopback bind, so the unset-token default-open tests in
  // this file exercise the intended loopback-open developer behaviour. The
  // non-loopback default-DENY scenarios override the host per-case.
  setAgentHostForTest('127.0.0.1');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  setAgentTokenForTest(undefined);
  setAgentHostForTest('0.0.0.0');
  vi.useRealTimers();
  if (envBackup.HERMES_HOME === undefined) delete process.env.HERMES_HOME;
  else process.env.HERMES_HOME = envBackup.HERMES_HOME;
  if (envBackup.STALE_WORKER_MS === undefined) delete process.env.STALE_WORKER_MS;
  else process.env.STALE_WORKER_MS = envBackup.STALE_WORKER_MS;
  rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** Derive a unique board slug so the shared runtime never reuses state. */
function freshSlug(): string {
  slugSeq += 1;
  return `ib${slugSeq}`;
}

function boardPath(slug: string): string {
  return join(home, 'kanban', 'boards', slug, 'kanban.db');
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

const SLUG_PARTIAL = '([^/]+)';

/**
 * A resolve(event) that mimics SvelteKit's router: it dispatches the real route
 * handlers by pathname, extracting [slug] into event.params. Every dispatched
 * handler call is recorded so tests can assert the route was (or was not)
 * reached behind the gate. Unknown/UI paths resolve to a 200 marker so the UI
 * surface is exercised without pulling in a page renderer.
 */
function makeResolve() {
  const calls: string[] = [];
  const resolve = async (event: RequestEvent) => {
    const u = event.url;
    const p = u.pathname;

    const changesMatch = new RegExp(`^/api/agent/board/${SLUG_PARTIAL}/changes$`).exec(p);
    if (changesMatch) {
      calls.push(p);
      const ev = { url: u, params: { slug: changesMatch[1] } } as unknown as RequestEvent;
      return changesGET(ev);
    }

    const cardsMatch = new RegExp(`^/api/agent/board/${SLUG_PARTIAL}/cards$`).exec(p);
    if (cardsMatch) {
      calls.push(p);
      const ev = { url: u, params: { slug: cardsMatch[1] } } as unknown as RequestEvent;
      return cardsGET(ev);
    }

    if (p === '/api/boards.json') {
      calls.push(p);
      return boardsGET();
    }

    // UI / anything else — never gated, resolves fine.
    calls.push(p);
    return new Response('ok', { status: 200 });
  };
  return { resolve, calls };
}

/** Drive handle() against a real, token-toggled request. */
async function callHandle(
  path: string,
  opts: { method?: string; headers?: Record<string, string>; token?: string | undefined } = {},
) {
  const { method = 'GET', headers = {}, token } = opts;
  setAgentTokenForTest(token ?? undefined);
  const { resolve, calls } = makeResolve();
  const url = new URL(`http://test${path}`);
  const event = {
    url,
    request: new Request(`http://test${path}`, { method, headers }),
  };
  const input = { event, resolve: resolve as never } as never;
  const res = await handle(input);
  return { res, calls };
}

describe('integration: agent REST routes through the AGENT_TOKEN gate', () => {
  it('loopback-open: /changes succeeds with no credentials when AGENT_TOKEN unset on a loopback bind', async () => {
    const slug = freshSlug();
    createBoard(slug, [{ id: 'a', title: 'alpha' }]);
    const { res, calls } = await callHandle(`/api/agent/board/${slug}/changes?since=0`);
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1); // route was reached
    const body = await res.json();
    expect(body.changes).toEqual([
      { kind: 'reset', cards: [expect.objectContaining({ id: 'a', title: 'alpha' })] },
    ]);
  });

  it('loopback-open: /cards succeeds with no credentials when AGENT_TOKEN unset on a loopback bind', async () => {
    const slug = freshSlug();
    createBoard(slug, [{ id: 'a', title: 'alpha' }, { id: 'b', title: 'beta' }]);
    const { res, calls } = await callHandle(`/api/agent/board/${slug}/cards`);
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    const ids = (await res.json()).map((c: { id: string }) => c.id).sort();
    expect(ids).toEqual(['a', 'b']);
  });

  it('valid Bearer header succeeds and returns real endpoint data', async () => {
    const slug = freshSlug();
    createBoard(slug, [{ id: 'x', title: 'xx' }]);
    const { res, calls } = await callHandle(`/api/agent/board/${slug}/changes?since=0`, {
      token: 'cfg',
      headers: { authorization: 'Bearer cfg' },
    });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    const body = await res.json();
    expect(body.changes[0].kind).toBe('reset');
    expect(body.revision).toBeGreaterThan(0);
  });

  it('valid ?token= fallback succeeds and returns real endpoint data', async () => {
    const slug = freshSlug();
    createBoard(slug, [{ id: 'y', title: 'yy' }]);
    const { res, calls } = await callHandle(`/api/agent/board/${slug}/cards?token=cfg`, { token: 'cfg' });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    const ids = (await res.json()).map((c: { id: string }) => c.id);
    expect(ids).toEqual(['y']);
  });

  it('missing token → uniform 401, route handler never reached', async () => {
    const slug = freshSlug();
    createBoard(slug, [{ id: 'z', title: 'zz' }]);
    const { res, calls } = await callHandle(`/api/agent/board/${slug}/changes?since=0`, { token: 'cfg' });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
    expect(await res.json()).toEqual({ error: 'unauthorized' });
    expect(calls).toHaveLength(0); // gate short-circuits before the route
  });

  it('wrong Bearer token → uniform 401, route handler never reached', async () => {
    const slug = freshSlug();
    createBoard(slug, [{ id: 'z', title: 'zz' }]);
    const { res, calls } = await callHandle(`/api/agent/board/${slug}/changes`, {
      token: 'cfg',
      headers: { authorization: 'Bearer not-the-token' },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
    expect(calls).toHaveLength(0);
  });

  it('wrong ?token= → uniform 401, route handler never reached', async () => {
    const slug = freshSlug();
    createBoard(slug, [{ id: 'z', title: 'zz' }]);
    const { res, calls } = await callHandle(`/api/agent/board/${slug}/cards?token=nope`, { token: 'cfg' });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
    expect(await res.json()).toEqual({ error: 'unauthorized' });
    expect(calls).toHaveLength(0);
  });

  it('cards and changes both gated identically', async () => {
    const slug = freshSlug();
    createBoard(slug, [{ id: 'a', title: 'a' }]);
    const cards = await callHandle(`/api/agent/board/${slug}/cards`, { token: 'cfg' });
    expect(cards.res.status).toBe(401);
    expect(cards.calls).toHaveLength(0);
    const changes = await callHandle(`/api/agent/board/${slug}/changes?since=0`, { token: 'cfg' });
    expect(changes.res.status).toBe(401);
    expect(changes.calls).toHaveLength(0);
  });

  it('non-loopback deny: unset AGENT_TOKEN on a non-loopback bind returns 401 before the route', async () => {
    const slug = freshSlug();
    createBoard(slug, [{ id: 'a', title: 'alpha' }]);
    setAgentHostForTest('0.0.0.0');
    const { res, calls } = await callHandle(`/api/agent/board/${slug}/changes?since=0`);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
    expect(await res.json()).toEqual({ error: 'unauthorized' });
    expect(calls).toHaveLength(0); // gate short-circuits before the route
  });
});

describe('integration: ordinary UI / REST endpoints stay ungated', () => {
  it('ordinary REST (/api/boards.json) accessible with no credentials even when AGENT_TOKEN is set', async () => {
    const { res, calls } = await callHandle('/api/boards.json', { token: 'cfg' });
    expect(res.status).toBe(200);
    expect(calls).toEqual(['/api/boards.json']);
  });

  it('UI path accessible with no credentials even when AGENT_TOKEN is set', async () => {
    const { res, calls } = await callHandle('/');
    expect(res.status).toBe(200);
    expect(calls).toEqual(['/']);
  });

  it('agent endpoint still DNS-404s with valid token through the hook', async () => {
    const { res, calls } = await callHandle('/api/agent/board/does-not-exist/cards?token=cfg', { token: 'cfg' });
    expect(res.status).toBe(404);
    expect(calls).toHaveLength(1);
  });
});

describe('integration: endpoint semantics preserved at the hook layer', () => {
  it('since=0 → full snapshot reset with valid token', async () => {
    const slug = freshSlug();
    createBoard(slug, [{ id: 'a', title: 'alpha' }, { id: 'b', title: 'beta' }]);
    const { res } = await callHandle(`/api/agent/board/${slug}/changes?since=0`, {
      token: 'cfg',
      headers: { authorization: 'Bearer cfg' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.changes).toEqual([
      { kind: 'reset', cards: [expect.objectContaining({ id: 'a' }), expect.objectContaining({ id: 'b' })] },
    ]);
  });

  it('since=prev → deltas only, revision+1 with valid token', async () => {
    const slug = freshSlug();
    createBoard(slug, [{ id: 'a', title: 'alpha' }]);
    const first = await (
      await callHandle(`/api/agent/board/${slug}/changes?since=0`, {
        token: 'cfg',
        headers: { authorization: 'Bearer cfg' },
      })
    ).res.json();
    const prevRev = first.revision as number;

    addTask(slug, 'c1', 'one more');
    vi.advanceTimersByTime(1000);

    const { res } = await callHandle(`/api/agent/board/${slug}/changes?since=${prevRev}`, {
      token: 'cfg',
      headers: { authorization: 'Bearer cfg' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.revision).toBe(prevRev + 1);
    expect(body.changes.some((c: { kind: string }) => c.kind === 'cards')).toBe(true);
    expect(body.changes.some((c: { kind: string }) => c.kind === 'reset')).toBe(false);
  });

  it('cards filters apply behind the gate with valid token', async () => {
    const slug = freshSlug();
    createBoard(slug, [{ id: 'a', title: 'a', assignee: 'bob' }, { id: 'b', title: 'b', assignee: 'alice' }]);
    const { res } = await callHandle(`/api/agent/board/${slug}/cards?assignee=bob&token=cfg`, { token: 'cfg' });
    expect(res.status).toBe(200);
    const ids = (await res.json()).map((c: { id: string }) => c.id);
    expect(ids).toEqual(['a']);
  });
});