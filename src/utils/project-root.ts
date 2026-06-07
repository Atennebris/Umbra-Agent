import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const projectRoot = path.resolve(__dirname, '..', '..');
export const umbraProjectPathEnv = 'UMBRA_PROJECT_PATH';

/** Directories that are clearly NOT a user project. */
const SYSTEM_DIR_PATTERNS = [
  /[/\\]Windows[/\\]System32/i,
  /[/\\]Windows[/\\]SysWOW64/i,
  /[/\\]Windows[/\\]System/i,
  /^[A-Za-z]:[/\\]Windows$/i,
  /^[A-Za-z]:[/\\]$/, // bare drive root
  /^[/\\]$/, // filesystem root on Unix
];

export function isSystemDirectory(p: string): boolean {
  return SYSTEM_DIR_PATTERNS.some((re) => re.test(p));
}

function findGitRoot(startPath: string): string | null {
  let current = path.resolve(startPath);
  while (true) {
    if (fs.existsSync(path.join(current, '.git'))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

export function resolveTargetProjectPath(
  explicitPath?: string,
  fallbackFn?: () => string | undefined,
): string {
  // 1. Explicit argument takes highest priority.
  if (explicitPath?.trim()) {
    return path.resolve(explicitPath.trim());
  }

  // 2. Environment variable.
  const fromEnv = process.env[umbraProjectPathEnv]?.trim();
  if (fromEnv) {
    return path.resolve(fromEnv);
  }

  // 3. Git Root detection from CWD
  const cwd = process.cwd();
  const gitRoot = findGitRoot(cwd);
  if (gitRoot && !isSystemDirectory(gitRoot)) {
    return gitRoot;
  }

  // 4. Current working directory — but only if it's not a system/junk dir.
  if (!isSystemDirectory(cwd)) {
    return path.resolve(cwd);
  }

  // 5. Fallback: last known good project path (from preferences).
  const saved = fallbackFn?.();
  if (saved) {
    return path.resolve(saved);
  }

  // 6. Last resort: return cwd even if it's a system dir (so callers still get a string).
  return path.resolve(cwd);
}
