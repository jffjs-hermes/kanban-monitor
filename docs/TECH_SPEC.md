# Kanban Board Monitor — Technical Specification

Implementation spec for the MVP described in the human-authored feature spec
(`kanban-monitor-spec.md`). This document fixes module boundaries, data shapes,
the poll → diff → SSE pipeline, and the environment surface. **Spec only — no
feature code in this change.**

Ground truth (locked, do not relitigate): TypeScript, SvelteKit on Bun,
adapter-node, `bun:sqlite` read-only against the board DB, SSE for realtime,
deploy as a single `bun run` process on port 8787 behind systemd.

---

## 1. Architecture & Module Boundaries

```
Browser (Svelte SPA)  ──SSE──►  SvelteKit server (one process, adapter-node)
                                   │
                                   ├─ boardDiscoverer   find available board DBs
                                   ├─ dataAccess        read-only bun:sqlite reads
                                   ├─ poller            ~1s tick, snapshot reads
                                   ├─ differ            snapshot vs last-known → scoped deltas
                                   ├─ liveness          heartbeat staleness classification
                                   ├─ viewState         DB rows → UI view models
                                   └─ sseHub            fan-out deltas to clients
```

One process serves the page, the JSON endpoints, and the SSE stream. No separate
API service. All board access is read-only; the app never writes to the board.

### 1.1 Server entry

SvelteKit adapter-node boots one Node process. On startup:

- `boardDiscoverer.listBoards()` → available boards (default + named).
- A singleton `BoardRuntime` per selected board owns `poller` + `differ` +
  `sseHub`. Board switch = stop old runtime (if any), start new one, publish a
  `board` event on a cross-board SSE channel (see §4).
- Liveness classification is recomputed inside the view-state derivation on
  every poll tick; no separate timer.

### 1.2 Module layout

```
src/lib/server/
  board-discover.ts    # discover board DBs on disk
  data-access.ts       # all SQL lives here; bun:sqlite readonly handles
  snapshot.ts          # full board snapshot read (one function, one tx)
  poller.ts            # setInterval tick → snapshot → compare
  differ.ts            # snapshot vs previous → BoardDelta (scoped)
  liveness.ts          # stale-worker classification (STALE_WORKER_MS)
  view-state.ts        # rows → view models (CardView, BoardSummary, ...)
  sse-hub.ts           # subscriber registry + delta fan-out
  runtime.ts           # BoardRuntime: wires the above per board

src/lib/types.ts       # shared types (imported by client + server)
src/routes/
  +page.svelte         # board view (columns, summary strip, switcher)
  +layout.ts           # client shell, no SSR data deps
  /api/boards.json     # GET: available boards
  /api/board/[slug].json  # GET: full snapshot (initial load / fallback)
  /api/events/[slug]   # GET: SSE stream (text/event-stream)
src/lib/components/
  BoardColumn.svelte  Card.svelte  CardDetailDrawer.svelte
  SummaryStrip.svelte BoardSwitcher.svelte  LivenessDot.svelte
```

Boundary rules:

- **Only `data-access.ts` touches SQL.** Everything else sees typed shapes.
- **Only `differ.ts` decides "what changed."** Components never diff.
- **Only `sse-hub.ts` knows about connections.** `poller`/`differ` emit plain
  deltas; the hub handles fan-out and per-client cursors.
- View-state derivation (`view-state.ts`) is pure and unit-testable with
  fixture snapshots.

### 1.3 Board discoverer

Boards are files, not DB rows:

- Default: `$HERMES_HOME/kanban.db` (default `$HERMES_HOME = ~/.hermes`).
- Named: `$HERMES_HOME/kanban/boards/<slug>/kanban.db`.

`listBoards()` returns `{ slug: "default" | <name>, path }[]`, skipping missing
files. Re-scanned on each `/api/boards.json` request (cheap `stat` loop) so
newly created named boards appear without a restart. The poller tolerates the
DB file disappearing/reappearing (board re-created): on read error it emits a
`reset` event with `error` info and retries next tick.

### 1.4 Read-only access

Open with `new Database(path, { readonly: true })` per board. WAL mode on the
writer's side means readers never block the live gateway. Long-lived readonly
connections are fine; if a read throws (file swapped), close and reopen on the
next tick.

---

## 2. Data Shapes (TypeScript)

