// Unit tests: transcript-render — pure, DOM-free decision helpers for the
// transcript viewer's event rendering (deterministic mode precedence, diff
// line classification, pretty JSON). The markdown branch is the one raw-HTML
// sink, so it routes through the existing renderMarkdown (marked → DOMPurify);
// we verify that sanitizer strips script/handlers (as in markdown.test.ts) and
// that the helpers themselves never emit HTML.
//
// jsdom must be registered before the module graph that imports dompurify
// loads a bound sanitizer, mirroring markdown.test.ts.

import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

const dom = new JSDOM('');
Object.assign(globalThis, { window: dom.window, document: dom.window.document });

const { renderMarkdown } = await import('./markdown');
const { prettyJson, renderMode, renderDiffLines, isDiff } = await import('./transcript-render');

describe('renderMode — markdown kind precedence', () => {
  it('routes user events to markdown even when the body starts with {', () => {
    expect(renderMode('user', '{"answer": 42}')).toBe('markdown');
  });

  it('routes assistant events to markdown even when the body looks like a diff', () => {
    expect(renderMode('assistant', 'diff --git a/x b/x\n@@ -1 +1 @@\n+changed')).toBe('markdown');
  });

  it('does not treat tool-kind text as markdown', () => {
    expect(renderMode('tool-result', 'diff --git a/x b/x\n@@ -1 +1 @@\n-changed\n+new\n')).toBe('diff');
    expect(renderMode('heartbeat', '{"ok":1}')).toBe('json');
  });
});

describe('renderMode — structured JSON precedence', () => {
  it('pretty-prints a valid top-level object', () => {
    expect(renderMode('tool-result', '{"ok":true,"n":1}')).toBe('json');
    expect(prettyJson('{"ok":true,"n":1}')).toBe('{\n  "ok": true,\n  "n": 1\n}');
  });

  it('pretty-prints a valid top-level array', () => {
    expect(renderMode('tool-call', '[1,2]')).toBe('json');
    expect(prettyJson('[1,2]')).toBe('[\n  1,\n  2\n]');
  });

  it('classifies a scalar JSON value as plain, not json', () => {
    expect(prettyJson('42')).toBeNull();
    expect(prettyJson('"str"')).toBeNull();
    expect(prettyJson('true')).toBeNull();
    expect(renderMode('tool-result', '42')).toBe('plain');
  });

  it('falls back to plain for malformed/truncated JSON', () => {
    expect(prettyJson('{"ok": tru')).toBeNull();
    expect(prettyJson('{"unclosed"')).toBeNull();
    expect(prettyJson('not json at all')).toBeNull();
    expect(renderMode('tool-result', '{"ok": tru')).toBe('plain');
  });
});

describe('renderMode — plain fallback', () => {
  it('renders a bare terminal command as plain', () => {
    expect(renderMode('tool-result', 'npm install --save marked')).toBe('plain');
    expect(isDiff('npm install')).toBe(false);
  });

  it('renders empty/whitespace text as plain', () => {
    expect(renderMode('tool-result', '')).toBe('plain');
    expect(renderMode('tool-result', '   ')).toBe('plain');
  });
});

describe('renderMode — diff signatures', () => {
  it('classifies a real unified diff by its signature lines', () => {
    const d = 'diff --git a/x b/x\n' + 'index 000..111\n' + '--- a/x\n' + '+++ b/x\n' + '@@ -1,3 +1,3 @@\n' + '-old\n' + '+new\n' + ' context\n';
    expect(isDiff(d)).toBe(true);
    expect(renderMode('tool-result', d)).toBe('diff');
  });

  it('requires at least two signature lines to qualify as a diff', () => {
    // A single `+++ b/x` header (one signature line) is not enough.
    const single = '+++ b/x\n+new\n';
    expect(isDiff(single)).toBe(false);
    expect(renderMode('tool-result', single)).toBe('plain');
  });

  it('does not treat a stray single + line (shell/menu) as a diff', () => {
    const stray = '+ quickly add\nanother line\nmore\n';
    expect(isDiff(stray)).toBe(false);
    expect(renderMode('tool-result', stray)).toBe('plain');
  });
});

describe('renderDiffLines — line classification', () => {
  const d = 'diff --git a/x b/x\n' + 'index 000..111\n' + '--- a/x\n' + '+++ b/x\n' + '@@ -1,3 +1,3 @@\n' + '-old\n' + '+new\n' + ' context\n';
  const lines = renderDiffLines(d);

  it('labels metadata headers as meta', () => {
    const meta = lines.filter((l) => l.kind === 'meta').map((l) => l.text);
    expect(meta).toEqual(['diff --git a/x b/x', 'index 000..111', '--- a/x', '+++ b/x']);
  });

  it('labels the hunk header as hunk', () => {
    expect(lines.filter((l) => l.kind === 'hunk').map((l) => l.text)).toEqual(['@@ -1,3 +1,3 @@']);
  });

  it('labels +/- prefixed lines as add/del (excluding --- / +++), and the rest as ctx', () => {
    const k = lines.map((l) => l.kind);
    // The fixture ends with a newline, so a trailing empty line classifies as ctx.
    expect(k).toEqual(['meta', 'meta', 'meta', 'meta', 'hunk', 'del', 'add', 'ctx', 'ctx']);
    expect(lines.find((l) => l.text === '-old')!.kind).toBe('del');
    expect(lines.find((l) => l.text === '+new')!.kind).toBe('add');
    expect(lines.find((l) => l.text === ' context')!.kind).toBe('ctx');
  });
});

describe('HTML safety', () => {
  it('markdown output is sanitized: scripts and handlers are removed', () => {
    const html = renderMarkdown('<script>alert(1)</script><img src=x onerror="alert(2)">');
    expect(html).not.toContain('<script');
    expect(html.toLowerCase()).not.toContain('onerror');
  });

  it('renderMode still routes hostile content in user events to markdown (the sanitizer gate)', () => {
    expect(renderMode('user', '<script>alert(1)</script>')).toBe('markdown');
  });

  it('helpers never emit HTML', () => {
    // prettyJson returns the raw JSON string; embedded tag-lookalikes stay literal text.
    expect(prettyJson('{"a":"<b>hi</b>"}')).toBe('{\n  "a": "<b>hi</b>"\n}');
    // Hostile content in a non-markdown kind routes to plain (escaped by Svelte).
    expect(renderMode('tool-result', '<script>x</script>')).toBe('plain');
    // renderDiffLines returns plain structured strings; angle-bracket text is
    // preserved verbatim as text content, never turned into a tag.
    const [l] = renderDiffLines('<div onclick=x>+ <script></script>');
    expect(l.kind).toBe('ctx');
    expect(l.text).toBe('<div onclick=x>+ <script></script>');
  });
});
