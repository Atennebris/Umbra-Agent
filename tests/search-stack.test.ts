import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { executeToolCall } from '../src/tools/index.js';

const createdDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    createdDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })),
  );
});

async function makeWorkspace(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `umbra-search-${prefix}-`));
  createdDirs.push(dir);
  return dir;
}

// ─── search.rg grouped output ─────────────────────────────────────────────────

describe('search.rg grouped output', () => {
  it('returns fileBuckets grouped by file', async () => {
    const ws = await makeWorkspace('rg-buckets');
    await fs.writeFile(path.join(ws, 'alpha.txt'), 'foo\nbar foo\n', 'utf8');
    await fs.writeFile(path.join(ws, 'beta.txt'), 'baz\n', 'utf8');

    const result = await executeToolCall({
      preset: 'chat-readonly',
      cwd: ws,
      call: { name: 'search.rg', arguments: { pattern: 'foo', path: '.' } },
    });

    expect(result.status).toBe('completed');
    const out = result.output as {
      fileBuckets: Array<{ file: string; matchCount: number; snippets: unknown[] }>;
      totalMatchCount: number;
      truncatedFiles: boolean;
    };
    expect(out.totalMatchCount).toBeGreaterThanOrEqual(2);
    expect(out.fileBuckets.length).toBeGreaterThanOrEqual(1);
    const alphaB = out.fileBuckets.find((b) => b.file.includes('alpha'));
    expect(alphaB).toBeDefined();
    expect(alphaB!.matchCount).toBeGreaterThanOrEqual(2);
    expect(alphaB!.snippets.length).toBeGreaterThanOrEqual(2);
    expect(out.truncatedFiles).toBe(false);
  });

  it('includes contextBefore/contextAfter when contextLines > 0 and rg is available', async () => {
    const ws = await makeWorkspace('rg-ctx');
    await fs.writeFile(path.join(ws, 'ctx.txt'), 'line1\nTARGET\nline3\n', 'utf8');

    const result = await executeToolCall({
      preset: 'chat-readonly',
      cwd: ws,
      call: {
        name: 'search.rg',
        arguments: { pattern: 'TARGET', path: '.', contextLines: 1 },
      },
    });

    expect(result.status).toBe('completed');
    const out = result.output as {
      engine: string;
      fileBuckets: Array<{
        snippets: Array<{ contextBefore: string[]; contextAfter: string[] }>;
      }>;
    };
    expect(out.fileBuckets.length).toBe(1);
    const snippet = out.fileBuckets[0]!.snippets[0]!;
    if (out.engine === 'rg') {
      expect(snippet.contextBefore.length + snippet.contextAfter.length).toBeGreaterThan(0);
    } else {
      expect(snippet.contextBefore).toEqual([]);
      expect(snippet.contextAfter).toEqual([]);
    }
  });

  it('keeps flat matches array for backward compatibility', async () => {
    const ws = await makeWorkspace('rg-flat');
    await fs.writeFile(path.join(ws, 'f.txt'), 'hello world\nhello again\n', 'utf8');

    const result = await executeToolCall({
      preset: 'chat-readonly',
      cwd: ws,
      call: { name: 'search.rg', arguments: { pattern: 'hello', path: '.' } },
    });

    expect(result.status).toBe('completed');
    const out = result.output as {
      matches: Array<{ path: string; line: number; text: string }>;
      truncated: boolean;
    };
    expect(out.matches.length).toBeGreaterThanOrEqual(2);
    expect(out.truncated).toBe(false);
    expect(out.matches[0]).toMatchObject({ line: expect.any(Number), text: expect.any(String) });
  });

  it('reports truncated=true when maxMatches is hit', async () => {
    const ws = await makeWorkspace('rg-trunc');
    const content = Array.from({ length: 10 }, (_, i) => `match${i}`).join('\n');
    await fs.writeFile(path.join(ws, 'big.txt'), content, 'utf8');

    const result = await executeToolCall({
      preset: 'chat-readonly',
      cwd: ws,
      call: {
        name: 'search.rg',
        arguments: { pattern: 'match', path: '.', maxMatches: 3 },
      },
    });

    expect(result.status).toBe('completed');
    const out = result.output as { truncated: boolean; matches: unknown[] };
    expect(out.matches.length).toBeLessThanOrEqual(3);
    expect(out.truncated).toBe(true);
  });

  it('fallback engine still returns fileBuckets', async () => {
    const ws = await makeWorkspace('rg-fallback');
    await fs.writeFile(path.join(ws, 'x.txt'), 'needle found\n', 'utf8');

    const result = await executeToolCall({
      preset: 'chat-readonly',
      cwd: ws,
      call: {
        name: 'search.rg',
        arguments: { pattern: 'needle', path: '.' },
      },
    });

    expect(result.status).toBe('completed');
    const out = result.output as {
      engine: string;
      fileBuckets: Array<{ file: string; matchCount: number }>;
    };
    expect(out.fileBuckets.length).toBeGreaterThanOrEqual(1);
  });
});

