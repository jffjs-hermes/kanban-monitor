// Unit tests: card-drawer client shell (spec §2.1, §4). Runs the pure store
// transitions without a browser — open sets a target + bumps `rev`, markDirty
// refetches only the open card, close clears it — mirroring what the SSE `card`
// scope and the overlay do in the app.

import { beforeEach, describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import { drawer, openDrawer, closeDrawer, markDirty } from './card-drawer';

beforeEach(() => {
  closeDrawer();
});

describe('card-drawer store', () => {
  it('openDrawer sets the target card and board', () => {
    openDrawer('task-1', 'alpha');
    const s = get(drawer);
    expect(s.open).toBe(true);
    expect(s.taskId).toBe('task-1');
    expect(s.slug).toBe('alpha');
  });

  it('openDrawer bumps rev so the drawer refetches', () => {
    openDrawer('task-1');
    const r1 = get(drawer).rev;
    openDrawer('task-1');
    expect(get(drawer).rev).toBeGreaterThan(r1);
  });

  it('markDirty refetches only the currently open card', () => {
    openDrawer('task-1');
    const r1 = get(drawer).rev;
    markDirty('task-2'); // different card → no-op
    expect(get(drawer).rev).toBe(r1);
    markDirty('task-1'); // open card → bump
    expect(get(drawer).rev).toBeGreaterThan(r1);
  });

  it('markDirty is a no-op when the drawer is closed', () => {
    closeDrawer();
    const r1 = get(drawer).rev;
    markDirty('task-1');
    expect(get(drawer).rev).toBe(r1);
    expect(get(drawer).open).toBe(false);
  });

  it('closeDrawer clears the open flag but keeps the target for reuse', () => {
    openDrawer('task-1', 'beta');
    closeDrawer();
    const s = get(drawer);
    expect(s.open).toBe(false);
    expect(s.taskId).toBe('task-1');
  });
});
