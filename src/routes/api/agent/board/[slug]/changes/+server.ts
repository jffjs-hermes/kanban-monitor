// GET /api/agent/board/[slug]/changes?since=REV — resumable cursor poll
// (spec §5, locked decisions §10; M-1 #2).
//
// Agent-facing plain-HTTP read surface: a script/tool polls from `revision`
// to `revision` with no duplicate sends and no gaps, reusing the runtime's
// shared revision + delta ring (never re-reading sqlite here).
//
// Semantics (spec §3.2):
//   - `since` omitted or `0` (or negative) → snapshot init:
//       { revision, changes: [{ kind:'reset', cards: [all cards] }] }
//   - `since=REV` inside the delta ring → { revision, changes:[deltas after REV] }
//   - buffer miss (ring eviction / interleaved reset) → degrade to a full
//     `reset` snapshot (cheap and correct)
//   - board current / no change → { revision:<same>, changes:[] } (idle ~0 cost,
//     no DB wake)
//   - unknown/unreadable board slug → 404 (reuse runtime `select`)

import { json, type RequestEvent } from '@sveltejs/kit';
import { boardRuntime } from '../../../../../../lib/server/runtime';
import type { BoardSlug, CardView, DeltaScope } from '../../../../../../lib/types';

/** A DeltaScope as served to agent callers: `reset` carries the full card list. */
export type AgentChange =
  | { kind: 'summary' }
  | { kind: 'cards'; upserts: CardView[]; removedIds: string[] }
  | { kind: 'card'; taskId: string }
  | { kind: 'reset'; cards: CardView[] };

export interface ChangesResponse {
  revision: number;
  changes: AgentChange[];
}

/** Parse the `since` query param: omitted / empty / non-numeric → 0. */
function parseSince(search: URLSearchParams): number {
  const raw = search.get('since');
  if (raw === null || raw.trim() === '') return 0;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : Math.floor(n);
}

/** Wrap a runtime DeltaScope, replacing `reset` with an agent-shaped reset. */
function toAgentChanges(deltas: DeltaScope[], resetCards: CardView[]): AgentChange[] {
  const changes: AgentChange[] = [];
  for (const d of deltas) {
    if (d.kind === 'reset') {
      changes.push({ kind: 'reset', cards: resetCards });
    } else if (d.kind === 'summary') {
      changes.push({ kind: 'summary' });
    } else if (d.kind === 'card') {
      changes.push({ kind: 'card', taskId: d.taskId });
    } else if (d.kind === 'health') {
      // Agent API surface (spec §6) has no health scope — the UI gets per-
      // worker health via the SSE `health` event. Skip it so the agent delta
      // shape stays unchanged.
      continue;
    } else {
      changes.push({ kind: 'cards', upserts: d.upserts, removedIds: d.removedIds });
    }
  }
  return changes;
}

export function GET(event: RequestEvent) {
  const slug: BoardSlug = event.params.slug ?? 'default';
  const since = parseSince(event.url.searchParams);

  // select() primes + polls the board, and returns null for unknown/unreadable
  // DB → 404 (reuse runtime `select`, spec §5).
  const snapshot = boardRuntime.select(slug);
  if (!snapshot) {
    return json({ error: `board '${slug}' unavailable` }, { status: 404 });
  }

  const rev = boardRuntime.currentRevision(slug);

  // since ≤ 0 → snapshot init: full reset with the complete card set.
  if (since <= 0) {
    const changes: AgentChange[] = [{ kind: 'reset', cards: snapshot.cards }];
    return json({ revision: rev, changes } satisfies ChangesResponse);
  }

  const res = boardRuntime.deltasSince(slug, since);
  if ('reset' in res) {
    // Buffer miss / never-polled → full snapshot rebuild.
    const cards = res.snapshot?.cards ?? snapshot.cards;
    const changes: AgentChange[] = [{ kind: 'reset', cards }];
    return json({ revision: rev, changes } satisfies ChangesResponse);
  }

  return json({
    revision: res.revision,
    changes: toAgentChanges(res.deltas, snapshot.cards),
  } satisfies ChangesResponse);
}
