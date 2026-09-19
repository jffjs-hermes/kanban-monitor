// Shared TypeScript types for the Kanban Board Monitor.
// Consumed by both the Svelte client and the server modules (spec §2).

export type BoardSlug = string; // 'default' | <name>

export type TaskStatus =
  | 'triage'
  | 'todo'
  | 'ready'
  | 'running'
  | 'review'
  | 'blocked'
  | 'done'
  | 'archived';

/** Row straight from the `tasks` table (subset the app consumes). */
export interface TaskRow {
  id: string;
  title: string;
  body: string;
  assignee: string | null;
  status: TaskStatus;
  priority: number;
  created_at: number; // unix seconds
  started_at: number | null;
  completed_at: number | null;
  worker_pid: number | null;
  last_heartbeat_at: number | null;
  current_run_id: number | null;
  block_kind: string | null;
}

export interface RunRow {
  id: number;
  task_id: string;
  status: string; // running | completed | failed | ...
  outcome: string | null; // e.g. "gave_up"
  summary: string | null;
  worker_pid: number | null;
  worker_session_id: string | null;
  started_at: number | null;
  ended_at: number | null;
  error: string | null;
  metadata: string | null; // raw JSON from task_runs.metadata (e.g. published_pr)
}

export interface EventRow {
  // `task_events`
  id: number;
  task_id: string;
  kind: string; // created, claimed, promoted, heartbeat, ...
  payload: string | null; // JSON blob
  created_at: number;
  run_id: number | null;
}

export interface CommentRow {
  // `task_comments`
  id: number;
  task_id: string;
  author: string;
  body: string;
  created_at: number;
}

export interface TaskLinkRow {
  // `task_links`
  parent_id: string;
  child_id: string;
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
  liveness: Liveness | null; // non-null only when status='running'
  elapsedMs: number | null; // running: now - started_at; else null
  createdAt: number;
  runCount: number; // attempts, from task_runs
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
  maxInProgress: number | null; // from dispatcher config if present, else null
  lastSyncedAt: number; // unix ms of last successful poll
}

/** Full snapshot (what /api/board/[slug] returns). */
export interface BoardSnapshot {
  slug: BoardSlug;
  summary: BoardSummary;
  cards: CardView[]; // non-archived, sorted status → priority → age
  /**
   * Per-board monotonic revision (spec §3.1). Owned by the runtime; bumped by
   * exactly +1 per non-trivial delta the poller publishes (trivial/no-change
   * ticks and per-client SSE `seq` do NOT touch it). This is the addressable
   * cursor both the agent REST and MCP surfaces read from.
   */
  revision: number;
}

// --- Diff / change scopes (§2.1) -------------------------------------------

export type DeltaScope =
  | { kind: 'summary' } // BoardSummary changed
  | { kind: 'cards'; upserts: CardView[]; removedIds: string[] }
  | { kind: 'card'; taskId: string } // detail data for one card changed
  | { kind: 'reset' }; // too big / DB swapped — resend full

// --- Delta ring buffer (§3.2) ----------------------------------------------

/** One entry in the shared per-board delta ring (spec §3.2). */
export interface RevisionedDelta {
  /** Board revision AFTER this delta was applied (the post-state cursor). */
  revision: number;
  scope: DeltaScope;
}

/** Result of a resumable `deltasSince` query (spec §3.2, §5). */
export type DeltasSinceResult =
  | { revision: number; deltas: DeltaScope[] } // resumable catch-up
  | { reset: true; snapshot: BoardSnapshot | null }; // buffer miss / DB swap — rebuild

// --- SSE wire payload (§2.2) -----------------------------------------------

export interface SseEvent<T = unknown> {
  seq: number; // monotonic per connection
  at: number; // unix ms
  scope: DeltaScope;
  data?: unknown; // scope-dependent
}