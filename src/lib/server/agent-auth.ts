// Shared AGENT_TOKEN auth foundation for agent-facing surfaces (spec §6.1–6.3;
// M-1 #4). One helper owns the "is this request authorized?" decision so the
// SvelteKit hook and every future gate share a single, uniform implementation.
//
// Contract (spec §6.2):
//   - AGENT_TOKEN is read at module load into `configuredToken` — the single
//     source of truth; no per-route env reads.
//   - When AGENT_TOKEN is unset → DEFAULT-OPEN: agent surfaces are open,
//     including on non-loopback binds. The boot WARN that makes this visible is
//     emitted by `warnIfAgentOpenOnNonLoopback`, called from hooks.server.ts.
//   - When set → /api/agent/* and every /mcp method (POST/GET/DELETE) require
//     `Authorization: Bearer <token>` (primary) or the debug-only `?token=`
//     query param (fallback). Missing vs wrong credentials produce the same
//     uniform 401 (don't reveal which failed).
//   - Constant-time compare: SHA-256 digest of both values, then
//     crypto.timingSafeEqual (Node-compatible in Bun). Digesting first sidesteps
//     the length-mismatch leak that makes timingSafeEqual on raw strings unsafe.

import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Configured agent token, read from env once at module load.
 * `undefined` (or empty) → default-open.
 */
let configuredToken: string | undefined = process.env.AGENT_TOKEN;

/**
 * Test seam: swap the configured token at runtime. The production path never
 * calls this — it is only used by unit tests to exercise both the set and
 * unset states without re-importing the module. Never read in production code.
 */
export function setAgentTokenForTest(token: string | undefined): void {
  configuredToken = token;
}

/** True when agent-surface auth is enforced (a token is configured). */
export function isAuthEnabled(): boolean {
  return Boolean(configuredToken);
}

/**
 * Extract the presented credentials from a request:
 * `Authorization: Bearer <token>` (primary) or `?token=<token>` (debug-only
 * fallback). Returns null when neither is present.
 */
export function extractToken(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (header) {
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (match) return match[1].trim();
  }
  const queryToken = new URL(request.url).searchParams.get('token');
  if (queryToken) return queryToken;
  return null;
}

/**
 * Constant-time secret comparison via SHA-256 digest + timingSafeEqual.
 * Both digests are 32 bytes, so timingSafeEqual is always well-formed regardless
 * of the input token lengths.
 */
export function secureEqual(a: string, b: string): boolean {
  const da = createHash('sha256').update(a, 'utf8').digest();
  const db = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(da, db);
}

/**
 * Whether a request is authorized for agent surfaces. Returns true when auth is
 * disabled (default-open), and otherwise requires valid Bearer or ?token=
 * credentials.
 */
export function isAuthorized(request: Request): boolean {
  if (!configuredToken) return true; // default-open when AGENT_TOKEN unset
  const presented = extractToken(request);
  if (presented === null) return false;
  return secureEqual(presented, configuredToken);
}

/**
 * True when the pathname is an agent surface that must be gated when auth is
 * enabled: the /api/agent/* REST routes and /mcp (all methods). UI, ordinary
 * REST, and browser SSE surfaces are never gated.
 */
export function isAgentSurface(pathname: string): boolean {
  return pathname === '/mcp' || pathname.startsWith('/api/agent/');
}

/**
 * The uniform 401 used for missing/wrong credentials across every gated route.
 * Same body for missing as for wrong — never reveal which one failed.
 */
export function unauthorizedResponse(): Response {
  return new Response(JSON.stringify({ error: 'unauthorized' }), {
    status: 401,
    headers: {
      'content-type': 'application/json',
      'www-authenticate': 'Bearer',
    },
  });
}

/**
 * True when a host string is a loopback bind. Used by the boot warning to avoid
 * nagging operators who are already bound to loopback-only.
 */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.startsWith('127.');
}

/**
 * Emit the prominent boot WARN when agent surfaces are open with no AGENT_TOKEN
 * on a non-loopback bind (spec §6.1). No-op when auth is enabled or the bind is
 * loopback. Returns true when a warning was emitted.
 */
export function warnIfAgentOpenOnNonLoopback(host: string): boolean {
  if (isAuthEnabled()) return false;
  if (isLoopbackHost(host)) return false;
  console.warn(
    'agent surfaces open (no AGENT_TOKEN) on non-loopback bind — set AGENT_TOKEN to restrict',
  );
  return true;
}