<script lang="ts">
  // Board view (spec §1.2, §4 client logic, §5.0 localStorage).
  //
  // Renders Ready → Running → Review → Blocked → Done columns (with
  // triage/todo/archived collapsed behind a toggle), the summary strip, and the
  // board switcher. Live updates arrive via `EventSource` → `board` store, so
  // cards re-render in place when a delta arrives — no manual refresh. Board
  // switch re-targets the stream + snapshot and persists in localStorage (§5.0).
  import { board, selectBoard } from '$lib/board-client';
  import { drawer, openDrawer, closeDrawer } from '$lib/card-drawer';
  import {
    cardElId,
    COLUMN_DEFS,
    distinctAssignees,
    filterByAssignee,
    groupByStatus,
    moveFocus,
    visibleCardIds,
    type FocusDirection,
  } from '$lib/board-view';
  import BoardColumn from '$lib/components/BoardColumn.svelte';
  import SummaryStrip from '$lib/components/SummaryStrip.svelte';
  import AgentHealthPanel from '$lib/components/AgentHealthPanel.svelte';
  import BoardSwitcher from '$lib/components/BoardSwitcher.svelte';
  import { get } from 'svelte/store';
  import type { BoardSlug } from '$lib/types';

  const LS_KEY = 'kanban-monitor.board';
  const THEME_KEY = 'kanban-monitor-theme';
  // §5.0 localStorage convention: view preferences persist under a
  // `kanban-monitor.*` key. The assignee filter uses `null` = "All" — see
  // `AssigneeFilter` in board-view.ts.
  const ASSIGNEE_LS_KEY = 'kanban-monitor.assignee';

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
  // All eight columns render by default (spec §1.2). The toggle collapses the
  // triage/todo/archived subset behind a button; `collapsed` flags stay as-is.
  let showCollapsed = $state(true);
  let now = $state(Date.now()); // ticking clock for elapsed + footer

  // Assignee filter (Card B): `null` = "All" (no filtering). Restored from
  // localStorage so the choice survives reloads; reset on board switch.
  function readStoredAssignee(): string | null {
    try {
      const v = localStorage.getItem(ASSIGNEE_LS_KEY);
      return v && v.length > 0 ? v : null;
    } catch {
      return null;
    }
  }
  let assigneeFilter = $state<string | null>(readStoredAssignee());
  // Distinct assignees across all statuses the board renders, for the dropdown.
  const assigneeOptions = $derived(distinctAssignees($board.snapshot?.cards ?? []));
  function setAssigneeFilter(a: string | null) {
    assigneeFilter = a;
    focusedId = null; // a filtered-away card must not stay the roving tab stop
    try {
      if (a === null) localStorage.removeItem(ASSIGNEE_LS_KEY);
      else localStorage.setItem(ASSIGNEE_LS_KEY, a);
    } catch {
      /* storage unavailable — session-only */
    }
  }

  // Keyboard navigation (Card A) — roving tabindex. `focusedId` names the one
  // card in the tab order; arrow keys move it one step over the rendered grid
  // (via `moveFocus` on the visible layout) and `Enter`/`Space` opens its
  // drawer. `null` means "no explicit selection": the first card is then the
  // tab stop, so Tab always lands on the board.
  let focusedId = $state<string | null>(null);
  // Per-column "show more" expansion, lifted from BoardColumn so the layout
  // used for arrow movement matches exactly what is rendered.
  let expandedCols = $state<Record<string, boolean>>({});

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
    focusedId = null; // and any keyboard selection
    expandedCols = {};
    setAssigneeFilter(null); // filter resets to "All" on board switch
    try {
      localStorage.setItem(LS_KEY, slug);
    } catch {
      /* storage unavailable — session-only */
    }
    selectBoard(slug);
  }

  // Keyboard navigation (Card A). The visible layout: one column per rendered
  // column def, holding the ids the column actually shows (respecting the
  // newest-N limit and its expansion toggle), in render order. The assignee
  // filter (Card B) narrows the cards before grouping, so columns, their
  // counts, and the empty states all reflect the selection.
  const groups = $derived(
    $board.snapshot
      ? groupByStatus(filterByAssignee($board.snapshot.cards, assigneeFilter))
      : groupByStatus([]),
  );
  const focusColumns = $derived(
    COLUMN_DEFS.filter((d) => !d.collapsed || showCollapsed).map((d) =>
      visibleCardIds(groups[d.status] ?? [], expandedCols[d.status] ?? false),
    ),
  );
  // Roving tab stop: the selected card when it is still rendered, else the
  // first card (default), else nothing on an empty board.
  const effectiveFocusId = $derived.by(() => {
    const fid = focusedId;
    return fid !== null && focusColumns.some((col) => col.includes(fid))
      ? fid
      : (focusColumns[0]?.[0] ?? null);
  });

  function handleNav(dir: FocusDirection) {
    if ($drawer.open) return; // never move the selection under an open drawer
    const next = moveFocus(focusColumns, focusedId, dir);
    if (next !== null && next !== focusedId) {
      focusedId = next;
      document.getElementById(cardElId(next))?.focus();
    }
  }

  // A click selects the card (roving tab stop follows the mouse) and opens the
  // detail drawer exactly as before — no behavior regression.
  function onCardSelect(id: string) {
    focusedId = id;
    openDrawer(id, $board.slug);
  }

  // Tick the client clock every second (drives elapsed + footer timestamps).
  $effect(() => {
    const t = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(t);
  });
</script>
<svelte:head><title>Kanban Board Monitor</title></svelte:head>

<div class="max-w-full p-7">
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
    <div class="mb-3 flex flex-wrap items-center justify-end gap-2 text-[13px]">
      <label for="assignee-filter" class="text-muted">Filter by assignee</label>
      <select
        id="assignee-filter"
        class="cursor-pointer rounded-md border border-default bg-surface px-3 py-1.5 text-[13px] text-foreground outline-none transition-colors duration-100 hover:border-border-strong"
        value={assigneeFilter ?? ''}
        onchange={(e) => setAssigneeFilter((e.currentTarget as HTMLSelectElement).value || null)}
      >
        <option value="">All</option>
        {#each assigneeOptions as a (a)}
          <option value={a}>{a}</option>
        {/each}
      </select>
    </div>
    <SummaryStrip
      summary={$board.snapshot.summary}
      cards={$board.snapshot.cards}
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
        {#if !def.collapsed || showCollapsed}
          <BoardColumn
            label={def.label}
            cards={groups[def.status] ?? []}
            expanded={expandedCols[def.status] ?? false}
            onToggle={() => (expandedCols[def.status] = !expandedCols[def.status])}
            {now}
            frameAt={$board.snapshot.summary.lastSyncedAt}
            focusedId={effectiveFocusId}
            onNav={handleNav}
            onSelect={onCardSelect}
          />
        {/if}
      {/each}
    </main>
    {#if COLUMN_DEFS.some((d) => d.collapsed)}
      <button
        class="mt-[18px] cursor-pointer rounded-md border border-default bg-surface px-3.5 py-2 text-muted hover:text-foreground"
        onclick={() => (showCollapsed = !showCollapsed)}
        type="button"
      >
        {showCollapsed ? 'Hide' : 'Show'} collapsed columns (triage / todo / archived)
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
