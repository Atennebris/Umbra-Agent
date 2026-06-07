import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { loadRuntimeSettings, updateRuntimeSettings } from '../memory/settings-store.js';
import type { ExternalToolSourceMode, ExternalToolStatus } from './types.js';

type ExternalToolDefinition = {
  tool: 'git' | 'rg';
  displayName: string;
  executableNames: string[];
  knownPaths: string[];
  manualPathAllowed: boolean;
  versionArgs: string[];
  versionParser: (output: string) => string | null;
  fallbackFactory?: () => string | null;
};

const externalToolDefinitions: ExternalToolDefinition[] = [
  {
    tool: 'git',
    displayName: 'Git',
    executableNames: process.platform === 'win32' ? ['git.exe', 'git'] : ['git'],
    knownPaths:
      process.platform === 'win32'
        ? ['C:\\Program Files\\Git\\cmd\\git.exe', 'C:\\Program Files\\Git\\bin\\git.exe']
        : ['/usr/bin/git', '/usr/local/bin/git'],
    manualPathAllowed: true,
    versionArgs: ['--version'],
    versionParser: (output) => output.trim() || null,
  },
  {
    tool: 'rg',
    displayName: 'ripgrep',
    executableNames: process.platform === 'win32' ? ['rg.exe', 'rg'] : ['rg'],
    knownPaths: process.platform === 'win32' ? ['C:\\Program Files\\ripgrep\\rg.exe'] : [],
    manualPathAllowed: true,
    versionArgs: ['--version'],
    versionParser: (output) => output.split(/\r?\n/, 1)[0]?.trim() ?? null,
    fallbackFactory: () => 'node-fallback',
  },
];

export function listExternalToolStatuses(): ExternalToolStatus[] {
  return externalToolDefinitions.map((definition) => getExternalToolStatus(definition.tool));
}

export function getExternalToolStatus(tool: 'git' | 'rg'): ExternalToolStatus {
  const definition = getExternalToolDefinition(tool);
  const customPath = loadRuntimeSettings().tools.customPaths[tool];

  if (customPath) {
    const resolved = resolveCandidate(customPath, definition);
    if (resolved) {
      return resolved;
    }
  }

  for (const executableName of definition.executableNames) {
    const systemPath = resolveFromPath(executableName);
    if (systemPath) {
      const resolved = resolveCandidate(systemPath, definition, 'system');
      if (resolved) {
        return resolved;
      }
    }
  }

  for (const knownPath of definition.knownPaths) {
    const resolved = resolveCandidate(knownPath, definition, 'system');
    if (resolved) {
      return resolved;
    }
  }

  const fallbackPath = definition.fallbackFactory?.();
  if (fallbackPath) {
    return {
      tool: definition.tool,
      displayName: definition.displayName,
      available: true,
      sourceMode: 'fallback',
      resolvedPath: fallbackPath,
      version: null,
      fallbackAvailable: true,
      manualPathAllowed: definition.manualPathAllowed,
      missingReason: null,
    };
  }

  return {
    tool: definition.tool,
    displayName: definition.displayName,
    available: false,
    sourceMode: null,
    resolvedPath: null,
    version: null,
    fallbackAvailable: Boolean(definition.fallbackFactory),
    manualPathAllowed: definition.manualPathAllowed,
    missingReason: 'Executable not found in custom path, PATH, known system paths, or fallback.',
  };
}

export function resolveExternalToolPath(tool: 'git' | 'rg'): ExternalToolStatus {
  return getExternalToolStatus(tool);
}

export function setExternalToolCustomPath(
  tool: 'git' | 'rg',
  customPath: string | null,
): ExternalToolStatus {
  const definition = getExternalToolDefinition(tool);

  if (!definition.manualPathAllowed && customPath) {
    throw new Error(`Manual path is not allowed for ${tool}.`);
  }

  updateRuntimeSettings((current) => ({
    ...current,
    tools: {
      ...current.tools,
      customPaths: {
        ...current.tools.customPaths,
        ...(customPath ? { [tool]: customPath } : {}),
      },
    },
  }));

  if (!customPath) {
    updateRuntimeSettings((current) => {
      const nextCustomPaths = { ...current.tools.customPaths };
      delete nextCustomPaths[tool];
      return {
        ...current,
        tools: {
          ...current.tools,
          customPaths: nextCustomPaths,
        },
      };
    });
  }

  return getExternalToolStatus(tool);
}

function getExternalToolDefinition(tool: 'git' | 'rg'): ExternalToolDefinition {
  const definition = externalToolDefinitions.find((candidate) => candidate.tool === tool);

  if (!definition) {
    throw new Error(`Unknown external tool: ${tool}`);
  }

  return definition;
}

function resolveFromPath(executableName: string): string | null {
  const pathEntries = (process.env.PATH ?? '').split(path.delimiter);

  for (const entry of pathEntries) {
    const candidate = path.join(entry, executableName);

    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function resolveCandidate(
  candidatePath: string,
  definition: ExternalToolDefinition,
  sourceMode: ExternalToolSourceMode = 'custom',
): ExternalToolStatus | null {
  if (!fs.existsSync(candidatePath)) {
    return null;
  }

  const versionOutput = spawnSync(candidatePath, definition.versionArgs, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5000,
  });

  const version = definition.versionParser(
    `${versionOutput.stdout ?? ''}\n${versionOutput.stderr ?? ''}`.trim(),
  );

  return {
    tool: definition.tool,
    displayName: definition.displayName,
    available: true,
    sourceMode,
    resolvedPath: candidatePath,
    version,
    fallbackAvailable: Boolean(definition.fallbackFactory),
    manualPathAllowed: definition.manualPathAllowed,
    missingReason: null,
  };
}
