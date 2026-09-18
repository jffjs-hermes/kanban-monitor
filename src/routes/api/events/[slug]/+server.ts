// GET /api/events/[slug] — SSE stream (spec §1.2, §4).
//
// Opens a `text/event-stream` that:
//   - sends `retry: 3000`, a `hello` (§4) and an initial full `reset` so a
//     reconnect never has to replay missed deltas (no Last-Event-ID handling in
//     MVP);
//   - forwards board deltas (summary/cards/card/reset) from the hub with the
//     spec-§4 payloads;
//   - forwards cross-board `board` events so a client watching a board that the
//     runtime switches away from can re-target (§1.1);
//   - emits a `ping` every 15s to keep proxies alive (§4);
//   - cleans up (unsubscribes + stops the ping timer) on abort/disconnect
//     (§4 cleanup — check `request.signal`).

import type { RequestEvent } from '@sveltejs/kit';
import {
  encodeSseFrame,
  PING_INTERVAL_MS,
  sseWireEvent,
} from '../../../../lib/server/sse-hub';
import { boardRuntime } from '../../../../lib/server/runtime';
import type { BoardSlug, SseEvent } from '../../../../lib/types';

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
} as const;

export function GET(event: RequestEvent) {
  const { params, request } = event;
  const slug: BoardSlug = params.slug ?? 'default';
  boardRuntime.select(slug);

  let seq = 0; // per-connection monotonic cursor (spec §2.2)
  let closed = false;
  const unsubs: (() => void)[] = [];
  let ping: ReturnType<typeof setInterval> | null = null;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (ping) clearInterval(ping);
    for (const un of unsubs) un();
    unsubs.length = 0;
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (s: string) => {
        if (closed) return;
        try {
          controller.enqueue(new TextEncoder().encode(s));
        } catch {
          /* stream already torn down */
        }
      };

      // Reconnection pacing (spec §4), then the connection greeting + full state.
      write('retry: 3000\n\n');
      seq += 1;
      write(encodeSseFrame('hello', { seq, slug, staleMs: boardRuntime.staleMs() }, seq));

      const snapshot = boardRuntime.snapshotOf(slug);
      if (snapshot) {
        seq += 1;
        write(encodeSseFrame('reset', snapshot, seq));
      }

      // Board deltas → spec-§4 payloads.
      unsubs.push(
        boardRuntime.hub.subscribe(slug, (evt: SseEvent) => {
          const wire = sseWireEvent(evt, boardRuntime.snapshotOf(slug));
          if (!wire) return;
          seq += 1;
          write(encodeSseFrame(wire.name, wire.data, seq));
        }),
      );

      // Cross-board channel: only notify when the active board moved away from
      // the board this connection is subscribed to.
      unsubs.push(
        boardRuntime.hub.subscribeAll((bev) => {
          if (bev.slug === slug) return;
          seq += 1;
          write(encodeSseFrame('board', { slug: bev.slug }, seq));
        }),
      );

      // Keep-alive pings (spec §4).
      ping = setInterval(() => {
        seq += 1;
        write(encodeSseFrame('ping', { at: Date.now() }, seq));
      }, PING_INTERVAL_MS);

      request.signal.addEventListener('abort', cleanup, { once: true });
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}