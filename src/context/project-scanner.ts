import fs from 'node:fs';
import path from 'node:path';

export type ScannedProjectFile = {
  absolutePath: string;
  relativePath: string;
  extension: string;
  size: number;
};

export type ScanProjectOptions = {
  maxFiles?: number;
  maxFileSizeBytes?: number;
};

const defaultIgnoredDirectories = new Set([
  '.git',
  '.hg',
  '.idea',
  '.next',
  '.pnpm-store',
  '.turbo',
  '.venv',
  '.vscode',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'tmp',
]);

const ignoredExtensions = new Set([
  '.bmp',
  '.class',
  '.dll',
  '.doc',
  // .docx is handled by DOCX extractor in repo-map
  '.exe',
  '.gif',
  '.ico',
  '.jar',
  '.jpeg',
  '.jpg',
  '.mp3',
  '.mp4',
  // .pdf is handled by PDF extractor in repo-map
  '.png',
  '.pyc',
  '.so',
  '.svg',
  '.ttf',
  '.wav',
  '.webp',
  '.wasm',
  '.woff',
  '.woff2',
  '.zip',
]);

export function scanProjectFiles(
  rootPath: string,
  options: ScanProjectOptions = {},
): ScannedProjectFile[] {
  const maxFiles = options.maxFiles ?? 250;
  const maxFileSizeBytes = options.maxFileSizeBytes ?? 256_000;
  const normalizedRoot = path.resolve(rootPath);
  const results: ScannedProjectFile[] = [];
  const directories = [normalizedRoot];

  while (directories.length > 0 && results.length < maxFiles) {
    const directory = directories.pop();

    if (!directory) {
      continue;
    }

    let entries: fs.Dirent[];

    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }

    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      if (results.length >= maxFiles) {
        break;
      }

      const absolutePath = path.join(directory, entry.name);
      const relativePath = normalizeRelativePath(path.relative(normalizedRoot, absolutePath));

      if (!relativePath || shouldIgnorePath(relativePath, entry)) {
        continue;
      }

      if (entry.isDirectory()) {
        directories.push(absolutePath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const extension = path.extname(entry.name).toLowerCase();

      if (ignoredExtensions.has(extension)) {
        continue;
      }

      let stats: fs.Stats;

      try {
        stats = fs.statSync(absolutePath);
      } catch {
        continue;
      }

      if (stats.size > maxFileSizeBytes) {
        continue;
      }

      results.push({
        absolutePath,
        relativePath,
        extension,
        size: stats.size,
      });
    }
  }

  return results.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function shouldIgnorePath(relativePath: string, entry: fs.Dirent): boolean {
  const normalized = normalizeRelativePath(relativePath);
  const segments = normalized.split('/');

  if (segments.some((segment) => defaultIgnoredDirectories.has(segment))) {
    return true;
  }

  if (entry.isDirectory() && entry.name.startsWith('.') && entry.name !== '.agents') {
    return true;
  }

  return false;
}

function normalizeRelativePath(value: string): string {
  return value
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .trim();
}
