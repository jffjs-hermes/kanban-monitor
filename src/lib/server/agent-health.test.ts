// Unit tests: per-profile agent health derivation (spec §1.2 acceptance).
// Pure fixture tests over synthetic TaskRow/RunRow pairs: active worker, stale
// heartbeat, and an idle board with no running cards.

import { describe, expect, it } from 'vitest';
import { deriveAgentHealth } from './agent-health';
import { DEFAULT_STALE_MS } from './liveness';
import type { RunRow, TaskRow } from '../types';

function task(over: Partial<TaskRow>): TaskRow {
  return {
    id: over.id ?? 't1',
    title: '',
    body: '',
    assignee: over.assignee ?? null,
    status: over.status ?? 'running',
    priority: 0,
    created_at: 0,
    started_at: over.started_at ?? null,
    completed_at: null,
    worker_pid: null,
    last_heartbeat_at: over.last_heartbeat_at ?? null,
    current_run_id: null,
    block_kind: null,
  };
}

function run(over: Partial<RunRow>): RunRow {
  return {
    id: over.id ?? 1,
    task_id: over.task_id ?? 't1',
    status: over.status ?? 'running',
    outcome: null,
    summary: null,
    worker_pid: over.worker_pid ?? null,
    worker_session_id: over.worker_session_id ?? null,
    profile: over.profile ?? null,
    started_at: over.started_at ?? null,
    ended_at: null,
    error: null,
    metadata: null,
  };
}

describe('deriveAgentHealth', () => {
  const now = 1_000_000_000;
  const staleMs = DEFAULT_STALE_MS; // 90_000

  it('reports an active worker: pid, session, run start, fresh heartbeat age', () => {
    const tasks = [task({ id: 't1', assignee: 'builder', last_heartbeat_at: now - 12 })];
    const runs = [
      run({
        id: 7,
        task_id: 't1',
        worker_pid: 4242,
        worker_session_id: 'sess-abc',
        started_at: now - 60,
      }),
    ];
    const h = deriveAgentHealth(tasks, runs, now, staleMs);
    expect(h).toHaveLength(1);
    const [e] = h;
    expect(e.profile).toBe('builder');
    expect(e.runningCardCount).toBe(1);
    expect(e.workerPid).toBe(4242);
    expect(e.workerSessionId).toBe('sess-abc');
    expect(e.runStartedAt).toBe(now - 60);
    expect(e.heartbeatAgeSec).toBe(12);
    expect(e.stale).toBe(false);
  });

  it('flags a stale heartbeat (age >= threshold) and keeps age', () => {
    const tasks = [task({ id: 't1', assignee: 'reviewer', last_heartbeat_at: now - staleMs - 5 })];
    const runs = [run({ id: 1, task_id: 't1', worker_pid: 99, started_at: now - staleMs * 10 })];
    const [e] = deriveAgentHealth(tasks, runs, now, staleMs);
    expect(e.stale).toBe(true);
    expect(e.heartbeatAgeSec).toBe(staleMs + 5);
  });

  it('flags a running card with no recorded heartbeat as stale, heartbeatAgeSec null', () => {
    const tasks = [task({ id: 't1', assignee: 'builder', last_heartbeat_at: null })];
    const runs = [run({ id: 2, task_id: 't1', worker_pid: 8, started_at: now - 10 })];
    const [e] = deriveAgentHealth(tasks, runs, now, staleMs);
    expect(e.stale).toBe(true);
    expect(e.heartbeatAgeSec).toBeNull();
  });

  it('counts multiple running cards per profile and uses the freshest heartbeat', () => {
    const tasks = [
      task({ id: 'a', assignee: 'builder', last_heartbeat_at: now - 200_000 }), // stale card
      task({ id: 'b', assignee: 'builder', last_heartbeat_at: now - 5 }), // fresh card
    ];
    const runs = [
      run({ id: 10, task_id: 'b', worker_pid: 111, started_at: now - 30 }),
      run({ id: 9, task_id: 'a', worker_pid: 222, started_at: now - 900 }),
    ];
    const [e] = deriveAgentHealth(tasks, runs, now, staleMs);
    expect(e.runningCardCount).toBe(2);
    // Worker is alive while any active card heartbeats.
    expect(e.stale).toBe(false);
    expect(e.heartbeatAgeSec).toBe(5);
    // Latest run (highest id) supplies pid/session.
    expect(e.workerPid).toBe(111);
  });

  it('uses the latest run even when the freshest-running profile has older runs', () => {
    const tasks = [task({ id: 'a', assignee: 'lead', last_heartbeat_at: now - 1 })];
    const runs = [
      run({ id: 3, task_id: 'a', worker_pid: 1, started_at: now - 500 }),
      run({ id: 4, task_id: 'a', worker_pid: 2, worker_session_id: 'sess-new', started_at: now - 400 }),
    ];
    const [e] = deriveAgentHealth(tasks, runs, now, staleMs);
    expect(e.workerPid).toBe(2);
    expect(e.workerSessionId).toBe('sess-new');
  });

  it('excludes profiles with no running card', () => {
    const tasks = [
      task({ id: 'done1', assignee: 'builder', status: 'done', last_heartbeat_at: now - 1 }),
      task({ id: 'todo1', assignee: 'researcher', status: 'todo', last_heartbeat_at: now - 1 }),
    ];
    const runs = [run({ id: 1, task_id: 'done1', worker_pid: 5, started_at: now - 10 })];
    expect(deriveAgentHealth(tasks, runs, now, staleMs)).toEqual([]);
  });

  it('is empty on an idle board (no active runs) and never throws', () => {
    expect(deriveAgentHealth([], [], now, staleMs)).toEqual([]);
    const idle = [task({ id: 'x', assignee: 'builder', status: 'todo' })];
    expect(deriveAgentHealth(idle, [], now, staleMs)).toEqual([]);
  });

  it('sorts entries deterministically by profile name', () => {
    const tasks = [
      task({ id: 'a', assignee: 'zeta', last_heartbeat_at: now - 1 }),
      task({ id: 'b', assignee: 'alpha', last_heartbeat_at: now - 1 }),
    ];
    const runs = [
      run({ id: 1, task_id: 'a', started_at: now - 1 }),
      run({ id: 2, task_id: 'b', started_at: now - 1 }),
    ];
    const profiles = deriveAgentHealth(tasks, runs, now, staleMs).map((e) => e.profile);
    expect(profiles).toEqual(['alpha', 'zeta']);
  });
});