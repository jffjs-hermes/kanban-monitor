<script lang="ts">
  // One workflow column (spec §1.2). Renders its status label, the card count,
  // and the cards it owns, with an empty-state hint when none.
  //
  // Impl 12: by default only the 10 newest cards (cards arrive newest-first
  // from `groupByStatus`) are shown; when a column holds more than 10 a toggle
  // reveals the rest. The header badge always shows the TOTAL count.
  import Card from './Card.svelte';
  import { DEFAULT_COLUMN_LIMIT, takeNewest } from '../board-view';
  import type { CardView } from '../types';

  let {
    label,
    cards,
    now,
    frameAt,
    accent = '',
    onSelect,
  }: {
    label: string;
    cards: CardView[];
    now: number;
    frameAt: number;
    accent?: string;
    onSelect?: (id: string) => void;
  } = $props();
  let expanded = $state(false);

  const visible = $derived(expanded ? cards : takeNewest(cards, DEFAULT_COLUMN_LIMIT));
  const hiddenCount = $derived(cards.length - DEFAULT_COLUMN_LIMIT);
  const hasMore = $derived(cards.length > DEFAULT_COLUMN_LIMIT);

  function toggle() {
    expanded = !expanded;
  }
</script>

<section class="flex min-h-[300px] min-w-[170px] flex-1 flex-col overflow-hidden rounded-lg border border-default bg-surface">
  <header
    class="flex items-center justify-between border-b border-default px-3.5 py-3"
    class:border-b-accent={!!accent}
  >
    <h2 class="m-0 text-[15px] font-semibold text-foreground">{label}</h2>
    <span class="rounded-full border border-default bg-surface-2 px-[9px] py-px text-[12px] tabular-nums text-muted" class:text-foreground={cards.length > 0}>{cards.length}</span>
  </header>
  <div class="flex-1 overflow-y-auto p-3">
    {#if cards.length === 0}
      <div class="py-[45px] text-center text-[13px] text-faint">No cards</div>
    {:else}
      {#each visible as card (card.id)}
        <Card {card} {now} {frameAt} {onSelect} />
      {/each}
    {/if}
  </div>
  {#if hasMore}
    <button
      class="cursor-pointer border-t border-default bg-surface px-3.5 py-2 text-[13px] text-muted transition-colors duration-100 hover:text-foreground"
      onclick={toggle}
      type="button"
      aria-expanded={expanded}
    >
      {expanded ? 'Show less' : `Show ${hiddenCount} more`}
    </button>
  {/if}
</section>