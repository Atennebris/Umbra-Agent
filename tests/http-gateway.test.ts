import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HttpGateway, shouldLogDaemonRequest } from '../src/core/http-gateway.js';
import type { TextEmbedder } from '../src/memory/embeddings.js';
import { resetMemoryManagerForTests, setMemoryManagerForTests } from '../src/memory/index.js';
import { MemoryManager } from '../src/memory/manager.js';
import {
  DefaultProviderCatalog,
  ModelsRegistry,
  type ProviderCatalog,
  type ProviderCompleteRequest,
  type ProviderCompleteResponse,
  resetProviderCatalogForTests,
  setProviderCatalogForTests,
} from '../src/providers/index.js';

let gateway: HttpGateway | null = null;
const createdDirs: string[] = [];
const originalUmbraHome = process.env.UMBRA_HOME;

afterEach(async () => {
  if (gateway) {
    await gateway.stop();
    gateway = null;
  }

  resetMemoryManagerForTests();
  resetProviderCatalogForTests();
  resetEnv('UMBRA_HOME', originalUmbraHome);

  await Promise.all(
    createdDirs.splice(0).map(async (directory) => {
      await fs.rm(directory, { recursive: true, force: true });
    }),
  );
});

describe('HttpGateway', () => {
  it('filters noisy daemon polling paths from debug logs', () => {
    expect(shouldLogDaemonRequest('GET', '/health')).toBe(false);
    expect(shouldLogDaemonRequest('GET', '/usage/stats')).toBe(false);
    expect(shouldLogDaemonRequest('GET', '/runs/run-123')).toBe(false);
    expect(shouldLogDaemonRequest('GET', '/runs/run-123?verbose=true')).toBe(false);
    expect(shouldLogDaemonRequest('GET', '/runs/contracts')).toBe(true);
    expect(shouldLogDaemonRequest('POST', '/runs/run-123/stop')).toBe(true);
  });

  it('serves provider metadata and model capabilities from the backend catalog', async () => {
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'umbra-gateway-types-'));
    createdDirs.push(runtimeDir);
    process.env.UMBRA_HOME = runtimeDir;
    setProviderCatalogForTests(createTestProviderCatalog());
    gateway = new HttpGateway({ host: '127.0.0.1', port: 0 });
    await gateway.start();
    const address = gateway.address;

    if (!address || typeof address === 'string') {
      throw new Error('Expected an IPv4 address info object.');
    }

    const typesResponse = await fetch(`http://127.0.0.1:${address.port}/providers/types`);
    const typesPayload = (await typesResponse.json()) as Array<{ value: string }>;
    expect(typesResponse.status).toBe(200);
    expect(typesPayload).toEqual([{ value: 'openai' }, { value: 'anthropic' }]);

    const resolveResponse = await fetch(
      `http://127.0.0.1:${address.port}/providers/resolve?type=zen`,
    );
    const resolvePayload = (await resolveResponse.json()) as {
      available: boolean;
      resolvedType: string;
    };
    expect(resolveResponse.status).toBe(200);
    expect(resolvePayload.available).toBe(false);
    expect(resolvePayload.resolvedType).toBe('openai');
  });

  it('binds strictly to 127.0.0.1 and rejects invalid payloads with 400 Bad Request', async () => {
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'umbra-gateway-bind-'));
    createdDirs.push(runtimeDir);
    process.env.UMBRA_HOME = runtimeDir;
    gateway = new HttpGateway({ host: '127.0.0.1', port: 0 });
    await gateway.start();
    const address = gateway.address;

    if (!address || typeof address === 'string') {
      throw new Error('Expected an IPv4 address info object.');
    }

    // Verify it bound to 127.0.0.1
    expect(address.address).toBe('127.0.0.1');

    // Send an invalid payload (missing required fields for POST /runs)
    const badRunResponse = await fetch(`http://127.0.0.1:${address.port}/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'invalid_mode_without_threadId' }),
    });

    expect(badRunResponse.status).toBe(400);
    const errPayload = (await badRunResponse.json()) as Record<string, unknown>;
    expect(errPayload.error).toBeDefined();

    // Send malformed JSON
    const malformedResponse = await fetch(`http://127.0.0.1:${address.port}/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{ bad_json',
    });

    expect(malformedResponse.status).toBe(400);
  });

  it('serves the tools catalog, health, and execution endpoints', async () => {
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'umbra-tools-gateway-'));
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'umbra-tools-project-'));
    createdDirs.push(runtimeDir, projectDir);
    process.env.UMBRA_HOME = runtimeDir;

    const memoryManager = new MemoryManager(createTestEmbedder());
    memoryManager.initialize();
    setMemoryManagerForTests(memoryManager);

    gateway = new HttpGateway({ host: '127.0.0.1', port: 0 });
    await gateway.start();
    const address = gateway.address;

    if (!address || typeof address === 'string') {
      throw new Error('Expected an IPv4 address info object.');
    }

    const catalogResponse = await fetch(`http://127.0.0.1:${address.port}/tools`);
    const catalogPayload = (await catalogResponse.json()) as {
      presets: Array<{ id: string }>;
      tools: Array<{ name: string }>;
    };
    expect(catalogResponse.status).toBe(200);
    expect(catalogPayload.presets.map((preset) => preset.id)).toEqual([
      'chat-readonly',
      'agent-default',
      'exec-full',
    ]);
    expect(catalogPayload.tools.some((tool) => tool.name === 'fs.edit')).toBe(true);

    const healthResponse = await fetch(`http://127.0.0.1:${address.port}/tools/health`);
    const healthPayload = (await healthResponse.json()) as {
      tools: Array<{ tool: string; available: boolean }>;
    };
    expect(healthResponse.status).toBe(200);
    expect(healthPayload.tools.some((tool) => tool.tool === 'git')).toBe(true);

    const executeResponse = await fetch(`http://127.0.0.1:${address.port}/tools/execute`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        preset: 'exec-full',
        cwd: projectDir,
        call: {
          name: 'fs.write',
          arguments: {
            path: 'gateway.txt',
            content: 'gateway write',
          },
        },
      }),
    });
    const executePayload = (await executeResponse.json()) as {
      status: string;
      output?: { bytesWritten: number };
    };
    expect(executeResponse.status).toBe(200);
    expect(executePayload.status).toBe('completed');
    expect(executePayload.output?.bytesWritten).toBeGreaterThan(0);
    expect(await fs.readFile(path.join(projectDir, 'gateway.txt'), 'utf8')).toBe('gateway write');

    const blockedResponse = await fetch(`http://127.0.0.1:${address.port}/tools/execute`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        preset: 'chat-readonly',
        cwd: projectDir,
        call: {
          name: 'fs.write',
          arguments: {
            path: 'blocked.txt',
            content: 'blocked',
          },
        },
      }),
    });
    const blockedPayload = (await blockedResponse.json()) as {
      status: string;
      permission: { outcome: string };
    };
    expect(blockedResponse.status).toBe(409);
    expect(blockedPayload.status).toBe('blocked');
    expect(blockedPayload.permission.outcome).toBe('deny');
  });

  it('serves run contracts and completes a planning run through /runs', async () => {
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'umbra-runs-gateway-'));
    createdDirs.push(runtimeDir);
    process.env.UMBRA_HOME = runtimeDir;
    setProviderCatalogForTests(createRunTestProviderCatalog());
    const memoryManager = new MemoryManager(createTestEmbedder());
    memoryManager.initialize();
    setMemoryManagerForTests(memoryManager);

    gateway = new HttpGateway({ host: '127.0.0.1', port: 0 });
    await gateway.start();
    const address = gateway.address;

    if (!address || typeof address === 'string') {
      throw new Error('Expected an IPv4 address info object.');
    }

    const contractsResponse = await fetch(`http://127.0.0.1:${address.port}/runs/contracts`);
    const contractsPayload = (await contractsResponse.json()) as {
      modes: Array<{ mode: string; toolPreset: string | null }>;
    };
    expect(contractsResponse.status).toBe(200);
    expect(contractsPayload.modes.map((entry) => entry.mode)).toEqual(['plan', 'agent', 'exec']);

    const createResponse = await fetch(`http://127.0.0.1:${address.port}/runs`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        prompt: 'Plan the task',
        mode: 'plan',
      }),
    });
    const created = (await createResponse.json()) as { id: string };
    expect(createResponse.status).toBe(202);
    expect(created.id).toBeTruthy();

    let statusResponse = await fetch(`http://127.0.0.1:${address.port}/runs/${created.id}`);
    let runPayload = (await statusResponse.json()) as {
      status: string;
      result: { finalJson: { summary: string } } | null;
    };

    for (let attempt = 0; attempt < 20 && runPayload.status === 'running'; attempt += 1) {
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });
      statusResponse = await fetch(`http://127.0.0.1:${address.port}/runs/${created.id}`);
      runPayload = (await statusResponse.json()) as {
        status: string;
        result: { finalJson: { summary: string } } | null;
      };
    }

    expect(runPayload.status).toBe('completed');
    expect(runPayload.result?.finalJson.summary).toBe('Gateway plan');
  }, 15000);

  it('accepts POST tasks on localhost and persists a session', async () => {
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'umbra-gateway-runtime-'));
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'umbra-gateway-project-'));
    createdDirs.push(runtimeDir, projectDir);
    process.env.UMBRA_HOME = runtimeDir;
    const memoryManager = new MemoryManager(createTestEmbedder());
    memoryManager.initialize();
    setMemoryManagerForTests(memoryManager);

    gateway = new HttpGateway({ host: '127.0.0.1', port: 0 });
    await gateway.start();
    const address = gateway.address;

    if (!address || typeof address === 'string') {
      throw new Error('Expected an IPv4 address info object.');
    }

    const response = await fetch(`http://127.0.0.1:${address.port}/tasks`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ task: 'bootstrap daemon', context: { projectPath: projectDir } }),
    });

    expect(response.status).toBe(202);

    const payload = (await response.json()) as {
      task: string;
      status: string;
      projectPath?: string;
      sessionId?: string;
      contextSummary?: {
        repoFiles: number;
        repoSymbols: number;
        tokenReport: { totalTokens: number };
      };
    };
    expect(payload.task).toBe('bootstrap daemon');
    expect(payload.status).toBe('accepted');
    expect(payload.projectPath).toBe(projectDir);
    expect(payload.sessionId).toBeTruthy();
    expect(payload.contextSummary?.repoFiles).toBeGreaterThanOrEqual(0);
    expect(payload.contextSummary?.tokenReport.totalTokens).toBeGreaterThan(0);

    const health = await fetch(`http://127.0.0.1:${address.port}/health`);
    const healthPayload = (await health.json()) as {
      activeProvider: { id: string | null; label: string | null; model: string | null };
      memory: { sessionsCount: number; runtimeHome: string };
    };
    expect(healthPayload.activeProvider.id).toBeNull();
    expect(healthPayload.memory.sessionsCount).toBe(1);
    expect(healthPayload.memory.runtimeHome).toBe(runtimeDir);

    const sessionsResponse = await fetch(
      `http://127.0.0.1:${address.port}/sessions?projectPath=${encodeURIComponent(projectDir)}`,
    );
    const sessionsPayload = (await sessionsResponse.json()) as Array<{
      id: string;
      projectPath: string;
    }>;
    expect(sessionsPayload).toHaveLength(1);
    expect(sessionsPayload[0]?.id).toBe(payload.sessionId);

    await fetch(`http://127.0.0.1:${address.port}/tasks`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        task: 'second pass through session',
        context: {
          projectPath: projectDir,
          sessionId: payload.sessionId,
          fileReferences: ['src/context/context-engine.ts'],
        },
      }),
    });
    await fetch(`http://127.0.0.1:${address.port}/tasks`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        task: 'third pass with failure details',
        context: {
          projectPath: projectDir,
          sessionId: payload.sessionId,
          droppedPaths: ['C:\\tmp\\stderr.txt'],
        },
      }),
    });

    const compactResponse = await fetch(
      `http://127.0.0.1:${address.port}/sessions/${encodeURIComponent(String(payload.sessionId))}/compact`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({ projectPath: projectDir, instructions: 'keep failures' }),
      },
    );
    const compactPayload = (await compactResponse.json()) as {
      sessionId: string;
      oldTokens: number;
      newTokens: number;
      summary: string;
    };
    expect(compactResponse.status).toBe(200);
    expect(compactPayload.sessionId).toBe(payload.sessionId);
    expect(compactPayload.oldTokens).toBeGreaterThan(0);
    expect(compactPayload.newTokens).toBeGreaterThan(0);
    expect(compactPayload.summary).toContain('keep failures');
  });

  it('serves memory settings and thread lifecycle endpoints', async () => {
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'umbra-memory-gateway-'));
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'umbra-memory-project-'));
    createdDirs.push(runtimeDir, projectDir);
    process.env.UMBRA_HOME = runtimeDir;
    const memoryManager = new MemoryManager(createTestEmbedder());
    memoryManager.initialize();
    setMemoryManagerForTests(memoryManager);

    gateway = new HttpGateway({ host: '127.0.0.1', port: 0 });
    await gateway.start();
    const address = gateway.address;

    if (!address || typeof address === 'string') {
      throw new Error('Expected an IPv4 address info object.');
    }

    const createThreadResponse = await fetch(`http://127.0.0.1:${address.port}/threads`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        projectPath: projectDir,
        title: 'Gateway thread',
        useMemories: false,
      }),
    });
    const createdThread = (await createThreadResponse.json()) as {
      id: string;
      sessionId: string;
      useMemories: boolean;
    };
    expect(createThreadResponse.status).toBe(201);
    expect(createdThread.useMemories).toBe(false);

    const settingsResponse = await fetch(`http://127.0.0.1:${address.port}/memory/settings`);
    const settings = (await settingsResponse.json()) as { draftPersistence: boolean };
    expect(settingsResponse.status).toBe(200);
    expect(settings.draftPersistence).toBe(true);

    const updateSettingsResponse = await fetch(`http://127.0.0.1:${address.port}/memory/settings`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        draftPersistence: false,
      }),
    });
    const updatedSettings = (await updateSettingsResponse.json()) as {
      draftPersistence: boolean;
    };
    expect(updateSettingsResponse.status).toBe(200);
    expect(updatedSettings.draftPersistence).toBe(false);

    const webSettingsResponse = await fetch(`http://127.0.0.1:${address.port}/web/settings`);
    const webSettings = (await webSettingsResponse.json()) as {
      mode: string;
      providerId: string;
    };
    expect(webSettingsResponse.status).toBe(200);
    expect(webSettings.mode).toBe('live');
    expect(webSettings.providerId).toBe('ddg');

    const updateWebResponse = await fetch(`http://127.0.0.1:${address.port}/web/settings`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        mode: 'cached',
      }),
    });
    const updatedWeb = (await updateWebResponse.json()) as { mode: string; enabled: boolean };
    expect(updateWebResponse.status).toBe(200);
    expect(updatedWeb.mode).toBe('cached');
    expect(updatedWeb.enabled).toBe(true);

    const healthAfterWeb = await fetch(`http://127.0.0.1:${address.port}/health`);
    const healthAfterWebPayload = (await healthAfterWeb.json()) as {
      webSearch: { mode: string };
    };
    expect(healthAfterWebPayload.webSearch.mode).toBe('cached');

    const updateThreadResponse = await fetch(
      `http://127.0.0.1:${address.port}/threads/${encodeURIComponent(createdThread.id)}/settings`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          projectPath: projectDir,
          useMemories: true,
          generateMemories: false,
        }),
      },
    );
    const updatedThread = (await updateThreadResponse.json()) as {
      id: string;
      useMemories: boolean;
      generateMemories: boolean;
    };
    expect(updateThreadResponse.status).toBe(200);
    expect(updatedThread.useMemories).toBe(true);
    expect(updatedThread.generateMemories).toBe(false);

    const resumeResponse = await fetch(
      `http://127.0.0.1:${address.port}/threads/${encodeURIComponent(createdThread.id)}/resume`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          projectPath: projectDir,
        }),
      },
    );
    const resumedThread = (await resumeResponse.json()) as { id: string; sessionId: string };
    expect(resumeResponse.status).toBe(200);
    expect(resumedThread.id).toBe(createdThread.id);

    const exportResponse = await fetch(
      `http://127.0.0.1:${address.port}/threads/${encodeURIComponent(createdThread.id)}/export`,
      {
        method: 'POST',
      },
    );
    const exportPayload = (await exportResponse.json()) as {
      exportPath: string;
      thread: { id: string };
    };
    expect(exportResponse.status).toBe(200);
    expect(exportPayload.thread.id).toBe(createdThread.id);

    const detectResponse = await fetch(`http://127.0.0.1:${address.port}/threads/detect`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        paths: [exportPayload.exportPath],
      }),
    });
    const detectPayload = (await detectResponse.json()) as {
      candidates: Array<{ filePath: string }>;
    };
    expect(detectResponse.status).toBe(200);
    expect(detectPayload.candidates[0]?.filePath).toBe(exportPayload.exportPath);

    const importResponse = await fetch(`http://127.0.0.1:${address.port}/threads/import`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        filePath: exportPayload.exportPath,
        projectPath: projectDir,
        title: 'Imported gateway thread',
      }),
    });
    const importedThread = (await importResponse.json()) as { title: string; id: string };
    expect(importResponse.status).toBe(201);
    expect(importedThread.title).toBe('Imported gateway thread');
    expect(importedThread.id).not.toBe(createdThread.id);
  });

  it('supports provider profile CRUD and provider model endpoints', async () => {
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'umbra-provider-gateway-'));
    createdDirs.push(runtimeDir);
    process.env.UMBRA_HOME = runtimeDir;

    const memoryManager = new MemoryManager(createTestEmbedder());
    memoryManager.initialize();
    setMemoryManagerForTests(memoryManager);

    setProviderCatalogForTests(
      new DefaultProviderCatalog({
        modelsRegistry: new ModelsRegistry({
          datasetLoader: async () => ({}),
        }),
        fetcher: createMockFetch({
          'http://127.0.0.1:11434/api/tags': {
            models: [{ name: 'qwen3:latest', context_length: 131072 }],
          },
          'http://127.0.0.1:11434/v1/chat/completions': {
            choices: [
              {
                finish_reason: 'stop',
                message: {
                  content: 'ollama ok',
                },
              },
            ],
          },
        }),
      }),
    );
    gateway = new HttpGateway({ host: '127.0.0.1', port: 0 });
    await gateway.start();
    const address = gateway.address;

    if (!address || typeof address === 'string') {
      throw new Error('Expected an IPv4 address info object.');
    }

    const createResponse = await fetch(`http://127.0.0.1:${address.port}/providers/profiles`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        type: 'ollama',
        label: 'Local Ollama',
        model: 'qwen3:latest',
        makeDefault: true,
      }),
    });
    const created = (await createResponse.json()) as {
      id: string;
      baseUrl: string;
      status: string;
    };
    expect(createResponse.status).toBe(201);
    expect(created.baseUrl).toBe('http://127.0.0.1:11434/v1');
    expect(created.status).toBe('connected');

    const listResponse = await fetch(`http://127.0.0.1:${address.port}/providers/profiles`);
    const listed = (await listResponse.json()) as {
      profiles: Array<{ id: string }>;
      defaultProfileId: string;
      activeProfileId: string;
    };
    expect(listResponse.status).toBe(200);
    expect(listed.profiles).toHaveLength(1);
    expect(listed.defaultProfileId).toBe(created.id);
    expect(listed.activeProfileId).toBe(created.id);

    const modelsResponse = await fetch(
      `http://127.0.0.1:${address.port}/providers/profiles/${created.id}/models`,
    );
    const modelsPayload = (await modelsResponse.json()) as {
      models: Array<{ id: string; contextWindow: number }>;
    };
    expect(modelsResponse.status).toBe(200);
    expect(modelsPayload.models[0]?.id).toBe('qwen3:latest');
    expect(modelsPayload.models[0]?.contextWindow).toBe(131072);

    const testResponse = await fetch(
      `http://127.0.0.1:${address.port}/providers/profiles/${created.id}/test`,
      { method: 'POST' },
    );
    const testPayload = (await testResponse.json()) as { ok: boolean; message: string };
    expect(testResponse.status).toBe(200);
    expect(testPayload.ok).toBe(true);
    expect(testPayload.message).toContain('1 model(s) available');

    const completeResponse = await fetch(
      `http://127.0.0.1:${address.port}/providers/profiles/${created.id}/complete`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'ping' }],
        }),
      },
    );
    const completePayload = (await completeResponse.json()) as {
      outputText: string;
      model: string;
    };
    expect(completeResponse.status).toBe(200);
    expect(completePayload.outputText).toBe('ollama ok');
    expect(completePayload.model).toBe('qwen3:latest');

    const defaultsResponse = await fetch(
      `http://127.0.0.1:${address.port}/providers/default-models`,
    );
    const defaultsPayload = (await defaultsResponse.json()) as {
      defaultProfileId: string;
      fallbackProfileId: string;
      activeProfileId: string;
      profiles: Array<{ model: string }>;
    };
    expect(defaultsResponse.status).toBe(200);
    expect(defaultsPayload.defaultProfileId).toBe(created.id);
    expect(defaultsPayload.fallbackProfileId).toBe(created.id);
    expect(defaultsPayload.activeProfileId).toBe(created.id);
    expect(defaultsPayload.profiles[0]?.model).toBe('qwen3:latest');

    const healthResponse = await fetch(`http://127.0.0.1:${address.port}/health`);
    const healthPayload = (await healthResponse.json()) as {
      activeProvider: { id: string | null; label: string | null; model: string | null };
    };
    expect(healthPayload.activeProvider.id).toBe(created.id);
    expect(healthPayload.activeProvider.label).toBe('Local Ollama');
    expect(healthPayload.activeProvider.model).toBe('qwen3:latest');

    const updateResponse = await fetch(
      `http://127.0.0.1:${address.port}/providers/profiles/${created.id}`,
      {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({ enabled: false }),
      },
    );
    const updated = (await updateResponse.json()) as { status: string; enabled: boolean };
    expect(updateResponse.status).toBe(200);
    expect(updated.status).toBe('available');
    expect(updated.enabled).toBe(false);

    const deleteResponse = await fetch(
      `http://127.0.0.1:${address.port}/providers/profiles/${created.id}`,
      {
        method: 'DELETE',
      },
    );
    const deleted = (await deleteResponse.json()) as {
      profiles: unknown[];
      defaultProfileId: null;
    };
    expect(deleteResponse.status).toBe(200);
    expect(deleted.profiles).toEqual([]);
    expect(deleted.defaultProfileId).toBeNull();
  });
});

function resetEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}

function createTestEmbedder(): TextEmbedder {
  return {
    getStatus() {
      return {
        backend: 'transformers-js',
        model: 'test-model',
        ready: true,
        modelDir: 'test-model-dir',
        cacheDir: 'test-cache-dir',
        lastError: null,
      };
    },
    startWarmup() {},
    async embedText(content: string) {
      const values = new Array<number>(384).fill(0);
      values[0] = content.length / 100;
      values[1] = 1;

      return {
        model: 'test-model',
        dimensions: values.length,
        values,
      };
    },
  };
}

function createTestProviderCatalog(): ProviderCatalog {
  return {
    listTypes() {
      return [{ value: 'openai' }, { value: 'anthropic' }] as ReturnType<
        ProviderCatalog['listTypes']
      >;
    },
    resolveType(providerType) {
      const knownTypes = ['openai', 'anthropic'];
      if (!knownTypes.includes(providerType)) {
        return {
          requestedType: providerType,
          normalizedType: providerType,
          available: false,
          resolvedType: 'openai',
          fallbackType: 'openai',
          reason: `Provider type "${providerType}" is unknown.`,
        };
      }

      return {
        requestedType: providerType,
        normalizedType: providerType,
        available: true,
        resolvedType: providerType,
        fallbackType: null,
        reason: null,
      };
    },
    async getModelCapabilities(modelId) {
      return {
        modelId,
        normalizedModelId: modelId,
        matchedModelId: null,
        source: 'heuristic',
        contextWindow: null,
        supportsTools: true,
        supportsVision: false,
        supportsReasoning: true,
        supportsStructuredOutput: true,
        supportsAttachments: false,
        supportsTemperature: true,
        longContext: false,
        interleaved: 'reasoning_content',
        inputModalities: ['text'],
        outputModalities: ['text'],
      };
    },
  };
}

