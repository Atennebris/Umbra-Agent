import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type ProjectReferenceItem = {
  path: string;
  kind: 'file' | 'directory';
  matchIndices?: number[];
};

type CatalogCache = {
  cwd: string;
  items: ProjectReferenceItem[];
  loadedAt: number;
};

let catalogCache: CatalogCache | null = null;

export async function loadProjectReferenceCatalog(cwd: string): Promise<ProjectReferenceItem[]> {
  if (catalogCache && catalogCache.cwd === cwd && Date.now() - catalogCache.loadedAt < 15_000) {
    return catalogCache.items;
  }

  const items = buildProjectReferenceCatalog(filterReferencePaths(await listProjectFiles(cwd)));
  catalogCache = {
    cwd,
    items,
    loadedAt: Date.now(),
  };
  return items;
}

export function buildProjectReferenceCatalog(filePaths: string[]): ProjectReferenceItem[] {
  const directories = new Set<string>();
  const files = new Set<string>();

  for (const filePath of filePaths) {
    const normalized = normalizeReferencePath(filePath);

    if (!normalized) {
      continue;
    }

    files.add(normalized);

    const segments = normalized.split('/');
    for (let index = 1; index < segments.length; index += 1) {
      directories.add(segments.slice(0, index).join('/'));
    }
  }

  return [
    ...Array.from(directories)
      .sort()
      .map((path) => ({ path, kind: 'directory' as const })),
    ...Array.from(files)
      .sort()
      .map((path) => ({ path, kind: 'file' as const })),
  ];
}

export function getAtReferenceQuery(input: string): string | null {
  const match = /(?:^|\s)@([^\s@]*)$/.exec(input);
  return match ? (match[1] ?? '') : null;
}

export function getAtSuggestions(
  input: string,
  catalog: ProjectReferenceItem[],
): ProjectReferenceItem[] {
  const query = getAtReferenceQuery(input);

  if (query === null) {
    return [];
  }

  const normalizedQuery = normalizeReferencePath(query).toLowerCase();

  if (normalizedQuery.length === 0) {
    return catalog
      .slice()
      .sort((left, right) => {
        if (left.kind !== right.kind) return left.kind === 'directory' ? -1 : 1;
        return left.path.localeCompare(right.path);
      })
      .slice(0, 12)
      .map((item) => ({ ...item, matchIndices: [] }));
  }

  type Scored = { path: string; kind: 'file' | 'directory'; matchIndices: number[]; score: number };

  const scored: Scored[] = [];
  for (const item of catalog) {
    const { score, indices } = fuzzyScorePath(normalizedQuery, item.path.toLowerCase());
    if (score > 0) {
      scored.push({ path: item.path, kind: item.kind, matchIndices: indices, score });
    }
  }

  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
    return a.path.localeCompare(b.path);
  });

  return scored.slice(0, 12).map(({ score: _score, ...item }) => item);
}

function fuzzyScorePath(query: string, target: string): { score: number; indices: number[] } {
  if (target.includes(query)) {
    const idx = target.indexOf(query);
    const indices = Array.from({ length: query.length }, (_, i) => idx + i);
    const bonus = target.endsWith(query)
      ? 20
      : target.includes(`/${query}`) || target.includes(`\\${query}`)
        ? 10
        : 0;
    return { score: 100 + bonus - Math.floor(target.length / 10), indices };
  }

  const indices: number[] = [];
  let tIdx = 0;
  let consecutive = 0;
  let score = 0;

  for (let qIdx = 0; qIdx < query.length; qIdx += 1) {
    let found = false;
    while (tIdx < target.length) {
      if (target[tIdx] === query[qIdx]) {
        indices.push(tIdx);
        score += 5 + consecutive * 3;
        consecutive += 1;
        tIdx += 1;
        found = true;
        break;
      }
      consecutive = 0;
      tIdx += 1;
    }
    if (!found) return { score: 0, indices: [] };
  }

  score = Math.max(0, score - Math.floor(target.length / 5));
  return { score, indices };
}

export function applyAtSuggestion(input: string, item: ProjectReferenceItem): string {
  return input.replace(/@([^\s@]*)$/, () => {
    if (item.kind === 'directory') {
      return `@${item.path}/`;
    }

    return `@${item.path} `;
  });
}

async function listProjectFiles(cwd: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      'rg',
      ['--files', '--hidden', '-g', '!.git', '-g', '!dist/**', '-g', '!node_modules/**'],
      {
        cwd,
        windowsHide: true,
      },
    );

    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch {
    return listProjectFilesFallback(cwd);
  }
}

async function listProjectFilesFallback(cwd: string): Promise<string[]> {
  const entries: string[] = [];
  await walkProjectFiles(cwd, cwd, entries);
  return entries;
}

async function walkProjectFiles(
  rootPath: string,
  currentPath: string,
  entries: string[],
): Promise<void> {
  const children = await fs.readdir(currentPath, { withFileTypes: true }).catch(() => []);

  for (const child of children) {
    if (child.name === '.git' || child.name === 'node_modules' || child.name === 'dist') {
      continue;
    }

    const absolutePath = path.join(currentPath, child.name);

    if (child.isDirectory()) {
      await walkProjectFiles(rootPath, absolutePath, entries);
      continue;
    }

    if (!child.isFile()) {
      continue;
    }

    entries.push(path.relative(rootPath, absolutePath));
  }
}

function normalizeReferencePath(value: string): string {
  return value
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/\/{2,}/g, '/')
    .trim();
}

function filterReferencePaths(filePaths: string[]): string[] {
  return filePaths.filter((filePath) => {
    const normalized = normalizeReferencePath(filePath);
    return !isIgnoredReferencePath(normalized);
  });
}

function isIgnoredReferencePath(referencePath: string): boolean {
  return (
    referencePath === '.git' ||
    referencePath === 'dist' ||
    referencePath === 'node_modules' ||
    referencePath.startsWith('.git/') ||
    referencePath.startsWith('dist/') ||
    referencePath.startsWith('node_modules/')
  );
}
