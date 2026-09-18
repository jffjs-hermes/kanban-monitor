// Client-side board view state (spec §4 client logic).
//
// Pure, browser-free reducer: turns SSE wire events into the UI state the board
// view renders. Keeping it free of `EventSource`/DOM lets vitest exercise the
// exact sequence a real stream produces (reset → summary → cards …) with plain
// fixtures, without a browser (spec §7 "vitest component/SSE-consumer").

import type {
  BoardSlug,
  BoardSnapshot,
  BoardSummary,
  CardView,
  TaskStatus,
} from './types';

/** Wire event names the reducer understands (§4). */
export type BoardEventName =
  | 'hello'
  | 'reset'
  | 'summary'
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
 * status is always present (empty when it has no cards). */
export function groupByStatus(cards: CardView[]): Record<TaskStatus, CardView[]> {
  const groups = {} as Record<TaskStatus, CardView[]>;
  for (const st of Object.keys(STATUS_ORDER) as TaskStatus[]) groups[st] = [];
  for (const c of cards) groups[c.status]!.push(c);
  return groups;
}