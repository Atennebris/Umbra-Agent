import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { resolveExternalToolPath } from './external-tools.js';
import type { ToolExecutionContext } from './types.js';
import { applyUnifiedDiffPatch } from './unified-diff.js';

const execFileAsync = promisify(execFile);

export const fsListInputSchema = z.object({
  path: z.string().min(1),
  recursive: z.boolean().default(false),
  includeHidden: z.boolean().default(false),
  maxEntries: z.number().int().min(1).max(5000).default(200),
});

export const fsListOutputSchema = z.object({
  path: z.string(),
  resolvedPath: z.string(),
  entries: z.array(
    z.object({
      name: z.string(),
      path: z.string(),
      kind: z.enum(['file', 'directory']),
      size: z.number().int().nullable(),
    }),
  ),
  truncated: z.boolean(),
});

export async function executeFsList(
  input: z.infer<typeof fsListInputSchema>,
  context: ToolExecutionContext,
): Promise<z.infer<typeof fsListOutputSchema>> {
  const resolvedPath = path.resolve(context.cwd, input.path);
  const entries: z.infer<typeof fsListOutputSchema>['entries'] = [];
  let truncated = false;

  await walkDirectory(
    resolvedPath,
    '',
    input.recursive,
    input.includeHidden,
    input.maxEntries,
    entries,
    () => {
      truncated = true;
    },
  );

  return {
    path: input.path,
    resolvedPath,
    entries,
    truncated,
  };
}

async function walkDirectory(
  absolutePath: string,
  relativePrefix: string,
  recursive: boolean,
  includeHidden: boolean,
  maxEntries: number,
  entries: z.infer<typeof fsListOutputSchema>['entries'],
  onTruncated: () => void,
): Promise<void> {
  if (entries.length >= maxEntries) {
    onTruncated();
    return;
  }

  const directoryEntries = await fs.readdir(absolutePath, { withFileTypes: true });

  for (const entry of directoryEntries) {
    if (!includeHidden && entry.name.startsWith('.')) {
      continue;
    }

    if (entries.length >= maxEntries) {
      onTruncated();
      return;
    }

    const entryPath = path.join(absolutePath, entry.name);
    const relativePath = relativePrefix ? path.join(relativePrefix, entry.name) : entry.name;
    const stats = entry.isDirectory() ? null : await fs.stat(entryPath);
    entries.push({
      name: entry.name,
      path: relativePath,
      kind: entry.isDirectory() ? 'directory' : 'file',
      size: stats?.size ?? null,
    });

    if (recursive && entry.isDirectory()) {
      await walkDirectory(
        entryPath,
        relativePath,
        recursive,
        includeHidden,
        maxEntries,
        entries,
        onTruncated,
      );
    }
  }
}

export const fsReadInputSchema = z.object({
  path: z.string().min(1),
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(512_000).default(65_536),
});

export const fsReadOutputSchema = z.object({
  path: z.string(),
  resolvedPath: z.string(),
  content: z.string(),
  truncated: z.boolean(),
  totalBytes: z.number().int(),
});

export async function executeFsRead(
  input: z.infer<typeof fsReadInputSchema>,
  context: ToolExecutionContext,
): Promise<z.infer<typeof fsReadOutputSchema>> {
  const resolvedPath = path.resolve(context.cwd, input.path);
  const buffer = await fs.readFile(resolvedPath);
  const sliced = buffer.subarray(input.offset, input.offset + input.limit);

  return {
    path: input.path,
    resolvedPath,
    content: sliced.toString('utf8'),
    truncated: input.offset + input.limit < buffer.length,
    totalBytes: buffer.length,
  };
}

export const fsWriteInputSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  createDirectories: z.boolean().default(true),
});

export const fsWriteOutputSchema = z.object({
  path: z.string(),
  resolvedPath: z.string(),
  bytesWritten: z.number().int(),
  createdDirectories: z.boolean(),
});

export async function executeFsWrite(
  input: z.infer<typeof fsWriteInputSchema>,
  context: ToolExecutionContext,
): Promise<z.infer<typeof fsWriteOutputSchema>> {
  const resolvedPath = path.resolve(context.cwd, input.path);

  if (input.createDirectories) {
    await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
  }

  await fs.writeFile(resolvedPath, input.content, 'utf8');

  return {
    path: input.path,
    resolvedPath,
    bytesWritten: Buffer.byteLength(input.content, 'utf8'),
    createdDirectories: input.createDirectories,
  };
}