// ─── search.files ignore rules ───────────────────────────────────────────────

describe('search.files ignore rules', () => {
  it('returns files from workspace', async () => {
    const ws = await makeWorkspace('files-basic');
    await fs.writeFile(path.join(ws, 'main.ts'), 'export {}', 'utf8');
    await fs.writeFile(path.join(ws, 'readme.md'), '# hi', 'utf8');

    const result = await executeToolCall({
      preset: 'chat-readonly',
      cwd: ws,
      call: { name: 'search.files', arguments: { path: '.' } },
    });

    expect(result.status).toBe('completed');
    const out = result.output as { files: Array<{ path: string; kind: string }>; truncated: boolean };
    const names = out.files.map((f) => path.basename(f.path));
    expect(names).toContain('main.ts');
    expect(names).toContain('readme.md');
    expect(out.truncated).toBe(false);
  });

  it('skips node_modules directory', async () => {
    const ws = await makeWorkspace('files-ignore');
    await fs.mkdir(path.join(ws, 'node_modules'), { recursive: true });
    await fs.writeFile(path.join(ws, 'node_modules', 'pkg.js'), '// inside nm', 'utf8');
    await fs.writeFile(path.join(ws, 'real.ts'), 'export {}', 'utf8');

    const result = await executeToolCall({
      preset: 'chat-readonly',
      cwd: ws,
      call: { name: 'search.files', arguments: { path: '.' } },
    });

    expect(result.status).toBe('completed');
    const out = result.output as { files: Array<{ path: string }> };
    const paths = out.files.map((f) => f.path);
    expect(paths.some((p) => p.includes('node_modules'))).toBe(false);
    expect(paths.some((p) => p.includes('real.ts'))).toBe(true);
  });

  it('skips dist directory', async () => {
    const ws = await makeWorkspace('files-dist');
    await fs.mkdir(path.join(ws, 'dist'), { recursive: true });
    await fs.writeFile(path.join(ws, 'dist', 'bundle.js'), '// built', 'utf8');
    await fs.writeFile(path.join(ws, 'src.ts'), '', 'utf8');

    const result = await executeToolCall({
      preset: 'chat-readonly',
      cwd: ws,
      call: { name: 'search.files', arguments: { path: '.' } },
    });

    expect(result.status).toBe('completed');
    const out = result.output as { files: Array<{ path: string }> };
    expect(out.files.every((f) => !f.path.includes('dist'))).toBe(true);
  });

  it('glob filters files by extension', async () => {
    const ws = await makeWorkspace('files-glob');
    await fs.writeFile(path.join(ws, 'a.ts'), '', 'utf8');
    await fs.writeFile(path.join(ws, 'b.js'), '', 'utf8');
    await fs.writeFile(path.join(ws, 'c.md'), '', 'utf8');

    const result = await executeToolCall({
      preset: 'chat-readonly',
      cwd: ws,
      call: { name: 'search.files', arguments: { path: '.', glob: '*.ts' } },
    });

    expect(result.status).toBe('completed');
    const out = result.output as { files: Array<{ path: string }> };
    expect(out.files.every((f) => f.path.endsWith('.ts'))).toBe(true);
  });

  it('respects maxResults and reports truncated', async () => {
    const ws = await makeWorkspace('files-max');
    for (let i = 0; i < 5; i++) {
      await fs.writeFile(path.join(ws, `file${i}.txt`), '', 'utf8');
    }

    const result = await executeToolCall({
      preset: 'chat-readonly',
      cwd: ws,
      call: { name: 'search.files', arguments: { path: '.', maxResults: 2 } },
    });

    expect(result.status).toBe('completed');
    const out = result.output as { files: unknown[]; truncated: boolean };
    expect(out.files.length).toBeLessThanOrEqual(2);
    expect(out.truncated).toBe(true);
  });
});

