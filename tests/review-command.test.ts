/**
 * Phase 12.8 — Built-in Code Review (`/review`) tests.
 *
 * DoD:
 * - Review output: mock git diff → structured response contains findings with file:line refs.
 * - Context isolation: /review does NOT write to session events.
 * - Round-trip settings: reviewProvider/reviewModel persist across reads.
 * - Default path: reviewProvider=null → /review still responds without errors.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ReviewResult } from '../src/core/contracts.js';
import { HttpGateway } from '../src/core/http-gateway.js';
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
  if (originalUmbraHome !== undefined) {
    process.env.UMBRA_HOME = originalUmbraHome;
  } else {
    process.env.UMBRA_HOME = undefined;
  }
  await Promise.all(
    createdDirs.splice(0).map(async (d) => {
      await fs.rm(d, { recursive: true, force: true });
    }),
  );
});

function resetEnv(key: string, original: string | undefined) {
  if (original !== undefined) {
    process.env[key] = original;
  } else {
    delete process.env[key];
  }
}

function createTestEmbedder(): TextEmbedder {
  return {
    getStatus() {
      return {
        backend: 'transformers-js',
        model: 'test-model',
        ready: true,
        modelDir: 'test-dir',
        cacheDir: 'test-cache',
        lastError: null,
      };
    },
    startWarmup() {},
    async embedText(content: string) {
      const values = new Array<number>(384).fill(0);
      values[0] = content.length / 100;
      return { model: 'test-model', dimensions: values.length, values };
    },
  };
}

/** Fixed ReviewResult the mock LLM always returns */
const MOCK_REVIEW_RESULT: ReviewResult = {
  findings: [
    {
      title: '[P2] Missing null check before property access',
      body: 'The variable `foo` can be null when the list is empty, causing a TypeError at runtime.',
      confidence_score: 0.87,
      priority: 2,
      code_location: {
        absolute_file_path: '/tmp/test-repo/src/index.ts',
        line_range: { start: 12, end: 14 },
      },
    },
  ],
  overall_correctness: 'patch is incorrect',
  overall_explanation: 'The patch introduces a potential null dereference in the hot path.',
  overall_confidence_score: 0.85,
};

function createReviewProviderCatalog(): ProviderCatalog {
  const base = new DefaultProviderCatalog();
  return {
    ...base,
    listProfiles() {
      return {
        profiles: [
          {
            id: 'review-profile',
            type: 'openai',
            normalizedType: 'openai',
            label: 'Review Test Provider',
            baseUrl: 'http://127.0.0.1',
            model: 'gpt-review',
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
        defaultProfileId: 'review-profile',
        fallbackProfileId: 'review-profile',
        activeProfileId: 'review-profile',
      };
    },
    async completeProfile(
      _profileId: string,
      _request: ProviderCompleteRequest,
    ): Promise<ProviderCompleteResponse> {
      return {
        providerProfileId: 'review-profile',
        providerType: 'openai',
        model: 'gpt-review',
        outputText: JSON.stringify(MOCK_REVIEW_RESULT),
        outputJson: MOCK_REVIEW_RESULT,
        toolCalls: [],
        stopReason: 'stop',
      };
    },
    resolveModelCapabilities(_model: string) {
      return {
        modelId: _model,
        normalizedModelId: _model,
        matchedModelId: null,
        source: 'heuristic' as const,
        contextWindow: 8192,
        supportsTools: true,
        supportsVision: false,
        supportsReasoning: false,
        supportsStructuredOutput: true,
        supportsAttachments: false,
        supportsTemperature: true,
        longContext: false,
        interleaved: null,
        inputModalities: ['text'],
        outputModalities: ['text'],
      };
    },
  };
}

/** Creates a minimal git repo with one staged file for testing. */
async function createTempGitRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'umbra-review-repo-'));
  createdDirs.push(dir);

  const run = (args: string[]) =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' });

  run(['init']);
  run(['config', 'user.email', 'test@test.com']);
  run(['config', 'user.name', 'Test']);

  // Initial commit so HEAD exists
  await fs.writeFile(path.join(dir, 'README.md'), '# Test\n');
  run(['add', 'README.md']);
  run(['commit', '-m', 'init']);

  // Add a new file and stage it
  await fs.mkdir(path.join(dir, 'src'), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'src/index.ts'),
    'export function foo(list: string[]) {\n  return list[0].length;\n}\n',
  );
  run(['add', 'src/index.ts']);

  return dir;
}

