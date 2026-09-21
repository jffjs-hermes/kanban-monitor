// MCP server (Streamable HTTP) on the same kanban-monitor process (spec §4;
// M-1 #3). A thin adapter that exposes the derived monitoring view as native
// MCP tools/resources, calling the SAME `boardRuntime` the REST/SSE surfaces
// use — no separate process, no double diffing, no sqlite reads outside the
// runtime.
//
// Tools (MVP, spec §4.2):
//   - list_boards()            → BoardSlug[]
//   - read_board(slug?)        → BoardSnapshot (full: summary + cards, incl. revision)
//   - list_changes(slug?, since) → { revision, changes: DeltaScope[] }
//   - get_card(slug?, id)      → CardDetail (runs, comments, transitions, body, PR metadata)
// Resources (optional, cheap, spec §4.3):
//   - board://{slug}/snapshot
//   - board://{slug}/card/{id}
//
// Read-only: the tools observe; no mutation through MCP. No auth on this
// surface in this increment (deferred; binds as the REST surface does today).

import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { z } from 'zod';

import { boardRuntime } from './runtime';
import { listBoards } from './board-discover';
import type { BoardSlug, CardView, DeltaScope } from '../types';

/** Server identity advertised to MCP clients. */
export const MCP_SERVER_NAME = 'kanban-monitor';
export const MCP_SERVER_VERSION = '1.0.0';

/** A DeltaScope as served to MCP callers: `reset` carries the full card list. */
export type AgentChange =
  | { kind: 'summary' }
  | { kind: 'cards'; upserts: CardView[]; removedIds: string[] }
  | { kind: 'card'; taskId: string }
  | { kind: 'reset'; cards: CardView[] };

export interface ChangesResult {
  revision: number;
  changes: AgentChange[];
}

/** Wrap a runtime DeltaScope, replacing `reset` with an agent-shaped reset. */
function toAgentChanges(deltas: DeltaScope[], resetCards: CardView[]): AgentChange[] {
  const changes: AgentChange[] = [];
  for (const d of deltas) {
    if (d.kind === 'reset') {
      changes.push({ kind: 'reset', cards: resetCards });
    } else if (d.kind === 'summary') {
      changes.push({ kind: 'summary' });
    } else if (d.kind === 'card') {
      changes.push({ kind: 'card', taskId: d.taskId });
    } else if (d.kind === 'health') {
      // Agent API surface (spec §6) has no health scope — the UI gets per-
      // worker health via the SSE `health` event. Skip it so the agent delta
      // shape stays unchanged.
      continue;
    } else {
      changes.push({ kind: 'cards', upserts: d.upserts, removedIds: d.removedIds });
    }
  }
  return changes;
}

/** Resolve the optional `slug` argument (default board when omitted). */
function resolveSlug(slug: string | undefined): BoardSlug {
  return slug && slug.trim() !== '' ? slug : 'default';
}

/** Coerce a URI-template variable (string | string[]) to a single string. */
function varString(v: string | string[] | undefined): string | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v[0] : v;
}

/** Serialize a tool result as a single JSON text block. */
function textResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

/**
 * Build an MCP server wired to the shared `boardRuntime` and connect it to
 * `transport`. Each MCP session gets its own McpServer instance, but all share
 * the single runtime singleton, so every session observes the same board state.
 */
