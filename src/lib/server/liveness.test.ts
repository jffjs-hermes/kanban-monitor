// Unit tests: liveness classification (spec §1.2, §3, §7).
// Pure fixture tests against synthetic TaskRows and heartbeat timestamps.

import { describe, expect, it } from 'vitest';
import { classify, DEFAULT_STALE_MS } from './liveness';
import type { TaskRow } from '../types';

function task(over: Partial<TaskRow>): TaskRow {
  return {
    id: 't',
    title: '',
    body: '',
    assignee: null,
    status: 'running',
    priority: 0,
    created_at: 0,
    started_at: null,
    completed_at: null,
    worker_pid: null,
    last_heartbeat_at: null,
    current_run_id: null,
    block_kind: null,
    ...over,
  };
}

describe('classify', () => {
  const now = 1_000_000_000;
  const staleMs = DEFAULT_STALE_MS; // 90_000

  it('returns active for a running card with a fresh heartbeat', () => {
    expect(classify(task({ last_heartbeat_at: now - 1 }), now, staleMs)).toBe('active');
    expect(classify(task({ last_heartbeat_at: now - (staleMs - 1) }), now, staleMs)).toBe('active');
  });

  it('returns stalled at exactly the staleness boundary', () => {
    // now - last_heartbeat_at === staleMs is NOT < staleMs → stalled.
    expect(classify(task({ last_heartbeat_at: now - staleMs }), now, staleMs)).toBe('stalled');
  });

  it('returns stalled for a heartbeat older than the threshold', () => {
    expect(classify(task({ last_heartbeat_at: now - staleMs - 1 }), now, staleMs)).toBe('stalled');
    expect(classify(task({ last_heartbeat_at: now - staleMs * 100 }), now, staleMs)).toBe('stalled');
  });

  it('returns stalled for a running card with no recorded heartbeat', () => {
    expect(classify(task({ last_heartbeat_at: null }), now, staleMs)).toBe('stalled');
  });

  it('returns null for non-running cards regardless of heartbeat', () => {
    for (const status of ['todo', 'ready', 'done', 'review', 'blocked'] as const) {
      expect(classify(task({ status, last_heartbeat_at: now - 1 }), now, staleMs)).toBeNull();
      expect(classify(task({ status, last_heartbeat_at: null }), now, staleMs)).toBeNull();
    }
  });

  it('respects a custom (env-overridable) threshold', () => {
    // Threshold probe window of 10ms.
    expect(classify(task({ last_heartbeat_at: now - 9 }), now, 10)).toBe('active');
    expect(classify(task({ last_heartbeat_at: now - 11 }), now, 10)).toBe('stalled');
  });
});