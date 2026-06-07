import { z } from 'zod';
import type {
  WebSearchProviderPayload,
  WebSearchSettingsPayload,
  WebSearchSettingsUpdatePayload,
} from '../core/contracts.js';
import {
  type RuntimeSettings,
  loadRuntimeSettings,
  updateRuntimeSettings,
} from '../memory/settings-store.js';
import type { ToolExecutionContext } from './types.js';

export const webSearchModeSchema = z.enum(['off', 'cached', 'live']);
export type WebSearchMode = z.infer<typeof webSearchModeSchema>;

export const webSearchSettingsUpdateSchema = z
  .object({
    mode: webSearchModeSchema.optional(),
    providerId: z.string().min(1).optional(),
    providerConfig: z
      .object({
        id: z.string().min(1),
        apiKey: z.string().nullable().optional(),
        baseUrl: z.string().nullable().optional(),
      })
      .optional(),
  })
  .strict();

export const webSearchInputSchema = z.object({
  query: z.string().min(1),
  maxResults: z.number().int().min(1).max(10).default(5),
  domains: z.array(z.string().min(1)).max(10).optional(),
});

export const webSearchOutputSchema = z.object({
  query: z.string(),
  mode: z.enum(['cached', 'live']),
  providerId: z.string(),
  results: z.array(
    z.object({
      rank: z.number().int().min(1),
      title: z.string(),
      url: z.string().url(),
      snippet: z.string(),
      displayUrl: z.string().optional(),
    }),
  ),
});

type WebSearchProviderId = 'brave' | 'tavily' | 'jina' | 'searxng' | 'ddg';

type ResolvedProviderAuth = {
  apiKey: string | null;
  baseUrl: string;
  authSource: WebSearchProviderPayload['authSource'];
};

type WebSearchProviderSpec = {
  id: WebSearchProviderId;
  label: string;
  type: WebSearchProviderPayload['type'];
  defaultBaseUrl: string;
  apiKeyEnv: string;
  baseUrlEnv: string;
  /** When false the provider works without an API key (free tier). */
  requiresApiKey?: boolean;
  execute(
    request: {
      query: string;
      maxResults: number;
      mode: Exclude<WebSearchMode, 'off'>;
    },
    auth: ResolvedProviderAuth,
    fetcher: typeof fetch,
    signal?: AbortSignal,
  ): Promise<z.infer<typeof webSearchOutputSchema>['results']>;
};

export class WebSearchService {
  readonly #fetcher: typeof fetch;
  readonly #settingsLoader: () => RuntimeSettings;

  constructor(input?: {
    fetcher?: typeof fetch;
    settingsLoader?: () => RuntimeSettings;
  }) {
    this.#fetcher = input?.fetcher ?? globalThis.fetch;
    this.#settingsLoader = input?.settingsLoader ?? loadRuntimeSettings;
  }

  getSettingsPayload(): WebSearchSettingsPayload {
    const settings = this.#settingsLoader();
    const providerId = normalizeProviderId(settings.webSearch.providerId);
    const provider = providerRegistry[providerId];
    const providers = Object.values(providerRegistry).map((spec) =>
      this.#buildProviderPayload(spec, spec.id === providerId, settings),
    );
    const active = providers.find((entry) => entry.id === providerId) ?? providers[0];

    return {
      mode: settings.webSearch.mode,
      enabled: settings.webSearch.mode !== 'off',
      providerId,
      providerLabel: active?.label ?? provider.label,
      configured: active?.configured ?? false,
      availableProviders: providers,
    };
  }

