// PR link derivation for the card detail drawer (Impl 9).
//
// A card's pull request is recovered from two places, in priority order:
//   1. the most recent run whose `metadata.published_pr` is a full, well-formed
//      GitHub PR URL (implementation/review cards set `published_pr` on
//      `kanban_request_review`, persisted in `task_runs.metadata`);
//   2. otherwise, the first full GitHub PR URL found in the card's comments
//      (fallback for cards that predate the run-metadata field).
// If neither yields a valid link, `findPrUrl` returns `null` so the drawer
// renders nothing (no placeholder).

export interface PrLink {
  url: string; // absolute https://github.com/<org>/<repo>/pull/<n>
  number: number;
}

// Full absolute GitHub PR URL — for validating `published_pr`, which is
// supposed to be a complete URL. Anchored so bare numbers, partial paths, and
// non-github hosts are all rejected as malformed.
const ABSOLUTE_PR_RE =
  /^https?:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+)\/?$/i;

// A GitHub PR URL appearing anywhere in a larger string (comment bodies). The
// scheme is optional so prose like "see github.com/org/repo/pull/12" matches;
// `\b` after the digits stops a run-on like `pull/12abc`.
const INLINE_PR_RE =
  /(?:https?:\/\/)?(?:www\.)?github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+)\b/i;

function toAbsolute(url: string): string {
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

/**
 * Find the pull request for a card.
 *
 * @param metadataByRun per-run `task_runs.metadata` objects, JSON-parsed, most
 *   recent run first. `null` entries are skipped.
 * @param comments the card's comment rows (only `body` is read).
 * @returns `{ url, number }` of the most recent run's `published_pr`, else the
 *   first GitHub PR URL found in the comments, else `null`.
 */
export function findPrUrl(
  metadataByRun: Array<Record<string, unknown> | null>,
  comments: Array<{ body: string }>,
): PrLink | null {
  for (const meta of metadataByRun) {
    if (!meta || typeof meta !== 'object') continue;
    const value = meta['published_pr'];
    if (typeof value !== 'string') continue;
    const m = ABSOLUTE_PR_RE.exec(value.trim());
    if (m) return { url: value.trim(), number: Number(m[1]) };
  }
  for (const comment of comments) {
    const m = INLINE_PR_RE.exec(comment.body ?? '');
    if (m) return { url: toAbsolute(m[0]), number: Number(m[1]) };
  }
  return null;
}