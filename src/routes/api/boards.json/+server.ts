// GET /api/boards.json — available boards (spec §1.2, via board-discover).
//
// Re-scanned on every request (cheap stat loop, spec §1.3) so newly created
// named boards appear without a restart. Razor: only slugs + display path go
// over the wire; board discovery + the DB layout stay server-side.

import { json } from '@sveltejs/kit';
import { listBoards } from '../../../lib/server/board-discover';

export function GET() {
  const boards = listBoards().map((b) => ({ slug: b.slug }));
  return json({ boards });
}