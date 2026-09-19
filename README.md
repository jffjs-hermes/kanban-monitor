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

Both surfaces are read-only in this increment (observe, don't mutate) and bind
as the REST surface does today (no auth yet — deferred).

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
