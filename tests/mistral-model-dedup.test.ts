/**
 * Tests for Mistral model list deduplication and family extraction.
 * Validates that normalizeMistralListedModels collapses dated/versioned aliases
 * into single family entries and returns correct display names.
 */
import { describe, expect, it, vi } from 'vitest';
import { createProviderClient } from '../src/providers/provider-client.js';

vi.mock('../src/debug/runtime-debug.js', () => ({ writeDebugEvent: vi.fn() }));

function makeProfile(model = 'mistral-large-latest') {
  return {
    id: 'mistral-test',
    type: 'mistral',
    normalizedType: 'mistral',
    label: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    model,
    enabled: true,
    extraHeaders: {},
    options: {},
    hasApiKey: true,
    apiKey: 'test-key',
    needsKey: true,
    keyOptional: false,
    status: 'connected' as const,
  };
}

function makeApiResponse(
  models: Array<{
    id: string;
    name?: string;
    context_window?: number;
    deprecation?: string | null;
    archived?: boolean;
    capabilities?: Record<string, boolean>;
  }>,
) {
  return JSON.stringify({
    data: models.map((m) => ({
      id: m.id,
      name: m.name ?? m.id,
      context_window: m.context_window ?? 128000,
      deprecation: m.deprecation ?? null,
      archived: m.archived ?? false,
      capabilities: m.capabilities ?? {
        completion_chat: true,
        function_calling: true,
      },
    })),
  });
}

async function listModels(
  models: Array<{
    id: string;
    name?: string;
    context_window?: number;
    deprecation?: string | null;
    archived?: boolean;
    capabilities?: Record<string, boolean>;
  }>,
) {
  const body = makeApiResponse(models);
  const fetcher = vi
    .fn()
    .mockResolvedValue(
      new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }),
    );
  const client = createProviderClient(makeProfile(), 'mistral', fetcher);
  return client.listModels();
}

// ---------------------------------------------------------------------------
// Family extraction via iterative suffix stripping
// ---------------------------------------------------------------------------

