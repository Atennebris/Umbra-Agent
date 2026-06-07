#!/usr/bin/env node
/**
 * Umbra CLI – global entry point shim.
 *
 * Works in two modes:
 *  1. Development / locally linked: invokes the TypeScript source via tsx.
 *  2. Production (after pnpm build): runs the compiled dist/cli/main.js directly.
 *
 * Install globally for local use:
 *   pnpm link --global        (from project root)
 *   → 'umbra' becomes available anywhere on the system.
 *
 * Or install the built package:
 *   pnpm build && npm install -g .
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Project root is one level up from bin/
const projectRoot = path.join(__dirname, '..');

// Prefer source (tsx) when available — no rebuild needed during development.
// Fall back to compiled dist only when src is absent (installed package).
const distEntry = path.join(projectRoot, 'dist', 'cli', 'main.js');
const srcEntry = path.join(projectRoot, 'src', 'cli', 'main.ts');

// Strip --debug from argv before passing to the CLI; track it separately.
const debugFlagIdx = process.argv.indexOf('--debug');
const debugMode = debugFlagIdx !== -1;
const withoutDebug = debugMode
  ? [...process.argv.slice(0, debugFlagIdx), ...process.argv.slice(debugFlagIdx + 1)]
  : process.argv;

// --project <path>  sets the working project path explicitly (useful when launching
// from a shortcut or a directory that isn't the target project).
let projectPathOverride = null;
const withoutProject = [];
for (let i = 0; i < withoutDebug.length; i++) {
  if (withoutDebug[i] === '--project' && i + 1 < withoutDebug.length) {
    projectPathOverride = withoutDebug[i + 1];
    i++; // skip the value
  } else {
    withoutProject.push(withoutDebug[i]);
  }
}

// --exec is passed through to cac/main.ts which routes it to exec-command (harness loop TUI).
// For headless one-shot runs: umbra exec "task"
const filteredArgv = withoutProject;

let childArgs;
let command;
const extraEnv = {};
if (projectPathOverride) {
  extraEnv.UMBRA_PROJECT_PATH = projectPathOverride;
}
if (debugMode) {
  extraEnv.UMBRA_DEBUG_SIDECAR = '1';
}

if (existsSync(srcEntry)) {
  // Development mode: run TypeScript source via tsx
  const require = createRequire(import.meta.url);

  // Try to use tsx/esm as a Node.js loader (preferred — no subprocess overhead).
  // tsx/esm is the correct ESM loader specifier, not the tsx CLI binary.
  let tsxEsmPath = null;
  try {
    tsxEsmPath = require.resolve('tsx/esm');
  } catch {
    // tsx not locally installed
  }

  if (tsxEsmPath) {
    // require.resolve returns an absolute OS path on all platforms.
    // --import on Windows requires a file:// URL; pathToFileURL handles that.
    const tsxUrl = pathToFileURL(tsxEsmPath).href;
    command = process.execPath;
    childArgs = ['--import', tsxUrl, srcEntry, ...filteredArgv.slice(2)];
  } else {
    // tsx not in node_modules — try spawning from PATH
    command = 'tsx';
    childArgs = [srcEntry, ...filteredArgv.slice(2)];
  }
} else if (existsSync(distEntry)) {
  // Installed package: run compiled JS directly with Node
  command = process.execPath;
  childArgs = [distEntry, ...filteredArgv.slice(2)];
} else {
  process.stderr.write(
    '[umbra] Neither dist/cli/main.js nor src/cli/main.ts found.\n' +
      'Run "pnpm build" (production) or ensure the source tree is intact.\n',
  );
  process.exit(1);
}

// When --debug accompanies a normal launch, open a separate sidecar console.
if (debugMode && process.platform === 'win32') {
  // Pass the entire command as one string with an empty args array so that:
  //  - shell: true handles quoting correctly (cmd /d /s /c "...")
  //  - DEP0190 is not triggered (it only fires when shell:true + non-empty args array)
  spawn('start "Umbra Debug" cmd /k umbra debug', [], {
    detached: true,
    shell: true,
    stdio: 'ignore',
  }).unref();
}

const child = spawn(command, childArgs, {
  stdio: 'inherit',
  env: { ...process.env, ...extraEnv },
  shell: false,
});

child.on('error', (err) => {
  process.stderr.write(`[umbra] Failed to start: ${err.message}\n`);
  process.exit(1);
});

const forwardSignal = (signal) => {
  if (child.killed) return;
  try {
    child.kill(signal);
  } catch {
    /* ignore */
  }
};

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => forwardSignal(sig));
}

const result = await new Promise((resolve) => {
  child.on('exit', (code, signal) => {
    if (signal) {
      resolve({ type: 'signal', signal });
    } else {
      resolve({ type: 'code', exitCode: code ?? 1 });
    }
  });
});

if (result.type === 'signal') {
  process.kill(process.pid, result.signal);
} else {
  process.exit(result.exitCode);
}
