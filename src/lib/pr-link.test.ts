// Unit tests: findPrUrl (Impl 9). Metadata path, comment fallback, and the
// no-PR / malformed-URL rejections the spec requires.

import { describe, expect, it } from 'vitest';
import { findPrUrl } from './pr-link';

const META = {
  ok: { published_pr: 'https://github.com/jffjs-hermes/kanban-monitor/pull/42' },
  other: { published_pr: 'https://github.com/jffjs-hermes/kanban-monitor/pull/7' },
  noPr: { worker_session_id: 's-1' },
  malformed: { published_pr: 'not-a-url' },
  partial: { published_pr: 'https://github.com/jffjs-hermes/kanban-monitor/pull/' },
  nonGithub: { published_pr: 'https://example.com/org/repo/pull/9' },
  protocolRelative: { published_pr: 'github.com/jffjs-hermes/kanban-monitor/pull/11' },
} as const;

describe('findPrUrl', () => {
  it('reads published_pr from run metadata (most recent first)', () => {
    // Most recent run's metadata wins over an older run's.
    expect(findPrUrl([META.ok, META.other], [])).toEqual({
      url: 'https://github.com/jffjs-hermes/kanban-monitor/pull/42',
      number: 42,
    });
    expect(findPrUrl([META.other, META.ok], [])).toEqual({
      url: 'https://github.com/jffjs-hermes/kanban-monitor/pull/7',
      number: 7,
    });
  });

  it('skips runs without published_pr / malformed, using the next valid run', () => {
    // Newest run has no published_pr → falls to the older valid run.
    expect(findPrUrl([META.noPr, META.ok], [])).toEqual(
      { url: 'https://github.com/jffjs-hermes/kanban-monitor/pull/42', number: 42 },
    );
    expect(findPrUrl([META.noPr, META.malformed], [])).toBeNull(); // none valid
    expect(findPrUrl([META.malformed, META.ok], [])).toEqual(
      { url: 'https://github.com/jffjs-hermes/kanban-monitor/pull/42', number: 42 },
    );
    expect(findPrUrl([META.partial, META.ok], [])).toEqual(
      { url: 'https://github.com/jffjs-hermes/kanban-monitor/pull/42', number: 42 },
    );
  });

  it('rejects malformed/partial/non-github metadata URLs', () => {
    // Partial (no number), non-github host, protocol-relative, bare string.
    expect(findPrUrl([META.partial], [])).toBeNull();
    expect(findPrUrl([META.nonGithub], [])).toBeNull();
    expect(findPrUrl([META.protocolRelative], [])).toBeNull();
    expect(findPrUrl([META.malformed], [])).toBeNull();
    expect(findPrUrl([null], [])).toBeNull();
    expect(findPrUrl([], [])).toBeNull();
  });

  it('falls back to the first GitHub PR URL in the comments', () => {
    const comments = [
      { body: 'approved — merge https://github.com/jffjs-hermes/kanban-monitor/pull/12 now' },
    ];
    expect(findPrUrl([], comments)).toEqual({
      url: 'https://github.com/jffjs-hermes/kanban-monitor/pull/12',
      number: 12,
    });

    // A scheme-less PR reference in prose also matches.
    expect(findPrUrl([], [{ body: 'see github.com/jffjs-hermes/kanban-monitor/pull/5' }])).toEqual({
      url: 'https://github.com/jffjs-hermes/kanban-monitor/pull/5',
      number: 5,
    });
  });

  it('uses the first comment match, and metadata wins over comments', () => {
    const first = { body: 'first: github.com/jffjs-hermes/kanban-monitor/pull/3' };
    const second = { body: 'second: https://github.com/jffjs-hermes/kanban-monitor/pull/88' };
    expect(findPrUrl([], [first, second])).toEqual({
      url: 'https://github.com/jffjs-hermes/kanban-monitor/pull/3',
      number: 3,
    });

    // A valid run metadata PR is preferred even when a comment also has a URL.
    expect(findPrUrl([META.ok], [second])).toEqual({
      url: 'https://github.com/jffjs-hermes/kanban-monitor/pull/42',
      number: 42,
    });
  });

  it('returns null when no PR is found anywhere', () => {
    expect(findPrUrl([META.noPr], [{ body: 'no links here' }])).toBeNull();
    expect(findPrUrl([], [{ body: 'partial github.com/x/y/pull/' }])).toBeNull();
    expect(findPrUrl([], [])).toBeNull();
  });
});