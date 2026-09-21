// Integration tests: AGENT_TOKEN gate in front of the REAL MCP Streamable HTTP
// path (spec §6.1–6.3; M-1 #4). This imports 'mcp-auth-test-env' first so the
// hooks.server import-time boot check stays silent, then wires the REAL
// hooks.server handle() directly in front of the REAL lib/server/mcp
// handleMcpRequest so each request traverses the actual gate → transport →
// session code — no mocked resolve, no fake Transport.
//
// Scope (matching the implementation card): missing/wrong/valid credentials
// across POST/GET/DELETE, an authenticated initialize establishing a REAL
// session, authenticated GET SSE + DELETE on that session, an unauthenticated
// initialize being unable to establish a session, a valid session WITHOUT its
// repeated Authorization header being rejected (and still usable once the
// header returns), ?token= query fallback, and default-open when AGENT_TOKEN is
// unset. MCP tool semantics / session handling are left untouched and are
// asserted to still function (initialize → notifications/initialized →
// tools/list → GET SSE → DELETE) through the gate.

import './mcp-auth-test-env';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handle } from '../../hooks.server';
import { handleMcpRequest } from './mcp';
import { setAgentHostForTest, setAgentTokenForTest } from './agent-auth';

const BASE = 'http://test/mcp';
const PROTO = '2025-06-18';
const TOKEN = 'integration-cfg';

/** Drive a Web Request through the REAL hook-before-handleMcpRequest path. */
async function gate(request: Request): Promise<Response> {
  const url = new URL(request.url);
  return handle({
    event: { url, request },
    resolve: ({ request: r }: { request: Request }) => handleMcpRequest(r),
  } as never);
}

/** Build a JSON-RPC POST with the transport-required headers. */
function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(BASE, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

/** Build a header-less GET SSE stream request (transport requires Accept: text/event-stream). */
function sseGet(headers: Record<string, string> = {}): Request {
  return new Request(BASE, {
    method: 'GET',
    headers: { accept: 'text/event-stream', ...headers },
  });
}

/** Build a DELETE request. */
function del(headers: Record<string, string> = {}): Request {
  return new Request(BASE, { method: 'DELETE', headers });
}

const bearer = { authorization: `Bearer ${TOKEN}` };
const initMsg = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: PROTO,
    capabilities: {},
    clientInfo: { name: 'integration-test', version: '1.0.0' },
  },
};

function initializedNotification() {
  return { jsonrpc: '2.0' as const, method: 'notifications/initialized' as const };
}

const toolsListMsg = { jsonrpc: '2.0', id: 2, method: 'tools/list' };

/** Establish a real authenticated MCP session, return its session id. */
async function establishSession(): Promise<string> {
  const res = await gate(post(initMsg, bearer));
  expect(res.status).toBe(200);
  const sid = res.headers.get('mcp-session-id');
  expect(sid).toBeTruthy();
  const body = await res.json();
  expect(body.result).toBeDefined();
  expect(body.result.serverInfo).toBeDefined();
  return sid!;
}

beforeEach(() => {
  setAgentTokenForTest(TOKEN);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  setAgentTokenForTest(undefined);
  setAgentHostForTest('127.0.0.1');
  vi.restoreAllMocks();
});

