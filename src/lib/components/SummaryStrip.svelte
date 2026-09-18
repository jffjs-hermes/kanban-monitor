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

<div class="strip">
  <div class="tiles">
    {#each TILES as st (st)}
      <span class="tile" data-status={st}>
        <b>{counts[st]}</b> {STATUS_LABEL[st]}
      </span>
    {/each}
    <span class="tile running"><b>{summary.runningCount}</b> running</span>
    <span class="tile stalled"><b>{summary.stalledCount}</b> stalled</span>
  </div>
  <div class="meta">
    <span class="slots">slots: {summary.maxInProgress ?? '—'}</span>
    <span class="cart">
      {#each AUX as st (st)}
        <b>{counts[st]}</b> {STATUS_LABEL[st]}{#if st !== 'archived'} · {/if}
      {/each}
    </span>
    <span class="clock"
      >last updated
      <b>{summary.lastSyncedAt ? fmtClock(now) : '—'}</b>
      {#if !connected}<span class="offline"> (offline)</span>{/if}
      {#if seq !== null}· <span data-seq>seq {seq}</span>{/if}</span
    >
  </div>
</div>

<style>
  .strip {
    padding: 20px 0;
    border-bottom: 1px solid #30363d;
  }
  .tiles {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
    align-items: center;
  }
  .tile {
    background: #161b22;
    border: 1px solid #30363d;
    border-radius: 6px;
    padding: 8px 12px;
    color: #8b949e;
    font-size: 13px;
  }
  .tile b {
    color: #e6edf3;
    font-variant-numeric: tabular-nums;
    margin-right: 4px;
  }
  .tile.running b {
    color: #388bfd;
  }
  .tile.stalled b {
    color: #d29922;
  }
  .meta {
    display: flex;
    gap: 18px;
    flex-wrap: wrap;
    align-items: center;
    margin-top: 12px;
    color: #6e7681;
    font-size: 12px;
  }
  .cart {
    color: #8b949e;
  }
  .clock b {
    color: #8b949e;
    font-variant-numeric: tabular-nums;
  }
  .offline {
    color: #f85149;
  }
</style>