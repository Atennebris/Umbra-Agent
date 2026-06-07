import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolveRuntimeLayout } from './runtime-layout.js';

export type ProjectRuntimePaths = {
  projectPath: string;
  projectKey: string;
  directory: string;
  memoryPath: string;
  metadataPath: string;
};

export type ParsedAgentsRules = {
  path: string | null;
  raw: string | null;
  rules: string[];
};

export function normalizeProjectPath(projectPath: string): string {
  return path.resolve(projectPath);
}

export function getProjectRuntimePaths(projectPath: string): ProjectRuntimePaths {
  const normalizedProjectPath = normalizeProjectPath(projectPath);
  const projectKey = createProjectKey(normalizedProjectPath);
  const directory = path.join(resolveRuntimeLayout().projectsDir, projectKey);

  return {
    projectPath: normalizedProjectPath,
    projectKey,
    directory,
    memoryPath: path.join(directory, 'MEMORY.md'),
    metadataPath: path.join(directory, 'project.json'),
  };
}

export function ensureProjectRuntime(projectPath: string): ProjectRuntimePaths {
  const paths = getProjectRuntimePaths(projectPath);
  fs.mkdirSync(paths.directory, { recursive: true });

  if (!fs.existsSync(paths.memoryPath)) {
    fs.writeFileSync(paths.memoryPath, '', 'utf8');
  }

  if (!fs.existsSync(paths.metadataPath)) {
    fs.writeFileSync(
      paths.metadataPath,
      `${JSON.stringify(
        {
          projectKey: paths.projectKey,
          projectPath: paths.projectPath,
          createdAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
  }

  return paths;
}

export function readProjectMemory(projectPath: string): string {
  const paths = ensureProjectRuntime(projectPath);
  return fs.readFileSync(paths.memoryPath, 'utf8');
}

export function writeProjectMemory(projectPath: string, content: string): void {
  const paths = ensureProjectRuntime(projectPath);
  fs.writeFileSync(paths.memoryPath, content, 'utf8');
}

export function readAgentsRules(projectPath: string): ParsedAgentsRules {
  const agentsPath = path.join(normalizeProjectPath(projectPath), 'AGENTS.md');

  if (!fs.existsSync(agentsPath)) {
    return {
      path: null,
      raw: null,
      rules: [],
    };
  }

  const raw = fs.readFileSync(agentsPath, 'utf8');
  const rules = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- ') || /^\d+\./.test(line) || line.startsWith('#'));

  return {
    path: agentsPath,
    raw,
    rules,
  };
}

export function readGlobalAgentsRules(): ParsedAgentsRules {
  const globalPath = path.join(resolveRuntimeLayout().homeDir, 'AGENTS.md');

  if (!fs.existsSync(globalPath)) {
    try {
      fs.writeFileSync(globalPath, '', 'utf8');
    } catch {}
    return { path: globalPath, raw: '', rules: [] };
  }

  const raw = fs.readFileSync(globalPath, 'utf8');
  const rules = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  return { path: globalPath, raw, rules };
}

function createProjectKey(projectPath: string): string {
  const baseName = path
    .basename(projectPath)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-');
  const normalizedBaseName = baseName.replace(/^-+|-+$/g, '') || 'project';
  const hash = createHash('sha1').update(projectPath).digest('hex').slice(0, 10);
  return `${normalizedBaseName}-${hash}`;
}
