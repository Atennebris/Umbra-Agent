const MODELS_DEV_API = 'https://models.dev/api.json';
const HUGGING_FACE_MODEL_API = 'https://huggingface.co/api/models/';
const DEFAULT_MODELS_TTL_MS = 5 * 60 * 1000;

export type ModelsDevDataset = Record<string, { models?: Record<string, ModelsDevModelRecord> }>;

export type ModelsDevModelRecord = {
  name?: string;
  tool_call?: boolean;
  attachment?: boolean;
  reasoning?: boolean;
  structured_output?: boolean;
  temperature?: boolean;
  interleaved?: true | { field?: string };
  limit?: {
    context?: number;
    input?: number;
    output?: number;
  };
  pricing?: {
    input?: number;
    output?: number;
  };
  modalities?: {
    input?: string[];
    output?: string[];
  };
  [key: string]: unknown;
};

export type FlattenedModelRecord = ModelsDevModelRecord & {
  id: string;
  provider: string;
};

export type ModelCapabilitiesPayload = {
  modelId: string;
  normalizedModelId: string;
  matchedModelId: string | null;
  source: 'models.dev' | 'huggingface' | 'heuristic';
  contextWindow: number | null;
  supportsTools: boolean;
  supportsVision: boolean;
  supportsReasoning: boolean;
  supportsStructuredOutput: boolean;
  supportsAttachments: boolean;
  supportsTemperature: boolean;
  longContext: boolean;
  interleaved: 'reasoning_content' | 'reasoning_details' | null;
  inputModalities: string[];
  outputModalities: string[];
  pricingPerMillion?: {
    input: number;
    output: number;
    /** Cache read pricing per 1M tokens (defaults to ~10% of input if not set) */
    cacheRead?: number;
    /** Cache write pricing per 1M tokens (defaults to same as input if not set) */
    cacheWrite?: number;
  };
};

type ModelsRegistryOptions = {
  datasetLoader?: () => Promise<unknown>;
  ttlMs?: number;
};

type DatasetCache = {
  loadedAt: number;
  dataset: Record<string, FlattenedModelRecord>;
};

export class ModelsRegistry {
  #datasetLoader: () => Promise<unknown>;
  #ttlMs: number;
  #cache: DatasetCache | null = null;
  #loading: Promise<Record<string, FlattenedModelRecord>> | null = null;

  constructor(options: ModelsRegistryOptions = {}) {
    this.#datasetLoader = options.datasetLoader ?? defaultModelsDevLoader;
    this.#ttlMs = options.ttlMs ?? DEFAULT_MODELS_TTL_MS;
  }

  async getModelCapabilities(modelId: string): Promise<ModelCapabilitiesPayload> {
    const normalizedModelId = normalizeModelId(modelId);
    const dataset = await this.#getDataset();
    const match = findModelInDataset(dataset, normalizedModelId);

    if (!match) {
      const huggingFace = await fetchHuggingFaceCapabilities(modelId, normalizedModelId);
      return huggingFace ?? buildHeuristicCapabilities(modelId, normalizedModelId);
    }

    return buildModelsDevCapabilities(modelId, normalizedModelId, match);
  }

  async refresh(force = false): Promise<void> {
    if (force) {
      this.#cache = null;
    }

    await this.#getDataset(force);
  }

  async getDataset(force = false): Promise<Record<string, FlattenedModelRecord>> {
    return this.#getDataset(force);
  }

  async #getDataset(force = false): Promise<Record<string, FlattenedModelRecord>> {
    if (!force && this.#cache && Date.now() - this.#cache.loadedAt < this.#ttlMs) {
      return this.#cache.dataset;
    }

    if (!this.#loading) {
      this.#loading = this.#loadDataset().finally(() => {
        this.#loading = null;
      });
    }

    return this.#loading;
  }

  async #loadDataset(): Promise<Record<string, FlattenedModelRecord>> {
    const rawDataset = await this.#datasetLoader();
    const dataset = flattenModelsDevDataset(rawDataset);
    this.#cache = {
      loadedAt: Date.now(),
      dataset,
    };
    return dataset;
  }
}

export function normalizeModelId(modelId: string): string {
  const trimmed = modelId.trim();
  const [base] = trimmed.split(':');
  return (base ?? trimmed).trim().toLowerCase();
}

