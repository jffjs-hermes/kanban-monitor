// Client-side board view state (spec §4 client logic).
//
// Pure, browser-free reducer: turns SSE wire events into the UI state the board
// view renders. Keeping it free of `EventSource`/DOM lets vitest exercise the
// exact sequence a real stream produces (reset → summary → cards …) with plain
// fixtures, without a browser (spec §7 "vitest component/SSE-consumer").

import type {
  AgentHealth,
  BoardSlug,
  BoardSnapshot,
  BoardSummary,
  CardView,
  TaskStatus,
} from './types';

/** How long a just-transitioned card keeps its "→ status" annotation (ms).
 * Derived from state: the annotation is shown whenever the card's latest
 * transition is within this window of the client's clock (`now`), so it's
 * correct on reload and clears itself as the window passes on the next tick
 * (locked decision §2/§3 — no imperative per-event flash that can be missed). */
export const TRANSITION_WINDOW_MS = 5_000;

/**
 * The card's most recent status move iff it happened within `windowMs` of
 * `nowMs` (the ticking client clock, unix ms). Pure window derivation for the
 * board annotation: `card.lastTransition.at` is unix seconds, so it converts
 * here. Returns `null` when the card has no transition or it has aged out.
 */
export function recentTransition(
  card: CardView,
  nowMs: number,
  windowMs: number = TRANSITION_WINDOW_MS,
): { to: TaskStatus; at: number } | null {
  const lt = card.lastTransition;
  if (!lt) return null;
  const ageMs = nowMs - lt.at * 1000;
  return ageMs >= 0 && ageMs <= windowMs ? lt : null;
}

/** Wire event names the reducer understands (§4). */
export type BoardEventName =
  | 'hello'
  | 'reset'
  | 'summary'
  | 'health'
  | 'cards'
  | 'card'
  | 'ping'
  | 'board'
  | 'open'
  | 'error';

export interface BoardUiState {
  slug: BoardSlug;
  snapshot: BoardSnapshot | null;
  connected: boolean;
  error: string | null;
  seq: number | null; // last applied per-connection seq (footer "last updated")
  lastEventAt: number | null; // unix ms of the last live event (ping counts)
  staleMs: number | null; // from `hello` (§4)
}

export function initialBoardState(slug: BoardSlug = 'default'): BoardUiState {
  return {
    slug,
    snapshot: null,
    connected: false,
    error: null,
    seq: null,
    lastEventAt: null,
    staleMs: null,
  };
}

/** Snapshot-sort: status order (§2) → priority (desc) → age (asc). */
const STATUS_ORDER: Record<TaskStatus, number> = {
  triage: 0,
  todo: 1,
  ready: 2,
  running: 3,
  review: 4,
  blocked: 5,
  done: 6,
  archived: 7,
};

export function sortCards(cards: CardView[]): CardView[] {
  return [...cards].sort(
    (a, b) =>
      STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
      b.priority - a.priority ||
      a.createdAt - b.createdAt,
  );
}

/**
 * Newest-first ordering used within a column (Impl 12): card creation time
 * descending so the most recently created card sits at the top. This is
 * independent of the snapshot-wide status/priority/age sort — it's the
 * per-column view ordering the column limit slices against.
 */
export function sortByNewestFirst(cards: CardView[]): CardView[] {
  return [...cards].sort((a, b) => b.createdAt - a.createdAt);
}

/** Default number of newest cards shown per column before the toggle (Impl 12). */
export const DEFAULT_COLUMN_LIMIT = 10;

/** Slice a newest-first column list down to its first `limit` cards (Impl 12).
 * Pure view concern — the caller decides whether the rest is revealed. */
export function takeNewest(cards: CardView[], limit: number = DEFAULT_COLUMN_LIMIT): CardView[] {
  return cards.slice(0, Math.max(0, limit));
}

// --- Stalled / credit-burn alerting (Impl task) ------------------------------
//
// A running card with a stale (or missing) heartbeat is "stalled". We surface
// it loudly and blame it for the credit burn: pull it to the top of Running,
// badge its stall age, and emphasize the run count when a worker has tried
// multiple times (each retry burns credits while it stays stuck). Everything
// is derived from the current snapshot (liveness + elapsed + runCount) vs the
// ticking client clock — no new server fields, no per-event flash, survives a
// reload.

/** True when the card is running and its heartbeat is stale/missing — exactly
 * the server's `liveness === 'stalled'` (`status='running'` + heartbeat age ≥
 * STALE_WORKER_MS, or no heartbeat). Not a second definition. */
export function isStalled(card: CardView): boolean {
  return card.status === 'running' && card.liveness === 'stalled';
}

/** Reorder a column list so stalled cards move ahead of every non-stalled card,
 * preserving the input (newest-first) relative order within each group. Used on
 * the Running column so stuck cards needing eyes land at the top. */
export function sortStalledToTop(cards: CardView[]): CardView[] {
  return [...cards].sort((a, b) => Number(isStalled(b)) - Number(isStalled(a)));
}

/**
 * Live stall duration (ms) for a stalled running card. `elapsedMs` is how long
 * the card has been running at `frameAt` (the snapshot's lastSyncedAt); we add
 * the client-clock elapsed since the frame so the age ticks up every poll and
 * reads as "this has been burning" across consecutive polls. State-derived:
 * returns `null` (and the badge disappears) the moment the card is no longer
 * classified stalled or leaves Running.
 */
export function stallAgeMs(card: CardView, now: number, frameAt: number): number | null {
  if (!isStalled(card) || card.elapsedMs === null) return null;
  const startedMs = frameAt - card.elapsedMs;
  return Math.max(0, now - startedMs);
}

