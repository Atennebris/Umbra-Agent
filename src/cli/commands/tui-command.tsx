import { render } from 'ink';
import React from 'react';
import type { WebSearchSettingsUpdatePayload } from '../../core/contracts.js';
import { getLastProjectPath, saveLastProjectPath } from '../../core/runtime-preferences.js';
import { resolveTargetProjectPath } from '../../utils/project-root.js';
import { checkForUpdate, promptAndUpdate } from '../../utils/update-check.js';
import type { CliCommandHandler } from '../command-types.js';
import {
  getStatus,
  postTask,
  updateWebSearchSettings,
  waitForDaemonReady,
} from '../http-client.js';
import { ensureDaemonWithPm2, stopDaemonWithPm2 } from '../pm2-client.js';
import { scaffoldProjectInstructions } from '../scaffold.js';
import { parseDroppedPaths } from '../tui/drop-paths.js';
import { parseFileReferences } from '../tui/file-references.js';
import { renderKeyValueCard, renderUmbraSplash } from '../tui/frame.js';
import { imageFileToBase64 } from '../tui/image-base64.js';
import { UmbraInkApp } from '../tui/ink-app.js';
import { renderMarkdownToAnsi } from '../tui/markdown.js';
import { StartupLoader } from '../tui/startup-loader.js';

type TuiCommandInput = {
  prompt?: string;
  json: boolean;
  projectPath?: string;
  mode?: string;
  web?: string;
};

export const runTuiCommand: CliCommandHandler = async (input) => {
  const { prompt, json, projectPath, mode, web } = input as TuiCommandInput;
  const targetProjectPath = resolveTargetProjectPath(projectPath, getLastProjectPath);
  const startupWebMode = resolveStartupWebSearchMode(web);

  // Persist the resolved project path so future launches from system dirs can fall back to it.
  saveLastProjectPath(targetProjectPath);

  // Check for updates in the background — don't block startup.
  const updatePromise = checkForUpdate(4000);

  const isInteractive = process.stdin.isTTY && process.stdout.isTTY && !prompt;

  let daemonReady = false;
  let loader: StartupLoader | null = null;

  if (isInteractive) {
    loader = new StartupLoader([
      {
        id: 'daemon',
        name: 'daemon',
        runningText: 'starting via PM2…',
        doneText: 'online',
        errorText: 'start failed',
      },
      {
        id: 'connection',
        name: 'connection',
        runningText: 'waiting for response…',
        doneText: 'ready',
        errorText: 'timed out',
      },
      {
        id: 'workspace',
        name: 'workspace',
        runningText: 'initializing…',
        doneText: 'ready',
      },
    ]);
    loader.start();
  }

  let daemonPm2Ok = false;
  try {
    loader?.begin('daemon');
    await ensureDaemonWithPm2();
    daemonPm2Ok = true;
    loader?.complete('daemon');

    loader?.begin('connection');
    await waitForDaemonReady(10_000);
    loader?.complete('connection');
    daemonReady = true;
  } catch (cause: unknown) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    if (loader) {
      loader.complete(daemonPm2Ok ? 'connection' : 'daemon', false);
      await new Promise<void>((r) => setTimeout(r, 700));
      loader.dismiss();
      loader = null;
    }
    process.stderr.write(`[umbra] Could not start daemon (PM2): ${msg}\n`);
    process.stderr.write('[umbra] Try: umbra start    (from this Umbra install)\n');
  }

  if (loader && daemonReady) {
    loader.begin('workspace');
    if (startupWebMode !== undefined) {
      await updateWebSearchSettings({ mode: startupWebMode });
    }
    loader.complete('workspace');
    await new Promise<void>((r) => setTimeout(r, 350));
    loader.dismiss();
    loader = null;
  } else {
    if (loader) {
      loader.dismiss();
      loader = null;
    }
    if (startupWebMode !== undefined) {
      await updateWebSearchSettings({ mode: startupWebMode });
    }
  }

  if (prompt) {
    await handlePrompt(prompt, json, targetProjectPath);
    return;
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log(renderUmbraSplash());
    console.log(
      renderMarkdownToAnsi(
        'Use `umbra tui --prompt "/status"` or `umbra task add "<task>"` when no interactive TTY is available.',
      ),
    );
    return;
  }

  if (!daemonReady) {
    process.stderr.write('[umbra] Daemon did not respond in time. Run `umbra start` first.\n');
    return;
  }

  // Show update prompt if a newer version is available.
  const updateResult = await updatePromise;
  if (updateResult.available) {
    await promptAndUpdate(updateResult.current, updateResult.latest);
  }

  const initialMode = normalizeInitialMode(mode);
  const launchFlags = buildBannerFlags(
    mode,
    startupWebMode,
    process.env.UMBRA_DEBUG_SIDECAR === '1',
  );
  const app = render(
    <UmbraInkApp
      projectPath={targetProjectPath}
      {...(initialMode !== undefined ? { initialMode } : {})}
      {...(launchFlags.length > 0 ? { launchFlags } : {})}
    />,
  );
  await app.waitUntilExit();
  await stopDaemonWithPm2().catch(() => {});
};

