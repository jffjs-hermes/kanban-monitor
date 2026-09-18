<script lang="ts">
  // One workflow column (spec §1.2). Renders its status label, the card count,
  // and the cards it owns, with an empty-state hint when none.
  import Card from './Card.svelte';
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
</script>

<section class="flex min-h-[300px] flex-col overflow-hidden rounded-lg border border-default bg-surface">
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
      {#each cards as card (card.id)}
        <Card {card} {now} {frameAt} {onSelect} />
      {/each}
    {/if}
  </div>
</section>