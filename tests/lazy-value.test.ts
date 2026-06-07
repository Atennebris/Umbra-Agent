import { describe, expect, it, vi } from 'vitest';
import { createLazyValue } from '../src/utils/lazy-value.js';

describe('createLazyValue', () => {
  it('creates the value only once and reuses it afterward', async () => {
    const factory = vi.fn(async () => ({ ready: true }));
    const loadValue = createLazyValue(factory);

    const first = await loadValue();
    const second = await loadValue();

    expect(first).toBe(second);
    expect(factory).toHaveBeenCalledTimes(1);
  });
});
