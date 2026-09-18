// Detail-drawer client shell (spec §2.1, §4). A tiny Svelte store that says
// "which card's drawer is open", decoupled from the board store so any page/API
// route can open it from a card click and close it from an overlay/Escape.
//
// `rev` is a monotonically increasing token: bump it to force the open drawer
// to refetch detail data (called by the SSE `card` scope so an open drawer
// live-refreshes when its card's detail rows change — §2.1 "the drawer fetches
// …/cards/[id].json on receipt"). It is intentionally browser-side only; a
// missing drawer store in a non-browser context is a no-op (`ssr=false`).

import { writable, type Writable } from 'svelte/store';
import type { BoardSlug } from './types';

export interface DrawerState {
  open: boolean;
  taskId: string | null;
  slug: BoardSlug;
  rev: number;
}

export const drawer: Writable<DrawerState> = writable({
  open: false,
  taskId: null,
  slug: 'default',
  rev: 0,
});

let revSeq = 0;

export function openDrawer(taskId: string, slug: BoardSlug = 'default'): void {
  revSeq += 1;
  drawer.set({ open: true, taskId, slug, rev: revSeq });
}

export function closeDrawer(): void {
  drawer.update((d) => (d.open ? { ...d, open: false } : d));
}

/**
 * Notify the drawer that `taskId`'s detail data may have changed (a `card`
 * SSE scope). Only the open card triggers a refetch; everything else is a
 * no-op so stray scopes never yank the drawer around.
 */
export function markDirty(taskId: string): void {
  drawer.update((d) => {
    if (!d.open || d.taskId !== taskId) return d;
    revSeq += 1;
    return { ...d, rev: revSeq };
  });
}
