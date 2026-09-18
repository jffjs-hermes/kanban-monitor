# Kanban Board Monitor

Read-only SvelteKit dashboard scaffold for the Hermes Kanban board. It runs on Bun and currently provides the board-switcher shell and status columns; live SQLite/SSE features follow in later milestones.

## Requirements

- Bun 1.4+

## Setup and verification

From a clean checkout:

```sh
bun install --frozen-lockfile
bun run check
bun run test
bun run build
```

Run the development server:

```sh
bun dev
```

Open http://localhost:5173. The production adapter-node output can be started with `bun run build && bun run preview`; deployment defaults and port configuration will be added with the live layer.
