import fs from 'node:fs';
import { resolveRuntimeLayout } from './runtime-layout.js';

export type RuntimeSettings = {
  version: 1;
  defaultProjectPath: string | null;
  memories: {
    useMemories: boolean;
    generateMemories: boolean;
    draftPersistence: boolean;
  };
  compression: {
    level: import('../utils/compression.js').CompressionLevel;
  };
  vectorStore: {
    backend: 'better-sqlite3+sqlite-vec';
    sqliteVecModulePath: string | null;
  };
  embeddings: {
    backend: 'transformers-js';
    model: 'onnx-community/all-MiniLM-L6-v2-ONNX';
    transformersModulePath: string | null;
    autoDownloadEnabled: true;
  };
  tools: {
    customPaths: Record<string, string>;
  };
  webSearch: {
    mode: 'off' | 'cached' | 'live';
    providerId: string;
    providers: Record<
      string,
      {
        apiKey: string | null;
        baseUrl: string | null;
      }
    >;
  };
};

const defaultSettings: RuntimeSettings = {
  version: 1,
  defaultProjectPath: null,
  memories: {
    useMemories: true,
    generateMemories: true,
    draftPersistence: true,
  },
  compression: {
    level: 'standard',
  },
  vectorStore: {
    backend: 'better-sqlite3+sqlite-vec',
    sqliteVecModulePath: null,
  },
  embeddings: {
    backend: 'transformers-js',
    model: 'onnx-community/all-MiniLM-L6-v2-ONNX',
    transformersModulePath: null,
    autoDownloadEnabled: true,
  },
  tools: {
    customPaths: {},
  },
  webSearch: {
    mode: 'live',
    providerId: 'ddg',
    providers: {
      ddg: {
        apiKey: null,
        baseUrl: null,
      },
      jina: {
        apiKey: null,
        baseUrl: null,
      },
      searxng: {
        apiKey: null,
        baseUrl: null,
      },
      brave: {
        apiKey: null,
        baseUrl: null,
      },
      tavily: {
        apiKey: null,
        baseUrl: null,
      },
    },
  },
};

export function loadRuntimeSettings(): RuntimeSettings {
  const { settingsPath } = resolveRuntimeLayout();

  if (!fs.existsSync(settingsPath)) {
    return structuredClone(defaultSettings);
  }

  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Partial<RuntimeSettings>;
    const rawEmbeddings = raw.embeddings as
      | {
          backend?: string;
          model?: string;
        }
      | undefined;
    const merged = {
      ...structuredClone(defaultSettings),
      ...raw,
      memories: {
        ...defaultSettings.memories,
        ...raw.memories,
      },
      compression: {
        ...defaultSettings.compression,
        ...raw.compression,
      },
      vectorStore: {
        ...defaultSettings.vectorStore,
        ...raw.vectorStore,
      },
      embeddings: {
        ...defaultSettings.embeddings,
        ...raw.embeddings,
      },
      tools: {
        ...defaultSettings.tools,
        ...raw.tools,
        customPaths: {
          ...defaultSettings.tools.customPaths,
          ...(raw.tools?.customPaths ?? {}),
        },
      },
      webSearch: {
        ...defaultSettings.webSearch,
        ...(isRecord(raw.webSearch) ? raw.webSearch : {}),
        providers: mergeWebSearchProviders(
          defaultSettings.webSearch.providers,
          isRecord(raw.webSearch) ? raw.webSearch.providers : undefined,
        ),
      },
    };

    if (rawEmbeddings?.backend !== undefined && rawEmbeddings.backend !== 'transformers-js') {
      merged.embeddings = { ...defaultSettings.embeddings };
    }

    if (rawEmbeddings?.model === 'umbra-hash-v1') {
      merged.embeddings = { ...defaultSettings.embeddings };
    }

    if (merged.vectorStore.backend !== 'better-sqlite3+sqlite-vec') {
      merged.vectorStore = { ...defaultSettings.vectorStore };
    }

    if (
      merged.webSearch.mode !== 'off' &&
      merged.webSearch.mode !== 'cached' &&
      merged.webSearch.mode !== 'live'
    ) {
      merged.webSearch.mode = defaultSettings.webSearch.mode;
    }

    if (
      typeof merged.webSearch.providerId !== 'string' ||
      merged.webSearch.providerId.trim().length === 0
    ) {
      merged.webSearch.providerId = defaultSettings.webSearch.providerId;
    }

    // Auto-migrate: if active provider requires an API key and none is set,
    // fall back to 'jina' (free, no key required) so search works out of the box.
    // Auto-migrate: if provider requires API key and none is set, switch to ddg (zero-config).
    const keyRequiredProviders: Record<string, string> = {
      brave: 'BRAVE_SEARCH_API_KEY',
      tavily: 'TAVILY_API_KEY',
    };
    const currentId = merged.webSearch.providerId;
    const envVarName = keyRequiredProviders[currentId];
    if (envVarName) {
      const providerEntry = merged.webSearch.providers[currentId];
      const envKey = process.env[envVarName]?.trim();
      if (!providerEntry?.apiKey && !envKey) {
        merged.webSearch.providerId = 'ddg';
      }
    }

    return merged;
  } catch {
    return structuredClone(defaultSettings);
  }
}

export function saveRuntimeSettings(settings: RuntimeSettings): RuntimeSettings {
  const { settingsPath } = resolveRuntimeLayout();
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  return settings;
}

export function updateRuntimeSettings(
  updater: (current: RuntimeSettings) => RuntimeSettings,
): RuntimeSettings {
  return saveRuntimeSettings(updater(loadRuntimeSettings()));
}

export function ensureRuntimeSettings(): RuntimeSettings {
  const settings = loadRuntimeSettings();
  return saveRuntimeSettings(settings);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mergeWebSearchProviders(
  defaults: RuntimeSettings['webSearch']['providers'],
  rawProviders: unknown,
): RuntimeSettings['webSearch']['providers'] {
  const merged: RuntimeSettings['webSearch']['providers'] = { ...defaults };

  if (!isRecord(rawProviders)) {
    return merged;
  }

  for (const [providerId, rawConfig] of Object.entries(rawProviders)) {
    if (!isRecord(rawConfig)) {
      continue;
    }

    const current = merged[providerId] ?? {
      apiKey: null,
      baseUrl: null,
    };
    merged[providerId] = {
      apiKey: typeof rawConfig.apiKey === 'string' ? rawConfig.apiKey : current.apiKey,
      baseUrl: typeof rawConfig.baseUrl === 'string' ? rawConfig.baseUrl : current.baseUrl,
    };
  }

  return merged;
}
