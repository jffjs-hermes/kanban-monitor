# Kanban Board Monitor

Read-only live dashboard for the Hermes Kanban board. It runs on Bun
(**one process** — adapter-node — that serves the SPA, the JSON endpoints, and
the SSE stream) and reads the board DBs read-only via `bun:sqlite`. Live
updates stream over SSE; clicking a card opens a detail drawer with the card
body, status-transition trail, run attempts/outcomes, comments, and parent/child
links.

## Requirements

- Bun 1.4+ (the server imports `bun:sqlite`, so the built app must run under
  `bun`, not plain `node`).
- A Hermes board DB at `$HERMES_HOME/kanban.db` or
  `$HERMES_HOME/kanban/boards/<slug>/kanban.db` (default `$HERMES_HOME = ~/.hermes`).

## Setup and verification

From a clean checkout:

```sh
bun install --frozen-lockfile
bun run check
bun run test
bun run build
```

- **SSR note**: the build runs as `bun --bun vite build` and `bun:sqlite`
  is kept as an external resolved by the bun runtime, so SSR and the poller
  resolve it at run time.

## Run

Development server (hot reload):

```sh
bun dev
```

Production build + serve from a local shell (matches the systemd unit):

```sh
bun run build
PORT=8787 bun run start
# or with an explicit board / home:
#   HERMES_HOME=/home/jeff/.hermes BOARD=kanban-monitor PORT=8787 bun run start
```

Then open http://localhost:8787.

## Environment (spec §5)

| Variable           | Default       | Purpose                                            |
|--------------------|---------------|----------------------------------------------------|
| `PORT`             | `8787`        | adapter-node listen port                           |
| `HOST`             | `0.0.0.0`     | bind address (localhost/private LAN)               |
| `HERMES_HOME`      | `~/.hermes`   | root for board DB discovery                        |
| `STALE_WORKER_MS`  | `90000`       | running-worker heartbeat staleness threshold       |
| `POLL_INTERVAL_MS` | `1000`        | sqlite poll tick                                   |
| `BOARD`            | `default`     | initial board on first load                        |
| `AGENT_TOKEN`      | *(unset)*     | bearer token gating the agent/sensitive surfaces   |
|                    |               | (`/api/agent/*` + `/mcp` + `/api/transcripts/*`); see "Agent auth" below  |

## systemd deploy (auto-start on the Pi)

The repo ships a systemd **user** unit at `deploy/kanban-monitor.service`
(`After=network-online.target`, single `bun build/index.js` process). Install
and start it as your user:

```sh
cd /home/jeff/Projects/kanban-monitor
mkdir -p ~/.config/systemd/user
cp deploy/kanban-monitor.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now kanban-monitor
loginctl enable-linger "$USER"          # run at boot without a login session
systemctl --user status kanban-monitor  # → active (running)
```

The unit pins the build directory and the app's env. To start on a named board
or tune staleness, override without editing the shipped file:

```sh
systemctl --user edit kanban-monitor
```

then add, e.g., `Environment=BOARD=kanban-monitor` / `STALE_WORKER_MS=120000`
under `[Service]`, and restart:

```sh
systemctl --user restart kanban-monitor
journalctl --user -u kanban-monitor -f
```

Health check: `curl -s http://localhost:8787/api/boards.json`.

## Features

- **Board columns** — Ready / Running / Review / Blocked / Done, plus collapsible
  Triage / Todo / Archived.
- **Summary strip** — per-status counts, #running, #stalled, and a "last
  updated" timestamp with live sequence (`seq`) so a frozen stream is visible.
- **Live updates** — SSE (`/api/events/[slug]`) with browser-native reconnect
  (`retry: 3000` + fresh `reset`), in-place card re-render, heartbeat liveness
  dots (green active / amber stalled).
- **Board switcher** — pick default or any named board; selection persists in
  `localStorage`.
- **Card detail drawer** — click a card to see its body, status-transition trail
  (from `task_events`), run attempts/outcomes (from `task_runs`), comments
  (from `task_comments`), and clickable parent/child links (from `task_links`).
  The open drawer refreshes live when its card's detail changes over SSE.
- **Resilience** — a missing/swapped board file is tolerated (the poller
  reopens it next tick); an empty board renders an empty state rather than
  erroring.

## Agent API (MCP + REST)

The same process exposes the derived board view to agents and scripts over two
read-only surfaces, both backed by the shared `boardRuntime` (one poller, one
delta ring — no separate process, no double DB read):

- **MCP (Streamable HTTP)** at `POST /mcp` — the primary agent interface.
  Native tools:
  - `list_boards()` → `BoardSlug[]`
  - `read_board(slug?)` → full `BoardSnapshot` (summary + cards, incl. `revision`)
  - `list_changes(slug?, since)` → `{ revision, changes }` — resumable cursor
    poll; `since=0`/omitted → full snapshot-init reset, `since=REV` → only the
    deltas after `REV`, buffer miss → clean `reset`
  - `get_card(slug?, id)` → `CardDetail` (runs, comments, transitions, body, PR metadata)
  Optional read-only resources: `board://{slug}/snapshot` and
  `board://{slug}/card/{id}`.
