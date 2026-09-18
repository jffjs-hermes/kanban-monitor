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
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
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

/**
 * Recover a board slug from a DB file path, using the same layout as
 * `listBoards` (§1.3): `<home>/kanban.db` → 'default',
 * `<home>/kanban/boards/<slug>/kanban.db` → '<slug>'. Pure string logic (no
 * filesystem I/O), so it is safe to call on every snapshot tick. Paths that do
 * not match the known layout (e.g. ad-hoc/in-memory test DBs) fall back to the
 * default board.
 */
export function slugFromPath(dbPath: string): BoardSlug {
  const path = resolve(dbPath);
  const home = resolve(hermesHome());
  if (path === resolve(join(home, 'kanban.db'))) return 'default';

  const boardsRoot = resolve(join(home, 'kanban', 'boards'));
  const rel = relative(boardsRoot, path);
  if (rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)) {
    const [slugDir, ...rest] = rel.split(sep);
    if (slugDir && rest.join(sep) === 'kanban.db') return slugDir;
  }
  return 'default';
}