import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { TextEmbedder } from '../src/memory/embeddings.js';
import { resetMemoryManagerForTests } from '../src/memory/index.js';
import { MemoryManager } from '../src/memory/manager.js';

const cleanupDirs: string[] = [];
const originalUmbraHome = process.env.UMBRA_HOME;

afterEach(async () => {
  resetMemoryManagerForTests();
  resetEnv('UMBRA_HOME', originalUmbraHome);

  await Promise.all(
    cleanupDirs.splice(0).map(async (directory) => {
      await fs.rm(directory, { recursive: true, force: true });
    }),
  );
});

describe('MemoryManager', () => {
  it('creates runtime layout, session JSONL, and project-scoped files outside the repo', async () => {
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'umbra-runtime-'));
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'umbra-project-'));
    cleanupDirs.push(runtimeDir, projectDir);
    process.env.UMBRA_HOME = runtimeDir;

    await fs.writeFile(
      path.join(projectDir, 'AGENTS.md'),
      '# Rules\n- keep tests green\n- no junk sqlite in repo\n',
      'utf8',
    );

    const manager = new MemoryManager(createTestEmbedder());
    manager.initialize();

    const { sessionId, projectPath } = await manager.registerTask({
      task: 'Fix daemon memory pipeline',
      context: {
        projectPath: projectDir,
      },
    });

    const status = manager.getStatus();
    const sessions = manager.listSessions(projectPath);
    const events = manager.readSessionEvents(sessionId);
    const projectContext = manager.getProjectContext(projectDir);
    const matches = await manager.findSimilarMemories(projectDir, 'memory pipeline daemon', 1);

    expect(status.runtimeHome).toBe(runtimeDir);
    expect(status.sessionsCount).toBe(1);
    expect(status.embeddingBackend).toBe('transformers-js');
    expect(sessions).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('user_message');
    expect(projectContext.agentsRules.path).toBe(path.join(projectDir, 'AGENTS.md'));
    expect(projectContext.memory).toBe('');
    expect(matches[0]?.content).toContain('Fix daemon memory pipeline');

    await expect(fs.access(path.join(runtimeDir, 'settings.json'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(runtimeDir, 'main.sqlite'))).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(runtimeDir, 'sessions', `${sessionId}.jsonl`)),
    ).resolves.toBeUndefined();

    manager.close();
  });

  it('supports thread lifecycle, draft persistence, export/import, and explicit memory flags', async () => {
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'umbra-runtime-'));
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'umbra-project-'));
    cleanupDirs.push(runtimeDir, projectDir);
    process.env.UMBRA_HOME = runtimeDir;

    const manager = new MemoryManager(createTestEmbedder());
    manager.initialize();

    const thread = manager.createThread({
      projectPath: projectDir,
      title: 'Alpha thread',
      useMemories: false,
      generateMemories: true,
    });
    manager.saveDraft(thread.id, 'draft payload');

    expect(manager.loadDraft(thread.id)).toBe('draft payload');
    expect(thread.useMemories).toBe(false);
    expect(thread.generateMemories).toBe(true);

    const registered = await manager.registerTask(
      {
        task: 'Remember the codename Bluebird.',
        context: {
          projectPath: projectDir,
          threadId: thread.id,
          sessionId: thread.sessionId,
        },
      },
      {
        useMemories: false,
        generateMemories: true,
      },
    );
    const summary = await manager.buildContextSummary({
      projectPath: projectDir,
      task: 'What codename did I mention?',
      threadId: registered.threadId,
      sessionId: registered.sessionId,
      useMemories: false,
    });
    const forked = manager.forkThread(thread.id, {
      projectPath: projectDir,
      title: 'Forked thread',
    });
    const exported = manager.exportThread(thread.id);
    const detected = manager.detectImportableSessions({
      paths: [exported.exportPath],
    });
    const imported = manager.importThread({
      filePath: exported.exportPath,
      projectPath: projectDir,
      title: 'Imported thread',
    });
    const reset = manager.resetMemories({
      threadId: thread.id,
    });

    expect(summary.memoryCitation.threadId).toBe(thread.id);
    expect(summary.memoryCitation.entries).toHaveLength(0);
    expect(forked.title).toBe('Forked thread');
    expect(forked.id).not.toBe(thread.id);
    expect(detected[0]?.filePath).toBe(exported.exportPath);
    expect(imported.title).toBe('Imported thread');
    expect(reset.threadId).toBe(thread.id);
    expect(reset.clearedVectors).toBeGreaterThan(0);

    manager.clearDraft(thread.id);
    expect(manager.loadDraft(thread.id)).toBe('');

    manager.close();
  });

  it('does not inject raw task vectors into prompt memory recall', async () => {
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'umbra-runtime-'));
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'umbra-project-'));
    cleanupDirs.push(runtimeDir, projectDir);
    process.env.UMBRA_HOME = runtimeDir;

    const manager = new MemoryManager(createTestEmbedder());
    manager.initialize();

    await manager.registerTask({
      task: 'Find the live weather in Chisinau.',
      context: {
        projectPath: projectDir,
      },
    });

    const rawMatches = await manager.findSimilarMemories(projectDir, 'weather Chisinau', 5);
    const summary = await manager.buildContextSummary({
      projectPath: projectDir,
      task: 'What did I ask you most recently?',
      useMemories: true,
    });

    expect(rawMatches.some((memory) => memory.sourceType === 'task')).toBe(true);
    expect(summary.similarMemoriesText).not.toContain('Find the live weather in Chisinau');
    expect(summary.memoryCitation.entries).toHaveLength(0);

    manager.close();
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
      const tokens = content.toLowerCase().split(/\W+/).filter(Boolean);

      for (const [index, token] of tokens.entries()) {
        values[index % 384] = token.length / 10;
      }

      return {
        model: 'test-model',
        dimensions: values.length,
        values,
      };
    },
  };
}