export const fsEditInputSchema = z.object({
  patch: z.string().min(1),
  dryRun: z.boolean().default(false),
});

export const fsEditOutputSchema = z.object({
  dryRun: z.boolean(),
  changedFiles: z.array(
    z.object({
      path: z.string(),
      operation: z.enum(['modified', 'added', 'deleted']),
      hunksApplied: z.number().int(),
    }),
  ),
});

export async function executeFsEdit(
  input: z.infer<typeof fsEditInputSchema>,
  context: ToolExecutionContext,
): Promise<z.infer<typeof fsEditOutputSchema>> {
  const changedFiles = await applyUnifiedDiffPatch(input.patch, context.cwd, input.dryRun);
  return {
    dryRun: input.dryRun,
    changedFiles,
  };
}

export const shellExecInputSchema = z.object({
  command: z.string().min(1),
  cwd: z.string().optional(),
  timeoutMs: z.number().int().min(1).max(120_000).default(30_000),
});

export const shellExecOutputSchema = z.object({
  command: z.string(),
  cwd: z.string(),
  exitCode: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
  timedOut: z.boolean(),
});

export async function executeShellExec(
  input: z.infer<typeof shellExecInputSchema>,
  context: ToolExecutionContext,
): Promise<z.infer<typeof shellExecOutputSchema>> {
  const cwd = path.resolve(context.cwd, input.cwd ?? '.');
  const shellExecutable = process.platform === 'win32' ? 'powershell.exe' : 'bash';
  const shellArgs =
    process.platform === 'win32'
      ? ['-NoProfile', '-NonInteractive', '-Command', input.command]
      : ['-lc', input.command];

  try {
    const result = await execFileAsync(shellExecutable, shellArgs, {
      cwd,
      encoding: 'utf8',
      timeout: input.timeoutMs,
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
      signal: context.signal,
    });

    return {
      command: input.command,
      cwd,
      exitCode: 0,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: false,
    };
  } catch (error) {
    const payload = error as {
      code?: number | string;
      stdout?: string;
      stderr?: string;
      killed?: boolean;
      signal?: string;
    };

    return {
      command: input.command,
      cwd,
      exitCode: typeof payload.code === 'number' ? payload.code : 1,
      stdout: payload.stdout ?? '',
      stderr: payload.stderr ?? '',
      timedOut: payload.signal === 'SIGTERM' || payload.killed === true,
    };
  }
}

export const searchRgInputSchema = z.object({
  pattern: z.string().min(1),
  path: z.string().default('.'),
  glob: z.string().optional(),
  caseSensitive: z.boolean().default(false),
  maxMatches: z.number().int().min(1).max(5000).default(200),
  contextLines: z.number().int().min(0).max(5).default(0),
});

const searchRgSnippetSchema = z.object({
  line: z.number().int(),
  column: z.number().int(),
  text: z.string(),
  contextBefore: z.array(z.string()),
  contextAfter: z.array(z.string()),
});

const searchRgFileBucketSchema = z.object({
  file: z.string(),
  matchCount: z.number().int(),
  snippets: z.array(searchRgSnippetSchema),
  truncated: z.boolean(),
});

export const searchRgOutputSchema = z.object({
  pattern: z.string(),
  resolvedPath: z.string(),
  engine: z.enum(['rg', 'fallback']),
  fileBuckets: z.array(searchRgFileBucketSchema),
  totalMatchCount: z.number().int(),
  truncatedFiles: z.boolean(),
  matches: z.array(
    z.object({
      path: z.string(),
      line: z.number().int(),
      column: z.number().int(),
      text: z.string(),
    }),
  ),
  truncated: z.boolean(),
});

