// Card transcript reader (spec §2 `CardDetail` + transcript viewer card).
//
// Read-only surface that turns one card's worker transcript into an ordered,
// bounded list of events for the drawer (live tail for running cards, full
// history for done/blocked). It reads the *owning profile's* session store —
// the profile `state.db` (`sessions` + `messages` tables) under
// `$HERMES_HOME/profiles/<profile>/` — keyed ONLY by the session id recorded on
// the card's own run (`task_runs.metadata.$.worker_session_id`). It never
// accepts a user-supplied session id and performs no writes (locked decisions
// §1, §3, §4).
//
// Resolution, strictly card-keyed:
//   card → its runs → the run's owning profile + worker_session_id → that
//   profile's `state.db` → session → ordered messages.
// A foreign/forged session id is unreadable by construction: the reader only
// ever looks up the session id that the requested card's run already recorded,
// and only inside that run's owning profile directory.
//
// Missing/moved/disappeared session data degrades gracefully to an empty
// result (the drawer renders a "no transcript" note) rather than throwing.
//
// Bounding: every event's body text is truncated to a bounded character
// budget (large tool-result payloads are never dumped in full), and the event
// list itself is capped — a monitor, not a log dumper (locked decision §5).

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';

import { openReadonly } from './data-access';
import { hermesHome } from './board-discover';
import { listRuns, listTasks } from './data-access';
import type { TranscriptEvent, TranscriptResult } from '../types';

/** Per-event body-text cap (locked decision §5: bounded, "show more" on text). */
export const MAX_PAYLOAD_CHARS = 2000;
/** Hard cap on the number of events returned (oldest dropped; flagged truncated). */
export const MAX_EVENTS = 1000;

/** A raw `messages` row subset the transcript needs. */
interface MessageRow {
  id: number;
  role: string;
  content: string | null;
  tool_call_id: string | null;
  tool_calls: string | null;
  tool_name: string | null;
  timestamp: number | null;
}

interface ParsedToolCall {
  function?: { name?: string; arguments?: string };
  name?: string;
  id?: string;
}

function truncate(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, max), truncated: true };
}

function parseToolCalls(raw: string | null): ParsedToolCall[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v as ParsedToolCall[];
  } catch {
    return [];
  }
}

function callName(tc: ParsedToolCall): string | null {
  return tc.function?.name ?? tc.name ?? null;
}

/**
 * Fold one `messages` row into one-or-more transcript events, in row order.
 * Emits, in id order:
 *   - `user` messages   → a single body-text event.
 *   - `assistant` rows  → a body-text event when `content` is non-blank, plus
 *     one `tool-call` event per tool call in `tool_calls`.
 *   - `tool` rows       → a `heartbeat` event when the tool name carries
 *     "heartbeat", else a `tool-result` event (body = the result payload,
 *     truncated to the bounded budget).
 */
function foldMessage(row: MessageRow, max: number): Omit<TranscriptEvent, 'seq'>[] {
  const at = typeof row.timestamp === 'number' ? row.timestamp : null;
  const out: Omit<TranscriptEvent, 'seq'>[] = [];

  if (row.role === 'tool') {
    const body = row.content ?? '';
    const truncatedBody = truncate(body, max);
    const isHeartbeat = (row.tool_name ?? '').toLowerCase().includes('heartbeat');
    out.push({
      at,
      kind: isHeartbeat ? 'heartbeat' : 'tool-result',
      role: 'tool',
      toolName: row.tool_name,
      text: truncatedBody.text,
      truncated: truncatedBody.truncated,
    });
    return out;
  }

  const body = row.content ?? '';

  if (row.role === 'user') {
    const t = truncate(body, max);
    out.push({ at, kind: 'user', role: 'user', toolName: null, text: t.text, truncated: t.truncated });
    return out;
  }

  // assistant: body text (if any) then one tool-call event per call.
  if (row.role === 'assistant') {
    if (body.trim().length > 0) {
      const t = truncate(body, max);
      out.push({ at, kind: 'assistant', role: 'assistant', toolName: null, text: t.text, truncated: t.truncated });
    }
    for (const tc of parseToolCalls(row.tool_calls)) {
      const name = callName(tc);
      // Tool arguments can be large (a full command/query); bind them.
      const args = tc.function?.arguments ?? '';
      const t = truncate(args, max);
      out.push({
        at,
        kind: 'tool-call',
        role: 'assistant',
        toolName: name,
        text: t.text,
        truncated: t.truncated,
      });
    }
    return out;
  }

  // Unknown role — carry the body through so nothing is silently dropped.
  const t = truncate(body, max);
  out.push({ at, kind: 'assistant', role: row.role, toolName: null, text: t.text, truncated: t.truncated });
  return out;
}

