import { describe, expect, it } from 'vitest';
import {
  getProviderSpec,
  normalizeProviderType,
  providerTypePayloads,
  resolveProviderType,
} from '../src/providers/index.js';

describe('provider registry', () => {
  it('returns builtin provider payloads as backend source of truth', () => {
    const payloads = providerTypePayloads();
    const values = payloads.map((payload) => payload.value);

    expect(values).toContain('openai');
    expect(values).toContain('anthropic');
    expect(values).toContain('openrouter');
    expect(values).toContain('mistral');
    expect(values).toContain('ollama');
    expect(values).toContain('lmstudio');
    expect(values).toContain('openai_compatible');
  });

  it('normalizes aliases to canonical provider types', () => {
    expect(getProviderSpec('claude')?.value).toBe('anthropic');
    expect(getProviderSpec('lm-studio')?.value).toBe('lmstudio');
    expect(normalizeProviderType('custom')).toBe('openai_compatible');
  });

});
