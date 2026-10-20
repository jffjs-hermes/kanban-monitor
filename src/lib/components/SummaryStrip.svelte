<script lang="ts">
  // Top strip (spec §1.2): per-status counts, #running, #stalled (from
  // liveness), and a "last updated" timestamp (spec §4: shown next to seq, with
  // frozen-view detectability — seq stalls with no ping). The maxInProgress
  // "slots" value is null in MVP (§3), rendered as "slots: —".
  //
  // Card D: each column chip also shows its own card count, its stalled running
  // cards (Running only), and a "last updated" relative age. The per-column
  // aggregate comes from `columnSummary(cards)` — computed once per snapshot —
  // and only the age label ticks from the existing `now` clock, in the same
  // relative-age style as the card footers.
  import { columnSummary, relativeAge, type ColumnSummary } from '../board-view';
  import type { BoardSummary, CardView, TaskStatus } from '../types';

  let {
    summary,
    cards,
    seq,
    now,
    connected,
  }: {
    summary: BoardSummary;
    cards: CardView[];
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

  // Per-column detail, derived once per snapshot (`cards` reference changes
  // only when the snapshot does; `now` ticks re-render but never recompute).
  const cols = $derived.by<Record<TaskStatus, ColumnSummary>>(() => {
    const out = {} as Record<TaskStatus, ColumnSummary>;
    for (const e of columnSummary(cards)) out[e.status] = e;
    return out;
  });

  function fmtClock(ms: number): string {
    return new Date(ms).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }

  function ageLabel(st: TaskStatus): string {
    const ms = cols[st].lastUpdatedMs;
    return ms !== null ? relativeAge(ms, now) : '—';
  }

  function ageTitle(st: TaskStatus): string {
    const ms = cols[st].lastUpdatedMs;
    return ms !== null ? `Last updated ${new Date(ms).toLocaleString()}` : 'No cards in this column yet';
  }
</script>

<div class="border-t border-default py-5">
  <div class="flex flex-wrap items-center gap-2.5">
    {#each TILES as st (st)}
      <span
        class="rounded-md border border-default bg-surface px-3 py-2 text-[13px] text-muted"
        data-status={st}
        title={ageTitle(st)}
      >
        <b class="mr-1 tabular-nums text-foreground">{cols[st].count}</b> {STATUS_LABEL[st]}
        {#if st === 'running'}
          <b class="mx-1 tabular-nums text-warning">{cols[st].stalled}</b> stalled
        {/if}
        <span class="ml-1.5 text-[11px] tabular-nums text-faint" data-last-updated={st}>{ageLabel(st)}</span>
      </span>
    {/each}
    <span class="rounded-md border border-default bg-surface px-3 py-2 text-[13px] text-muted"><b class="mr-1 tabular-nums text-accent">{summary.runningCount}</b> running</span>
    <span class="rounded-md border border-default bg-surface px-3 py-2 text-[13px] text-muted"><b class="mr-1 tabular-nums text-warning">{summary.stalledCount}</b> stalled</span>
  </div>
  <div class="mt-3 flex flex-wrap items-center gap-2.5">
    {#each AUX as st (st)}
      <span class="rounded-md border border-default bg-surface px-3 py-2 text-[13px] text-muted" data-status={st} title={ageTitle(st)}>
        <b class="mr-1 tabular-nums text-foreground">{cols[st].count}</b> {STATUS_LABEL[st]}
        <span class="ml-1.5 text-[11px] tabular-nums text-faint" data-last-updated={st}>{ageLabel(st)}</span>
      </span>
    {/each}
    <span class="ml-auto flex flex-wrap items-center gap-[18px] text-[12px] text-faint">
      <span class="slots">slots: {summary.maxInProgress ?? '—'}</span>
      <span class="clock"
        >last updated
        <b class="tabular-nums text-muted">{summary.lastSyncedAt ? fmtClock(now) : '—'}</b>
        {#if !connected}<span class="text-danger"> (offline)</span>{/if}
        {#if seq !== null}· <span data-seq>seq {seq}</span>{/if}</span
      >
    </span>
  </div>
</div>