- **REST** at `/api/agent/board/[slug]/changes?since=` (resumable cursor) and
  `/api/agent/board/[slug]/cards?assignee=&stalled=` (filtered query) for
  scripts/curl.
- **Card transcript** at `/api/agent/board/[slug]/cards/[id]/transcript` —
  the ordered worker session transcript for one card's latest run (roles,
  tool calls, tool results, heartbeats) with bounded/truncated payloads,
  keyed strictly by the card's own run session id (no arbitrary session
  reads). The drawer's **Transcript** section renders it, live-refreshing for
  a running card.

Both surfaces are read-only in this increment (observe, don't mutate). They bind
as the REST surface does today; see **Agent auth** below for the optional
`AGENT_TOKEN` gate.

### Agent watcher loop (spec §4.4)

An agent can poll cheaply and resumably from `revision` to `revision` and react
to stalls / review-assignee changes with no direct DB access:

```ts
// Pseudocode — MCP client calling list_changes on the kanban-monitor process.
let rev = 0;
while (true) {
  const { revision, changes } = await mcp.list_changes({ slug: 'kanban-monitor', since: rev });
  for (const c of changes) {
    if (c.kind === 'cards') {
      for (const card of c.upserts) {
        if (card.liveness === 'stalled') notifyOperator(card);      // heartbeat overdue
        if (card.status === 'review' && card.assignee === me) act(); // my review turn
      }
    }
    if (c.kind === 'summary' && c.summary?.stalledCount > 0) flag();
  }
  rev = revision;   // advance the cursor — no gaps, no dups
  await sleep(2_000);
}
```

The equivalent REST poll is `curl -s 'http://localhost:8787/api/agent/board/kanban-monitor/changes?since=0'`.

## Agent auth (`AGENT_TOKEN`) — spec §6.1–6.4

The agent-facing surfaces (`/api/agent/*`, `/mcp` — all methods including the
MCP GET stream — and the reserved sensitive-read namespace `/api/transcripts/*`)
can be gated behind a bearer token. The browser UI, ordinary REST endpoints
(`/api/boards.json`, `/api/board/*`), and the browser SSE stream
(`/api/events/*`) are **never** gated — the UI keeps working without a token.

**Every agent/client call must send the token**: send `Authorization: Bearer
<token>` on every request to `/api/agent/*`, `/mcp`, or `/api/transcripts/*`
when a token is configured. On a non-loopback deploy the token is **required**
— see [Default-deny on non-loopback](#default-deny-on-non-loopback) below.

### Generate a token

```sh
openssl rand -hex 32   # 64 hex chars; keep it secret
```

### Set it

```sh
AGENT_TOKEN=<secret> bun run dev                    # dev server
AGENT_TOKEN=<secret> PORT=8787 bun run start        # built app
```

Under systemd, add `Environment=AGENT_TOKEN=<secret>` to the unit override
(`systemctl --user edit kanban-monitor`). Never commit the token to the repo;
prefer launching with the value in the user environment or a root-only
EnvironmentFile.

### Send it on every request

The token is re-checked **on every request** — an MCP session does not remember
that it was authorized at `initialize`. Send the header on all of them.

REST (curl):

```sh
curl -s -H "Authorization: Bearer $AGENT_TOKEN" \
  'http://localhost:8787/api/agent/board/kanban-monitor/changes?since=0'
```

MCP (clients must repeat the header on `initialize` *and* every follow-up
POST/GET/DELETE — configure it in the MCP client's header settings):

```sh
curl -s -X POST http://localhost:8787/mcp \
  -H "Authorization: Bearer $AGENT_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"1.0"}}}'
```

**`?token=<secret>` is a debug-only fallback** (e.g. a quick `curl` test) and is
discouraged for real use: a token in a URL leaks into access logs, browser
history, and referrer headers. Prefer the `Authorization: Bearer` header.

Missing and wrong credentials both return the same `401` with a
`WWW-Authenticate: Bearer` header and `{"error":"unauthorized"}` — the server does
not reveal which one failed.

### Default-deny on non-loopback

When `AGENT_TOKEN` is unset **and** the bind is non-loopback (`HOST` defaults
to `0.0.0.0`), the agent and sensitive surfaces are **denied** — every request
to `/api/agent/*`, `/mcp`, and `/api/transcripts/*` returns a uniform `401`
until a token is configured. To surface a missing token rather than let it stay
silent, the process logs a prominent warning at boot:

```
agent surfaces DENIED on non-loopback bind (0.0.0.0) — AGENT_TOKEN is unset; set AGENT_TOKEN to authorize /api/agent/*, /mcp, and sensitive reads
```

`HOST=127.0.0.1`/`localhost`/`::1` (a loopback-only bind) suppresses the denial
and stays **open** without a token — the developer default for local work. Any
LAN/container deployment must set `AGENT_TOKEN`; otherwise agent access is
impossible-by-design (not silently open). This guards the future raw-transcript
surface: `/api/transcripts/*` is reserved for the upcoming viewer and inherits
the same enforcement with no further change.
