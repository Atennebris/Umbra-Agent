import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { getMemoryManager, resolveRuntimeLayout } from '../memory/index.js';
import { getWebSearchSettings } from '../tools/index.js';
import { loadConfig } from '../utils/config.js';
import { projectRoot } from '../utils/project-root.js';
import { getStatus } from './http-client.js';
import { readPm2ProcessList } from './pm2-client.js';

export type DoctorItemStatus = 'pass' | 'warn' | 'fail' | 'fixed';

export type DoctorItem = {
  name: string;
  status: DoctorItemStatus;
  detail: string;
};

export type DoctorReport = {
  ok: boolean;
  appliedFixes: string[];
  items: DoctorItem[];
};

type DoctorOptions = {
  fix: boolean;
};

export async function runDoctor(options: DoctorOptions): Promise<DoctorReport> {
  const appliedFixes: string[] = [];
  const items: DoctorItem[] = [];
  const config = loadConfig();

  items.push(await checkWorkspaceAccess(options.fix, appliedFixes));
  items.push(await checkMemoryRoot(options.fix, appliedFixes));
  items.push(await checkBetterSqliteNativeUnderCliNode());
  items.push(await checkPortAvailability(config.daemon.host, config.daemon.port));
  items.push(await checkPm2Status());
  items.push(await checkDaemonHealth());
  items.push(await checkSqlitePreparation());
  items.push(checkWebSearchConfiguration());

  return {
    ok: items.every((item) => item.status === 'pass' || item.status === 'fixed'),
    appliedFixes,
    items,
  };
}

function checkWebSearchConfiguration(): DoctorItem {
  const settings = getWebSearchSettings();
  const active = settings.availableProviders.find(
    (provider) => provider.id === settings.providerId,
  );

  if (!active) {
    return {
      name: 'Web search provider',
      status: 'fail',
      detail: 'No web search provider registry entry is available.',
    };
  }

  if (!active.configured) {
    return {
      name: 'Web search provider',
      status: settings.enabled ? 'fail' : 'warn',
      detail: `${active.label} is selected but not configured. Set its API key env var or update ~/.umbra/settings.json.`,
    };
  }

  return {
    name: 'Web search provider',
    status: 'pass',
    detail: `${active.label} is configured (${settings.mode} mode, ${active.authSource} auth, ${active.baseUrl}).`,
  };
}

async function checkWorkspaceAccess(fix: boolean, appliedFixes: string[]): Promise<DoctorItem> {
  const probePath = path.join(process.cwd(), '.umbra-doctor-write-test');

  try {
    await fs.writeFile(probePath, 'ok', 'utf8');
    await fs.rm(probePath, { force: true });
    return {
      name: 'Workspace filesystem',
      status: 'pass',
      detail: 'Current working directory is readable and writable.',
    };
  } catch (error) {
    if (fix) {
      appliedFixes.push(
        'Skipped workspace repair because permissions cannot be elevated automatically.',
      );
    }

    return {
      name: 'Workspace filesystem',
      status: 'fail',
      detail: getErrorMessage(error),
    };
  }
}

async function checkMemoryRoot(fix: boolean, appliedFixes: string[]): Promise<DoctorItem> {
  const memoryRoot = path.join(os.homedir(), '.umbra');

  try {
    await fs.mkdir(memoryRoot, { recursive: true });

    if (fix) {
      appliedFixes.push(`Ensured memory root exists at ${memoryRoot}`);
      return {
        name: 'Umbra memory root',
        status: 'fixed',
        detail: `Verified or created ${memoryRoot}.`,
      };
    }

    return {
      name: 'Umbra memory root',
      status: 'pass',
      detail: `${memoryRoot} is ready.`,
    };
  } catch (error) {
    return {
      name: 'Umbra memory root',
      status: 'fail',
      detail: getErrorMessage(error),
    };
  }
}

async function checkPortAvailability(host: string, port: number): Promise<DoctorItem> {
  const available = await isPortAvailable(host, port);

  return available
    ? {
        name: 'Daemon port',
        status: 'pass',
        detail: `${host}:${port} is available for the daemon.`,
      }
    : {
        name: 'Daemon port',
        status: 'warn',
        detail: `${host}:${port} is already occupied. This is fine when the daemon is already running.`,
      };
}