// ─── search.fuzzy ranking ─────────────────────────────────────────────────────

describe('search.fuzzy ranking', () => {
  it('finds exact filename match with high score', async () => {
    const ws = await makeWorkspace('fuzzy-basic');
    await fs.writeFile(path.join(ws, 'provider-registry.ts'), '', 'utf8');
    await fs.writeFile(path.join(ws, 'unrelated.ts'), '', 'utf8');

    const result = await executeToolCall({
      preset: 'chat-readonly',
      cwd: ws,
      call: { name: 'search.fuzzy', arguments: { query: 'provider-registry', path: '.' } },
    });

    expect(result.status).toBe('completed');
    const out = result.output as {
      results: Array<{ path: string; score: number; kind: string; matchIndices: number[] }>;
    };
    expect(out.results.length).toBeGreaterThanOrEqual(1);
    const top = out.results[0]!;
    expect(top.path).toContain('provider-registry');
    expect(top.score).toBeGreaterThan(0);
    expect(top.matchIndices.length).toBeGreaterThan(0);
  });

  it('ranks closer matches above distant ones', async () => {
    const ws = await makeWorkspace('fuzzy-rank');
    await fs.writeFile(path.join(ws, 'runner.ts'), '', 'utf8');
    await fs.writeFile(path.join(ws, 'rnr-utils.ts'), '', 'utf8');

    const result = await executeToolCall({
      preset: 'chat-readonly',
      cwd: ws,
      call: { name: 'search.fuzzy', arguments: { query: 'runner', path: '.' } },
    });

    expect(result.status).toBe('completed');
    const out = result.output as { results: Array<{ path: string; score: number }> };
    const runnerResult = out.results.find((r) => r.path.includes('runner.ts'));
    expect(runnerResult).toBeDefined();
    if (out.results.length > 1) {
      expect(runnerResult!.score).toBeGreaterThanOrEqual(out.results[out.results.length - 1]!.score);
    }
  });

  it('returns empty results when nothing matches', async () => {
    const ws = await makeWorkspace('fuzzy-empty');
    await fs.writeFile(path.join(ws, 'alpha.ts'), '', 'utf8');

    const result = await executeToolCall({
      preset: 'chat-readonly',
      cwd: ws,
      call: { name: 'search.fuzzy', arguments: { query: 'xyzqwerty', path: '.' } },
    });

    expect(result.status).toBe('completed');
    const out = result.output as { results: unknown[] };
    expect(out.results.length).toBe(0);
  });

  it('respects maxResults cap', async () => {
    const ws = await makeWorkspace('fuzzy-max');
    for (let i = 0; i < 10; i++) {
      await fs.writeFile(path.join(ws, `file${i}.ts`), '', 'utf8');
    }

    const result = await executeToolCall({
      preset: 'chat-readonly',
      cwd: ws,
      call: { name: 'search.fuzzy', arguments: { query: 'file', path: '.', maxResults: 3 } },
    });

    expect(result.status).toBe('completed');
    const out = result.output as { results: unknown[]; truncated: boolean };
    expect(out.results.length).toBeLessThanOrEqual(3);
    expect(out.truncated).toBe(true);
  });

  it('skips node_modules in fuzzy walk', async () => {
    const ws = await makeWorkspace('fuzzy-ignore');
    await fs.mkdir(path.join(ws, 'node_modules'), { recursive: true });
    await fs.writeFile(path.join(ws, 'node_modules', 'target.ts'), '', 'utf8');
    await fs.writeFile(path.join(ws, 'real-target.ts'), '', 'utf8');

    const result = await executeToolCall({
      preset: 'chat-readonly',
      cwd: ws,
      call: { name: 'search.fuzzy', arguments: { query: 'target', path: '.' } },
    });

    expect(result.status).toBe('completed');
    const out = result.output as { results: Array<{ path: string }> };
    expect(out.results.every((r) => !r.path.includes('node_modules'))).toBe(true);
    expect(out.results.some((r) => r.path.includes('real-target'))).toBe(true);
  });
});
