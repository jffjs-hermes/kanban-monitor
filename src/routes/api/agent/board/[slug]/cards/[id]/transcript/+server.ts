// GET /api/agent/board/[slug]/cards/[id]/transcript — one card's worker
// transcript (transcript viewer card).
//
// Read-only, additive surface under `/api/agent/*` so the existing hooks-level
// AGENT_TOKEN gate already covers it (locked decision §2; spec §6.3): every
// non-loopback request must present valid `Authorization: Bearer <token>` (or
// the debug-only `?token=` query) or the hook returns a uniform 401 before
// this handler runs. No per-route auth logic lives here.
//
// Session resolution is strictly card-keyed (locked decision §3): we never
// accept a session id from the request — the reader resolves `card → its run →
// the run's owning profile + worker_session_id → that profile's state.db → the
// session, in that order. A forged/foreign session id is unreachable by
// construction. Returns `{ events, truncated, sessionId, profile,
// hasTranscript }`; missing board/card → 404; a card with no session (or a
// vanished session store) → 200 with `hasTranscript: false` + empty events so
// the drawer renders a graceful "no transcript" note.

import { json, type RequestEvent } from '@sveltejs/kit';
import { boardRuntime } from '../../../../../../../../lib/server/runtime';
import type { BoardSlug } from '../../../../../../../../lib/types';

export function GET(event: RequestEvent) {
  const slug: BoardSlug = event.params.slug ?? 'default';
  const taskId = event.params.id ?? '';
  const transcript = boardRuntime.transcriptOf(slug, taskId);
  if (!transcript) {
    return json(
      { error: `card '${taskId}' unavailable on board '${slug}'` },
      { status: 404 },
    );
  }
  return json({
    events: transcript.events,
    truncated: transcript.truncated,
    sessionId: transcript.sessionId,
    profile: transcript.profile,
    hasTranscript: transcript.hasTranscript,
  });
}
