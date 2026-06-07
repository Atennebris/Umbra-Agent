import { spawn } from 'node:child_process';

export type ProcessResult = {
  code: number;
  stdout: string;
  stderr: string;
};

export type RunProcessOptions = {
  env?: NodeJS.ProcessEnv;
};

export async function runProcess(
  command: string,
  args: string[],
  cwd = process.cwd(),
  options?: RunProcessOptions,
): Promise<ProcessResult> {
  const useCmdShim = process.platform === 'win32' && /\.cmd$/i.test(command);
  const child = spawn(
    useCmdShim ? process.env.ComSpec || 'cmd.exe' : command,
    useCmdShim ? ['/d', '/s', '/c', command, ...args] : args,
    {
      cwd,
      env: options?.env ? { ...process.env, ...options.env } : process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );

  let stdout = '';
  let stderr = '';

  child.stdout.on('data', (chunk: Buffer | string) => {
    stdout += chunk.toString();
  });

  child.stderr.on('data', (chunk: Buffer | string) => {
    stderr += chunk.toString();
  });

  return await new Promise<ProcessResult>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => {
      resolve({
        code: code ?? 1,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    });
  });
}

export function getPnpmCommand(): string {
  return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
}
