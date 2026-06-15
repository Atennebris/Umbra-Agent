import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentRuntime } from '../src/core/agent-runtime.js';
import type { RunEvent, RunTaskPayload } from '../src/core/contracts.js';
import type { TextEmbedder } from '../src/memory/embeddings.js';
import { resetMemoryManagerForTests, setMemoryManagerForTests } from '../src/memory/index.js';
import { MemoryManager } from '../src/memory/manager.js';
import { loadRuntimeSettings } from '../src/memory/settings-store.js';
import {
  DefaultProviderGateway,
  ModelsRegistry,
  type ProviderCatalog,
  type ProviderChatMessage,
  type ProviderCompleteRequest,
  type ProviderCompleteResponse,
  type ProviderProfilesListPayload,
} from '../src/providers/index.js';

const createdDirs: string[] = [];
const originalUmbraHome = process.env.UMBRA_HOME;

afterEach(async () => {
  resetMemoryManagerForTests();

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

describe('AgentRuntime', () => {
  it('returns structured JSON in plan mode without tool execution', async () => {
    const { runtime } = await createRuntime(new ScenarioProviderCatalog('plan'));
    const events: RunEvent[] = [];
    const result = await runtime.executeRun(
      {
        prompt: 'Plan a refactor',
        mode: 'plan',
        projectPath: process.cwd(),
      },
      createHooks(events),
    );

    expect(result.finalJson).toMatchObject({
      explanation: 'Plan generated',
      plan: [
        { step: 'Inspect files in src/', status: 'pending' },
        { step: 'Run pnpm test', status: 'pending' },
      ],
    });
    expect(result.finalText).toContain('Inspect files');
    expect(events.some((event) => event.type === 'tool_result')).toBe(false);
  }, 15000);

  it('executes agent tool calls through the phase 5 runner', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'umbra-agent-runtime-'));
    createdDirs.push(workspace);
    await fs.writeFile(path.join(workspace, 'note.txt'), 'agent content', 'utf8');
    const { runtime } = await createRuntime(new ScenarioProviderCatalog('agent'));
    const events: RunEvent[] = [];
    const result = await runtime.executeRun(
      {
        prompt: 'Read note.txt and summarize it',
        mode: 'agent',
        projectPath: workspace,
      },
      createHooks(events),
    );

    expect(result.finalText).toContain('agent content');
    expect(events.some((event) => event.type === 'tool_result')).toBe(true);
  });

  it('stops after the MAX_AGENT_TURNS safety cap when the model never stops requesting tools', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'umbra-agent-infinite-'));
    createdDirs.push(workspace);
    await fs.writeFile(path.join(workspace, 'note.txt'), 'agent content', 'utf8');
    const provider = new ScenarioProviderCatalog('agent-infinite-tools');
    const { runtime } = await createRuntime(provider);
    const events: RunEvent[] = [];
    const result = await runtime.executeRun(
      {
        prompt: 'Read note.txt forever',
        mode: 'agent',
        projectPath: workspace,
      },
      createHooks(events),
    );

    expect(result.finalText).toContain('turn safety limit');
    expect(provider.requests).toHaveLength(40);
  }, 30000);

  it('reuses prior session messages for follow-up agent runs', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'umbra-agent-memory-'));
    createdDirs.push(workspace);
    const provider = new ScenarioProviderCatalog('memory');
    const { runtime } = await createRuntime(provider);

    await runtime.executeRun(
      {
        prompt: 'Remember that the release codename is Bluebird.',
        mode: 'agent',
        projectPath: workspace,
        sessionId: 'session-memory',
      },
      createHooks([]),
    );

    const secondResult = await runtime.executeRun(
      {
        prompt: 'What release codename did I ask you to remember?',
        mode: 'agent',
        projectPath: workspace,
        sessionId: 'session-memory',
      },
      createHooks([]),
    );

    const secondRequest = provider.requests.at(-1);

    expect(secondRequest).toBeDefined();
    expect(secondRequest?.messages.map((message) => message.role)).toEqual([
      'system',
      'user',
      'assistant',
      'user',
    ]);
    expect(secondRequest?.messages[1]?.content).toContain('Bluebird');
    expect(secondRequest?.messages[2]?.content).toContain('Stored it');
    expect(secondRequest?.messages[0]?.content).toContain('Repo map:');
    expect(secondResult.memoryCitation?.threadId).toBe('session-memory');
  });

  it('reconstructs prior tool calls and results for follow-up agent runs', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'umbra-agent-followup-'));
    createdDirs.push(workspace);
    await fs.writeFile(path.join(workspace, 'note.txt'), 'agent content', 'utf8');
    const provider = new ScenarioProviderCatalog('agent-followup-tools');
    const { runtime } = await createRuntime(provider);

    await runtime.executeRun(
      {
        prompt: 'Read note.txt and summarize it',
        mode: 'agent',
        projectPath: workspace,
        sessionId: 'session-followup',
      },
      createHooks([]),
    );

    await runtime.executeRun(
      {
        prompt: 'What did you read?',
        mode: 'agent',
        projectPath: workspace,
        sessionId: 'session-followup',
      },
      createHooks([]),
    );

    const thirdRequest = provider.requests.at(-1);

    expect(thirdRequest).toBeDefined();
    expect(thirdRequest?.messages.map((message) => message.role)).toEqual([
      'system',
      'user',
      'assistant',
      'assistant',
      'tool',
      'assistant',
      'user',
    ]);

    const reconstructedToolCall = thirdRequest?.messages[3];
    expect(reconstructedToolCall?.toolCalls?.[0]).toMatchObject({
      name: 'fs.read',
      arguments: { path: 'note.txt' },
    });

    const reconstructedToolResult = thirdRequest?.messages[4];
    expect(reconstructedToolResult?.toolCallId).toBe(reconstructedToolCall?.toolCalls?.[0]?.id);
    expect(reconstructedToolResult?.content).toContain('agent content');

    expect(thirdRequest?.messages[5]?.content).toContain('Summary: done.');
    expect(thirdRequest?.messages[6]?.content).toBe('What did you read?');
  });

  it('replaces a superseded fs.read result with a stale placeholder in later runs', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'umbra-agent-stale-reads-'));
    createdDirs.push(workspace);
    await fs.writeFile(path.join(workspace, 'note.txt'), 'agent content', 'utf8');
    const provider = new ScenarioProviderCatalog('agent-stale-reads');
    const { runtime } = await createRuntime(provider);

    await runtime.executeRun(
      {
        prompt: 'Read note.txt and summarize it',
        mode: 'agent',
        projectPath: workspace,
        sessionId: 'session-stale-reads',
      },
      createHooks([]),
    );

    await runtime.executeRun(
      {
        prompt: 'Read note.txt again',
        mode: 'agent',
        projectPath: workspace,
        sessionId: 'session-stale-reads',
      },
      createHooks([]),
    );

    await runtime.executeRun(
      {
        prompt: 'What did you read overall?',
        mode: 'agent',
        projectPath: workspace,
        sessionId: 'session-stale-reads',
      },
      createHooks([]),
    );

    const thirdRequest = provider.requests.at(-1);

    expect(thirdRequest).toBeDefined();
    const toolResults = thirdRequest?.messages.filter((message) => message.role === 'tool') ?? [];
    expect(toolResults).toHaveLength(2);

    expect(toolResults[0]?.content).not.toContain('agent content');
    expect(toolResults[0]?.content).toContain('stale');

    expect(toolResults[1]?.content).toContain('agent content');
  });

  it('runs the exec harness loop until check.ps1 passes', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'umbra-exec-runtime-'));
    createdDirs.push(workspace);
    await fs.writeFile(
      path.join(workspace, 'check.ps1'),
      [
        '$value = Get-Content -Path ./state.txt -Raw -ErrorAction SilentlyContinue',
        "if ($value -match 'pass') {",
        '  exit 0',
        '}',
        "Write-Error 'state.txt is not passing yet'",
        'exit 1',
      ].join('\n'),
      'utf8',
    );
    const { runtime } = await createRuntime(new ScenarioProviderCatalog('exec'));
    const events: RunEvent[] = [];
    const result = await runtime.executeRun(
      {
        prompt: 'Fix the project until checks pass',
        mode: 'exec',
        projectPath: workspace,
      },
      createHooks(events),
    );

    expect(result.check?.exitCode).toBe(0);
    expect(await fs.readFile(path.join(workspace, 'state.txt'), 'utf8')).toContain('pass');
    expect(events.filter((event) => event.type === 'command').length).toBeGreaterThan(1);
  }, 20000);

  it('reports an empty model response after a tool failure instead of ending silently', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'umbra-agent-empty-'));
    createdDirs.push(workspace);
    const { runtime } = await createRuntime(
      new ScenarioProviderCatalog('agent-empty-after-failure'),
    );
    const events: RunEvent[] = [];

    const result = await runtime.executeRun(
      {
        prompt: 'Fix the broken file',
        mode: 'agent',
        projectPath: workspace,
      },
      createHooks(events),
    );

    expect(result.finalText).toContain('Run ended with no further response');
    expect(
      events.some((event) => event.type === 'tool_result' && event.payload.status === 'failed'),
    ).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === 'assistant_message' &&
          typeof event.payload.text === 'string' &&
          event.payload.text.includes('Run ended with no further response'),
      ),
    ).toBe(true);
  });

  it('does not fail exec mode chat when the target project has no check script', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'umbra-exec-no-check-'));
    createdDirs.push(workspace);
    const { runtime } = await createRuntime(new ScenarioProviderCatalog('exec-chat'));
    const events: RunEvent[] = [];

    const result = await runtime.executeRun(
      {
        prompt: 'hi',
        mode: 'exec',
        projectPath: workspace,
      },
      createHooks(events),
    );

    expect(result.finalText).toContain('Hello from exec chat');
    expect(result.check).toBeNull();
    expect(events.some((event) => event.type === 'command')).toBe(false);
    expect(
      events.some((event) => event.type === 'status' && event.payload.phase === 'harness_skipped'),
    ).toBe(true);
  });
});

