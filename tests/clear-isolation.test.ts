/**
 * Tests: /clear isolation
 *
 * DoD for Phase 1 (/clear parity Codex CLI) and Phase 2 (thread lifecycle):
 *  - /clear calls POST /threads → a new threadId is minted by the daemon.
 *  - The new thread's sessionId is different from the previous thread's sessionId.
 *  - Runs submitted after /clear carry the new threadId, isolating model history.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HttpGateway } from '../src/core/http-gateway.js';
import type { TextEmbedder } from '../src/memory/embeddings.js';
import { resetMemoryManagerForTests, setMemoryManagerForTests } from '../src/memory/index.js';
import { MemoryManager } from '../src/memory/manager.js';
import { resetProviderCatalogForTests } from '../src/providers/index.js';

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

  if (originalUmbraHome === undefined) {
    process.env.UMBRA_HOME = undefined;
  } else {
    process.env.UMBRA_HOME = originalUmbraHome;
  }

  await Promise.all(
    createdDirs.splice(0).map(async (directory) => {
      await fs.rm(directory, { recursive: true, force: true });
    }),
  );
});

describe('/clear isolation — new thread on the daemon', () => {
  it('POST /threads twice yields two distinct threadIds and sessionIds', async () => {
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'umbra-clear-runtime-'));
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'umbra-clear-project-'));
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

    // Simulate the first conversation: create the initial thread.
    const firstResponse = await fetch(`http://127.0.0.1:${address.port}/threads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectPath: projectDir, title: 'First conversation' }),
    });
    expect(firstResponse.status).toBe(201);
    const firstThread = (await firstResponse.json()) as { id: string; sessionId: string };

    // Simulate what /clear does: create a brand-new thread.
    const clearResponse = await fetch(`http://127.0.0.1:${address.port}/threads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectPath: projectDir, title: 'New conversation' }),
    });
    expect(clearResponse.status).toBe(201);
    const newThread = (await clearResponse.json()) as { id: string; sessionId: string };

    // Thread identity must be different — /clear must not reuse the old thread.
    expect(newThread.id).not.toBe(firstThread.id);

    // Each thread owns a distinct session — model history is isolated.
    expect(newThread.sessionId).not.toBe(firstThread.sessionId);
    expect(typeof newThread.sessionId).toBe('string');
    expect(newThread.sessionId.length).toBeGreaterThan(0);

    // Both threads must be listed on the project (old thread stays in history).
    const listResponse = await fetch(
      `http://127.0.0.1:${address.port}/threads?projectPath=${encodeURIComponent(projectDir)}`,
    );
    expect(listResponse.status).toBe(200);
    const listed = (await listResponse.json()) as { threads: Array<{ id: string }> };
    const ids = listed.threads.map((t) => t.id);
    expect(ids).toContain(firstThread.id);
    expect(ids).toContain(newThread.id);
  });

  it('POST /threads with memory settings propagates flags to the new thread', async () => {
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'umbra-clear-mem-runtime-'));
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'umbra-clear-mem-project-'));
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

    const response = await fetch(`http://127.0.0.1:${address.port}/threads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectPath: projectDir,
        title: 'New conversation',
        useMemories: false,
        generateMemories: false,
      }),
    });
    expect(response.status).toBe(201);
    const thread = (await response.json()) as {
      id: string;
      sessionId: string;
      useMemories: boolean;
      generateMemories: boolean;
    };
    expect(thread.useMemories).toBe(false);
    expect(thread.generateMemories).toBe(false);
    expect(thread.id).toBeTruthy();
    expect(thread.sessionId).toBeTruthy();
  });
});

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
