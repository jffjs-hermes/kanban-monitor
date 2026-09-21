# Feature Spec — Board-state API for agents (MCP + forgiving REST)

**Status:** Draft for review (rewrite; supersedes the garbled draft)
**Project:** kanban-monitor (SvelteKit on Bun)
**Locked decision (Jeff, 2026-09-19):** **Both** — the kanban-monitor process exposes an **MCP server** (primary agent interface) *and* keeps/resumes **plain REST** (browser + scripts). One process, two surfaces, shared machinery.

---

## 1. Problem & goal

A Hermes agent (bot team, operator, or a profile that doesn't carry native `kanban_*` tools) has no clean way to *read* current kanban board state over a standard agent interface and react to it. The kanban-monitor process serves a browser UI; its SSE stream gives each browser connection a private per-client cursor, and there is no addressable, resumable position a machine can poll. Today an agent must either re-fetch the full snapshot and diff locally, or run a separate watcher process that double-polls and double-reads the sqlite DB — the "separate process" this feature eliminates.

**Goal:** the *same* kanban-monitor process exposes a **cursor-based, resumable board-state surface over both protocols** — an **MCP server** exposing the derived monitoring view (cards, status, assignee, liveness/stalled, deltas, revisions, card detail incl. PR metadata) as native agent tools/resources, plus the existing **REST** API (snapshot + a new `/changes?since=` cursor endpoint) for scripts and the UI. An agent or script can poll cheaply and resumably from `revision` to `revision`, no separate process, no double DB read.

**Non-goals (MVP):** read-only — observe, don't mutate (no claim/transition/block/comment through this surface in this increment). Mutating actions, if wanted, are a separate feature.

---

## 2. Consumers & protocol mapping

| Consumer | Interface | Surface | Value |
|---|---|---|---|
| Hermes LLM agents (lead/builder/reviewer/operator, incl. profiles without kanban tools) | **MCP** | `read_board`, `list_changes`, `get_card`, `list_boards` as tools; optional board resources | derived view as native tools; reaction without a fetch loop |
| Scripts / cron / non-LLM tooling | **REST** | `GET /api/board/[slug].json` (+`revision`), `GET /api/agent/board/[slug]/changes?since=` | curl-able, language-agnostic, cacheable |
| Browser UI (unchanged) | **REST + SSE** (as today) | `/api/boards.json`, `/api/board/[slug].json`, `/api/events/[slug]` | live view |

The **revision + delta model (§3) is shared** across all three; only the transport/delivery differs.

---

## 3. Architecture (reuse, don't re-read)

The server already has the machinery: `poller` polls the board DB each tick, `differ` computes `DeltaScope` (`summary` / `cards` upserts+removedIds / `card` / `reset`), and `runtime` holds the latest `BoardSnapshot` per board with `lastSyncedAt`. This feature adds a **per-board monotonic revision** and delivers deltas over two transports — reusing the diff, never reading sqlite twice.

### 3.1 Global monotonic board revision

- Add `revision: number` to `BoardSnapshot` (today: `slug`/`summary`/`cards`).
- The runtime owns one monotonically increasing counter per board, bumped by **exactly +1 per non-trivial delta** the poller publishes.
- SSE's per-client `seq` is untouched (private to SSE framing). The revision is the *board-addressable* cursor both MCP and REST read from — so an MCP tool call and a REST call see the same position.

### 3.2 Shared delta buffer (resumability without re-scan)

- Keep a bounded **per-board ring buffer** of recent `(revisionAfter, DeltaScope)` entries (e.g. last 256 / ~5 min) so a client can rebuild from its last `revision` without re-reading the DB.
- Buffer miss or DB swap → degrade to a `reset` (full snapshot) delta. Cheap and correct; matches the existing `reset` semantic.
- Empty board / no change → 200 with an empty `changes` and unchanged `revision` (idle ~0 cost, no DB wake).

### 3.3 Caller-visible fields (react the way the operator does)

Already present and exposed as-is in both surfaces: `summary.stalledCount`, per-card `liveness` (`active`/`stalled`/null), `CardView.{assignee, priority, status, parentIds, childIds, runCount, lastOutcome, elapsedMs, createdAt}`; `CardDetail.{runs, comments, transitions, body, card}`. Nothing new to compute — the derived monitoring view already exists; we're just delivering it over a standard interface.

---

## 4. MCP server (primary agent interface)

### 4.1 Transport & placement
- **MCP Streamable HTTP** transport, served by the same SvelteKit/Bun process (e.g. `/mcp` route on the existing port, or a documented dedicated port). One process — the "no separate process" goal holds literally.
- No new runtime dependency beyond an MCP SDK/package (decide `@modelcontextprotocol/sdk`; zero DB deps). The MCP layer calls into the same `boardRuntime`.

### 4.2 Tools (MVP)
| Tool | Input → Output |
|---|---|
| `list_boards` | → slugs available (reuses REST discovery) |
| `read_board(slug?)` | → `BoardSnapshot` (full: summary + cards) including `revision` |
| `list_changes(slug?, since)` | → `{revision, changes:[DeltaScope]}` (since=0 → snapshot init/reset) |
| `get_card(slug?, id)` | → `CardDetail` (runs, comments, transitions, body, PR metadata) |

### 4.3 Resources (optional, cheap)
- `board://{slug}/snapshot` and `board://{slug}/card/{id}` as read-only resources, so agent frameworks that read resources by URI get board context without tool-call plumbing. Mark optional for MVP.

### 4.4 Agent example (doc, not impl)
```
rev = 0
loop:
  {revision, changes} = MCP.list_changes(slug="kanban-monitor", since=rev)
  for c in changes:
     if any(c.cards.upserts.liveness == 'stalled')  -> notify operator
     if c.summary?.stalledCount > 0                 -> flag
     if card moved to status=='review' && assignee==me -> act (via normal kanban tools)
  rev = revision
  sleep 2s
```

---

## 5. REST (kept; minimal additions)

| Endpoint | Change |
|---|---|
| `GET /api/boards.json` | unchanged |
| `GET /api/board/[slug].json` | **+`revision`** in payload (non-breaking addition) |
| `GET /api/agent/board/[slug]/changes?since=REV` | **new** — `{revision, changes:[DeltaScope]}`; resumable cursor poll |
| `GET /api/agent/board/[slug]/cards?assignee=X&stalled=true` | **new** (cheap filtered query) |
| `GET /api/board/[slug]/cards/[id].json` | unchanged (detail) |
| `GET /api/events/[slug]` | unchanged (live browser SSE) |

Semantics identical to §3.2: `since=0`→snapshot; `since=REV`→deltas after it; buffer miss→`reset`; unknown board→404 (reuse runtime `select`). No breaking renames — the UI is untouched.

---

## 6. Auth & deployment (MVP)

Default bind stays `0.0.0.0` (LAN) as today. The surface is **read-only**, so exposure risk is limited, but agent-facing endpoints are a real surface.

### 6.1 Resolution (research pass, 2026-09-21): default-open when `AGENT_TOKEN` unset, with a loud boot warning

- **Default-open stays the behavior when `AGENT_TOKEN` is unset**, including on non-loopback binds. Rationale:
  - The surface is read-only (locked decision §10.2); the worst-case exposure is board metadata, and the deployment is LAN-only behind the home network.
  - Default-deny would silently break every existing curl script and the §4.4 watcher loop with a 401 the operator didn't anticipate — failure mode is a mysteriously-stalled agent, not an obvious one.
  - Compromise that makes the open state *visible*: at process boot, if `AGENT_TOKEN` is unset and the bind is non-loopback (`0.0.0.0`/host IP), log a prominent WARN: `agent surfaces open (no AGENT_TOKEN) on non-loopback bind — set AGENT_TOKEN to restrict`. This satisfies "open on LAN, but never open by accident/silently."
- **If a future write surface (claim/transition) lands, default-deny becomes mandatory** — write access must never be unauthenticated, so at that point unset `AGENT_TOKEN` ⇒ agent write routes disabled (reads may stay open or stay token-gated as decided then). This is recorded now so the write feature inherits an explicit rule.
- Optional hardening knob (not MVP): `AGENT_BIND=loopback` to force loopback-only binding if the operator wants a no-token-secure mode. Deferred.

### 6.2 `AGENT_TOKEN` enforcement when set

- Read from `process.env.AGENT_TOKEN` once at module load (Bun runtime; single source of truth — no per-route env reads).
- **Scope**: all `/api/agent/*` routes and **all methods** of `/mcp` (POST, GET, DELETE). Browser/REST/SSE surfaces (`/api/boards.json`, `/api/board/*`, `/api/events/*`, `/`) are **never** gated — the UI must keep working with no token.
- **Accepted credentials**: `Authorization: Bearer <token>` header (primary), or `?token=<token>` query param (fallback for curl-quick testing; discouraged — tokens in URLs leak into access logs/history; document as debug convenience only).
- **Failure semantics**: missing/incorrect token → `401` with `WWW-Authenticate: Bearer` and a short JSON error. For `/mcp`, this applies to `initialize` (a fresh POST with no `Mcp-Session-Id`) — an unauthenticated client simply cannot establish a session. Return the same 401 body shape for a wrong token as for a missing one (don't reveal which failed).
- **Constant-time compare**: never `===` on raw tokens. Compare SHA-256 digests of both the presented token and the configured token with `crypto.timingSafeEqual` (Node compat in Bun) — digesting first sidesteps the length-mismatch leak that makes timingSafeEqual on raw strings unusable. One shared helper in `src/lib/server/agent-auth.ts`.

### 6.3 Implementation approach (research conclusion)

- **Gate location: a new `src/hooks.server.ts` `handle()`** — the project currently has none, and it is the right hook rather than per-route guards:
  - One gate covers all four surfaces uniformly (both REST agent routes, and all three `/mcp` methods), instead of duplicating the check in each `+server.ts`.
  - The MCP transport lives behind `handleMcpRequest` in `lib/server/mcp.ts` and dispatches by HTTP method; auth must apply *before* dispatch (a GET SSE stream and a DELETE need the gate too, which per-tool checks would never see).
  - Route handlers stay untouched — the gate is additive and trivially removable/testable.
  - Guard shape: `if (AGENT_TOKEN && isAgentSurface(pathname) && !authorized(request))` → return 401; else `await resolve(event)`.
- **MCP session continuity**: the token is checked on **every** request, including follow-up POST/GET/DELETE that carry only `Mcp-Session-Id`. Do not "remember" auth at session creation — MCP Streamable HTTP clients are expected to repeat the `Authorization` header on all requests, so per-request checking is both the spec-aligned and the simplest-correct behavior. (Alternative of binding `Mcp-Session-Id → authed` was considered and rejected: an attacker who learns a session id would inherit access, and it adds session-bound state the in-memory `sessions` map doesn't currently track.)
- **`resolveSlug` / shared runtime interaction: none.** Auth is a transport-level concern resolved in `handle()` before any route/tool code runs; `resolveSlug` and `boardRuntime` need no changes and no token awareness.
- **Testing (maps to M-1 #4)**: unit tests for the auth helper (accept valid Bearer, accept `?token=`, reject missing/wrong with equal-timing shape, 401 on all three MCP methods, UI routes never gated); smoke test: run the built app with `AGENT_TOKEN` set and drive the §4.4 watcher loop with the header; boot-warning test for the unset-on-non-loopback case.

### 6.4 Deployment docs (README additions for M-1 #4)

- `AGENT_TOKEN=<random secret> bun run dev` — generate with `openssl rand -hex 32`.
- Agent/MCP clients send `Authorization: Bearer <token>` on every request (Hermes MCP config: header config in the MCP client entry; curl: `-H "Authorization: Bearer $AGENT_TOKEN"`).

---

## 7. Acceptance (MVP)

1. `MCP list_changes(since=0)` and `GET .../changes?since=0` both return a full snapshot-init delta (every card, no dups).
2. After a single card status change, `since=<prev revision>` returns only that card's `cards` upsert (+ a `summary` delta) with `revision` incremented exactly +1; no full re-send.
3. Idempotent/resumable: duplicate `since` → identical batch; walking revisions forward catches up with no gaps/dups. Buffer-miss / DB swap → clean `reset`.
4. No-change poll → 200 `{revision:<same>, changes:[]}` with ~0 idle cost.
5. Stalled detection available in both surfaces (`summary.stalledCount`, per-card `liveness:'stalled'`).
6. An agent can run the §4.4 watcher loop reacting to stall/review-assignee with **no direct DB access**.
7. `bun run check` 0 errors; `bun run test` green (new tests for revision monotonicity, buffer miss→reset, idempotence); `bun run build` green. Existing UI + SSE unaffected (no renames).

---

## 8. Non-goals / out of scope (MVP)

- **Write/action API** (claim, transition, block, comment) — deferred decision; read-only increment.
- SSE-as-agent-push — MCP tool calls + REST polling are the deterministic agent path; SSE stays browser-facing (an agent *may* long-poll it, but it's not the spec'd interface).

---

## 9. Milestones / cards (chained, one at a time)

- **M-1 #1** — shared `revision` on runtime + `BoardSnapshot.revision` + per-board delta ring buffer (modules: `runtime.ts`, `types.ts`, `snapshot.ts`, `differ.ts`). Unit tests: revision monotonic +1, buffer eviction→reset.
- **M-1 #2** — REST cursor surface: `/api/agent/board/[slug]/changes?since=` + `/cards` filtered query (route + tests: since0→reset, since=rev→deltas, idempotence, empty, 404).
- **M-1 #3** — MCP server (Streamable HTTP) on the same process: `list_boards`, `read_board`, `list_changes`, `get_card` (+ optional resources). Tests via a mock MCP client. Docs: agent watcher-loop example.
- **M-1 #4** — `AGENT_TOKEN` optional auth gate across `/api/agent/*` + MCP; env wiring; README/docs; smoke test of a watcher against the built app.

Reviewed/merged via the existing lead-bot reviewer contract (real GitHub approval + merge before `done`).

---

## 10. Locked decisions

1. **Both surfaces** — MCP server (agents) + REST (browser/scripts), same process, shared machinery (Jeff).
2. **Read-only MVP** — observe only; no mutation through this surface in this increment.
3. **MCP Streamable HTTP served by the kanban-monitor process itself** — no separate MCP process.
4. **Shared per-board monotonic `revision`** bumped +1 per non-trivial delta, owned by runtime; SSE per-client `seq` untouched.
5. **Bounded per-board delta buffer** for resumption; miss → `reset` full snapshot.
6. **`AGENT_TOKEN` optional** auth on agent surfaces. **Resolved (2026-09-21 research pass): default-open** when unset, including on non-loopback bind, with a loud boot WARN; a future write surface must default-deny (§6.1).
7. Approval = real GitHub review (lead-bot `gh pr review --approve`, verify `APPROVED`, merge) before `done`.

---

## 11. Open questions

1. ~~**§6 auth default** — default-open, or refer-fault to deny when `AGENT_TOKEN` unset on non-loopback bind?~~ **RESOLVED (2026-09-21): default-open when unset**, with a boot WARN on non-loopback bind; default-deny becomes mandatory when a write surface lands (see §6.1–§6.4 for the full resolution).
2. **Confirm read-only MVP** is the intent (agent observes + reacts via its own tools), rather than also writing (claim/transition/comment) through this surface — the latter is a larger, write-scoped feature.