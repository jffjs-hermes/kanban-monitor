// GET /api/agent/board/[slug]/cards?assignee=X&stalled=true|false — cheap
// filtered board query (spec §5 table, M-1 #2).
//
// Returns a `CardView[]` linearly filtered over the CURRENT snapshot (spec
// §5 "forgiving REST"; no DB re-read — reuses the runtime's cached snapshot).
//
// Filters (all optional; combined with AND when more than one supplied):
//   - `assignee=X`      → keep cards whose assignee === X (null never matches)
//   - `stalled=true`    → keep cards with liveness === 'stalled'
//   - `stalled=false`   → keep cards with liveness === 'active' (running, not
//                         stalled); excludes non-running cards (liveness null)
// Omitting all params returns every card in the snapshot.
//
// Unknown/unreadable board slug → 404 (reuse runtime `select`).

import { json, type RequestEvent } from '@sveltejs/kit';
import { boardRuntime } from '../../../../../../lib/server/runtime';
import type { BoardSlug, CardView } from '../../../../../../lib/types';

export function GET(event: RequestEvent) {
  const slug: BoardSlug = event.params.slug ?? 'default';

  const snapshot = boardRuntime.select(slug);
  if (!snapshot) {
    return json({ error: `board '${slug}' unavailable` }, { status: 404 });
  }

  let cards: CardView[] = snapshot.cards;

  const assignee = event.url.searchParams.get('assignee');
  if (assignee !== null && assignee !== '') {
    cards = cards.filter((c) => c.assignee === assignee);
  }

  const stalledRaw = event.url.searchParams.get('stalled');
  if (stalledRaw === 'true') {
    cards = cards.filter((c) => c.liveness === 'stalled');
  } else if (stalledRaw === 'false') {
    cards = cards.filter((c) => c.liveness === 'active');
  }

  return json(cards);
}
