// Pure, DOM-free helpers that decide how a transcript event's text is
// rendered (transcript viewer). No sanitizer, no DOM, no dependencies — they
// only classify the text and structure it for the Svelte template to escape
// via normal text/interpolation nodes (never {@html}). Markdown is the single
// exception and stays exclusively in `renderMarkdown` (marked → DOMPurify).
//
// Deterministic mode precedence (locked decision, transcript viewer card):
//   1. kind `user`/`assistant`  → markdown, unconditionally (even if the body
//      starts with `{` or looks like a diff).
//   2. valid top-level object/array JSON → pretty-printed `json`.
//   3. a diff signature with ≥ 2 matching lines → `diff`.
//   4. anything else → `plain` (escaped raw text).
// A diff field inside a structured result is intentionally allowed to fall
// through to the JSON path first — readable JSON is never lost for a diff.

export type RenderMode = 'markdown' | 'json' | 'diff' | 'plain';

/** One line of a classified diff, ready for escaped text interpolation. */
export type DiffKind = 'meta' | 'hunk' | 'add' | 'del' | 'ctx';

export interface DiffLine {
  kind: DiffKind;
  text: string;
}

/**
 * Pretty-print `text` only when it parses as JSON whose top-level value is an
 * object or array (a scalar like `123` or a bare string stays `null`, so it
 * falls through to the plain renderer). Returns `null` on any parse failure —
 * including truncated JSON — which callers treat as "not JSON".
 */
export function prettyJson(text: string): string | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (value === null || typeof value !== 'object') return null;
  return JSON.stringify(value, null, 2);
}

/** A diff-signature line: index/commit metadata, a @@ hunk, or --- / +++ file headers. */
const DIFF_SIG = /^(?:diff --git|index |@@ |--- |\+\+\+ )/;

/** Count diff-signature lines, early-exiting past the 2 needed to classify. */
function countDiffSignatures(text: string): number {
  let n = 0;
  for (const line of text.split('\n')) {
    if (DIFF_SIG.test(line) && ++n >= 2) break;
  }
  return n;
}

/**
 * True when the text carries a diff signature on at least two lines. A stray
 * single `+`/`-` line (a shell continuation, a menu bullet) is deliberately NOT
 * a diff — it never matches `DIFF_SIG` (which requires `+++ `/`--- ` headers,
 * `diff --git`, `index `, or `@@ `).
 */
export function isDiff(text: string): boolean {
  return countDiffSignatures(text) >= 2;
}

/**
 * Decide how `text` (for an event of `kind`) should be rendered. See the
 * module header for the deterministic precedence. Returns `markdown` only for
 * user/assistant events; structured tool-call / tool-result / heartbeat text
 * is decided by JSON-then-diff sniffing.
 */
export function renderMode(kind: string, text: string): RenderMode {
  if (kind === 'user' || kind === 'assistant') return 'markdown';
  if (prettyJson(text) !== null) return 'json';
  if (isDiff(text)) return 'diff';
  return 'plain';
}

/**
 * Classify a diff's lines for display. Each line maps to one of:
 *   `meta`  — `diff --git`, `index ...`, `--- a/...`, `+++ b/...` headers
 *   `hunk`  — `@@ -.. +.. @@`
 *   `add`   — `+` prefixed (but NOT `+++`, already consumed as `meta`)
 *   `del`   — `-` prefixed (but NOT `---`, already consumed as `meta`)
 *   `ctx`   — everything else (context / plain lines)
 * Returns a plain structure of strings; the template renders each through Svelte
 * text interpolation, never unsanitized HTML.
 */
export function renderDiffLines(text: string): DiffLine[] {
  return text.split('\n').map((line): DiffLine => {
    if (/^@@ /.test(line)) return { kind: 'hunk', text: line };
    if (/^(?:diff --git|index |--- |\+\+\+ )/.test(line)) return { kind: 'meta', text: line };
    if (line.startsWith('+')) return { kind: 'add', text: line };
    if (line.startsWith('-')) return { kind: 'del', text: line };
    return { kind: 'ctx', text: line };
  });
}
