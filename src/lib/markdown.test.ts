// Unit tests for renderMarkdown. DOMPurify needs a DOM, so register jsdom
// globals BEFORE the module is loaded (via dynamic import below); otherwise
// dompurify's default export would be the Node *factory* rather than a bound
// sanitizer instance.
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

const dom = new JSDOM('');
Object.assign(globalThis, { window: dom.window, document: dom.window.document });

const { renderMarkdown } = await import('./markdown');

describe('renderMarkdown', () => {
  it('renders headings, bold/italic, lists, links, code, and GFM tables to HTML', () => {
    const md =
      '# Title\n\n' +
      '**bold** and *italic*\n\n' +
      '- one\n- two\n\n' +
      '[link](https://example.com)\n\n' +
      '`inline`\n\n' +
      '```\nblock code\n```\n\n' +
      '| a | b |\n|---|--:|\n| 1 | 2 |';
    const html = renderMarkdown(md);
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>italic</em>');
    expect(html).toContain('<ul>');
    expect(html).toContain('<a href="https://example.com">link</a>');
    expect(html).toContain('<code>inline</code>');
    expect(html).toContain('<table>');
    expect(html).toContain('<th>a</th>');
  });

  it('applies GFM autolinks and strikethrough', () => {
    const html = renderMarkdown('see https://example.com and ~~gone~~');
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('<del>gone</del>');
  });

  it('sanitizes malicious markup: strips scripts and event handlers', () => {
    const html = renderMarkdown('<script>alert(1)</script><img src=x onerror="alert(2)">');
    expect(html).not.toContain('<script');
    expect(html.toLowerCase()).not.toContain('onerror');
    // the img tag survives (safe) but only with its harmless src attribute
    expect(html).toContain('<img src="x">');
  });

  it('strips javascript: links', () => {
    const html = renderMarkdown('[bad](javascript:alert(1))');
    expect(html.toLowerCase()).not.toContain('javascript:');
  });

  it('returns an empty string for empty, null, and undefined bodies', () => {
    expect(renderMarkdown('')).toBe('');
    expect(renderMarkdown(null)).toBe('');
    expect(renderMarkdown(undefined)).toBe('');
  });
});