export function createMcpServer(transport: Transport): McpServer {
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    { capabilities: { tools: {}, resources: {} } },
  );

  server.registerTool(
    'list_boards',
    { description: 'List the board slugs available on this kanban-monitor process.' },
    async () => textResult(listBoards().map((b) => b.slug)),
  );

  server.registerTool(
    'read_board',
    {
      description:
        'Read the full derived snapshot for a board (summary + cards, including the monotonic revision). Omit slug for the default board.',
      inputSchema: { slug: z.string().optional() },
    },
    async ({ slug }) => {
      const s = resolveSlug(slug);
      const snapshot = boardRuntime.select(s);
      if (!snapshot) throw new Error(`board '${s}' unavailable`);
      return textResult(snapshot);
    },
  );

  server.registerTool(
    'list_changes',
    {
      description:
        'Resumable cursor poll from a past revision. since=0 (or omitted) returns a full snapshot-init reset; since=REV returns only the deltas after REV; a buffer miss degrades to a full reset. Returns { revision, changes }.',
      inputSchema: { slug: z.string().optional(), since: z.number().int().optional() },
    },
    async ({ slug, since }) => {
      const s = resolveSlug(slug);
      const sinceN = since ?? 0;
      const snapshot = boardRuntime.select(s);
      if (!snapshot) throw new Error(`board '${s}' unavailable`);

      const rev = boardRuntime.currentRevision(s);
      let changes: AgentChange[];
      if (sinceN <= 0) {
        changes = [{ kind: 'reset', cards: snapshot.cards }];
      } else {
        const res = boardRuntime.deltasSince(s, sinceN);
        if ('reset' in res) {
          changes = [{ kind: 'reset', cards: res.snapshot?.cards ?? snapshot.cards }];
        } else {
          changes = toAgentChanges(res.deltas, snapshot.cards);
        }
      }
      return textResult({ revision: rev, changes } satisfies ChangesResult);
    },
  );

  server.registerTool(
    'get_card',
    {
      description:
        'Read the full detail for one card on a board: runs, comments, transitions, body, and PR metadata. Omit slug for the default board.',
      inputSchema: { slug: z.string().optional(), id: z.string() },
    },
    async ({ slug, id }) => {
      const s = resolveSlug(slug);
      const detail = boardRuntime.detailOf(s, id);
      if (!detail) throw new Error(`card '${id}' not found on board '${s}'`);
      return textResult(detail);
    },
  );

  // Optional read-only resources (spec §4.3).
  server.registerResource(
    'board snapshot',
    new ResourceTemplate('board://{slug}/snapshot', { list: undefined }),
    { mimeType: 'application/json' },
    async (uri, variables) => {
      const s = resolveSlug(varString(variables.slug));
      const snapshot = boardRuntime.select(s);
      if (!snapshot) throw new Error(`board '${s}' unavailable`);
      return {
        contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(snapshot) }],
      };
    },
  );

  server.registerResource(
    'board card',
    new ResourceTemplate('board://{slug}/card/{id}', { list: undefined }),
    { mimeType: 'application/json' },
    async (uri, variables) => {
      const s = resolveSlug(varString(variables.slug));
      const id = varString(variables.id);
      if (!id) throw new Error('card id missing from resource URI');
      const detail = boardRuntime.detailOf(s, id);
      if (!detail) throw new Error(`card '${id}' not found on board '${s}'`);
      return {
        contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(detail) }],
      };
    },
  );

  server.connect(transport);
  return server;
}

// --- Streamable HTTP session management -------------------------------------
//
// Stateful mode: each MCP client session owns one transport + McpServer. The
// transport generates a session id on `initialize` (via `onsessioninitialized`)
// and we keep it in a map so subsequent POST/GET/DELETE requests with the
// `Mcp-Session-Id` header route to the same session. Sessions are in-memory
// and die with the process (one process, one set of boards — spec §4.1).

const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();

/**
 * Handle an MCP Streamable HTTP request (POST/GET/DELETE) on the `/mcp` route.
 * Returns a Web-standard Response for SvelteKit to pass through.
 */
export async function handleMcpRequest(request: Request): Promise<Response> {
  const sessionId = request.headers.get('mcp-session-id');

  if (request.method === 'GET') {
    // SSE stream for an existing session (server-initiated messages).
    const transport = sessionId ? sessions.get(sessionId) : undefined;
    if (!transport) return new Response('Session not found', { status: 404 });
    return transport.handleRequest(request);
  }

  if (request.method === 'DELETE') {
    const transport = sessionId ? sessions.get(sessionId) : undefined;
    if (!transport) return new Response('Session not found', { status: 404 });
    const res = await transport.handleRequest(request);
    sessions.delete(sessionId!);
    return res;
  }

  // POST with an existing session id → route to that session.
  if (sessionId) {
    const transport = sessions.get(sessionId);
    if (!transport) return new Response('Session not found', { status: 404 });
    return transport.handleRequest(request);
  }

  // POST without a session id → new session (initialize).
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    enableJsonResponse: true,
    onsessioninitialized: (id) => {
      sessions.set(id, transport);
    },
  });
  createMcpServer(transport);
  return transport.handleRequest(request);
}
