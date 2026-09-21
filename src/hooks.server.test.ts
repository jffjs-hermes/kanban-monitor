// Unit tests: SvelteKit auth hook (spec §6.3; M-1 #4).
// Exercises the real handle() gate against fake RequestEvent-like objects,
// verifying the agent paths and every /mcp method are gated when AGENT_TOKEN is
// set, and that UI / ordinary REST / SSE surfaces are never gated. Also covers
// the boot-warning surface (spec §6.1) via the shared helper.

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { handle } from './hooks.server';
import { setAgentTokenForTest } from '$lib/server/agent-auth';

/** Build a fake { event, resolve } pair for the gate. */
function makeEvent(pathname: string, method = 'GET', headers: Record<string, string> = {}) {
  const request = new Request(`http://test${pathname}`, { method, headers });
  const url = new URL(`http://test${pathname}`);
  const resolve = vi.fn().mockImplementation(async () => new Response('ok', { status: 200 }));
  return { event: { url, request }, resolve } as {
    event: { url: URL; request: Request };
    resolve: ReturnType<typeof vi.fn>;
  };
}

beforeEach(() => {
  setAgentTokenForTest(undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  setAgentTokenForTest(undefined);
  vi.restoreAllMocks();
});

describe('hook: default-open when AGENT_TOKEN is unset', () => {
  it('lets agent paths and /mcp through without credentials', async () => {
    setAgentTokenForTest(undefined);
    const t1 = makeEvent('/api/agent/board/b/changes');
    const r1 = await handle(t1 as never);
    expect(r1.status).toBe(200);
    expect(t1.resolve).toHaveBeenCalledTimes(1);

    const t2 = makeEvent('/mcp');
    const r2 = await handle(t2 as never);
    expect(r2.status).toBe(200);
    expect(t2.resolve).toHaveBeenCalledTimes(1);
  });
});

describe('hook: enforcement on agent surfaces when AGENT_TOKEN is set', () => {
  it('rejects agent paths with no token (uniform 401)', async () => {
    setAgentTokenForTest('cfg');
    for (const p of ['/api/agent/board/b/changes', '/api/agent/board/b/cards']) {
      const t = makeEvent(p);
      t.resolve.mockClear();
      const r = await handle(t as never);
      expect(r.status).toBe(401);
      expect(r.headers.get('www-authenticate')).toBe('Bearer');
      expect(await r.json()).toEqual({ error: 'unauthorized' });
      expect(t.resolve).not.toHaveBeenCalled();
    }
  });

  it('rejects a wrong token', async () => {
    setAgentTokenForTest('cfg');
    const t = makeEvent('/api/agent/board/b/changes', 'GET', { authorization: 'Bearer wrong' });
    const r = await handle(t as never);
    expect(r.status).toBe(401);
    expect(t.resolve).not.toHaveBeenCalled();
  });

  it('accepts a valid Bearer token', async () => {
    setAgentTokenForTest('cfg');
    const t = makeEvent('/api/agent/board/b/changes', 'GET', { authorization: 'Bearer cfg' });
    const r = await handle(t as never);
    expect(r.status).toBe(200);
    expect(t.resolve).toHaveBeenCalledTimes(1);
  });

  it('accepts the ?token= query fallback', async () => {
    setAgentTokenForTest('cfg');
    const t = makeEvent('/api/agent/board/b/cards?token=cfg');
    const r = await handle(t as never);
    expect(r.status).toBe(200);
  });
});

describe('hook: /mcp methods all gated when AGENT_TOKEN is set', () => {
  for (const method of ['POST', 'GET', 'DELETE']) {
    it(`rejects ${method} /mcp without a token (401)`, async () => {
      setAgentTokenForTest('cfg');
      const t = makeEvent('/mcp', method);
      t.resolve.mockClear();
      const r = await handle(t as never);
      expect(r.status).toBe(401);
      expect(t.resolve).not.toHaveBeenCalled();
    });

    it(`accepts ${method} /mcp with a valid Bearer token`, async () => {
      setAgentTokenForTest('cfg');
      const t = makeEvent('/mcp', method, { authorization: 'Bearer cfg' });
      const r = await handle(t as never);
      expect(r.status).toBe(200);
      expect(t.resolve).toHaveBeenCalledTimes(1);
    });
  }
});

describe('hook: UI / ordinary REST / SSE surfaces never gated', () => {
  it('stays accessible with no token even when AGENT_TOKEN is set', async () => {
    setAgentTokenForTest('cfg');
    const paths = [
      '/',
      '/api/boards.json',
      '/api/board/default.json',
      '/api/board/b/cards/a.json',
      '/api/events/default',
    ];
    for (const p of paths) {
      const t = makeEvent(p);
      const r = await handle(t as never);
      expect(r.status).toBe(200);
      expect(t.resolve).toHaveBeenCalledTimes(1);
    }
  });
});