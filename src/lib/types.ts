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
  /** Task `assignee` — the worker profile that owns the run (task_runs.profile). */
  profile: string | null;
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
  lastTransition: { to: TaskStatus; at: number } | null; // most recent status move
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

/**
 * Live health of one worker profile (agent health panel, spec §1.2). Read-only
 * derivation over `task_runs` + `tasks` — the monitor never touches the board's
 * state machine. A profile appears only while it has a currently-running task.
 */
export interface AgentHealth {
  /** Task `assignee` — the worker profile this entry describes. */
  profile: string;
  /** Number of that profile's cards currently `status='running'`. */
  runningCardCount: number;
  /** `worker_pid` of the profile's latest run (task_runs). Null if none. */
  workerPid: number | null;
  /** `worker_session_id` of the latest run (metadata JSON). Cross-reference
   * against active runs; null if the latest run recorded none. */
  workerSessionId: string | null;
  /** `started_at` (unix s) of the profile's latest run. */
  runStartedAt: number | null;
  /**
   * Age (seconds) of the freshest heartbeat among the profile's running cards
   * (now − last_heartbeat_at). Null when none of them has recorded a heartbeat
   * while running. Mirrors the card liveness boundary: age ≥ STALE_WORKER_MS
   * is stale, exactly like `classify`.
   */
  heartbeatAgeSec: number | null;
  /** True when no running card of this profile has a fresh heartbeat (reuses
   * `liveness` semantics: heartbeat missing or ≥ STALE_WORKER_MS old). */
  stale: boolean;
}

/** Top strip. */
export interface BoardSummary {
  countsByStatus: Record<TaskStatus, number>;
  runningCount: number;
  stalledCount: number;
  maxInProgress: number | null; // from dispatcher config if present, else null
  lastSyncedAt: number; // unix ms of last successful poll
}

/** One item in a card's ordered worker transcript (transcript viewer). */
export interface TranscriptEvent {
  /** 1-based position in the emitted transcript (client render key). */
  seq: number;
  /** Unix seconds of the underlying message, or null when unset. */
  at: number | null;
  /**
   * `user` / `assistant` → body text; `tool-call` → an assistant tool
   * invocation (toolName + arguments); `tool-result` → a tool's output payload
   * (bounded); `heartbeat` → a kanban heartbeat tool result.
   */
  kind: 'user' | 'assistant' | 'tool-call' | 'tool-result' | 'heartbeat';
  /** Raw `messages.role` (user/assistant/tool), for styling/grouping. */
  role: string;
  /** Tool name for tool-call / tool-result / heartbeat events, else null. */
  toolName: string | null;
  /** Body text (user/assistant content, tool arguments, or bounded tool result). */
  text: string;
  /** True when this event's text was truncated to the bounded payload budget. */
  truncated: boolean;
}

/**
 * Result of reading a card's transcript (transcript viewer). `events` is
 * ordered oldest→newest (by message id) and bounded: payloads are truncated to
 * `MAX_PAYLOAD_CHARS` and the list to `MAX_EVENTS`, with `truncated` set when
 * anything was cut.
 */
export interface TranscriptResult {
  events: TranscriptEvent[];
  /** True when any event body was truncated OR events were dropped past `MAX_EVENTS`. */
  truncated: boolean;
  /** The session id recorded on the card's own run (never user input). */
  sessionId: string | null;
  /** Owning worker profile (the profile whose `state.db` holds the session). */
  profile: string | null;
  /** False when the card has no session / session store missing -> "no transcript". */
  hasTranscript: boolean;
}

/** Full snapshot (what /api/board/[slug] returns). */
export interface BoardSnapshot {
  slug: BoardSlug;
  summary: BoardSummary;
  cards: CardView[]; // non-archived, sorted status → priority → age
  /** Per-profile worker health; empty when no profile has a running card. */
  health: AgentHealth[];
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
  | { kind: 'health'; health: AgentHealth[] } // per-profile worker health changed
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