export async function executeSearchRg(
  input: z.infer<typeof searchRgInputSchema>,
  context: ToolExecutionContext,
): Promise<z.infer<typeof searchRgOutputSchema>> {
  const resolvedPath = path.resolve(context.cwd, input.path);
  const rgStatus = resolveExternalToolPath('rg');
  const maxSnippetsPerFile = 20;
  const maxFiles = 50;

  if (rgStatus.available && rgStatus.sourceMode !== 'fallback' && rgStatus.resolvedPath) {
    const args = ['--json', '--line-number', '--column'];
    if (!input.caseSensitive) args.push('-i');
    if (input.glob) args.push('-g', input.glob);
    if (input.contextLines > 0) args.push('-C', String(input.contextLines));
    args.push(input.pattern, resolvedPath);

    let stdout = '';
    try {
      const result = await execFileAsync(rgStatus.resolvedPath, args, {
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
      });
      stdout = result.stdout;
    } catch (error) {
      const payload = error as { code?: number | string; stdout?: string; stderr?: string };
      if (payload.code !== 1) {
        const detail = payload.stderr?.trim() || payload.stdout?.trim() || 'ripgrep failed';
        throw new Error(detail);
      }
      stdout = payload.stdout ?? '';
    }

    const { fileBuckets, flatMatches, truncatedFiles } = parseRgJsonGrouped(
      stdout,
      context.cwd,
      input.maxMatches,
      maxSnippetsPerFile,
      maxFiles,
    );
    const totalMatchCount = flatMatches.length;
    const truncated = truncatedFiles || totalMatchCount >= input.maxMatches;

    return {
      pattern: input.pattern,
      resolvedPath,
      engine: 'rg',
      fileBuckets,
      totalMatchCount,
      truncatedFiles,
      matches: flatMatches.slice(0, input.maxMatches),
      truncated,
    };
  }

  const matches: z.infer<typeof searchRgOutputSchema>['matches'] = [];
  await searchFallback(
    resolvedPath,
    input.pattern,
    input.caseSensitive,
    input.maxMatches,
    matches,
    input.glob,
  );

  const fileBuckets = buildFallbackBuckets(matches, maxSnippetsPerFile, maxFiles);
  const truncatedFiles = fileBuckets.length >= maxFiles;

  return {
    pattern: input.pattern,
    resolvedPath,
    engine: 'fallback',
    fileBuckets,
    totalMatchCount: matches.length,
    truncatedFiles,
    matches,
    truncated: matches.length >= input.maxMatches,
  };
}

type RgEvent = {
  type?: string;
  data?: {
    path?: { text?: string };
    line_number?: number;
    submatches?: Array<{ start?: number; match?: { text?: string } }>;
    lines?: { text?: string };
  };
};

function parseRgJsonGrouped(
  output: string,
  cwd: string,
  maxMatches: number,
  maxSnippetsPerFile: number,
  maxFiles: number,
): {
  fileBuckets: z.infer<typeof searchRgFileBucketSchema>[];
  flatMatches: z.infer<typeof searchRgOutputSchema>['matches'];
  truncatedFiles: boolean;
} {
  const fileMap = new Map<
    string,
    {
      matchCount: number;
      snippets: z.infer<typeof searchRgSnippetSchema>[];
      contextBuffer: string[];
      pendingContext: Map<number, string[]>;
    }
  >();
  const flatMatches: z.infer<typeof searchRgOutputSchema>['matches'] = [];
  let currentFile = '';

  for (const raw of output.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    let parsed: RgEvent;
    try {
      parsed = JSON.parse(raw) as RgEvent;
    } catch {
      continue;
    }

    const { type, data } = parsed;
    if (!data?.path?.text) continue;
    const filePath = path.relative(cwd, data.path.text);

    if (type === 'begin') {
      currentFile = filePath;
      if (!fileMap.has(filePath)) {
        fileMap.set(filePath, {
          matchCount: 0,
          snippets: [],
          contextBuffer: [],
          pendingContext: new Map(),
        });
      }
      continue;
    }

    const fileEntry = fileMap.get(filePath) ?? fileMap.get(currentFile);
    if (!fileEntry) continue;

    if (type === 'context') {
      fileEntry.contextBuffer.push(data.lines?.text?.trimEnd() ?? '');
      continue;
    }

    if (type === 'match') {
      const lineText = data.lines?.text?.trimEnd() ?? '';
      const lineNum = data.line_number ?? 0;

      for (const submatch of data.submatches ?? []) {
        fileEntry.matchCount += 1;
        if (flatMatches.length < maxMatches) {
          flatMatches.push({
            path: filePath,
            line: lineNum,
            column: (submatch.start ?? 0) + 1,
            text: lineText,
          });
        }

        if (fileEntry.snippets.length < maxSnippetsPerFile) {
          fileEntry.snippets.push({
            line: lineNum,
            column: (submatch.start ?? 0) + 1,
            text: lineText,
            contextBefore: [...fileEntry.contextBuffer],
            contextAfter: [],
          });
        }
      }
      fileEntry.contextBuffer = [];
      continue;
    }

    if (type === 'end') {
      for (const snippet of fileEntry.snippets) {
        if (snippet.contextAfter.length === 0 && fileEntry.contextBuffer.length > 0) {
          snippet.contextAfter = [...fileEntry.contextBuffer];
        }
      }
      fileEntry.contextBuffer = [];
    }
  }

  const fileBuckets: z.infer<typeof searchRgFileBucketSchema>[] = [];
  let truncatedFiles = false;

  for (const [file, entry] of fileMap) {
    if (entry.matchCount === 0) continue;
    if (fileBuckets.length >= maxFiles) {
      truncatedFiles = true;
      break;
    }
    fileBuckets.push({
      file,
      matchCount: entry.matchCount,
      snippets: entry.snippets,
      truncated: entry.matchCount > entry.snippets.length,
    });
  }

  return { fileBuckets, flatMatches, truncatedFiles };
}

