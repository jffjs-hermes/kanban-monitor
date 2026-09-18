<script lang="ts">
  type Card = { id: string; title: string; assignee: string; priority: number };
  const columns: { label: string; cards: Card[] }[] = [
    { label: 'Ready', cards: [] }, { label: 'Running', cards: [] }, { label: 'Review', cards: [] },
    { label: 'Blocked', cards: [] }, { label: 'Done', cards: [] }
  ];
  let board = 'default';
  const boards = ['default'];
</script>

<svelte:head><title>Kanban Board Monitor</title></svelte:head>
<div class="shell">
  <header><div><h1>Kanban Board Monitor</h1><p>Read-only live view of the Hermes team</p></div>
    <label>Board <select bind:value={board}>{#each boards as name}<option value={name}>{name}</option>{/each}</select></label>
  </header>
  <section class="summary"><span>Ready 0</span><span>Running 0</span><span>Review 0</span><span>Blocked 0</span><span>Done 0</span><small>Last sync: not connected</small></section>
  <main>{#each columns as column}<section class="column"><h2>{column.label}<b>{column.cards.length}</b></h2>{#if column.cards.length === 0}<div class="empty">No cards</div>{:else}{#each column.cards as card}<article><strong>{card.title}</strong><small>{card.assignee} · priority {card.priority}</small></article>{/each}{/if}</section>{/each}</main>
</div>
<style>
  :global(*) { box-sizing: border-box } :global(body) { margin: 0; background: #0d1117; color: #e6edf3; font: 15px system-ui, sans-serif }
  .shell { max-width: 1500px; margin: auto; padding: 28px } header { display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #30363d; padding-bottom:22px } h1 { margin:0; font-size:28px } p { color:#8b949e; margin:6px 0 0 } label { color:#8b949e } select { margin-left:8px; background:#161b22; border:1px solid #484f58; color:#e6edf3; border-radius:6px; padding:8px 30px 8px 10px }
  .summary { display:flex; gap:12px; align-items:center; padding:20px 0; color:#8b949e } .summary span { background:#161b22; border:1px solid #30363d; border-radius:6px; padding:8px 12px } .summary small { margin-left:auto } main { display:grid; grid-template-columns:repeat(5, minmax(180px,1fr)); gap:14px } .column { background:#161b22; border:1px solid #30363d; border-radius:8px; min-height:300px; padding:14px } h2 { margin:0 0 14px; font-size:16px } h2 b { float:right; color:#8b949e; font-weight:normal } .empty { color:#6e7681; text-align:center; padding:45px 0 } article { background:#21262d; border:1px solid #30363d; border-radius:6px; padding:12px; margin-bottom:10px } article strong, article small { display:block } article small { color:#8b949e; margin-top:8px }
  @media (max-width: 900px) { main { grid-template-columns:repeat(2, 1fr) } .summary { flex-wrap:wrap } .summary small { margin-left:0; width:100% } } 
</style>