```ts
// src/lib/types.ts

export type BoardSlug = string;                       // "default" | name
export type TaskStatus =
  | 'triage' | 'todo' | 'ready' | 'running'
  | 'review' | 'blocked' | 'done' | 'archived';

/** Row straight from the `tasks` table (subset the app consumes). */
export interface TaskRow {
  id: string;
  title: string;
  body: string;
  assignee: string | null;
  status: TaskStatus;
  priority: number;
  created_at: number;            // unix seconds
  started_at: number | null;
  completed_at: number | null;
  worker_pid: number | null;
  last_heartbeat_at: number | null;
  current_run_id: number | null;
  block_kind: string | null;
}

export interface RunRow {
  id: number; task_id: string;
  status: string;                // running | completed | failed | ...
  outcome: string | null;        // e.g. "gave_up"
  summary: string | null;
  worker_pid: number | null;
  worker_session_id: string | null;
  started_at: number | null; ended_at: number | null;
  error: string | null;
}

export interface EventRow {      // `task_events`
  id: number; task_id: string;
  kind: string;                  // created, claimed, promoted, heartbeat, ...
  payload: string | null;        // JSON blob
  created_at: number;
  run_id: number | null;
}

export interface CommentRow {    // `task_comments`
  id: number; task_id: string;
  author: string; body: string; created_at: number;
}

export interface TaskLinkRow {   // `task_links`
  parent_id: string; child_id: string;
}

/** Liveness classification of a running card. */
export type Liveness = 'active' | 'stalled';
//   active:  status='running' AND now - last_heartbeat_at < STALE_WORKER_MS
//   stalled: status='running' AND heartbeat stale (or null)

/** UI view model for one card. */
export interface CardView {
  id: string;
  title: string;
  assignee: string | null;
  priority: number;
  status: TaskStatus;
  liveness: Liveness | null;     // non-null only when status='running'
  elapsedMs: number | null;      // running: now - started_at; else null
  createdAt: number;
  runCount: number;              // attempts, from task_runs
  lastOutcome: string | null;
  parentIds: string[];
  childIds: string[];
}

/** Card detail drawer payload. */
export interface CardDetail {
  card: CardView;
  body: string;
  transitions: { from: TaskStatus | null; to: TaskStatus; at: number }[];
  runs: RunRow[];
  comments: CommentRow[];
}

/** Top strip. */
export interface BoardSummary {
  countsByStatus: Record<TaskStatus, number>;
  runningCount: number;
  stalledCount: number;
  maxInProgress: number | null;  // from dispatcher config if present, else null
  lastSyncedAt: number;          // unix ms of last successful poll
}

/** Full snapshot (what /api/board/[slug] returns). */
export interface BoardSnapshot {
  slug: BoardSlug;
  summary: BoardSummary;
  cards: CardView[];             // non-archived, sorted status → priority → age
}
```

### 2.1 Diff / change scopes

The differ classifies each poll tick's change into one or more **scopes**.
A scope is the smallest unit a client needs to re-render:

```ts
export type DeltaScope =
  | { kind: 'summary' }                          // BoardSummary changed
  | { kind: 'cards'; upserts: CardView[]; removedIds: string[] }
  | { kind: 'card'; taskId: string }             // detail data for one card changed
  | { kind: 'reset' };                           // too big / DB swapped — resend full
```

Rules:

- Compare `(status, priority, assignee, liveness, title, runCount, lastOutcome)`
  per card. A card whose only change is heartbeat freshness within the same
  liveness class produces **no delta** (otherwise every running card would push
  every tick).
- Elapsed timers tick client-side (`started_at` is all the client needs); the
  server does not push per-second elapsed updates.
- More than ~30% of cards changed, or the board slug changed, or the snapshot
  read failed → `reset`.
- Detail scopes are emitted per changed task id so an open drawer can refresh
  itself; the drawer fetches `/api/board/[slug]/cards/[id].json` on receipt.

### 2.2 SSE wire payload

```ts
export interface SseEvent<T = unknown> {
  seq: number;          // monotonic per connection
  at: number;           // unix ms
  scope: DeltaScope;
  data?: unknown;       // scope-dependent: summary for 'summary',
                        // upserts for 'cards', full BoardSnapshot for 'reset'
}
```

---

## 3. Poller → Diff → SSE Pipeline (function signatures)

All server-side (`src/lib/server/`).

```ts
// snapshot.ts
export function readSnapshot(db: Database, opts: { staleMs: number; now: number }): BoardSnapshot;

// poller.ts
export interface Poller {
  start(): void;
  stop(): void;
  onDelta(cb: (delta: DeltaScope & { slug: BoardSlug }) => void): void;
}
export function createPoller(db: () => Database | null, intervalMs?: number /* default 1000 */): Poller;
// Each tick: readSnapshot → differ.diffSnapshot(prev, next) → emit deltas (or 'reset').
// Read error → emit { kind: 'reset', error } and keep ticking.

// differ.ts
export function diffSnapshot(prev: BoardSnapshot | null, next: BoardSnapshot): DeltaScope[];

// liveness.ts
export function classify(task: TaskRow, now: number, staleMs: number): Liveness | null;
// staleMs comes from env STALE_WORKER_MS (default 90_000). null for non-running cards.

// sse-hub.ts
export interface SseHub {
  subscribe(slug: BoardSlug, send: (evt: SseEvent) => void): () => void; // returns unsubscribe
  publish(slug: BoardSlug, scope: DeltaScope, data?: unknown): void;
  clientCount(slug: BoardSlug): number;
}
export function createSseHub(): SseHub;
// Skips publish when clientCount === 0 (idle boards cost one sqlite read/s, no I/O to browsers).
```

