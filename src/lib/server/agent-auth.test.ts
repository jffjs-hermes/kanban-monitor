// Unit tests: shared AGENT_TOKEN auth helper (spec §6.2; M-1 #4).
// The helper reads env once at module load but exposes a test seam
// (setAgentTokenForTest), so each scenario toggles the configured token
// directly rather than re-importing.

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  extractToken,
  isAgentSurface,
  isAuthorized,
  isAuthEnabled,
  isLoopbackHost,
  secureEqual,
  setAgentTokenForTest,
  unauthorizedResponse,
  warnIfAgentOpenOnNonLoopback,
} from './agent-auth';

/** Build a Request with the given path + headers (used for extractToken/isAuthorized). */
function req(path: string, headers: Record<string, string> = {}) {
  return new Request(`http://test${path}`, { headers });
}

afterEach(() => {
  setAgentTokenForTest(undefined);
  vi.restoreAllMocks();
});

describe('extractToken', () => {
  it('returns the Bearer header token (primary)', () => {
    expect(extractToken(req('/mcp', { authorization: 'Bearer abc123' }))).toBe('abc123');
  });

  it('is case-insensitive for the Bearer scheme and trims whitespace', () => {
    expect(extractToken(req('/mcp', { authorization: 'bearer   spaced-token  ' }))).toBe('spaced-token');
  });

  it('returns the ?token= query param as a fallback when no header', () => {
    expect(extractToken(req('/api/agent/x?token=querytok'))).toBe('querytok');
  });

  it('returns null when neither a Bearer header nor ?token= is present', () => {
    expect(extractToken(req('/mcp'))).toBeNull();
    expect(extractToken(req('/api/agent/x', { authorization: 'Basic dXNlcjpwYXNz' }))).toBeNull();
  });

  it('returns null for a malformed header (no scheme match)', () => {
    expect(extractToken(req('/mcp', { authorization: 'Bearer' }))).toBeNull();
  });
});

describe('secureEqual (constant-time digest comparison)', () => {
  it('accepts equal tokens', () => {
    expect(secureEqual('s3cret-value', 's3cret-value')).toBe(true);
  });

  it('rejects different tokens', () => {
    expect(secureEqual('s3cret-value', 's3cret-wrong')).toBe(false);
    expect(secureEqual('', 'x')).toBe(false);
  });

  it('compares via SHA-256 digest (timing-safe even for unequal raw lengths)', () => {
    // Raw token lengths differ, but the SHA-256 digests are both 32 bytes, so
    // timingSafeEqual is always well-formed and rejects correctly.
    expect(secureEqual('short', 'a-considerably-longer-secret')).toBe(false);
  });
});

describe('isAgentSurface', () => {
  it('flags /api/agent/* and /mcp', () => {
    expect(isAgentSurface('/mcp')).toBe(true);
    expect(isAgentSurface('/api/agent/board/default/changes')).toBe(true);
    expect(isAgentSurface('/api/agent/board/b/cards')).toBe(true);
  });

  it('never flags UI, ordinary REST, or SSE surfaces', () => {
    expect(isAgentSurface('/')).toBe(false);
    expect(isAgentSurface('/api/boards.json')).toBe(false);
    expect(isAgentSurface('/api/board/default.json')).toBe(false);
    expect(isAgentSurface('/api/board/b/cards/a.json')).toBe(false);
    expect(isAgentSurface('/api/events/default')).toBe(false);
  });
});

describe('isLoopbackHost', () => {
  it('recognizes loopback binds', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('127.0.0.2')).toBe(true);
  });

  it('does not recognize non-loopback binds', () => {
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
    expect(isLoopbackHost('192.168.1.236')).toBe(false);
    expect(isLoopbackHost('*')).toBe(false);
  });
});

describe('unauthorizedResponse', () => {
  it('is a uniform 401 JSON with WWW-Authenticate: Bearer', async () => {
    const res = unauthorizedResponse();
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });
});

describe('default-open when AGENT_TOKEN is unset', () => {
  it('auth is disabled and authorizes agent surfaces without any credentials', () => {
    setAgentTokenForTest(undefined);
    expect(isAuthEnabled()).toBe(false);
    expect(isAuthorized(req('/api/agent/board/b/changes'))).toBe(true);
    expect(isAuthorized(req('/mcp'))).toBe(true);
  });
});

describe('enforcement when AGENT_TOKEN is set', () => {
  it('isAuthEnabled is true and a valid Bearer is accepted', () => {
    setAgentTokenForTest('config-token');
    expect(isAuthEnabled()).toBe(true);
    expect(isAuthorized(req('/mcp', { authorization: 'Bearer config-token' }))).toBe(true);
    expect(isAuthorized(req('/api/agent/board/b/changes', { authorization: 'Bearer config-token' }))).toBe(true);
  });

  it('accepts the ?token= query fallback', () => {
    setAgentTokenForTest('config-token');
    expect(isAuthorized(req('/api/agent/board/b/changes?token=config-token'))).toBe(true);
    expect(isAuthorized(req('/mcp?token=config-token'))).toBe(true);
  });

  it('rejects a wrong token', () => {
    setAgentTokenForTest('config-token');
    expect(isAuthorized(req('/mcp', { authorization: 'Bearer wrong' }))).toBe(false);
    expect(isAuthorized(req('/api/agent/x?token=wrong'))).toBe(false);
  });

  it('rejects a missing token', () => {
    setAgentTokenForTest('config-token');
    expect(isAuthorized(req('/mcp'))).toBe(false);
    expect(isAuthorized(req('/api/agent/board/b/cards'))).toBe(false);
  });
});

describe('warnIfAgentOpenOnNonLoopback (boot warning, spec §6.1)', () => {
  it('warns when AGENT_TOKEN is unset on a non-loopback bind', () => {
    setAgentTokenForTest(undefined);
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(warnIfAgentOpenOnNonLoopback('0.0.0.0')).toBe(true);
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining('agent surfaces open (no AGENT_TOKEN) on non-loopback bind'),
    );
  });

  it('does not warn on a loopback bind', () => {
    setAgentTokenForTest(undefined);
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(warnIfAgentOpenOnNonLoopback('127.0.0.1')).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('does not warn when AGENT_TOKEN is set (even on non-loopback)', () => {
    setAgentTokenForTest('cfg');
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(warnIfAgentOpenOnNonLoopback('0.0.0.0')).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });
});