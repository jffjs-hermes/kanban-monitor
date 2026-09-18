// Browser-side SSE client (spec §4 client logic).
//
// Thin EventSource wrapper around the pure `reduceBoard` reducer. Owns a single
// live connection for the currently-selected board; switching boards closes the
// old stream and opens `/api/events/<slug>` (spec §5.0 — board switcher
// re-targets the stream + snapshot). Reconnect is native `EventSource` behavior
// (server sends `retry: 3000` and a fresh `reset`, so the client never replays
// missed deltas — no Last-Event-ID handling in MVP, spec §4).
//
// Kept separate from `board-view.ts` (the pure, testable reducer) so vitest can
// drive the reducer without a browser.

import { writable, type Writable } from 'svelte/store';
import { markDirty } from './card-drawer';
import {
  initialBoardState,
  reduceBoard,
  type BoardEventName,
  type BoardUiState,
} from './board-view';
import type { BoardSlug } from './types';

/** Reactive board UI state, consumed by the Svelte components via `$board`. */
export const board: Writable<BoardUiState> = writable(initialBoardState());

const EVENT_NAMES: BoardEventName[] = [
  'hello',
  'reset',
  'summary',
  'cards',
  'card',
  'ping',
  'board',
];

let es: EventSource | null = null;
let activeSlug: BoardSlug | null = null;
const esBySlug = new Map<BoardSlug, EventSource>();

function open(slug: BoardSlug): EventSource {
  const existing = esBySlug.get(slug);
  if (existing) return existing;

  const src = new EventSource(`/api/events/${encodeURIComponent(slug)}`);

  src.addEventListener('open', () => {
    board.update((s) => reduceBoard(s, 'open', null, null));
  });
  src.addEventListener('error', () => {
    board.update((s) => reduceBoard(s, 'error', null, null));
  });

  for (const name of EVENT_NAMES) {
    src.addEventListener(name, (ev: MessageEvent) => {
      let data: unknown = null;
      if (ev.data) {
        try {
          data = JSON.parse(ev.data as string);
        } catch {
          data = null;
        }
      }
      const seq = ev.lastEventId ? Number(ev.lastEventId) : null;
      board.update((s) => reduceBoard(s, name, data, seq));
      // A `card` scope means one card's detail rows changed (§2.1). If that is
      // the drawer's open card, bump its refresh token so it refetches.
      if (name === 'card') {
        const tid = (data as { taskId?: string } | null)?.taskId;
        if (tid) markDirty(tid);
      }
    });
  }

  esBySlug.set(slug, src);
  return src;
}

/**
 * Re-target the viewer to `slug`: close any other open stream, open (or reuse)
 * the selected board's stream, and reset the store to that board's baseline.
 * The new connection's `reset` immediately replaces the snapshot (spec §4). The
 * selection is persisted by the caller via localStorage (§5.0).
 */
export function selectBoard(slug: BoardSlug): void {
  activeSlug = slug;
  board.set(initialBoardState(slug));
  for (const [s, src] of esBySlug) {
    if (s !== slug) {
      src.close();
      esBySlug.delete(s);
    }
  }
  es = open(slug);
}

/** Active selection is pubic for consumers that need it outside the store. */
export function currentSlug(): BoardSlug | null {
  return activeSlug;
}