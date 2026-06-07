import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export type ProviderTypeSpec = {
  value: string;
  label: string;
  defaultUrl: string;
  needsKey: boolean;
  keyOptional?: boolean;
  keyHint?: string;
  cloud?: boolean;
  aliases?: readonly string[];
};

export type ProviderTypePayload = {
  value: string;
  label: string;
  defaultUrl: string;
  needsKey: boolean;
  keyOptional: boolean;
  keyHint: string;
  cloud: boolean;
  aliases: string[];
};

export type ProviderTypeResolution = {
  requestedType: string;
  normalizedType: string;
  available: boolean;
  resolvedType: string;
  fallbackType: string | null;
  reason: string | null;
};

type OptionalProviderDescriptor = {
  spec: ProviderTypeSpec;
  probePaths: readonly string[];
};

const BUILTIN_SPECS: readonly ProviderTypeSpec[] = [
  {
    value: 'openai',
    label: 'OpenAI',
    defaultUrl: 'https://api.openai.com/v1',
    needsKey: true,
    cloud: true,
  },
  {
    value: 'anthropic',
    label: 'Anthropic',
    defaultUrl: 'https://api.anthropic.com/v1',
    needsKey: true,
    cloud: true,
    aliases: ['claude'],
  },
  {
    value: 'openrouter',
    label: 'OpenRouter',
    defaultUrl: 'https://openrouter.ai/api/v1',
    needsKey: true,
    cloud: true,
  },
  {
    value: 'mistral',
    label: 'Mistral',
    defaultUrl: 'https://api.mistral.ai/v1',
    needsKey: true,
    cloud: true,
  },
  {
    value: 'ollama',
    label: 'Ollama',
    defaultUrl: 'http://127.0.0.1:11434/v1',
    needsKey: false,
    cloud: false,
  },
  {
    value: 'lmstudio',
    label: 'LM Studio',
    defaultUrl: 'http://127.0.0.1:1234/v1',
    needsKey: false,
    cloud: false,
    aliases: ['lm-studio'],
  },
  {
    value: 'openai-codex',
    label: 'ChatGPT Plus/Pro (Codex OAuth)',
    defaultUrl: 'https://chatgpt.com/backend-api',
    needsKey: false,
    keyOptional: true,
    keyHint: 'Uses your ChatGPT subscription via OAuth — no API key needed.',
    cloud: true,
    aliases: ['codex', 'chatgpt-codex'],
  },
  {
    value: 'openai_compatible',
    label: 'Custom (OpenAI-compatible)',
    defaultUrl: '',
    needsKey: true,
    cloud: true,
    aliases: ['openai-compatible', 'custom'],
  },
];

const OPTIONAL_PROVIDERS: readonly OptionalProviderDescriptor[] = [
  {
    spec: {
      value: 'secondary',
      label: 'Secondary Provider',
      defaultUrl: 'https://opencode.ai/zen/v1',
      needsKey: false,
      keyOptional: true,
      keyHint: 'Free models can work without a key. Add a private key to unlock paid models.',
      cloud: true,
      aliases: ['zen'],
    },
    probePaths: [
      new URL('./secondary_provider.ts', import.meta.url),
      new URL('./secondary_provider.js', import.meta.url),
      new URL('./optional/secondary-provider.ts', import.meta.url),
      new URL('./optional/secondary-provider.js', import.meta.url),
    ].map((url) => fileURLToPath(url)),
  },
  {
    spec: {
      value: 'opencode-zen',
      label: 'OpenCode Zen',
      defaultUrl: 'https://opencode.ai/zen/v1',
      needsKey: false,
      keyOptional: true,
      keyHint: 'API key from opencode.ai/zen. Free models (big-pickle, minimax-m2.5-free, gpt-5-nano) work without a key.',
      cloud: true,
      aliases: ['opencode', 'opencode.ai'],
    },
    probePaths: [
      new URL('./opencode-zen-provider.ts', import.meta.url),
      new URL('./opencode-zen-provider.js', import.meta.url),
    ].map((url) => fileURLToPath(url)),
  },
];

const DEFAULT_FALLBACK_PROVIDER = 'openai';

export function providerSpecs(): ProviderTypeSpec[] {
  return [...BUILTIN_SPECS, ...loadOptionalSpecs()];
}

export function getProviderSpec(providerType: string): ProviderTypeSpec | null {
  const normalized = providerType.trim().toLowerCase();

  for (const spec of providerSpecs()) {
    if (matchesProviderType(spec, normalized)) {
      return spec;
    }
  }

  return null;
}

export function normalizeProviderType(providerType: string): string {
  const availableSpec = getProviderSpec(providerType);

  if (availableSpec) {
    return availableSpec.value;
  }

  const optionalSpec = getOptionalProviderSpec(providerType);
  return optionalSpec?.value ?? providerType.trim().toLowerCase();
}

export function providerTypePayloads(): ProviderTypePayload[] {
  return providerSpecs().map(toProviderTypePayload);
}

export function resolveProviderType(providerType: string): ProviderTypeResolution {
  const requestedType = providerType.trim();
  const availableSpec = getProviderSpec(requestedType);

  if (availableSpec) {
    return {
      requestedType,
      normalizedType: availableSpec.value,
      available: true,
      resolvedType: availableSpec.value,
      fallbackType: null,
      reason: null,
    };
  }

  const optionalSpec = getOptionalProviderSpec(requestedType);

  if (optionalSpec) {
    return {
      requestedType,
      normalizedType: optionalSpec.value,
      available: false,
      resolvedType: DEFAULT_FALLBACK_PROVIDER,
      fallbackType: DEFAULT_FALLBACK_PROVIDER,
      reason: `Provider type "${optionalSpec.value}" is unavailable.`,
    };
  }

  return {
    requestedType,
    normalizedType: requestedType.toLowerCase(),
    available: false,
    resolvedType: DEFAULT_FALLBACK_PROVIDER,
    fallbackType: DEFAULT_FALLBACK_PROVIDER,
    reason: `Provider type "${requestedType}" is unknown.`,
  };
}

function loadOptionalSpecs(): ProviderTypeSpec[] {
  return OPTIONAL_PROVIDERS.filter((descriptor) =>
    descriptor.probePaths.some((probePath) => fs.existsSync(probePath)),
  ).map((descriptor) => descriptor.spec);
}

function getOptionalProviderSpec(providerType: string): ProviderTypeSpec | null {
  const normalized = providerType.trim().toLowerCase();

  for (const descriptor of OPTIONAL_PROVIDERS) {
    if (matchesProviderType(descriptor.spec, normalized)) {
      return descriptor.spec;
    }
  }

  return null;
}

function matchesProviderType(spec: ProviderTypeSpec, value: string): boolean {
  if (spec.value === value) {
    return true;
  }

  return spec.aliases?.includes(value) ?? false;
}

function toProviderTypePayload(spec: ProviderTypeSpec): ProviderTypePayload {
  return {
    value: spec.value,
    label: spec.label,
    defaultUrl: spec.defaultUrl,
    needsKey: spec.needsKey,
    keyOptional: spec.keyOptional ?? false,
    keyHint: spec.keyHint ?? '',
    cloud: spec.cloud ?? true,
    aliases: [...(spec.aliases ?? [])],
  };
}