  updateSettings(input: WebSearchSettingsUpdatePayload): WebSearchSettingsPayload {
    const nextProviderId =
      input.providerId !== undefined ? normalizeProviderId(input.providerId) : undefined;

    updateRuntimeSettings((current) => {
      const candidateId = nextProviderId ?? normalizeProviderId(current.webSearch.providerId);
      const candidateSpec = providerRegistry[candidateId];

      const activatingMode = input.mode && input.mode !== 'off' && current.webSearch.mode === 'off';
      const currentAuth = this.#resolveProviderAuth(candidateSpec, current);
      const currentlyConfigured =
        candidateSpec.requiresApiKey === false ? true : Boolean(currentAuth.apiKey);

      let resolvedProviderId = candidateId;
      if (activatingMode && !currentlyConfigured && !nextProviderId) {
        const fallback = pickFreeProvider(current);
        if (fallback) resolvedProviderId = fallback;
      }

      let providers = current.webSearch.providers;
      if (input.providerConfig) {
        const cfgId = normalizeProviderId(input.providerConfig.id);
        const existing = current.webSearch.providers[cfgId] ?? { apiKey: null, baseUrl: null };
        providers = {
          ...providers,
          [cfgId]: {
            apiKey: input.providerConfig.apiKey !== undefined ? input.providerConfig.apiKey : existing.apiKey,
            baseUrl: input.providerConfig.baseUrl !== undefined ? input.providerConfig.baseUrl : existing.baseUrl,
          },
        };
      }

      return {
        ...current,
        webSearch: {
          ...current.webSearch,
          ...(input.mode ? { mode: input.mode } : {}),
          providerId: resolvedProviderId,
          providers,
        },
      };
    });
    return this.getSettingsPayload();
  }

  async executeSearch(
    input: z.infer<typeof webSearchInputSchema>,
    context: ToolExecutionContext,
  ): Promise<z.infer<typeof webSearchOutputSchema>> {
    const settings = this.#settingsLoader();
    if (settings.webSearch.mode === 'off') {
      throw new Error('web.search is disabled. Enable it with /web on.');
    }

    const providerId = normalizeProviderId(settings.webSearch.providerId);
    const provider = providerRegistry[providerId];
    const auth = this.#resolveProviderAuth(provider, settings);

    if (!auth.apiKey && provider.requiresApiKey !== false) {
      throw new Error(
        `Web search provider "${provider.label}" is not configured. Set ${provider.apiKeyEnv} or update ~/.umbra/settings.json.`,
      );
    }

    const query = applyDomainFilters(input.query, input.domains);
    try {
      const results = await provider.execute(
        {
          query,
          maxResults: input.maxResults,
          mode: settings.webSearch.mode,
        },
        auth,
        this.#fetcher,
        context.signal,
      );
      return {
        query: input.query,
        mode: settings.webSearch.mode,
        providerId,
        results,
      };
    } catch (error) {
      throw normalizeProviderError(provider.label, error);
    }
  }

  #buildProviderPayload(
    provider: WebSearchProviderSpec,
    selected: boolean,
    settings: RuntimeSettings,
  ): WebSearchProviderPayload {
    const auth = this.#resolveProviderAuth(provider, settings);
    return {
      id: provider.id,
      label: provider.label,
      type: provider.type,
      configured: provider.requiresApiKey === false ? true : Boolean(auth.apiKey),
      selected,
      baseUrl: auth.baseUrl,
      authSource: auth.authSource,
    };
  }

  #resolveProviderAuth(
    provider: WebSearchProviderSpec,
    settings: RuntimeSettings,
  ): ResolvedProviderAuth {
    const runtimeEntry = settings.webSearch.providers[provider.id] ?? {
      apiKey: null,
      baseUrl: null,
    };
    const envApiKey = process.env[provider.apiKeyEnv]?.trim() || null;
    const envBaseUrl = process.env[provider.baseUrlEnv]?.trim() || null;

    const apiKey = envApiKey ?? runtimeEntry.apiKey ?? null;
    const baseUrl = envBaseUrl ?? runtimeEntry.baseUrl ?? provider.defaultBaseUrl;
    const authSource = envApiKey
      ? 'env'
      : runtimeEntry.apiKey
        ? 'runtime'
        : envBaseUrl || runtimeEntry.baseUrl || provider.requiresApiKey === false
          ? 'default'
          : 'missing';

    return {
      apiKey,
      baseUrl,
      authSource,
    };
  }
}

