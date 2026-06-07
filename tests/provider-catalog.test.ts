import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DefaultProviderCatalog, ModelsRegistry } from '../src/providers/index.js';

const createdDirs: string[] = [];
const originalUmbraHome = process.env.UMBRA_HOME;

afterEach(async () => {
  resetEnv('UMBRA_HOME', originalUmbraHome);

  await Promise.all(
    createdDirs.splice(0).map(async (directory) => {
      await fs.rm(directory, { recursive: true, force: true });
    }),
  );
});

describe('provider catalog', () => {
  it('stores provider profiles in runtime state and computes defaults/fallbacks', async () => {
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'umbra-provider-runtime-'));
    createdDirs.push(runtimeDir);
    process.env.UMBRA_HOME = runtimeDir;

    const catalog = new DefaultProviderCatalog({
      modelsRegistry: new ModelsRegistry({
        datasetLoader: async () => ({}),
      }),
      fetcher: createMockFetch({
        'https://api.openai.com/v1/models': {
          data: [{ id: 'gpt-5', name: 'GPT-5', context_window: 400000 }],
        },
        'https://api.openai.com/v1/responses': {
          status: 'completed',
          output: [
            {
              type: 'message',
              content: [
                {
                  type: 'output_text',
                  text: '{"result":"ok"}',
                },
              ],
            },
          ],
        },
      }),
    });

    const created = catalog.createProfile({
      type: 'openai',
      label: 'Primary OpenAI',
      apiKey: 'sk-test',
      model: 'gpt-5',
      makeDefault: true,
    });

    expect(created.type).toBe('openai');
    expect(created.baseUrl).toBe('https://api.openai.com/v1');
    expect(created.hasApiKey).toBe(true);
    expect(created.status).toBe('connected');

    const listed = catalog.listProfiles();
    expect(listed.defaultProfileId).toBe(created.id);
    expect(listed.fallbackProfileId).toBe(created.id);
    expect(listed.activeProfileId).toBe(created.id);
    expect(listed.profiles).toHaveLength(1);

    const defaults = catalog.getDefaults();
    expect(defaults.defaultProfileId).toBe(created.id);
    expect(defaults.profiles[0]?.model).toBe('gpt-5');

    const models = await catalog.listProfileModels(created.id);
    expect(models).toEqual([{ id: 'gpt-5', name: 'GPT-5', contextWindow: 400000 }]);

    const tested = await catalog.testProfile(created.id);
    expect(tested.ok).toBe(true);
    expect(tested.message).toContain('1 model(s) available');

    const completed = await catalog.completeProfile(created.id, {
      messages: [{ role: 'user', content: 'say ok' }],
      responseFormat: {
        type: 'json_schema',
        name: 'completion_result',
        schema: {
          type: 'object',
          properties: {
            result: { type: 'string' },
          },
          required: ['result'],
        },
      },
    });
    expect(completed.outputJson).toEqual({ result: 'ok' });
    expect(completed.providerType).toBe('openai');
  });

  it('rejects unknown provider types for new profiles', async () => {
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'umbra-provider-runtime-'));
    createdDirs.push(runtimeDir);
    process.env.UMBRA_HOME = runtimeDir;

    const catalog = new DefaultProviderCatalog({
      modelsRegistry: new ModelsRegistry({
        datasetLoader: async () => ({}),
      }),
    });

    expect(() =>
      catalog.createProfile({
        type: 'ghost',
        label: 'Unknown Provider',
      }),
    ).toThrow('Provider type "ghost" is unknown.');
  });

  it('marks invalid cloud/custom profiles unavailable until required fields are present', async () => {
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'umbra-provider-runtime-'));
    createdDirs.push(runtimeDir);
    process.env.UMBRA_HOME = runtimeDir;

    const catalog = new DefaultProviderCatalog({
      modelsRegistry: new ModelsRegistry({
        datasetLoader: async () => ({}),
      }),
    });

    const created = catalog.createProfile({
      type: 'openai_compatible',
      label: 'Custom Empty',
      baseUrl: 'http://127.0.0.1:8081/v1',
    });
    expect(created.status).toBe('unavailable');
    expect(created.reason).toContain('missing apiKey');
  });

  it('uses mistral through the OpenAI-compatible runtime adapter', async () => {
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'umbra-provider-runtime-'));
    createdDirs.push(runtimeDir);
    process.env.UMBRA_HOME = runtimeDir;

    const catalog = new DefaultProviderCatalog({
      modelsRegistry: new ModelsRegistry({
        datasetLoader: async () => ({}),
      }),
      fetcher: createMockFetch({
        'https://api.mistral.ai/v1/models': {
          data: [
            {
              id: 'mistral-medium-latest',
              name: 'Mistral Medium Latest',
              max_context_length: 131072,
              capabilities: {
                completion_chat: true,
                function_calling: true,
                vision: false,
              },
              archived: false,
              deprecation: null,
            },
            {
              id: 'mistral-medium-latest',
              name: 'Mistral Medium Latest duplicate',
              max_context_length: 32768,
              capabilities: {
                completion_chat: true,
                function_calling: false,
                vision: false,
              },
              archived: false,
              deprecation: null,
            },
            {
              id: 'mistral-embed-2312',
              max_context_length: 8192,
              capabilities: {
                completion_chat: false,
                function_calling: false,
                vision: false,
              },
              archived: false,
              deprecation: null,
            },
          ],
        },
        'https://api.mistral.ai/v1/chat/completions': {
          choices: [
            {
              finish_reason: 'stop',
              message: {
                content: 'mistral ok',
              },
            },
          ],
        },
      }),
    });

    const mistral = catalog.createProfile({
      type: 'mistral',
      label: 'Mistral',
      apiKey: 'mistral-test',
      model: 'mistral-medium-latest',
    });

    const models = await catalog.listProfileModels(mistral.id);
    expect(models[0]?.id).toBe('mistral-medium-latest');
    expect(models[0]?.contextWindow).toBe(131072);
    expect(models[0]?.tags).toContain('tools');
    expect(models.some((entry) => entry.id === 'mistral-embed-2312')).toBe(false);

    const completed = await catalog.completeProfile(mistral.id, {
      messages: [{ role: 'user', content: 'ping' }],
    });
    expect(completed.providerType).toBe('mistral');
    expect(completed.outputText).toBe('mistral ok');
  });
});

function createMockFetch(
  routes: Record<string, unknown>,
  seenHeaders?: Record<string, string>,
): typeof fetch {
  return (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const payload = routes[url];

    if (seenHeaders) {
      const headers = new Headers(init?.headers);

      for (const [key, value] of headers.entries()) {
        seenHeaders[key] = value;
      }
    }

    if (payload === undefined) {
      return new Response(JSON.stringify({ error: 'not mocked' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }

    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

function resetEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}