function createHooks(events: RunEvent[]) {
  let summary: Partial<RunTaskPayload> = {};

  return {
    appendEvent(event: Omit<RunEvent, 'id' | 'timestamp'>) {
      events.push({
        id: `event-${events.length + 1}`,
        timestamp: new Date().toISOString(),
        type: event.type,
        payload: event.payload,
      });
    },
    setSummary(patch: Partial<RunTaskPayload>) {
      summary = { ...summary, ...patch };
    },
    isStopped() {
      return false;
    },
    ensureActive() {
      if (summary.status === 'stopped') {
        throw new Error('stopped');
      }
    },
  };
}

async function createRuntime(providerCatalog: ProviderCatalog): Promise<{
  runtime: AgentRuntime;
  memory: MemoryManager;
}> {
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'umbra-runtime-home-'));
  createdDirs.push(runtimeDir);
  process.env.UMBRA_HOME = runtimeDir;
  const memory = new MemoryManager(createTestEmbedder());
  memory.initialize();
  setMemoryManagerForTests(memory);

  const models = new ModelsRegistry({
    datasetLoader: async () => ({}),
  });

  return {
    runtime: new AgentRuntime({
      memory,
      providers: providerCatalog,
      gateway: new DefaultProviderGateway({
        catalog: providerCatalog,
        models,
      }),
      settingsLoader: () => loadRuntimeSettings(),
    }),
    memory,
  };
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

