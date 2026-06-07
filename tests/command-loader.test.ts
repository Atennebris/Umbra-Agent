import { describe, expect, it } from 'vitest';
import { loadCliCommand } from '../src/cli/command-loader.js';

describe('loadCliCommand', () => {
  it('loads and caches the status command lazily', async () => {
    const first = await loadCliCommand('status');
    const second = await loadCliCommand('status');

    expect(first).toBe(second);
  });

  it('loads and caches the task add command lazily', async () => {
    const first = await loadCliCommand('task:add');
    const second = await loadCliCommand('task:add');

    expect(first).toBe(second);
  });

  it('loads and caches the doctor command lazily', async () => {
    const first = await loadCliCommand('doctor');
    const second = await loadCliCommand('doctor');

    expect(first).toBe(second);
  });
});
