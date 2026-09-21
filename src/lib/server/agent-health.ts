// Per-profile agent health derivation (spec §1.2, agent health panel).
//
// Pure and unit-testable: folds the already-read `tasks` and `task_runs` rows
// into one compact `AgentHealth` entry per profile that currently has a running
// card. Read-only — it observes board data only and never touches the state
// machine (locked decision §1). Liveness semantics are reused from
// `liveness.classify`, so "stale" here means exactly what it means per card:
// heartbeat missing while running, or age >= STALE_WORKER_MS.

import { classify } from './liveness';
import type { AgentHealth, RunRow, TaskRow } from '../types';

/**
 * Fold a board's tasks + runs into per-profile health entries.
 *
 * - Only profiles with >= 1 `status='running'` task are shown (an idle board —
 *   no active runs — yields `[]`, which the panel renders as clean/empty).
 * - `workerPid` / `workerSessionId` / `runStartedAt` come from the profile's
 *   latest run (task_runs by descending id) — the persistent record a reader
 *   can cross-reference the session id against.
 * - `heartbeatAgeSec` is the age of the freshest heartbeat among the profile's
 *   running cards; `stale` reuses `classify` on that representative card so the
 *   boundary rule (age < staleMs active, >= staleMs stalled) matches the rest of
 *   the monitor exactly.
 */
export function deriveAgentHealth(
  tasks: TaskRow[],
  runs: RunRow[],
  now: number,
  staleMs: number,
): AgentHealth[] {
  // Profile -> its running cards. A profile enters the panel only while running.
  const runningByProfile = new Map<string, TaskRow[]>();
  // task_id -> assignee, to attribute each run to its owning profile.
  const assigneeByTask = new Map<string, string | null>();
  for (const t of tasks) {
    assigneeByTask.set(t.id, t.assignee);
    if (t.status === 'running' && t.assignee !== null) {
      const arr = runningByProfile.get(t.assignee);
      if (arr) arr.push(t);
      else runningByProfile.set(t.assignee, [t]);
    }
  }
  if (runningByProfile.size === 0) return [];

  // Profile -> all its runs (assigned via the run's task).
  const runsByProfile = new Map<string, RunRow[]>();
  for (const r of runs) {
    const assignee = assigneeByTask.get(r.task_id);
    if (assignee === undefined || assignee === null) continue;
    const arr = runsByProfile.get(assignee);
    if (arr) arr.push(r);
    else runsByProfile.set(assignee, [r]);
  }

  const health: AgentHealth[] = [];
  for (const [profile, runningCards] of runningByProfile) {
    // Representative running card = the one with the freshest heartbeat (a
    // worker heartbeating any active card is alive). Ties break to the first.
    let rep = runningCards[0];
    for (const c of runningCards) {
      if (
        c.last_heartbeat_at !== null &&
        (rep.last_heartbeat_at === null || c.last_heartbeat_at! > rep.last_heartbeat_at!)
      ) {
        rep = c;
      }
    }
    const heartbeatAgeSec =
      rep.last_heartbeat_at === null ? null : now - rep.last_heartbeat_at;
    const stale = classify(rep, now, staleMs) === 'stalled';

    const profileRuns = (runsByProfile.get(profile) ?? []).slice().sort(
      (a, b) => (b.id ?? 0) - (a.id ?? 0),
    );
    const latest = profileRuns[0];

    health.push({
      profile,
      runningCardCount: runningCards.length,
      workerPid: latest?.worker_pid ?? null,
      workerSessionId: latest?.worker_session_id ?? null,
      runStartedAt: latest?.started_at ?? null,
      heartbeatAgeSec,
      stale,
    });
  }

  // Deterministic order for the panel.
  health.sort((a, b) => (a.profile < b.profile ? -1 : a.profile > b.profile ? 1 : 0));
  return health;
}