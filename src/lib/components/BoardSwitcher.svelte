<script lang="ts">
  // Board switcher (spec §1.2, §5.0). Lists available boards (fetched from
  // /api/boards.json), highlights the current selection, and on change tells
  // the parent to re-target the SSE stream + snapshot. The parent persists the
  // selection in localStorage.
  import type { BoardSlug } from '../types';

  let {
    boards,
    current,
    onSelect,
  }: {
    boards: { slug: BoardSlug; label?: string }[];
    current: BoardSlug;
    onSelect: (slug: BoardSlug) => void;
  } = $props();

  function labelOf(b: { slug: BoardSlug; label?: string }): string {
    return b.label ?? b.slug;
  }
</script>

<div class="switcher">
  {#each boards as b (b.slug)}
    <button
      class="board"
      class:selected={b.slug === current}
      onclick={() => onSelect(b.slug)}
      type="button"
    >
      {labelOf(b)}
    </button>
  {/each}
</div>

<style>
  .switcher {
    display: flex;
    gap: 6px;
    align-items: center;
    flex-wrap: wrap;
  }
  .board {
    background: #161b22;
    border: 1px solid #30363d;
    color: #8b949e;
    border-radius: 6px;
    padding: 6px 12px;
    font-size: 13px;
    cursor: pointer;
    transition: background 0.12s, color 0.12s, border-color 0.12s;
  }
  .board:hover {
    color: #e6edf3;
    border-color: #484f58;
  }
  .board.selected {
    background: #1f6feb;
    border-color: #1f6feb;
    color: #fff;
  }
</style>