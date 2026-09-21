<script lang="ts">
  // Board view (spec §1.2, §4 client logic, §5.0 localStorage).
  //
  // Renders Ready → Running → Review → Blocked → Done columns (with
  // triage/todo/archived collapsed behind a toggle), the summary strip, and the
  // board switcher. Live updates arrive via `EventSource` → `board` store, so
  // cards re-render in place when a delta arrives — no manual refresh. Board
  // switch re-targets the stream + snapshot and persists in localStorage (§5.0).
  import { board, selectBoard } from '$lib/board-client';
  import { openDrawer, closeDrawer } from '$lib/card-drawer';
  import { COLUMN_DEFS, groupByStatus } from '$lib/board-view';
  import BoardColumn from '$lib/components/BoardColumn.svelte';
  import SummaryStrip from '$lib/components/SummaryStrip.svelte';
  import AgentHealthPanel from '$lib/components/AgentHealthPanel.svelte';
  import BoardSwitcher from '$lib/components/BoardSwitcher.svelte';
  import { get } from 'svelte/store';
  import type { BoardSlug } from '$lib/types';

  const LS_KEY = 'kanban-monitor.board';
  const THEME_KEY = 'kanban-monitor-theme';

  // Theme: toggle flips the `dark` class on <html>. Initial value is restored
  // from localStorage (defaulting to the system preference), matching the
  // no-FOUC init in app.html. Choosing an explicit theme wins over system.
  let dark = $state(
    (() => {
      try {
        const saved = localStorage.getItem(THEME_KEY);
        if (saved === 'light') return false;
        if (saved === 'dark') return true;
        return window.matchMedia('(prefers-color-scheme: dark)').matches;
      } catch {
        return false;
      }
    })(),
  );
  function toggleTheme() {
    dark = !dark;
    document.documentElement.classList.toggle('dark', dark);
    try {
      localStorage.setItem(THEME_KEY, dark ? 'dark' : 'light');
    } catch {
      /* storage unavailable — session-only */
    }
  }

  function readStored(): BoardSlug | null {
    try {
      const v = localStorage.getItem(LS_KEY);
      return v && v.length > 0 ? v : null;
    } catch {
      return null;
    }
  }

  let boards: { slug: BoardSlug }[] = $state([]);
  let showMore = $state(false);
  let now = $state(Date.now()); // ticking clock for elapsed + footer

  // Restore the persisted selection (or default) and start streaming. Read the
  // initial value once into a plain const so `selectBoard` runs exactly once on
  // setup without capturing the reactive binding.
  const initialSlug: BoardSlug = readStored() ?? 'default';
  let current: BoardSlug = $state(initialSlug);
  selectBoard(initialSlug);

  async function loadBoards() {
    try {
      const res = await fetch('/api/boards.json');
      if (res.ok) {
        const data = await res.json();
        boards = data.boards ?? [];
      }
    } catch {
      boards = [];
    }
  }

  // Bootstrap: fetch the board list, and fall back to the JSON snapshot for an
  // immediate first paint when the SSE stream hasn't delivered a reset yet
  // (spec §1.2 "initial load / fallback"). Once EventSource delivers, its
  // `reset` overwrites this baseline.
  $effect(() => {
    loadBoards();
    const st = get(board);
    if (!st.snapshot && !st.connected) {
      fetch(`/api/board/${encodeURIComponent(st.slug)}.json`)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error('snapshot failed'))))
        .then((snap) => {
          const next = get(board);
          if (!next.snapshot) board.set({ ...next, snapshot: snap, connected: true, error: null });
        })
        .catch(() => {});
    }
  });

  // Persist selection + re-target the stream on switch (§5.0).
  function onSelect(slug: BoardSlug) {
    current = slug;
    closeDrawer(); // a different board invalidates any open card detail
    try {
      localStorage.setItem(LS_KEY, slug);
    } catch {
      /* storage unavailable — session-only */
    }
    selectBoard(slug);
  }

  // Tick the client clock every second (drives elapsed + footer timestamps).
  $effect(() => {
    const t = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(t);
  });
</script>
<svelte:head><title>Kanban Board Monitor</title></svelte:head>

<div class="mx-auto max-w-[1500px] p-7">
  <header class="flex flex-wrap items-center justify-between gap-6 pb-[22px]">
    <div class="brand">
      <h1 class="m-0 text-[26px]">Kanban Board Monitor</h1>
      <p class="mt-1.5 text-muted">Read-only live view of the Hermes team</p>
    </div>
    <div class="flex items-center gap-2.5">
      <BoardSwitcher {boards} {current} onSelect={onSelect} />
      <button
        class="cursor-pointer rounded-md border border-default bg-surface px-3 py-1.5 text-[13px] text-muted transition-colors duration-100 hover:border-border-strong hover:text-foreground"
        onclick={toggleTheme}
        type="button"
        aria-label="Toggle light/dark theme"
        title="Toggle light/dark theme"
      >
        {dark ? 'Light' : 'Dark'}
      </button>
    </div>
  </header>

  {#if $board.snapshot}
    {@const groups = groupByStatus($board.snapshot.cards)}
    <SummaryStrip
      summary={$board.snapshot.summary}
      seq={$board.seq}
      {now}
      connected={$board.connected}
    />
    <AgentHealthPanel
      health={$board.snapshot.health}
      lastSyncedAtMs={$board.snapshot.summary.lastSyncedAt}
      {now}
    />
    <main class="flex min-w-0 flex-nowrap items-stretch gap-3.5 overflow-x-auto">
      {#each COLUMN_DEFS as def (def.status)}
        {#if !def.collapsed || showMore}
          <BoardColumn
            label={def.label}
            cards={groups[def.status] ?? []}
            {now}
            frameAt={$board.snapshot.summary.lastSyncedAt}
            onSelect={(id) => openDrawer(id, $board.slug)}
          />
        {/if}
      {/each}
    </main>
    {#if COLUMN_DEFS.some((d) => d.collapsed)}
      <button
        class="mt-[18px] cursor-pointer rounded-md border border-default bg-surface px-3.5 py-2 text-muted hover:text-foreground"
        onclick={() => (showMore = !showMore)}
        type="button"
      >
        {showMore ? 'hide' : 'Show'} more columns (triage / todo / archived)
      </button>
    {/if}
  {:else}
    <div class="py-[60px] text-center text-muted">
      {#if $board.error}
        <p class="text-danger">{$board.error} — retrying…</p>
      {:else}
        <p>Connecting to board <b class="text-foreground">{$board.slug}</b>…</p>
      {/if}
    </div>
  {/if}
</div>
