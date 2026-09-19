// Unit tests: MCP server tool handlers (spec §4; M-1 #3).
// Drives the real McpServer through a mock MCP client (in-process
// InMemoryTransport linked pair + the SDK Client), exercising the 4 tools and
// the optional resources against a fake board DB using the board-discover
// layout: read_board full snapshot, list_changes since=0→reset and
// since=rev→deltas, get_card detail, unknown board/id → error.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Database } from 'bun:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from './mcp';

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

function boardPath(slug: string): string {
  return join(home, 'kanban', 'boards', slug, 'kanban.db');
}

beforeEach(() => {
  vi.useFakeTimers();
  home = resolve(mkdtempSync('mcp-'));
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

interface ToolResult {
  content: { type: string; text?: string }[];
  isError?: boolean;
}

/** Connect a mock MCP client to a fresh McpServer over an in-memory pair. */
async function connect(): Promise<Client> {
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  createMcpServer(serverTransport);
  const client = new Client({ name: 'mock-client', version: '1.0.0' });
  await client.connect(clientTransport);
  return client;
}

/** Call a tool and return the parsed JSON text of its first content block. */
async function callTool(client: Client, name: string, args?: Record<string, unknown>): Promise<unknown> {
  const res = (await client.callTool({ name, arguments: args ?? {} })) as unknown as ToolResult;
  const block = res.content[0];
  if (block.type !== 'text') throw new Error('expected text content block');
  return JSON.parse(block.text!);
}

/** Call a tool and return the raw result (for error assertions). */
async function callToolRaw(client: Client, name: string, args?: Record<string, unknown>): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args ?? {} })) as unknown as ToolResult;
}

