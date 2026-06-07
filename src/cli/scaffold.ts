import fs from 'node:fs/promises';
import path from 'node:path';

type ScaffoldOptions = {
  force: boolean;
};

type PackageScripts = {
  test?: string;
  lint?: string;
  build?: string;
};

export type ScaffoldResult = {
  summary: string;
};

export async function scaffoldProjectInstructions(
  targetDir: string,
  options: ScaffoldOptions,
): Promise<ScaffoldResult> {
  await fs.mkdir(targetDir, { recursive: true });

  const packageScripts = await readPackageScripts(targetDir);
  const agentsPath = path.join(targetDir, 'AGENTS.md');
  const checkShPath = path.join(targetDir, 'check.sh');
  const checkPs1Path = path.join(targetDir, 'check.ps1');

  const outcomes = [
    await writeAgentsFile(
      agentsPath,
      createAgentsTemplate(targetDir, packageScripts),
      options.force,
    ),
    await writeScaffoldFile(checkShPath, createCheckSh(packageScripts), options.force),
    await writeScaffoldFile(checkPs1Path, createCheckPs1(packageScripts), options.force),
  ];

  return {
    summary: `Scaffolded ${outcomes.join(', ')} in ${targetDir}`,
  };
}

async function writeAgentsFile(filePath: string, content: string, force: boolean): Promise<string> {
  if (!force && (await fileExists(filePath))) {
    const existing = await fs.readFile(filePath, 'utf8');
    await fs.writeFile(filePath, mergeAgentsContent(existing, content), 'utf8');
    return 'AGENTS.md (updated in place)';
  }

  await fs.writeFile(filePath, content, 'utf8');
  return 'AGENTS.md';
}

async function writeScaffoldFile(
  filePath: string,
  content: string,
  force: boolean,
): Promise<string> {
  if (!force && (await fileExists(filePath))) {
    return `${path.basename(filePath)} (kept existing)`;
  }

  await fs.writeFile(filePath, content, 'utf8');
  return path.basename(filePath);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readPackageScripts(targetDir: string): Promise<PackageScripts> {
  const packageJsonPath = path.join(targetDir, 'package.json');

  if (!(await fileExists(packageJsonPath))) {
    return {};
  }

  const raw = await fs.readFile(packageJsonPath, 'utf8');
  const parsed = JSON.parse(raw) as {
    scripts?: Record<string, string>;
  };

  const scripts: PackageScripts = {};

  if (parsed.scripts?.test) {
    scripts.test = parsed.scripts.test;
  }

  if (parsed.scripts?.lint) {
    scripts.lint = parsed.scripts.lint;
  }

  if (parsed.scripts?.build) {
    scripts.build = parsed.scripts.build;
  }

  return scripts;
}

function createAgentsTemplate(targetDir: string, scripts: PackageScripts): string {
  const projectName = path.basename(targetDir);
  const commandHints = [
    scripts.test
      ? `- Test: \`${scripts.test}\``
      : '- Test: define a stable test command before large changes.',
    scripts.lint
      ? `- Lint: \`${scripts.lint}\``
      : '- Lint: add a repeatable lint command when the stack is finalized.',
    scripts.build
      ? `- Build: \`${scripts.build}\``
      : '- Build: add a release build command when the toolchain is finalized.',
  ].join('\n');

  return `# ${projectName}

## Working Rules
- Read the current repository structure before changing architecture.
- Keep patches focused and production-oriented.
- Preserve existing command names and user-facing workflows unless the task explicitly changes them.

## Verification
${commandHints}
- Run the relevant checks before closing the task and report exact blockers if the environment prevents execution.

## Context
- Document only the non-obvious architecture or workflow details that future agent sessions will need.
- Prefer concise instructions over narrative prose.
`;
}

function mergeAgentsContent(existing: string, generated: string): string {
  const markerStart = '<!-- umbra:init:start -->';
  const markerEnd = '<!-- umbra:init:end -->';
  const generatedBlock = `${markerStart}\n${generated.trim()}\n${markerEnd}`;

  if (existing.includes(markerStart) && existing.includes(markerEnd)) {
    return existing.replace(
      new RegExp(`${escapeRegex(markerStart)}[\\s\\S]*?${escapeRegex(markerEnd)}`, 'm'),
      generatedBlock,
    );
  }

  const trimmed = existing.trimEnd();
  return `${trimmed}\n\n${generatedBlock}\n`;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function createCheckSh(scripts: PackageScripts): string {
  const commands = [scripts.test, scripts.build, scripts.lint].filter(Boolean) as string[];

  if (commands.length === 0) {
    return '#!/usr/bin/env bash\nset -euo pipefail\necho "No verification commands are configured yet."\n';
  }

  return `#!/usr/bin/env bash
set -euo pipefail
${commands.join('\n')}
`;
}

function createCheckPs1(scripts: PackageScripts): string {
  const commands = [scripts.test, scripts.build, scripts.lint].filter(Boolean) as string[];

  if (commands.length === 0) {
    return 'Write-Host "No verification commands are configured yet."\n';
  }

  return `${commands.map((command) => `& ${toPowerShellCommand(command)}`).join('\n')}\n`;
}

function toPowerShellCommand(command: string): string {
  if (command.startsWith('pnpm ')) {
    return `"pnpm" ${command.slice(5)}`;
  }

  return `"${command}"`;
}
