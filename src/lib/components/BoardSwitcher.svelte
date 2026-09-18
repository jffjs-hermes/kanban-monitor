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

<div class="flex flex-wrap items-center gap-1.5">
  {#each boards as b (b.slug)}
    <button
      class="cursor-pointer rounded-md border px-3 py-1.5 text-[13px] transition-colors duration-100 border-default bg-surface text-muted hover:border-border-strong hover:text-foreground"
      class:selected={b.slug === current}
      class:border-accent-strong={b.slug === current}
      class:bg-accent-strong={b.slug === current}
      class:text-on-accent={b.slug === current}
      onclick={() => onSelect(b.slug)}
      type="button"
    >
      {labelOf(b)}
    </button>
  {/each}
</div>