describe('MCP Streamable HTTP auth gate (real hook → handleMcpRequest)', () => {
  it('rejects an unauthenticated initialize with a uniform 401 and no session', async () => {
    const res = await gate(post(initMsg));
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
    expect(await res.json()).toEqual({ error: 'unauthorized' });
    // An initialize that never reached the transport cannot mint a session id.
    expect(res.headers.get('mcp-session-id')).toBeNull();
  });

  it('rejects an initialize with a wrong token (same 401 body as missing)', async () => {
    const res = await gate(post(initMsg, { authorization: 'Bearer nope' }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });

  it('accepts a valid Bearer initialize and establishes a functional session', async () => {
    const sid = await establishSession();
    expect(sid.length).toBeGreaterThan(0);

    // Complete initialization and prove the session is a real, working MCP
    // server (tools/list returns the registered tool set) — semantics intact.
    const notif = await gate(post(initializedNotification(), { ...bearer, 'mcp-session-id': sid }));
    expect(notif.status).toBe(202);

    const tools = await gate(
      post(toolsListMsg, { ...bearer, 'mcp-session-id': sid, 'mcp-protocol-version': PROTO }),
    );
    expect(tools.status).toBe(200);
    const toolJson = await tools.json();
    const names = toolJson.result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain('list_boards');
    expect(names).toContain('read_board');
    expect(names).toContain('list_changes');
    expect(names).toContain('get_card');

    // Cleanup: DELETE (also covers authenticated DELETE on a valid session).
    const bye = await gate(del({ ...bearer, 'mcp-session-id': sid }));
    expect(bye.status).toBe(200);
  });

  it('accepts the ?token= query fallback for initialize and follow-up', async () => {
    const initQ = await gate(
      new Request(`${BASE}?token=${TOKEN}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify(initMsg),
      }),
    );
    expect(initQ.status).toBe(200);
    const sid = initQ.headers.get('mcp-session-id');
    expect(sid).toBeTruthy();

    const toolsQ = await gate(
      new Request(`${BASE}?token=${TOKEN}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-session-id': sid!,
          'mcp-protocol-version': PROTO,
        },
        body: JSON.stringify(toolsListMsg),
      }),
    );
    expect(toolsQ.status).toBe(200);

    await gate(del({ authorization: `Bearer ${TOKEN}`, 'mcp-session-id': sid! }));
  });

  it('rejects GET SSE and POST without a repeated Authorization header, even for a valid session', async () => {
    const sid = await establishSession();

    // Valid session, but the GET SSE stream omits the Authorization header →
    // rejected at the hook before the transport ever sees the session id.
    const unauthedSse = await gate(sseGet({ 'mcp-session-id': sid, 'mcp-protocol-version': PROTO }));
    expect(unauthedSse.status).toBe(401);

    // Same for a follow-up POST carrying only the session id (no token).
    const unauthedPost = await gate(
      post(toolsListMsg, { 'mcp-session-id': sid, 'mcp-protocol-version': PROTO }),
    );
    expect(unauthedPost.status).toBe(401);

    // Re-checking on every request must NOT kill the session: with the header
    // restored, the same session still serves. And the authenticated GET SSE
    // stream opens (then we cancel it to tear down its keep-alive timer).
    const authedSse = await gate(
      sseGet({ ...bearer, 'mcp-session-id': sid, 'mcp-protocol-version': PROTO }),
    );
    expect(authedSse.status).toBe(200);
    expect(authedSse.headers.get('content-type')).toContain('text/event-stream');
    await authedSse.body?.cancel();

    await gate(del({ ...bearer, 'mcp-session-id': sid }));
  });

  it('rejects DELETE without a repeated Authorization header, then grants it with one and removes the session', async () => {
    const sid = await establishSession();

    const unauthedDel = await gate(del({ 'mcp-session-id': sid }));
    expect(unauthedDel.status).toBe(401);

    // With the header, DELETE succeeds and the session is torn down.
    const authedDel = await gate(del({ ...bearer, 'mcp-session-id': sid }));
    expect(authedDel.status).toBe(200);

    // A terminated session is gone: a fresh authenticated request with the old
    // session id now 404s (mcp.ts session map no longer holds it).
    const after = await gate(
      post(toolsListMsg, { ...bearer, 'mcp-session-id': sid, 'mcp-protocol-version': PROTO }),
    );
    expect(after.status).toBe(404);
  });

  it('loopback-open: initialize works with no credentials when AGENT_TOKEN unset on a loopback bind', async () => {
    setAgentTokenForTest(undefined);
    setAgentHostForTest('127.0.0.1');
    const res = await gate(post(initMsg));
    expect(res.status).toBe(200);
    const sid = res.headers.get('mcp-session-id');
    expect(sid).toBeTruthy();
    // Cleanup via a tokenless DELETE (open mode) so no session leaks between tests.
    const bye = await gate(del({ 'mcp-session-id': sid! }));
    expect(bye.status).toBe(200);
  });

  it('non-loopback deny: initialize returns 401 with no token when AGENT_TOKEN unset on a non-loopback bind (spec §6.4)', async () => {
    setAgentTokenForTest(undefined);
    setAgentHostForTest('0.0.0.0');
    const res = await gate(post(initMsg));
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
    expect(await res.json()).toEqual({ error: 'unauthorized' });
    // A denied initialize cannot mint a session.
    expect(res.headers.get('mcp-session-id')).toBeNull();
  });
});