function buildFallbackBuckets(
  matches: z.infer<typeof searchRgOutputSchema>['matches'],
  maxSnippetsPerFile: number,
  maxFiles: number,
): z.infer<typeof searchRgFileBucketSchema>[] {
  const fileMap = new Map<string, z.infer<typeof searchRgFileBucketSchema>>();

  for (const m of matches) {
    let bucket = fileMap.get(m.path);
    if (!bucket) {
      if (fileMap.size >= maxFiles) continue;
      bucket = { file: m.path, matchCount: 0, snippets: [], truncated: false };
      fileMap.set(m.path, bucket);
    }
    bucket.matchCount += 1;
    if (bucket.snippets.length < maxSnippetsPerFile) {
      bucket.snippets.push({
        line: m.line,
        column: m.column,
        text: m.text,
        contextBefore: [],
        contextAfter: [],
      });
    } else {
      bucket.truncated = true;
    }
  }

  return Array.from(fileMap.values());
}

async function searchFallback(
  directoryPath: string,
  pattern: string,
  caseSensitive: boolean,
  maxMatches: number,
  matches: z.infer<typeof searchRgOutputSchema>['matches'],
  glob?: string,
  cwd = directoryPath,
): Promise<void> {
  if (matches.length >= maxMatches) return;

  const stat = await fs.stat(directoryPath).catch(() => null);
  if (!stat) return;

  if (stat.isFile()) {
    if (glob && !minimatchLite(path.basename(directoryPath), glob)) return;

    const content = await fs.readFile(directoryPath, 'utf8').catch(() => null);
    if (content === null) return;

    const lines = content.split(/\r?\n/);
    const needle = caseSensitive ? pattern : pattern.toLowerCase();

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex] ?? '';
      const haystack = caseSensitive ? line : line.toLowerCase();
      const column = haystack.indexOf(needle);

      if (column !== -1) {
        matches.push({
          path: path.relative(cwd, directoryPath) || path.basename(directoryPath),
          line: lineIndex + 1,
          column: column + 1,
          text: line,
        });
      }

      if (matches.length >= maxMatches) return;
    }

    return;
  }

  const entries = await fs.readdir(directoryPath, { withFileTypes: true });

  for (const entry of entries) {
    if (matches.length >= maxMatches) return;

    const absolutePath = path.join(directoryPath, entry.name);

    if (entry.isDirectory()) {
      await searchFallback(absolutePath, pattern, caseSensitive, maxMatches, matches, glob, cwd);
      continue;
    }

    if (glob && !minimatchLite(entry.name, glob)) continue;

    const content = await fs.readFile(absolutePath, 'utf8').catch(() => null);
    if (content === null) continue;

    const lines = content.split(/\r?\n/);
    const needle = caseSensitive ? pattern : pattern.toLowerCase();

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex] ?? '';
      const haystack = caseSensitive ? line : line.toLowerCase();
      const column = haystack.indexOf(needle);

      if (column !== -1) {
        matches.push({
          path: path.relative(cwd, absolutePath) || entry.name,
          line: lineIndex + 1,
          column: column + 1,
          text: line,
        });
      }

      if (matches.length >= maxMatches) return;
    }
  }
}

// ─── search.files ─────────────────────────────────────────────────────────────

const IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.nuxt',
  'coverage',
  '.cache',
  '__pycache__',
  '.venv',
  'venv',
  '.tox',
  'target',
  'out',
]);

export const searchFilesInputSchema = z.object({
  path: z.string().default('.'),
  glob: z.string().optional(),
  includeHidden: z.boolean().default(false),
  maxResults: z.number().int().min(1).max(5000).default(200),
});