// ───────── Settings round-trip tests ─────────

describe('/review settings round-trip', () => {
  let tempHome: string;
  let origHome: string | undefined;

  beforeEach(async () => {
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'umbra-review-settings-'));
    createdDirs.push(tempHome);
    origHome = process.env.UMBRA_HOME;
    process.env.UMBRA_HOME = tempHome;
  });

  afterEach(() => {
    resetEnv('UMBRA_HOME', origHome);
  });

  it('Default path: getReviewSettings returns null/null when nothing saved', async () => {
    const { getReviewSettings } = await import('../src/core/runtime-preferences.js');
    const s = getReviewSettings();
    expect(s.provider).toBeNull();
    expect(s.model).toBeNull();
  });

  it('saves custom provider and model, reads them back', async () => {
    const { setReviewSettings, getReviewSettings } = await import(
      '../src/core/runtime-preferences.js'
    );
    setReviewSettings('my-review-provider', 'review-model-v1');
    const s = getReviewSettings();
    expect(s.provider).toBe('my-review-provider');
    expect(s.model).toBe('review-model-v1');
  });

  it('persists across re-read (simulates restart)', async () => {
    const { setReviewSettings } = await import('../src/core/runtime-preferences.js');
    setReviewSettings('persisted-provider', 'persisted-model');
    const { getReviewSettings } = await import('../src/core/runtime-preferences.js');
    const s = getReviewSettings();
    expect(s.provider).toBe('persisted-provider');
    expect(s.model).toBe('persisted-model');
  });

  it('resets to Default when called with null/null', async () => {
    const { setReviewSettings, getReviewSettings } = await import(
      '../src/core/runtime-preferences.js'
    );
    setReviewSettings('old-provider', 'old-model');
    setReviewSettings(null, null);
    const s = getReviewSettings();
    expect(s.provider).toBeNull();
    expect(s.model).toBeNull();
  });

  it('preserves other runtime prefs when review settings change', async () => {
    const { setReviewSettings, setDefaultRuntimeMode, readRuntimePreferences } = await import(
      '../src/core/runtime-preferences.js'
    );
    setDefaultRuntimeMode('full');
    setReviewSettings('rv-provider', 'rv-model');
    const prefs = readRuntimePreferences();
    expect(prefs.reviewProvider).toBe('rv-provider');
    expect(prefs.reviewModel).toBe('rv-model');
    expect(prefs.defaultMode).toBe('full');
  });
});

// ───────── HTTP endpoint tests ─────────

