// Card detail read (spec §1.2 `CardDetailDrawer`, §2 `CardDetail`).
//
// Builds the full typed detail payload for ONE card (regardless of status,
// including archived) using the data layer's typed reads (`readBoardRows`, the
// only SQL touch-point — spec §1.2 boundary rule). Drains the five tables in a
// single read-only transaction so the card, its runs, comments, links, and the
// event trail are mutually consistent, then derives:
//   - the `CardView` for the card (same shape the board consumes, spec §2);
//   - the status-transition trail from `task_events` (§2 `CardDetail.transitions`);
//   - that card's runs (attempts/outcomes) and comments.
//
// No SQL lives here; the trail is derived from event *kinds* and their JSON
// payloads, folding chronological events into from→to status transitions.

import { readBoardRows } from './data-access';
import { classify } from './liveness';
import type { SnapshotOptions } from './snapshot';
import type { Database } from 'bun:sqlite';
import type {
  CardDetail,
  CardView,
  EventRow,
  TaskLinkRow,
  TaskRow,
  TaskStatus,
} from '../types';

function parsePayload(payload: string | null): Record<string, unknown> | null {
  if (!payload) return null;
  try {
    const v = JSON.parse(payload);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * The status a card is in immediately *after* this event, or `null` when the
 * event kind carries no reliable status signal (heartbeat / spawned /
 * commented / …). Best-effort mapping for the free-form event vocabulary:
 *
 *   created            -> payload.status (the initial status; fallback 'todo')
 *   claimed            -> running        (a worker picked the card up)
 *   promoted           -> ready          (parent completed → child advanced)
 *   blocked            -> blocked
 *   changes_requested  -> payload.status (the status returned to; fallback ready)
 *   review_requested   -> review
 *   completed          -> done
 *   archived           -> archived
 *
 * Events without a status target are skipped by the trail fold, so the trail
 * shows only genuine status moves (created → … → done), deduplicating
 * consecutive same-status repeats (e.g. re-reviews round-trip review→running).
 */
export function statusAfterEvent(
  kind: string,
  payload: string | null,
): TaskStatus | null {
  switch (kind) {
    case 'created':
      return (parsePayload(payload)?.['status'] as TaskStatus) ?? 'todo';
    case 'claimed':
      return 'running';
    case 'promoted':
      return 'ready';
    case 'blocked':
      return 'blocked';
    case 'changes_requested':
      return (parsePayload(payload)?.['status'] as TaskStatus) ?? 'ready';
    case 'review_requested':
      return 'review';
    case 'completed':
      return 'done';
    case 'archived':
      return 'archived';
    default:
      return null;
  }
}

/** Fold an event list into chronological from→to status transitions (§2). */
export function deriveTransitions(events: EventRow[]): CardDetail['transitions'] {
  const sorted = [...events].sort((a, b) => a.created_at - b.created_at || a.id - b.id);
  const out: CardDetail['transitions'] = [];
  let last: TaskStatus | null = null;
  for (const ev of sorted) {
    const to = statusAfterEvent(ev.kind, ev.payload);
    if (to === null || to === last) continue;
    out.push({ from: last, to, at: ev.created_at });
    last = to;
  }
  return out;
}

/**
 * The card's most recent status move, as the board card flash needs it:
 * `{ to, at }` of the last transition in the trail, or `null` when the card
 * has no recorded status move. Reuses the same deriveTransitions fold as the
 * drawer trail (locked decision §1) so the board annotation and the drawer
 * always agree on what counts as a transition.
 */
export function lastTransitionOf(events: EventRow[]): CardView['lastTransition'] {
  const trail = deriveTransitions(events);
  if (trail.length === 0) return null;
  const last = trail[trail.length - 1];
  return { to: last.to, at: last.at };
}

/** One card's view model, mirroring `snapshot.ts` derivation but for a single
 * card (and including archived cards). */
function buildCard(
  task: TaskRow,
  runs: CardDetail['runs'],
  links: TaskLinkRow[],
  opts: SnapshotOptions,
  lastTransition: CardView['lastTransition'],
): CardView {
  const taskRuns = runs
    .filter((r) => r.task_id === task.id)
    .sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
  const lastOutcome = taskRuns.length > 0 ? taskRuns[taskRuns.length - 1].outcome : null;
  const runCount = taskRuns.length;

  const children: string[] = [];
  const parents: string[] = [];
  for (const l of links) {
    if (l.parent_id === task.id) children.push(l.child_id);
    if (l.child_id === task.id) parents.push(l.parent_id);
  }

  const running = task.status === 'running';
  return {
    id: task.id,
    title: task.title,
    assignee: task.assignee,
    priority: task.priority,
    status: task.status,
    liveness: classify(task, opts.now, opts.staleMs),
    elapsedMs:
      running && task.started_at !== null ? (opts.now - task.started_at) * 1000 : null,
    createdAt: task.created_at,
    runCount,
    lastOutcome,
    lastTransition,
    parentIds: parents,
    childIds: children,
  };
}

/**
 * Full typed detail for one card (spec §2 `CardDetail`), or `null` when the
 * task does not exist in this board. Reads through `readBoardRows` in a single
 * transaction. `runCount`/`lastOutcome` derive from the most recent run; the
 * transition trail comes from `task_events`.
 */
export function readCardDetail(
  db: Database,
  taskId: string,
  opts: SnapshotOptions,
): CardDetail | null {
  const { tasks, runs, events, comments, links } = readBoardRows(db);
  const task = tasks.find((t) => t.id === taskId);
  if (!task) return null;

  const card = buildCard(task, runs, links, opts, lastTransitionOf(events.filter((e) => e.task_id === taskId)));
  const transitions = deriveTransitions(events.filter((e) => e.task_id === taskId));
  const taskRuns = runs
    .filter((r) => r.task_id === taskId)
    .sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
  const taskComments = comments
    .filter((c) => c.task_id === taskId)
    .sort((a, b) => a.id - b.id);

  return {
    card,
    body: task.body ?? '',
    transitions,
    runs: taskRuns,
    comments: taskComments,
  };
}
