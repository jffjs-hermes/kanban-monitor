// Unit tests: GET /api/agent/board/[slug]/cards/[id]/transcript (transcript
// viewer card).
//
// Drives the real route handler against a fake board DB + a fake profile
// session store, using the board-discover layout and $HERMES_HOME/profiles/<p>/
// for the owning profile's state.db. Covers the endpoint's graceful semantics:
//   - 404 for an unknown card / unknown board (the route short-circuits);
//   - 200 with an ordered transcript when the card's run records a session;
//   - 200 with a graceful empty transcript when the card has no run/session.
// The AGENT_TOKEN gate itself is covered by hooks.server.integration.test.ts
// (this handler is token-unaware; the hook short-circuits before it).
//
// The handler calls the shared `boardRuntime` singleton, resolved per test from
// a unique board slug under a fresh HERMES_HOME.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
`;

const PROFILE_SCHEMA = `
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, source TEXT, started_at REAL, ended_at REAL, message_count INTEGER
);
CREATE TABLE messages (
  id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL,
  content TEXT, tool_call_id TEXT, tool_calls TEXT, tool_name TEXT, timestamp REAL
);
`;

let home: string;
let envBackup: { HERMES_HOME?: string };
let slugSeq = 0;

function boardPath(slug: string): string {
  return join(home, 'kanban', 'boards', slug, 'kanban.db');
}

beforeEach(() => {
  home = resolve(mkdtempSync('tr-' + Date.now().toString(36) + '-'));
  mkdirSync(join(home, 'kanban', 'boards'), { recursive: true });
  envBackup = { HERMES_HOME: process.env.HERMES_HOME };
  process.env.HERMES_HOME = home;
});

afterEach(() => {
  if (envBackup.HERMES_HOME === undefined) delete process.env.HERMES_HOME;
  else process.env.HERMES_HOME = envBackup.HERMES_HOME;
  rmSync(home, { recursive: true, force: true });
});

function freshSlug(): string {
  slugSeq += 1;
  return `t${slugSeq}`;
}

function makeBoard(slug: string, tasks: [string, string][], runs: [
  id: number, taskId: string, profile: string | null, metadata: string | null,
][]) {
  const dbPath = boardPath(slug);
  mkdirSync(join(dbPath, '..'), { recursive: true });
  const db = new Database(dbPath);
  db.exec(SCHEMA);
  const ins = db.prepare(
    `INSERT INTO tasks (id, title, body, assignee, status, priority, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  db.transaction(() => {
    for (const [id, assignee] of tasks) {
      ins.run(id, 'T', '', assignee, 'todo', 0, 1_000_000_000);
    }
    const run = db.prepare(
      `INSERT INTO task_runs (id, task_id, profile, status, metadata) VALUES (?, ?, ?, ?, ?)`,
    );
    for (const [id, taskId, profile, metadata] of runs) {
      run.run(id, taskId, profile, 'completed', metadata);
    }
  })();
  db.close();
}

function makeProfileStore(profile: string, sessionId: string, messages: [
  id: number, role: string, content: string | null, toolCalls: string | null, toolName: string | null,
][]) {
  const dir = join(home, 'profiles', profile);
  mkdirSync(dir, { recursive: true });
  const db = new Database(join(dir, 'state.db'));
  db.exec(PROFILE_SCHEMA);
  db.prepare(`INSERT INTO sessions (id, source, started_at, ended_at, message_count) VALUES (?, 'kanban', 0, 0, ?)`)
    .run(sessionId, messages.length);
  const ins = db.prepare(
    `INSERT INTO messages (id, session_id, role, content, tool_call_id, tool_calls, tool_name, timestamp) VALUES (?, ?, ?, ?, NULL, ?, ?, ?)`,
  );
  for (const [id, role, content, toolCalls, toolName] of messages) {
    ins.run(id, sessionId, role, content, toolCalls, toolName, id);
  }
  db.close();
}

async function callGET(slug: string, id: string): Promise<Response> {
  const url = new URL(`http://test/api/agent/board/${slug}/cards/${id}/transcript`);
  return GET({ params: { slug, id }, url } as never);
}

describe('GET /api/agent/board/[slug]/cards/[id]/transcript', () => {
  it('404 for an unknown card on a real board', async () => {
    const slug = freshSlug();
    makeBoard(slug, [['a', 'builder']], []);
    const res = await callGET(slug, 'nope');
    expect(res.status).toBe(404);
  });

  it('404 for an unknown board', async () => {
    const res = await callGET('does-not-exist', 'a');
    expect(res.status).toBe(404);
  });

  it('200 with graceful empty transcript when the card has a run but no session id', async () => {
    const slug = freshSlug();
    makeBoard(slug, [['a', 'builder']], [[1, 'a', 'builder', null]]);
    const res = await callGET(slug, 'a');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.events).toEqual([]);
    expect(body.hasTranscript).toBe(false);
    expect(body.sessionId).toBeNull();
    expect(body.truncated).toBe(false);
  });

  it('200 with the ordered transcript when the card run records a session id', async () => {
    const slug = freshSlug();
    makeBoard(
      slug,
      [['a', 'builder']],
      [[1, 'a', 'builder', JSON.stringify({ worker_session_id: 's-rt' })]],
    );
    makeProfileStore('builder', 's-rt', [
      [1, 'user', 'please', null, null],
      [2, 'assistant', null, JSON.stringify([{ function: { name: 'terminal', arguments: 'x' } }]), null],
      [3, 'tool', '{"ok":true}', null, 'terminal'],
    ]);
    const res = await callGET(slug, 'a');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.hasTranscript).toBe(true);
    expect(body.truncated).toBe(false);
    expect(body.events.map((e: { kind: string }) => e.kind)).toEqual([
      'user', 'tool-call', 'tool-result',
    ]);
    expect(body.events.map((e: { seq: number }) => e.seq)).toEqual([1, 2, 3]);
  });
});
