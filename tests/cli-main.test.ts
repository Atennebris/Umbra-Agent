import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCli, main } from '../src/cli/main.js';

const originalExitCode = process.exitCode;

afterEach(() => {
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
});

describe('createCli', () => {
  it('registers phase 1 commands', () => {
    const cli = createCli();
    const names = cli.commands.map((command) => command.name);

    expect(names).toContain('start');
    expect(names).toContain('stop');
    expect(names).toContain('status');
    expect(names.some((name) => name.includes('task'))).toBe(true);
    expect(names).toContain('init');
    expect(names).toContain('doctor');
    expect(names).toContain('debug');
    expect(names).toContain('tui');
    expect(names).toContain('providers connect');
    expect(names).toContain('providers');
    expect(names).toContain('models');
  });

  it('rejects unknown bare commands instead of silently opening the TUI', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await main(['node', 'umbra', 'qwerty']);

    expect(process.exitCode).toBe(1);
    expect(stderrSpy).toHaveBeenCalledWith(
      "Unknown command: qwerty\nRun 'umbra --help' for a list of available commands.\n",
    );
  });
});
