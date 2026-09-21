// SvelteKit server hooks (spec §6.3; M-1 #4). Single transport-level auth gate
// that runs before any route/MCP dispatch and covers, uniformly:
//   - all /api/agent/* REST routes, and
//   - every /mcp method (POST/GET/DELETE, including the SSE GET stream).
// UI, ordinary REST, and browser SSE surfaces are never gated.
//
// Route handlers and the shared runtime (resolveSlug / boardRuntime) are left
// completely untouched and token-unaware — this hook is purely additive.

import type { Handle } from '@sveltejs/kit';
import {
  isAgentSurface,
  isAuthorized,
  unauthorizedResponse,
  warnIfAgentOpenOnNonLoopback,
} from '$lib/server/agent-auth';

// --- Boot warning (spec §6.1) -----------------------------------------------
// The agent surface is read-only and the deployment is LAN-only, so when
// AGENT_TOKEN is unset we stay default-open (including on non-loopback binds)
// rather than silently breaking existing curl scripts / the watcher loop. But
// that open state must never be silent: if auth is disabled AND we are bound to
// a non-loopback address, log a prominent WARN at boot.
const AGENT_HOST = process.env.AGENT_HOST ?? process.env.HOST ?? '0.0.0.0';
warnIfAgentOpenOnNonLoopback(AGENT_HOST);

// --- Auth gate (spec §6.2–6.3) ----------------------------------------------
// Guard shape: if (AGENT_TOKEN && isAgentSurface(pathname) && !authorized(req))
//   → return uniform 401; else `await resolve(event)`.
// The token is re-checked on EVERY request (no session-bound auth): MCP
// Streamable HTTP clients are expected to repeat the Authorization header on
// all follow-up POST/GET/DELETE calls, so per-request checking is both
// spec-aligned and the simplest correct behavior.
export const handle: Handle = async ({ event, resolve }) => {
  const pathname = event.url.pathname;
  if (isAgentSurface(pathname) && !isAuthorized(event.request)) {
    return unauthorizedResponse();
  }
  return resolve(event);
};