export function flattenModelsDevDataset(rawDataset: unknown): Record<string, FlattenedModelRecord> {
  if (!isRecord(rawDataset)) {
    return {};
  }

  const flattened: Record<string, FlattenedModelRecord> = {};

  for (const [providerId, providerData] of Object.entries(rawDataset)) {
    if (!isRecord(providerData) || !isRecord(providerData.models)) {
      continue;
    }

    for (const [modelId, modelData] of Object.entries(providerData.models)) {
      if (!isRecord(modelData)) {
        continue;
      }

      const normalizedModelId = normalizeModelId(modelId);
      flattened[normalizedModelId] = {
        ...modelData,
        id: normalizedModelId,
        provider: providerId,
      };
    }
  }

  return flattened;
}

export function findModelInDataset(
  dataset: Record<string, FlattenedModelRecord>,
  modelId: string,
): FlattenedModelRecord | null {
  if (modelId in dataset) {
    return dataset[modelId] ?? null;
  }

  if (modelId.includes('/')) {
    const [, name] = modelId.split('/', 2);

    if (name) {
      for (const candidate of Object.values(dataset)) {
        if (candidate.id.endsWith(`/${name}`) || candidate.id === name) {
          return candidate;
        }
      }
    }
  }

  let bestMatch: FlattenedModelRecord | null = null;
  let bestScore = 0;

  for (const candidate of Object.values(dataset)) {
    const score = computeMatchScore(modelId, candidate.id);

    if (score > bestScore) {
      bestScore = score;
      bestMatch = candidate;
    }
  }

  return bestScore >= 0.7 ? bestMatch : null;
}

export function buildModelsDevCapabilities(
  modelId: string,
  normalizedModelId: string,
  match: FlattenedModelRecord,
): ModelCapabilitiesPayload {
  const inputModalities = normalizeModalities(match.modalities?.input);
  const outputModalities = normalizeModalities(match.modalities?.output);
  const heuristic = buildHeuristicCapabilities(modelId, normalizedModelId);
  const contextWindow = toFiniteNumber(match.limit?.context);

  return {
    modelId,
    normalizedModelId,
    matchedModelId: match.id,
    source: 'models.dev',
    contextWindow,
    supportsTools: match.tool_call ?? heuristic.supportsTools,
    supportsVision:
      inputModalities.includes('image') ||
      inputModalities.includes('pdf') ||
      heuristic.supportsVision,
    supportsReasoning: match.reasoning ?? heuristic.supportsReasoning,
    supportsStructuredOutput: match.structured_output ?? heuristic.supportsStructuredOutput,
    supportsAttachments: match.attachment ?? heuristic.supportsAttachments,
    supportsTemperature: match.temperature ?? heuristic.supportsTemperature,
    longContext: contextWindow !== null ? contextWindow >= 100_000 : heuristic.longContext,
    interleaved: normalizeInterleaved(match.interleaved),
    inputModalities,
    outputModalities,
    ...(match.pricing
      ? {
          pricingPerMillion: {
            input: toFiniteNumber(match.pricing.input) ?? 0,
            output: toFiniteNumber(match.pricing.output) ?? 0,
          },
        }
      : {}),
  };
}

const HEURISTIC_CONTEXT_WINDOWS: Array<[RegExp, number]> = [
  [/^gpt-4\.1/, 1_047_576],
  [/^gpt-5/, 272_000],
  [/^codex-/, 200_000],
  [/^o[134](-mini|-preview)?$/, 200_000],
  [/^gpt-4o/, 128_000],
  [/^claude-3-5/, 200_000],
  [/^claude-3/, 200_000],
  [/^claude-[^1]/, 200_000],
  [/^gemini-2/, 2_000_000],
  [/^gemini-1\.5/, 1_000_000],
];

function heuristicContextWindow(id: string): number | null {
  for (const [re, win] of HEURISTIC_CONTEXT_WINDOWS) {
    if (re.test(id)) return win;
  }
  return null;
}

