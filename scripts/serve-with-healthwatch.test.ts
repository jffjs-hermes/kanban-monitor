// Unit tests for the healthwatch watchdog's probe-target derivation and the
// HEALTHWATCH_* numeric parsing (regression for the HOST=0.0.0.0 crash-loop and
// the 10ms-with-underscore-default bug that shipped in PR #28).
//
// The runtime side of serve-with-healthwatch.ts is guarded by `import.meta.main`
// and is therefore not executed when this file imports it under `bun test`.

import { describe, expect, it } from 'vitest';
import { listenerUrl, parseEnvPositiveInt, probeHostFor } from './serve-with-healthwatch';

describe('probeHostFor + listenerUrl (probe target must not be the bind HOST)', () => {
  const cases: Array<[bindHost: string, expectedUrl: string]> = [
    // Loopback bind already probes loopback verbatim.
    ['127.0.0.1', 'http://127.0.0.1:8787/'],
    // Wildcard binds must NOT be probed directly; probe loopback instead.
    ['0.0.0.0', 'http://127.0.0.1:8787/'],
    ['', 'http://127.0.0.1:8787/'],
    // IPv6 wildcard binds probe [::1], with the literal correctly bracketed.
    ['::', 'http://[::1]:8787/'],
    ['[::]', 'http://[::1]:8787/'],
    ['::1', 'http://[::1]:8787/'],
    // A resolvable hostname binds/probes as-is.
    ['localhost', 'http://localhost:8787/'],
  ];

  for (const [bindHost, expectedUrl] of cases) {
    it(`HOST=${bindHost || '<unset>'} probes ${expectedUrl}`, () => {
      expect(listenerUrl(probeHostFor(bindHost), 8787)).toBe(expectedUrl);
    });
  }
});

describe('parseEnvPositiveInt (underscore-safe HEALTHWATCH defaults)', () => {
  it('parses the underscore-shaped default as the full number, not just its prefix', () => {
    expect(parseEnvPositiveInt(undefined, 10_000)).toBe(10_000);
    expect(parseEnvPositiveInt(undefined, 15_000)).toBe(15_000);
    expect(parseEnvPositiveInt(undefined, 3_000)).toBe(3_000);
  });

  it('strips underscores from an explicit env value', () => {
    expect(parseEnvPositiveInt('10_000', 1_000)).toBe(10_000);
    expect(parseEnvPositiveInt('5000', 1_000)).toBe(5_000);
  });

  it('rejects missing, non-numeric, and non-positive values loudly', () => {
    expect(() => parseEnvPositiveInt('abc', 10_000)).toThrow();
    expect(() => parseEnvPositiveInt('0', 10_000)).toThrow();
    expect(() => parseEnvPositiveInt('-5', 10_000)).toThrow();
    expect(() => parseEnvPositiveInt('1.5', 10_000)).toThrow();
  });
});