class ScenarioProviderCatalog implements ProviderCatalog {
  readonly #scenario:
    | 'plan'
    | 'agent'
    | 'agent-empty-after-failure'
    | 'agent-followup-tools'
    | 'agent-infinite-tools'
    | 'agent-stale-reads'
    | 'exec'
    | 'exec-chat'
    | 'memory';
  readonly requests: ProviderCompleteRequest[] = [];

  constructor(
    scenario:
      | 'plan'
      | 'agent'
      | 'agent-empty-after-failure'
      | 'agent-followup-tools'
      | 'agent-infinite-tools'
      | 'agent-stale-reads'
      | 'exec'
      | 'exec-chat'
      | 'memory',
  ) {
    this.#scenario = scenario;
  }

  listTypes() {
    return [
      {
        value: 'openai',
        label: 'OpenAI',
        defaultUrl: '',
        needsKey: false,
        keyOptional: true,
        keyHint: '',
        cloud: true,
        aliases: [],
      },
    ];
  }

  listProfiles(): ProviderProfilesListPayload {
    return {
      profiles: [
        {
          id: 'profile-1',
          type: 'openai',
          normalizedType: 'openai',
          label: 'Test Provider',
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
  }

  resolveType(providerType: string) {
    return {
      requestedType: providerType,
      normalizedType: providerType,
      available: true,
      resolvedType: providerType,
      fallbackType: null,
      reason: null,
    };
  }

  async getModelCapabilities(modelId: string) {
    return {
      modelId,
      normalizedModelId: modelId,
      matchedModelId: null,
      source: 'heuristic' as const,
      contextWindow: null,
      supportsTools: true,
      supportsVision: false,
      supportsReasoning: true,
      supportsStructuredOutput: true,
      supportsAttachments: false,
      supportsTemperature: true,
      longContext: false,
      interleaved: 'reasoning_content' as const,
      inputModalities: ['text'],
      outputModalities: ['text'],
    };
  }

  async completeProfile(
    _profileId: string,
    request: ProviderCompleteRequest,
  ): Promise<ProviderCompleteResponse> {
    this.requests.push(structuredClone(request));

    if (this.#scenario === 'plan') {
      return {
        providerProfileId: 'profile-1',
        providerType: 'openai',
        model: request.model ?? 'gpt-test',
        outputText: null,
        outputJson: null,
        toolCalls: [
          {
            id: 'call-plan-1',
            name: 'update_plan',
            arguments: {
              explanation: 'Plan generated',
              plan: [
                { step: 'Inspect files in src/', status: 'pending' },
                { step: 'Run pnpm test', status: 'pending' },
              ],
            },
          },
        ],
        stopReason: 'tool_calls',
      };
    }

    if (this.#scenario === 'memory') {
      const userMessages = request.messages.filter((message) => message.role === 'user');

      return {
        providerProfileId: 'profile-1',
        providerType: 'openai',
        model: request.model ?? 'gpt-test',
        outputText:
          userMessages.length <= 1 ? 'Stored it: Bluebird.' : 'You asked me to remember Bluebird.',
        outputJson: null,
        toolCalls: [],
        stopReason: 'stop',
      };
    }

    if (this.#scenario === 'exec-chat') {
      return {
        providerProfileId: 'profile-1',
        providerType: 'openai',
        model: request.model ?? 'gpt-test',
        outputText: 'Hello from exec chat.',
        outputJson: null,
        toolCalls: [],
        stopReason: 'stop',
      };
    }

    const toolPayloads = request.messages
      .filter((message) => message.role === 'tool')
      .map((message) => message.content ?? '');
    const latestUser = latestUserMessage(request.messages);

    if (this.#scenario === 'agent') {
      if (toolPayloads.length === 0) {
        return toolCallResponse('fs.read', { path: 'note.txt' }, 'Reading note.txt');
      }

      return {
        providerProfileId: 'profile-1',
        providerType: 'openai',
        model: request.model ?? 'gpt-test',
        outputText: `Summary: ${toolPayloads.at(-1) ?? ''}`,
        outputJson: null,
        toolCalls: [],
        stopReason: 'stop',
      };
    }

    if (this.#scenario === 'agent-followup-tools') {
      if (latestUser.includes('Read note.txt')) {
        if (toolPayloads.length === 0) {
          return toolCallResponse('fs.read', { path: 'note.txt' }, 'Reading note.txt');
        }

        return {
          providerProfileId: 'profile-1',
          providerType: 'openai',
          model: request.model ?? 'gpt-test',
          outputText: 'Summary: done.',
          outputJson: null,
          toolCalls: [],
          stopReason: 'stop',
        };
      }

      return {
        providerProfileId: 'profile-1',
        providerType: 'openai',
        model: request.model ?? 'gpt-test',
        outputText: 'Second answer.',
        outputJson: null,
        toolCalls: [],
        stopReason: 'stop',
      };
    }

    if (this.#scenario === 'agent-stale-reads') {
      if (latestUser.includes('Read note.txt and summarize')) {
        if (toolPayloads.length === 0) {
          return toolCallResponse('fs.read', { path: 'note.txt' }, 'Reading note.txt');
        }

        return {
          providerProfileId: 'profile-1',
          providerType: 'openai',
          model: request.model ?? 'gpt-test',
          outputText: 'Summary: first read.',
          outputJson: null,
          toolCalls: [],
          stopReason: 'stop',
        };
      }

      if (latestUser.includes('Read note.txt again')) {
        // toolPayloads already contains the run-1 fs.read result reconstructed
        // from history, so the "no tool call yet this run" baseline is 1, not 0.
        if (toolPayloads.length <= 1) {
          return toolCallResponse('fs.read', { path: 'note.txt' }, 'Reading note.txt again');
        }

        return {
          providerProfileId: 'profile-1',
          providerType: 'openai',
          model: request.model ?? 'gpt-test',
          outputText: 'Summary: second read.',
          outputJson: null,
          toolCalls: [],
          stopReason: 'stop',
        };
      }

      return {
        providerProfileId: 'profile-1',
        providerType: 'openai',
        model: request.model ?? 'gpt-test',
        outputText: 'Final answer.',
        outputJson: null,
        toolCalls: [],
        stopReason: 'stop',
      };
    }

    if (this.#scenario === 'agent-infinite-tools') {
      // Never stops requesting tools — used to exercise the MAX_AGENT_TURNS safety cap.
      return toolCallResponse('fs.read', { path: 'note.txt' }, 'Reading note.txt');
    }

    if (this.#scenario === 'agent-empty-after-failure') {
      if (toolPayloads.length === 0) {
        return toolCallResponse('fs.read', { path: 'missing.txt' }, 'Reading missing.txt');
      }

      // Simulates a provider returning a completely empty completion after the
      // failed fs.read result was fed back — no text, no tool calls.
      return {
        providerProfileId: 'profile-1',
        providerType: 'openai',
        model: request.model ?? 'gpt-test',
        outputText: null,
        outputJson: null,
        toolCalls: [],
        stopReason: 'stop',
      };
    }

    if (latestUser.includes('Harness check failed') && toolPayloads.length <= 1) {
      return toolCallResponse('fs.write', { path: 'state.txt', content: 'pass' }, 'Applying fix');
    }

    if (toolPayloads.length === 0) {
      return toolCallResponse('fs.write', { path: 'state.txt', content: 'fail' }, 'Starting fix');
    }

    return {
      providerProfileId: 'profile-1',
      providerType: 'openai',
      model: request.model ?? 'gpt-test',
      outputText: 'Ready to run checks.',
      outputJson: null,
      toolCalls: [],
      stopReason: 'stop',
    };
  }
}

function toolCallResponse(
  name: string,
  argumentsPayload: Record<string, unknown>,
  outputText: string,
): ProviderCompleteResponse {
  return {
    providerProfileId: 'profile-1',
    providerType: 'openai',
    model: 'gpt-test',
    outputText,
    outputJson: null,
    toolCalls: [
      {
        id: `${name}-1`,
        name,
        arguments: argumentsPayload,
      },
    ],
    stopReason: 'tool_calls',
  };
}

function latestUserMessage(messages: ProviderChatMessage[]): string {
  const userMessages = messages.filter((message) => message.role === 'user');
  return userMessages.at(-1)?.content ?? '';
}
