import fs from 'node:fs';
import path from 'node:path';

export type RuntimePermissionMode = 'agent' | 'full';

export type TerminalCursorStyle = 'blinking' | 'static';

export type UsageDetailMode = 'off' | 'compact' | 'verbose';

export type LivePreviewMode = 'expanded' | 'compact';

type RuntimePreferences = {
  defaultMode: RuntimePermissionMode;
  lastProjectPath?: string;
  cursorStyle?: TerminalCursorStyle;
  usageDetailMode?: UsageDetailMode;
  livePreviewMode?: LivePreviewMode;
  compactProvider?: string | null;
  compactModel?: string | null;
  reviewProvider?: string | null;
  reviewModel?: string | null;
  theme?: string;
};

const DEFAULT_PREFERENCES: RuntimePreferences = {
  defaultMode: 'agent',
  cursorStyle: 'blinking',
  usageDetailMode: 'off',
  livePreviewMode: 'expanded',
};

export function readRuntimePreferences(): RuntimePreferences {
  const preferencesPath = resolvePreferencesPath();

  try {
    if (!fs.existsSync(preferencesPath)) {
      return DEFAULT_PREFERENCES;
    }
    const parsed = JSON.parse(fs.readFileSync(preferencesPath, 'utf8')) as unknown;
    if (!isRecord(parsed)) {
      return DEFAULT_PREFERENCES;
    }
    const mode = parsed.defaultMode;
    const lastProjectPath =
      typeof parsed.lastProjectPath === 'string' ? parsed.lastProjectPath : undefined;
    const cursorStyle =
      parsed.cursorStyle === 'blinking' || parsed.cursorStyle === 'static'
        ? parsed.cursorStyle
        : DEFAULT_PREFERENCES.cursorStyle;

    // Migrate old boolean showUsageDetail → usageDetailMode
    let usageDetailMode: UsageDetailMode = 'off';
    if (parsed.usageDetailMode === 'compact' || parsed.usageDetailMode === 'verbose') {
      usageDetailMode = parsed.usageDetailMode;
    } else if (parsed.showUsageDetail === true) {
      usageDetailMode = 'compact';
    }

    const livePreviewMode: LivePreviewMode =
      parsed.livePreviewMode === 'compact' || parsed.livePreviewMode === 'expanded'
        ? parsed.livePreviewMode
        : 'expanded';

    const compactProvider =
      typeof parsed.compactProvider === 'string' ? parsed.compactProvider : null;
    const compactModel = typeof parsed.compactModel === 'string' ? parsed.compactModel : null;
    const reviewProvider = typeof parsed.reviewProvider === 'string' ? parsed.reviewProvider : null;
    const reviewModel = typeof parsed.reviewModel === 'string' ? parsed.reviewModel : null;

    const theme = typeof parsed.theme === 'string' ? parsed.theme : undefined;

    return {
      defaultMode: mode === 'agent' || mode === 'full' ? mode : DEFAULT_PREFERENCES.defaultMode,
      ...(lastProjectPath ? { lastProjectPath } : {}),
      ...(cursorStyle ? { cursorStyle } : {}),
      usageDetailMode,
      livePreviewMode,
      compactProvider,
      compactModel,
      reviewProvider,
      reviewModel,
      ...(theme ? { theme } : {}),
    };
  } catch {}

  return DEFAULT_PREFERENCES;
}

export function setCursorStyle(style: TerminalCursorStyle): void {
  const current = readRuntimePreferences();
  writePreferences({ ...current, cursorStyle: style });
  // Apply immediately via ANSI: ESC[?12h = blink on, ESC[?12l = blink off
  if (process.stdout.isTTY) {
    process.stdout.write(style === 'blinking' ? '\x1b[?12h' : '\x1b[?12l');
  }
}

export function applySavedCursorStyle(): void {
  const { cursorStyle } = readRuntimePreferences();
  if (process.stdout.isTTY) {
    process.stdout.write(cursorStyle === 'static' ? '\x1b[?12l' : '\x1b[?12h');
  }
}

export function setDefaultRuntimeMode(mode: RuntimePermissionMode): RuntimePreferences {
  const current = readRuntimePreferences();
  return writePreferences({ ...current, defaultMode: mode });
}

export function saveLastProjectPath(projectPath: string): void {
  const current = readRuntimePreferences();
  writePreferences({ ...current, lastProjectPath: projectPath });
}

export function getLastProjectPath(): string | undefined {
  return readRuntimePreferences().lastProjectPath;
}

export function setUsageDetailMode(mode: UsageDetailMode): void {
  const current = readRuntimePreferences();
  writePreferences({ ...current, usageDetailMode: mode });
}

export function getUsageDetailMode(): UsageDetailMode {
  return readRuntimePreferences().usageDetailMode ?? 'off';
}

export function setLivePreviewMode(mode: LivePreviewMode): void {
  const current = readRuntimePreferences();
  writePreferences({ ...current, livePreviewMode: mode });
}

export function getLivePreviewMode(): LivePreviewMode {
  return readRuntimePreferences().livePreviewMode ?? 'expanded';
}

export function setThemePreference(name: string): void {
  const current = readRuntimePreferences();
  writePreferences({ ...current, theme: name });
}

export function getThemePreference(): string {
  return readRuntimePreferences().theme ?? 'umbra';
}

export function getCompactSettings(): { provider: string | null; model: string | null } {
  const prefs = readRuntimePreferences();
  return {
    provider: prefs.compactProvider ?? null,
    model: prefs.compactModel ?? null,
  };
}

export function setCompactSettings(provider: string | null, model: string | null): void {
  const current = readRuntimePreferences();
  writePreferences({ ...current, compactProvider: provider, compactModel: model });
}

export function getReviewSettings(): { provider: string | null; model: string | null } {
  const prefs = readRuntimePreferences();
  return {
    provider: prefs.reviewProvider ?? null,
    model: prefs.reviewModel ?? null,
  };
}

export function setReviewSettings(provider: string | null, model: string | null): void {
  const current = readRuntimePreferences();
  writePreferences({ ...current, reviewProvider: provider, reviewModel: model });
}

function writePreferences(prefs: RuntimePreferences): RuntimePreferences {
  const preferencesPath = resolvePreferencesPath();
  const directory = path.dirname(preferencesPath);
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
  }
  fs.writeFileSync(preferencesPath, JSON.stringify(prefs, null, 2), 'utf8');
  return prefs;
}

function resolvePreferencesPath(): string {
  const home =
    process.env.UMBRA_HOME ??
    path.join(process.env.HOME ?? process.env.USERPROFILE ?? '', '.umbra');
  return path.join(home, 'runtime-preferences.json');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
