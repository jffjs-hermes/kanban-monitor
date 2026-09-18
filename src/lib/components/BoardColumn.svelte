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

<section class="column" class:accented={!!accent}>
  <header class="col-head">
    <h2>{label}</h2>
    <span class="count" class:hot={cards.length > 0}>{cards.length}</span>
  </header>
  <div class="body">
    {#if cards.length === 0}
      <div class="empty">No cards</div>
    {:else}
      {#each cards as card (card.id)}
        <Card {card} {now} {frameAt} {onSelect} />
      {/each}
    {/if}
  </div>
</section>

<style>
  .column {
    background: #161b22;
    border: 1px solid #30363d;
    border-radius: 8px;
    min-height: 300px;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .accented .col-head {
    border-bottom-color: #388bfd;
  }
  .col-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 14px;
    border-bottom: 1px solid #30363d;
  }
  h2 {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
    color: #e6edf3;
  }
  .count {
    background: #21262d;
    border: 1px solid #30363d;
    color: #8b949e;
    border-radius: 12px;
    padding: 1px 9px;
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }
  .count.hot {
    color: #e6edf3;
  }
  .body {
    padding: 12px;
    flex: 1;
    overflow-y: auto;
  }
  .empty {
    color: #6e7681;
    text-align: center;
    padding: 45px 0;
    font-size: 13px;
  }
</style>