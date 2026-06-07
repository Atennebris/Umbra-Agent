/**
 * Rebuild better-sqlite3 so its NODE_MODULE_VERSION matches the Node binary
 * PM2 uses for umbra-daemon (often older than the Node first on PATH).
 *
 * Usage (from repo root): node scripts/rebuild-better-sqlite-for-daemon-node.mjs
 * Or: pnpm rebuild:natives:match-daemon
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

function pm2List() {
  const r = spawnSync('pnpm', ['exec', 'pm2', 'jlist'], {
    cwd: projectRoot,
    encoding: 'utf8',
    shell: true,
    windowsHide: true,
  });
  if (r.status !== 0 || !r.stdout?.trim()) return [];
  try {
    const parsed = JSON.parse(r.stdout.trim());
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Resolve absolute path to Node.exe the daemon should use (same rule as ecosystem.config.cjs). */
function resolveDaemonNodeBinary() {
  const cliOverride = process.argv[2]?.trim();
  if (cliOverride && fs.existsSync(cliOverride)) {
    return path.resolve(cliOverride);
  }

  const fromEnv = process.env.UMBRA_PM2_NODE?.trim();
  if (fromEnv && path.isAbsolute(fromEnv) && fs.existsSync(fromEnv)) {
    return fromEnv;
  }

  const list = pm2List();
  const daemon = list.find((p) => p?.name === 'umbra-daemon');
  const interp = daemon?.pm2_env?.exec_interpreter;
  if (typeof interp === 'string' && path.isAbsolute(interp) && fs.existsSync(interp)) {
    return interp;
  }

  console.error(
    '[umbra] Could not read absolute exec_interpreter for umbra-daemon from pm2 jlist. Using current shell Node.',
  );
  console.error(
    '[umbra] If rebuild still mismatches, pass explicit path: node scripts/rebuild-better-sqlite-for-daemon-node.mjs "C:\\\\path\\\\to\\\\node.exe"',
  );
  return process.execPath;
}

const nodeBin = resolveDaemonNodeBinary();
const nodeDir = path.dirname(nodeBin);

const ver = spawnSync(nodeBin, ['-p', 'process.version'], {
  encoding: 'utf8',
  shell: true,
  windowsHide: true,
}).stdout?.trim();
const abi = spawnSync(nodeBin, ['-p', 'process.versions.modules'], {
  encoding: 'utf8',
  shell: true,
  windowsHide: true,
}).stdout?.trim();

console.error('[umbra] Rebuilding better-sqlite3 using Node first on PATH:');
console.error(`[umbra]   ${nodeBin}`);
console.error(`[umbra]   ${ver ?? '?'} (NODE_MODULE_VERSION ${abi ?? '?'})`);

const env = {
  ...process.env,
  PATH: `${nodeDir}${path.delimiter}${process.env.PATH ?? ''}`,
};

const rebuild = spawnSync('pnpm', ['rebuild', 'better-sqlite3'], {
  cwd: projectRoot,
  env,
  stdio: 'inherit',
  shell: true,
  windowsHide: true,
});

if ((rebuild.status ?? 1) !== 0) {
  console.error(
    '[umbra] rebuild failed. Install build tools (VS Build Tools on Windows) or align Node versions.',
  );
}

process.exit(rebuild.status ?? 1);
