<script lang="ts">
  // Root client shell (spec §1.2 `CardDetailDrawer`). Renders the routed page
  // inside a layout that also mounts the card detail drawer, so any card click
  // anywhere in the SPA opens the drawer overlay without the page owning it.
  // `ssr=false` is set in `+layout.ts`, so this stays client-only (no SSR data
  // requirements — spec §1.2 "+layout.ts … keep no-SSR").
  import CardDetailDrawer from '$lib/components/CardDetailDrawer.svelte';
</script>

<slot />

<CardDetailDrawer />
