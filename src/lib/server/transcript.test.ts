// Unit tests: card transcript reader (transcript viewer card).
//
// Verifies the locked decisions:
//   §3  — session resolution is strictly card-keyed: the reader resolves
//         card → its run → worker_session_id → owning profile's state.db and
//         never accepts a session id from the caller.
//   §4  — reads the owning profile's `state.db` (sessions + messages) and
//         degrades gracefully when the store/session is missing.
//   §5  — events are ordered + bounded; large payloads are truncated (not
//         dumped) and the list is capped.
//   read-only — the profile store is opened readonly.
//
// Fixture layout mirrors the real deploy: under $HERMES_HOME a board
// `kanban.db` (tasks + task_runs) and `<HERMES_HOME>/profiles/<profile>/state.db`
// (sessions + messages). Worker session ids are recorded on task_runs.metadata
// ($.worker_session_id), exactly as `listRuns` extracts them.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Database } from 'bun:sqlite';

import { openReadonly } from './data-access';
import { readCardTranscript, MAX_PAYLOAD_CHARS } from './transcript';

const BOARD_SCHEMA = `
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

/** Minimal session/message schema matching the real profile `state.db`. */
const PROFILE_SCHEMA = `
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, source TEXT, started_at REAL, ended_at REAL,
  message_count INTEGER
);
CREATE TABLE messages (
  id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL,
  content TEXT, tool_call_id TEXT, tool_calls TEXT, tool_name TEXT,
  timestamp REAL
);
`;

interface Fixture {
  home: string;
  dbPath: string;
}

let fixture: Fixture | null = null;
let envBackup: { HERMES_HOME?: string };

function makeBoard(tasks: [string, string | null, string][], runs: [
  id: number, taskId: string, profile: string | null, metadata: string | null,
][]): Fixture {
  const home = resolve(mkdtempSync('transcript-'));
  const dbPath = join(home, 'kanban.db');
  const db = new Database(dbPath);
  db.exec(BOARD_SCHEMA);
  const ins = db.prepare(
    `INSERT INTO tasks (id, title, body, assignee, status, priority, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const [id, assignee, status] of tasks) {
    ins.run(id, 'T', '', assignee, status ?? 'todo', 0, 1000);
  }
  const run = db.prepare(
    `INSERT INTO task_runs (id, task_id, profile, status, metadata) VALUES (?, ?, ?, ?, ?)`,
  );
  for (const [id, taskId, profile, metadata] of runs) {
    run.run(id, taskId, profile, 'completed', metadata);
  }
  db.close();
  return { home, dbPath };
}

/** Write `<home>/profiles/<profile>/state.db` with a session + messages. */
function makeProfileStore(
  home: string,
  profile: string,
  sessionId: string,
  messages: [id: number, role: string, content: string | null, toolCalls: string | null, toolName: string | null, timestamp: number | null][],
): string {
  const dir = join(home, 'profiles', profile);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 'state.db');
  // Force a fresh store (a call may target the same profile dir again).
  if (existsSync(p)) rmSync(p, { force: true });
  const db = new Database(p);
  db.exec(PROFILE_SCHEMA);
  db.prepare(`INSERT INTO sessions (id, source, started_at, ended_at, message_count) VALUES (?, 'kanban', ?, ?, ?)`)
    .run(sessionId, 1000, 2000, messages.length);
  const ins = db.prepare(
    `INSERT INTO messages (id, session_id, role, content, tool_call_id, tool_calls, tool_name, timestamp) VALUES (?, ?, ?, ?, NULL, ?, ?, ?)`,
  );
  for (const [id, role, content, toolCalls, toolName, ts] of messages) {
    ins.run(id, sessionId, role, content, toolCalls, toolName, ts);
  }
  db.close();
  return p;
}

beforeEach(() => {
  envBackup = { HERMES_HOME: process.env.HERMES_HOME };
  process.env.HERMES_HOME = '';
});

afterEach(() => {
  if (fixture) rmSync(fixture.home, { recursive: true, force: true });
  fixture = null;
  if (envBackup.HERMES_HOME === undefined) delete process.env.HERMES_HOME;
  else process.env.HERMES_HOME = envBackup.HERMES_HOME;
});