describe('POST /review — HTTP endpoint', () => {
  it('returns 400 when projectPath is missing', async () => {
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'umbra-review-gateway-'));
    createdDirs.push(runtimeDir);
    process.env.UMBRA_HOME = runtimeDir;

    gateway = new HttpGateway({ host: '127.0.0.1', port: 0 });
    await gateway.start();
    const { port } = gateway.address as { port: number };

    const resp = await fetch(`http://127.0.0.1:${port}/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: 'uncommitted' }),
    });
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toMatch(/projectPath/);
  });

  it('returns empty findings when there are no changes', async () => {
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'umbra-review-empty-'));
    createdDirs.push(runtimeDir);
    process.env.UMBRA_HOME = runtimeDir;
    setProviderCatalogForTests(createReviewProviderCatalog());
    const mem = new MemoryManager(createTestEmbedder());
    mem.initialize();
    setMemoryManagerForTests(mem);

    // Create a clean git repo with no staged/unstaged changes
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'umbra-review-clean-'));
    createdDirs.push(repoDir);
    const run = (args: string[]) =>
      execFileSync('git', args, { cwd: repoDir, encoding: 'utf8', stdio: 'pipe' });
    run(['init']);
    run(['config', 'user.email', 'test@test.com']);
    run(['config', 'user.name', 'Test']);
    await fs.writeFile(path.join(repoDir, 'README.md'), '# Clean\n');
    run(['add', '.']);
    run(['commit', '-m', 'init']);

    gateway = new HttpGateway({ host: '127.0.0.1', port: 0 });
    await gateway.start();
    const { port } = gateway.address as { port: number };

    const resp = await fetch(`http://127.0.0.1:${port}/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectPath: repoDir, target: 'uncommitted' }),
    });
    expect(resp.status).toBe(200);
    const result = (await resp.json()) as ReviewResult;
    expect(result.findings).toHaveLength(0);
    expect(result.overall_correctness).toBe('patch is correct');
  });

  it('review output: returns structured findings with file:line references', async () => {
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'umbra-review-output-'));
    createdDirs.push(runtimeDir);
    process.env.UMBRA_HOME = runtimeDir;
    setProviderCatalogForTests(createReviewProviderCatalog());
    const mem = new MemoryManager(createTestEmbedder());
    mem.initialize();
    setMemoryManagerForTests(mem);

    const repoDir = await createTempGitRepo();

    gateway = new HttpGateway({ host: '127.0.0.1', port: 0 });
    await gateway.start();
    const { port } = gateway.address as { port: number };

    const resp = await fetch(`http://127.0.0.1:${port}/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectPath: repoDir, target: 'staged' }),
    });
    expect(resp.status).toBe(200);
    const result = (await resp.json()) as ReviewResult;

    // Findings must be an array
    expect(Array.isArray(result.findings)).toBe(true);
    // At least one finding from the mock
    expect(result.findings.length).toBeGreaterThan(0);

    const finding = result.findings[0];
    // Must have title and body
    expect(typeof finding.title).toBe('string');
    expect(finding.title.length).toBeGreaterThan(0);
    expect(typeof finding.body).toBe('string');
    // Must have a code_location with file path and line range
    expect(finding.code_location).toBeDefined();
    expect(typeof finding.code_location.absolute_file_path).toBe('string');
    expect(finding.code_location.line_range.start).toBeGreaterThan(0);
    expect(finding.code_location.line_range.end).toBeGreaterThanOrEqual(
      finding.code_location.line_range.start,
    );

    // Overall fields must be present
    expect(['patch is correct', 'patch is incorrect']).toContain(result.overall_correctness);
    expect(typeof result.overall_explanation).toBe('string');
    expect(typeof result.overall_confidence_score).toBe('number');
  });

  it('context isolation: /review does NOT create session events', async () => {
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'umbra-review-isolation-'));
    createdDirs.push(runtimeDir);
    process.env.UMBRA_HOME = runtimeDir;
    setProviderCatalogForTests(createReviewProviderCatalog());
    const mem = new MemoryManager(createTestEmbedder());
    mem.initialize();
    setMemoryManagerForTests(mem);

    const repoDir = await createTempGitRepo();

    gateway = new HttpGateway({ host: '127.0.0.1', port: 0 });
    await gateway.start();
    const { port } = gateway.address as { port: number };

    // Create a session first
    const threadResp = await fetch(`http://127.0.0.1:${port}/threads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectPath: repoDir }),
    });
    const thread = (await threadResp.json()) as { id: string; sessionId: string };
    const { sessionId } = thread;

    // Run a review
    await fetch(`http://127.0.0.1:${port}/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectPath: repoDir, target: 'staged' }),
    });

    // Read session events — review should NOT appear in them
    const eventsResp = await fetch(
      `http://127.0.0.1:${port}/sessions/${encodeURIComponent(sessionId)}`,
    );
    const sessionEvents = (await eventsResp.json()) as Array<{ type: string }>;
    // session events could be an array or wrapped object — handle both
    const eventsArray = Array.isArray(sessionEvents)
      ? sessionEvents
      : ((sessionEvents as unknown as { events?: Array<{ type: string }> }).events ?? []);
    const reviewEvents = eventsArray.filter(
      (e) => e.type === 'review' || e.type === 'review_result',
    );
    expect(reviewEvents).toHaveLength(0);
  });

  it('default path: /review works without reviewProvider configured (uses agent profile)', async () => {
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'umbra-review-default-'));
    createdDirs.push(runtimeDir);
    process.env.UMBRA_HOME = runtimeDir;
    // Do NOT set reviewProvider in prefs — should use the active agent profile
    setProviderCatalogForTests(createReviewProviderCatalog());
    const mem = new MemoryManager(createTestEmbedder());
    mem.initialize();
    setMemoryManagerForTests(mem);

    const repoDir = await createTempGitRepo();

    gateway = new HttpGateway({ host: '127.0.0.1', port: 0 });
    await gateway.start();
    const { port } = gateway.address as { port: number };

    // reviewProvider is null (default) → should still succeed using agent's active profile
    const resp = await fetch(`http://127.0.0.1:${port}/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectPath: repoDir, target: 'staged' }),
    });
    expect(resp.status).toBe(200);
    const result = (await resp.json()) as ReviewResult;
    expect(Array.isArray(result.findings)).toBe(true);
  });
});
