import { describe, expect, it } from 'vitest';
import {
  ModelsRegistry,
  buildHeuristicCapabilities,
  findModelInDataset,
  flattenModelsDevDataset,
  normalizeModelId,
} from '../src/providers/index.js';

describe('models registry', () => {
  it('flattens provider grouped models.dev payloads', () => {
    const dataset = flattenModelsDevDataset({
      anthropic: {
        models: {
          'anthropic/claude-sonnet-4-20250514': {
            tool_call: true,
          },
        },
      },
    });

    expect(dataset['anthropic/claude-sonnet-4-20250514']?.provider).toBe('anthropic');
    expect(dataset['anthropic/claude-sonnet-4-20250514']?.tool_call).toBe(true);
  });

  it('normalizes suffixes and finds close matches from models.dev', async () => {
    const registry = new ModelsRegistry({
      datasetLoader: async () => ({
        anthropic: {
          models: {
            'anthropic/claude-sonnet-4-20250514': {
              tool_call: true,
              reasoning: true,
              attachment: true,
              structured_output: true,
              temperature: false,
              interleaved: { field: 'reasoning_details' },
              limit: { context: 200000 },
              modalities: { input: ['text', 'image'], output: ['text'] },
            },
          },
        },
      }),
    });

    const payload = await registry.getModelCapabilities('claude-sonnet-4-20250514:free');

    expect(normalizeModelId('claude-sonnet-4-20250514:free')).toBe('claude-sonnet-4-20250514');
    expect(payload.source).toBe('models.dev');
    expect(payload.matchedModelId).toBe('anthropic/claude-sonnet-4-20250514');
    expect(payload.supportsVision).toBe(true);
    expect(payload.supportsTools).toBe(true);
    expect(payload.supportsReasoning).toBe(true);
    expect(payload.longContext).toBe(true);
    expect(payload.interleaved).toBe('reasoning_details');
  });

  it('falls back to heuristics when the model is missing', async () => {
    const registry = new ModelsRegistry({
      datasetLoader: async () => ({}),
    });

    const payload = await registry.getModelCapabilities('openai/gpt-5');

    expect(payload.source).toBe('heuristic');
    expect(payload.supportsTools).toBe(true);
    expect(payload.supportsReasoning).toBe(true);
  });

  it('supports direct dataset lookups by normalized id', () => {
    const dataset = flattenModelsDevDataset({
      openai: {
        models: {
          'openai/gpt-4.1': {
            tool_call: true,
          },
        },
      },
    });

    expect(findModelInDataset(dataset, 'openai/gpt-4.1')?.id).toBe('openai/gpt-4.1');
    expect(buildHeuristicCapabilities('openai/gpt-4.1').supportsStructuredOutput).toBe(true);
  });
});
