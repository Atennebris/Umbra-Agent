import { pathToFileURL } from 'node:url';
import { cac } from 'cac';
import { writeDebugEvent } from '../debug/runtime-debug.js';
import { loadCliCommand } from './command-loader.js';

type StatusOptions = {
  json?: boolean;
};

type TaskAddOptions = {
  json?: boolean;
  source?: string;
  project?: string;
};

type InitOptions = {
  force?: boolean;
};

type DoctorOptions = {
  json?: boolean;
  fix?: boolean;
  repair?: boolean;
};

type DebugOptions = {
  interval?: string;
};

type TuiOptions = {
  prompt?: string;
  json?: boolean;
  project?: string;
  mode?: string;
  web?: string;
  doctor?: boolean;
};

type ExecOptions = {
  time?: string;
  json?: boolean;
  project?: string;
};

type ProvidersBaseOptions = {
  json?: boolean;
};

type ProvidersAddOptions = {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  default?: boolean;
  header?: string[];
};

type ProvidersUseOptions = {
  model?: string;
};

export function createCli() {
  const cli = cac('umbra');

  cli.command('start', 'Start the Umbra daemon through PM2.').action(async () => {
    const handler = await loadCliCommand('start');
    await handler({});
  });

  cli.command('stop', 'Stop the Umbra daemon through PM2.').action(async () => {
    const handler = await loadCliCommand('stop');
    await handler({});
  });

  cli
    .command('status', 'Show daemon health and queue state.')
    .option('--json', 'Print raw JSON output.')
    .action(async (options: StatusOptions) => {
      const handler = await loadCliCommand('status');
      await handler(options);
    });

  cli
    .command('task add [...task]', 'Queue a task for the daemon.')
    .option('--json', 'Print raw JSON output.')
    .option('--source <source>', 'Attach a source label to the task context.')
    .option('--project <path>', 'Target project path instead of the current shell cwd.')
    .action(async (task: string[], options: TaskAddOptions) => {
      const handler = await loadCliCommand('task:add');
      await handler({
        taskText: task.join(' ').trim(),
        json: options.json ?? false,
        source: options.source,
        projectPath: options.project,
      });
    });

  cli
    .command('init [directory]', 'Generate AGENTS.md and check scripts in a target directory.')
    .option('--force', 'Overwrite existing scaffold files.')
    .action(async (directory: string | undefined, options: InitOptions) => {
      const handler = await loadCliCommand('init');
      await handler({
        directory,
        force: options.force ?? false,
      });
    });

  cli
    .command('doctor', 'Run Umbra environment diagnostics.')
    .option('--json', 'Print raw JSON output.')
    .option('--fix', 'Attempt safe automatic repairs.')
    .option('--repair', 'Alias for --fix.')
    .action(async (options: DoctorOptions) => {
      const handler = await loadCliCommand('doctor');
      await handler({
        json: options.json ?? false,
        fix: options.fix ?? options.repair ?? false,
      });
    });

  cli
    .command('debug', 'Monitor daemon health and Umbra debug events.')
    .option('--interval <ms>', 'Health poll interval in milliseconds.')
    .action(async (options: DebugOptions) => {
      const handler = await loadCliCommand('debug');
      await handler({
        intervalMs: options.interval ? Number(options.interval) : undefined,
      });
    });

  // tui kept as alias for scripts that use it explicitly
  cli
    .command('tui', 'Alias for `umbra` — open the terminal workspace.')
    .option('--prompt <text>', 'Send a single prompt.')
    .option('--project <path>', 'Target project path.')
    .option('--mode <mode>', 'Permission mode: agent, full, plan.')
    .option('--web <mode>', 'Web search mode: off, on, cached, live.')
    .option('--exec', 'Autonomous mode — no confirmation prompts.')
    .option('--doctor', 'Run diagnostics and exit.')
    .action(async (options: TuiOptions & { exec?: boolean }) => {
      if (options.doctor) {
        const handler = await loadCliCommand('doctor');
        await handler({ json: false, fix: false });
        return;
      }
      if (options.exec) {
        const handler = await loadCliCommand('exec');
        await handler({ projectPath: options.project });
        return;
      }
      const handler = await loadCliCommand('tui');
      await handler({
        prompt: options.prompt,
        json: false,
        projectPath: options.project,
        mode: options.mode,
        web: options.web,
      });
    });

  // providers (no subcommand) → interactive menu
  cli.command('providers', 'Manage provider profiles interactively.').action(async () => {
    const handler = await loadCliCommand('providers');
    await handler({ action: 'interactive' });
  });

  cli
    .command('providers list', 'List configured provider profiles.')
    .option('--json', 'Print raw JSON output.')
    .action(async (options: ProvidersBaseOptions) => {
      const handler = await loadCliCommand('providers');
      await handler({ action: 'list', json: options.json ?? false });
    });

  cli
    .command('providers add <type> <label>', 'Create a provider profile with an API key.')
    .option('--base-url <url>', 'Override provider base URL.')
    .option('--api-key <key>', 'Attach API key.')
    .option('--model <model>', 'Set default model.')
    .option('--default', 'Make the new profile active by default.')
    .option('--header <key:value>', 'Extra header, can be repeated.', { default: [] })
    .action(async (type: string, label: string, options: ProvidersAddOptions) => {
      const handler = await loadCliCommand('providers');
      await handler({
        action: 'add',
        type,
        label,
        baseUrl: options.baseUrl,
        apiKey: options.apiKey,
        model: options.model,
        makeDefault: options.default ?? false,
        headers: options.header ?? [],
      });
    });

  cli
    .command(
      'providers connect [type]',
      'Connect via OAuth (e.g. openai-codex for ChatGPT Plus/Pro).',
    )
    .action(async (type: string | undefined) => {
      const handler = await loadCliCommand('providers');
      await handler({ action: 'connect', provider: type });
    });

  cli
    .command('providers use <id>', 'Set default provider profile and optionally model.')
    .option('--model <model>', 'Override the default model for this profile.')
    .action(async (id: string, options: ProvidersUseOptions) => {
      const handler = await loadCliCommand('providers');
      await handler({ action: 'use', id, model: options.model });
    });

  cli
    .command('providers models [id]', 'List models for a provider profile or the active provider.')
    .action(async (id: string | undefined) => {
      const handler = await loadCliCommand('providers');
      await handler({ action: 'models', id });
    });

  cli
    .command('models [id]', 'List models for a provider profile or the active provider.')
    .action(async (id: string | undefined) => {
      const handler = await loadCliCommand('providers');
      await handler({ action: 'models', id });
    });

  cli
    .command('providers test <id>', 'Test a provider profile connection.')
    .action(async (id: string) => {
      const handler = await loadCliCommand('providers');
      await handler({ action: 'test', id });
    });

  cli
    .command('providers catalog', 'Browse the model catalog.')
    .option('--json', 'Print raw JSON output.')
    .action(async (options: ProvidersBaseOptions) => {
      const handler = await loadCliCommand('providers');
      await handler({ action: 'catalog', json: options.json ?? false });
    });

  cli.command('providers remove <id>', 'Delete a provider profile.').action(async (id: string) => {
    const handler = await loadCliCommand('providers');
    await handler({ action: 'remove', id });
  });

  cli
    .command('permission [mode]', 'Choose permission mode: default or full.')
    .action(async (mode: string | undefined) => {
      const handler = await loadCliCommand('permission');
      await handler({
        mode,
      });
    });

  cli
    .command('context [directory]', 'Show Repo Map and context summary for a directory.')
    .action(async (directory: string | undefined) => {
      const handler = await loadCliCommand('context');
      await handler({
        directory,
      });
    });

  cli
    .command('usage [sub]', 'Show token and cost usage for the last request and session totals.')
    .action(async (sub: string | undefined) => {
      const handler = await loadCliCommand('usage');
      await handler(sub ? [sub] : []);
    });

  cli.command('trust list', 'List all trusted workspace paths.').action(async () => {
    const handler = await loadCliCommand('trust');
    await handler(['list']);
  });

  cli
    .command('trust remove <path>', 'Remove a path from the trusted workspace list.')
    .action(async (targetPath: string) => {
      const handler = await loadCliCommand('trust');
      await handler(['remove', targetPath]);
    });

  cli
    .command('exec [...task]', 'Run a task headlessly in exec (harness loop) mode.')
    .option('--project <path>', 'Target project path instead of current directory.')
    .option('--time <duration>', 'Time limit, e.g. 30m or 2h.')
    .action(async (task: string[], options: { project?: string; time?: string }) => {
      const handler = await loadCliCommand('exec');
      await handler({
        task: task.join(' ').trim(),
        projectPath: options.project,
        time: options.time,
      });
    });

  // Default command: umbra [flags]
  // umbra             → open TUI
  // umbra --exec      → autonomous mode (no confirmations)
  // umbra --debug     → debug monitor
  // umbra --doctor    → run diagnostics
  // umbra --prompt    → send single prompt
  // umbra --project   → set project path
  // umbra --mode      → agent | full | plan
  cli
    .command('', 'Open the Umbra terminal workspace.')
    .option('--exec', 'Autonomous mode — agent works without confirmation prompts.')
    .option('--debug', 'Open the debug monitor instead of the TUI.')
    .option('--doctor', 'Run environment diagnostics and exit.')
    .option('--prompt <text>', 'Send a single prompt and exit.')
    .option('--project <path>', 'Target project path instead of current directory.')
    .option('--mode <mode>', 'Permission mode: agent (default), full, plan.')
    .option('--web <mode>', 'Web search mode: off, on, cached, live.')
    .action(async (options: TuiOptions & { exec?: boolean; debug?: boolean }) => {
      if (options.doctor) {
        const handler = await loadCliCommand('doctor');
        await handler({ json: false, fix: false });
        return;
      }
      if (options.debug) {
        const handler = await loadCliCommand('debug');
        await handler({ intervalMs: undefined });
        return;
      }
      if (options.exec) {
        const handler = await loadCliCommand('exec');
        await handler({ projectPath: options.project });
        return;
      }
      const handler = await loadCliCommand('tui');
      await handler({
        prompt: options.prompt,
        json: false,
        projectPath: options.project,
        mode: options.mode,
        web: options.web,
      });
    });

  cli.help();
  cli.version('0.1.0');

  return cli;
}