export const searchFilesOutputSchema = z.object({
  resolvedPath: z.string(),
  engine: z.enum(['rg', 'fallback']),
  files: z.array(
    z.object({
      path: z.string(),
      kind: z.enum(['file', 'directory']),
    }),
  ),
  truncated: z.boolean(),
  totalScanned: z.number().int(),
});

export async function executeSearchFiles(
  input: z.infer<typeof searchFilesInputSchema>,
  context: ToolExecutionContext,
): Promise<z.infer<typeof searchFilesOutputSchema>> {
  const resolvedPath = path.resolve(context.cwd, input.path);
  const rgStatus = resolveExternalToolPath('rg');

  if (rgStatus.available && rgStatus.sourceMode !== 'fallback' && rgStatus.resolvedPath) {
    const args = ['--files'];
    if (!input.includeHidden) args.push('--no-hidden');
    if (input.glob) args.push('-g', input.glob);
    args.push(resolvedPath);

    let stdout = '';
    try {
      const result = await execFileAsync(rgStatus.resolvedPath, args, {
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
      });
      stdout = result.stdout;
    } catch (error) {
      const payload = error as { code?: number | string; stdout?: string; stderr?: string };
      if (payload.code !== 1) {
        const detail = payload.stderr?.trim() || 'ripgrep --files failed';
        throw new Error(detail);
      }
      stdout = payload.stdout ?? '';
    }

    const lines = stdout.split(/\r?\n/).filter(Boolean);
    const files = lines.slice(0, input.maxResults).map((line) => ({
      path: path.relative(context.cwd, line),
      kind: 'file' as const,
    }));

    return {
      resolvedPath,
      engine: 'rg',
      files,
      truncated: lines.length > input.maxResults,
      totalScanned: lines.length,
    };
  }

  const files: z.infer<typeof searchFilesOutputSchema>['files'] = [];
  let scanned = 0;
  let truncated = false;

  await walkForFiles(
    resolvedPath,
    context.cwd,
    input.includeHidden,
    input.glob,
    input.maxResults,
    files,
    () => {
      truncated = true;
    },
    () => {
      scanned += 1;
    },
  );

  return {
    resolvedPath,
    engine: 'fallback',
    files,
    truncated,
    totalScanned: scanned,
  };
}

async function walkForFiles(
  absolutePath: string,
  cwd: string,
  includeHidden: boolean,
  glob: string | undefined,
  maxResults: number,
  results: z.infer<typeof searchFilesOutputSchema>['files'],
  onTruncated: () => void,
  onScanned: () => void,
): Promise<void> {
  if (results.length >= maxResults) {
    onTruncated();
    return;
  }

  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(absolutePath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!includeHidden && entry.name.startsWith('.')) continue;
    if (entry.isDirectory() && IGNORE_DIRS.has(entry.name)) continue;

    const childPath = path.join(absolutePath, entry.name);
    const relPath = path.relative(cwd, childPath);

    if (entry.isDirectory()) {
      await walkForFiles(
        childPath,
        cwd,
        includeHidden,
        glob,
        maxResults,
        results,
        onTruncated,
        onScanned,
      );
    } else {
      onScanned();
      if (glob && !minimatchLite(entry.name, glob)) continue;
      if (results.length >= maxResults) {
        onTruncated();
        return;
      }
      results.push({ path: relPath, kind: 'file' });
    }
  }
}

// ─── search.fuzzy ─────────────────────────────────────────────────────────────

export const searchFuzzyInputSchema = z.object({
  query: z.string().min(1),
  path: z.string().default('.'),
  maxResults: z.number().int().min(1).max(100).default(20),
  includeDirectories: z.boolean().default(false),
  includeHidden: z.boolean().default(false),
});

export const searchFuzzyOutputSchema = z.object({
  query: z.string(),
  resolvedPath: z.string(),
  results: z.array(
    z.object({
      path: z.string(),
      score: z.number(),
      kind: z.enum(['file', 'directory']),
      matchIndices: z.array(z.number().int()),
    }),
  ),
  truncated: z.boolean(),
});

