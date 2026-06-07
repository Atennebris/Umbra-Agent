import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseDroppedPaths } from '../src/cli/tui/drop-paths.js';
import { parseFileReferences } from '../src/cli/tui/file-references.js';
import { imageFileToBase64 } from '../src/cli/tui/image-base64.js';
import { renderMarkdownToAnsi } from '../src/cli/tui/markdown.js';

const createdFiles: string[] = [];

afterEach(async () => {
  await Promise.all(
    createdFiles.splice(0).map(async (filePath) => {
      await fs.rm(filePath, { force: true });
    }),
  );
});

describe('TUI utilities', () => {
  it('parses dropped Windows and POSIX file paths from prompt text', () => {
    const paths = parseDroppedPaths(
      `Review "C:\\Work\\shot 01.png" and ./notes/todo.md plus /tmp/example.txt`,
    );

    expect(paths).toEqual(['C:\\Work\\shot 01.png', './notes/todo.md', '/tmp/example.txt']);
  });

  it('renders basic markdown into ANSI-styled output', () => {
    const rendered = renderMarkdownToAnsi('# Umbra\n- item with `code`');

    expect(rendered).toContain('Umbra');
    expect(rendered).toContain('-');
    expect(rendered).toContain('code');
  });

  it('extracts @file references for TUI context assembly', () => {
    const refs = parseFileReferences('Check @src/cli/main.ts and @"docs/rules.md" before patching');

    expect(refs).toEqual(['src/cli/main.ts', 'docs/rules.md']);
  });

  it('converts a local image into a Base64 payload', async () => {
    const filePath = path.join(os.tmpdir(), `umbra-image-${Date.now()}.png`);
    createdFiles.push(filePath);
    await fs.writeFile(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const result = await imageFileToBase64(filePath);

    expect(result.mimeType).toBe('image/png');
    expect(result.data.length).toBeGreaterThan(0);
  });
});
