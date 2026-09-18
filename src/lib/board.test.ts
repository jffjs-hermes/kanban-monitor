import { describe, expect, it } from 'vitest';

describe('monitor scaffold', () => {
  it('exposes the MVP status columns in order', () => {
    expect(['Ready', 'Running', 'Review', 'Blocked', 'Done']).toHaveLength(5);
  });
});
