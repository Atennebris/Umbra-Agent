import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyAtSuggestion,
  buildProjectReferenceCatalog,
  getAtReferenceQuery,
  getAtSuggestions,
  loadProjectReferenceCatalog,
} from '../src/cli/tui/project-reference-index.js';

const createdDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    createdDirs.splice(0).map(async (directory) => {
      await fs.rm(directory, { recursive: true, force: true });
    }),
  );
});

describe('project-reference-index helpers', () => {
  it('builds directory and file catalog entries from project files', () => {
    expect(
      buildProjectReferenceCatalog(['src/cli/main.ts', 'src/cli/tui/ink-app.tsx', '.gitignore']),
    ).toEqual([
      { path: 'src', kind: 'directory' },
      { path: 'src/cli', kind: 'directory' },
      { path: 'src/cli/tui', kind: 'directory' },
      { path: '.gitignore', kind: 'file' },
      { path: 'src/cli/main.ts', kind: 'file' },
      { path: 'src/cli/tui/ink-app.tsx', kind: 'file' },
    ]);
  });

  it('extracts the active @ query only when the token is at the end', () => {
    expect(getAtReferenceQuery('check @src/cli/ma')).toBe('src/cli/ma');
    expect(getAtReferenceQuery('check @src/cli/main.ts then')).toBeNull();
  });

  it('returns matching file and directory suggestions (fuzzy)', () => {
    const catalog = buildProjectReferenceCatalog([
      'src/cli/main.ts',
      'src/cli/tui/ink-app.tsx',
      'tests/tui-utils.test.ts',
    ]);

    const results = getAtSuggestions('@src/c', catalog);
    // Strip matchIndices for order/content check
    expect(results.map((r) => ({ path: r.path, kind: r.kind }))).toEqual([
      { path: 'src/cli', kind: 'directory' },
      { path: 'src/cli/tui', kind: 'directory' },
      { path: 'src/cli/main.ts', kind: 'file' },
      { path: 'src/cli/tui/ink-app.tsx', kind: 'file' },
    ]);
    // Results include match indices
    for (const r of results) {
      expect(Array.isArray(r.matchIndices)).toBe(true);
    }
  });

  it('fuzzy matches non-prefix queries', () => {
    const catalog = buildProjectReferenceCatalog([
      'src/cli/main.ts',
      'src/cli/tui/ink-app.tsx',
      'tests/tui-utils.test.ts',
    ]);

    const results = getAtSuggestions('@main', catalog);
    const paths = results.map((r) => r.path);
    expect(paths).toContain('src/cli/main.ts');
    // Non-matching paths should not appear
    expect(paths).not.toContain('src/cli/tui');
  });

  it('applies selected @ suggestions into the input buffer', () => {
    expect(
      applyAtSuggestion('inspect @src/cl', {
        path: 'src/cli',
        kind: 'directory',
      }),
    ).toBe('inspect @src/cli/');

    expect(
      applyAtSuggestion('inspect @src/cli/main', {
        path: 'src/cli/main.ts',
        kind: 'file',
      }),
    ).toBe('inspect @src/cli/main.ts ');
  });

  it('ignores dist and node_modules entries when building the live catalog', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'umbra-reference-index-'));
    createdDirs.push(workspace);

    await fs.mkdir(path.join(workspace, 'src'), { recursive: true });
    await fs.mkdir(path.join(workspace, 'dist'), { recursive: true });
    await fs.mkdir(path.join(workspace, 'node_modules', 'pkg'), { recursive: true });
    await fs.writeFile(path.join(workspace, 'src', 'main.ts'), 'export {};', 'utf8');
    await fs.writeFile(path.join(workspace, 'dist', 'main.js'), 'export {};', 'utf8');
    await fs.writeFile(path.join(workspace, 'node_modules', 'pkg', 'index.js'), '', 'utf8');

    const catalog = await loadProjectReferenceCatalog(workspace);
    const paths = catalog.map((item) => item.path);

    expect(paths).toContain('src');
    expect(paths).toContain('src/main.ts');
    expect(paths).not.toContain('dist');
    expect(paths).not.toContain('dist/main.js');
    expect(paths).not.toContain('node_modules');
    expect(paths).not.toContain('node_modules/pkg/index.js');
  });
});
