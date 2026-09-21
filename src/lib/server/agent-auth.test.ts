// Unit tests: shared AGENT_TOKEN auth helper (spec §6.2/§6.4; M-1 #4).
// The helper reads env once at module load but exposes a test seam
// (setAgentTokenForTest / setAgentHostForTest), so each scenario toggles the
// configured token and bind host directly rather than re-importing.

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  extractToken,
  isAgentSurface,
  isAuthorized,
  isAuthEnabled,
  isDefaultDenyOnNonLoopback,
  isLoopbackHost,
  isProtectedSurface,
  isSensitiveSurface,
  secureEqual,
  setAgentHostForTest,
  setAgentTokenForTest,
  shouldDenyProtectedSurface,
  unauthorizedResponse,
  warnIfDenyingOnNonLoopback,
} from './agent-auth';

/** Build a Request with the given path + headers (used for extractToken/isAuthorized). */
function req(path: string, headers: Record<string, string> = {}) {
  return new Request(`http://test${path}`, { headers });
}

afterEach(() => {
  setAgentTokenForTest(undefined);
  // Reset bind to the production default so tests never leak host state.
  setAgentHostForTest('0.0.0.0');
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

describe('isSensitiveSurface (reserved card-transcript namespace, spec §6.4)', () => {
  it('flags the reserved /api/transcripts/* namespace', () => {
    expect(isSensitiveSurface('/api/transcripts/board/default')).toBe(true);
    expect(isSensitiveSurface('/api/transcripts/board/default/run/42')).toBe(true);
  });

  it('flags the agent-API-adjacent transcript form', () => {
    expect(isSensitiveSurface('/api/agent/board/default/transcripts')).toBe(true);
    expect(isSensitiveSurface('/api/agent/board/default/transcripts/42')).toBe(true);
  });

  it('never flags agent summaries, ordinary REST, UI, or SSE', () => {
    expect(isSensitiveSurface('/api/agent/board/default/changes')).toBe(false);
    expect(isSensitiveSurface('/api/agent/board/default/cards')).toBe(false);
    expect(isSensitiveSurface('/api/boards.json')).toBe(false);
    expect(isSensitiveSurface('/')).toBe(false);
    expect(isSensitiveSurface('/api/events/default')).toBe(false);
  });
});

describe('isProtectedSurface', () => {
  it('is the union of agent and sensitive surfaces', () => {
    expect(isProtectedSurface('/mcp')).toBe(true);
    expect(isProtectedSurface('/api/agent/board/b/changes')).toBe(true);
    expect(isProtectedSurface('/api/transcripts/board/b/run/1')).toBe(true);
    expect(isProtectedSurface('/api/agent/board/b/transcripts/1')).toBe(true);
  });

  it('never flags unprotected surfaces', () => {
    expect(isProtectedSurface('/')).toBe(false);
    expect(isProtectedSurface('/api/boards.json')).toBe(false);
    expect(isProtectedSurface('/api/board/default.json')).toBe(false);
    expect(isProtectedSurface('/api/events/default')).toBe(false);
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

describe('isDefaultDenyOnNonLoopback', () => {
  it('false when a token is set (auth enabled) even on non-loopback', () => {
    setAgentTokenForTest('cfg');
    setAgentHostForTest('0.0.0.0');
    expect(isDefaultDenyOnNonLoopback()).toBe(false);
  });

  it('false when token unset on a loopback bind', () => {
    setAgentTokenForTest(undefined);
    setAgentHostForTest('127.0.0.1');
    expect(isDefaultDenyOnNonLoopback()).toBe(false);
  });

  it('true when token unset on a non-loopback bind (default-deny)', () => {
    setAgentTokenForTest(undefined);
    setAgentHostForTest('0.0.0.0');
    expect(isDefaultDenyOnNonLoopback()).toBe(true);
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

describe('default-open when AGENT_TOKEN is unset on a LOOPBACK bind', () => {
  it('auth is disabled and authorizes agent surfaces without any credentials', () => {
    setAgentTokenForTest(undefined);
    setAgentHostForTest('127.0.0.1');
    expect(isAuthEnabled()).toBe(false);
    expect(isAuthorized(req('/api/agent/board/b/changes'))).toBe(true);
    expect(isAuthorized(req('/mcp'))).toBe(true);
    // The surface-level gate honours the loopback open default.
    expect(shouldDenyProtectedSurface('/mcp', req('/mcp'))).toBe(false);
  });
});

describe('default-DENY when AGENT_TOKEN is unset on a NON-loopback bind (spec §6.4)', () => {
  it('denies agent, MCP, and sensitive surfaces without credentials', () => {
    setAgentTokenForTest(undefined);
    setAgentHostForTest('0.0.0.0');
    for (const p of [
      '/api/agent/board/b/changes',
      '/api/agent/board/b/cards',
      '/mcp',
      '/api/transcripts/board/b/run/1',
      '/api/agent/board/b/transcripts/1',
    ]) {
      expect(shouldDenyProtectedSurface(p, req(p))).toBe(true);
    }
  });

  it('still allows UI / ordinary REST / SSE surfaces without credentials', () => {
    setAgentTokenForTest(undefined);
    setAgentHostForTest('0.0.0.0');
    for (const p of ['/', '/api/boards.json', '/api/board/default.json', '/api/events/default']) {
      expect(shouldDenyProtectedSurface(p, req(p))).toBe(false);
    }
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

  it('surface gate: valid token allows on non-loopback, invalid denies', () => {
    setAgentTokenForTest('cfg');
    setAgentHostForTest('0.0.0.0');
    expect(shouldDenyProtectedSurface('/mcp', req('/mcp', { authorization: 'Bearer cfg' }))).toBe(false);
    expect(shouldDenyProtectedSurface('/api/agent/board/b/changes', req('/api/agent/board/b/changes'))).toBe(true);
    expect(shouldDenyProtectedSurface('/api/transcripts/board/b/run/1', req('/api/transcripts/board/b/run/1', { authorization: 'Bearer cfg' }))).toBe(false);
  });

  it('surface gate: UI is never denied on non-loopback even without a token header', () => {
    setAgentTokenForTest('cfg');
    setAgentHostForTest('0.0.0.0');
    expect(shouldDenyProtectedSurface('/api/events/default', req('/api/events/default'))).toBe(false);
    expect(shouldDenyProtectedSurface('/', req('/'))).toBe(false);
  });
});

describe('warnIfDenyingOnNonLoopback (boot warning, spec §6.1/§6.4)', () => {
  it('warns when AGENT_TOKEN is unset on a non-loopback bind (denial is active)', () => {
    setAgentTokenForTest(undefined);
    setAgentHostForTest('0.0.0.0');
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(warnIfDenyingOnNonLoopback()).toBe(true);
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining('agent surfaces DENIED on non-loopback bind'),
    );
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('set AGENT_TOKEN'));
  });

  it('does not warn on a loopback bind', () => {
    setAgentTokenForTest(undefined);
    setAgentHostForTest('127.0.0.1');
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(warnIfDenyingOnNonLoopback()).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('does not warn when AGENT_TOKEN is set (even on non-loopback)', () => {
    setAgentTokenForTest('cfg');
    setAgentHostForTest('0.0.0.0');
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(warnIfDenyingOnNonLoopback()).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });
});