/**
 * OpenCode Zen provider — self-contained optional module.
 *
 * Drop this file into src/providers/ to enable the "opencode-zen" provider type.
 * Removing it disables the provider entirely without touching any other file.
 *
 * Free models (big-pickle, minimax-m2.5-free, gpt-5-nano, etc.) work without
 * an API key. Paid models require a key from https://opencode.ai/zen
 *
 * Endpoint routing is automatic by model family:
 *   gpt-5.x        → /zen/v1/responses    (OpenAI Responses API)
 *   claude-*       → /zen/v1/messages     (Anthropic Messages API)
 *   everything else→ /zen/v1/chat/completions
 */

import type {
  ProviderConnectionTestPayload,
  ProviderModelPayload,
  ProviderProfile,
} from './profile-types.js';
import {
  type FetchLike,
  type ProviderClient,
  buildZenClientFetcher,
  makeZenCompactId,
} from './provider-client.js';
import type {
  ProviderCompleteRequest,
  ProviderCompleteResponse,
  ProviderStreamObserver,
  ProviderToolCall,
} from './runtime-types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ZEN_BASE_URL = 'https://opencode.ai/zen/v1';

// Free models shown as fallback when /models endpoint is unreachable or no key.
const ZEN_FREE_MODELS: ProviderModelPayload[] = [
  { id: 'big-pickle', name: 'Big Pickle (Free)', contextWindow: 128_000 },
  { id: 'minimax-m2.5-free', name: 'MiniMax M2.5 Free', contextWindow: 40_960 },
  { id: 'gpt-5-nano', name: 'GPT 5 Nano', contextWindow: null },
  { id: 'hy3-preview-free', name: 'Hy3 Preview Free', contextWindow: 32_768 },
  { id: 'nemotron-3-super-free', name: 'Nemotron 3 Super Free', contextWindow: 128_000 },
];

// Known context windows for zen models (API does not return context_window).
// Values in tokens.
const ZEN_KNOWN_CTX: Record<string, number> = {
  'big-pickle': 128_000,
  'deepseek-v4-flash-free': 65_536,
  'deepseek-v4-flash': 65_536,
  'minimax-m2.5-free': 40_960,
  'minimax-m2.5': 40_960,
  'minimax-m3-free': 40_960,
  'minimax-m3': 40_960,
  'mimo-v2.5-free': 32_768,
  'gpt-5-nano': 128_000,
  'gpt-5-mini': 128_000,
  'hy3-preview-free': 32_768,
  'nemotron-3-super-free': 128_000,
  'qwen3.6-plus-free': 128_000,
  'qwen3.6-plus': 128_000,
};

// Display name overrides: models that are free but whose id doesn't contain "free".
const ZEN_FREE_DISPLAY: Record<string, string> = {
  'big-pickle': 'Big Pickle (Free)',
  'gpt-5-nano': 'GPT 5 Nano (Free)',
  'mimo-v2.5-free': 'Mimo v2.5 (Free)',
};

// Stable zen client identifiers for this process instance (match OpenCode session/project formats).
const _zenSessionId = makeZenCompactId('ses_');
const _zenProjectId = (makeZenCompactId('') + makeZenCompactId('')).slice(0, 40);

// ---------------------------------------------------------------------------
// Endpoint routing
// ---------------------------------------------------------------------------

type ZenStyle = 'responses' | 'messages' | 'chat';

function zenStyle(modelId: string): ZenStyle {
  const id = modelId.toLowerCase();
  if (/^gpt-5/.test(id)) return 'responses';
  if (id.startsWith('claude-')) return 'messages';
  return 'chat';
}

function zenUrl(base: string, style: ZenStyle): string {
  const root = base.replace(/\/+$/, '');
  if (style === 'responses') return `${root}/responses`;
  if (style === 'messages') return `${root}/messages`;
  return `${root}/chat/completions`;
}

// ---------------------------------------------------------------------------
// Header helpers
// ---------------------------------------------------------------------------