/**
 * Read the ordered transcript for `taskId`'s latest run session, or `null`
 * when the card does not exist on this board. Degrades gracefully:
 *   - no run / no session id     → empty result (`hasTranscript: false`);
 *   - profile `state.db` missing → empty result (session store moved/gone);
 *   - session id not found there → empty result (session not yet persisted).
 * `sessionId` is always the id recorded on the card's own run (never user input).
 */
export function readCardTranscript(
  db: Database,
  taskId: string,
  opts?: { maxPayloadChars?: number; maxEvents?: number },
): TranscriptResult | null {
  const maxPayloadChars = opts?.maxPayloadChars ?? MAX_PAYLOAD_CHARS;
  const maxEvents = opts?.maxEvents ?? MAX_EVENTS;

  const tasks = listTasks(db);
  const task = tasks.find((t) => t.id === taskId);
  if (!task) return null;

  const runs = listRuns(db)
    .filter((r) => r.task_id === taskId)
    .sort((a, b) => (b.id ?? 0) - (a.id ?? 0));

  const latestOwned = runs.find((r) => r.worker_session_id != null);
  if (!latestOwned) {
    return { events: [], truncated: false, sessionId: null, hasTranscript: false, profile: null };
  }

  const sessionId = latestOwned.worker_session_id!;
  // Owning profile: the run's recorded profile, falling back to the card's
  // assignee. Either suspect → cannot resolve a profile dir → no transcript.
  const profile = latestOwned.profile ?? task.assignee;
  if (!profile) {
    return { events: [], truncated: false, sessionId, hasTranscript: false, profile: null };
  }

  const stateDbPath = join(hermesHome(), 'profiles', profile, 'state.db');
  if (!existsSync(stateDbPath)) {
    return { events: [], truncated: false, sessionId, hasTranscript: false, profile };
  }

  let store: Database;
  try {
    store = openReadonly(stateDbPath);
  } catch {
    return { events: [], truncated: false, sessionId, hasTranscript: false, profile };
  }

  try {
    // Confirm the session exists in this profile's store before reading rows —
    // a session id that maps to no session is "no transcript", not an error.
    const found = store
      .query<{ c: number }, [string]>('SELECT count(*) AS c FROM sessions WHERE id = ?')
      .get(sessionId);
    if (!found || found.c === 0) {
      return { events: [], truncated: false, sessionId, hasTranscript: false, profile };
    }

    const rows = store
      .query<MessageRow, [string]>(
        `SELECT id, role, content, tool_call_id, tool_calls, tool_name, timestamp
           FROM messages WHERE session_id = ? ORDER BY id ASC`,
      )
      .all(sessionId);

    const events: TranscriptEvent[] = [];
    // Keep the *latest* events within the cap (a long session's tail is the
    // useful part for a running card / post-mortem).
    const kept = rows.slice(-maxEvents);
    const eventsDropped = rows.length > kept.length;

    let seq = 0;
    for (const row of kept) {
      for (const base of foldMessage(row, maxPayloadChars)) {
        seq += 1;
        events.push({ seq, ...base });
      }
    }

    const truncated = events.some((e) => e.truncated) || eventsDropped;
    return { events, truncated, sessionId, hasTranscript: true, profile };
  } catch {
    // Store became unreadable mid-read → graceful empty.
    return { events: [], truncated: false, sessionId, hasTranscript: false, profile };
  } finally {
    try {
      store.close();
    } catch {
      /* already closed */
    }
  }
}
