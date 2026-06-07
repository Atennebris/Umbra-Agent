const path = require('node:path');
const { spawnSync } = require('node:child_process');
const config = require('./config.json');

const umbraRoot = __dirname;

/**
 * Find the first node executable that can actually load better-sqlite3.
 * This makes the daemon start correctly regardless of which node ABI
 * better-sqlite3 was compiled for, and regardless of which node the CLI
 * was invoked with (Cursor's v22 vs system NodeJS v25, etc.).
 */
function findCompatibleNode() {
  const candidates = [
    // Explicit override from CLI (still respected if set)
    process.env.UMBRA_PM2_NODE,
    // The node that's running this config evaluation (pnpm/pm2's node)
    process.execPath,
    // Generic fallback
    'node',
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      const probe = spawnSync(
        candidate,
        // Must instantiate Database to actually load the native .node binding.
        // A bare require() only loads the JS wrapper and defers native loading.
        ['-e', "new (require('better-sqlite3'))(':memory:'); process.exit(0)"],
        { cwd: umbraRoot, encoding: 'utf8', timeout: 6000, windowsHide: true },
      );
      if (probe.status === 0 && !probe.error) {
        return candidate;
      }
    } catch {
      // try next
    }
  }

  // Last resort
  return process.env.UMBRA_PM2_NODE || process.execPath;
}

const interpreter = findCompatibleNode();

module.exports = {
  apps: [
    {
      name: 'umbra-daemon',
      cwd: umbraRoot,
      script: path.join(umbraRoot, 'dist/core/daemon-entry.js'),
      interpreter,
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      // Prevent rapid crash-loop "light show" on Windows:
      // stop retrying after 5 crashes; require 3 s of uptime to count as healthy
      max_restarts: 5,
      min_uptime: 3000,
      // Hide the cmd window PM2 would otherwise flash for each fork on Windows
      windowsHide: true,
      watch: false,
      env: {
        UMBRA_DAEMON_HOST: config.daemon.host,
        UMBRA_DAEMON_PORT: String(config.daemon.port),
      },
    },
  ],
};
