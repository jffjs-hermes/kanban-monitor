<script lang="ts">
  // Agent health panel (spec §1.2, §4): per-profile live worker visibility.
  //
  // For each profile currently running a card: running-card count, latest run
  // pid, worker session id, run start time, and the current heartbeat age
  // (e.g. "12s ago"), with a subtle stale indicator when the heartbeat is
  // missing or older than STALE_WORKER_MS. A clean, empty strip on an idle
  // board. Reuses LivenessDot + the summary's `lastSyncedAt` barrier so ages
  // keep ticking against the client clock (`now`) without extra data on the
  // wire: heartbeatTs = lastSyncedAt − deriv(age), re-aged against `now`.
  import type { AgentHealth } from '../types';
  import LivenessDot from './LivenessDot.svelte';

  let {
    health,
    lastSyncedAtMs,
    now,
  }: {
    health: AgentHealth[];
    lastSyncedAtMs: number; // snapshot barrier (unix ms)
    now: number; // ticking client clock (unix ms)
  } = $props();

  // Reconstruct the barriered heartbeat timestamp (unix s) so the displayed
  // age can tick live as `now` advances.
  function liveAgeSec(e: AgentHealth): number | null {
    if (e.heartbeatAgeSec === null) return null;
    const heartbeatTs = lastSyncedAtMs / 1000 - e.heartbeatAgeSec;
    return now / 1000 - heartbeatTs;
  }

  function fmtAge(sec: number | null): string {
    if (sec === null) return '—';
    const s = Math.max(0, Math.round(sec));
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s ago`;
    return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ago`;
  }

  function fmtClock(sec: number | null): string {
    if (sec === null) return '—';
    return new Date(sec * 1000).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }
</script>

<div
  class="mt-3 border-t border-default px-4 py-3"
  data-test="agent-health"
>
  <div class="flex items-center gap-2 text-[12px] text-faint">
    <span class="font-semibold text-muted">Agent health</span>
    <span class="text-faint">{health.length} active</span>
  </div>

  {#if health.length === 0}
    <p class="mt-1 text-[12px] text-faint">No workers running.</p>
  {:else}
    <div class="mt-1.5 flex flex-wrap items-center gap-3">
      {#each health as e (e.profile)}
        <span
          class="rounded-md border border-default bg-surface px-3 py-1.5 text-[12px]"
          data-profile={e.profile}
          data-stale={e.stale}
        >
          <LivenessDot liveness={e.stale ? 'stalled' : 'active'} size={9} title={e.profile} />
          <b class="mr-1 text-foreground">{e.profile}</b>
          <span class="text-muted">
            {e.runningCardCount} running
            · pid {e.workerPid ?? '—'}
            · sess {e.workerSessionId ?? '—'}
            · start {fmtClock(e.runStartedAt)}
            · hb <b class="tabular-nums text-muted">{e.heartbeatAgeSec === null ? '—' : fmtAge(liveAgeSec(e))}</b>
          </span>
          {#if e.stale}
            <span class="ml-1 rounded bg-warning-tint px-1.5 py-0.5 text-[11px] text-warning">stale</span>
          {/if}
        </span>
      {/each}
    </div>
  {/if}
</div>