<script lang="ts">
  // One card on the board (spec §1.2). Shows title, assignee, an outing of
  // priority, and — for running cards — elapsed runtime + a LivenessDot.
  //
  // `frameAt` is the timestamp the snapshot was taken (summary.lastSyncedAt).
  // `now` is a ticking client clock; elapsed for running cards is computed
  // client-side by adding the elapsed since `frameAt` (spec §2.1: the server
  // does not push per-second elapsed updates).
  import LivenessDot from './LivenessDot.svelte';
  import type { CardView } from '../types';

  let {
    card,
    now,
    frameAt,
    onSelect,
  }: {
    card: CardView;
    now: number;
    frameAt: number;
    onSelect?: (id: string) => void;
  } = $props();

  function handleClick() {
    onSelect?.(card.id);
  }

  function handleKey(e: KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleClick();
    }
  }

  function elapsedText(ms: number | null, startedMs: number | null): string {
    if (ms !== null && startedMs !== null) {
      const live = ms + Math.max(0, now - startedMs);
      return fmt(live);
    }
    if (ms !== null) return fmt(ms);
    return '';
  }

  function fmt(ms: number): string {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${sec}s`;
    return `${sec}s`;
  }

  // started_at (unix seconds) reconstructed from elapsedMs + frameAt — the
  // snapshot didn't carry it, so derive the "since" anchor for live ticking.
  // Only meaningful while the card is running.
  const startedMs = (): number | null =>
    card.elapsedMs !== null ? frameAt - card.elapsedMs : null;
</script>

<article
  class="card"
  class:running={card.status === 'running'}
  class:clickable={!!onSelect}
  title={card.title}
  role={onSelect ? 'button' : undefined}
  tabindex={onSelect ? 0 : undefined}
  onclick={handleClick}
  onkeydown={handleKey}
>
  <div class="top">
    <strong class="title">{card.title}</strong>
    {#if card.status === 'running' && card.liveness}
      <LivenessDot
        liveness={card.liveness}
        title={card.liveness === 'active' ? 'active — heartbeat fresh' : 'stalled — heartbeat overdue'}
      />
    {/if}
  </div>
  <div class="meta">
    {#if card.assignee}<span class="assignee">{card.assignee}</span>{/if}
    <span class="priority">p{card.priority}</span>
    {#if card.status === 'running' && card.elapsedMs !== null}
      <span class="elapsed">{elapsedText(card.elapsedMs, startedMs())}</span>
    {/if}
    {#if card.runCount > 1}<span class="runs">{card.runCount} tries</span>{/if}
  </div>
</article>

<style>
  .card {
    background: #21262d;
    border: 1px solid #30363d;
    border-radius: 6px;
    padding: 12px;
    margin-bottom: 10px;
    font-size: 14px;
  }
  .card.running {
    border-left: 3px solid #388bfd;
  }
  .card.clickable {
    cursor: pointer;
  }
  .card.clickable:hover {
    border-color: #2f81f7;
    background: #262d36;
  }
  .top {
    display: flex;
    gap: 8px;
    align-items: flex-start;
    justify-content: space-between;
  }
  .title {
    display: block;
    color: #e6edf3;
    line-height: 1.3;
    word-break: break-word;
  }
  .meta {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
    margin-top: 10px;
    color: #8b949e;
    font-size: 12px;
  }
  .assignee {
    color: #a5d6ff;
  }
  .priority {
    background: #161b22;
    border: 1px solid #30363d;
    border-radius: 10px;
    padding: 0 7px;
  }
  .elapsed {
    font-variant-numeric: tabular-nums;
    color: #e6edf3;
  }
  .runs {
    color: #6e7681;
  }
</style>