const providerRegistry: Record<WebSearchProviderId, WebSearchProviderSpec> = {
  ddg: {
    id: 'ddg',
    label: 'DuckDuckGo',
    type: 'serp-only',
    requiresApiKey: false,
    defaultBaseUrl: 'https://html.duckduckgo.com',
    apiKeyEnv: 'DDG_API_KEY',
    baseUrlEnv: 'DDG_BASE_URL',
    async execute(request, _auth, fetcher, signal) {
      const body = new URLSearchParams({ q: request.query, b: '' });
      const response = await fetcher('https://html.duckduckgo.com/html/', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
        body: body.toString(),
        ...(signal ? { signal } : {}),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return parseDdgHtml(await response.text(), request.maxResults);
    },
  },
  jina: {
    id: 'jina',
    label: 'Jina Search',
    type: 'neural',
    requiresApiKey: false,
    defaultBaseUrl: 'https://s.jina.ai',
    apiKeyEnv: 'JINA_API_KEY',
    baseUrlEnv: 'JINA_BASE_URL',
    async execute(request, auth, fetcher, signal) {
      const url = `${auth.baseUrl}/${encodeURIComponent(request.query)}`;
      const headers: Record<string, string> = {
        'X-No-Cache': request.mode === 'live' ? 'true' : 'false',
      };
      // JSON mode requires an API key; without one Jina returns plain text or HTML
      if (auth.apiKey) {
        headers.Authorization = `Bearer ${auth.apiKey}`;
        headers.Accept = 'application/json';
      } else {
        headers.Accept = 'text/plain, */*';
      }

      const response = await fetcher(url, { headers, ...(signal ? { signal } : {}) });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const contentType = response.headers.get('content-type') ?? '';
      const body = await response.text();

      // JSON response (with API key)
      if (contentType.includes('application/json') && !body.trimStart().startsWith('<')) {
        const payload = JSON.parse(body) as {
          code?: number;
          data?: Array<{ title?: string; url?: string; description?: string; content?: string }>;
        };
        const results = payload.data ?? [];
        return results
          .filter(
            (e): e is { title: string; url: string; description?: string; content?: string } =>
              typeof e?.title === 'string' && typeof e.url === 'string',
          )
          .slice(0, request.maxResults)
          .map((e, i) => ({
            rank: i + 1,
            title: e.title,
            url: e.url,
            snippet: (e.description ?? e.content ?? '').trim(),
            displayUrl: e.url,
          }));
      }

      // HTML error page — Jina rejected the request
      if (body.trimStart().startsWith('<')) {
        throw new Error(
          'Jina Search returned an error page. Set JINA_API_KEY for reliable access, or use /web provider searxng.',
        );
      }

      // Plain text / markdown format (free tier, no key)
      return parseJinaTextResults(body, request.maxResults);
    },
  },
  searxng: {
    id: 'searxng',
    label: 'SearXNG (self-hosted)',
    type: 'serp-only',
    requiresApiKey: false,
    defaultBaseUrl: 'http://localhost:8080',
    apiKeyEnv: 'SEARXNG_API_KEY',
    baseUrlEnv: 'SEARXNG_BASE_URL',
    async execute(request, auth, fetcher, signal) {
      const url = new URL(`${auth.baseUrl}/search`);
      url.searchParams.set('q', request.query);
      url.searchParams.set('format', 'json');
      url.searchParams.set('count', String(request.maxResults));
      if (request.mode === 'live') {
        url.searchParams.set('safesearch', '0');
      }

      const headers: Record<string, string> = { Accept: 'application/json' };
      if (auth.apiKey) {
        headers.Authorization = `Bearer ${auth.apiKey}`;
      }

      const response = await fetcher(url, { headers, ...(signal ? { signal } : {}) });
      const payload = (await response.json()) as {
        results?: Array<{ title?: string; url?: string; content?: string }>;
        error?: string;
      };

      if (!response.ok) {
        throw new Error(payload.error ?? `HTTP ${response.status}`);
      }

      const results = payload.results ?? [];
      return results
        .filter(
          (e): e is { title: string; url: string; content?: string } =>
            typeof e?.title === 'string' && typeof e.url === 'string',
        )
        .slice(0, request.maxResults)
        .map((e, i) => ({
          rank: i + 1,
          title: e.title,
          url: e.url,
          snippet: (e.content ?? '').trim(),
          displayUrl: e.url,
        }));
    },
  },
  brave: {
    id: 'brave',
    label: 'Brave Search',
    type: 'serp-only',
    defaultBaseUrl: 'https://api.search.brave.com/res/v1/web/search',
    apiKeyEnv: 'BRAVE_SEARCH_API_KEY',
    baseUrlEnv: 'BRAVE_SEARCH_BASE_URL',
    async execute(request, auth, fetcher, signal) {
      const url = new URL(auth.baseUrl);
      url.searchParams.set('q', request.query);
      url.searchParams.set('count', String(request.maxResults));
      url.searchParams.set('extra_snippets', 'true');

      const response = await fetcher(url, {
        headers: {
          Accept: 'application/json',
          'X-Subscription-Token': auth.apiKey ?? '',
        },
        ...(signal ? { signal } : {}),
      });
      const payload = (await response.json()) as {
        web?: {
          results?: Array<{
            title?: string;
            url?: string;
            description?: string;
            extra_snippets?: string[];
          }>;
        };
        error?: { message?: string };
      };

      if (!response.ok) {
        throw new Error(payload.error?.message ?? `HTTP ${response.status}`);
      }

      const results = payload.web?.results ?? [];

      return results
        .filter(
          (
            entry,
          ): entry is {
            title: string;
            url: string;
            description?: string;
            extra_snippets?: string[];
          } => typeof entry?.title === 'string' && typeof entry.url === 'string',
        )
        .slice(0, request.maxResults)
        .map((entry, index) => ({
          rank: index + 1,
          title: entry.title,
          url: entry.url,
          snippet: [entry.description ?? '', ...(entry.extra_snippets ?? [])].join(' ').trim(),
          displayUrl: entry.url,
        }));
    },
  },
  tavily: {
    id: 'tavily',
    label: 'Tavily',
    type: 'neural',
    defaultBaseUrl: 'https://api.tavily.com/search',
    apiKeyEnv: 'TAVILY_API_KEY',
    baseUrlEnv: 'TAVILY_BASE_URL',
    async execute(request, auth, fetcher, signal) {
      const response = await fetcher(auth.baseUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          api_key: auth.apiKey,
          query: request.query,
          max_results: request.maxResults,
          search_depth: request.mode === 'live' ? 'advanced' : 'basic',
          include_answer: false,
          include_raw_content: false,
        }),
        ...(signal ? { signal } : {}),
      });
      const payload = (await response.json()) as {
        results?: Array<{
          title?: string;
          url?: string;
          content?: string;
        }>;
        error?: string;
      };

      if (!response.ok) {
        throw new Error(payload.error ?? `HTTP ${response.status}`);
      }

      const results = payload.results ?? [];

      return results
        .filter(
          (entry): entry is { title: string; url: string; content?: string } =>
            typeof entry?.title === 'string' && typeof entry.url === 'string',
        )
        .slice(0, request.maxResults)
        .map((entry, index) => ({
          rank: index + 1,
          title: entry.title,
          url: entry.url,
          snippet: entry.content?.trim() ?? '',
          displayUrl: entry.url,
        }));
    },
  },
};

