import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type RuntimeSettings, loadRuntimeSettings } from '../src/memory/settings-store.js';
import {
  executeToolCall,
  getWebSearchSettings,
  updateWebSearchSettings,
} from '../src/tools/index.js';
import { WebSearchService, setWebSearchServiceForTests } from '../src/tools/web-search.js';

const createdDirs: string[] = [];
const originalUmbraHome = process.env.UMBRA_HOME;

afterEach(async () => {
  setWebSearchServiceForTests(null);
  if (originalUmbraHome === undefined) {
    process.env.UMBRA_HOME = '';
  } else {
    process.env.UMBRA_HOME = originalUmbraHome;
  }

  await Promise.all(
    createdDirs.splice(0).map(async (directory) => {
      await fs.rm(directory, { recursive: true, force: true });
    }),
  );
});

describe('web search', () => {
  it('refuses direct tool execution while web mode is off', async () => {
    setWebSearchServiceForTests(
      new WebSearchService({
        settingsLoader: () => makeSettings('off'),
      }),
    );

    const result = await executeToolCall({
      preset: 'exec-full',
      cwd: process.cwd(),
      call: {
        name: 'web.search',
        arguments: {
          query: 'latest TypeScript release',
        },
      },
    });

    expect(result.status).toBe('failed');
    expect(result.error).toContain('disabled');
  });

  it('parses a fake Brave response into a stable machine-readable payload', async () => {
    setWebSearchServiceForTests(
      new WebSearchService({
        settingsLoader: () => makeSettings('cached'),
        fetcher: async () =>
          new Response(
            JSON.stringify({
              web: {
                results: [
                  {
                    title: 'TypeScript 5.9',
                    url: 'https://devblogs.microsoft.com/typescript/5-9/',
                    description: 'Release notes',
                    extra_snippets: ['Faster builds', 'Improved tooling'],
                  },
                ],
              },
            }),
            {
              status: 200,
              headers: {
                'content-type': 'application/json',
              },
            },
          ),
      }),
    );

    const result = await executeToolCall({
      preset: 'exec-full',
      cwd: process.cwd(),
      call: {
        name: 'web.search',
        arguments: {
          query: 'latest TypeScript release',
          maxResults: 3,
        },
      },
    });

    expect(result.status).toBe('completed');
    expect(result.output).toMatchObject({
      mode: 'cached',
      providerId: 'brave',
      results: [
        {
          rank: 1,
          title: 'TypeScript 5.9',
          url: 'https://devblogs.microsoft.com/typescript/5-9/',
        },
      ],
    });
  });

  it('returns a clear provider-auth error when the backend rejects credentials', async () => {
    setWebSearchServiceForTests(
      new WebSearchService({
        settingsLoader: () => makeSettings('live'),
        fetcher: async () =>
          new Response(JSON.stringify({ error: { message: 'Unauthorized' } }), {
            status: 401,
            headers: {
              'content-type': 'application/json',
            },
          }),
      }),
    );

    const result = await executeToolCall({
      preset: 'exec-full',
      cwd: process.cwd(),
      call: {
        name: 'web.search',
        arguments: {
          query: 'OpenAI Codex CLI reference',
        },
      },
    });

    expect(result.status).toBe('failed');
    expect(result.error).toContain('rejected the API key');
  });

  it('persists mode and provider selection in the runtime settings store', async () => {
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'umbra-web-settings-'));
    createdDirs.push(runtimeDir);
    process.env.UMBRA_HOME = runtimeDir;

    const initial = getWebSearchSettings();
    expect(initial.mode).toBe('off');
    expect(initial.providerId).toBe('ddg');

    // Set a fake API key so the auto-migration doesn't switch tavily → jina
    process.env.TAVILY_API_KEY = 'test-key-for-migration';
    updateWebSearchSettings({ mode: 'live', providerId: 'tavily' });

    const stored = loadRuntimeSettings();
    expect(stored.webSearch.mode).toBe('live');
    expect(stored.webSearch.providerId).toBe('tavily');

    const next = getWebSearchSettings();
    expect(next.mode).toBe('live');
    expect(next.providerId).toBe('tavily');

    process.env.TAVILY_API_KEY = undefined;
  });
});

function makeSettings(mode: RuntimeSettings['webSearch']['mode']): RuntimeSettings {
  return {
    version: 1,
    defaultProjectPath: null,
    memories: {
      useMemories: true,
      generateMemories: true,
      draftPersistence: true,
    },
    compression: {
      level: 'standard',
    },
    vectorStore: {
      backend: 'better-sqlite3+sqlite-vec',
      sqliteVecModulePath: null,
    },
    embeddings: {
      backend: 'transformers-js',
      model: 'onnx-community/all-MiniLM-L6-v2-ONNX',
      transformersModulePath: null,
      autoDownloadEnabled: true,
    },
    tools: {
      customPaths: {},
    },
    webSearch: {
      mode,
      providerId: 'brave',
      providers: {
        brave: {
          apiKey: 'test-key',
          baseUrl: null,
        },
        tavily: {
          apiKey: 'test-key',
          baseUrl: null,
        },
      },
    },
  };
}