/** Compact duration string for a stall badge, e.g. "45s", "3m 5s", "2h 5m". */
export function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function reconcile(
  snapshot: BoardSnapshot,
  upserts: CardView[],
  removedIds: string[],
): BoardSnapshot {
  const byId = new Map(snapshot.cards.map((c) => [c.id, c]));
  for (const u of upserts) byId.set(u.id, u);
  for (const id of removedIds) byId.delete(id);
  return { ...snapshot, cards: sortCards([...byId.values()]) };
}

/**
 * Apply one SSE wire event to `state`, returning the next state (pure). The
 * browser layer (`board-client.ts`) calls this for every parsed frame; vitest
 * drives it directly.
 *
 *   reset   → replace the whole snapshot (spec §4: initial/reconnect/DB swap)
 *   summary → merge the strip into the existing snapshot
 *   health  → merge per-profile worker health into the existing snapshot
 *   cards   → upsert/remove cards in place (spec §4), re-sorted
 *   card    → detail-relevant tick only; no board re-render (drawer refetches)
 *   ping    → keep-alive; just updates "last updated"
 *   hello   → capture staleMs (§4)
 *   board   → server switched its active board; we re-target via our own
 *             switcher, so nothing to do here (and it's for other boards anyway)
 */
export function reduceBoard(
  state: BoardUiState,
  name: BoardEventName,
  data: unknown,
  seq: number | null,
  at: number = Date.now(),
): BoardUiState {
  if (state.snapshot === null && name !== 'reset' && name !== 'hello') {
    // No baseline yet — a reset/hello will establish it. Drop anything else so
    // a partial stream before the initial snapshot can't corrupt state.
    return seq !== null || name === 'open' || name === 'error'
      ? { ...state, seq: seq ?? state.seq }
      : state;
  }

  switch (name) {
    case 'hello': {
      const payload = (data ?? {}) as { slug?: string; staleMs?: number };
      return {
        ...state,
        connected: true,
        error: null,
        staleMs: payload.staleMs ?? state.staleMs,
        seq: seq ?? state.seq,
        lastEventAt: at,
      };
    }
    case 'open':
      return { ...state, connected: true, error: null };
    case 'error':
      return { ...state, connected: false, error: 'connection lost' };
    case 'reset': {
      const snap = data as BoardSnapshot;
      return {
        ...state,
        slug: snap.slug ?? state.slug,
        snapshot: snap,
        connected: true,
        error: null,
        seq: seq ?? state.seq,
        lastEventAt: at,
      };
    }
    case 'summary': {
      const summary = data as BoardSummary;
      if (!state.snapshot) return state;
      return {
        ...state,
        snapshot: { ...state.snapshot, summary },
        seq: seq ?? state.seq,
        lastEventAt: at,
      };
    }
    case 'health': {
      // Merge fresh per-profile worker health into the existing snapshot,
      // preserving every other field (analogous to the `summary` case). No
      // full reset — the panel's ages keep ticking client-side; this just
      // brings fresher source values when a worker starts/stops/crosses stale.
      const health = data as AgentHealth[];
      if (!state.snapshot) return state;
      return {
        ...state,
        snapshot: { ...state.snapshot, health },
        seq: seq ?? state.seq,
        lastEventAt: at,
      };
    }
    case 'cards': {
      if (!state.snapshot) return state;
      const payload = (data ?? {}) as { upserts: CardView[]; removedIds: string[] };
      return {
        ...state,
        snapshot: reconcile(
          state.snapshot,
          payload.upserts ?? [],
          payload.removedIds ?? [],
        ),
        seq: seq ?? state.seq,
        lastEventAt: at,
      };
    }
    case 'card':
      return { ...state, seq: seq ?? state.seq, lastEventAt: at };
    case 'ping':
      return { ...state, seq: seq ?? state.seq, lastEventAt: at };
    case 'board':
      // Server-side active-board switch; our own switcher re-targets, so the
      // stream is either already re-pointing or irrelevant. No state change.
      return { ...state, seq: seq ?? state.seq };
    default:
      return state;
  }
}

// --- Column formation (§1.2: Ready → Running → Review → Blocked → Done, with
// triage/todo/archived collapsed/toggleable) ---------------------------------

export interface ColumnDef {
  status: TaskStatus;
  label: string;
  collapsed: boolean; // shown only when the user expands "more columns"
}

export const COLUMN_DEFS: ColumnDef[] = [
  { status: 'triage', label: 'Triage', collapsed: true },
  { status: 'todo', label: 'Todo', collapsed: true },
  { status: 'ready', label: 'Ready', collapsed: false },
  { status: 'running', label: 'Running', collapsed: false },
  { status: 'review', label: 'Review', collapsed: false },
  { status: 'blocked', label: 'Blocked', collapsed: false },
  { status: 'done', label: 'Done', collapsed: false },
  { status: 'archived', label: 'Archived', collapsed: true },
];

/** The five always-visible MVP columns (spec §1.2). */
export const PRIMARY_COLUMNS: TaskStatus[] = [
  'ready',
  'running',
  'review',
  'blocked',
  'done',
];

/** Group a snapshot's cards into per-status lists keyed by status. Every
 * status is always present (empty when it has no cards). Cards within each
 * column are ordered newest-first (Impl 12) so the column limit shows the
 * most recently created cards by default. */
export function groupByStatus(cards: CardView[]): Record<TaskStatus, CardView[]> {
  const groups = {} as Record<TaskStatus, CardView[]>;
  for (const st of Object.keys(STATUS_ORDER) as TaskStatus[]) groups[st] = [];
  for (const c of sortByNewestFirst(cards)) groups[c.status]!.push(c);
  // Stalled cards land at the top of the Running column (credit-burn alert).
  groups.running = sortStalledToTop(groups.running);
  return groups;
}