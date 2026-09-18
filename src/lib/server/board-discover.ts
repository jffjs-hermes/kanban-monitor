// Discover available board DBs on disk (spec §1.3).
//
// Boards are files, not DB rows:
//   - default: $HERMES_HOME/kanban.db            (default $HERMES_HOME = ~/.hermes)
//   - named:   $HERMES_HOME/kanban/boards/<slug>/kanban.db
//
// listBoards() skips missing/unreadable files and tolerates a board DB that is
// being swapped or re-created. It performs no I/O writes of any kind.

import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { BoardSlug } from '../types';

export interface BoardInfo {
  slug: BoardSlug;
  path: string;
}

/** Resolve the Hermes home directory (respects HERMES_HOME). */
export function hermesHome(): string {
  const env = process.env['HERMES_HOME'];
  if (env && env.trim().length > 0) {
    // Absolute paths are used as-is; relative ones resolve against home for
    // predictability, mirroring how $HOME-relative tooling behaves.
    return isAbsolute(env) ? env : join(homedir(), env);
  }
  return join(homedir(), '.hermes');
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function listBoardsIn(dir: string): BoardInfo[] {
  let names: string[];
  try {
    names = readdirSync(dir); // throws when missing/unreadable
  } catch {
    return []; // boards dir missing or unreadable
  }
  const boards: BoardInfo[] = [];
  for (const name of names) {
    const dbPath = join(dir, name, 'kanban.db');
    if (isFile(dbPath)) {
      boards.push({ slug: name, path: dbPath });
    }
  }
  // Deterministic ordering for stable UI lists.
  boards.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  return boards;
}

/**
 * List every available board DB. The default board always comes first when
 * present; named boards follow in slug order. Missing files are skipped.
 */
export function listBoards(): BoardInfo[] {
  const home = hermesHome();
  const boards: BoardInfo[] = [];

  const defaultPath = join(home, 'kanban.db');
  if (isFile(defaultPath)) {
    boards.push({ slug: 'default', path: defaultPath });
  }

  boards.push(...listBoardsIn(join(home, 'kanban', 'boards')));
  return boards;
}