function normalizeInitialMode(mode: string | undefined): 'agent' | 'full' | 'plan' | undefined {
  if (mode === 'exec' || mode === 'full') return 'full';
  if (mode === 'plan') return 'plan';
  if (mode === 'agent') return 'agent';
  return undefined;
}

export function buildLaunchFlags(
  mode: string | undefined,
  webMode: WebSearchSettingsUpdatePayload['mode'] | undefined,
): string[] {
  const flags: string[] = [];
  if (mode === 'full' || mode === 'exec') {
    flags.push('[ --mode full ]  all tools allowed without confirmation');
  } else if (mode === 'plan') {
    flags.push('[ --mode plan ]  plan only, no execution');
  } else if (mode === 'agent') {
    flags.push('[ --mode agent ]  agent mode (default)');
  }
  if (webMode === 'cached' || webMode === 'live') {
    flags.push(`[ --web ${webMode} ]  web search enabled`);
  }
  return flags;
}

export function buildBannerFlags(
  mode: string | undefined,
  webMode: WebSearchSettingsUpdatePayload['mode'] | undefined,
  debugSidecar = false,
): string[] {
  const flags: string[] = [];
  if (mode === 'exec') {
    flags.push('[ --exec ] autonomous edit/run/check/fix without confirmations');
  } else if (mode === 'full') {
    flags.push('[ --mode full ] full tool access without confirmations');
  } else if (mode === 'plan') {
    flags.push('[ --mode plan ] planning only, no tool execution');
  } else if (mode === 'agent') {
    flags.push('[ --mode agent ] agent mode (default)');
  }

  if (debugSidecar) {
    flags.push('[ --debug ] debug monitor sidecar active');
  }

  if (webMode === 'cached' || webMode === 'live') {
    flags.push(`[ --web ${webMode} ] web search enabled`);
  }

  return flags;
}

export function resolveStartupWebSearchMode(
  optionMode?: string,
  envMode = process.env.UMBRA_WEB_SEARCH_MODE,
): WebSearchSettingsUpdatePayload['mode'] | undefined {
  if (typeof optionMode === 'string' && optionMode.trim().length > 0) {
    return normalizeWebMode(optionMode, '--web');
  }

  if (typeof envMode === 'string' && envMode.trim().length > 0) {
    return normalizeWebMode(envMode, 'UMBRA_WEB_SEARCH_MODE');
  }

  return undefined;
}

function normalizeWebMode(
  rawMode: string,
  source: '--web' | 'UMBRA_WEB_SEARCH_MODE',
): WebSearchSettingsUpdatePayload['mode'] {
  const normalized = rawMode.trim().toLowerCase();

  switch (normalized) {
    case 'off':
      return 'off';
    case 'on':
    case 'cached':
      return 'cached';
    case 'live':
      return 'live';
    default:
      throw new Error(
        `Unsupported ${source} value "${rawMode}". Use one of: off, on, cached, live.`,
      );
  }
}

async function handlePrompt(prompt: string, json: boolean, projectPath: string): Promise<void> {
  const droppedPaths = parseDroppedPaths(prompt);
  const fileReferences = parseFileReferences(prompt);

  if (prompt === '/init') {
    const result = await scaffoldProjectInstructions(projectPath, { force: false });
    console.log(result.summary);
    return;
  }

  if (prompt === '/status') {
    const status = await getStatus();

    if (json) {
      console.log(JSON.stringify(status, null, 2));
      return;
    }

    const statusRecord = status as Record<string, unknown>;

    console.log(
      renderKeyValueCard('Umbra Session Status', [
        ['Daemon', statusRecord.ok === true ? 'online' : 'offline'],
        ['Host', String(statusRecord.host ?? 'unknown')],
        ['Port', String(statusRecord.port ?? 'unknown')],
        ['Queue depth', String(statusRecord.queueDepth ?? '0')],
      ]),
    );
    return;
  }

  const imageAttachments = await Promise.all(
    droppedPaths
      .filter((filePath) => /\.(png|jpe?g|webp|gif|bmp)$/i.test(filePath))
      .map(async (filePath) => {
        const image = await imageFileToBase64(filePath);
        return {
          path: filePath,
          mimeType: image.mimeType,
          base64Length: image.data.length,
        };
      }),
  );

  const result = await postTask({
    task: prompt,
    context: {
      projectPath,
      droppedPaths,
      fileReferences,
      imageAttachments,
    },
  });

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const taskRecord = result as Record<string, unknown>;

  console.log(
    renderKeyValueCard('Umbra Dispatch', [
      ['Task', String(taskRecord.task ?? prompt)],
      ['Status', String(taskRecord.status ?? 'accepted')],
      ['Attachments', String(droppedPaths.length)],
      ['Images', String(imageAttachments.length)],
      ['File refs', String(fileReferences.length)],
    ]),
  );
}