describe('Mistral family deduplication', () => {
  it('deduplicates -latest vs dated version into one entry', async () => {
    const result = await listModels([{ id: 'mistral-large-latest' }, { id: 'mistral-large-2411' }]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('mistral-large-latest');
  });

  it('deduplicates version suffix -3-5 into same family as -latest', async () => {
    const result = await listModels([
      { id: 'mistral-medium-latest' },
      { id: 'mistral-medium-2604' },
      { id: 'mistral-medium-3-5' },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('mistral-medium-latest');
  });

  it('handles compound suffix -3-5-2604 (two iterations needed)', async () => {
    const result = await listModels([
      { id: 'mistral-medium-3-5-2604' },
      { id: 'mistral-medium-latest' },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('mistral-medium-latest');
  });

  it('deduplicates mistral-medium-3 into mistral-medium family', async () => {
    const result = await listModels([{ id: 'mistral-medium-latest' }, { id: 'mistral-medium-3' }]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('mistral-medium-latest');
  });

  it('does NOT strip trailing letter suffix like -3b, -7b, -8b', async () => {
    const result = await listModels([
      { id: 'ministral-3b-latest' },
      { id: 'ministral-8b-latest' },
      { id: 'open-mistral-7b' },
    ]);
    // All three are distinct families and should survive
    expect(result).toHaveLength(3);
  });

  it('keeps magistral-small and magistral-medium as separate families', async () => {
    const result = await listModels([
      { id: 'magistral-small-latest' },
      { id: 'magistral-medium-latest' },
    ]);
    expect(result).toHaveLength(2);
    const ids = result.map((m) => m.id);
    expect(ids).toContain('magistral-small-latest');
    expect(ids).toContain('magistral-medium-latest');
  });

  it('keeps devstral and devstral-small as separate families', async () => {
    const result = await listModels([{ id: 'devstral-2512' }, { id: 'devstral-small-2505' }]);
    expect(result).toHaveLength(2);
  });

  it('deduplicates open-mistral-nemo vs open-mistral-nemo-2407', async () => {
    const result = await listModels([
      { id: 'open-mistral-nemo' },
      { id: 'open-mistral-nemo-2407' },
    ]);
    expect(result).toHaveLength(1);
  });

  it('prefers non-deprecated over deprecated in same family', async () => {
    const result = await listModels([
      { id: 'pixtral-large-2411', deprecation: '2025-01-01' },
      { id: 'pixtral-large-latest' },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('pixtral-large-latest');
    expect(result[0].tags).not.toContain('deprecated');
  });

  it('filters out archived models', async () => {
    const result = await listModels([
      { id: 'old-mistral-model', archived: true },
      { id: 'mistral-large-latest' },
    ]);
    const ids = result.map((m) => m.id);
    expect(ids).not.toContain('old-mistral-model');
    expect(ids).toContain('mistral-large-latest');
  });

  it('pre-deduplicates identical IDs returned twice by API', async () => {
    const result = await listModels([
      { id: 'mistral-small-latest' },
      { id: 'mistral-small-latest' }, // exact duplicate from API
    ]);
    expect(result).toHaveLength(1);
  });

  it('deduplicates full realistic Mistral API model set correctly', async () => {
    const result = await listModels([
      { id: 'magistral-small-latest' },
      { id: 'magistral-medium-latest' },
      { id: 'magistral-medium-2509' },
      { id: 'mistral-large-latest' },
      { id: 'mistral-large-2411' },
      { id: 'mistral-medium-3-5' },
      { id: 'mistral-medium-3-5-2604' },
      { id: 'mistral-small-latest' },
      { id: 'mistral-small-2603' },
      { id: 'devstral-2512' },
      { id: 'devstral-small-2505' },
      { id: 'codestral-latest' },
      { id: 'codestral-mamba-latest' },
      { id: 'ministral-3b-latest' },
      { id: 'ministral-8b-latest' },
      { id: 'pixtral-large-latest' },
      { id: 'pixtral-12b-2409' },
      { id: 'open-mistral-7b' },
      { id: 'open-mixtral-8x7b' },
      { id: 'open-mixtral-8x22b' },
      { id: 'open-mistral-nemo' },
      { id: 'open-mistral-nemo-2407' },
    ]);
    // Each distinct model family should appear exactly once
    const ids = result.map((m) => m.id);
    const uniqueIds = new Set(ids);
    expect(ids.length).toBe(uniqueIds.size);
    // Should be significantly fewer than 22 raw inputs
    expect(result.length).toBeLessThan(20);
    expect(result.length).toBeGreaterThan(10);
  });
});

// ---------------------------------------------------------------------------
// Display name formatting
// ---------------------------------------------------------------------------

describe('Mistral display name formatting', () => {
  it('formats magistral-small-latest → Magistral Small (Latest)', async () => {
    const result = await listModels([
      { id: 'magistral-small-latest', name: 'magistral-small-latest' },
    ]);
    expect(result[0].name).toBe('Magistral Small (Latest)');
  });

  it('formats mistral-large-latest → Mistral Large (Latest)', async () => {
    const result = await listModels([{ id: 'mistral-large-latest', name: 'mistral-large-latest' }]);
    expect(result[0].name).toBe('Mistral Large (Latest)');
  });

  it('formats devstral-2512 → Devstral 2512', async () => {
    const result = await listModels([{ id: 'devstral-2512', name: 'devstral-2512' }]);
    expect(result[0].name).toBe('Devstral 2512');
  });

  it('keeps API-provided name when it differs from id', async () => {
    const result = await listModels([{ id: 'mistral-small-latest', name: 'Mistral Small' }]);
    expect(result[0].name).toBe('Mistral Small');
  });

  it('formats open-mistral-nemo → Open Mistral Nemo', async () => {
    const result = await listModels([{ id: 'open-mistral-nemo', name: 'open-mistral-nemo' }]);
    expect(result[0].name).toBe('Open Mistral Nemo');
  });
});

// ---------------------------------------------------------------------------
// Sorting: magistral first, deprecated last
// ---------------------------------------------------------------------------

describe('Mistral model sorting', () => {
  it('puts magistral models before mistral-large', async () => {
    const result = await listModels([
      { id: 'mistral-large-latest' },
      { id: 'magistral-medium-latest' },
    ]);
    expect(result[0].id).toBe('magistral-medium-latest');
  });

  it('puts deprecated models last', async () => {
    const result = await listModels([
      { id: 'pixtral-large-2411', deprecation: '2025-01-01' },
      { id: 'magistral-small-latest' },
      { id: 'mistral-large-latest' },
    ]);
    expect(result.at(-1)?.id).toBe('pixtral-large-2411');
  });
});
