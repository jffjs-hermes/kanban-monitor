// All SQL in the codebase lives here (spec §1.2 boundary rule).
//
// Everything below opens read-only `bun:sqlite` handles. The app never writes
// to a board DB. Readers rely on the default journal mode (no WAL forced) so
// they coexist with the live gateway's writer. Long-lived read-only handles are
// fine; callers that hit a swapped/disappeared DB close and reopen next tick.

import { Database } from 'bun:sqlite';
import type {
  CommentRow,
  EventRow,
  RunRow,
  TaskLinkRow,
  TaskRow,
} from '../types';

/** Open a board DB read-only. Throws if the file is unusable. */
export function openReadonly(path: string): Database {
  return new Database(path, { readonly: true });
}

/**
 * The on-disk path a (read-only) handle was opened for, from `PRAGMA
 * database_list`. A raw bun:sqlite `Database` carries no path property, and the
 * filename is what `board-discover.slugFromPath` needs to recover the board
 * slug. Returns '' for in-memory DBs.
 */
export function boardDbPath(db: Database): string {
  const rows = db.query<{ name: string; file: string }, []>(`PRAGMA database_list`).all();
  const main = rows.find((r) => r.name === 'main');
  return main?.file ?? '';
}

function rows<T>(db: Database, sql: string): T[] {
  return db.query(sql).all() as T[];
}

// --- individual table reads ------------------------------------------------

export function listTasks(db: Database): TaskRow[] {
  return rows<TaskRow>(
    db,
    `SELECT id, title, body, assignee, status, priority, created_at,
            started_at, completed_at, worker_pid, last_heartbeat_at,
            current_run_id, block_kind
       FROM tasks`,
  );
}

export function listRuns(db: Database): RunRow[] {
  return rows<RunRow>(
    db,
    `SELECT id, task_id, status, outcome, summary, worker_pid,
            json_extract(metadata, '$.worker_session_id') AS worker_session_id,
            started_at, ended_at, error
       FROM task_runs`,
  );
}

export function listEvents(db: Database): EventRow[] {
  return rows<EventRow>(
    db,
    `SELECT id, task_id, kind, payload, created_at, run_id
       FROM task_events`,
  );
}

export function listComments(db: Database): CommentRow[] {
  return rows<CommentRow>(
    db,
    `SELECT id, task_id, author, body, created_at
       FROM task_comments`,
  );
}

export function listLinks(db: Database): TaskLinkRow[] {
  return rows<TaskLinkRow>(db, `SELECT parent_id, child_id FROM task_links`);
}

/**
 * Drain every table the monitor consumes in a single read-only transaction
 * (spec §2). Reads are consistent within one snapshot tick.
 */
export interface BoardRows {
  tasks: TaskRow[];
  runs: RunRow[];
  events: EventRow[];
  comments: CommentRow[];
  links: TaskLinkRow[];
}

export function readBoardRows(db: Database): BoardRows {
  const doRead = () => ({
    tasks: listTasks(db),
    runs: listRuns(db),
    events: listEvents(db),
    comments: listComments(db),
    links: listLinks(db),
  });
  // One read-only transaction so all five reads see a consistent board state.
  return db.transaction(doRead)();
}