export function buildHeuristicCapabilities(
  modelId: string,
  normalizedModelId = normalizeModelId(modelId),
): ModelCapabilitiesPayload {
  const tools = /(gpt|claude|gemini|qwen|command|deepseek)/.test(normalizedModelId);
  const vision = /(vision|vl|4o|gemini|claude-3|claude-sonnet|pixtral)/.test(normalizedModelId);
  const reasoning =
    /(reason|thinking|o1|o3|o4|r1|gpt-5|claude-sonnet-4|big-pickle|deepseek-v4|deepseek-r)/.test(
      normalizedModelId,
    );
  const structured = /(gpt|claude|gemini|command)/.test(normalizedModelId);
  const attachments = vision;
  const longContext = /(128k|200k|256k|1m)/.test(normalizedModelId);

  return {
    modelId,
    normalizedModelId,
    matchedModelId: null,
    source: 'heuristic',
    contextWindow: heuristicContextWindow(normalizedModelId),
    supportsTools: tools,
    supportsVision: vision,
    supportsReasoning: reasoning,
    supportsStructuredOutput: structured,
    supportsAttachments: attachments,
    supportsTemperature: true,
    longContext,
    interleaved: reasoning ? 'reasoning_content' : null,
    inputModalities: vision ? ['text', 'image'] : ['text'],
    outputModalities: ['text'],
  };
}

export function buildHuggingFaceCapabilities(
  modelId: string,
  normalizedModelId: string,
  payload: unknown,
): ModelCapabilitiesPayload | null {
  if (!isRecord(payload)) {
    return null;
  }

  const tags = Array.isArray(payload.tags)
    ? payload.tags
        .filter((tag): tag is string => typeof tag === 'string')
        .map((tag) => tag.toLowerCase())
    : [];
  const pipelineTag =
    typeof payload.pipeline_tag === 'string' ? payload.pipeline_tag.toLowerCase() : '';
  const heuristic = buildHeuristicCapabilities(modelId, normalizedModelId);
  const supportsTools =
    tags.includes('tool-use') ||
    tags.includes('function-calling') ||
    tags.includes('tools') ||
    heuristic.supportsTools;
  const supportsVision =
    pipelineTag.includes('image') ||
    tags.includes('vision') ||
    tags.includes('image-text-to-text') ||
    tags.includes('multimodal') ||
    heuristic.supportsVision;
  const supportsReasoning =
    tags.includes('reasoning') || tags.includes('thinking') || heuristic.supportsReasoning;
  const longContext =
    tags.includes('long-context') ||
    tags.includes('longcontext') ||
    tags.includes('128k') ||
    heuristic.longContext;

  return {
    ...heuristic,
    source: 'huggingface',
    supportsTools,
    supportsVision,
    supportsReasoning,
    supportsAttachments: supportsVision,
    longContext,
    inputModalities: supportsVision ? ['text', 'image'] : heuristic.inputModalities,
  };
}

async function defaultModelsDevLoader(): Promise<unknown> {
  const response = await fetch(MODELS_DEV_API);

  if (!response.ok) {
    throw new Error(`models.dev API returned ${response.status}`);
  }

  return (await response.json()) as unknown;
}

async function fetchHuggingFaceCapabilities(
  modelId: string,
  normalizedModelId: string,
): Promise<ModelCapabilitiesPayload | null> {
  if (!looksLikeHuggingFaceModelId(modelId)) {
    return null;
  }

  try {
    const response = await fetch(`${HUGGING_FACE_MODEL_API}${encodeURIComponent(modelId.trim())}`);

    if (!response.ok) {
      return null;
    }

    const payload = (await response.json()) as unknown;
    return buildHuggingFaceCapabilities(modelId, normalizedModelId, payload);
  } catch {
    return null;
  }
}

function computeMatchScore(requested: string, candidate: string): number {
  const requestedValue = requested.toLowerCase();
  const candidateValue = candidate.toLowerCase();

  if (candidateValue.includes(requestedValue)) {
    return requestedValue.length / candidateValue.length;
  }

  if (requestedValue.includes(candidateValue)) {
    return candidateValue.length / requestedValue.length;
  }

  return 0;
}

function normalizeModalities(values: string[] | undefined): string[] {
  return values?.map((value) => value.toLowerCase()) ?? [];
}

function looksLikeHuggingFaceModelId(modelId: string): boolean {
  const trimmed = modelId.trim();

  if (!trimmed.includes('/')) {
    return false;
  }

  return !/^(openai|anthropic|openrouter|mistral|ollama|lmstudio|secondary)\//.test(
    trimmed.toLowerCase(),
  );
}

function normalizeInterleaved(
  value: FlattenedModelRecord['interleaved'],
): 'reasoning_content' | 'reasoning_details' | null {
  if (value === true) {
    return 'reasoning_content';
  }

  const field = value?.field;

  if (field === 'reasoning_content' || field === 'reasoning_details') {
    return field;
  }

  return null;
}

function toFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
