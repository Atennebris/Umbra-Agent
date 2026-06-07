import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildRepoMap, renderRepoMapMarkdown } from '../src/context/repo-map.js';

describe('buildRepoMap snapshots', () => {
  it('matches snapshot for a fixed project fixture', async () => {
    const projectDir = path.resolve(__dirname, 'fixtures/repo-map-project');
    const repoMap = await buildRepoMap(projectDir);

    // Clean up absolute paths for snapshot stability
    const stableRepoMap = {
      ...repoMap,
      rootPath: '<ROOT>',
      generatedAt: '2026-05-14T12:00:00.000Z',
      files: repoMap.files
        .sort((a, b) => a.path.localeCompare(b.path))
        .map((file) => ({
          ...file,
          symbols: file.symbols.sort((a, b) => a.name.localeCompare(b.name)),
        })),
    };

    expect(stableRepoMap).toMatchSnapshot();

    const markdown = renderRepoMapMarkdown(repoMap);
    expect(markdown).toMatchSnapshot();
  }, 15000);
});