export async function executeSearchFuzzy(
  input: z.infer<typeof searchFuzzyInputSchema>,
  context: ToolExecutionContext,
): Promise<z.infer<typeof searchFuzzyOutputSchema>> {
  const resolvedPath = path.resolve(context.cwd, input.path);
  const candidates: Array<{ relPath: string; kind: 'file' | 'directory' }> = [];

  await collectCandidates(
    resolvedPath,
    context.cwd,
    input.includeHidden,
    input.includeDirectories,
    2000,
    candidates,
  );

  const scored = candidates
    .map(({ relPath, kind }) => {
      const { score, indices } = fuzzyScore(input.query, relPath);
      return { path: relPath, score, kind, matchIndices: indices };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);

  const results = scored.slice(0, input.maxResults);

  return {
    query: input.query,
    resolvedPath,
    results,
    truncated: scored.length > input.maxResults,
  };
}

async function collectCandidates(
  absolutePath: string,
  cwd: string,
  includeHidden: boolean,
  includeDirectories: boolean,
  limit: number,
  results: Array<{ relPath: string; kind: 'file' | 'directory' }>,
): Promise<void> {
  if (results.length >= limit) return;

  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(absolutePath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!includeHidden && entry.name.startsWith('.')) continue;
    if (IGNORE_DIRS.has(entry.name)) continue;
    if (results.length >= limit) return;

    const childPath = path.join(absolutePath, entry.name);
    const relPath = path.relative(cwd, childPath);

    if (entry.isDirectory()) {
      if (includeDirectories) results.push({ relPath, kind: 'directory' });
      await collectCandidates(childPath, cwd, includeHidden, includeDirectories, limit, results);
    } else {
      results.push({ relPath, kind: 'file' });
    }
  }
}

