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
    if (s === 'running') return 'run-running';
    if (s === 'completed' || s === 'done') return 'run-ok';
    if (s === 'failed') return 'run-err';
    return 'run-neu';
  }

  function transitionLabel(t: { from: TaskStatus | null; to: TaskStatus }): string {
    return `${t.from ? STATUS_LABEL[t.from] ?? t.from : '·'} → ${STATUS_LABEL[t.to] ?? t.to}`;
  }
</script>

{#if open && detail}
  <div class="backdrop" onclick={onBackdropClose} onkeydown={onBackdropKey} role="presentation">
    <div class="drawer" role="dialog" aria-modal="true" aria-label="Card detail" tabindex="-1">
      <header class="head">
        <div class="hd">
          <h2>{detail.card.title}</h2>
          <div class="chips">
            <span class="chip status">{STATUS_LABEL[detail.card.status] ?? detail.card.status}</span>
            {#if detail.card.assignee}<span class="chip assignee">{detail.card.assignee}</span>{/if}
            <span class="chip prio">p{detail.card.priority}</span>
          </div>
        </div>
        <button class="close" onclick={closeDrawer} aria-label="Close" type="button">×</button>
      </header>

      <div class="scroll">
        <section class="body-sec">
          <h3>Body</h3>
          {#if detail.body}
            <pre class="body">{detail.body}</pre>
          {:else}
            <p class="muted">No body.</p>
          {/if}
        </section>

        <section class="trail-sec">
          <h3>Status trail</h3>
          {#if detail.transitions.length === 0}
            <p class="muted">No status transitions recorded.</p>
          {:else}
            <ol class="trail">
              {#each detail.transitions as t, i (i)}
                <li>
                  <span class="tarrow">{transitionLabel(t)}</span>
                  <span class="tat">{fmtTime(t.at)}</span>
                </li>
              {/each}
            </ol>
          {/if}
        </section>

        <section class="runs-sec">
          <h3>Runs <span class="count">{detail.runs.length}</span></h3>
          {#if detail.runs.length === 0}
            <p class="muted">No runs yet.</p>
          {:else}
            {#each detail.runs as r (r.id)}
              <div class="run">
                <div class="run-head">
                  <span class="badge {runStatusClass(r)}">#{r.id} {r.status ?? '—'}</span>
                  {#if r.outcome}<span class="outcome">{r.outcome}</span>{/if}
                  <span class="when">{runBase(r)}</span>
                </div>
                {#if r.summary}
                  <pre class="run-summary">{r.summary}</pre>
                {/if}
                {#if r.error}
                  <pre class="run-error">{r.error}</pre>
                {/if}
              </div>
            {/each}
          {/if}
        </section>

        <section class="comments-sec">
          <h3>Comments <span class="count">{detail.comments.length}</span></h3>
          {#if detail.comments.length === 0}
            <p class="muted">No comments.</p>
          {:else}
            {#each detail.comments as c (c.id)}
              <div class="comment">
                <div class="c-head"><b>{c.author}</b><span>{fmtTime(c.created_at)}</span></div>
                <pre class="c-body">{c.body}</pre>
              </div>
            {/each}
          {/if}
        </section>

        <section class="links-sec">
          <h3>Links</h3>
          <div class="links">
            <div class="link-group">
              <span class="lbl">Parents</span>
              {#if detail.card.parentIds.length === 0}
                <span class="muted">none</span>
              {:else}
                <span class="chip-group">
                  {#each detail.card.parentIds as pid (pid)}
                    <button class="chip link" onclick={() => openDrawer(pid, $drawer.slug)} type="button">{pid}</button>
                  {/each}
                </span>
              {/if}
            </div>
            <div class="link-group">
              <span class="lbl">Children</span>
              {#if detail.card.childIds.length === 0}
                <span class="muted">none</span>
              {:else}
                <span class="chip-group">
                  {#each detail.card.childIds as cid (cid)}
                    <button class="chip link" onclick={() => openDrawer(cid, $drawer.slug)} type="button">{cid}</button>
                  {/each}
                </span>
              {/if}
            </div>
          </div>
        </section>

        <footer class="foot">
          created {fmtTime(detail.card.createdAt)} · {detail.card.runCount} run{detail.card.runCount === 1 ? '' : 's'}
        </footer>
      </div>
    </div>
  </div>
{:else if open}
  <div class="backdrop" onclick={onBackdropClose} onkeydown={onBackdropKey} role="presentation">
    <div class="drawer status-pane" role="dialog" aria-modal="true" aria-label="Card detail">
      <header class="head"><h2>Card detail</h2><button class="close" onclick={closeDrawer} aria-label="Close" type="button">×</button></header>
      <p class="status-msg">{loading ? 'Loading…' : error ?? 'No detail.'}</p>
    </div>
  </div>
{/if}

<style>
  * { box-sizing: border-box; }
  .backdrop {
    position: fixed; inset: 0; background: rgba(1, 4, 9, 0.55);
    z-index: 50; display: flex; justify-content: flex-end;
  }
  .drawer {
    width: min(560px, 94vw); height: 100%; background: #161b22;
    border-left: 1px solid #30363d; display: flex; flex-direction: column;
    box-shadow: -12px 0 32px rgba(0,0,0,.45); animation: slide .16s ease-out;
  }
  @keyframes slide { from { transform: translateX(18px); opacity: .6; } to { transform: none; opacity: 1; } }
  .head {
    display: flex; justify-content: space-between; align-items: flex-start;
    gap: 12px; padding: 18px 20px; border-bottom: 1px solid #30363d;
  }
  .hd h2 { margin: 0 0 10px; font-size: 18px; color: #e6edf3; line-height: 1.3; word-break: break-word; }
  .chips { display: flex; gap: 8px; flex-wrap: wrap; }
  .chip {
    background: #21262d; border: 1px solid #30363d; color: #8b949e;
    border-radius: 12px; padding: 2px 10px; font-size: 12px;
  }
  .chip.status { color: #a5d6ff; border-color: #1f6feb; }
  .chip.assignee { color: #a5d6ff; }
  .chip.link { cursor: pointer; color: #58a6ff; border-color: #1f6feb; font-family: ui-monospace, monospace; }
  .chip.link:hover { background: #1f6feb22; }
  .close {
    background: none; border: 1px solid #30363d; color: #8b949e;
    width: 30px; height: 30px; border-radius: 6px; font-size: 18px; line-height: 1;
    cursor: pointer; flex: none;
  }
  .close:hover { color: #e6edf3; border-color: #6e7681; }
  .scroll { overflow-y: auto; padding: 4px 20px 24px; }
  section { border-bottom: 1px solid #21262d; padding: 16px 0; }
  h3 { margin: 0 0 10px; font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: #8b949e; }
  h3 .count { color: #6e7681; }
  .body, pre { margin: 0; font-family: inherit; font-size: 14px; color: #c9d1d9; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
  .muted { color: #6e7681; font-size: 13px; }
  .trail { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
  .trail li { display: flex; justify-content: space-between; gap: 12px; align-items: baseline; }
  .tarrow { color: #e6edf3; font-size: 13px; }
  .tat { color: #6e7681; font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .run { background: #0d1117; border: 1px solid #21262d; border-radius: 6px; padding: 10px 12px; margin-bottom: 10px; }
  .run-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .badge { font-size: 12px; padding: 1px 8px; border-radius: 10px; }
  .run-running { background: #1f6feb22; color: #58a6ff; }
  .run-ok { background: #23863622; color: #3fb950; }
  .run-err { background: #da363322; color: #f85149; }
  .run-neu { background: #21262d; color: #8b949e; }
  .outcome { font-size: 12px; color: #8b949e; }
  .when { font-size: 12px; color: #6e7681; margin-left: auto; font-variant-numeric: tabular-nums; }
  .run-summary { font-size: 13px; margin-top: 6px; }
  .run-error { font-size: 13px; color: #f85149; margin-top: 6px; }
  .comment { border: 1px solid #21262d; border-radius: 6px; background: #0d1117; padding: 10px 12px; margin-bottom: 10px; }
  .c-head { display: flex; justify-content: space-between; margin-bottom: 6px; font-size: 12px; color: #a5d6ff; }
  .c-head span { color: #6e7681; }
  .c-body { font-size: 13px; }
  .links { display: flex; flex-direction: column; gap: 10px; }
  .link-group { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .lbl { font-size: 12px; color: #8b949e; width: 70px; }
  .chip-group { display: flex; gap: 6px; flex-wrap: wrap; }
  .foot { padding-top: 14px; color: #6e7681; font-size: 12px; }
  .status-pane { padding: 4px 20px; }
  .status-msg { color: #8b949e; font-size: 14px; }
</style>