function buildHeaders(
  apiKey: string | null | undefined,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    'content-type': 'application/json',
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Message serializers
// ---------------------------------------------------------------------------

// OpenAI chat/completions format
function serializeChat(messages: ProviderCompleteRequest['messages']): unknown[] {
  return messages.map((m) => {
    if (m.role === 'tool') {
      return { role: 'tool', tool_call_id: m.toolCallId, content: m.content ?? '' };
    }
    if (m.role === 'assistant' && m.toolCalls?.length) {
      return {
        role: 'assistant',
        content: m.content ?? null,
        // Reasoning content is intentionally NOT echoed back — big-pickle/DeepSeek-class
        // models don't require it for tool-call continuity, and echoing it caused
        // multi-KB reasoning blocks to accumulate in every subsequent request.
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        })),
      };
    }
    return { role: m.role, content: m.content ?? '' };
  });
}

// OpenAI Responses API format (for gpt-5.x)
function serializeResponses(messages: ProviderCompleteRequest['messages']): {
  system: string;
  input: unknown[];
} {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content ?? '')
    .join('\n\n');

  const input = messages
    .filter((m) => m.role !== 'system')
    .map((m) => {
      if (m.role === 'tool') {
        return {
          type: 'function_call_output',
          call_id: m.toolCallId ?? '',
          output: m.content ?? '',
        };
      }
      if (m.role === 'assistant' && m.toolCalls?.length) {
        return {
          type: 'message',
          role: 'assistant',
          content: [
            ...(m.content ? [{ type: 'output_text', text: m.content }] : []),
            ...m.toolCalls.map((tc) => ({
              type: 'function_call',
              call_id: tc.id,
              name: tc.name,
              arguments: JSON.stringify(tc.arguments),
            })),
          ],
        };
      }
      const role = m.role === 'assistant' ? 'assistant' : 'user';
      const ctype = m.role === 'assistant' ? 'output_text' : 'input_text';
      return { role, content: [{ type: ctype, text: m.content ?? '' }] };
    });

  return { system, input };
}

// Anthropic Messages format (for claude-*)
function serializeAnthropic(messages: ProviderCompleteRequest['messages']): {
  system: string;
  messages: unknown[];
} {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content ?? '')
    .join('\n\n');

  const out = messages
    .filter((m) => m.role !== 'system')
    .map((m) => {
      if (m.role === 'assistant' && m.toolCalls?.length) {
        return {
          role: 'assistant',
          content: m.toolCalls.map((tc) => ({
            type: 'tool_use',
            id: tc.id,
            name: tc.name,
            input: tc.arguments,
          })),
        };
      }
      if (m.role === 'tool') {
        return {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content ?? '' }],
        };
      }
      return { role: m.role, content: [{ type: 'text', text: m.content ?? '' }] };
    });

  return { system, messages: out };
}

// ---------------------------------------------------------------------------
// Tool serializers
// ---------------------------------------------------------------------------

type ToolDef = NonNullable<ProviderCompleteRequest['tools']>[number];

// Some providers (DeepSeek, etc.) reject tool names containing dots or other
// chars outside ^[a-zA-Z0-9_-]+$. Replace any offending character with _.
function sanitizeToolName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}

// Build a sanitized copy of the tools array and a reverse map sanitized→original.
// Used so the model receives valid names and we can restore originals from the response.
function sanitizeTools(tools: ToolDef[] | null | undefined): {
  sanitized: ToolDef[] | null;
  toolNameMap: Map<string, string>;
} {
  const toolNameMap = new Map<string, string>();
  if (!tools || tools.length === 0) return { sanitized: tools ?? null, toolNameMap };
  const sanitized = tools.map((t) => {
    const s = sanitizeToolName(t.name);
    if (s !== t.name) toolNameMap.set(s, t.name);
    return { ...t, name: s };
  });
  return { sanitized, toolNameMap };
}

