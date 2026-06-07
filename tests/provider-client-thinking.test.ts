/**
 * Tests for thinking/reasoning parameter dispatch across provider types.
 * Validates that correct params are sent to the API: Anthropic gets `thinking:{budget_tokens}`,
 * OpenAI o-series gets `reasoning_effort`, Mistral magistral gets `reasoning_effort` + `temperature:1.0`,
 * and unknown models get nothing.
 */
import { describe, expect, it, vi } from 'vitest';
import { createProviderClient } from '../src/providers/provider-client.js';
import type { ProviderCompleteRequest } from '../src/providers/runtime-types.js';

vi.mock('../src/debug/runtime-debug.js', () => ({ writeDebugEvent: vi.fn() }));

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function makeProfile(overrides: Partial<{
  id: string;
  type: string;
  model: string;
  baseUrl: string;
  apiKey: string;
}> = {}) {
  return {
    id: overrides.id ?? 'test-profile',
    type: overrides.type ?? 'openai-compatible',
    normalizedType: overrides.type ?? 'openai-compatible',
    label: 'Test',
    baseUrl: overrides.baseUrl ?? 'http://localhost:9999',
    model: overrides.model ?? null,
    enabled: true,
    extraHeaders: {},
    options: {},
    hasApiKey: !!overrides.apiKey,
    apiKey: overrides.apiKey ?? '',
    needsKey: false,
    keyOptional: true,
    keyHint: '',
    cloud: false,
    available: true,
    status: 'connected' as const,
    fallbackType: null,
    fallbackProfileId: null,
    reason: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function mockFetchCapture(responseBody: unknown = null) {
  const captured: { url: string; body: Record<string, unknown> }[] = [];
  const mockFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {};
    captured.push({ url, body });
    const payload = responseBody ?? {
      choices: [{ finish_reason: 'stop', message: { content: 'ok', tool_calls: null } }],
    };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { captured, mockFetch };
}

const BASE_REQUEST: ProviderCompleteRequest = {
  model: 'placeholder',
  messages: [{ role: 'user', content: 'hello' }],
};

// ---------------------------------------------------------------------------
// OpenAI-compatible: reasoning_effort for o-series
// ---------------------------------------------------------------------------

describe('OpenAI-compatible — reasoning_effort (o-series)', () => {
  it('sends reasoning_effort for o3-mini with thinkBudget=high', async () => {
    const { captured, mockFetch } = mockFetchCapture();
    const client = createProviderClient(makeProfile({ model: 'o3-mini' }), 'openai-compatible', mockFetch as typeof fetch);
    await client.complete({ ...BASE_REQUEST, model: 'o3-mini', thinkBudget: 'high' } as ProviderCompleteRequest & { thinkBudget: unknown });
    const body = captured[0]?.body;
    expect(body?.reasoning_effort).toBe('high');
  });

  it('maps max → high for o-series', async () => {
    const { captured, mockFetch } = mockFetchCapture();
    const client = createProviderClient(makeProfile({ model: 'o4-mini' }), 'openai-compatible', mockFetch as typeof fetch);
    await client.complete({ ...BASE_REQUEST, model: 'o4-mini', thinkBudget: 'max' } as ProviderCompleteRequest & { thinkBudget: unknown });
    expect(captured[0]?.body?.reasoning_effort).toBe('high');
  });

  it('sends reasoning_effort for numeric budget on o1', async () => {
    const { captured, mockFetch } = mockFetchCapture();
    const client = createProviderClient(makeProfile({ model: 'o1' }), 'openai-compatible', mockFetch as typeof fetch);
    // 16000 tokens → effortFromBudget → 'high'
    await client.complete({ ...BASE_REQUEST, model: 'o1', thinkBudget: 16000 } as ProviderCompleteRequest & { thinkBudget: unknown });
    expect(captured[0]?.body?.reasoning_effort).toBe('high');
  });

  it('does NOT send reasoning_effort when thinkBudget is null', async () => {
    const { captured, mockFetch } = mockFetchCapture();
    const client = createProviderClient(makeProfile({ model: 'o3-mini' }), 'openai-compatible', mockFetch as typeof fetch);
    await client.complete({ ...BASE_REQUEST, model: 'o3-mini', thinkBudget: null } as ProviderCompleteRequest & { thinkBudget: unknown });
    expect(captured[0]?.body?.reasoning_effort).toBeUndefined();
  });

  it('does NOT send reasoning_effort for gpt-4o (not o-series)', async () => {
    const { captured, mockFetch } = mockFetchCapture();
    const client = createProviderClient(makeProfile({ model: 'gpt-4o' }), 'openai-compatible', mockFetch as typeof fetch);
    await client.complete({ ...BASE_REQUEST, model: 'gpt-4o', thinkBudget: 'high' } as ProviderCompleteRequest & { thinkBudget: unknown });
    expect(captured[0]?.body?.reasoning_effort).toBeUndefined();
  });

  it('does NOT send reasoning_effort for deepseek-chat (blocklisted)', async () => {
    const { captured, mockFetch } = mockFetchCapture();
    const client = createProviderClient(makeProfile({ model: 'deepseek-chat' }), 'openai-compatible', mockFetch as typeof fetch);
    await client.complete({ ...BASE_REQUEST, model: 'deepseek-chat', thinkBudget: 'high' } as ProviderCompleteRequest & { thinkBudget: unknown });
    expect(captured[0]?.body?.reasoning_effort).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Anthropic: thinking block with budget_tokens
// ---------------------------------------------------------------------------

describe('Anthropic — thinking block', () => {
  const anthropicProfile = makeProfile({
    id: 'anthropic-test',
    type: 'anthropic',
    model: 'claude-3-5-sonnet-20241022',
    baseUrl: 'https://api.anthropic.com/v1',
    apiKey: 'test-key',
  });

  function mockAnthropicFetch(responseBody?: unknown) {
    const captured: { url: string; body: Record<string, unknown> }[] = [];
    const mockFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();
      const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {};
      captured.push({ url, body });
      const payload = responseBody ?? {
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 10, output_tokens: 5 },
      };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    return { captured, mockFetch };
  }

  it('sends thinking block for budget level high', async () => {
    const { captured, mockFetch } = mockAnthropicFetch();
    const client = createProviderClient(anthropicProfile as never, 'anthropic', mockFetch as typeof fetch);
    await client.complete({ ...BASE_REQUEST, model: 'claude-3-7-sonnet-20250219', thinkBudget: 'high' } as ProviderCompleteRequest & { thinkBudget: unknown });
    const body = captured[0]?.body;
    expect(body?.thinking).toEqual({ type: 'enabled', budget_tokens: 16000 });
    // temperature must NOT be sent when thinking is enabled
    expect(body?.temperature).toBeUndefined();
  });

  it('sends thinking block for numeric budget', async () => {
    const { captured, mockFetch } = mockAnthropicFetch();
    const client = createProviderClient(anthropicProfile as never, 'anthropic', mockFetch as typeof fetch);
    await client.complete({ ...BASE_REQUEST, model: 'claude-3-7-sonnet-20250219', thinkBudget: 8000 } as ProviderCompleteRequest & { thinkBudget: unknown });
    const body = captured[0]?.body;
    expect(body?.thinking).toEqual({ type: 'enabled', budget_tokens: 8000 });
  });

  it('maps max → 32000 budget tokens', async () => {
    const { captured, mockFetch } = mockAnthropicFetch();
    const client = createProviderClient(anthropicProfile as never, 'anthropic', mockFetch as typeof fetch);
    await client.complete({ ...BASE_REQUEST, model: 'claude-3-7-sonnet-20250219', thinkBudget: 'max' } as ProviderCompleteRequest & { thinkBudget: unknown });
    expect((captured[0]?.body?.thinking as Record<string,unknown>)?.budget_tokens).toBe(32000);
  });

  it('does NOT send thinking block when thinkBudget is null', async () => {
    const { captured, mockFetch } = mockAnthropicFetch();
    const client = createProviderClient(anthropicProfile as never, 'anthropic', mockFetch as typeof fetch);
    await client.complete({ ...BASE_REQUEST, model: 'claude-3-5-sonnet-20241022', thinkBudget: null } as ProviderCompleteRequest & { thinkBudget: unknown });
    expect(captured[0]?.body?.thinking).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Mistral: magistral models use reasoning_effort + temperature 1.0
// ---------------------------------------------------------------------------

// Magistral models ALWAYS reason — built-in, no parameter needed per official docs.
// https://docs.mistral.ai/capabilities/reasoning/
describe('Mistral — magistral (always-on reasoning, no parameter needed)', () => {
  const mistralProfile = makeProfile({
    id: 'mistral-test',
    type: 'mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    apiKey: 'test-key',
  });

  it('does NOT send reasoning_effort for magistral-medium — reasoning is built-in', async () => {
    const { captured, mockFetch } = mockFetchCapture();
    const client = createProviderClient(mistralProfile as never, 'mistral', mockFetch as typeof fetch);
    await client.complete({
      ...BASE_REQUEST,
      model: 'magistral-medium-latest',
      thinkBudget: 'high',
    } as ProviderCompleteRequest & { thinkBudget: unknown });
    const body = captured[0]?.body;
    // Magistral always reasons — no reasoning_effort or temperature override sent
    expect(body?.reasoning_effort).toBeUndefined();
    expect(body?.temperature).toBeUndefined();
  });

  it('does NOT send reasoning_effort for magistral-small regardless of thinkBudget', async () => {
    const { captured, mockFetch } = mockFetchCapture();
    const client = createProviderClient(mistralProfile as never, 'mistral', mockFetch as typeof fetch);
    await client.complete({
      ...BASE_REQUEST,
      model: 'magistral-small-2509',
      thinkBudget: 'max',
    } as ProviderCompleteRequest & { thinkBudget: unknown });
    expect(captured[0]?.body?.reasoning_effort).toBeUndefined();
    expect(captured[0]?.body?.temperature).toBeUndefined();
  });

  it('does NOT send reasoning_effort for magistral even when thinkBudget=null', async () => {
    const { captured, mockFetch } = mockFetchCapture();
    const client = createProviderClient(mistralProfile as never, 'mistral', mockFetch as typeof fetch);
    await client.complete({
      ...BASE_REQUEST,
      model: 'magistral-medium-latest',
      thinkBudget: null,
    } as ProviderCompleteRequest & { thinkBudget: unknown });
    expect(captured[0]?.body?.reasoning_effort).toBeUndefined();
  });

  it('does NOT send reasoning_effort for non-thinking Mistral models (mistral-large)', async () => {
    const { captured, mockFetch } = mockFetchCapture();
    const client = createProviderClient(mistralProfile as never, 'mistral', mockFetch as typeof fetch);
    await client.complete({
      ...BASE_REQUEST,
      model: 'mistral-large-latest',
      thinkBudget: 'high',
    } as ProviderCompleteRequest & { thinkBudget: unknown });
    expect(captured[0]?.body?.reasoning_effort).toBeUndefined();
    expect(captured[0]?.body?.temperature).toBeUndefined();
  });
});

// Mistral adjustable reasoning: mistral-small / mistral-medium support reasoning_effort
describe('Mistral — adjustable reasoning (mistral-small / mistral-medium)', () => {
  const mistralProfile = makeProfile({
    id: 'mistral-adjustable-test',
    type: 'mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    apiKey: 'test-key',
  });

  it('sends reasoning_effort=high for mistral-small with thinkBudget=high', async () => {
    const { captured, mockFetch } = mockFetchCapture();
    const client = createProviderClient(mistralProfile as never, 'mistral', mockFetch as typeof fetch);
    await client.complete({
      ...BASE_REQUEST,
      model: 'mistral-small-latest',
      thinkBudget: 'high',
    } as ProviderCompleteRequest & { thinkBudget: unknown });
    expect(captured[0]?.body?.reasoning_effort).toBe('high');
  });

  it('sends reasoning_effort=medium for mistral-medium with thinkBudget=medium', async () => {
    const { captured, mockFetch } = mockFetchCapture();
    const client = createProviderClient(mistralProfile as never, 'mistral', mockFetch as typeof fetch);
    await client.complete({
      ...BASE_REQUEST,
      model: 'mistral-medium-latest',
      thinkBudget: 'medium',
    } as ProviderCompleteRequest & { thinkBudget: unknown });
    expect(captured[0]?.body?.reasoning_effort).toBe('medium');
  });

  it('maps max → high for adjustable Mistral reasoning', async () => {
    const { captured, mockFetch } = mockFetchCapture();
    const client = createProviderClient(mistralProfile as never, 'mistral', mockFetch as typeof fetch);
    await client.complete({
      ...BASE_REQUEST,
      model: 'mistral-small-latest',
      thinkBudget: 'max',
    } as ProviderCompleteRequest & { thinkBudget: unknown });
    expect(captured[0]?.body?.reasoning_effort).toBe('high');
  });

  it('does NOT send reasoning_effort for mistral-small when thinkBudget=null', async () => {
    const { captured, mockFetch } = mockFetchCapture();
    const client = createProviderClient(mistralProfile as never, 'mistral', mockFetch as typeof fetch);
    await client.complete({
      ...BASE_REQUEST,
      model: 'mistral-small-latest',
      thinkBudget: null,
    } as ProviderCompleteRequest & { thinkBudget: unknown });
    expect(captured[0]?.body?.reasoning_effort).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Mistral: parsing array content response from magistral
// ---------------------------------------------------------------------------

describe('Mistral — magistral array content response parsing', () => {
  const mistralProfile = makeProfile({
    id: 'mistral-parse-test',
    type: 'mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    apiKey: 'test-key',
  });

  it('extracts text and reasoning from magistral array content', async () => {
    const responseBody = {
      choices: [
        {
          finish_reason: 'stop',
          message: {
            content: [
              {
                type: 'thinking',
                thinking: [{ type: 'text', text: 'Let me think about this carefully.' }],
              },
              { type: 'text', text: 'The answer is 42.' },
            ],
            tool_calls: null,
          },
        },
      ],
    };
    const { mockFetch } = mockFetchCapture(responseBody);
    const client = createProviderClient(mistralProfile as never, 'mistral', mockFetch as typeof fetch);
    const result = await client.complete({
      ...BASE_REQUEST,
      model: 'magistral-medium-latest',
      thinkBudget: 'high',
    } as ProviderCompleteRequest & { thinkBudget: unknown });
    expect(result.outputText).toBe('The answer is 42.');
    expect((result as Record<string, unknown>).reasoningContent).toBe('Let me think about this carefully.');
  });

  it('handles string content (non-thinking magistral response) normally', async () => {
    const responseBody = {
      choices: [{ finish_reason: 'stop', message: { content: 'plain text', tool_calls: null } }],
    };
    const { mockFetch } = mockFetchCapture(responseBody);
    const client = createProviderClient(mistralProfile as never, 'mistral', mockFetch as typeof fetch);
    const result = await client.complete({
      ...BASE_REQUEST,
      model: 'magistral-medium-latest',
    });
    expect(result.outputText).toBe('plain text');
    expect((result as Record<string, unknown>).reasoningContent).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Unknown models: no reasoning params sent
// ---------------------------------------------------------------------------

describe('Unknown models — no reasoning params', () => {
  it('does not send reasoning_effort for an unknown model with thinkBudget set', async () => {
    const { captured, mockFetch } = mockFetchCapture();
    const client = createProviderClient(makeProfile({ model: 'some-custom-llm-v1' }), 'openai-compatible', mockFetch as typeof fetch);
    await client.complete({
      ...BASE_REQUEST,
      model: 'some-custom-llm-v1',
      thinkBudget: 'high',
    } as ProviderCompleteRequest & { thinkBudget: unknown });
    expect(captured[0]?.body?.reasoning_effort).toBeUndefined();
  });
});
