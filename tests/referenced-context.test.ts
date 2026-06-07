import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { enrichPromptWithReferences } from '../src/cli/tui/referenced-context.js';

const createdDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    createdDirs.splice(0).map(async (directory) => {
      await fs.rm(directory, { recursive: true, force: true });
    }),
  );
});

describe('enrichPromptWithReferences', () => {
  it('injects referenced file contents into the prompt', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'umbra-reference-context-'));
    createdDirs.push(workspace);
    await fs.mkdir(path.join(workspace, 'src'), { recursive: true });
    await fs.writeFile(
      path.join(workspace, 'src', 'main.ts'),
      'export const value = 42;\n',
      'utf8',
    );

    const prompt = await enrichPromptWithReferences({
      prompt: 'Inspect @src/main.ts',
      projectPath: workspace,
      fileReferences: ['src/main.ts'],
      catalog: [{ path: 'src/main.ts', kind: 'file' }],
    });

    expect(prompt).toContain('Referenced project context:');
    expect(prompt).toContain('File: src/main.ts');
    expect(prompt).toContain('export const value = 42;');
  });

  it('lists directory children for directory references', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'umbra-reference-directory-'));
    createdDirs.push(workspace);

    const prompt = await enrichPromptWithReferences({
      prompt: 'Inspect @src/',
      projectPath: workspace,
      fileReferences: ['src/'],
      catalog: [
        { path: 'src', kind: 'directory' },
        { path: 'src/main.ts', kind: 'file' },
        { path: 'src/core/runtime.ts', kind: 'file' },
      ],
    });

    expect(prompt).toContain('Directory: src/');
    expect(prompt).toContain('- src/main.ts');
    expect(prompt).toContain('- src/core/runtime.ts');
  });
});
