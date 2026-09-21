// SvelteKit server hooks (spec §6.3-§6.4; M-1 #4). Single transport-level auth
// gate that runs before any route/MCP dispatch and covers, uniformly:
//   - all /api/agent/* REST routes,
//   - every /mcp method (POST/GET/DELETE, including the MCP SSE GET stream), and
//   - the reserved sensitive-read namespace /api/transcripts/* (future card
//     transcript viewer — the parented card inherits this gate for free).
// UI, ordinary REST, and browser SSE surfaces are never gated.
//
// Deny semantics (spec §6.4 forward rule): when AGENT_TOKEN is unset the agent
// and sensitive surfaces are DENIED (401) on a non-loopback bind — not opened
// with a warning. Only a loopback bind (developer default) stays open. When the
// token IS set, the behaviour is the existing approved gate: Bearer (or debug
// ?token=) required on every protected route.
//
// Route handlers and the shared runtime (resolveSlug / boardRuntime) are left
// completely untouched and token-unaware — this hook is purely additive.

import type { Handle } from '@sveltejs/kit';
import {
  shouldDenyProtectedSurface,
  unauthorizedResponse,
  warnIfDenyingOnNonLoopback,
} from '$lib/server/agent-auth';

// --- Boot warning (spec §6.1/§6.4) ------------------------------------------
// If auth is disabled AND we are bound to a non-loopback address, protected
// surfaces are being denied by default — that denial must never be silent, so
// log a prominent WARN at boot. No-op on a loopback bind or when a token is set.
warnIfDenyingOnNonLoopback();

// --- Auth gate (spec §6.2-§6.4) ---------------------------------------------
// Guard shape: if (isProtectedSurface(pathname) && shouldDenyProtectedSurface(req))
//   → return uniform 401; else `await resolve(event)`.
// The token is re-checked on EVERY request (no session-bound auth): MCP
// Streamable HTTP clients are expected to repeat the Authorization header on
// all follow-up POST/GET/DELETE calls, so per-request checking is both
// spec-aligned and the simplest correct behavior.
export const handle: Handle = async ({ event, resolve }) => {
  if (shouldDenyProtectedSurface(event.url.pathname, event.request)) {
    return unauthorizedResponse();
  }
  return resolve(event);
};