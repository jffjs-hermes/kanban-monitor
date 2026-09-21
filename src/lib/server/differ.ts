// Snapshot differ (spec §1.2, §2.1, §3 `diffSnapshot`).
//
// Pure module: compares the previous board snapshot against the next one and
// produces the scoped deltas a client needs. Only `differ.ts` decides "what
// changed" (spec §1.2 boundary rule). No SQL, no timers, no I/O.

import type { AgentHealth, BoardSnapshot, CardView, DeltaScope } from '../types';

/** Fraction of cards that may change before we fall back to a reset (spec §2.1). */
const RESET_CHANGED_RATIO = 0.3;

/**
 * Ratio resets only guard against pathological re-orgs on boards large enough
 * for a full resend to beat a scoped delta. On small boards a scoped delta is
 * always cheaper than a full resend, so a single change there must not escalate
 * to a reset (card acceptance: added/updated/removed stay scoped deltas).
 */
const RESET_MIN_CARDS = 10;

/**
 * Fields that drive per-card change detection (spec §2.1). Heartbeat freshness
 * is intentionally NOT compared here — a running card whose only change is a
 * fresh tick within the same liveness class produces no delta.
 */
type Diffable = Pick<
  CardView,
  'status' | 'priority' | 'assignee' | 'liveness' | 'title' | 'runCount' | 'lastOutcome'
>;

function diffableOf(c: CardView): Diffable {
  return {
    status: c.status,
    priority: c.priority,
    assignee: c.assignee,
    liveness: c.liveness,
    title: c.title,
    runCount: c.runCount,
    lastOutcome: c.lastOutcome,
  };
}

function sameCard(a: CardView, b: CardView): boolean {
  const pa = diffableOf(a);
  const pb = diffableOf(b);
  return (
    pa.status === pb.status &&
    pa.priority === pb.priority &&
    pa.assignee === pb.assignee &&
    pa.liveness === pb.liveness &&
    pa.title === pb.title &&
    pa.runCount === pb.runCount &&
    pa.lastOutcome === pb.lastOutcome
  );
}

/**
 * Whether the strip-level summary changed. `lastSyncedAt` ticks every poll, so
 * it is excluded from change detection (like elapsed timers, which tick
 * client-side — spec §2.1). Only the derived counts trigger a 'summary' scope.
 */
function sameSummary(a: BoardSnapshot, b: BoardSnapshot): boolean {
  const sa = a.summary;
  const sb = b.summary;
  if (sa.runningCount !== sb.runningCount) return false;
  if (sa.stalledCount !== sb.stalledCount) return false;
  if (sa.maxInProgress !== sb.maxInProgress) return false;
  const ka = Object.keys(sa.countsByStatus) as (keyof typeof sa.countsByStatus)[];
  for (const k of ka) if (sa.countsByStatus[k] !== sb.countsByStatus[k]) return false;
  return true;
}

/**
 * Whether the per-profile worker health changed (spec §1.2 agent health).
 *
 * `heartbeatAgeSec` is intentionally NOT compared: it re-derives from `now`
 * every poll, so a healthy worker's age simply ticks up and would false-positive
 * on every tick. The `stale` boolean IS the heartbeat-age bucket (age below /
 * at-or-above STALE_WORKER_MS), matching the card liveness boundary — so a
 * heartbeat-age change is a health-content change only when it crosses into or
 * out of the stale bucket. Compare the stable identity + derived fields instead.
 * Array equality by profile (arrays are deterministically sorted in
 * `deriveAgentHealth`).
 */
function sameHealth(a: readonly AgentHealth[], b: readonly AgentHealth[]): boolean {
  if (a.length !== b.length) return false;
  const byProfile = new Map(b.map((h) => [h.profile, h]));
  for (const ha of a) {
    const hb = byProfile.get(ha.profile);
    if (!hb) return false;
    if (
      ha.runningCardCount !== hb.runningCardCount ||
      ha.workerPid !== hb.workerPid ||
      ha.workerSessionId !== hb.workerSessionId ||
      ha.runStartedAt !== hb.runStartedAt ||
      ha.stale !== hb.stale
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Diff `prev` against `next`, returning the scopes to push (spec §3).
 *
 * - `prev === null` (first tick) → `reset` (client needs the full state).
 * - board slug changed → `reset`.
 * - >~30% of cards changed → `reset` (full resend beats a large delta).
 * - otherwise → 'summary' if the strip changed, 'health' if worker health
 *   changed, 'cards' if the card set/fields changed, plus a 'card' scope per
 *   changed task id (open drawers refresh).
 */
export function diffSnapshot(prev: BoardSnapshot | null, next: BoardSnapshot): DeltaScope[] {
  if (prev === null) return [{ kind: 'reset' }];
  if (prev.slug !== next.slug) return [{ kind: 'reset' }];

  const nextById = new Map(next.cards.map((c) => [c.id, c]));
  const prevById = new Map(prev.cards.map((c) => [c.id, c]));

  const upserts: CardView[] = [];
  const removedIds: string[] = [];
  const changedIds: string[] = [];

  for (const c of next.cards) {
    const p = prevById.get(c.id);
    if (!p || !sameCard(p, c)) {
      upserts.push(c);
      changedIds.push(c.id);
    }
  }
  for (const p of prev.cards) {
    if (!nextById.has(p.id)) {
      removedIds.push(p.id);
      changedIds.push(p.id);
    }
  }

  const changedCount = upserts.length + removedIds.length;
  const cardCount = Math.max(next.cards.length, 1);
  if (cardCount >= RESET_MIN_CARDS && changedCount / cardCount > RESET_CHANGED_RATIO) {
    return [{ kind: 'reset' }];
  }

  const scopes: DeltaScope[] = [];
  if (!sameSummary(prev, next)) scopes.push({ kind: 'summary' });
  if (!sameHealth(prev.health, next.health)) scopes.push({ kind: 'health', health: next.health });
  if (upserts.length > 0 || removedIds.length > 0) {
    scopes.push({ kind: 'cards', upserts, removedIds });
  }
  for (const id of changedIds) scopes.push({ kind: 'card', taskId: id });
  return scopes;
}