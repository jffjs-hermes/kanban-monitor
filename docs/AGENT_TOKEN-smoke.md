# AGENT_TOKEN deployment smoke test — evidence (t_0ba8eddd)

Recorded 2026-09-21 against the **built** app (`bun run build`, adapter-node)
launched with `bun build/index.js` on throwaway ports. Throwaway token
(`openssl rand -hex 32`), used only in this run and scrubbed afterward; no real
secret appears anywhere in this file.

## Board

`BOARD=kanban-monitor HERMES_HOME=/home/jeff/.hermes` (live board DB).

## With `AGENT_TOKEN` set (port 8899, HOST=0.0.0.0)

Verified via a Python HTTP client (urllib) against the live server. Pass/fail
counts are from a 13-assertion run: 13/13 PASS.

| Surface | Request | Result |
|---|---|---|
| REST `changes?since=0` | no token | `401` + `WWW-Authenticate: Bearer` + `{"error":"unauthorized"}` |
| REST `changes?since=0` | `Authorization: Bearer <wrong>` | `401` (same uniform body) |
| REST `changes?since=0` | `Authorization: Bearer <valid>` | `200` + snapshot (`revision`, `changes`) |
| REST `changes?since=0` | valid Bearer twice | `200`, `200` (repeated valid Bearer OK) |
| REST `cards?stalled=true` | no token | `401` |
| REST `cards?stalled=true` | valid Bearer | `200` |
| REST `changes?since=0&token=<valid>` | `?token=` fallback | `200` (debug-only path works) |
| UI data `/api/boards.json` | no token | `200` (ungated) |
| browser SSE `/api/events/kanban-monitor` | no token | `200 text/event-stream` (ungated) |
| MCP `initialize` (POST) | no token | `401` + `WWW-Authenticate` |
| MCP `initialize` (POST) | valid Bearer | `200` + `Mcp-Session-Id` |
| MCP `tools/list` (POST, same session) | valid Bearer + session id | `200`, `read_board` present |
| MCP `tools/list` (POST, same valid session) | **no** auth header | `401` (session does not mint auth) |
| MCP GET SSE (same session) | no auth | `401` immediately (gate on GET) |

Notes: MCP Streamable HTTP requires `Accept: application/json,
text/event-stream` (else the SDK returns 406). The authenticated GET SSE holds
the stream open per Streamable HTTP semantics (no server messages to push); its
200 text/event-stream behavior is covered by the integration suite (185 tests,
0 fail). A wrong token and a missing one return the same body — the server
never reveals which failed.

## No `AGENT_TOKEN` (default-open + boot warning)

| Bind | Server log | Agent surface (no token) |
|---|---|---|
| `HOST=0.0.0.0` (port 8898) | `agent surfaces open (no AGENT_TOKEN) on non-loopback bind — set AGENT_TOKEN to restrict` then `Listening on http://0.0.0.0:8898` | REST `changes?since=0` → `200`; MCP `initialize` → `200` |
| `HOST=127.0.0.1` (port 8897) | `Listening on http://127.0.0.1:8897` (WARN suppressed on loopback) | — |

## Static checks

`bun run check` → 0 errors (1 pre-existing svelte warning)
`bun run test`  → 185 pass / 0 fail
`bun run build` → ok (`gate present in built hooks.server.js`)