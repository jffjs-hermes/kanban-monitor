<script lang="ts">
  // Top strip (spec §1.2): per-status counts, #running, #stalled (from
  // liveness), and a "last updated" timestamp (spec §4: shown next to seq, with
  // frozen-view detectability — seq stalls with no ping). The maxInProgress
  // "slots" value is null in MVP (§3), rendered as "slots: —".
  import type { BoardSummary, TaskStatus } from '../types';

  let {
    summary,
    seq,
    now,
    connected,
  }: {
    summary: BoardSummary;
    seq: number | null;
    now: number;
    connected: boolean;
  } = $props();

  const STATUS_LABEL: Record<TaskStatus, string> = {
    ready: 'Ready',
    running: 'Running',
    review: 'Review',
    blocked: 'Blocked',
    done: 'Done',
    triage: 'Triage',
    todo: 'Todo',
    archived: 'Archived',
  };

  const TILES: TaskStatus[] = ['ready', 'running', 'review', 'blocked', 'done'];
  const AUX: TaskStatus[] = ['triage', 'todo', 'archived'];

  function fmtClock(ms: number): string {
    return new Date(ms).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }

  // Ensure every status has a count for stable rendering even when 0.
  const counts = $derived({
    ready: summary.countsByStatus.ready ?? 0,
    running: summary.countsByStatus.running ?? 0,
    review: summary.countsByStatus.review ?? 0,
    blocked: summary.countsByStatus.blocked ?? 0,
    done: summary.countsByStatus.done ?? 0,
    triage: summary.countsByStatus.triage ?? 0,
    todo: summary.countsByStatus.todo ?? 0,
    archived: summary.countsByStatus.archived ?? 0,
  });
</script>

<div class="border-t border-default py-5">
  <div class="flex flex-wrap items-center gap-2.5">
    {#each TILES as st (st)}
      <span class="rounded-md border border-default bg-surface px-3 py-2 text-[13px] text-muted" data-status={st}>
        <b class="mr-1 tabular-nums text-foreground">{counts[st]}</b> {STATUS_LABEL[st]}
      </span>
    {/each}
    <span class="rounded-md border border-default bg-surface px-3 py-2 text-[13px] text-muted"><b class="mr-1 tabular-nums text-accent">{summary.runningCount}</b> running</span>
    <span class="rounded-md border border-default bg-surface px-3 py-2 text-[13px] text-muted"><b class="mr-1 tabular-nums text-warning">{summary.stalledCount}</b> stalled</span>
  </div>
  <div class="mt-3 flex flex-wrap items-center gap-[18px] text-[12px] text-faint">
    <span class="slots">slots: {summary.maxInProgress ?? '—'}</span>
    <span class="text-muted">
      {#each AUX as st (st)}
        <b>{counts[st]}</b> {STATUS_LABEL[st]}{#if st !== 'archived'} · {/if}
      {/each}
    </span>
    <span class="clock"
      >last updated
      <b class="tabular-nums text-muted">{summary.lastSyncedAt ? fmtClock(now) : '—'}</b>
      {#if !connected}<span class="text-danger"> (offline)</span>{/if}
      {#if seq !== null}· <span data-seq>seq {seq}</span>{/if}</span
    >
  </div>
</div>
