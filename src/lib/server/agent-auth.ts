// Shared AGENT_TOKEN auth foundation for agent/sensitive surfaces (spec §6.1–6.3;
// M-1 #4). One helper owns the "is this request authorized?" decision so the
// SvelteKit hook and every future gate share a single, uniform implementation.
//
// Contract (spec §6.2, §6.4 forward rule):
//   - AGENT_TOKEN and the bind host (AGENT_HOST ?? HOST ?? '0.0.0.0') are read at
//     module load into `configuredToken` / `configuredHost` — the single sources
//     of truth; no per-route env reads.
//   - When AGENT_TOKEN is unset AND the bind is NON-loopback → DEFAULT-DENY:
//     protected surfaces return 401 and are never reachable without a token.
//     A loud boot WARN (`warnIfDenyingOnNonLoopback`) makes the missing token
//     visible instead of silent.
//   - When AGENT_TOKEN is unset AND the bind is loopback (127.0.0.1/localhost/::1)
//     → default-open (developer convenience; documented as such).
//   - When set → every protected surface (/api/agent/*, /mcp, and the reserved
//     sensitive-read namespace) requires `Authorization: Bearer *** (primary)
//     or the debug-only `?token=` query param (fallback). Missing vs wrong
//     credentials produce the same uniform 401 (don't reveal which failed).
//   - Constant-time compare: SHA-256 digest of both values, then
//     crypto.timingSafeEqual (Node-compatible in Bun). Digesting first sidesteps
//     the length-mismatch leak that makes timingSafeEqual on raw strings unsafe.

import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Configured agent token, read from env once at module load.
 * `undefined` (or empty) → default-open on loopback, default-deny on non-loopback.
 */
let configuredToken: string | undefined = process.env.AGENT_TOKEN;

/**
 * Bind host, read from env once at module load. Used to decide whether failing
 * to configure AGENT_TOKEN is tolerated (loopback) or a hard denial (non-loopback).
 */
let configuredHost: string = process.env.AGENT_HOST ?? process.env.HOST ?? '0.0.0.0';

/**
 * Test seam: swap the configured token at runtime. The production path never
 * calls this — it is only used by unit tests to exercise the set and unset
 * states without re-importing the module. Never read in production code.
 */
export function setAgentTokenForTest(token: string | undefined): void {
  configuredToken = token;
}

/**
 * Test seam: swap the bind host at runtime (parallel to setAgentTokenForTest).
 * Used by unit tests to exercise loopback vs non-loopback denial deterministically.
 */
export function setAgentHostForTest(host: string): void {
  configuredHost = host;
}

/** True when agent-surface auth is enforced (a token is configured). */
export function isAuthEnabled(): boolean {
  return Boolean(configuredToken);
}

/**
 * Extract the presented credentials from a request:
 * `Authorization: Bearer *** (primary) or `?token=<token>` (debug-only
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
 * Credential-level authorization. Returns true when auth is disabled
 * (default-open on a loopback bind) or when valid Bearer / ?token= credentials
 * are presented. This is the per-credential check only — combine it with
 * `isDefaultDenyOnNonLoopback()` (via `shouldDenyProtectedSurface`) to decide
 * a surface's access, because an unset token is NOT open on a non-loopback bind.
 */
export function isAuthorized(request: Request): boolean {
  if (!configuredToken) return true; // default-open only on loopback (see gate)
  const presented = extractToken(request);
  if (presented === null) return false;
  return secureEqual(presented, configuredToken);
}

/**
 * True when the pathname is an agent surface that must be gated when auth is
 * enabled or default-deny applies: the /api/agent/* REST routes and /mcp (all
 * methods). UI, ordinary REST, and browser SSE surfaces are never gated.
 */
export function isAgentSurface(pathname: string): boolean {
  return pathname === '/mcp' || pathname.startsWith('/api/agent/');
}

/**
 * True when the pathname is a raw/sensitive-read surface that must inherit the
 * same gate as agent surfaces. Reserved for the upcoming card-transcript
 * viewer: the future transcript route will live under `/api/transcripts/*` (and
 * also `/api/agent/board/<slug>/transcripts...` for the agent-API-adjacent
 * form), so it is default-denied on non-loopback long before the endpoint that
 * serves it lands. Currently no such route is registered — this matcher exists
 * so the parented viewer card inherits enforcement without touching the hook.
 */
export function isSensitiveSurface(pathname: string): boolean {
  if (pathname.startsWith('/api/transcripts/')) return true;
  return /^\/api\/agent\/board\/[^/]+\/transcripts(\/.*)?$/.test(pathname);
}

/**
 * True when any protected surface path is matched: agent surfaces plus the
 * reserved sensitive-transcript namespace.
 */
export function isProtectedSurface(pathname: string): boolean {
  return isAgentSurface(pathname) || isSensitiveSurface(pathname);
}

/**
 * True when protected surfaces must be denied even with no token configured —
 * i.e. AGENT_TOKEN unset AND the bind is non-loopback (spec §6.4 forward rule).
 */
export function isDefaultDenyOnNonLoopback(): boolean {
  return !isAuthEnabled() && !isLoopbackHost(configuredHost);
}

/**
 * The complete per-request gate decision for a surface: returns true when the
 * request must be rejected with the uniform 401, false when it may proceed.
 *   - not a protected surface            → false (UI/ordinary-REST/SSE never gated)
 *   - token set, bad/missing credentials  → true
 *   - token set, valid credentials        → false
 *   - token unset, loopback bind          → false (open, developer default)
 *   - token unset, non-loopback bind      → true (DEFAULT-DENY)
 */
export function shouldDenyProtectedSurface(pathname: string, request: Request): boolean {
  if (!isProtectedSurface(pathname)) return false;
  // isAuthorized covers valid credentials (or open-on-loopback). The only
  // remaining allow-override is open-on-loopback; anything else that passes
  // `isAuthorized` (unset + non-loopback) must be force-denied below.
  if (!isAuthorized(request)) return true;
  return isDefaultDenyOnNonLoopback();
}

/**
 * The uniform 401 used for missing/wrong credentials or default-deny across
 * every gated route. Same body for missing as for wrong — never reveal which.
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
 * True when a host string is a loopback bind. Used to distinguish the developer
 * default (open allowed) from a production/LAN bind (deny when unset).
 */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.startsWith('127.');
}

/**
 * Emit the prominent boot WARN when protected surfaces are being DENIED because
 * AGENT_TOKEN is unset on a non-loopback bind (spec §6.1/§6.4). No-op when auth
 * is enabled or the bind is loopback. Returns true when a warning was emitted.
 */
export function warnIfDenyingOnNonLoopback(): boolean {
  if (isAuthEnabled()) return false;
  if (isLoopbackHost(configuredHost)) return false;
  console.warn(
    `agent surfaces DENIED on non-loopback bind (${configuredHost}) — AGENT_TOKEN is unset; ` +
      'set AGENT_TOKEN to authorize /api/agent/*, /mcp, and sensitive reads',
  );
  return true;
}