<script lang="ts">
  // Card detail drawer (spec §1.2, §2 `CardDetail`, §2.1). A right-hand
  // overlay that opens when a card is clicked and shows everything the board
  // columns can't: the card body, the status-transition trail (folded from
  // `task_events`), run attempts/outcomes (*runs* summary/error), comments, and
  // parent/child links. It fetches `/api/board/[slug]/cards/[id].json` on open
  // and refetches whenever the SSE `card` scope marks the open card dirty
  // (§2.1) or `rev` bumps, so the drawer live-refreshes like the columns do.
  //
  // Parent/child chips open that card's own drawer (they live on this board),
  // making links actionable rather than inert ids. Escape, the backdrop, and
  // the × button all close it.
  import { drawer, closeDrawer, openDrawer } from '$lib/card-drawer';
  import type { CardDetail, RunRow, TaskStatus } from '$lib/types';

  let detail = $state<CardDetail | null>(null);
  let loading = $state(false);
  let error = $state<string | null>(null);

  const st = $derived($drawer);
  const open = $derived(st.open && st.taskId !== null);

  // Refetch whenever the drawer target or its refresh token changes.
  $effect(() => {
    if (!st.open || st.taskId === null) {
      detail = null;
      loading = false;
      error = null;
      return;
    }
    const slug = st.slug;
    const taskId = st.taskId;
    let cancelled = false;
    loading = true;
    fetch(`/api/board/${encodeURIComponent(slug)}/cards/${encodeURIComponent(taskId)}.json`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('detail unavailable'))))
      .then((d) => {
        if (cancelled) return;
        detail = d as CardDetail;
        error = null;
      })
      .catch(() => {
        if (cancelled) return;
        detail = null;
        error = 'Could not load card detail.';
      })
      .finally(() => {
        if (!cancelled) loading = false;
      });
    return () => {
      cancelled = true;
    };
  });

  $effect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeDrawer();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  function onBackdropClose(e: MouseEvent) {
    if (e.target === e.currentTarget) closeDrawer();
  }

  function onBackdropKey(e: KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      closeDrawer();
    }
  }

  const STATUS_LABEL: Record<string, string> = {
    ready: 'Ready', running: 'Running', review: 'Review', blocked: 'Blocked',
    done: 'Done', triage: 'Triage', todo: 'Todo', archived: 'Archived',
  };

  function fmtTime(sec: number | null | undefined): string {
    if (sec == null) return '—';
    return new Date((sec < 1e12 ? sec * 1000 : sec)).toLocaleString([], {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  }

  function fmtDuration(ms: number | null | undefined): string {
    if (ms == null) return '—';
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m` : `${s}s`;
  }

  function runBase(r: RunRow): string {
    return (r.started_at != null && r.ended_at != null)
      ? `${fmtTime(r.started_at)} → ${fmtTime(r.ended_at)} (${fmtDuration((r.ended_at - r.started_at) * 1000)})`
      : `${fmtTime(r.started_at)} → ${fmtTime(r.ended_at)}`;
  }

  function runStatusClass(r: RunRow): string {
    const s = (r.status ?? '').toLowerCase();
    if (s === 'running') return 'bg-accent-tint text-link';
    if (s === 'completed' || s === 'done') return 'bg-success-tint text-success';
    if (s === 'failed') return 'bg-danger-tint text-danger';
    return 'bg-surface-2 text-muted';
  }

  function transitionLabel(t: { from: TaskStatus | null; to: TaskStatus }): string {
    return `${t.from ? STATUS_LABEL[t.from] ?? t.from : '·'} → ${STATUS_LABEL[t.to] ?? t.to}`;
  }
</script>

{#if open && detail}
  <div class="fixed inset-0 z-50 flex justify-end bg-scrim" onclick={onBackdropClose} onkeydown={onBackdropKey} role="presentation">
    <div class="flex h-full w-[min(560px,94vw)] animate-drawer-slide flex-col border-l border-default bg-surface shadow-[-12px_0_32px_var(--scrim)]" role="dialog" aria-modal="true" aria-label="Card detail" tabindex="-1">
      <header class="flex items-start justify-between gap-3 border-b border-default p-[18px_20px]">
        <div class="hd">
          <h2 class="m-0 mb-2.5 break-words text-[18px] leading-[1.3] text-foreground">{detail.card.title}</h2>
          <div class="flex flex-wrap gap-2">
            <span class="rounded-full border border-accent-strong bg-surface-2 px-2.5 py-0.5 text-[12px] text-link-soft">{STATUS_LABEL[detail.card.status] ?? detail.card.status}</span>
            {#if detail.card.assignee}<span class="rounded-full border border-default bg-surface-2 px-2.5 py-0.5 text-[12px] text-link-soft">{detail.card.assignee}</span>{/if}
            <span class="rounded-full border border-default bg-surface-2 px-2.5 py-0.5 text-[12px] text-muted">p{detail.card.priority}</span>
          </div>
        </div>
        <button class="flex-none cursor-pointer rounded-md border border-default bg-transparent text-[18px] leading-none text-muted hover:border-border-strong hover:text-foreground" onclick={closeDrawer} aria-label="Close" type="button" style="width:30px;height:30px">×</button>
      </header>

      <div class="overflow-y-auto px-5 pt-1 pb-6">
        <section class="border-b border-surface-2 py-4">
          <h3 class="m-0 mb-2.5 text-[12px] tracking-[.06em] uppercase text-muted">Body</h3>
          {#if detail.body}
            <pre class="m-0 break-words font-[inherit] whitespace-pre-wrap leading-[1.5] text-[14px] text-foreground-soft">{detail.body}</pre>
          {:else}
            <p class="text-[13px] text-faint">No body.</p>
          {/if}
        </section>

        <section class="border-b border-surface-2 py-4">
          <h3 class="m-0 mb-2.5 text-[12px] tracking-[.06em] uppercase text-muted">Status trail</h3>
          {#if detail.transitions.length === 0}
            <p class="text-[13px] text-faint">No status transitions recorded.</p>
          {:else}
            <ol class="m-0 flex list-none flex-col gap-1.5 p-0">
              {#each detail.transitions as t, i (i)}
                <li class="flex items-baseline justify-between gap-3">
                  <span class="text-[13px] text-foreground">{transitionLabel(t)}</span>
                  <span class="tabular-nums text-[12px] whitespace-nowrap text-faint">{fmtTime(t.at)}</span>
                </li>
              {/each}
            </ol>
          {/if}
        </section>

        <section class="border-b border-surface-2 py-4">
          <h3 class="m-0 mb-2.5 text-[12px] tracking-[.06em] uppercase text-muted">Runs <span class="text-faint">{detail.runs.length}</span></h3>
          {#if detail.runs.length === 0}
            <p class="text-[13px] text-faint">No runs yet.</p>
          {:else}
            {#each detail.runs as r (r.id)}
              <div class="mb-2.5 rounded-md border border-surface-2 bg-background p-[10px_12px]">
                <div class="flex flex-wrap items-center gap-2.5">
                  <span class="rounded-[10px] px-2 py-0.5 text-[12px] {runStatusClass(r)}">#{r.id} {r.status ?? '—'}</span>
                  {#if r.outcome}<span class="text-[12px] text-muted">{r.outcome}</span>{/if}
                  <span class="tabular-nums ml-auto text-[12px] text-faint">{runBase(r)}</span>
                </div>
                {#if r.summary}
                  <pre class="m-0 mt-1.5 break-words font-[inherit] whitespace-pre-wrap text-[13px] text-foreground">{r.summary}</pre>
                {/if}
                {#if r.error}
                  <pre class="m-0 mt-1.5 break-words font-[inherit] whitespace-pre-wrap text-[13px] text-danger">{r.error}</pre>
                {/if}
              </div>
            {/each}
          {/if}
        </section>

        <section class="border-b border-surface-2 py-4">
          <h3 class="m-0 mb-2.5 text-[12px] tracking-[.06em] uppercase text-muted">Comments <span class="text-faint">{detail.comments.length}</span></h3>
          {#if detail.comments.length === 0}
            <p class="text-[13px] text-faint">No comments.</p>
          {:else}
            {#each detail.comments as c (c.id)}
              <div class="mb-2.5 rounded-md border border-surface-2 bg-background p-[10px_12px]">
                <div class="mb-1.5 flex justify-between text-[12px] text-link-soft"><b>{c.author}</b><span class="text-faint">{fmtTime(c.created_at)}</span></div>
                <pre class="m-0 break-words font-[inherit] whitespace-pre-wrap text-[13px] text-foreground">{c.body}</pre>
              </div>
            {/each}
          {/if}
        </section>

        <section class="border-b border-surface-2 py-4">
          <h3 class="m-0 mb-2.5 text-[12px] tracking-[.06em] uppercase text-muted">Links</h3>
          <div class="flex flex-col gap-2.5">
            <div class="flex flex-wrap items-center gap-2.5">
              <span class="w-[70px] text-[12px] text-muted">Parents</span>
              {#if detail.card.parentIds.length === 0}
                <span class="text-[13px] text-faint">none</span>
              {:else}
                <span class="flex flex-wrap gap-1.5">
                  {#each detail.card.parentIds as pid (pid)}
                    <button class="cursor-pointer rounded-full border border-accent-strong bg-surface-2 px-2.5 py-0.5 font-mono text-[12px] text-link hover:bg-accent-tint" onclick={() => openDrawer(pid, $drawer.slug)} type="button">{pid}</button>
                  {/each}
                </span>
              {/if}
            </div>
            <div class="flex flex-wrap items-center gap-2.5">
              <span class="w-[70px] text-[12px] text-muted">Children</span>
              {#if detail.card.childIds.length === 0}
                <span class="text-[13px] text-faint">none</span>
              {:else}
                <span class="flex flex-wrap gap-1.5">
                  {#each detail.card.childIds as cid (cid)}
                    <button class="cursor-pointer rounded-full border border-accent-strong bg-surface-2 px-2.5 py-0.5 font-mono text-[12px] text-link hover:bg-accent-tint" onclick={() => openDrawer(cid, $drawer.slug)} type="button">{cid}</button>
                  {/each}
                </span>
              {/if}
            </div>
          </div>
        </section>

        <footer class="pt-3.5 text-[12px] text-faint">
          created {fmtTime(detail.card.createdAt)} · {detail.card.runCount} run{detail.card.runCount === 1 ? '' : 's'}
        </footer>
      </div>
    </div>
  </div>
{:else if open}
  <div class="fixed inset-0 z-50 flex justify-end bg-scrim" onclick={onBackdropClose} onkeydown={onBackdropKey} role="presentation">
    <div class="flex h-full w-[min(560px,94vw)] flex-col border-l border-default bg-surface p-[4px_20px] shadow-[-12px_0_32px_var(--scrim)]" role="dialog" aria-modal="true" aria-label="Card detail">
      <header class="flex items-start justify-between gap-3 border-b border-default p-[18px_20px]"><h2 class="m-0 text-foreground">Card detail</h2><button class="flex-none cursor-pointer rounded-md border border-default bg-transparent text-[18px] leading-none text-muted hover:border-border-strong hover:text-foreground" onclick={closeDrawer} aria-label="Close" type="button" style="width:30px;height:30px">×</button></header>
      <p class="text-[14px] text-muted">{loading ? 'Loading…' : error ?? 'No detail.'}</p>
    </div>
  </div>
{/if}
