<script lang="ts">
  // One card on the board (spec §1.2). Shows title, assignee, an outing of
  // priority, and — for running cards — elapsed runtime + a LivenessDot.
  //
  // `frameAt` is the timestamp the snapshot was taken (summary.lastSyncedAt).
  // `now` is a ticking client clock; elapsed for running cards is computed
  // client-side by adding the elapsed since `frameAt` (spec §2.1: the server
  // does not push per-second elapsed updates).
  //
  // Stalled / credit-burn alert (Impl task): a running card whose heartbeat is
  // stale gets a persistent warning treatment — amber tint + warning accent,
  // a `stalled {age}` badge whose age ticks up every poll, and an emphasized
  // run count when a worker has tried multiple times (escalating burn). All
  // derived from state (liveness + elapsed + runCount vs `now`), so it survives
  // a reload and clears the moment the heartbeat resumes or the card leaves
  // Running.
  import LivenessDot from './LivenessDot.svelte';
  import {
    formatDuration,
    isStalled,
    recentTransition,
    stallAgeMs,
  } from '../board-view';
  import type { CardView, TaskStatus } from '../types';

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

  const stalled = $derived(isStalled(card));
  const stallAge = $derived(stallAgeMs(card, now, frameAt));

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

  // "Just transitioned" annotation: shown only while the card's most recent
  // status move is inside the window of the ticking client clock (`now`).
  // Derived from state (card.lastTransition vs now), so it survives a reload
  // and clears itself as the window passes — no imperative per-event flash.
  const ann = $derived(recentTransition(card, now));

  const STATUS_LABEL: Record<TaskStatus, string> = {
    triage: 'triage', todo: 'todo', ready: 'ready', running: 'running',
    review: 'review', blocked: 'blocked', done: 'done', archived: 'archived',
  };
</script>

<article
  class="mb-2.5 rounded-md border border-default bg-surface-2 p-3 text-[14px]"
  class:border-l-3={card.status === 'running' || stalled}
  class:border-l-accent={card.status === 'running' && !stalled}
  class:border-l-warning={stalled}
  class:bg-warning-tint={stalled}
  class:cursor-pointer={!!onSelect}
  class:hover:border-border-strong={!!onSelect}
  class:hover:bg-surface-3={!!onSelect}
  title={card.title}
  role={onSelect ? 'button' : undefined}
  tabindex={onSelect ? 0 : undefined}
  onclick={handleClick}
  onkeydown={handleKey}
>
  <div class="flex items-start justify-between gap-2">
    <strong class="block break-words leading-[1.3] text-foreground">{card.title}</strong>
    {#if card.status === 'running' && card.liveness}
      <LivenessDot
        liveness={card.liveness}
        title={card.liveness === 'active' ? 'active — heartbeat fresh' : 'stalled — heartbeat overdue'}
      />
    {/if}
  </div>
  {#if ann}
    <div
      class="mt-1.5 flex items-center gap-1.5 text-[11px] font-semibold animate-transition-pop"
      role="status"
    >
      <span class="size-1.5 rounded-full bg-accent" aria-hidden="true"></span>
      <span class="text-link">→ {STATUS_LABEL[ann.to]}</span>
    </div>
  {/if}
  {#if stalled && stallAge !== null}
    <div
      class="mt-1.5 inline-flex items-center gap-1.5 rounded-[10px] border border-warning bg-warning-tint px-[8px] py-px text-[11px] font-semibold text-warning"
      role="status"
      title="Heartbeat overdue — this running card is stalled and continuing to burn credits"
    >
      <span class="size-1.5 rounded-full bg-warning animate-pulse" aria-hidden="true"></span>
      <span>stalled {formatDuration(stallAge)}</span>
    </div>
  {/if}
  <div class="mt-2.5 flex flex-wrap gap-2.5 text-[12px] text-muted">
    {#if card.assignee}<span class="text-link-soft">{card.assignee}</span>{/if}
    <span class="rounded-[10px] border border-default bg-surface px-[7px]">p{card.priority}</span>
    {#if card.status === 'running' && card.elapsedMs !== null}
      <span class="tabular-nums text-foreground">{elapsedText(card.elapsedMs, startedMs())}</span>
    {/if}
    {#if card.runCount > 1}
      <span
        class="tabular-nums"
        class:font-semibold={stalled}
        class:text-warning={stalled}
        class:text-faint={!stalled}
        title={stalled ? 'Multiple attempts while stalled — escalating credit burn' : `${card.runCount} attempts`}
      >{card.runCount} tries</span>
    {/if}
  </div>
</article>