function parseDdgHtml(
  html: string,
  maxResults: number,
): z.infer<typeof webSearchOutputSchema>['results'] {
  const results: z.infer<typeof webSearchOutputSchema>['results'] = [];

  const titleRe = /<a\s[^>]*class="result__a"[^>]*\shref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe = /<a\s[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;

  const entries: Array<{ url: string; title: string }> = [];
  const snippets: string[] = [];

  for (const m of html.matchAll(titleRe)) {
    const url = decodeEntities(m[1] ?? '').trim();
    const title = stripTags(m[2] ?? '').trim();
    if (url.startsWith('http') && title) entries.push({ url, title });
  }
  for (const m of html.matchAll(snippetRe)) {
    snippets.push(stripTags(m[1] ?? '').trim());
  }

  for (let i = 0; i < Math.min(entries.length, maxResults); i++) {
    results.push({
      rank: i + 1,
      title: entries[i]?.title ?? '',
      url: entries[i]?.url ?? '',
      snippet: snippets[i] ?? '',
      displayUrl: entries[i]?.url ?? '',
    });
  }
  return results;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseJinaTextResults(
  text: string,
  maxResults: number,
): z.infer<typeof webSearchOutputSchema>['results'] {
  const results: z.infer<typeof webSearchOutputSchema>['results'] = [];

  // Jina free-tier text format:
  //   [N]. [Title](URL)\nDescription\n\n
  // or just markdown links scattered in text
  const numbered = /^\d+\.\s+\[([^\]]+)\]\((https?:\/\/[^)]+)\)[^\n]*\n?(.*?)(?=^\d+\.|$)/gms;
  for (const m of text.matchAll(numbered)) {
    if (results.length >= maxResults) break;
    const title = (m[1] ?? '').trim();
    const url = (m[2] ?? '').trim();
    const snippet = (m[3] ?? '').replace(/\n+/g, ' ').trim();
    if (title && url)
      results.push({ rank: results.length + 1, title, url, snippet, displayUrl: url });
  }

  // Fallback: extract any markdown links [title](url)
  if (results.length === 0) {
    const links = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;
    for (const m of text.matchAll(links)) {
      if (results.length >= maxResults) break;
      const title = (m[1] ?? '').trim();
      const url = (m[2] ?? '').trim();
      if (title && url)
        results.push({ rank: results.length + 1, title, url, snippet: '', displayUrl: url });
    }
  }

  // Last resort: extract bare URLs
  if (results.length === 0) {
    const urls = /https?:\/\/[^\s"'<>]+/g;
    for (const m of text.matchAll(urls)) {
      if (results.length >= maxResults) break;
      results.push({
        rank: results.length + 1,
        title: m[0],
        url: m[0],
        snippet: '',
        displayUrl: m[0],
      });
    }
  }

  return results;
}

function pickFreeProvider(settings: RuntimeSettings): WebSearchProviderId | null {
  for (const [id, spec] of Object.entries(providerRegistry) as Array<
    [WebSearchProviderId, WebSearchProviderSpec]
  >) {
    if (spec.requiresApiKey === false) return id;
    const entry = settings.webSearch.providers[id];
    if (entry?.apiKey) return id;
    if (process.env[spec.apiKeyEnv]?.trim()) return id;
  }
  return null;
}

let serviceOverride: WebSearchService | null = null;

export function getWebSearchService(): WebSearchService {
  return serviceOverride ?? new WebSearchService();
}

export function setWebSearchServiceForTests(service: WebSearchService | null): void {
  serviceOverride = service;
}

export function getWebSearchSettings(): WebSearchSettingsPayload {
  return getWebSearchService().getSettingsPayload();
}

export function updateWebSearchSettings(
  input: WebSearchSettingsUpdatePayload,
): WebSearchSettingsPayload {
  const parsed = webSearchSettingsUpdateSchema.parse(input);
  return getWebSearchService().updateSettings({
    ...(parsed.mode ? { mode: parsed.mode } : {}),
    ...(parsed.providerId ? { providerId: parsed.providerId } : {}),
  });
}

export async function executeWebSearch(
  input: z.infer<typeof webSearchInputSchema>,
  context: ToolExecutionContext,
): Promise<z.infer<typeof webSearchOutputSchema>> {
  return getWebSearchService().executeSearch(input, context);
}

function normalizeProviderId(value: string): WebSearchProviderId {
  if (value === 'tavily') return 'tavily';
  if (value === 'jina') return 'jina';
  if (value === 'searxng') return 'searxng';
  if (value === 'brave') return 'brave';
  return 'ddg';
}

function applyDomainFilters(query: string, domains?: string[]): string {
  if (!domains || domains.length === 0) {
    return query;
  }

  const filters = domains.map((domain) => `site:${domain.trim()}`).join(' ');
  return `${query} ${filters}`.trim();
}

function normalizeProviderError(providerLabel: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (/401|403|unauthor/i.test(message)) {
    return new Error(`${providerLabel} rejected the API key or request credentials.`);
  }
  return new Error(`${providerLabel} web search failed: ${message}`);
}