export async function main(argv = process.argv): Promise<void> {
  const cli = createCli();
  await cli.parse(argv, { run: false });

  // If default command matched, check whether the first raw arg is an unrecognised subcommand.
  // CAC silently falls through to the default command when no named command matches,
  // so "umbra qwerty" would open the TUI without this guard.
  const matchedName = cli.matchedCommandName ?? '';
  if (matchedName === '') {
    const firstArg = argv[2];
    if (typeof firstArg === 'string' && !firstArg.startsWith('-')) {
      process.stderr.write(
        `Unknown command: ${firstArg}\nRun 'umbra --help' for a list of available commands.\n`,
      );
      process.exitCode = 1;
      return;
    }
  }

  const commandName = matchedName || 'tui';
  const startedAt = Date.now();

  writeDebugEvent({
    component: 'cli',
    level: 'info',
    message: 'command started',
    data: {
      command: commandName,
      args: argv.slice(2),
    },
  });

  try {
    await cli.runMatchedCommand();
    writeDebugEvent({
      component: 'cli',
      level: 'info',
      message: 'command finished',
      data: {
        command: commandName,
        durationMs: Date.now() - startedAt,
      },
    });
  } catch (error) {
    writeDebugEvent({
      component: 'cli',
      level: 'error',
      message: 'command failed',
      data: {
        command: commandName,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      },
    });
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Absorb fetch/network errors that fire after the TUI exits (e.g. ECONNABORTED when
  // daemon shuts down while the poll loop is still in flight).
  process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    const isNetworkNoise = /ECONNABORTED|ECONNREFUSED|ECONNRESET|fetch failed/i.test(msg);
    if (!isNetworkNoise) {
      console.error('Unhandled error:', msg);
      process.exitCode = 1;
    }
  });

  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
