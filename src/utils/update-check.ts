import { createRequire } from 'node:module';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const _require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function getCurrentVersion(): string {
  try {
    const pkg = _require(path.resolve(__dirname, '../../package.json')) as { version: string };
    return pkg.version;
  } catch {
    return '0.0.0';
  }
}

function parseVersion(v: string): [number, number, number] {
  const parts = v.replace(/^v/, '').split('.').map(Number);
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

function isNewer(remote: string, local: string): boolean {
  const [rMaj, rMin, rPat] = parseVersion(remote);
  const [lMaj, lMin, lPat] = parseVersion(local);
  if (rMaj !== lMaj) return rMaj > lMaj;
  if (rMin !== lMin) return rMin > lMin;
  return rPat > lPat;
}

export type UpdateCheckResult =
  | { available: true; current: string; latest: string }
  | { available: false };

function askUpdatePrompt(current: string, latest: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    process.stdout.write(
      `\n  ┌──────────────────────────────────────────────────────┐\n  │  Update available  ${current} → ${latest}\n  │  Run: npm install -g umbra-agent\n  └──────────────────────────────────────────────────────┘\n\n  Update now and restart? [Y/n] `,
    );
    rl.once('line', (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() !== 'n');
    });
  });
}

export async function promptAndUpdate(current: string, latest: string): Promise<void> {
  const yes = await askUpdatePrompt(current, latest);
  if (!yes) {
    process.stdout.write('  Continuing with current version.\n\n');
    return;
  }

  const { spawnSync, spawn } = await import('node:child_process');
  process.stdout.write('\n  Installing update...\n\n');

  const result = spawnSync('npm', ['install', '-g', 'umbra-agent'], {
    stdio: 'inherit',
    shell: true,
  });

  if (result.status === 0) {
    process.stdout.write('\n  Update installed. Restarting...\n\n');
    const execPath = process.execPath;
    const args = process.argv.slice(1);
    spawn(execPath, args, { stdio: 'inherit', detached: false });
    process.exit(0);
  } else {
    process.stdout.write('\n  Update failed. Continuing with current version.\n\n');
  }
}

export async function checkForUpdate(timeoutMs = 4000): Promise<UpdateCheckResult> {
  const current = getCurrentVersion();

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const res = await fetch('https://registry.npmjs.org/umbra-agent/latest', {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });

    clearTimeout(timer);

    if (!res.ok) return { available: false };

    const data = (await res.json()) as { version?: string };
    const latest = data.version ?? '';

    if (latest && isNewer(latest, current)) {
      return { available: true, current, latest };
    }

    return { available: false };
  } catch {
    return { available: false };
  }
}
