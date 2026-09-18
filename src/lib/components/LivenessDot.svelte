<script lang="ts">
  // Live-connection indicator for running cards (spec §1.2).
  // green  = heartbeat fresh within STALE_WORKER_MS → active
  // amber  = heartbeat stale / missing → stalled
  // grey   = not running / no liveness info
  import type { Liveness } from '../types';

  let { liveness, size = 10, title = '' }: { liveness: Liveness | null; size?: number; title?: string } =
    $props();
</script>

<span
  class="dot"
  class:active={liveness === 'active'}
  class:stalled={liveness === 'stalled'}
  style={`width:${size}px;height:${size}px`}
  title={title}
  aria-label={title}
></span>

<style>
  .dot {
    display: inline-block;
    border-radius: 50%;
    background: #6e7681; /* grey — inactive / no liveness */
    flex: 0 0 auto;
  }
  .active {
    background: #3fb950; /* green — heartbeat fresh */
    box-shadow: 0 0 6px rgba(63, 185, 80, 0.6);
  }
  .stalled {
    background: #d29922; /* amber — overdue / stalled */
    box-shadow: 0 0 6px rgba(210, 153, 34, 0.5);
  }
</style>