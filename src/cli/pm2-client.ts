import { projectRoot } from '../utils/project-root.js';
import { getPnpmCommand, runProcess } from './process-runner.js';

/** PM2 runs relative to the Umbra package root so `ecosystem.config.cjs` resolves even when the user's shell cwd is elsewhere. */
const pm2Cwd = projectRoot;

/** Ensures ecosystem.config.cjs sees the same Node executable as this Umbra CLI process. */
function pm2Env(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    UMBRA_PM2_NODE: process.execPath,
  };
}

export type Pm2ActionResult = {
  ok: boolean;
  message: string;
};

export async function ensureDaemonWithPm2(): Promise<Pm2ActionResult> {
  let result = await runProcess(
    getPnpmCommand(),
    ['exec', 'pm2', 'restart', 'ecosystem.config.cjs', '--only', 'umbra-daemon', '--update-env'],
    pm2Cwd,
    { env: pm2Env() },
  );

  if (result.code !== 0) {
    result = await runProcess(
      getPnpmCommand(),
      ['exec', 'pm2', 'start', 'ecosystem.config.cjs', '--only', 'umbra-daemon', '--update-env'],
      pm2Cwd,
      { env: pm2Env() },
    );
  }

  if (result.code !== 0) {
    throw new Error(result.stderr || 'Failed to start the Umbra daemon through PM2.');
  }

  return {
    ok: true,
    message: result.stdout || 'Umbra daemon started.',
  };
}

export async function startDaemonWithPm2(): Promise<Pm2ActionResult> {
  const result = await runProcess(
    getPnpmCommand(),
    ['exec', 'pm2', 'start', 'ecosystem.config.cjs', '--only', 'umbra-daemon', '--update-env'],
    pm2Cwd,
    { env: pm2Env() },
  );

  if (result.code !== 0) {
    throw new Error(result.stderr || 'Failed to start the Umbra daemon through PM2.');
  }

  return {
    ok: true,
    message: result.stdout || 'Umbra daemon started.',
  };
}

export async function stopDaemonWithPm2(): Promise<Pm2ActionResult> {
  const result = await runProcess(
    getPnpmCommand(),
    ['exec', 'pm2', 'delete', 'umbra-daemon'],
    pm2Cwd,
    { env: pm2Env() },
  );

  if (result.code !== 0) {
    throw new Error(result.stderr || 'Failed to stop the Umbra daemon through PM2.');
  }

  return {
    ok: true,
    message: result.stdout || 'Umbra daemon stopped.',
  };
}

export async function readPm2ProcessList(): Promise<unknown[]> {
  let result: Awaited<ReturnType<typeof runProcess>>;

  try {
    result = await runProcess(getPnpmCommand(), ['exec', 'pm2', 'jlist'], pm2Cwd, {
      env: pm2Env(),
    });
  } catch {
    return [];
  }

  if (result.code !== 0) {
    return [];
  }

  if (!result.stdout) {
    return [];
  }

  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
