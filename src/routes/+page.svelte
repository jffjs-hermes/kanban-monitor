<script lang="ts">
  // Board view (spec §1.2, §4 client logic, §5.0 localStorage).
  //
  // Renders Ready → Running → Review → Blocked → Done columns (with
  // triage/todo/archived collapsed behind a toggle), the summary strip, and the
  // board switcher. Live updates arrive via `EventSource` → `board` store, so
  // cards re-render in place when a delta arrives — no manual refresh. Board
  // switch re-targets the stream + snapshot and persists in localStorage (§5.0).
  import { board, selectBoard } from '$lib/board-client';
  import { COLUMN_DEFS, groupByStatus } from '$lib/board-view';
  import BoardColumn from '$lib/components/BoardColumn.svelte';
  import SummaryStrip from '$lib/components/SummaryStrip.svelte';
  import BoardSwitcher from '$lib/components/BoardSwitcher.svelte';
  import { get } from 'svelte/store';
  import type { BoardSlug } from '$lib/types';

  const LS_KEY = 'kanban-monitor.board';

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

<div class="shell">
  <header>
    <div class="brand">
      <h1>Kanban Board Monitor</h1>
      <p>Read-only live view of the Hermes team</p>
    </div>
    <div class="tools">
      <BoardSwitcher {boards} {current} onSelect={onSelect} />
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
    <main>
      {#each COLUMN_DEFS as def (def.status)}
        {#if !def.collapsed || showMore}
          <BoardColumn
            label={def.label}
            cards={groups[def.status] ?? []}
            {now}
            frameAt={$board.snapshot.summary.lastSyncedAt}
          />
        {/if}
      {/each}
    </main>
    {#if COLUMN_DEFS.some((d) => d.collapsed)}
      <button class="more" onclick={() => (showMore = !showMore)} type="button">
        {showMore ? 'hide' : 'Show'} more columns (triage / todo / archived)
      </button>
    {/if}
  {:else}
    <div class="loading">
      {#if $board.error}
        <p class="err">{$board.error} — retrying…</p>
      {:else}
        <p>Connecting to board <b>{$board.slug}</b>…</p>
      {/if}
    </div>
  {/if}
</div>

<style>
  * {
    box-sizing: border-box;
  }
  :global(body) {
    margin: 0;
    background: #0d1117;
    color: #e6edf3;
    font: 15px system-ui, sans-serif;
  }
  .shell {
    max-width: 1500px;
    margin: auto;
    padding: 28px;
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    border-bottom: 1px solid #30363d;
    padding-bottom: 22px;
    gap: 24px;
    flex-wrap: wrap;
  }
  .brand h1 {
    margin: 0;
    font-size: 26px;
  }
  .brand p {
    color: #8b949e;
    margin: 6px 0 0;
  }
  .tools {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  main {
    display: grid;
    grid-template-columns: repeat(5, minmax(180px, 1fr));
    gap: 14px;
    align-items: start;
  }
  .more {
    margin-top: 18px;
    background: #161b22;
    border: 1px solid #30363d;
    color: #8b949e;
    border-radius: 6px;
    padding: 8px 14px;
    cursor: pointer;
  }
  .more:hover {
    color: #e6edf3;
  }
  .loading {
    padding: 60px 0;
    color: #8b949e;
    text-align: center;
  }
  .loading .err {
    color: #f85149;
  }
  .loading b {
    color: #e6edf3;
  }
  @media (max-width: 900px) {
    main {
      grid-template-columns: repeat(2, 1fr);
    }
  }
</style>