`max_in_progress`: read from the dispatcher config if it is discoverable in
`$HERMES_HOME`; MVP ships the field as `null` (strip renders "slots: —")
until the source is confirmed. Do not hardcode a number.

---

## 4. SSE Protocol

Endpoint: `GET /api/events/[slug]` → `Content-Type: text/event-stream`,
`Cache-Control: no-cache`, `Connection: keep-alive`.

Event names (the `event:` field):

| event      | `data:` payload                                  | when |
|------------|--------------------------------------------------|------|
| `hello`    | `{ seq, slug, staleMs }`                         | on connect |
| `reset`    | full `BoardSnapshot`                             | initial state, reconnect, DB swap, oversized diff |
| `summary`  | `BoardSummary`                                   | strip-level change only |
| `cards`    | `{ upserts: CardView[], removedIds: string[] }`  | card set/fields changed |
| `card`     | `{ taskId }`                                     | detail-relevant change for one card |
| `ping`     | `{ at }`                                         | every 15s idle, keeps proxies alive |

- **Reconnect:** browser-native `EventSource` auto-reconnect. Server sends
  `retry: 3000`. Reconnect always triggers a fresh `reset`, so the client never
  needs to replay missed deltas (no `Last-Event-ID` handling in MVP).
- **Client logic:** on `reset` replace whole state; on `summary` merge strip; on
  `cards` upsert/remove; on `card` refetch that card's detail if its drawer is
  open. Each event's `seq` is displayed in the footer next to "last updated"
  (frozen view is detectable: seq stalls + no ping).
- **Cleanup:** abort the stream (and unsubscribe from the hub) when the client
  disconnects — check `request.signal` in the route handler.

---

## 5. Environment Surface

| Variable           | Default                        | Purpose |
|--------------------|--------------------------------|---------|
| `PORT`             | `8787`                         | adapter-node listen port |
| `HOST`             | `0.0.0.0`                      | bind address (localhost/private LAN) |
| `HERMES_HOME`      | `~/.hermes`                    | root for board DB discovery |
| `STALE_WORKER_MS`  | `90000`                        | heartbeat staleness threshold |
| `POLL_INTERVAL_MS` | `1000`                         | sqlite poll tick |
| `BOARD`            | `default`                      | initial board on first load |
| `AGENT_TOKEN`      | *(unset)*                      | optional bearer token gating `/api/agent/*` + `/mcp` (all methods); see Agent auth |

The server also honors `AGENT_HOST` (defaults to `HOST`) solely to decide the
boot auth warning's loopback check. No other secrets are read by the app.

### Agent auth (`AGENT_TOKEN`, spec §6)

- **Default-open when unset**, including on non-loopback binds; at boot the
  process logs a loud WARN when auth is disabled on a non-loopback bind
  (`agent surfaces open (no AGENT_TOKEN) on non-loopback bind — set AGENT_TOKEN
  to restrict`). A loopback-only bind (`HOST=127.0.0.1`/`localhost`) suppresses
  it. A future **write** surface must default-deny when unset; this read-only
  MVP stays open.
- **When set**: every `/api/agent/*` request and every `/mcp` method (POST/GET
  DELETE, incl. the MCP GET SSE stream) requires `Authorization: Bearer
  <token>` (primary) or the debug-only `?token=` query param. UI, ordinary
  REST, and browser SSE surfaces are never gated.
- **Per-request check** — the token is re-verified on every MCP follow-up
  POST/GET/DELETE; establishing a session at `initialize` does not remember
  auth.
- **Uniform 401** for missing or wrong credentials: `401` +
  `WWW-Authenticate: Bearer` + `{"error":"unauthorized"}` — the server does not
  reveal which failed.
- **Constant-time compare** via SHA-256 digest + `crypto.timingSafeEqual`.

---

## 6. Versioning & CLI Surface

- Semver from `0.1.0`. Milestones ship as minor bumps (0.2 = live layer, 0.3 =
  worker visibility, 0.4 = drawer, 0.5 = summary strip + deploy); breaking
  SSE-protocol changes bump minor until 1.0 (pre-1.0 consumers are this repo's
  own frontend only).
- **No CLI in MVP.** The only entry points are `bun dev`, `bun run build`,
  `bun run start` (alias for `node build` — under Bun, `bun build/index.js`).
  The systemd unit (milestone 5) wraps that start command; unit spec lands with
  that milestone.
- Config is env-only; no config file, no flags.

---

## 7. Testing Notes

- `differ.ts`, `liveness.ts`, `view-state.ts`, and `board-discover.ts` are pure
  modules → unit tests against fixture snapshots (the existing vitest setup).
- SSE hub tested with fake timers: publish-when-empty is a no-op, unsubscribe
  stops delivery.
- Data-access is integration-tested only where a writable temp copy of a board
  DB is cheap to fabricate; otherwise covered by manual verification against
  the live board DB in read-only mode.