describe('readCardTranscript — card-keyed session resolution (§3)', () => {
  it('returns the ordered transcript for the card whose run records the session id', () => {
    fixture = makeBoard(
      [['a', 'builder', 'running']],
      [[1, 'a', 'builder', JSON.stringify({ worker_session_id: 's-1' })]],
    );
    process.env.HERMES_HOME = fixture.home;
    makeProfileStore(fixture.home, 'builder', 's-1', [
      [1, 'user', 'fix the poller', null, null, 1000.1],
      [2, 'assistant', 'Checking.', JSON.stringify([{ function: { name: 'terminal', arguments: 'ls' } }]), null, 1001.2],
      [3, 'tool', null, null, 'terminal', 1002.3],
      [4, 'tool', '{"ok":true}', null, 'kanban_heartbeat', 1003.4],
    ]);

    const db = openReadonly(fixture.dbPath);
    const r = readCardTranscript(db, 'a')!;
    db.close();

    expect(r.sessionId).toBe('s-1');
    expect(r.profile).toBe('builder');
    expect(r.hasTranscript).toBe(true);
    // Ordered ascending by message id: user → assistant text → tool-call → result → heartbeat.
    expect(r.events.map((e) => e.kind)).toEqual([
      'user', 'assistant', 'tool-call', 'tool-result', 'heartbeat',
    ]);
    expect(r.events.map((e) => e.role)).toEqual([
      'user', 'assistant', 'assistant', 'tool', 'tool',
    ]);
    expect(r.events[0].text).toBe('fix the poller');
    expect(r.events[2].toolName).toBe('terminal');
    expect(r.events[3].toolName).toBe('terminal');
    expect(r.events[4].kind).toBe('heartbeat');
    expect(r.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    // Timestamps carried through (raw message ts in seconds).
    expect(r.events[0].at).toBe(1000.1);
  });

  it('uses the latest run with a session id (falls back across earlier no-session runs)', () => {
    fixture = makeBoard(
      [['a', 'reviewer', 'done']],
      [
        [1, 'a', 'reviewer', null], // older run, no session
        [5, 'a', 'reviewer', JSON.stringify({ worker_session_id: 's-5' })],
      ],
    );
    process.env.HERMES_HOME = fixture.home;
    makeProfileStore(fixture.home, 'reviewer', 's-5', [
      [10, 'user', 'hello', null, null, 900],
    ]);
    const db = openReadonly(fixture.dbPath);
    const r = readCardTranscript(db, 'a')!;
    db.close();
    expect(r.sessionId).toBe('s-5');
    expect(r.events.map((e) => e.kind)).toEqual(['user']);
  });

  it('is silent for a forged/foreign session id — it never looks it up from the caller', () => {
    // The card owns session 's-owned'; a foreign session 's-intruder' exists in
    // the profile store but must never be reached, because the reader only
    // ever uses the card's own run's id. Calling for the card returns its own
    // transcript, not the intruder's.
    fixture = makeBoard(
      [['a', 'builder', 'running']],
      [[1, 'a', 'builder', JSON.stringify({ worker_session_id: 's-owned' })]],
    );
    process.env.HERMES_HOME = fixture.home;
    makeProfileStore(fixture.home, 'builder', 's-owned', [
      [1, 'user', 'mine', null, null, 100],
    ]);
    makeProfileStore(fixture.home, 'builder', 's-intruder', [
      [1, 'user', 'THEFT', null, null, 100],
    ]);
    const db = openReadonly(fixture.dbPath);
    const r = readCardTranscript(db, 'a')!;
    db.close();
    expect(r.sessionId).toBe('s-owned');
    expect(r.events.some((e) => e.text === 'THEFT')).toBe(false);
  });

  it('returns null for an unknown card id', () => {
    fixture = makeBoard([['a', 'builder', 'todo']], []);
    const db = openReadonly(fixture.dbPath);
    expect(readCardTranscript(db, 'nope')).toBeNull();
    db.close();
  });
});

describe('readCardTranscript — graceful absence / missing store (§4)', () => {
  it('no run with a session id -> empty, hasTranscript false, sessionId null', () => {
    fixture = makeBoard([['a', 'builder', 'todo']], [[1, 'a', 'builder', null]]);
    const db = openReadonly(fixture.dbPath);
    const r = readCardTranscript(db, 'a')!;
    db.close();
    expect(r.events).toEqual([]);
    expect(r.hasTranscript).toBe(false);
    expect(r.sessionId).toBeNull();
  });

  it('profile state.db missing -> graceful empty, not a throw', () => {
    fixture = makeBoard(
      [['a', 'builder', 'doing']],
      [[1, 'a', 'builder', JSON.stringify({ worker_session_id: 's-gone' })]],
    );
    process.env.HERMES_HOME = fixture.home; // no profiles/<builder>/state.db written
    const db = openReadonly(fixture.dbPath);
    const r = readCardTranscript(db, 'a')!;
    db.close();
    expect(r.events).toEqual([]);
    expect(r.hasTranscript).toBe(false);
    expect(r.sessionId).toBe('s-gone');
    expect(r.profile).toBe('builder');
  });

  it('session id not present in the profile store -> graceful empty', () => {
    fixture = makeBoard(
      [['a', 'builder', 'doing']],
      [[1, 'a', 'builder', JSON.stringify({ worker_session_id: 's-missing' })]],
    );
    process.env.HERMES_HOME = fixture.home;
    makeProfileStore(fixture.home, 'builder', 's-other', [
      [1, 'user', 'other session', null, null, 1],
    ]);
    const db = openReadonly(fixture.dbPath);
    const r = readCardTranscript(db, 'a')!;
    db.close();
    expect(r.events).toEqual([]);
    expect(r.hasTranscript).toBe(false);
  });

  it('falls back to the card assignee when the run has no profile recorded', () => {
    fixture = makeBoard(
      [['a', 'lead', 'done']],
      [[1, 'a', null, JSON.stringify({ worker_session_id: 's-l' })]],
    );
    process.env.HERMES_HOME = fixture.home;
    makeProfileStore(fixture.home, 'lead', 's-l', [
      [1, 'user', 'from lead', null, null, 5],
    ]);
    const db = openReadonly(fixture.dbPath);
    const r = readCardTranscript(db, 'a')!;
    db.close();
    expect(r.profile).toBe('lead');
    expect(r.events[0].text).toBe('from lead');
  });
});

describe('readCardTranscript — ordering + bounding (§5)', () => {
  it('truncates an oversized tool-result payload to MAX_PAYLOAD_CHARS (not dumped)', () => {
    fixture = makeBoard(
      [['a', 'builder', 'done']],
      [[1, 'a', 'builder', JSON.stringify({ worker_session_id: 's-big' })]],
    );
    process.env.HERMES_HOME = fixture.home;
    const big = 'x'.repeat(MAX_PAYLOAD_CHARS + 500);
    makeProfileStore(fixture.home, 'builder', 's-big', [
      [1, 'tool', big, null, 'terminal', 1],
    ]);
    const db = openReadonly(fixture.dbPath);
    const r = readCardTranscript(db, 'a')!;
    db.close();
    const ev = r.events[0];
    expect(ev.truncated).toBe(true);
    expect(ev.text.length).toBe(MAX_PAYLOAD_CHARS);
    expect(r.truncated).toBe(true);
  });

  it('caps the event list, keeping the latest events, and flags truncated', () => {
    fixture = makeBoard(
      [['a', 'builder', 'done']],
      [[1, 'a', 'builder', JSON.stringify({ worker_session_id: 's-cap' })]],
    );
    process.env.HERMES_HOME = fixture.home;
    const msgs = Array.from({ length: 5 }, (_, i) => [
      i + 1, 'user', `msg-${i + 1}`, null, null, i + 1,
    ]) as [number, string, string | null, string | null, string | null, number | null][];
    makeProfileStore(fixture.home, 'builder', 's-cap', msgs);
    const db = openReadonly(fixture.dbPath);
    const r = readCardTranscript(db, 'a', { maxEvents: 3 })!;
    db.close();
    expect(r.events).toHaveLength(3);
    // Kept the newest 3 (ids 3,4,5), dropped the oldest 2, flagged truncated.
    expect(r.events.map((e) => e.text)).toEqual(['msg-3', 'msg-4', 'msg-5']);
    expect(r.truncated).toBe(true);
  });

  it('respects a custom payload budget', () => {
    fixture = makeBoard(
      [['a', 'builder', 'done']],
      [[1, 'a', 'builder', JSON.stringify({ worker_session_id: 's-custom' })]],
    );
    process.env.HERMES_HOME = fixture.home;
    makeProfileStore(fixture.home, 'builder', 's-custom', [
      [1, 'user', 'abcdefgh', null, null, 1],
    ]);
    const db = openReadonly(fixture.dbPath);
    const r = readCardTranscript(db, 'a', { maxPayloadChars: 4 })!;
    db.close();
    expect(r.events[0].text).toBe('abcd');
    expect(r.events[0].truncated).toBe(true);
  });

  it('does not truncate small payloads (no truncated flag, full text)', () => {
    fixture = makeBoard(
      [['a', 'builder', 'done']],
      [[1, 'a', 'builder', JSON.stringify({ worker_session_id: 's-small' })]],
    );
    process.env.HERMES_HOME = fixture.home;
    makeProfileStore(fixture.home, 'builder', 's-small', [
      [1, 'user', 'short', null, null, 1],
    ]);
    const db = openReadonly(fixture.dbPath);
    const r = readCardTranscript(db, 'a')!;
    db.close();
    expect(r.events[0].text).toBe('short');
    expect(r.events[0].truncated).toBe(false);
    expect(r.truncated).toBe(false);
  });
});
