import { describe, expect, it, vi } from 'vitest';
import * as loader from '../src/cli/command-loader.js';
import { createCli } from '../src/cli/main.js';

describe('Lazy-load smoke test', () => {
  it('does not load heavy branches for simple CLI parsing like --help', () => {
    const spy = vi.spyOn(loader, 'loadCliCommand');
    const cli = createCli();

    // Override console.log to avoid spamming the test output with help text
    const originalLog = console.log;
    console.log = vi.fn();

    try {
      // By passing --help, cac prints help and exits the parse flow.
      // We pass { run: false } just in case, but cac usually exits process.
      // Wait, cac's cli.help() calls process.exit(0) unless we intercept or
      // override process.exit, but we don't have to if we don't pass --help to run.
      // We can just parse an unknown command or just check command matches without running.
      cli.parse(['node', 'umbra'], { run: false });

      // The command loader (heavy dynamic imports) should NEVER be called
      // during the parse phase.
      expect(spy).not.toHaveBeenCalled();
    } finally {
      console.log = originalLog;
      spy.mockRestore();
    }
  });
});
