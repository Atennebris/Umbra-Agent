import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const umbraRoot = path.resolve(__dirname, '..');

function findCompatibleNode() {
  const candidates = [
    process.env.UMBRA_PM2_NODE,
    process.execPath,
    'C:\\Soft\\NodeJS\\node.exe',
    'c:\\Soft\\cursor\\resources\\app\\resources\\helpers\\node.exe',
    'node',
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      const probe = spawnSync(
        candidate,
        // Must instantiate Database to actually load the native .node binding.
        [
          '-e',
          "import { createRequire } from 'module'; const req = createRequire(import.meta.url); new (req('better-sqlite3'))(':memory:'); process.exit(0)",
        ],
        { cwd: umbraRoot, encoding: 'utf8', timeout: 6000, windowsHide: true },
      );
      if (probe.status === 0 && !probe.error) {
        return candidate;
      }
    } catch {
      // try next
    }
  }

  return process.env.UMBRA_PM2_NODE || process.execPath;
}

const nodeCmd = findCompatibleNode();
const args = [
  path.join(__dirname, 'run-vitest.mjs'),
  'run',
  '--environment',
  'node',
  '--pool=threads',
];

const result = spawnSync(nodeCmd, args, {
  cwd: umbraRoot,
  stdio: 'inherit',
});

process.exit(result.status ?? 1);
