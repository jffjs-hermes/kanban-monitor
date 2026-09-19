// Full board snapshot read (spec §1.2, §3 `readSnapshot`).
//
// One function, one read-only transaction. It drains every table the monitor
// consumes through `data-access.ts`, derives the card view models and the
// summary strip, and returns the typed snapshot. No SQL lives here.

import { boardDbPath, readBoardRows } from './data-access';
import { slugFromPath } from './board-discover';
import { classify } from './liveness';
import { lastTransitionOf } from './card-detail';
import type { Database } from 'bun:sqlite';
import type {
  BoardSnapshot,
  BoardSummary,
  CardView,
  TaskRow,
  TaskStatus,
} from '../types';

export interface SnapshotOptions {
  staleMs: number; // heartbeat staleness threshold (spec §5, default 90_000)
  now: number; // unix seconds — "current time" for this snapshot
  /**
   * Board revision this snapshot represents (spec §3.1). Stamped by the caller
   * (the runtime owns the counter); defaults to 0 when the caller has no
   * revision yet (pre-first-delta primes).
   */
  revision?: number;
}

const STATUS_ORDER: Record<TaskStatus, number> = {
  triage: 0,
  todo: 1,
  ready: 2,
  running: 3,
  review: 4,
  blocked: 5,
  done: 6,
  archived: 7,
};

function toCard(
  task: TaskRow,
  opts: SnapshotOptions,
  lastOutcome: string | null,
  parentIds: string[],
  childIds: string[],
  lastTransition: CardView['lastTransition'],
): CardView {
  const running = task.status === 'running';
  return {
    id: task.id,
    title: task.title,
    assignee: task.assignee,
    priority: task.priority,
    status: task.status,
    liveness: classify(task, opts.now, opts.staleMs),
    elapsedMs: running && task.started_at !== null ? (opts.now - task.started_at) * 1000 : null,
    createdAt: task.created_at,
    runCount: 0, // filled by caller
    lastOutcome,
    lastTransition,
    parentIds,
    childIds,
  };
}

/**
 * Read the full, typed state of a board as of `now`, in a single read-only
 * transaction (spec §3: `readSnapshot(db, opts)`). The board slug is recovered
 * from the handle itself (`PRAGMA database_list` → `board-discover` layout),
 * because a raw bun:sqlite `Database` does not carry its own slug.
 */
export function readSnapshot(db: Database, opts: SnapshotOptions): BoardSnapshot {
  const slug = slugFromPath(boardDbPath(db));
  const { tasks: taskRows, runs, events, links } = readBoardRows(db);

  // Latest attempt outcome per task (most recent run wins for stable results).
  const lastOutcome: Map<string, string | null> = new Map();
  const runCount: Map<string, number> = new Map();
  const runsById = [...runs].sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
  for (const r of runsById) {
    lastOutcome.set(r.task_id, r.outcome);
    runCount.set(r.task_id, (runCount.get(r.task_id) ?? 0) + 1);
  }

  // Link index: parent -> children, child -> parents.
  const children: Map<string, string[]> = new Map();
  const parents: Map<string, string[]> = new Map();
  for (const l of links) {
    children.set(l.parent_id, [...(children.get(l.parent_id) ?? []), l.child_id]);
    parents.set(l.child_id, [...(parents.get(l.child_id) ?? []), l.parent_id]);
  }

  // Most recent status move per task, from the same event fold the drawer
  // uses (locked decision §1). Grouped once so each card derives cheaply.
  const lastTransitions = new Map<string, CardView['lastTransition']>();
  {
    const byTask = new Map<string, typeof events>();
    for (const e of events) {
      const arr = byTask.get(e.task_id);
      if (arr) arr.push(e);
      else byTask.set(e.task_id, [e]);
    }
    for (const [id, evs] of byTask) lastTransitions.set(id, lastTransitionOf(evs));
  }

  // Non-archived cards, sorted status → priority (desc) → age (asc).
  const cards = taskRows
    .filter((t) => t.status !== 'archived')
    .sort(
      (a, b) =>
        STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
        b.priority - a.priority ||
        a.created_at - b.created_at,
    )
    .map((t) =>
      toCard(
        t,
        opts,
        lastOutcome.get(t.id) ?? null,
        parents.get(t.id) ?? [],
        children.get(t.id) ?? [],
        lastTransitions.get(t.id) ?? null,
      ),
    );

  // Fill runCount after building cards.
  for (const c of cards) c.runCount = runCount.get(c.id) ?? 0;

  const summary = buildSummary(cards, opts.now * 1000);
  return { slug, summary, cards, revision: opts.revision ?? 0 };
}

function buildSummary(cards: CardView[], nowMs: number): BoardSummary {
  const counts: Record<TaskStatus, number> = { triage: 0, todo: 0, ready: 0, running: 0, review: 0, blocked: 0, done: 0, archived: 0 };
  let runningCount = 0;
  let stalledCount = 0;
  for (const c of cards) {
    counts[c.status]++;
    if (c.status === 'running') runningCount++;
    if (c.liveness === 'stalled') stalledCount++;
  }
  return {
    countsByStatus: counts,
    runningCount,
    stalledCount,
    maxInProgress: null, // MVP: dispatcher-config source not confirmed yet (spec §3)
    lastSyncedAt: nowMs,
  };
}