function fuzzyScore(query: string, target: string): { score: number; indices: number[] } {
  const q = query.toLowerCase();
  const t = target.toLowerCase();

  if (t.includes(q)) {
    const idx = t.indexOf(q);
    const indices = Array.from({ length: q.length }, (_, i) => idx + i);
    const bonus = target.endsWith(query)
      ? 20
      : target.includes(`/${query}`) || target.includes(`\\${query}`)
        ? 10
        : 0;
    return { score: 100 + bonus - Math.floor(t.length / 10), indices };
  }

  const indices: number[] = [];
  let tIdx = 0;
  let consecutive = 0;
  let score = 0;

  for (let qIdx = 0; qIdx < q.length; qIdx += 1) {
    let found = false;
    while (tIdx < t.length) {
      if (t[tIdx] === q[qIdx]) {
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

  score = Math.max(0, score - Math.floor(t.length / 5));
  return { score, indices };
}

function minimatchLite(value: string, glob: string): boolean {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`).test(value);
}

export const gitStatusInputSchema = z.object({
  cwd: z.string().optional(),
});

export const gitStatusOutputSchema = z.object({
  cwd: z.string(),
  branch: z.string().nullable(),
  upstream: z.string().nullable(),
  ahead: z.number().int(),
  behind: z.number().int(),
  entries: z.array(
    z.object({
      indexStatus: z.string(),
      worktreeStatus: z.string(),
      path: z.string(),
    }),
  ),
  raw: z.string(),
});

export async function executeGitStatus(
  input: z.infer<typeof gitStatusInputSchema>,
  context: ToolExecutionContext,
): Promise<z.infer<typeof gitStatusOutputSchema>> {
  const cwd = path.resolve(context.cwd, input.cwd ?? '.');
  const git = ensureResolvedGitPath();
  const result = await execFileAsync(git, ['status', '--porcelain=v1', '--branch'], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  });
  return parseGitStatusOutput(cwd, result.stdout);
}

function parseGitStatusOutput(cwd: string, output: string): z.infer<typeof gitStatusOutputSchema> {
  const lines = output.split(/\r?\n/).filter(Boolean);
  let branch: string | null = null;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  const entries: z.infer<typeof gitStatusOutputSchema>['entries'] = [];

  for (const line of lines) {
    if (line.startsWith('## ')) {
      const header = line.slice(3);
      const [branchPart, divergencePart] = header.split('...');
      branch = branchPart ?? null;
      if (divergencePart) {
        const upstreamMatch = /^([^ ]+)(?: \[(.*)\])?$/.exec(divergencePart);
        upstream = upstreamMatch?.[1] ?? null;
        const divergence = upstreamMatch?.[2] ?? '';
        const aheadMatch = /ahead (\d+)/.exec(divergence);
        const behindMatch = /behind (\d+)/.exec(divergence);
        ahead = aheadMatch ? Number(aheadMatch[1]) : 0;
        behind = behindMatch ? Number(behindMatch[1]) : 0;
      }
      continue;
    }

    entries.push({
      indexStatus: line.slice(0, 1),
      worktreeStatus: line.slice(1, 2),
      path: line.slice(3),
    });
  }

  return {
    cwd,
    branch,
    upstream,
    ahead,
    behind,
    entries,
    raw: output,
  };
}

export const gitDiffInputSchema = z.object({
  cwd: z.string().optional(),
  cached: z.boolean().default(false),
  contextLines: z.number().int().min(0).max(20).default(3),
});

export const gitDiffOutputSchema = z.object({
  cwd: z.string(),
  cached: z.boolean(),
  patch: z.string(),
  files: z.array(
    z.object({
      path: z.string(),
      additions: z.number().int(),
      deletions: z.number().int(),
    }),
  ),
});

export async function executeGitDiff(
  input: z.infer<typeof gitDiffInputSchema>,
  context: ToolExecutionContext,
): Promise<z.infer<typeof gitDiffOutputSchema>> {
  const cwd = path.resolve(context.cwd, input.cwd ?? '.');
  const git = ensureResolvedGitPath();
  const diffArgs = ['diff', `--unified=${input.contextLines}`];
  if (input.cached) {
    diffArgs.push('--cached');
  }

  const [patchResult, numstatResult] = await Promise.all([
    execFileAsync(git, diffArgs, {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
    }),
    execFileAsync(git, ['diff', '--numstat', ...(input.cached ? ['--cached'] : [])], {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
    }),
  ]);

  return {
    cwd,
    cached: input.cached,
    patch: patchResult.stdout,
    files: parseGitNumstat(numstatResult.stdout),
  };
}

function parseGitNumstat(output: string): z.infer<typeof gitDiffOutputSchema>['files'] {
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [additions, deletions, ...rest] = line.split('\t');
      return {
        path: rest.join('\t'),
        additions: Number(additions),
        deletions: Number(deletions),
      };
    });
}

export const gitApplyInputSchema = z.object({
  cwd: z.string().optional(),
  patch: z.string().min(1),
  check: z.boolean().default(false),
  cached: z.boolean().default(false),
});

export const gitApplyOutputSchema = z.object({
  cwd: z.string(),
  applied: z.boolean(),
  check: z.boolean(),
  cached: z.boolean(),
  stdout: z.string(),
  stderr: z.string(),
});

export async function executeGitApply(
  input: z.infer<typeof gitApplyInputSchema>,
  context: ToolExecutionContext,
): Promise<z.infer<typeof gitApplyOutputSchema>> {
  const cwd = path.resolve(context.cwd, input.cwd ?? '.');
  const git = ensureResolvedGitPath();
  const tempFile = path.join(
    os.tmpdir(),
    `umbra-git-apply-${Date.now()}-${Math.random().toString(16).slice(2)}.patch`,
  );
  await fs.writeFile(tempFile, input.patch, 'utf8');

  try {
    const args = ['apply'];
    if (input.check) {
      args.push('--check');
    }
    if (input.cached) {
      args.push('--cached');
    }
    args.push(tempFile);

    const result = await execFileAsync(git, args, {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
    });

    return {
      cwd,
      applied: !input.check,
      check: input.check,
      cached: input.cached,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } finally {
    await fs.rm(tempFile, { force: true });
  }
}

export const gitCommitInputSchema = z.object({
  cwd: z.string().optional(),
  message: z.string().min(1),
  all: z.boolean().default(false),
});

export const gitCommitOutputSchema = z.object({
  cwd: z.string(),
  commitHash: z.string(),
  message: z.string(),
  stdout: z.string(),
  stderr: z.string(),
});

export async function executeGitCommit(
  input: z.infer<typeof gitCommitInputSchema>,
  context: ToolExecutionContext,
): Promise<z.infer<typeof gitCommitOutputSchema>> {
  const cwd = path.resolve(context.cwd, input.cwd ?? '.');
  const git = ensureResolvedGitPath();
  const commitArgs = ['commit', '-m', input.message];
  if (input.all) {
    commitArgs.push('-a');
  }

  const result = await execFileAsync(git, commitArgs, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  });
  const hashResult = await execFileAsync(git, ['rev-parse', 'HEAD'], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  });

  return {
    cwd,
    commitHash: hashResult.stdout.trim(),
    message: input.message,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

export const gitPushInputSchema = z.object({
  cwd: z.string().optional(),
  remote: z.string().default('origin'),
  branch: z.string().optional(),
  force: z.boolean().default(false),
});

export const gitPushOutputSchema = z.object({
  cwd: z.string(),
  remote: z.string(),
  branch: z.string(),
  stdout: z.string(),
  stderr: z.string(),
});

export async function executeGitPush(
  input: z.infer<typeof gitPushInputSchema>,
  context: ToolExecutionContext,
): Promise<z.infer<typeof gitPushOutputSchema>> {
  const cwd = path.resolve(context.cwd, input.cwd ?? '.');
  const git = ensureResolvedGitPath();

  let branch = input.branch;
  if (!branch) {
    const branchResult = await execFileAsync(git, ['branch', '--show-current'], {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
    });
    branch = branchResult.stdout.trim() || 'HEAD';
  }

  const pushArgs = ['push', input.remote, branch];
  if (input.force) pushArgs.push('--force-with-lease');

  const result = await execFileAsync(git, pushArgs, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  });

  return {
    cwd,
    remote: input.remote,
    branch,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

export const gitPullInputSchema = z.object({
  cwd: z.string().optional(),
  remote: z.string().default('origin'),
  branch: z.string().optional(),
  rebase: z.boolean().default(false),
});

export const gitPullOutputSchema = z.object({
  cwd: z.string(),
  remote: z.string(),
  branch: z.string(),
  alreadyUpToDate: z.boolean(),
  stdout: z.string(),
  stderr: z.string(),
});

export async function executeGitPull(
  input: z.infer<typeof gitPullInputSchema>,
  context: ToolExecutionContext,
): Promise<z.infer<typeof gitPullOutputSchema>> {
  const cwd = path.resolve(context.cwd, input.cwd ?? '.');
  const git = ensureResolvedGitPath();

  let branch = input.branch;
  if (!branch) {
    const branchResult = await execFileAsync(git, ['branch', '--show-current'], {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
    });
    branch = branchResult.stdout.trim() || 'HEAD';
  }

  const pullArgs = ['pull'];
  if (input.rebase) pullArgs.push('--rebase');
  pullArgs.push(input.remote, branch);

  const result = await execFileAsync(git, pullArgs, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  });

  const alreadyUpToDate = /already up[- ]to[- ]date/i.test(result.stdout + result.stderr);

  return {
    cwd,
    remote: input.remote,
    branch,
    alreadyUpToDate,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

export const fsCdInputSchema = z.object({
  path: z.string().min(1),
});

export const fsCdOutputSchema = z.object({
  previousPath: z.string(),
  newPath: z.string(),
  status: z.enum(['completed', 'failed']),
  error: z.string().optional(),
});

export async function executeFsCd(
  input: z.infer<typeof fsCdInputSchema>,
  context: ToolExecutionContext,
): Promise<z.infer<typeof fsCdOutputSchema>> {
  try {
    const resolvedPath = path.resolve(context.cwd, input.path);
    const stats = await fs.stat(resolvedPath);

    if (!stats.isDirectory()) {
      return {
        previousPath: context.cwd,
        newPath: context.cwd,
        status: 'failed',
        error: `Path "${input.path}" is not a directory.`,
      };
    }

    return {
      previousPath: context.cwd,
      newPath: resolvedPath,
      status: 'completed',
    };
  } catch (error) {
    return {
      previousPath: context.cwd,
      newPath: context.cwd,
      status: 'failed',
      error: String(error),
    };
  }
}

export function classifyShellCommand(command: string): 'read_only' | 'execute' {
  const normalized = command.trim().toLowerCase();
  const readOnlyPrefixes = [
    'get-childitem',
    'get-content',
    'select-string',
    'where-object',
    'get-location',
    'pwd',
    'ls',
    'dir',
    'rg ',
    'git status',
    'git diff',
    'echo ',
  ];

  const destructiveSignals = [
    'remove-item',
    'set-content',
    'add-content',
    'move-item',
    'copy-item',
    'new-item',
    'clear-content',
    'git apply',
    'git commit',
    '>',
    '>>',
  ];

  if (destructiveSignals.some((signal) => normalized.includes(signal))) {
    return 'execute';
  }

  return readOnlyPrefixes.some((prefix) => normalized.startsWith(prefix)) ? 'read_only' : 'execute';
}

function ensureResolvedGitPath(): string {
  const gitStatus = resolveExternalToolPath('git');

  if (!gitStatus.available || !gitStatus.resolvedPath || gitStatus.sourceMode === 'fallback') {
    throw new Error('Git executable is not available.');
  }

  return gitStatus.resolvedPath;
}