// Restore original tool names in a parsed response using the reverse map.
function restoreToolNames(
  result: ProviderCompleteResponse,
  toolNameMap: Map<string, string>,
): ProviderCompleteResponse {
  if (toolNameMap.size === 0 || result.toolCalls.length === 0) return result;
  return {
    ...result,
    toolCalls: result.toolCalls.map((tc) => ({
      ...tc,
      name: toolNameMap.get(tc.name) ?? tc.name,
    })),
  };
}

function toChatTool(t: ToolDef) {
  return {
    type: 'function',
    function: {
      name: sanitizeToolName(t.name),
      description: t.description ?? '',
      parameters: t.inputSchema,
    },
  };
}

function toResponsesTool(t: ToolDef) {
  return {
    type: 'function',
    name: sanitizeToolName(t.name),
    description: t.description ?? '',
    parameters: t.inputSchema,
  };
}

function toAnthropicTool(t: ToolDef) {
  return {
    name: sanitizeToolName(t.name),
    description: t.description ?? '',
    input_schema: t.inputSchema,
  };
}

// ---------------------------------------------------------------------------
// Response parsers
// ---------------------------------------------------------------------------

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function safeJson(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function tryParseJson(s: string | null): unknown {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function emptyResponse(profileId: string, model: string): ProviderCompleteResponse {
  return {
    providerProfileId: profileId,
    providerType: 'opencode-zen',
    model,
    outputText: null,
    outputJson: null,
    toolCalls: [],
    stopReason: null,
  };
}

function parseChatJson(json: unknown, profileId: string, model: string): ProviderCompleteResponse {
  if (!isObj(json)) return emptyResponse(profileId, model);
  const choices = Array.isArray(json.choices) ? json.choices : [];
  const choice = choices[0];
  const msg = isObj(choice) && isObj(choice.message) ? choice.message : {};
  const outputText = typeof msg.content === 'string' ? msg.content : null;
  const rawTcs = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
  const toolCalls: ProviderToolCall[] = rawTcs
    .filter(isObj)
    .filter((tc) => isObj(tc.function))
    .map((tc) => {
      const fn = tc.function as Record<string, unknown>;
      return {
        id: String(tc.id ?? ''),
        name: String(fn.name ?? ''),
        arguments: safeJson(String(fn.arguments ?? '{}')),
      };
    });
  const u = isObj(json.usage) ? json.usage : null;
  return {
    providerProfileId: profileId,
    providerType: 'opencode-zen',
    model,
    outputText,
    outputJson: tryParseJson(outputText),
    toolCalls,
    stopReason:
      isObj(choice) && typeof choice.finish_reason === 'string' ? choice.finish_reason : null,
    ...(u
      ? {
          usage: {
            inputTokens: typeof u.prompt_tokens === 'number' ? u.prompt_tokens : undefined,
            outputTokens: typeof u.completion_tokens === 'number' ? u.completion_tokens : undefined,
            totalTokens: typeof u.total_tokens === 'number' ? u.total_tokens : undefined,
          },
        }
      : {}),
  };
}

function parseResponsesJson(
  json: unknown,
  profileId: string,
  model: string,
): ProviderCompleteResponse {
  if (!isObj(json)) return emptyResponse(profileId, model);
  const output = Array.isArray(json.output) ? json.output : [];
  const texts: string[] = [];
  const toolCalls: ProviderToolCall[] = [];
  for (const item of output) {
    if (!isObj(item)) continue;
    if (item.type === 'message') {
      for (const block of Array.isArray(item.content) ? item.content : []) {
        if (isObj(block) && block.type === 'output_text' && typeof block.text === 'string') {
          texts.push(block.text);
        }
      }
    } else if (item.type === 'function_call') {
      const name = typeof item.name === 'string' ? item.name : '';
      if (name) {
        toolCalls.push({
          id: typeof item.call_id === 'string' ? item.call_id : name,
          name,
          arguments: safeJson(typeof item.arguments === 'string' ? item.arguments : '{}'),
        });
      }
    }
  }
  const outputText = texts.length ? texts.join('\n') : null;
  const u = isObj(json.usage) ? json.usage : null;
  return {
    providerProfileId: profileId,
    providerType: 'opencode-zen',
    model,
    outputText,
    outputJson: tryParseJson(outputText),
    toolCalls,
    stopReason: typeof json.status === 'string' ? json.status : 'stop',
    ...(u
      ? {
          usage: {
            inputTokens: typeof u.input_tokens === 'number' ? u.input_tokens : undefined,
            outputTokens: typeof u.output_tokens === 'number' ? u.output_tokens : undefined,
            totalTokens: typeof u.total_tokens === 'number' ? u.total_tokens : undefined,
          },
        }
      : {}),
  };
}

function parseAnthropicJson(
  json: unknown,
  profileId: string,
  model: string,
): ProviderCompleteResponse {
  if (!isObj(json)) return emptyResponse(profileId, model);
  const content = Array.isArray(json.content) ? json.content : [];
  const texts = content
    .filter(isObj)
    .filter((b) => b.type === 'text')
    .map((b) => String(b.text ?? ''));
  const toolCalls: ProviderToolCall[] = content
    .filter(isObj)
    .filter((b) => b.type === 'tool_use')
    .map((b) => ({
      id: String(b.id ?? ''),
      name: String(b.name ?? ''),
      arguments: isObj(b.input) ? b.input : {},
    }));
  const outputText = texts.length ? texts.join('\n') : null;
  const u = isObj(json.usage) ? json.usage : null;
  return {
    providerProfileId: profileId,
    providerType: 'opencode-zen',
    model,
    outputText,
    outputJson: tryParseJson(outputText),
    toolCalls,
    stopReason: typeof json.stop_reason === 'string' ? json.stop_reason : null,
    ...(u
      ? {
          usage: {
            inputTokens: typeof u.input_tokens === 'number' ? u.input_tokens : undefined,
            outputTokens: typeof u.output_tokens === 'number' ? u.output_tokens : undefined,
            totalTokens: typeof u.total_tokens === 'number' ? u.total_tokens : undefined,
          },
        }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// SSE stream consumer (shared, chat/completions format)
// ---------------------------------------------------------------------------

async function consumeSse(response: Response, onData: (payload: unknown) => void): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) return;
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split(/\r?\n\r?\n/);
    buf = parts.pop() ?? '';
    for (const part of parts) {
      for (const line of part.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
          onData(JSON.parse(data));
        } catch {}
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

async function readErrBody(r: Response): Promise<string> {
  try {
    return (await r.text()).slice(0, 600);
  } catch {
    return '';
  }
}

function extractErrMsg(body: string): string {
  try {
    const p = JSON.parse(body) as unknown;
    if (isObj(p)) {
      const err = isObj(p.error) ? p.error : null;
      const msg =
        (typeof err?.message === 'string' && err.message) ||
        (typeof p.message === 'string' && p.message);
      if (msg) return msg;
    }
  } catch {}
  return body;
}

// ---------------------------------------------------------------------------
// Main provider client
// ---------------------------------------------------------------------------

export class OpencodeZenProviderClient implements ProviderClient {
  readonly #profile: ProviderProfile;
  readonly #fetcher: FetchLike;

  constructor(profile: ProviderProfile, fetcher: FetchLike) {
    this.#profile = profile;
    this.#fetcher = buildZenClientFetcher(
      fetcher,
      _zenSessionId,
      _zenProjectId,
      async () => profile.apiKey || 'public',
    );
  }

  #base(): string {
    return (this.#profile.baseUrl || ZEN_BASE_URL).replace(/\/+$/, '');
  }
  #key(): string | null {
    return this.#profile.apiKey || null;
  }
  #model(req: ProviderCompleteRequest): string {
    const m = req.model?.trim() || this.#profile.model?.trim();
    if (!m) throw new Error(`Provider "${this.#profile.id}" has no model configured.`);
    return m;
  }

  async listModels(): Promise<ProviderModelPayload[]> {
    try {
      const res = await this.#fetcher(`${this.#base()}/models`, {
        headers: buildHeaders(this.#key()),
      });
      if (!res.ok) return [...ZEN_FREE_MODELS];
      const json = (await res.json()) as unknown;
      if (!isObj(json)) return [...ZEN_FREE_MODELS];
      const raw: unknown[] = Array.isArray(json.data)
        ? json.data
        : Array.isArray(json.models)
          ? json.models
          : [];
      const models: ProviderModelPayload[] = raw
        .filter(isObj)
        .map((e) => {
          const id = typeof e.id === 'string' ? e.id : '';
          const rawName = typeof e.name === 'string' ? e.name : id;
          return {
            id,
            name: ZEN_FREE_DISPLAY[id] ?? rawName,
            contextWindow:
              typeof e.context_window === 'number' ? e.context_window : (ZEN_KNOWN_CTX[id] ?? null),
          };
        })
        .filter((m) => m.id.length > 0);
      return models.length > 0 ? models : [...ZEN_FREE_MODELS];
    } catch {
      return [...ZEN_FREE_MODELS];
    }
  }

  async testConnection(): Promise<ProviderConnectionTestPayload> {
    try {
      const models = await this.listModels();
      const keyStatus = this.#key() ? 'API key present' : 'no key (free models only)';
      return { ok: true, message: `${models.length} model(s) — ${keyStatus}` };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  async complete(request: ProviderCompleteRequest): Promise<ProviderCompleteResponse> {
    const model = this.#model(request);
    const style = zenStyle(model);
    const url = zenUrl(this.#base(), style);
    const headers = buildHeaders(this.#key(), this.#profile.extraHeaders ?? {});

    // Build sanitized tools + reverse map to restore original names from model response.
    const { toolNameMap, sanitized: tools } = sanitizeTools(request.tools);

    let body: string;
    if (style === 'responses') {
      const { system, input } = serializeResponses(request.messages);
      body = JSON.stringify({
        model,
        input,
        ...(system ? { instructions: system } : {}),
        stream: false,
        ...(tools ? { tools: tools.map(toResponsesTool), tool_choice: 'auto' } : {}),
        ...(typeof request.maxTokens === 'number' ? { max_output_tokens: request.maxTokens } : {}),
      });
    } else if (style === 'messages') {
      const { system, messages } = serializeAnthropic(request.messages);
      body = JSON.stringify({
        model,
        ...(system ? { system } : {}),
        messages,
        max_tokens: request.maxTokens ?? 4096,
        ...(typeof request.temperature === 'number' ? { temperature: request.temperature } : {}),
        ...(tools ? { tools: tools.map(toAnthropicTool) } : {}),
      });
    } else {
      body = JSON.stringify({
        model,
        messages: serializeChat(request.messages),
        ...(typeof request.temperature === 'number' ? { temperature: request.temperature } : {}),
        ...(typeof request.maxTokens === 'number' ? { max_tokens: request.maxTokens } : {}),
        ...(tools ? { tools: tools.map(toChatTool), tool_choice: 'auto' } : {}),
      });
    }

    const res = await this.#fetcher(url, { method: 'POST', headers, body });
    if (!res.ok) {
      const errBody = await readErrBody(res);
      if (res.status === 429) throw new Error('OpenCode Zen rate limit reached.');
      throw new Error(`opencode-zen ${res.status}: ${extractErrMsg(errBody)}`);
    }

    const json = (await res.json()) as unknown;
    let result: ProviderCompleteResponse;
    if (style === 'responses') result = parseResponsesJson(json, this.#profile.id, model);
    else if (style === 'messages') result = parseAnthropicJson(json, this.#profile.id, model);
    else result = parseChatJson(json, this.#profile.id, model);
    return restoreToolNames(result, toolNameMap);
  }

  async completeStream(
    request: ProviderCompleteRequest,
    observer: ProviderStreamObserver,
  ): Promise<ProviderCompleteResponse> {
    const model = this.#model(request);
    const style = zenStyle(model);

    // Responses and Messages APIs don't support streaming here — fall back to complete()
    if (style !== 'chat') return this.complete(request);

    const { toolNameMap, sanitized: tools } = sanitizeTools(request.tools);

    const url = zenUrl(this.#base(), 'chat');
    const headers = buildHeaders(this.#key(), {
      ...this.#profile.extraHeaders,
      accept: 'text/event-stream',
    });
    const body = JSON.stringify({
      model,
      messages: serializeChat(request.messages),
      stream: true,
      stream_options: { include_usage: true },
      ...(typeof request.temperature === 'number' ? { temperature: request.temperature } : {}),
      ...(typeof request.maxTokens === 'number' ? { max_tokens: request.maxTokens } : {}),
      ...(tools ? { tools: tools.map(toChatTool), tool_choice: 'auto' } : {}),
    });

    const res = await this.#fetcher(url, {
      method: 'POST',
      headers,
      body,
      ...(observer.signal ? { signal: observer.signal } : {}),
    });

    if (!res.ok || !res.body) {
      const errBody = !res.body ? '' : await readErrBody(res);
      if (!res.body || res.status === 401 || res.status === 403 || res.status === 429) {
        throw new Error(`opencode-zen stream ${res.status}: ${extractErrMsg(errBody)}`);
      }
      return this.complete(request);
    }

    const textParts: string[] = [];
    const reasoningParts: string[] = [];
    const tcMap = new Map<number, { id: string; name: string; args: string }>();
    let stopReason: string | null = null;
    let streamUsage: Record<string, unknown> | null = null;

    await consumeSse(res, (payload) => {
      if (!isObj(payload)) return;
      // Capture usage from the final stream chunk (include_usage: true sends it with empty choices).
      if (isObj(payload.usage)) streamUsage = payload.usage;
      const choices = Array.isArray(payload.choices) ? payload.choices : [];
      const choice = choices[0];
      if (!isObj(choice)) return;
      const delta = isObj(choice.delta) ? choice.delta : {};

      // DeepSeek / zen thinking tokens arrive as reasoning_content before content
      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
        reasoningParts.push(delta.reasoning_content);
        observer.onReasoningDelta?.(delta.reasoning_content);
      }

      if (typeof delta.content === 'string' && delta.content) {
        textParts.push(delta.content);
        observer.onTextDelta?.(delta.content);
      }

      const rawTcs = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
      for (const tc of rawTcs) {
        if (!isObj(tc)) continue;
        const idx = typeof tc.index === 'number' ? tc.index : 0;
        const fn = isObj(tc.function) ? tc.function : {};
        const cur = tcMap.get(idx) ?? { id: '', name: '', args: '' };
        tcMap.set(idx, {
          id: typeof tc.id === 'string' ? tc.id : cur.id,
          name: typeof fn.name === 'string' ? fn.name : cur.name,
          args: cur.args + (typeof fn.arguments === 'string' ? fn.arguments : ''),
        });
      }

      if (typeof choice.finish_reason === 'string' && choice.finish_reason) {
        stopReason = choice.finish_reason;
      }
    });

    const outputText = textParts.join('') || null;
    const reasoningText = reasoningParts.join('') || null;
    const toolCalls: ProviderToolCall[] = [...tcMap.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, tc]) => ({
        id: tc.id,
        name: toolNameMap.get(tc.name) ?? tc.name,
        arguments: safeJson(tc.args),
      }))
      .filter((tc) => tc.name.length > 0);

    const u = streamUsage as {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
    } | null;
    const usageBlock =
      u != null
        ? {
            usage: {
              inputTokens: typeof u.prompt_tokens === 'number' ? u.prompt_tokens : undefined,
              outputTokens:
                typeof u.completion_tokens === 'number' ? u.completion_tokens : undefined,
              totalTokens: typeof u.total_tokens === 'number' ? u.total_tokens : undefined,
            },
          }
        : {};
    return {
      providerProfileId: this.#profile.id,
      providerType: 'opencode-zen',
      model,
      outputText,
      outputJson: tryParseJson(outputText),
      toolCalls,
      stopReason,
      ...(reasoningText ? { reasoningContent: reasoningText } : {}),
      ...usageBlock,
    };
  }
}
