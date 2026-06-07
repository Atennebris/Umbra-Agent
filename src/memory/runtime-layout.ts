import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type UmbraRuntimeLayout = {
  homeDir: string;
  sessionsDir: string;
  projectsDir: string;
  cacheDir: string;
  transformersCacheDir: string;
  draftsDir: string;
  exportsDir: string;
  debugDir: string;
  debugEventsPath: string;
  debugLogPath: string;
  settingsPath: string;
  providersPath: string;
  databasePath: string;
};

export function resolveRuntimeLayout(): UmbraRuntimeLayout {
  const candidates = [
    process.env.UMBRA_HOME,
    path.join(os.homedir(), '.umbra'),
    path.join(os.tmpdir(), 'umbra-runtime'),
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);

  for (const candidate of candidates) {
    const layout = createLayout(candidate);

    try {
      ensureDirectory(layout.homeDir);
      ensureDirectory(layout.sessionsDir);
      ensureDirectory(layout.projectsDir);
      ensureDirectory(layout.cacheDir);
      ensureDirectory(layout.transformersCacheDir);
      ensureDirectory(layout.draftsDir);
      ensureDirectory(layout.exportsDir);
      ensureDirectory(layout.debugDir);
      return layout;
    } catch {}
  }

  throw new Error('Could not initialize any runtime root for Umbra.');
}

function createLayout(homeDir: string): UmbraRuntimeLayout {
  return {
    homeDir,
    sessionsDir: path.join(homeDir, 'sessions'),
    projectsDir: path.join(homeDir, 'projects'),
    cacheDir: path.join(homeDir, 'cache'),
    transformersCacheDir: path.join(homeDir, 'cache', 'transformers'),
    draftsDir: path.join(homeDir, 'drafts'),
    exportsDir: path.join(homeDir, 'exports'),
    debugDir: path.join(homeDir, 'debug'),
    debugEventsPath: path.join(homeDir, 'debug', 'events.jsonl'),
    debugLogPath: path.join(homeDir, 'debug', 'latest.log'),
    settingsPath: path.join(homeDir, 'settings.json'),
    providersPath: path.join(homeDir, 'providers.json'),
    databasePath: path.join(homeDir, 'main.sqlite'),
  };
}

function ensureDirectory(directoryPath: string): void {
  fs.mkdirSync(directoryPath, { recursive: true });
}
