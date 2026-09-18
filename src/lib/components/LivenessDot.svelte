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
  class="inline-block flex-none rounded-full"
  class:bg-faint={liveness !== 'active' && liveness !== 'stalled'}
  class:bg-success={liveness === 'active'}
  class:bg-warning={liveness === 'stalled'}
  class:shadow-[0_0_6px_var(--success-glow)]={liveness === 'active'}
  class:shadow-[0_0_6px_var(--warning-glow)]={liveness === 'stalled'}
  style={`width:${size}px;height:${size}px`}
  title={title}
  aria-label={title}
></span>