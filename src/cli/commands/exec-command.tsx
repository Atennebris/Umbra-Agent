import { render } from 'ink';
import React from 'react';
import type { RunTaskPayload } from '../../core/contracts.js';
import { getLastProjectPath, saveLastProjectPath } from '../../core/runtime-preferences.js';
import { resolveTargetProjectPath } from '../../utils/project-root.js';
import type { CliCommandHandler } from '../command-types.js';
import { createRun, getRun, waitForDaemonReady } from '../http-client.js';
import { ensureDaemonWithPm2, stopDaemonWithPm2 } from '../pm2-client.js';
import { renderUmbraSplash } from '../tui/frame.js';
import { UmbraInkApp } from '../tui/ink-app.js';
import { buildBannerFlags } from './tui-command.js';

type ExecCommandInput = {
  /** If provided, run headless harness loop for this task and exit. */
  task?: string;
  projectPath?: string;
  time?: string;
};

function parseTimeLimitMs(time: string | undefined): number | undefined {
  if (!time) return undefined;
  const m = /^(\d+)(m|h|s)?$/.exec(time.trim().toLowerCase());
  if (!m) return undefined;
  const n = Number(m[1]);
  if (m[2] === 'h') return n * 60 * 60 * 1000;
  if (m[2] === 's') return n * 1000;
  return n * 60 * 1000; // default: minutes
}

// Opens the TUI in exec mode — agent runs harness loop autonomously.
export const runExecCommand: CliCommandHandler = async (input) => {
  const { task, projectPath, time } = input as ExecCommandInput;
  const targetProjectPath = resolveTargetProjectPath(projectPath, getLastProjectPath);
  saveLastProjectPath(targetProjectPath);

  try {
    await ensureDaemonWithPm2();
    await waitForDaemonReady(10_000);
  } catch (cause: unknown) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    process.stderr.write(`[umbra] Could not start daemon (PM2): ${msg}\n`);
    process.stderr.write('[umbra] Try: umbra start    (from this Umbra install)\n');
    if (task) {
      process.exitCode = 1;
      return;
    }
  }

  // --- Headless mode: umbra exec "task text" ---
  if (task) {
    await runHeadlessExec(task, targetProjectPath, parseTimeLimitMs(time));
    await stopDaemonWithPm2().catch(() => {});
    return;
  }

  // --- Interactive TUI exec mode: umbra --exec ---
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log(renderUmbraSplash());
    console.log('Use `umbra exec "task"` for non-interactive execution.');
    return;
  }

  // initialMode='exec' → runtimeMode='exec' in TUI → daemon receives mode:'exec' (harness loop)
  const app = render(
    <UmbraInkApp
      projectPath={targetProjectPath}
      initialMode="exec"
      launchFlags={buildBannerFlags('exec', undefined, process.env.UMBRA_DEBUG_SIDECAR === '1')}
    />,
  );
  await app.waitUntilExit();
  await stopDaemonWithPm2().catch(() => {});
};

async function runHeadlessExec(
  task: string,
  projectPath: string,
  timeLimitMs?: number,
): Promise<void> {
  const ansi = {
    reset: '[0m',
    yellow: '[33m',
    green: '[32m',
    red: '[31m',
    cyan: '[36m',
    gray: '[90m',
    bold: '[1m',
  };

  process.stdout.write(
    `${ansi.yellow}[ EXEC ] ${ansi.bold}${task}${ansi.reset}\n` +
      `${ansi.gray}project: ${projectPath}${ansi.reset}\n\n`,
  );

  let run: RunTaskPayload;
  try {
    run = (await createRun({
      prompt: task,
      mode: 'exec',
      projectPath,
      ...(timeLimitMs ? { timeLimitMs } : {}),
    })) as RunTaskPayload;
  } catch (err) {
    process.stderr.write(
      `${ansi.red}[umbra] Failed to create run: ${err instanceof Error ? err.message : String(err)}${ansi.reset}\n`,
    );
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`${ansi.gray}run id: ${run.id}${ansi.reset}\n`);

  // Poll for completion, printing new events as they arrive.
  const seenEventIds = new Set<string>();
  let lastStatus = run.status;

  const printNewEvents = (payload: RunTaskPayload): void => {
    for (const event of payload.events ?? []) {
      if (seenEventIds.has(event.id)) continue;
      seenEventIds.add(event.id);
      renderHeadlessEvent(event, ansi);
    }
  };

  printNewEvents(run);

  while (lastStatus === 'running' || lastStatus === 'queued') {
    await sleep(1_000);
    try {
      run = (await getRun(run.id)) as RunTaskPayload;
    } catch {
      continue;
    }
    lastStatus = run.status;
    printNewEvents(run);
  }

  // Final result
  const result = run.result;
  if (run.status === 'completed') {
    if (result?.check) {
      const checkColor = result.check.exitCode === 0 ? ansi.green : ansi.red;
      process.stdout.write(`\n${checkColor}[ check ] exit ${result.check.exitCode}${ansi.reset}\n`);
    }
    if (result?.commit) {
      process.stdout.write(
        `${ansi.green}[ commit ] ${result.commit.commitHash.slice(0, 8)} ${result.commit.message}${ansi.reset}\n`,
      );
    }
    process.stdout.write(`\n${ansi.green}${ansi.bold}✓ Done${ansi.reset}\n`);
  } else {
    const errMsg = run.lastError ?? 'unknown error';
    process.stderr.write(`\n${ansi.red}✗ Run failed: ${errMsg}${ansi.reset}\n`);
    process.exitCode = 1;
  }
}

function renderHeadlessEvent(
  event: { type: string; payload: Record<string, unknown> },
  ansi: Record<string, string>,
): void {
  const { type, payload } = event;

  if (type === 'status') {
    const phase = payload.phase as string | undefined;
    if (phase === 'thinking') {
      process.stdout.write(`${ansi.gray}  thinking...${ansi.reset}\n`);
    } else if (phase === 'harness_retry') {
      const attempt = payload.attempt as number | undefined;
      process.stdout.write(
        `${ansi.yellow}  harness retry #${attempt ?? '?'} — check failed, retrying${ansi.reset}\n`,
      );
    }
    return;
  }

  if (type === 'command') {
    const phase = payload.phase as string | undefined;
    const cmd = payload.command as string | undefined;
    if (phase === 'started') {
      process.stdout.write(`${ansi.cyan}  $ ${cmd}${ansi.reset}\n`);
    } else if (phase === 'finished') {
      const exitCode = payload.exitCode as number | undefined;
      const stdout = (payload.stdout as string | undefined)?.trim();
      const stderr = (payload.stderr as string | undefined)?.trim();
      const color = exitCode === 0 ? ansi.green : ansi.red;
      process.stdout.write(`${color}  exit ${exitCode ?? '?'}${ansi.reset}\n`);
      if (stdout) process.stdout.write(`${ansi.gray}${stdout}${ansi.reset}\n`);
      if (stderr) process.stderr.write(`${ansi.red}${stderr}${ansi.reset}\n`);
    }
    return;
  }

  if (type === 'tool_call_started') {
    const name = payload.name as string | undefined;
    process.stdout.write(`${ansi.gray}  tool: ${name}${ansi.reset}\n`);
    return;
  }

  if (type === 'assistant_message') {
    const text = payload.text as string | undefined;
    if (text) {
      process.stdout.write(`\n${ansi.cyan}Umbra:${ansi.reset} ${text.trim()}\n`);
    }
    return;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
