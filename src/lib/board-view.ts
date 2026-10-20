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

// --- Keyboard navigation (roving tabindex) ----------------------------------
//
// The board keeps exactly one card in the tab order at a time — the "focused"
// card — and arrow keys move that selection around the rendered grid. All
// movement math lives here as pure functions so the wrap-around rules are
// unit-tested without a DOM: the page feeds `moveFocus` the ids each column
// actually renders, in render order, and applies the result (tabindex swap +
// DOM focus) to the cards.

/** Arrow-key direction of a focus move on the board. */
export type FocusDirection = 'up' | 'down' | 'left' | 'right';

/** The card ids a column renders right now, in render order — the navigation
 * layout for `moveFocus`. Mirrors BoardColumn's own `visible` computation
 * (newest-N limit unless expanded) so keyboard movement always lands on a card
 * that is actually on screen. */
export function visibleCardIds(
  cards: CardView[],
  expanded: boolean,
  limit: number = DEFAULT_COLUMN_LIMIT,
): string[] {
  return (expanded ? cards : takeNewest(cards, limit)).map((c) => c.id);
}

/**
 * Where the next focused card is when an arrow key moves the selection one
 * step on a board laid out as `columns` — one array of card ids per visible
 * column, in render order (empty arrays for columns with no cards).
 *
 *   up/down    — previous/next card within the same column, wrapping at the
 *                edges (first ↔ last); a single-card column stays put.
 *   left/right — adjacent column at the same row (clamped to the target
 *                column's length), skipping empty columns and wrapping
 *                last ↔ first; if every other column is empty, stays put.
 *   no focus   — `null` or an id that is not in the layout (the focused card
 *                was removed/streamed away) starts at the first card of the
 *                first non-empty column, the default roving-tabindex tab stop.
 *
 * Returns `null` only when the board has no cards at all.
 */
export function moveFocus(
  columns: string[][],
  focusedId: string | null,
  dir: FocusDirection,
): string | null {
  let ci = -1;
  let ri = -1;
  if (focusedId !== null) {
    for (let i = 0; i < columns.length; i++) {
      const j = columns[i].indexOf(focusedId);
      if (j !== -1) {
        ci = i;
        ri = j;
        break;
      }
    }
  }

  if (ci === -1) {
    for (let i = 0; i < columns.length; i++) {
      if (columns[i].length > 0) return columns[i][0];
    }
    return null;
  }

  if (dir === 'up' || dir === 'down') {
    const col = columns[ci];
    const n = col.length;
    if (n <= 1) return col[0];
    return dir === 'up' ? col[(ri - 1 + n) % n] : col[(ri + 1) % n];
  }

  const step = dir === 'right' ? 1 : -1;
  let next = (ci + step + columns.length) % columns.length;
  while (next !== ci && columns[next].length === 0) {
    next = (next + step + columns.length) % columns.length;
  }
  if (columns[next].length === 0) return focusedId; // no other column has cards
  return columns[next][Math.min(ri, columns[next].length - 1)];
}

/** DOM element id for a card article — the roving-tabindex focus target the
 * board focuses on arrow moves and the drawer returns focus to on Escape.
 * Card ids are unique within a snapshot, so the id is unique on a rendered
 * board. */
export function cardElId(cardId: string): string {
  return `card-${cardId}`;
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

// --- Relative-age footer (Card C) ------------------------------------------
//
// Every card footer shows how long ago its most recent status transition
// happened. Pure function of `transitionMs` vs the ticking client clock, so
// the label ticks up in place on every re-render from state (card's
// `lastTransition`), survives a reload, and needs no server fields.

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * Compact "how long ago" label for a card's most recent status move, single
 * unit: "just now" (hard floor for the first minute — the label never counts
 * seconds), then "3m ago" up to 59m, "2h ago" up to 23h, then "1d ago" and
 * up. `nowMs` before the transition (clock skew) clamps to "just now".
 */
export function relativeAge(transitionMs: number, nowMs: number): string {
  const ageMs = Math.max(0, nowMs - transitionMs);
  if (ageMs < MINUTE_MS) return 'just now';
  if (ageMs < HOUR_MS) return `${Math.floor(ageMs / MINUTE_MS)}m ago`;
  if (ageMs < DAY_MS) return `${Math.floor(ageMs / HOUR_MS)}h ago`;
  return `${Math.floor(ageMs / DAY_MS)}d ago`;
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

// --- Assignee filter (Card B) ------------------------------------------------
//
// Pure helpers for the "Filter by assignee" dropdown above the summary strip.
// The filter is a client-side view concern: it narrows which cards the columns
// render (and therefore their counts/empty states) without touching the
// server-derived summary strip.

/** The assignee filter value: a card assignee name, or `null` = "All" (no
 * filtering). `null` is the sentinel rather than `''` because unassigned cards
 * (assignee `null`/`''`) must remain visible under "All" while matching no
 * named filter — so `''` can't double as "All" without ambiguity. */
export type AssigneeFilter = string | null;

/** Distinct non-empty assignees across a snapshot's cards, sorted for a stable
 * dropdown. Unassigned cards are not options — they only match the "All"
 * filter. */
export function distinctAssignees(cards: CardView[]): string[] {
  const set = new Set<string>();
  for (const c of cards) if (c.assignee) set.add(c.assignee);
  return [...set].sort();
}

/** Keep only the cards assigned to `assignee`; `null` (or `''`) = "All" — no
 * filtering. Matches the stored assignee exactly, so an unassigned card
 * (assignee `null`/`''`) matches only "All", never a named filter. */
export function filterByAssignee(cards: CardView[], assignee: AssigneeFilter): CardView[] {
  if (!assignee) return cards;
  return cards.filter((c) => c.assignee === assignee);
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