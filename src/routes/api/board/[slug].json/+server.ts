// GET /api/board/[slug].json — full snapshot for initial load / fallback
// (spec §1.2). Selecting the board on the shared runtime guarantees a primed,
// polled snapshot (spec §1.1); returns 404 when the board DB is missing or
// unreadable (the poller will pick it up if it appears later, §1.3).

import { json, type RequestEvent } from '@sveltejs/kit';
import { boardRuntime } from '../../../../lib/server/runtime';
import type { BoardSlug } from '../../../../lib/types';

export function GET(event: RequestEvent) {
  const slug: BoardSlug = event.params.slug ?? 'default';
  const snapshot = boardRuntime.select(slug);
  if (!snapshot) {
    return json({ error: `board '${slug}' unavailable` }, { status: 404 });
  }
  return json(snapshot);
}