// Client-side markdown rendering for card bodies (`tasks.body`).
//
// Card bodies are semi-trusted team content — they may contain arbitrary
// links and markup, and they come from a SQLite board file — so the rendered
// HTML is always sanitized before it is handed to `{@html}`. Pipeline:
//   marked (GFM: tables, strikethrough, autolinks, breaks) → DOMPurify.
//
// This module is client-only by design: the app is `ssr=false`, so the
// browser DOM (which DOMPurify needs) is always present in the running app.
// The default export of `dompurify` is an already-bound sanitizer instance in
// the browser, but a *factory* expecting a window in a DOM-less test runner —
// resolve whichever form is present so `renderMarkdown` behaves identically
// in both.

import createDOMPurify from 'dompurify';
import { marked } from 'marked';

type Sanitizer = { sanitize(input: string): string };

const purify: Sanitizer = (
  typeof (createDOMPurify as unknown as Sanitizer).sanitize === 'function'
    ? (createDOMPurify as unknown as Sanitizer)
    : (createDOMPurify as unknown as (win: Window) => Sanitizer)(window)
);

/**
 * Parse a card body's markdown and return sanitized, safe HTML.
 * Empty/null/undefined bodies produce an empty string.
 */
export function renderMarkdown(body: string | null | undefined): string {
  if (!body) return '';
  const html = marked.parse(body, { gfm: true, breaks: true, async: false }) as string;
  return purify.sanitize(html);
}