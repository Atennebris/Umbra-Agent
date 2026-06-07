import { afterEach, describe, expect, it, vi } from 'vitest';
import * as runtimeDebug from '../src/debug/runtime-debug.js';
import type { ProviderCatalog, ProviderProfilePayload } from '../src/providers/index.js';
import { ModelsRegistry } from '../src/providers/models-registry.js';
import { DefaultProviderGateway } from '../src/providers/provider-gateway.js';

vi.mock('../src/debug/runtime-debug.js', () => ({
  writeDebugEvent: vi.fn(),
}));

describe('ProviderGateway', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('logs requests and successful responses', async () => {
    const completeProfile = vi.fn().mockResolvedValue({
      model: 'gpt-4',
      outputText: 'hello',
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      stopReason: 'stop',
      toolCalls: [],
    });
    const mockCatalog: Partial<ProviderCatalog> = {
      listProfiles: () => ({
        profiles: [makeProfilePayload()],
        activeProfileId: 'p1',
        defaultProfileId: 'p1',
        fallbackProfileId: 'p1',
      }),
      completeProfile,
    };

    const gateway = new DefaultProviderGateway({
      catalog: mockCatalog as ProviderCatalog,
      models: new ModelsRegistry({ datasetLoader: async () => ({}) }),
    });

    const result = await gateway.complete({
      profileId: 'p1',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(result.outputText).toBe('hello');
    expect(runtimeDebug.writeDebugEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        component: 'provider',
        message: 'outgoing llm request',
      }),
    );
    expect(runtimeDebug.writeDebugEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        component: 'provider',
        message: 'incoming llm response',
        data: expect.objectContaining({
          tokens: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        }),
      }),
    );
  });

  it('logs errors on failure', async () => {
    const mockCatalog: Partial<ProviderCatalog> = {
      listProfiles: () => ({
        profiles: [makeProfilePayload()],
        activeProfileId: 'p1',
        defaultProfileId: 'p1',
        fallbackProfileId: 'p1',
      }),
      completeProfile: vi.fn().mockRejectedValue(new Error('API Down')),
    };

    const gateway = new DefaultProviderGateway({
      catalog: mockCatalog as ProviderCatalog,
      models: new ModelsRegistry({ datasetLoader: async () => ({}) }),
    });

    await expect(
      gateway.complete({
        profileId: 'p1',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toThrow('API Down');

    expect(runtimeDebug.writeDebugEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        component: 'provider',
        message: 'llm request failed',
        level: 'error',
      }),
    );
  });

  it('retries on retryable failures', async () => {
    const completeProfile = vi
      .fn()
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockResolvedValueOnce({
        model: 'gpt-4',
        outputText: 'success after retry',
        usage: { totalTokens: 10 },
        stopReason: 'stop',
        toolCalls: [],
      });
    const mockCatalog: Partial<ProviderCatalog> = {
      listProfiles: () => ({
        profiles: [makeProfilePayload()],
        activeProfileId: 'p1',
        defaultProfileId: 'p1',
        fallbackProfileId: 'p1',
      }),
      completeProfile,
    };

    const gateway = new DefaultProviderGateway({
      catalog: mockCatalog as ProviderCatalog,
      models: new ModelsRegistry({ datasetLoader: async () => ({}) }),
    });

    const result = await gateway.complete({
      profileId: 'p1',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(result.outputText).toBe('success after retry');
    expect(completeProfile).toHaveBeenCalledTimes(2);
  });

  it('routes through a chain and stops at first success', async () => {
    const mockCatalog: Partial<ProviderCatalog> = {
      listChains: () => [
        {
          id: 'c1',
          label: 'Chain 1',
          entries: [{ profileId: 'p1' }, { profileId: 'p2' }],
          enabled: true,
          createdAt: '',
          updatedAt: '',
        },
      ],
      completeProfile: vi
        .fn()
        .mockRejectedValueOnce(new Error('P1 Down'))
        .mockResolvedValueOnce({
          model: 'gpt-4-fallback',
          outputText: 'hello from p2',
          usage: { totalTokens: 5 },
          stopReason: 'stop',
          toolCalls: [],
        }),
    };

    const gateway = new DefaultProviderGateway({
      catalog: mockCatalog as ProviderCatalog,
      models: new ModelsRegistry({ datasetLoader: async () => ({}) }),
    });

    const result = await gateway.complete({
      chainId: 'c1',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(result.outputText).toBe('hello from p2');
    expect(mockCatalog.completeProfile).toHaveBeenCalledTimes(2);
    expect(mockCatalog.completeProfile).toHaveBeenNthCalledWith(1, 'p1', expect.anything());
    expect(mockCatalog.completeProfile).toHaveBeenNthCalledWith(2, 'p2', expect.anything());
  });

  it('applies compression to messages before calling provider', async () => {
    const completeProfile = vi.fn().mockResolvedValue({
      model: 'gpt-4',
      outputText: 'ok',
      usage: { totalTokens: 1 },
      stopReason: 'stop',
      toolCalls: [],
    });
    const mockCatalog: Partial<ProviderCatalog> = {
      listProfiles: () => ({
        profiles: [makeProfilePayload()],
        activeProfileId: 'p1',
        defaultProfileId: 'p1',
        fallbackProfileId: 'p1',
      }),
      completeProfile,
    };

    const gateway = new DefaultProviderGateway({
      catalog: mockCatalog as ProviderCatalog,
      models: new ModelsRegistry({ datasetLoader: async () => ({}) }),
    });

    await gateway.complete({
      profileId: 'p1',
      compressionLevel: 'aggressive',
      messages: [
        { role: 'user', content: 'Actually, just a test.' },
        { role: 'tool', content: Array.from({ length: 100 }, (_, i) => `log ${i}`).join('\n') },
      ],
    });

    const callArgs = completeProfile.mock.calls[0]?.[1];
    expect(callArgs).toBeDefined();
    // Prose compression: "Actually, just" should be stripped
    expect(callArgs?.messages[0]?.content).not.toContain('Actually');
    // Machine compression: should be truncated
    expect(callArgs?.messages[1]?.content).toContain('TRUNCATED');
  });
});

function makeProfilePayload(
  overrides: Partial<ProviderProfilePayload> = {},
): ProviderProfilePayload {
  return {
    id: 'p1',
    type: 'openai',
    normalizedType: 'openai',
    label: 'Test',
    baseUrl: 'http://api.test',
    model: 'gpt-4',
    enabled: true,
    extraHeaders: {},
    options: {},
    hasApiKey: true,
    needsKey: true,
    keyOptional: false,
    keyHint: 'OPENAI_API_KEY',
    cloud: true,
    available: true,
    status: 'connected',
    fallbackType: null,
    fallbackProfileId: null,
    reason: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}
