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
  import { renderMarkdown } from '$lib/markdown';
  import { prettyJson, renderDiffLines, renderMode, type DiffLine } from '$lib/transcript-render';
  import type { CardDetail, RunRow, TaskStatus, TranscriptEvent } from '$lib/types';
  import { findPrUrl } from '$lib/pr-link';

  // --- Transcript tab (transcript viewer) ------------------------------------
  // The transcript endpoint lives under /api/agent/* so it is AGENT_TOKEN-gated
  // even for the UI (locked decision §2). The operator supplies the token once,
  // stored in localStorage, and every transcript fetch sends it as a Bearer
  // header. On a non-loopback deploy a missing/wrong token yields 401, which we
  // surface with the token input instead of an opaque error.
  const TOKEN_KEY = 'kanban-monitor-agent-token';
  let token = $state<string>(localStorage.getItem(TOKEN_KEY) ?? '');
  let transcript = $state<TranscriptEvent[] | null>(null);
  let transcriptTruncated = $state(false);
  let transcriptHas = $state(false);
  let transcriptAuth = $state(false); // true when the last fetch 401'd
  let expanded = $state<Set<number>>(new Set());

  function persistToken() {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
    void loadTranscript();
  }

  function toggleExpand(seq: number) {
    const s = new Set(expanded);
    if (s.has(seq)) s.delete(seq);
    else s.add(seq);
    expanded = s;
  }

  async function loadTranscript() {
    if (!st.open || st.taskId === null) return;
    const slug = st.slug;
    const taskId = st.taskId;
    const headers: Record<string, string> = {};
    if (token) headers['authorization'] = `Bearer ${token}`;
    try {
      const res = await fetch(
        `/api/agent/board/${encodeURIComponent(slug)}/cards/${encodeURIComponent(taskId)}/transcript`,
        { headers },
      );
      if (res.status === 401) {
        transcriptAuth = true;
        return;
      }
      transcriptAuth = false;
      if (!res.ok) {
        transcript = [];
        transcriptHas = false;
        transcriptTruncated = false;
        return;
      }
      const d = (await res.json()) as {
        events: TranscriptEvent[];
        truncated: boolean;
        hasTranscript: boolean;
      };
      transcript = d.events;
      transcriptTruncated = d.truncated;
      transcriptHas = d.hasTranscript;
    } catch {
      transcript = [];
      transcriptHas = false;
      transcriptTruncated = false;
    }
  }

  function eventLabel(e: TranscriptEvent): string {
    if (e.kind === 'tool-call') return e.toolName ? `→ ${e.toolName}` : '→ tool';
    if (e.kind === 'tool-result') return `⇐ ${e.toolName ?? 'result'}`;
    if (e.kind === 'heartbeat') return '♥ heartbeat';
    if (e.kind === 'user') return 'you';
    return 'agent';
  }

  function eventClass(e: TranscriptEvent): string {
    if (e.kind === 'tool-call') return 'text-link';
    if (e.kind === 'tool-result') return 'text-success';
    if (e.kind === 'heartbeat') return 'text-faint';
    return 'text-foreground';
  }

  // Color one classified diff line. Rendered through Svelte as escaped text
  // nodes inside a `<pre>`; the class is the only markup we add per line.
  function diffLineClass(kind: DiffLine['kind']): string {
    if (kind === 'hunk') return 'text-link';
    if (kind === 'add') return 'text-success';
    if (kind === 'del') return 'text-danger';
    if (kind === 'meta') return 'text-faint';
    return 'text-foreground';
  }

  let detail = $state<CardDetail | null>(null);
  let loading = $state(false);
  let error = $state<string | null>(null);

  const st = $derived($drawer);
  const open = $derived(st.open && st.taskId !== null);

  // Impl 9: the card's pull request, recovered from the most recent run's
  // `metadata.published_pr` (falling back to the first full GitHub PR URL in
  // the comments). Runs arrive ascending by id, so reverse for most-recent-first.
  function parsedMeta(r: RunRow): Record<string, unknown> | null {
    if (!r.metadata) return null;
    try {
      const v = JSON.parse(r.metadata);
      return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  const pr = $derived(
    detail
      ? findPrUrl([...detail.runs].reverse().map(parsedMeta), detail.comments)
      : null,
  );

  // Refetch whenever the drawer target or its refresh token changes.
  $effect(() => {
    if (!st.open || st.taskId === null) {
      detail = null;
      loading = false;
      error = null;
      transcript = null;
      transcriptTruncated = false;
      transcriptHas = false;
      transcriptAuth = false;
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
    // Live tail: refetch the transcript on every open/refresh tick so a running
    // card's history advances with the same SSE `card` scope / rev flow that
    // drives the detail refetch above.
    void loadTranscript();
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
          {#if pr}
            <a class="mt-2 inline-flex items-center gap-1 rounded-full border border-accent-strong bg-surface-2 px-2.5 py-0.5 text-[12px] text-link hover:bg-accent-tint" href={pr.url} target="_blank" rel="noreferrer">PR #{pr.number} ↗</a>
          {/if}
        </div>
        <button class="flex-none cursor-pointer rounded-md border border-default bg-transparent text-[18px] leading-none text-muted hover:border-border-strong hover:text-foreground" onclick={closeDrawer} aria-label="Close" type="button" style="width:30px;height:30px">×</button>
      </header>

      <div class="overflow-y-auto px-5 pt-1 pb-6">
        <section class="border-b border-surface-2 py-4">
          <h3 class="m-0 mb-2.5 text-[12px] tracking-[.06em] uppercase text-muted">Body</h3>
          {#if detail.body}
            <div class="markdown-body">{@html renderMarkdown(detail.body)}</div>
          {:else}
            <p class="text-[13px] text-faint">No body.</p>
          {/if}
        </section>

        <section class="border-b border-surface-2 py-4">
          <h3 class="m-0 mb-2.5 text-[12px] tracking-[.06em] uppercase text-muted">
            Transcript
            {#if transcript && transcript.length > 0}<span class="text-faint">{transcript.length}</span>{/if}
            {#if transcriptTruncated}<span class="ml-1 rounded bg-warning-tint px-1.5 py-0.5 text-[11px] text-warning">truncated</span>{/if}
          </h3>

          {#if transcriptAuth}
            <p class="mb-2 text-[13px] text-warning">This transcript requires the agent token (AGENT_TOKEN).</p>
            <div class="mb-1 flex items-center gap-2">
              <input
                type="password"
                class="min-w-0 flex-1 rounded-md border border-default bg-background px-2 py-1 text-[13px] text-foreground outline-none placeholder:text-faint focus:border-accent-strong"
                placeholder="AGENT_TOKEN"
                autocomplete="off"
                spellcheck="false"
                bind:value={token}
                oninput={persistToken}
                data-test="transcript-token"
              />
            </div>
            <p class="text-[12px] text-faint">Stored locally in your browser; sent only to /api/agent/*.</p>
          {:else if transcript === null}
            <p class="text-[13px] text-faint">Loading transcript…</p>
          {:else if !transcriptHas || transcript.length === 0}
            <p class="text-[13px] text-faint">No transcript for this card’s latest run.</p>
          {:else}
            {#if token}
              <div class="mb-2 flex items-center justify-end gap-2">
                <button class="cursor-pointer rounded-md border border-default bg-transparent px-2 py-0.5 text-[12px] text-muted hover:border-border-strong hover:text-foreground" onclick={() => { token = ''; persistToken(); }} type="button">clear token</button>
              </div>
            {/if}
            <ol class="m-0 flex list-none flex-col gap-1 p-0">
              {#each transcript ?? [] as e (e.seq)}
                <li class="rounded-md border border-surface-2 bg-background p-[8px_10px]">
                  <div class="flex items-baseline gap-2 text-[12px]">
                    <span class="font-mono shrink-0 tabular-nums text-faint">{fmtTime(e.at)}</span>
                    <span class={`shrink-0 font-semibold ${eventClass(e)}`}>{eventLabel(e)}</span>
                  </div>
                  {#if e.text}
                    {#snippet eventBody()}
                      {@const mode = renderMode(e.kind, e.text)}
                      {#if mode === 'markdown'}
                        <div class="markdown-body mt-1">{@html renderMarkdown(e.text)}</div>
                      {:else if mode === 'json'}
                        <pre class="m-0 mt-1 break-words font-[inherit] whitespace-pre-wrap text-[13px] text-foreground">{prettyJson(e.text) ?? e.text}</pre>
                      {:else if mode === 'diff'}
                        <pre class="m-0 mt-1 break-words font-[inherit] whitespace-pre-wrap text-[13px]">
                          {#each renderDiffLines(e.text) as l, i (i)}
                            <div class={diffLineClass(l.kind)}>{l.text}</div>
                          {/each}
                        </pre>
                      {:else}
                        <pre class="m-0 mt-1 break-words font-[inherit] whitespace-pre-wrap text-[13px] text-foreground">{e.text}</pre>
                      {/if}
                    {/snippet}
                    {#if e.truncated && !expanded.has(e.seq)}
                      {@render eventBody()}
                      <button class="mt-1 cursor-pointer rounded border border-default bg-transparent px-2 py-0.5 text-[12px] text-link hover:bg-accent-tint" onclick={() => toggleExpand(e.seq)} type="button">show more…</button>
                    {:else}
                      {@render eventBody()}
                      {#if e.truncated}<span class="text-faint"> …</span>{/if}
                      {#if e.truncated && expanded.has(e.seq)}
                        <button class="mt-1 cursor-pointer rounded border border-default bg-transparent px-2 py-0.5 text-[12px] text-link hover:bg-accent-tint" onclick={() => toggleExpand(e.seq)} type="button">hide</button>
                      {/if}
                    {/if}
                  {/if}
                </li>
              {/each}
            </ol>
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
