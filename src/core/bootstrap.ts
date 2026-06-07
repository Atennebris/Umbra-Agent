import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveTargetProjectPath } from '../utils/project-root.js';

export type BootstrapContext = {
  user: string;
  os: string;
  shell: string;
  nodeVersion: string;
  projectPath: string;
  hasGit: boolean;
  packageManager: 'npm' | 'pnpm' | 'yarn' | 'none';
};

export async function gatherBootstrapContext(
  projectPath = resolveTargetProjectPath(),
): Promise<BootstrapContext> {
  const isWindows = process.platform === 'win32';

  let packageManager: BootstrapContext['packageManager'] = 'none';
  if (fs.existsSync(path.join(projectPath, 'pnpm-lock.yaml'))) packageManager = 'pnpm';
  else if (fs.existsSync(path.join(projectPath, 'package-lock.json'))) packageManager = 'npm';
  else if (fs.existsSync(path.join(projectPath, 'yarn.lock'))) packageManager = 'yarn';

  return {
    user: os.userInfo().username,
    os: `${process.platform} ${os.release()}`,
    shell: process.env.SHELL || (isWindows ? 'powershell' : 'unknown'),
    nodeVersion: process.version,
    projectPath,
    hasGit: fs.existsSync(path.join(projectPath, '.git')),
    packageManager,
  };
}

export function renderBootstrapMarkdown(ctx: BootstrapContext): string {
  return [
    '# Platform Bootstrap Context',
    // Note: ctx.user is the OS account name (hostname), NOT the human's real name.
    // We intentionally omit it to prevent the agent from addressing the user by their PC name.
    `- **OS**: ${ctx.os}`,
    `- **Shell**: ${ctx.shell}`,
    `- **Node**: ${ctx.nodeVersion}`,
    `- **Project**: ${ctx.projectPath}`,
    `- **Git**: ${ctx.hasGit ? 'yes' : 'no'}`,
    `- **Package Manager**: ${ctx.packageManager}`,
  ].join('\n');
}