function createRunTestProviderCatalog(): ProviderCatalog {
  return {
    ...createTestProviderCatalog(),
    listProfiles() {
      return {
        profiles: [
          {
            id: 'profile-1',
            type: 'openai',
            normalizedType: 'openai',
            label: 'Gateway Test Provider',
            baseUrl: 'http://127.0.0.1',
            model: 'gpt-test',
            enabled: true,
            extraHeaders: {},
            options: {},
            hasApiKey: false,
            needsKey: false,
            keyOptional: true,
            keyHint: '',
            cloud: true,
            available: true,
            status: 'connected',
            fallbackType: null,
            fallbackProfileId: null,
            reason: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
        defaultProfileId: 'profile-1',
        fallbackProfileId: 'profile-1',
        activeProfileId: 'profile-1',
      };
    },
    async completeProfile(
      _profileId: string,
      request: ProviderCompleteRequest,
    ): Promise<ProviderCompleteResponse> {
      return {
        providerProfileId: 'profile-1',
        providerType: 'openai',
        model: request.model ?? 'gpt-test',
        outputText: JSON.stringify({
          summary: 'Gateway plan',
          steps: [
            {
              id: 'step-1',
              title: 'Inspect',
              reason: 'Need context',
              files: ['src/index.ts'],
              checks: ['pnpm test'],
            },
          ],
        }),
        outputJson: {
          summary: 'Gateway plan',
          steps: [{ id: 'step-1', title: 'Inspect' }],
        },
        toolCalls: [],
        stopReason: 'stop',
      };
    },
  };
}

function createMockFetch(routes: Record<string, unknown>): typeof fetch {
  return (async (input: URL | RequestInfo, _init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const payload = routes[url];

    if (payload === undefined) {
      return new Response(JSON.stringify({ error: 'not mocked' }), {
        status: 404,
        headers: {
          'content-type': 'application/json',
        },
      });
    }

    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: {
        'content-type': 'application/json',
      },
    });
  }) as typeof fetch;
}
