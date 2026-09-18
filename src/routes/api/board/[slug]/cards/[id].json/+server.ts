// GET /api/board/[slug]/cards/[id].json — full detail for one card (spec §2
// `CardDetail`, §2.1 "the drawer fetches …/cards/[id].json on receipt"). The
// drawer opens/refreshes against this endpoint on every card click and on each
// `card` SSE scope for the open card. Returns 404 when the board DB is missing/
// unreadable or the task id does not exist.

import { json, type RequestEvent } from '@sveltejs/kit';
import { boardRuntime } from '../../../../../../lib/server/runtime';
import type { BoardSlug } from '../../../../../../lib/types';

export function GET(event: RequestEvent) {
  const slug: BoardSlug = event.params.slug ?? 'default';
  const taskId = event.params.id ?? '';
  const detail = boardRuntime.detailOf(slug, taskId);
  if (!detail) {
    return json({ error: `card '${taskId}' unavailable on board '${slug}'` }, { status: 404 });
  }
  return json(detail);
}