async function checkDaemonHealth(): Promise<DoctorItem> {
  try {
    const status = (await getStatus()) as { ok?: boolean; queueDepth?: number };

    if (status.ok) {
      return {
        name: 'Daemon health',
        status: 'pass',
        detail: `Daemon responded successfully. Queue depth: ${status.queueDepth ?? 0}.`,
      };
    }
  } catch (error) {
    const processes = await readPm2ProcessList();
    const pm2Daemon = processes.find((entry) => {
      const candidate = entry as { name?: unknown };
      return candidate.name === 'umbra-daemon';
    }) as { pm2_env?: { status?: string } } | undefined;
    const pm2Online = pm2Daemon?.pm2_env?.status === 'online';
    const hint = pm2Online
      ? ' PM2 shows the daemon as online but the HTTP endpoint failed — often this loop-crashing daemon needs `pnpm rebuild better-sqlite3` under ONE fixed Node version, then `pm2 delete umbra-daemon` and start Umbra again so ecosystem picks up `UMBRA_PM2_NODE`.'
      : '';

    return {
      name: 'Daemon health',
      status: pm2Online ? 'fail' : 'warn',
      detail: `Daemon health endpoint is not reachable: ${getErrorMessage(error)}.${hint}`,
    };
  }

  return {
    name: 'Daemon health',
    status: 'warn',
    detail: 'Daemon returned an unexpected payload.',
  };
}

async function checkPm2Status(): Promise<DoctorItem> {
  const processes = await readPm2ProcessList();
  const daemon = processes.find((entry) => {
    const candidate = entry as { name?: unknown };
    return candidate.name === 'umbra-daemon';
  }) as { pm2_env?: { status?: string } } | undefined;

  if (!daemon) {
    return {
      name: 'PM2 process',
      status: 'warn',
      detail: 'PM2 does not currently list umbra-daemon.',
    };
  }

  const detail = `umbra-daemon PM2 state: ${daemon.pm2_env?.status ?? 'unknown'}. (States "online" while HTTP fails usually mean the process crashes and respawns - check SQLite/native ABI.)`;

  return {
    name: 'PM2 process',
    status: daemon.pm2_env?.status === 'online' ? 'pass' : 'warn',
    detail,
  };
}

async function checkBetterSqliteNativeUnderCliNode(): Promise<DoctorItem> {
  const nodeBin = process.execPath;
  const abi = process.versions.modules;
  const ver = process.version;

  const probe = spawnSync(nodeBin, ['-e', "require('better-sqlite3')"], {
    cwd: projectRoot,
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
  });

  if (probe.status === 0) {
    return {
      name: 'better-sqlite3 native',
      status: 'pass',
      detail: `Addon loads under this CLI Node (${ver}, NODE_MODULE_VERSION ${abi}). The daemon should use the same binary via UMBRA_PM2_NODE.`,
    };
  }

  const stderr = (probe.stderr || '').trim();
  return {
    name: 'better-sqlite3 native',
    status: 'fail',
    detail: `Addon fails under Node ${ver} (${abi}). ${stderr.slice(0, 320)}\nFix from Umbra folder: pnpm rebuild better-sqlite3`,
  };
}

async function checkSqlitePreparation(): Promise<DoctorItem> {
  try {
    const manager = getMemoryManager();
    const status = manager.getStatus();
    const layout = resolveRuntimeLayout();

    return {
      name: 'SQLite readiness',
      status: 'pass',
      detail: `Database ready at ${status.databasePath}; vector backend ${status.vectorBackend}; model ${status.model}; cache ${layout.transformersCacheDir}; ready=${String(status.modelReady)}.`,
    };
  } catch (error) {
    return {
      name: 'SQLite readiness',
      status: 'fail',
      detail: getErrorMessage(error),
    };
  }
}

async function isPortAvailable(host: string, port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const server = net.createServer();

    server.once('error', () => {
      resolve(false);
    });

    server.once('listening', () => {
      server.close(() => resolve(true));
    });

    server.listen(port, host);
  });
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
