import { describe, expect, it, vi } from 'vitest';
import { createCli } from '../src/cli/main.js';

describe('CLI Contract', () => {
  it('parses start command', () => {
    const cli = createCli();
    cli.parse(['node', 'umbra', 'start'], { run: false });
    expect(cli.matchedCommandName).toBe('start');
  });

  it('parses stop command', () => {
    const cli = createCli();
    cli.parse(['node', 'umbra', 'stop'], { run: false });
    expect(cli.matchedCommandName).toBe('stop');
  });

  it('parses status command with flags', () => {
    const cli = createCli();
    cli.parse(['node', 'umbra', 'status', '--json'], { run: false });
    expect(cli.matchedCommandName).toBe('status');
    expect(cli.options.json).toBe(true);
  });

  it('parses task add command with flags', () => {
    const cli = createCli();
    // CAC treats commands with spaces as a single quoted command name,
    // so we pass 'task add' as one element.
    cli.parse(['node', 'umbra', 'task add', 'do something', '--json', '--project', '/tmp'], {
      run: false,
    });
    expect(cli.matchedCommandName).toBe('task add');
    expect(cli.options.json).toBe(true);
    expect(cli.options.project).toBe('/tmp');
    expect(cli.args).toEqual(['do something']);
  });

  it('parses init command with flags', () => {
    const cli = createCli();
    cli.parse(['node', 'umbra', 'init', '/tmp', '--force'], { run: false });
    expect(cli.matchedCommandName).toBe('init');
    expect(cli.options.force).toBe(true);
    expect(cli.args).toEqual(['/tmp']);
  });
});