describe('MCP server tools', () => {
  it('list_boards returns the available board slugs', async () => {
    const slug = freshSlug();
    createBoard(slug, [{ id: 'a', title: 'alpha' }]);
    const client = await connect();
    const slugs = (await callTool(client, 'list_boards')) as string[];
    expect(slugs).toContain(slug);
  });

  it('read_board returns a full snapshot with revision', async () => {
    const slug = freshSlug();
    createBoard(slug, [
      { id: 'a', title: 'alpha', assignee: 'jeff', status: 'running' },
      { id: 'b', title: 'beta' },
    ]);
    const client = await connect();
    const snap = (await callTool(client, 'read_board', { slug })) as {
      slug: string;
      revision: number;
      cards: { id: string; title: string }[];
      summary: { stalledCount: number };
    };
    expect(snap.slug).toBe(slug);
    expect(snap.revision).toBeGreaterThan(0);
    expect(snap.cards.map((c) => c.id).sort()).toEqual(['a', 'b']);
    expect(snap.summary).toBeDefined();
  });

  it('read_board defaults to the default board when slug omitted', async () => {
    const dbPath = join(home, 'kanban.db');
    mkdirSync(join(home, 'kanban'), { recursive: true });
    const db = new Database(dbPath);
    db.exec(SCHEMA);
    db.prepare(
      `INSERT INTO tasks (id, title, body, assignee, status, priority, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('d1', 'default card', '', null, 'todo', 0, 1_000_000_000);
    db.close();

    const client = await connect();
    const snap = (await callTool(client, 'read_board')) as { slug: string; cards: { id: string }[] };
    expect(snap.slug).toBe('default');
    expect(snap.cards.map((c) => c.id)).toEqual(['d1']);
  });

  it('read_board unknown board → error', async () => {
    const client = await connect();
    const res = await callToolRaw(client, 'read_board', { slug: 'nope' });
    expect(res.isError).toBe(true);
    const text = res.content[0].type === 'text' ? res.content[0].text : '';
    expect(text).toContain('unavailable');
  });

  it('list_changes since=0 → full snapshot reset with all cards', async () => {
    const slug = freshSlug();
    createBoard(slug, [{ id: 'a', title: 'alpha' }]);
    const client = await connect();
    const res = (await callTool(client, 'list_changes', { slug, since: 0 })) as {
      revision: number;
      changes: { kind: string; cards?: { id: string }[] }[];
    };
    expect(res.revision).toBeGreaterThan(0);
    expect(res.changes).toHaveLength(1);
    expect(res.changes[0].kind).toBe('reset');
    expect(res.changes[0].cards?.map((c) => c.id)).toEqual(['a']);
  });

  it('list_changes since=prev → deltas only, revision +1', async () => {
    const slug = freshSlug();
    createBoard(slug, [{ id: 'a', title: 'alpha' }]);
    const client = await connect();
    const first = (await callTool(client, 'list_changes', { slug, since: 0 })) as { revision: number };
    const prevRev = first.revision;

    addTask(slug, 'c1', 'one more');
    vi.advanceTimersByTime(1000);

    const res = (await callTool(client, 'list_changes', { slug, since: prevRev })) as {
      revision: number;
      changes: { kind: string; upserts?: { id: string }[] }[];
    };
    expect(res.revision).toBe(prevRev + 1);
    expect(res.changes.some((c) => c.kind === 'cards')).toBe(true);
    const cardsScope = res.changes.find((c) => c.kind === 'cards');
    expect(cardsScope?.upserts?.map((c) => c.id)).toContain('c1');
    expect(res.changes.some((c) => c.kind === 'reset')).toBe(false);
  });

  it('list_changes no-change poll → empty changes, unchanged revision', async () => {
    const slug = freshSlug();
    createBoard(slug, [{ id: 'a', title: 'alpha' }]);
    const client = await connect();
    const first = (await callTool(client, 'list_changes', { slug, since: 0 })) as { revision: number };
    const rev = first.revision;

    vi.advanceTimersByTime(4000);

    const res = (await callTool(client, 'list_changes', { slug, since: rev })) as {
      revision: number;
      changes: unknown[];
    };
    expect(res.revision).toBe(rev);
    expect(res.changes).toEqual([]);
  });

  it('list_changes unknown board → error', async () => {
    const client = await connect();
    const res = await callToolRaw(client, 'list_changes', { slug: 'nope', since: 0 });
    expect(res.isError).toBe(true);
  });

  it('get_card returns full CardDetail (runs, comments, transitions, body)', async () => {
    const slug = freshSlug();
    createBoard(slug, [{ id: 'a', title: 'alpha' }]);
    const db = new Database(boardPath(slug));
    db.prepare(
      `INSERT INTO task_runs (id, task_id, status, started_at, ended_at, outcome, summary) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(1, 'a', 'completed', 1_000_000_000, 1_000_000_100, 'ok', 'done');
    db.prepare(
      `INSERT INTO task_comments (id, task_id, author, body, created_at) VALUES (?, ?, ?, ?, ?)`,
    ).run(1, 'a', 'jeff', 'looks good', 1_000_000_050);
    db.close();

    const client = await connect();
    const detail = (await callTool(client, 'get_card', { slug, id: 'a' })) as {
      card: { id: string };
      runs: unknown[];
      comments: { author: string; body: string }[];
      transitions: unknown[];
      body: string;
    };
    expect(detail.card.id).toBe('a');
    expect(detail.runs).toHaveLength(1);
    expect(detail.comments).toHaveLength(1);
    expect(detail.comments[0]).toMatchObject({ author: 'jeff', body: 'looks good' });
    expect(Array.isArray(detail.transitions)).toBe(true);
    expect(typeof detail.body).toBe('string');
  });

  it('get_card unknown id → error', async () => {
    const slug = freshSlug();
    createBoard(slug, [{ id: 'a', title: 'alpha' }]);
    const client = await connect();
    const res = await callToolRaw(client, 'get_card', { slug, id: 'missing' });
    expect(res.isError).toBe(true);
    const text = res.content[0].type === 'text' ? res.content[0].text : '';
    expect(text).toContain('not found');
  });

  it('get_card unknown board → error', async () => {
    const client = await connect();
    const res = await callToolRaw(client, 'get_card', { slug: 'nope', id: 'a' });
    expect(res.isError).toBe(true);
  });

  it('resources: board://{slug}/snapshot and board://{slug}/card/{id}', async () => {
    const slug = freshSlug();
    createBoard(slug, [{ id: 'a', title: 'alpha' }]);
    const client = await connect();

    // Templates are read-by-URI (not enumerated); listResources still works.
    const listed = await client.listResources();
    expect(Array.isArray(listed.resources)).toBe(true);

    const snap = (await client.readResource({ uri: `board://${slug}/snapshot` })) as { contents: { text?: string }[] };
    const snapText = snap.contents[0].text ?? '';
    expect(JSON.parse(snapText).cards.map((c: { id: string }) => c.id)).toEqual(['a']);

    const card = (await client.readResource({ uri: `board://${slug}/card/a` })) as { contents: { text?: string }[] };
    const cardText = card.contents[0].text ?? '';
    expect(JSON.parse(cardText).card.id).toBe('a');
  });
});
