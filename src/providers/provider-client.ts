import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { writeDebugEvent } from '../debug/runtime-debug.js';
import type {
  ProviderConnectionTestPayload,
  ProviderModelPayload,
  ProviderProfile,
} from './profile-types.js';
import type {
  ProviderCompleteRequest,
  ProviderCompleteResponse,
  ProviderStreamObserver,
  ProviderToolCall,
} from './runtime-types.js';
async function getSecondaryAccountToken(): Promise<string | null> {
  try {
    const { readdirSync } = await import('node:fs');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const dir = dirname(fileURLToPath(import.meta.url));
    const localFile = readdirSync(dir).find((f) => f.endsWith('.local.js'));
    if (!localFile) return null;
    const mod = await import(join(dir, localFile)) as { getSecondaryAccountToken?: () => string | null };
    return mod.getSecondaryAccountToken?.() ?? null;
  } catch {
    return null;
  }
}

async function loadOpencodeZenModule(): Promise<{
  OpencodeZenProviderClient: new (profile: ProviderProfile, fetcher: FetchLike) => ProviderClient;
} | null> {
  try {
    return (await import('./opencode-zen-provider.js')) as {
      OpencodeZenProviderClient: new (
        profile: ProviderProfile,
        fetcher: FetchLike,
      ) => ProviderClient;
    };
  } catch {
    return null;
  }
}

class OpencodeZenProviderClientProxy implements ProviderClient {
  readonly #profile: ProviderProfile;
  readonly #fetcher: FetchLike;

  constructor(profile: ProviderProfile, fetcher: FetchLike) {
    this.#profile = profile;
    this.#fetcher = fetcher;
  }

  async #resolve(): Promise<ProviderClient> {
    const mod = await loadOpencodeZenModule();
    if (!mod)
      throw new Error(
        'opencode-zen provider module not found. Place opencode-zen-provider.ts in src/providers/.',
      );
    return new mod.OpencodeZenProviderClient(this.#profile, this.#fetcher);
  }

  async listModels() {
    return (await this.#resolve()).listModels();
  }
  async testConnection() {
    return (await this.#resolve()).testConnection();
  }
  async complete(req: ProviderCompleteRequest) {
    return (await this.#resolve()).complete(req);
  }
  async completeStream(req: ProviderCompleteRequest, obs: ProviderStreamObserver) {
    const client = await this.#resolve();
    return client.completeStream ? client.completeStream(req, obs) : client.complete(req);
  }
}

export type FetchLike = typeof fetch;

export interface ProviderClient {
  listModels(): Promise<ProviderModelPayload[]>;
  testConnection(): Promise<ProviderConnectionTestPayload>;
  complete(request: ProviderCompleteRequest): Promise<ProviderCompleteResponse>;
  completeStream?(
    request: ProviderCompleteRequest,
    observer: ProviderStreamObserver,
  ): Promise<ProviderCompleteResponse>;
}

type NormalizedListedModel = ProviderModelPayload & {
  tags: string[];
  chatCapable: boolean | null;
  supportsTools: boolean;
  supportsVision: boolean;
  deprecated: boolean;
  archived: boolean;
  created: number | null;
};

const openAiChatCompletionResponseSchema = z.object({
  choices: z
    .array(
      z.object({
        finish_reason: z.string().nullable().optional(),
        message: z.object({
          // Mistral magistral returns an array of typed content chunks
          content: z.union([z.string(), z.array(z.unknown()), z.null()]).optional(),
          tool_calls: z
            .array(
              z.object({
                id: z.string(),
                type: z.string().optional(),
                function: z.object({
                  name: z.string(),
                  arguments: z.string(),
                }),
              }),
            )
            .nullish(),
        }),
      }),
    )
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number().int().nonnegative().optional(),
      completion_tokens: z.number().int().nonnegative().optional(),
      total_tokens: z.number().int().nonnegative().optional(),
      prompt_tokens_details: z
        .object({ cached_tokens: z.number().int().nonnegative().optional() })
        .optional(),
      completion_tokens_details: z
        .object({ reasoning_tokens: z.number().int().nonnegative().optional() })
        .optional(),
    })
    .optional(),
});

const anthropicMessageResponseSchema = z.object({
  stop_reason: z.string().nullable().optional(),
  content: z.array(
    z.discriminatedUnion('type', [
      z.object({
        type: z.literal('text'),
        text: z.string(),
      }),
      z.object({
        type: z.literal('tool_use'),
        id: z.string(),
        name: z.string(),
        input: z.record(z.string(), z.unknown()).default({}),
      }),
    ]),
  ),
  usage: z
    .object({
      input_tokens: z.number().int().nonnegative().optional(),
      output_tokens: z.number().int().nonnegative().optional(),
      cache_creation_input_tokens: z.number().int().nonnegative().optional(),
      cache_read_input_tokens: z.number().int().nonnegative().optional(),
    })
    .optional(),
});

const openAiResponsesResponseSchema = z.object({
  status: z.string().optional(),
  output: z
    .array(
      z.discriminatedUnion('type', [
        z.object({
          type: z.literal('message'),
          content: z.array(
            z.discriminatedUnion('type', [
              z.object({
                type: z.literal('output_text'),
                text: z.string(),
              }),
              z.object({
                type: z.literal('refusal'),
                refusal: z.string(),
              }),
            ]),
          ),
        }),
        z.object({
          type: z.literal('function_call'),
          call_id: z.string(),
          name: z.string(),
          arguments: z.string(),
        }),
      ]),
    )
    .default([]),
});

export function createProviderClient(
  profile: ProviderProfile,
  normalizedType: string,
  fetcher: FetchLike = fetch,
): ProviderClient {
  switch (normalizedType) {
    case 'openai':
      return new OpenAIProviderClient(profile, fetcher);
    case 'anthropic':
      return new AnthropicProviderClient(profile, fetcher);
    case 'secondary':
      return new SecondaryProviderClient(profile, fetcher);
    case 'ollama':
      return new OllamaProviderClient(profile, fetcher);
    case 'openai-codex':
      return new OpenAICodexProviderClient(profile, fetcher);
    case 'opencode-zen':
      return new OpencodeZenProviderClientProxy(profile, fetcher);
    default:
      return new OpenAICompatibleProviderClient(profile, fetcher, normalizedType);
  }
}

class OpenAICompatibleProviderClient implements ProviderClient {
  readonly #profile: ProviderProfile;
  readonly #fetcher: FetchLike;
  readonly #providerType: string;

  constructor(profile: ProviderProfile, fetcher: FetchLike, providerType: string) {
    this.#profile = profile;
    this.#fetcher = fetcher;
    this.#providerType = providerType;
  }

  async listModels(): Promise<ProviderModelPayload[]> {
    const startedAt = Date.now();
    writeDebugEvent({
      component: 'provider',
      level: 'info',
      message: 'listing models',
      data: {
        providerType: this.#providerType,
        profileId: this.#profile.id,
      },
    });
    const response = await this.#fetcher(`${trimTrailingSlash(this.#profile.baseUrl)}/models`, {
      headers: {
        ...createJsonHeaders(this.#profile),
        ...this.#profile.extraHeaders,
      },
    });

    if (!response.ok) {
      writeDebugEvent({
        component: 'provider',
        level: 'warn',
        message: 'provider request failed',
        data: {
          providerType: this.#providerType,
          profileId: this.#profile.id,
          operation: 'listModels',
          status: response.status,
          durationMs: Date.now() - startedAt,
        },
      });
      throw new Error(`Provider returned ${response.status} while listing models.`);
    }

    const payload = (await response.json()) as unknown;
    const data = isRecord(payload) && Array.isArray(payload.data) ? payload.data : [];

    const rawModels = data
      .filter(isRecord)
      .map((entry) => ({
        id: typeof entry.id === 'string' ? entry.id : '',
        name:
          typeof entry.name === 'string'
            ? entry.name
            : typeof entry.id === 'string'
              ? entry.id
              : '',
        contextWindow:
          typeof entry.context_window === 'number'
            ? entry.context_window
            : typeof entry.context_length === 'number'
              ? entry.context_length
              : typeof entry.max_context_length === 'number'
                ? entry.max_context_length
                : null,
        tags: buildListedModelTags(entry),
        chatCapable: readCapabilityFlag(entry, 'completion_chat'),
        supportsTools: readCapabilityFlag(entry, 'function_calling') === true,
        supportsVision: readCapabilityFlag(entry, 'vision') === true,
        deprecated: entry.deprecation !== null && entry.deprecation !== undefined,
        archived: entry.archived === true,
        created: typeof entry.created === 'number' ? entry.created : null,
      }))
      .filter((entry) => entry.id.length > 0);
    const models =
      this.#providerType === 'mistral'
        ? normalizeMistralListedModels(rawModels)
        : dedupeListedModels(rawModels);
    writeDebugEvent({
      component: 'provider',
      level: 'info',
      message: 'models listed',
      data: {
        providerType: this.#providerType,
        profileId: this.#profile.id,
        rawCount: rawModels.length,
        count: models.length,
        durationMs: Date.now() - startedAt,
      },
    });
    return models;
  }

  async testConnection(): Promise<ProviderConnectionTestPayload> {
    try {
      const models = await this.listModels();
      return {
        ok: true,
        message: `${models.length} model(s) available`,
      };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async complete(request: ProviderCompleteRequest): Promise<ProviderCompleteResponse> {
    const model = resolveModel(this.#profile, request);
    const startedAt = Date.now();
    const isMistralProvider = this.#providerType === 'mistral';
    const thinkInput = (request as ProviderCompleteRequest & { thinkBudget?: ThinkInput })
      .thinkBudget;
    // Magistral always reasons (built-in, no parameter needed)
    const mistralThinking = isMistralProvider && isMistralThinkingModel(model);
    const serializedMessages = serializeOpenAiMessages(request.messages, mistralThinking);
    const messagesWithReasoning = serializedMessages.filter(
      (m) => isRecord(m) && typeof (m as Record<string, unknown>).reasoning_content === 'string',
    ).length;
    writeDebugEvent({
      component: 'provider',
      level: 'info',
      message: 'completion requested',
      data: {
        providerType: this.#providerType,
        profileId: this.#profile.id,
        model,
        messageCount: request.messages.length,
        toolNames: request.tools?.map((t) => t.name) ?? [],
        toolChoice: request.toolChoice ?? null,
        messagesWithReasoningContent: messagesWithReasoning,
        roles: serializedMessages.map((m) => (isRecord(m) ? (m.role as string) : '?')),
      },
    });
    const serializedTools = request.tools?.map(toOpenAiTool);
    const reasoningParams = isMistralProvider
      ? buildMistralReasoningParams(model, thinkInput)
      : buildOpenAIReasoningParams(model, thinkInput);
    writeDebugEvent({
      component: 'provider',
      level: 'info',
      message: 'secondary think decision',
      data: {
        model,
        providerType: this.#providerType,
        thinkInput: thinkInput ?? 'off',
        isMistralThinking: mistralThinking,
        supportsReasoningEffort: !isMistralProvider ? supportsReasoningEffort(model) : null,
        reasoningEffortSent: (reasoningParams as Record<string, unknown>).reasoning_effort ?? null,
        temperatureOverride: (reasoningParams as Record<string, unknown>).temperature ?? null,
        paramsSent: Object.keys(reasoningParams).length > 0,
      },
    });
    const requestBody = {
      model,
      messages: serializedMessages,
      temperature: request.temperature,
      max_tokens: request.maxTokens,
      tools: serializedTools,
      ...(request.tools && request.toolChoice && request.toolChoice !== 'none'
        ? { tool_choice: request.toolChoice === 'required' ? 'required' : 'auto' }
        : {}),
      ...(request.responseFormat?.type === 'json_object'
        ? { response_format: { type: 'json_object' } }
        : request.responseFormat?.type === 'json_schema'
          ? {
              response_format: {
                type: 'json_schema',
                json_schema: {
                  name: request.responseFormat.name,
                  schema: request.responseFormat.schema,
                  strict: request.responseFormat.strict ?? true,
                },
              },
            }
          : {}),
      ...reasoningParams,
    };
    const response = await this.#fetcher(
      `${trimTrailingSlash(this.#profile.baseUrl)}/chat/completions`,
      {
        method: 'POST',
        headers: {
          ...createJsonHeaders(this.#profile),
          ...this.#profile.extraHeaders,
        },
        body: JSON.stringify(requestBody),
      },
    );

    if (!response.ok) {
      const body = await readErrorBody(response);
      writeDebugEvent({
        component: 'provider',
        level: 'warn',
        message: 'provider request failed',
        data: {
          providerType: this.#providerType,
          profileId: this.#profile.id,
          operation: 'complete',
          model,
          status: response.status,
          durationMs: Date.now() - startedAt,
          responseBody: body,
          sentToolNames:
            serializedTools?.map((t) =>
              isRecord(t) && isRecord(t.function) ? String(t.function.name) : '?',
            ) ?? [],
          hint:
            response.status === 400
              ? 'HTTP 400: check responseBody — common causes: invalid tool name, missing reasoning_content, unsupported response_format.'
              : undefined,
        },
      });
      throw new Error(extractProviderErrorMessage(this.#providerType, response.status, body));
    }

    const payload = openAiChatCompletionResponseSchema.parse((await response.json()) as unknown);
    const choice = payload.choices[0];
    const toolCalls = (choice?.message.tool_calls ?? []).map(parseOpenAiToolCall);
    const rawContent = choice?.message.content ?? null;
    // Mistral magistral returns content as array of typed chunks (thinking + text)
    const mistralChunks =
      isMistralProvider && Array.isArray(rawContent)
        ? extractMistralContentChunks(rawContent)
        : null;
    const outputText = mistralChunks
      ? mistralChunks.text
      : typeof rawContent === 'string'
        ? rawContent
        : null;
    const completionReasoning = mistralChunks?.reasoning ?? null;
    const ou = payload.usage;
    const result = {
      providerProfileId: this.#profile.id,
      providerType: this.#providerType,
      model,
      outputText,
      outputJson: parseJsonOrNull(outputText),
      toolCalls,
      stopReason: choice?.finish_reason ?? null,
      ...(completionReasoning ? { reasoningContent: completionReasoning } : {}),
      usage: ou
        ? (() => {
            const rawOut = ou.completion_tokens ?? 0;
            const rawTotal = ou.total_tokens ?? 0;
            const rawIn = ou.prompt_tokens ?? 0;
            const inputTokens = rawIn > 0 ? rawIn : rawTotal > rawOut ? rawTotal - rawOut : 0;
            return {
              inputTokens,
              outputTokens: rawOut,
              totalTokens: rawTotal > 0 ? rawTotal : inputTokens + rawOut,
              ...(ou.completion_tokens_details?.reasoning_tokens !== undefined
                ? { reasoningTokens: ou.completion_tokens_details.reasoning_tokens }
                : {}),
              ...(ou.prompt_tokens_details?.cached_tokens !== undefined
                ? { cacheReadTokens: ou.prompt_tokens_details.cached_tokens }
                : {}),
            };
          })()
        : undefined,
    };
    writeDebugEvent({
      component: 'provider',
      level: 'info',
      message: 'completion finished',
      data: {
        providerType: this.#providerType,
        profileId: this.#profile.id,
        model,
        toolCalls: toolCalls.length,
        stopReason: result.stopReason,
        durationMs: Date.now() - startedAt,
        outputPreview: summarizeOutputText(result.outputText),
      },
    });
    return result;
  }

  async completeStream(
    request: ProviderCompleteRequest,
    observer: ProviderStreamObserver,
  ): Promise<ProviderCompleteResponse> {
    const model = resolveModel(this.#profile, request);
    const startedAt = Date.now();
    const isMistralProvider = this.#providerType === 'mistral';
    const streamThinkInput = (request as ProviderCompleteRequest & { thinkBudget?: ThinkInput })
      .thinkBudget;
    // Magistral always reasons (built-in, no parameter needed)
    const streamMistralThinking = isMistralProvider && isMistralThinkingModel(model);
    const streamSerializedMessages = serializeOpenAiMessages(
      request.messages,
      streamMistralThinking,
    );
    const streamMessagesWithReasoning = streamSerializedMessages.filter(
      (m) => isRecord(m) && typeof (m as Record<string, unknown>).reasoning_content === 'string',
    ).length;
    const streamSerializedTools = request.tools?.map(toOpenAiTool);
    const streamReasoningParams = isMistralProvider
      ? buildMistralReasoningParams(model, streamThinkInput)
      : buildOpenAIReasoningParams(model, streamThinkInput);
    writeDebugEvent({
      component: 'provider',
      level: 'info',
      message: 'completion stream requested',
      data: {
        providerType: this.#providerType,
        profileId: this.#profile.id,
        model,
        messageCount: request.messages.length,
        toolNames: request.tools?.map((t) => t.name) ?? [],
        toolChoice: request.toolChoice ?? null,
        messagesWithReasoningContent: streamMessagesWithReasoning,
        roles: streamSerializedMessages.map((m) => (isRecord(m) ? (m.role as string) : '?')),
        thinkInput: streamThinkInput ?? null,
        isMistralThinking: streamMistralThinking,
        supportsReasoningEffort: !isMistralProvider ? supportsReasoningEffort(model) : null,
        reasoningEffortSent:
          (streamReasoningParams as Record<string, unknown>).reasoning_effort ?? null,
        temperatureOverride: (streamReasoningParams as Record<string, unknown>).temperature ?? null,
      },
    });

    const streamRequestBody = {
      model,
      messages: streamSerializedMessages,
      temperature: request.temperature,
      max_tokens: request.maxTokens,
      stream: true,
      stream_options: { include_usage: true },
      tools: streamSerializedTools,
      ...(request.tools && request.toolChoice && request.toolChoice !== 'none'
        ? { tool_choice: request.toolChoice === 'required' ? 'required' : 'auto' }
        : {}),
      ...(request.responseFormat?.type === 'json_object'
        ? { response_format: { type: 'json_object' } }
        : request.responseFormat?.type === 'json_schema'
          ? {
              response_format: {
                type: 'json_schema',
                json_schema: {
                  name: request.responseFormat.name,
                  schema: request.responseFormat.schema,
                  strict: request.responseFormat.strict ?? true,
                },
              },
            }
          : {}),
      ...streamReasoningParams,
    };

    const response = await this.#fetcher(
      `${trimTrailingSlash(this.#profile.baseUrl)}/chat/completions`,
      {
        method: 'POST',
        headers: {
          ...createJsonHeaders(this.#profile),
          ...this.#profile.extraHeaders,
        },
        body: JSON.stringify(streamRequestBody),
        ...(observer.signal ? { signal: observer.signal } : {}),
      },
    );

    if (!response.ok || !response.body) {
      const body = !response.body ? '' : await readErrorBody(response);
      const isHardFail = !response.body || isRateLimitOrAuth(response.status);
      writeDebugEvent({
        component: 'provider',
        level: 'warn',
        message: isHardFail
          ? 'stream failed — not retrying'
          : 'stream failed — falling back to complete',
        data: {
          providerType: this.#providerType,
          profileId: this.#profile.id,
          model,
          status: response.status,
          responseBody: body || '(no body — stream missing)',
          sentToolNames:
            streamSerializedTools?.map((t) =>
              isRecord(t) && isRecord(t.function) ? String(t.function.name) : '?',
            ) ?? [],
          messagesWithReasoningContent: streamMessagesWithReasoning,
          hint:
            response.status === 400
              ? 'HTTP 400: check responseBody — common causes: invalid tool name, missing reasoning_content, unsupported response_format.'
              : undefined,
        },
      });
      if (isHardFail) {
        throw new Error(extractProviderErrorMessage(this.#providerType, response.status, body));
      }
      return this.complete(request);
    }

    const outputTextParts: string[] = [];
    const reasoningParts: string[] = [];
    const toolCalls = new Map<number, { id: string; name: string; argumentsText: string }>();
    let stopReason: string | null = null;
    // State for tracking Anthropic-format tool calls across multiple SSE events
    let anthropicToolCallIndex: number | null = null;
    // Captured usage from final SSE chunks
    let streamUsage:
      | {
          inputTokens: number;
          outputTokens: number;
          totalTokens: number;
          reasoningTokens?: number;
          cacheReadTokens?: number;
          cacheWriteTokens?: number;
        }
      | undefined;
    // Anthropic streaming usage accumulators (message_start / message_delta)
    let anthropicInputTokens = 0;
    let anthropicOutputTokens = 0;
    let anthropicCacheRead = 0;
    let anthropicCacheWrite = 0;

    await consumeSseStream(response, (payload) => {
      // Handle Anthropic-format SSE (some zen models return Anthropic format
      // instead of OpenAI format, e.g. qwen3.6-plus-free routes to Claude backend)
      if (isAnthropicStreamFormat(payload)) {
        if (!isRecord(payload)) return;

        // message_start: contains input usage
        if (payload.type === 'message_start' && isRecord(payload.message)) {
          const msg = payload.message;
          if (isRecord(msg.usage)) {
            const u = msg.usage;
            if (typeof u.input_tokens === 'number') anthropicInputTokens = u.input_tokens;
            if (typeof u.cache_read_input_tokens === 'number')
              anthropicCacheRead = u.cache_read_input_tokens;
            if (typeof u.cache_creation_input_tokens === 'number')
              anthropicCacheWrite = u.cache_creation_input_tokens;
          }
        }

        // content_block_start: may start a text block or a tool_use block
        if (payload.type === 'content_block_start' && isRecord(payload.content_block)) {
          const block = payload.content_block;
          const idx = typeof payload.index === 'number' ? payload.index : 0;
          if (block.type === 'tool_use') {
            anthropicToolCallIndex = idx;
            toolCalls.set(idx, {
              id: typeof block.id === 'string' ? block.id : `tool_${idx}`,
              name: typeof block.name === 'string' ? block.name : '',
              argumentsText: '',
            });
          }
          return;
        }

        // content_block_delta: text, thinking, or tool input
        if (payload.type === 'content_block_delta' && isRecord(payload.delta)) {
          const delta = payload.delta;
          const idx = typeof payload.index === 'number' ? payload.index : 0;

          if (delta.type === 'text_delta' && typeof delta.text === 'string') {
            outputTextParts.push(delta.text);
            observer.onTextDelta?.(delta.text);
          } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
            reasoningParts.push(delta.thinking);
            observer.onReasoningDelta?.(delta.thinking);
          } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
            // Accumulate tool call JSON input
            const tc = toolCalls.get(idx);
            if (tc) tc.argumentsText += delta.partial_json;
          }
          return;
        }

        // message_delta: contains stop_reason and output usage
        if (payload.type === 'message_delta' && isRecord(payload.delta)) {
          const dr = payload.delta.stop_reason;
          if (typeof dr === 'string') stopReason = dr;
          if (isRecord(payload.usage) && typeof payload.usage.output_tokens === 'number') {
            anthropicOutputTokens = payload.usage.output_tokens;
          }
        }

        return;
      }

      const choice = firstChoice(payload);

      // Capture top-level usage from OpenAI-compatible chunks (include_usage: true)
      if (isRecord(payload) && isRecord(payload.usage)) {
        const u = payload.usage;
        const rawOut = typeof u.completion_tokens === 'number' ? u.completion_tokens : 0;
        const rawTotal = typeof u.total_tokens === 'number' ? u.total_tokens : 0;
        const rawIn = typeof u.prompt_tokens === 'number' ? u.prompt_tokens : 0;
        // Infer input tokens from total when prompt_tokens is absent
        const inputTokens = rawIn > 0 ? rawIn : rawTotal > rawOut ? rawTotal - rawOut : 0;
        streamUsage = {
          inputTokens,
          outputTokens: rawOut,
          totalTokens: rawTotal > 0 ? rawTotal : inputTokens + rawOut,
          ...(isRecord(u.completion_tokens_details) &&
          typeof u.completion_tokens_details.reasoning_tokens === 'number'
            ? { reasoningTokens: u.completion_tokens_details.reasoning_tokens }
            : {}),
          ...(isRecord(u.prompt_tokens_details) &&
          typeof u.prompt_tokens_details.cached_tokens === 'number'
            ? { cacheReadTokens: u.prompt_tokens_details.cached_tokens }
            : {}),
        };
      }

      if (!choice) {
        return;
      }

      const delta = isRecord(choice.delta) ? choice.delta : {};
      const textDelta = extractOpenAiTextDelta(delta);
      const reasoningDelta =
        extractOpenAiReasoningDelta(delta) ||
        (isMistralProvider ? extractMistralThinkingDelta(delta) : '');
      const partialToolCalls = extractOpenAiToolCallDeltas(delta);

      if (textDelta) {
        outputTextParts.push(textDelta);
        observer.onTextDelta?.(textDelta);
      }

      if (reasoningDelta) {
        reasoningParts.push(reasoningDelta);
        observer.onReasoningDelta?.(reasoningDelta);
      }

      for (const partial of partialToolCalls) {
        const current = toolCalls.get(partial.index) ?? { id: '', name: '', argumentsText: '' };
        toolCalls.set(partial.index, {
          id: partial.id || current.id,
          name: partial.name || current.name,
          argumentsText: current.argumentsText + partial.argumentsText,
        });
      }

      if (typeof choice.finish_reason === 'string' && choice.finish_reason.length > 0) {
        stopReason = choice.finish_reason;
      }
    });

    // Merge Anthropic streaming usage if it was captured.
    // Prefer Anthropic values when present, but fall back to OpenAI-format values so that a
    // missing message_start (no input_tokens) doesn't zero out prompt_tokens already captured
    // from the final OpenAI-compatible usage chunk.
    if (anthropicInputTokens > 0 || anthropicOutputTokens > 0) {
      const mergedInput =
        anthropicInputTokens > 0 ? anthropicInputTokens : (streamUsage?.inputTokens ?? 0);
      const mergedOutput =
        anthropicOutputTokens > 0 ? anthropicOutputTokens : (streamUsage?.outputTokens ?? 0);
      streamUsage = {
        inputTokens: mergedInput,
        outputTokens: mergedOutput,
        totalTokens: mergedInput + mergedOutput,
        ...(anthropicCacheRead > 0 ? { cacheReadTokens: anthropicCacheRead } : {}),
        ...(anthropicCacheWrite > 0 ? { cacheWriteTokens: anthropicCacheWrite } : {}),
      };
    }

    const outputText = outputTextParts.length > 0 ? outputTextParts.join('') : null;
    const reasoningText = reasoningParts.length > 0 ? reasoningParts.join('') : null;
    const result = {
      providerProfileId: this.#profile.id,
      providerType: this.#providerType,
      model,
      outputText,
      outputJson: parseJsonOrNull(outputText),
      toolCalls: [...toolCalls.entries()]
        .sort((left, right) => left[0] - right[0])
        .map(([, toolCall], index) => ({
          id: toolCall.id || `tool-call-${index + 1}`,
          name: toolCall.name,
          arguments: parseJsonObject(toolCall.argumentsText),
        }))
        .filter((toolCall) => toolCall.name.length > 0),
      stopReason,
      reasoningContent: reasoningText,
      usage: streamUsage,
    };

    writeDebugEvent({
      component: 'provider',
      level: 'info',
      message: 'completion stream finished',
      data: {
        providerType: this.#providerType,
        profileId: this.#profile.id,
        model,
        toolCalls: result.toolCalls.length,
        stopReason: result.stopReason,
        durationMs: Date.now() - startedAt,
        outputPreview: summarizeOutputText(result.outputText),
        reasoningChars: reasoningText?.length ?? 0,
        hasReasoningContent: reasoningText !== null,
      },
    });

    return result;
  }
}

class OpenAIProviderClient implements ProviderClient {
  readonly #profile: ProviderProfile;
  readonly #fetcher: FetchLike;

  constructor(profile: ProviderProfile, fetcher: FetchLike) {
    this.#profile = profile;
    this.#fetcher = fetcher;
  }

  async listModels(): Promise<ProviderModelPayload[]> {
    return new OpenAICompatibleProviderClient(this.#profile, this.#fetcher, 'openai').listModels();
  }

  async testConnection(): Promise<ProviderConnectionTestPayload> {
    return new OpenAICompatibleProviderClient(
      this.#profile,
      this.#fetcher,
      'openai',
    ).testConnection();
  }

  async complete(request: ProviderCompleteRequest): Promise<ProviderCompleteResponse> {
    const model = resolveModel(this.#profile, request);
    const startedAt = Date.now();
    writeDebugEvent({
      component: 'provider',
      level: 'info',
      message: 'completion requested',
      data: {
        providerType: 'openai',
        profileId: this.#profile.id,
        model,
        messageCount: request.messages.length,
      },
    });
    const response = await this.#fetcher(`${trimTrailingSlash(this.#profile.baseUrl)}/responses`, {
      method: 'POST',
      headers: {
        ...createJsonHeaders(this.#profile),
        ...this.#profile.extraHeaders,
      },
      body: JSON.stringify({
        model,
        input: serializeOpenAiResponsesInput(request.messages),
        tools: request.tools?.map(toResponsesTool),
        ...(request.tools && request.toolChoice && request.toolChoice !== 'none'
          ? { tool_choice: request.toolChoice }
          : {}),
        ...(request.responseFormat?.type === 'json_schema'
          ? {
              text: {
                format: {
                  type: 'json_schema',
                  name: request.responseFormat.name,
                  schema: request.responseFormat.schema,
                  strict: request.responseFormat.strict ?? true,
                },
              },
            }
          : {}),
        ...(typeof request.maxTokens === 'number' ? { max_output_tokens: request.maxTokens } : {}),
        ...(typeof request.temperature === 'number' ? { temperature: request.temperature } : {}),
      }),
    });

    if (!response.ok) {
      writeDebugEvent({
        component: 'provider',
        level: 'warn',
        message: 'provider request failed',
        data: {
          providerType: 'openai',
          profileId: this.#profile.id,
          operation: 'complete',
          model,
          status: response.status,
          durationMs: Date.now() - startedAt,
        },
      });
      throw new Error(`openai returned ${response.status} for completion.`);
    }

    const payload = openAiResponsesResponseSchema.parse((await response.json()) as unknown);
    const messageTexts: string[] = [];
    const toolCalls: ProviderToolCall[] = [];

    for (const item of payload.output) {
      if (item.type === 'message') {
        for (const content of item.content) {
          if (content.type === 'output_text') {
            messageTexts.push(content.text);
          }
        }
        continue;
      }

      toolCalls.push({
        id: item.call_id,
        name: item.name,
        arguments: parseJsonObject(item.arguments),
      });
    }

    const outputText = messageTexts.length > 0 ? messageTexts.join('\n') : null;
    const result = {
      providerProfileId: this.#profile.id,
      providerType: 'openai',
      model,
      outputText,
      outputJson: parseJsonOrNull(outputText),
      toolCalls,
      stopReason: payload.status ?? null,
    };
    writeDebugEvent({
      component: 'provider',
      level: 'info',
      message: 'completion finished',
      data: {
        providerType: 'openai',
        profileId: this.#profile.id,
        model,
        toolCalls: toolCalls.length,
        stopReason: result.stopReason,
        durationMs: Date.now() - startedAt,
        outputPreview: summarizeOutputText(result.outputText),
      },
    });
    return result;
  }

  async completeStream(
    request: ProviderCompleteRequest,
    observer: ProviderStreamObserver,
  ): Promise<ProviderCompleteResponse> {
    return new OpenAICompatibleProviderClient(
      this.#profile,
      this.#fetcher,
      'openai',
    ).completeStream(request, observer);
  }
}

class AnthropicProviderClient implements ProviderClient {
  readonly #profile: ProviderProfile;
  readonly #fetcher: FetchLike;

  constructor(profile: ProviderProfile, fetcher: FetchLike) {
    this.#profile = profile;
    this.#fetcher = fetcher;
  }

  async listModels(): Promise<ProviderModelPayload[]> {
    const startedAt = Date.now();
    writeDebugEvent({
      component: 'provider',
      level: 'info',
      message: 'listing models',
      data: {
        providerType: 'anthropic',
        profileId: this.#profile.id,
      },
    });
    const response = await this.#fetcher(`${trimTrailingSlash(this.#profile.baseUrl)}/models`, {
      headers: {
        'anthropic-version': '2023-06-01',
        ...createAnthropicHeaders(this.#profile),
        ...this.#profile.extraHeaders,
      },
    });

    if (!response.ok) {
      writeDebugEvent({
        component: 'provider',
        level: 'warn',
        message: 'provider request failed',
        data: {
          providerType: 'anthropic',
          profileId: this.#profile.id,
          operation: 'listModels',
          status: response.status,
          durationMs: Date.now() - startedAt,
        },
      });
      throw new Error(`Anthropic returned ${response.status} while listing models.`);
    }

    const payload = (await response.json()) as unknown;
    const data = isRecord(payload) && Array.isArray(payload.data) ? payload.data : [];

    const models = data
      .filter(isRecord)
      .map((entry) => ({
        id: typeof entry.id === 'string' ? entry.id : '',
        name:
          typeof entry.display_name === 'string'
            ? entry.display_name
            : typeof entry.id === 'string'
              ? entry.id
              : '',
        contextWindow: null,
      }))
      .filter((entry) => entry.id.length > 0);
    writeDebugEvent({
      component: 'provider',
      level: 'info',
      message: 'models listed',
      data: {
        providerType: 'anthropic',
        profileId: this.#profile.id,
        count: models.length,
        durationMs: Date.now() - startedAt,
      },
    });
    return models;
  }

  async testConnection(): Promise<ProviderConnectionTestPayload> {
    try {
      const models = await this.listModels();
      return {
        ok: true,
        message: `${models.length} model(s) available`,
      };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async complete(request: ProviderCompleteRequest): Promise<ProviderCompleteResponse> {
    const model = resolveModel(this.#profile, request);
    const startedAt = Date.now();
    writeDebugEvent({
      component: 'provider',
      level: 'info',
      message: 'completion requested',
      data: {
        providerType: 'anthropic',
        profileId: this.#profile.id,
        model,
        messageCount: request.messages.length,
      },
    });
    const { system, messages } = serializeAnthropicMessages(
      request.messages,
      request.responseFormat,
    );
    const thinkInput = (request as ProviderCompleteRequest & { thinkBudget?: ThinkInput })
      .thinkBudget;
    const thinkingBlock = buildAnthropicThinking(thinkInput);
    writeDebugEvent({
      component: 'provider',
      level: 'info',
      message: 'anthropic think decision',
      data: {
        model,
        thinkInput: thinkInput ?? 'off',
        thinkingEnabled: thinkingBlock !== null,
        budgetTokens: thinkingBlock?.budget_tokens ?? null,
      },
    });
    const effectiveMaxTokens = thinkingBlock
      ? Math.max(request.maxTokens ?? 4096, thinkingBlock.budget_tokens + 1024)
      : (request.maxTokens ?? 2048);
    const response = await this.#fetcher(`${trimTrailingSlash(this.#profile.baseUrl)}/messages`, {
      method: 'POST',
      headers: {
        'anthropic-version': '2023-06-01',
        ...createAnthropicHeaders(this.#profile),
        ...this.#profile.extraHeaders,
      },
      body: JSON.stringify({
        model,
        system,
        messages,
        max_tokens: effectiveMaxTokens,
        ...(thinkingBlock
          ? { thinking: thinkingBlock }
          : typeof request.temperature === 'number'
            ? { temperature: request.temperature }
            : {}),
        ...(request.tools ? { tools: request.tools.map(toAnthropicTool) } : {}),
        ...(request.tools && request.toolChoice && request.toolChoice !== 'none'
          ? { tool_choice: request.toolChoice === 'required' ? { type: 'any' } : { type: 'auto' } }
          : {}),
      }),
    });

    if (!response.ok) {
      writeDebugEvent({
        component: 'provider',
        level: 'warn',
        message: 'provider request failed',
        data: {
          providerType: 'anthropic',
          profileId: this.#profile.id,
          operation: 'complete',
          model,
          status: response.status,
          durationMs: Date.now() - startedAt,
        },
      });
      throw new Error(`anthropic returned ${response.status} for completion.`);
    }

    const payload = anthropicMessageResponseSchema.parse((await response.json()) as unknown);
    const textBlocks = payload.content
      .filter((item) => item.type === 'text')
      .map((item) => item.text);
    const toolCalls = payload.content
      .filter((item) => item.type === 'tool_use')
      .map((item) => ({
        id: item.id,
        name: item.name,
        arguments: item.input,
      }));
    const outputText = textBlocks.length > 0 ? textBlocks.join('\n') : null;

    const au = payload.usage;
    const result = {
      providerProfileId: this.#profile.id,
      providerType: 'anthropic',
      model,
      outputText,
      outputJson: parseJsonOrNull(outputText),
      toolCalls,
      stopReason: payload.stop_reason ?? null,
      usage: au
        ? {
            inputTokens: au.input_tokens ?? 0,
            outputTokens: au.output_tokens ?? 0,
            totalTokens: (au.input_tokens ?? 0) + (au.output_tokens ?? 0),
            ...(au.cache_read_input_tokens !== undefined
              ? { cacheReadTokens: au.cache_read_input_tokens }
              : {}),
            ...(au.cache_creation_input_tokens !== undefined
              ? { cacheWriteTokens: au.cache_creation_input_tokens }
              : {}),
          }
        : undefined,
    };
    writeDebugEvent({
      component: 'provider',
      level: 'info',
      message: 'completion finished',
      data: {
        providerType: 'anthropic',
        profileId: this.#profile.id,
        model,
        toolCalls: toolCalls.length,
        stopReason: result.stopReason,
        durationMs: Date.now() - startedAt,
        outputPreview: summarizeOutputText(result.outputText),
      },
    });
    return result;
  }

  async completeStream(
    request: ProviderCompleteRequest,
    _observer: ProviderStreamObserver,
  ): Promise<ProviderCompleteResponse> {
    const model = resolveModel(this.#profile, request);
    const thinkInput = (request as ProviderCompleteRequest & { thinkBudget?: ThinkInput })
      .thinkBudget;
    const thinkingBlock = buildAnthropicThinking(thinkInput);
    writeDebugEvent({
      component: 'provider',
      level: 'info',
      message: 'anthropic think decision (stream)',
      data: {
        model,
        thinkInput: thinkInput ?? null,
        thinkingEnabled: thinkingBlock !== null,
        budgetTokens: thinkingBlock?.budget_tokens ?? null,
      },
    });
    return this.complete(request);
  }
}

class OllamaProviderClient implements ProviderClient {
  readonly #profile: ProviderProfile;
  readonly #fetcher: FetchLike;

  constructor(profile: ProviderProfile, fetcher: FetchLike) {
    this.#profile = profile;
    this.#fetcher = fetcher;
  }

  async listModels(): Promise<ProviderModelPayload[]> {
    const startedAt = Date.now();
    writeDebugEvent({
      component: 'provider',
      level: 'info',
      message: 'listing models',
      data: {
        providerType: 'ollama',
        profileId: this.#profile.id,
      },
    });
    const response = await this.#fetcher(buildOllamaTagsUrl(this.#profile.baseUrl), {
      headers: {
        ...createJsonHeaders(this.#profile),
        ...this.#profile.extraHeaders,
      },
    });

    if (!response.ok) {
      writeDebugEvent({
        component: 'provider',
        level: 'warn',
        message: 'provider request failed',
        data: {
          providerType: 'ollama',
          profileId: this.#profile.id,
          operation: 'listModels',
          status: response.status,
          durationMs: Date.now() - startedAt,
        },
      });
      throw new Error(`Ollama returned ${response.status} while listing models.`);
    }

    const payload = (await response.json()) as unknown;
    const models = isRecord(payload) && Array.isArray(payload.models) ? payload.models : [];

    const listed = models
      .filter(isRecord)
      .map((entry) => ({
        id:
          typeof entry.name === 'string'
            ? entry.name
            : typeof entry.model === 'string'
              ? entry.model
              : '',
        name:
          typeof entry.name === 'string'
            ? entry.name
            : typeof entry.model === 'string'
              ? entry.model
              : '',
        contextWindow: typeof entry.context_length === 'number' ? entry.context_length : null,
      }))
      .filter((entry) => entry.id.length > 0);
    writeDebugEvent({
      component: 'provider',
      level: 'info',
      message: 'models listed',
      data: {
        providerType: 'ollama',
        profileId: this.#profile.id,
        count: listed.length,
        durationMs: Date.now() - startedAt,
      },
    });
    return listed;
  }

  async testConnection(): Promise<ProviderConnectionTestPayload> {
    try {
      const models = await this.listModels();
      return {
        ok: true,
        message: `${models.length} model(s) available`,
      };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async complete(request: ProviderCompleteRequest): Promise<ProviderCompleteResponse> {
    return new OpenAICompatibleProviderClient(this.#profile, this.#fetcher, 'ollama').complete(
      request,
    );
  }

  async completeStream(
    request: ProviderCompleteRequest,
    observer: ProviderStreamObserver,
  ): Promise<ProviderCompleteResponse> {
    return new OpenAICompatibleProviderClient(
      this.#profile,
      this.#fetcher,
      'ollama',
    ).completeStream(request, observer);
  }
}

// IDs use the same format as OpenCode (intercepted via MITM proxy):
// - session: "ses_" + compact ID (stable per daemon lifetime)
// - project: 40-char hex string (SHA1-like, stable per daemon)
// - request: "msg_" + compact ID (fresh per request, matches OpenCode's message ID format)
export function makeZenCompactId(prefix: string): string {
  const raw = cryptoRandomUuid().replace(/-/g, '');
  return `${prefix}${raw}`;
}

const _secondarySessionId = makeZenCompactId('ses_');
const _secondaryProjectId = (() => {
  // Stable 40-char hex (same format as OpenCode's SHA1 project hash)
  const raw = cryptoRandomUuid().replace(/-/g, '') + cryptoRandomUuid().replace(/-/g, '');
  return raw.slice(0, 40);
})();

function parseRetryAfterMs(
  headers: Headers,
  fallbackMs: number,
): { delayMs: number; isLongTerm: boolean } {
  const val = headers.get('retry-after');
  if (!val) return { delayMs: fallbackMs, isLongTerm: false };
  const seconds = Number.parseFloat(val);
  if (Number.isNaN(seconds)) return { delayMs: fallbackMs, isLongTerm: false };
  return { delayMs: seconds * 1000, isLongTerm: seconds > 60 };
}

/**
 * Wraps a fetcher with OpenCode zen-compatible headers and automatic 429 retry.
 * Used by both OpencodeZenProviderClient (public provider) and SecondaryProviderClient.
 *
 * @param baseFetcher - underlying fetch implementation
 * @param sessionId   - stable session ID for this process instance
 * @param projectId   - stable 40-char hex project ID
 * @param getAuthToken - async callback returning the bearer token (key, account token, or 'public')
 * @param label       - provider label used in debug log messages
 */
export function buildZenClientFetcher(
  baseFetcher: FetchLike,
  sessionId: string,
  projectId: string,
  getAuthToken: () => Promise<string>,
  label = 'zen',
): FetchLike {
  const maxRetries = 3;
  const retryDelaysMs = [2000, 4000, 8000];

  return async (input, init = {}) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : '[Request object]';

    let bodyInfo: Record<string, string> = {};
    if (init.body && typeof init.body === 'string') {
      try {
        const parsed = JSON.parse(init.body) as Record<string, unknown>;
        const msgs = Array.isArray(parsed.messages) ? parsed.messages : [];
        bodyInfo = {
          'body.model': String(parsed.model ?? ''),
          'body.messages': `[${msgs.length} messages]`,
          'body.stream': String(parsed.stream ?? ''),
          'body.tools': parsed.tools
            ? `[${Array.isArray(parsed.tools) ? parsed.tools.length : '?'} tools]`
            : 'none',
          'body.temperature': String(parsed.temperature ?? ''),
        };
      } catch {}
    }

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const requestId = makeZenCompactId('msg_');
      const headers = new Headers(init.headers);
      const authToken = await getAuthToken();
      headers.set('authorization', `Bearer ${authToken}`);
      headers.set('x-opencode-project', projectId);
      headers.set('x-opencode-session', sessionId);
      headers.set('x-opencode-request', requestId);
      headers.set('x-opencode-client', 'cli');
      // NO x-vercel-ai-sdk-version — opencode 1.15.3 with ai-sdk 4.0.23 does NOT send it
      headers.set('User-Agent', 'opencode/1.15.3 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.13');
      headers.set('Accept', '*/*');
      headers.set('Connection', 'keep-alive');

      writeDebugEvent({
        component: 'provider',
        level: 'info',
        message: `${label} request attempt ${attempt + 1}/${maxRetries}`,
        data: { url, method: init.method ?? 'GET', sessionId, projectId, requestId, ...bodyInfo },
      });

      const response = await baseFetcher(input, { ...init, headers });

      writeDebugEvent({
        component: 'provider',
        level: response.ok ? 'info' : 'warn',
        message: `${label} response`,
        data: {
          url,
          status: response.status,
          ok: response.ok,
          contentType: response.headers.get('content-type') ?? null,
          retryAfter: response.headers.get('retry-after') ?? null,
          attempt: attempt + 1,
        },
      });

      if (response.status !== 429) {
        return response;
      }

      const fallbackMs = retryDelaysMs[attempt] ?? 8000;
      const { delayMs, isLongTerm } = parseRetryAfterMs(response.headers, fallbackMs);

      if (isLongTerm || attempt === maxRetries - 1) {
        let giveUpMsg = `${label} 429 — max retries exhausted`;
        if (isLongTerm) {
          const resetAt = new Date(Date.now() + delayMs);
          const hh = String(resetAt.getHours()).padStart(2, '0');
          const mm = String(resetAt.getMinutes()).padStart(2, '0');
          giveUpMsg = `${label} 429 — daily quota exhausted, resets at ~${hh}:${mm} (in ${Math.round(delayMs / 3600000)}h)`;
        }
        writeDebugEvent({
          component: 'provider',
          level: 'warn',
          message: giveUpMsg,
          data: { delayMs, isLongTerm, attempt: attempt + 1 },
        });
        if (isLongTerm) {
          const resetAt = new Date(Date.now() + delayMs);
          const hh = String(resetAt.getHours()).padStart(2, '0');
          const mm = String(resetAt.getMinutes()).padStart(2, '0');
          throw new Error(
            `Daily free quota exhausted. Resets at ~${hh}:${mm} (${Math.round(delayMs / 3600000)}h). Use /models to pick a different model or /provider connect to add a provider.`,
          );
        }
        return response;
      }

      writeDebugEvent({
        component: 'provider',
        level: 'info',
        message: `${label} 429 — waiting ${Math.round(delayMs / 1000)}s then retrying`,
        data: { delayMs, attempt: attempt + 1 },
      });

      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }

    return baseFetcher(input, init);
  };
}

class SecondaryProviderClient implements ProviderClient {
  readonly #profile: ProviderProfile;
  readonly #fetcher: FetchLike;
  readonly #sessionId = _secondarySessionId;
  readonly #projectId = _secondaryProjectId;

  constructor(profile: ProviderProfile, fetcher: FetchLike) {
    this.#profile = profile;
    this.#fetcher = fetcher;
  }

  async listModels(): Promise<ProviderModelPayload[]> {
    return new OpenAICompatibleProviderClient(
      this.#profile,
      this.#withSecondaryHeaders(),
      'secondary',
    ).listModels();
  }

  async testConnection(): Promise<ProviderConnectionTestPayload> {
    return new OpenAICompatibleProviderClient(
      this.#profile,
      this.#withSecondaryHeaders(),
      'secondary',
    ).testConnection();
  }

  async complete(request: ProviderCompleteRequest): Promise<ProviderCompleteResponse> {
    const { sanitizedRequest, restoreNames } = sanitizeRequestToolNames(request);
    const response = await new OpenAICompatibleProviderClient(
      this.#profile,
      this.#withSecondaryHeaders(),
      'secondary',
    ).complete(sanitizedRequest);
    return restoreNames(response);
  }

  async completeStream(
    request: ProviderCompleteRequest,
    observer: ProviderStreamObserver,
  ): Promise<ProviderCompleteResponse> {
    const { sanitizedRequest, restoreNames } = sanitizeRequestToolNames(request);
    const response = await new OpenAICompatibleProviderClient(
      this.#profile,
      this.#withSecondaryHeaders(),
      'secondary',
    ).completeStream(sanitizedRequest, observer);
    return restoreNames(response);
  }

  #withSecondaryHeaders(): FetchLike {
    const profile = this.#profile;
    return buildZenClientFetcher(
      this.#fetcher,
      this.#sessionId,
      this.#projectId,
      async () => {
        const accountToken = await getSecondaryAccountToken();
        return profile.apiKey || accountToken || 'public';
      },
      'secondary',
    );
  }
}

function sanitizeRequestToolNames(request: ProviderCompleteRequest): {
  sanitizedRequest: ProviderCompleteRequest;
  restoreNames: (response: ProviderCompleteResponse) => ProviderCompleteResponse;
} {
  if (!request.tools || request.tools.length === 0) {
    return { sanitizedRequest: request, restoreNames: (r) => r };
  }

  const nameMap = new Map<string, string>();
  const sanitizedTools = request.tools.map((tool) => {
    const sanitized = tool.name.replace(/[^a-zA-Z0-9_-]/g, '_');
    if (sanitized !== tool.name) {
      nameMap.set(sanitized, tool.name);
    }
    return { ...tool, name: sanitized };
  });

  const sanitizedRequest = { ...request, tools: sanitizedTools };

  const restoreNames = (response: ProviderCompleteResponse): ProviderCompleteResponse => {
    if (nameMap.size === 0) return response;
    return {
      ...response,
      toolCalls: response.toolCalls.map((call) => ({
        ...call,
        name: nameMap.get(call.name) ?? call.name,
      })),
    };
  };

  return { sanitizedRequest, restoreNames };
}

function dedupeListedModels(models: NormalizedListedModel[]): ProviderModelPayload[] {
  const byId = new Map<string, NormalizedListedModel>();

  for (const model of models) {
    const key = model.id.trim().toLowerCase();
    const current = byId.get(key);

    if (!current || shouldReplaceListedModel(current, model)) {
      byId.set(key, model);
    }
  }

  return [...byId.values()]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(stripListedModelMetadata);
}

// Iteratively strip all known version/date suffixes until the ID is stable.
// Handles compound suffixes like mistral-medium-3-5-2604 → mistral-medium (two passes).
const MISTRAL_VERSION_SUFFIXES = [
  /-latest$/,
  /-\d{4}(-\d{2}(-\d{2})?)?$/, // -2604, -2604-01, -2604-01-15
  /-\d+\.\d+$/, // -3.5
  /-\d+-\d+$/, // -3-5
  /-v\d+(\.\d+)*$/, // -v2, -v2.1
  /-\d+$/, // -3 (single version digit, e.g. mistral-medium-3 → mistral-medium)
  // Safe: models ending in letter like -7b, -3b, -12b do NOT match
];

function getMistralModelFamily(id: string): string {
  let family = id.toLowerCase();
  let prev: string;
  do {
    prev = family;
    for (const re of MISTRAL_VERSION_SUFFIXES) {
      family = family.replace(re, '');
    }
  } while (family !== prev);
  return family;
}

// Format a raw Mistral model ID into a human-readable display name.
function formatMistralModelName(rawId: string): string {
  const MISTRAL_PREFIXES: Array<[RegExp, string]> = [
    [/^open-mistral-/, 'Open Mistral'],
    [/^open-mixtral-/, 'Open Mixtral'],
    [/^open-/, 'Open'],
    [/^magistral-/, 'Magistral'],
    [/^mistral-/, 'Mistral'],
    [/^pixtral-/, 'Pixtral'],
    [/^codestral-/, 'Codestral'],
    [/^ministral-/, 'Ministral'],
    [/^devstral-/, 'Devstral'],
    [/^voxtral-/, 'Voxtral'],
  ];

  // Extract known prefix label and the remainder after the dash
  let prefix = '';
  let remainder = rawId;
  for (const [re, label] of MISTRAL_PREFIXES) {
    const match = re.exec(rawId);
    if (match) {
      prefix = label;
      remainder = rawId.slice(match[0].length);
      break;
    }
  }

  // Capitalize each dash-separated segment of the remainder independently
  const parts = remainder
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1));

  const name = prefix ? [prefix, ...parts].join(' ') : parts.join(' ');
  return name
    .replace(/\bLatest\b/g, '(Latest)')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeMistralListedModels(models: NormalizedListedModel[]): ProviderModelPayload[] {
  // Filter non-chat and archived models; fall back to full list if everything is filtered out
  const candidates = models.filter((model) => !model.archived && model.chatCapable !== false);
  const pool = candidates.length > 0 ? candidates : models;

  // Step 1: pre-dedupe by exact normalized ID (guards against API returning the same ID twice)
  const byId = new Map<string, NormalizedListedModel>();
  for (const model of pool) {
    const key = model.id.toLowerCase().trim();
    const current = byId.get(key);
    if (!current || shouldReplaceListedModel(current, model)) {
      byId.set(key, model);
    }
  }

  // Step 2: group by base family using iterative suffix stripping
  // Handles compound IDs like mistral-medium-3-5-2604 correctly (two passes needed)
  const byFamily = new Map<string, NormalizedListedModel>();
  for (const model of byId.values()) {
    const id = model.id.toLowerCase();
    const family = getMistralModelFamily(id);
    const current = byFamily.get(family);
    if (!current) {
      byFamily.set(family, model);
    } else if (id.endsWith('-latest') && !current.id.toLowerCase().endsWith('-latest')) {
      // Always prefer -latest alias over any specific version
      byFamily.set(family, model);
    } else if (!id.endsWith('-latest') && !current.id.toLowerCase().endsWith('-latest')) {
      // Neither is -latest: pick better by quality heuristic
      if (shouldReplaceListedModel(current, model)) byFamily.set(family, model);
    }
    // current is -latest and candidate is not → keep current (no action)
  }

  writeDebugEvent({
    component: 'provider',
    level: 'info',
    message: 'mistral dedup complete',
    data: {
      rawCount: models.length,
      poolCount: pool.length,
      byIdCount: byId.size,
      byFamilyCount: byFamily.size,
      families: [...byFamily.entries()].map(([fam, m]) => `${fam} → ${m.id}`),
    },
  });

  // Step 3: final exact-ID dedupe (safety net; byFamily values should already be unique)
  const deduped = dedupeListedModels([...byFamily.values()]);

  return deduped
    .map((model) => {
      const name = model.name === model.id ? formatMistralModelName(model.id) : model.name;
      return { ...model, name };
    })
    .sort((left, right) => {
      const leftScore = scoreMistralModel(left);
      const rightScore = scoreMistralModel(right);
      if (leftScore !== rightScore) return rightScore - leftScore;
      if ((right.contextWindow ?? 0) !== (left.contextWindow ?? 0)) {
        return (right.contextWindow ?? 0) - (left.contextWindow ?? 0);
      }
      return left.name.localeCompare(right.name);
    });
}

function shouldReplaceListedModel(
  current: NormalizedListedModel,
  candidate: NormalizedListedModel,
): boolean {
  if (current.deprecated !== candidate.deprecated) {
    return current.deprecated && !candidate.deprecated;
  }

  if (current.contextWindow !== candidate.contextWindow) {
    return (candidate.contextWindow ?? 0) > (current.contextWindow ?? 0);
  }

  if (current.supportsTools !== candidate.supportsTools) {
    return candidate.supportsTools;
  }

  return (candidate.created ?? 0) > (current.created ?? 0);
}

function stripListedModelMetadata(model: NormalizedListedModel): ProviderModelPayload {
  return {
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    ...(model.tags.length > 0 ? { tags: model.tags } : {}),
  };
}

function scoreMistralModel(model: ProviderModelPayload): number {
  const value = model.id.toLowerCase();
  let score = 0;

  // Magistral = flagship reasoning models — show first
  if (value.startsWith('magistral')) score += 110;
  if (value.startsWith('mistral-large')) score += 100;
  if (value.startsWith('mistral-medium')) score += 90;
  if (value.startsWith('mistral-small')) score += 80;
  // Code / multimodal specialists
  if (value.startsWith('devstral')) score += 70;
  if (value.startsWith('codestral')) score += 65;
  if (value.startsWith('ministral')) score += 60;
  if (value.startsWith('pixtral')) score += 50;
  if (value.startsWith('voxtral')) score += 40;
  if (value.startsWith('open-')) score += 20;
  if ((model.tags ?? []).includes('tools')) score += 15;
  if ((model.tags ?? []).includes('vision')) score += 10;
  // Push internal / experimental / vibe-cli models to the bottom
  if (value.includes('vibe-cli')) score -= 80;
  if (value.startsWith('labs-')) score -= 70;
  if (value.startsWith('mistral-tiny')) score -= 60;
  if ((model.tags ?? []).includes('deprecated')) score -= 100;

  return score;
}

function buildListedModelTags(entry: Record<string, unknown>): string[] {
  const tags: string[] = [];

  if (readCapabilityFlag(entry, 'function_calling') === true) {
    tags.push('tools');
  }

  if (readCapabilityFlag(entry, 'vision') === true) {
    tags.push('vision');
  }

  if (readCapabilityFlag(entry, 'completion_fim') === true) {
    tags.push('fim');
  }

  if (entry.deprecation !== null && entry.deprecation !== undefined) {
    tags.push('deprecated');
  }

  return tags;
}

function readCapabilityFlag(entry: Record<string, unknown>, key: string): boolean | null {
  if (!isRecord(entry.capabilities)) {
    return null;
  }

  const value = entry.capabilities[key];
  return typeof value === 'boolean' ? value : null;
}

// ---------------------------------------------------------------------------
// Thinking / reasoning helpers
// ---------------------------------------------------------------------------

type ThinkInput = number | 'low' | 'medium' | 'high' | 'max' | null | undefined;

const EFFORT_TO_BUDGET: Record<string, number> = {
  low: 4_000,
  medium: 10_000,
  high: 16_000,
  max: 32_000,
};

function effortFromBudget(n: number): 'low' | 'medium' | 'high' {
  if (n <= 4_000) return 'low';
  if (n <= 10_000) return 'medium';
  return 'high';
}

/**
 * Build Anthropic thinking block.
 * String effort levels map to fixed budgets; numbers pass through directly.
 */
function buildAnthropicThinking(
  thinkInput: ThinkInput,
): { type: 'enabled'; budget_tokens: number } | null {
  if (thinkInput == null) return null;
  const budget =
    typeof thinkInput === 'number' ? thinkInput : (EFFORT_TO_BUDGET[thinkInput] ?? 10_000);
  return { type: 'enabled', budget_tokens: budget };
}

/**
 * Models whose IDs indicate they accept `reasoning_effort`.
 * Pattern: OpenAI o-series (o1, o3, o4-mini …) — NOT gpt-4o (it's vision, not CoT).
 * Blocklisted: DeepSeek, Qwen, Kimi etc. use non-standard APIs or no reasoning param.
 */
const REASONING_EFFORT_BLOCKLIST = [
  'deepseek-chat',
  'deepseek-reasoner',
  'deepseek-v3',
  'minimax',
  'glm',
  'kimi',
  'qwen',
  'big-pickle',
];

function supportsReasoningEffort(modelId: string): boolean {
  const id = modelId.toLowerCase();
  if (REASONING_EFFORT_BLOCKLIST.some((b) => id.includes(b))) return false;
  // OpenAI o-series: starts with o + digit (o1, o3, o4, o1-mini, o3-mini …)
  if (/^o\d/.test(id)) return true;
  // Explicitly named reasoning models not in blocklist (e.g. some OpenRouter aliases)
  if (id.includes('-r1') || id.includes('reasoning')) return true;
  return false;
}

/**
 * Build `reasoning_effort` param for OpenAI-compatible providers.
 * Returns empty object when model doesn't support it (silently ignored).
 */
function buildOpenAIReasoningParams(
  modelId: string,
  thinkInput: ThinkInput,
): Record<string, string> {
  if (thinkInput == null || !supportsReasoningEffort(modelId)) return {};
  const effort =
    typeof thinkInput === 'string'
      ? thinkInput === 'max'
        ? 'high'
        : thinkInput
      : effortFromBudget(thinkInput);
  return { reasoning_effort: effort };
}

// ---------------------------------------------------------------------------
// Mistral magistral thinking helpers
// ---------------------------------------------------------------------------

/**
 * Magistral models (magistral-small-*, magistral-medium-*) ALWAYS generate reasoning traces.
 * No parameter is needed to enable thinking — it is built-in.
 */
function isMistralThinkingModel(modelId: string): boolean {
  return modelId.toLowerCase().startsWith('magistral');
}

/**
 * Mistral adjustable-reasoning models: mistral-small and mistral-medium support
 * optional reasoning_effort parameter to control thinking verbosity.
 */
function isAdjustableMistralReasoningModel(modelId: string): boolean {
  const id = modelId.toLowerCase();
  return id.startsWith('mistral-small') || id.startsWith('mistral-medium');
}

/**
 * Build reasoning params for Mistral models.
 * - Magistral: always reasons, NO parameter needed — return {}
 * - mistral-small / mistral-medium: optional reasoning_effort (low/medium/high)
 * - All others: {}
 */
function buildMistralReasoningParams(
  modelId: string,
  thinkInput: ThinkInput,
): Record<string, unknown> {
  // Magistral always reasons — sending reasoning_effort is not needed/supported
  if (isMistralThinkingModel(modelId)) return {};
  // Adjustable reasoning models use reasoning_effort when explicitly requested
  if (isAdjustableMistralReasoningModel(modelId) && thinkInput != null) {
    const effort = typeof thinkInput === 'string' ? thinkInput : effortFromBudget(thinkInput);
    const effortValue = effort === 'max' ? 'high' : effort;
    return { reasoning_effort: effortValue };
  }
  return {};
}

/**
 * Extract text and reasoning from Magistral's array content response.
 * Content: [{type:"thinking", thinking:[{type:"text",text:"..."}]}, {type:"text",text:"..."}]
 */
function extractMistralContentChunks(rawContent: unknown): {
  text: string | null;
  reasoning: string | null;
} {
  if (typeof rawContent === 'string') return { text: rawContent || null, reasoning: null };
  if (!Array.isArray(rawContent)) return { text: null, reasoning: null };
  let text: string | null = null;
  let reasoning: string | null = null;
  for (const chunk of rawContent) {
    if (!isRecord(chunk)) continue;
    if (chunk.type === 'text' && typeof chunk.text === 'string') {
      text = (text ?? '') + chunk.text;
    } else if (chunk.type === 'thinking') {
      const parts = Array.isArray(chunk.thinking) ? chunk.thinking : [];
      for (const part of parts) {
        if (isRecord(part) && typeof part.text === 'string') {
          reasoning = (reasoning ?? '') + part.text;
        }
      }
    }
  }
  return { text: text || null, reasoning: reasoning || null };
}

/**
 * Extract Mistral thinking text from a streaming delta.
 * Magistral streams thinking as delta.content = [{type:"thinking", thinking:[{type:"text",text:"..."}]}]
 */
function extractMistralThinkingDelta(delta: Record<string, unknown>): string {
  const content = delta.content;
  if (!Array.isArray(content)) return '';
  let thinking = '';
  for (const chunk of content) {
    if (!isRecord(chunk) || chunk.type !== 'thinking') continue;
    const parts = Array.isArray(chunk.thinking) ? chunk.thinking : [];
    for (const part of parts) {
      if (isRecord(part) && typeof part.text === 'string') {
        thinking += part.text;
      }
    }
  }
  return thinking;
}

function createJsonHeaders(profile: ProviderProfile): Record<string, string> {
  return {
    'content-type': 'application/json',
    ...(profile.apiKey ? { authorization: `Bearer ${profile.apiKey}` } : {}),
  };
}

function createAnthropicHeaders(profile: ProviderProfile): Record<string, string> {
  return {
    'content-type': 'application/json',
    ...(profile.apiKey ? { 'x-api-key': profile.apiKey } : {}),
  };
}

function resolveModel(profile: ProviderProfile, request: ProviderCompleteRequest): string {
  const model = request.model?.trim() || profile.model?.trim();

  if (!model) {
    throw new Error(`Provider profile "${profile.id}" does not have a model configured.`);
  }

  return model;
}

function buildOllamaTagsUrl(baseUrl: string): string {
  const normalized = trimTrailingSlash(baseUrl);

  if (normalized.endsWith('/api')) {
    return `${normalized}/tags`;
  }

  if (normalized.endsWith('/v1')) {
    return `${normalized.slice(0, -3)}/api/tags`;
  }

  return `${normalized}/api/tags`;
}

function trimTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function serializeOpenAiMessages(
  messages: ProviderCompleteRequest['messages'],
  mistralThinkingMode = false,
) {
  const shouldBackfillReasoningContent =
    !mistralThinkingMode &&
    messages.some(
      (message) =>
        message.role === 'assistant' &&
        typeof message.reasoningContent === 'string' &&
        message.reasoningContent.length > 0,
    );

  return messages.map((message) => {
    // Mistral magistral multi-turn: assistant messages with reasoning use array content
    if (
      mistralThinkingMode &&
      message.role === 'assistant' &&
      typeof message.reasoningContent === 'string' &&
      message.reasoningContent.length > 0
    ) {
      const chunks: unknown[] = [
        { type: 'thinking', thinking: [{ type: 'text', text: message.reasoningContent }] },
      ];
      if (message.content) chunks.push({ type: 'text', text: message.content });
      return {
        role: 'assistant',
        content: chunks,
        ...(message.toolCalls
          ? {
              tool_calls: message.toolCalls.map((toolCall) => ({
                id: toolCall.id,
                type: 'function',
                function: { name: toolCall.name, arguments: JSON.stringify(toolCall.arguments) },
              })),
            }
          : {}),
      };
    }

    return {
      role: message.role,
      content: message.toolCalls && message.content === null ? null : (message.content ?? ''),
      ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
      ...(message.toolCalls
        ? {
            tool_calls: message.toolCalls.map((toolCall) => ({
              id: toolCall.id,
              type: 'function',
              function: {
                name: toolCall.name,
                arguments: JSON.stringify(toolCall.arguments),
              },
            })),
          }
        : {}),
      ...(message.role === 'assistant' && shouldBackfillReasoningContent
        ? { reasoning_content: message.reasoningContent ?? '' }
        : {}),
    };
  });
}

async function consumeSseStream(
  response: Response,
  onData: (payload: unknown) => void,
): Promise<void> {
  const reader = response.body?.getReader();

  if (!reader) {
    return;
  }

  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();

    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split(/\r?\n\r?\n/);
    buffer = parts.pop() ?? '';

    for (const part of parts) {
      for (const line of part.split(/\r?\n/)) {
        const trimmed = line.trim();

        if (!trimmed.startsWith('data:')) {
          continue;
        }

        const data = trimmed.slice(5).trim();

        if (!data || data === '[DONE]') {
          continue;
        }

        try {
          onData(JSON.parse(data) as unknown);
        } catch {}
      }
    }
  }
}

function serializeOpenAiResponsesInput(messages: ProviderCompleteRequest['messages']) {
  return messages.map((message) => {
    if (message.role === 'system') {
      return {
        role: 'developer',
        content: [{ type: 'input_text', text: message.content ?? '' }],
      };
    }

    if (message.role === 'assistant') {
      return {
        role: 'assistant',
        content: [{ type: 'output_text', text: message.content ?? '' }],
      };
    }

    return {
      role: message.role === 'tool' ? 'user' : message.role,
      content: [{ type: 'input_text', text: message.content ?? '' }],
    };
  });
}

function toOpenAiTool(tool: NonNullable<ProviderCompleteRequest['tools']>[number]) {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description ?? '',
      parameters: tool.inputSchema,
    },
  };
}

function toResponsesTool(tool: NonNullable<ProviderCompleteRequest['tools']>[number]) {
  return {
    type: 'function',
    name: tool.name,
    description: tool.description ?? '',
    parameters: tool.inputSchema,
  };
}

function toAnthropicTool(tool: NonNullable<ProviderCompleteRequest['tools']>[number]) {
  return {
    name: tool.name,
    description: tool.description ?? '',
    input_schema: tool.inputSchema,
  };
}

function serializeAnthropicMessages(
  messages: ProviderCompleteRequest['messages'],
  responseFormat: ProviderCompleteRequest['responseFormat'],
) {
  const systemParts = messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content ?? '')
    .filter((value) => value.length > 0);

  if (responseFormat?.type === 'json_object') {
    systemParts.push('Return valid JSON only. No text outside the JSON object.');
  } else if (responseFormat?.type === 'json_schema') {
    systemParts.push(
      [
        'Return valid JSON only.',
        `Schema name: ${responseFormat.name}.`,
        `JSON schema: ${JSON.stringify(responseFormat.schema)}`,
      ].join(' '),
    );
  }

  const normalized = messages
    .filter((message) => message.role !== 'system')
    .map((message) => {
      if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
        return {
          role: 'assistant',
          content: message.toolCalls.map((toolCall) => ({
            type: 'tool_use',
            id: toolCall.id,
            name: toolCall.name,
            input: toolCall.arguments,
          })),
        };
      }

      if (message.role === 'tool') {
        return {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: message.toolCallId,
              content: message.content ?? '',
            },
          ],
        };
      }

      return {
        role: message.role,
        content: [{ type: 'text', text: message.content ?? '' }],
      };
    });

  return {
    system: systemParts.join('\n\n'),
    messages: normalized,
  };
}

function parseOpenAiToolCall(toolCall: {
  id: string;
  function: { name: string; arguments: string };
}): ProviderToolCall {
  return {
    id: toolCall.id,
    name: toolCall.function.name,
    arguments: parseJsonObject(toolCall.function.arguments),
  };
}

function firstChoice(payload: unknown): Record<string, unknown> | null {
  if (!isRecord(payload) || !Array.isArray(payload.choices) || payload.choices.length === 0) {
    return null;
  }

  const choice = payload.choices[0];
  return isRecord(choice) ? choice : null;
}

function extractOpenAiTextDelta(delta: Record<string, unknown>): string {
  const content = delta.content;

  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((entry) => {
        if (typeof entry === 'string') {
          return entry;
        }

        if (isRecord(entry) && typeof entry.text === 'string') {
          return entry.text;
        }

        return '';
      })
      .join('');
  }

  return '';
}

// Some zen backends (e.g. qwen3.6-plus-free) return Anthropic-format SSE events
// instead of OpenAI-format. This function extracts text from Anthropic streaming chunks.
// Anthropic format: {"type":"content_block_delta","delta":{"type":"text_delta","text":"..."},"index":N}
function extractAnthropicStreamText(payload: unknown): string {
  if (!isRecord(payload)) return '';

  const type = payload.type;
  if (type === 'content_block_delta' && isRecord(payload.delta)) {
    const delta = payload.delta;
    if (delta.type === 'text_delta' && typeof delta.text === 'string') {
      return delta.text;
    }
  }

  return '';
}

function extractAnthropicStreamReasoning(payload: unknown): string {
  if (!isRecord(payload)) return '';
  if (payload.type === 'content_block_delta' && isRecord(payload.delta)) {
    const delta = payload.delta;
    if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
      return delta.thinking;
    }
  }
  return '';
}

function isAnthropicStreamFormat(payload: unknown): boolean {
  if (!isRecord(payload)) return false;
  const t = payload.type;
  return (
    t === 'message_start' ||
    t === 'content_block_start' ||
    t === 'content_block_delta' ||
    t === 'content_block_stop' ||
    t === 'message_delta' ||
    t === 'message_stop' ||
    t === 'ping'
  );
}

function extractOpenAiReasoningDelta(delta: Record<string, unknown>): string {
  const candidates = [delta.reasoning_content, delta.reasoning, delta.reasoning_details];

  return candidates.map((value) => extractDeltaText(value)).find((value) => value.length > 0) ?? '';
}

function extractDeltaText(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (!Array.isArray(value)) {
    return '';
  }

  return value
    .map((entry) => {
      if (typeof entry === 'string') {
        return entry;
      }

      if (!isRecord(entry)) {
        return '';
      }

      if (typeof entry.text === 'string') {
        return entry.text;
      }

      if (typeof entry.reasoning === 'string') {
        return entry.reasoning;
      }

      if (typeof entry.content === 'string') {
        return entry.content;
      }

      return '';
    })
    .join('');
}

function extractOpenAiToolCallDeltas(delta: Record<string, unknown>): Array<{
  index: number;
  id: string;
  name: string;
  argumentsText: string;
}> {
  const toolCalls = delta.tool_calls;

  if (!Array.isArray(toolCalls)) {
    return [];
  }

  return toolCalls
    .map((entry, index) => {
      if (!isRecord(entry)) {
        return null;
      }

      const fn = isRecord(entry.function) ? entry.function : {};
      return {
        index: typeof entry.index === 'number' ? entry.index : index,
        id: typeof entry.id === 'string' ? entry.id : '',
        name: typeof fn.name === 'string' ? fn.name : '',
        argumentsText: typeof fn.arguments === 'string' ? fn.arguments : '',
      };
    })
    .filter((value): value is NonNullable<typeof value> => value !== null);
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function readErrorBody(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.slice(0, 800);
  } catch {
    return '(could not read response body)';
  }
}

function extractProviderErrorMessage(providerType: string, status: number, body: string): string {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (isRecord(parsed)) {
      const err = isRecord(parsed.error) ? parsed.error : null;
      const msg =
        (typeof err?.message === 'string' && err.message) ||
        (typeof parsed.message === 'string' && parsed.message) ||
        null;
      if (msg) {
        return `${msg} (${providerType} / ${status})`;
      }
    }
  } catch {}
  return `${providerType} returned ${status}`;
}

function isRateLimitOrAuth(status: number): boolean {
  return status === 429 || status === 401 || status === 403;
}

function parseJsonOrNull(value: string | null): unknown | null {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function summarizeOutputText(value: string | null): string | null {
  if (!value) {
    return null;
  }

  return value.replace(/\s+/g, ' ').trim().slice(0, 160);
}

function cryptoRandomUuid(): string {
  return globalThis.crypto?.randomUUID?.() ?? `uuid-${Math.random().toString(36).slice(2, 12)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// OpenAI Codex (ChatGPT OAuth) provider client
// ---------------------------------------------------------------------------

const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const CODEX_JWT_CLAIM = 'https://api.openai.com/auth';

type CodexOAuthEntry = { access: string; refresh: string; expires: number; accountId: string };

function readCodexOAuthToken(profileId: string): CodexOAuthEntry | null {
  try {
    const home = process.env.UMBRA_HOME ?? path.join(os.homedir(), '.umbra');
    const content = fs.readFileSync(path.join(home, 'oauth-tokens.json'), 'utf8');
    const store = JSON.parse(content) as Record<string, unknown>;
    const token = store[profileId];
    if (!isRecord(token)) return null;
    if (
      typeof token.access !== 'string' ||
      typeof token.refresh !== 'string' ||
      typeof token.expires !== 'number'
    )
      return null;
    return {
      access: token.access,
      refresh: token.refresh,
      expires: token.expires,
      accountId: String(token.accountId ?? ''),
    };
  } catch {
    return null;
  }
}

function saveCodexOAuthToken(profileId: string, token: CodexOAuthEntry): void {
  try {
    const home = process.env.UMBRA_HOME ?? path.join(os.homedir(), '.umbra');
    const filePath = path.join(home, 'oauth-tokens.json');
    let store: Record<string, unknown> = {};
    try {
      store = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    } catch {}
    store[profileId] = token;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(store, null, 2), { encoding: 'utf8', mode: 0o600 });
  } catch {}
}

function extractCodexAccountId(token: string): string {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return '';
    const payload = JSON.parse(atob(parts[1] ?? '')) as Record<string, unknown>;
    const auth = payload[CODEX_JWT_CLAIM];
    if (!isRecord(auth)) return '';
    const id = auth.chatgpt_account_id;
    return typeof id === 'string' ? id : '';
  } catch {
    return '';
  }
}

function isRefreshTokenInvalidated(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes('refresh_token_invalidated') ||
    msg.includes('refresh_token_reused') ||
    msg.includes('token_invalidated') ||
    msg.includes('app_session_terminated') ||
    msg.includes('invalidated')
  );
}

async function refreshCodexToken(refreshToken: string): Promise<CodexOAuthEntry> {
  const response = await fetch(CODEX_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CODEX_CLIENT_ID,
    }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Codex token refresh failed (${response.status}): ${text}`);
  }
  const json = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!json.access_token || !json.refresh_token || typeof json.expires_in !== 'number') {
    throw new Error('Missing fields in Codex refresh response');
  }
  return {
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + json.expires_in * 1000,
    accountId: extractCodexAccountId(json.access_token),
  };
}

function buildCodexHeaders(
  access: string,
  accountId: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${access}`,
    'chatgpt-account-id': accountId,
    originator: 'umbra',
    'OpenAI-Beta': 'responses=experimental',
    ...extra,
  };
}

function buildCodexInput(messages: ProviderCompleteRequest['messages']): {
  system: string;
  input: unknown[];
} {
  const systemParts = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content ?? '')
    .filter(Boolean);
  const nonSystem = messages.filter((m) => m.role !== 'system');

  // Responses API input items: message, function_call, function_call_output are all top-level.
  // When a prior assistant turn included reasoning, its reasoning item MUST be re-sent in the
  // next request's input array — otherwise the Responses API loses context and tools stop working.
  const input = nonSystem.flatMap((message): unknown[] => {
    if (message.role === 'tool') {
      // Prefer custom_tool_call_output — ChatGPT backend uses CustomToolCall for
      // freeform tools (our fs.list, shell.exec, etc.) and expects the matching output type.
      // Fallback: we also send function_call_output for standard function_call responses.
      const callId = message.toolCallId ?? '';
      return [{ type: 'custom_tool_call_output', call_id: callId, output: message.content ?? '' }];
    }
    if (message.role === 'assistant') {
      const items: unknown[] = [];
      // Re-include reasoning item from prior turn so the model keeps tool-use context.
      if (message.reasoningContent) {
        items.push({
          type: 'reasoning',
          summary: [{ type: 'summary_text', text: message.reasoningContent }],
        });
      }
      if (message.toolCalls && message.toolCalls.length > 0) {
        if (message.content) {
          items.push({
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: message.content }],
          });
        }
        for (const tc of message.toolCalls) {
          items.push({
            type: 'custom_tool_call',
            call_id: tc.id,
            name: tc.name.replace(/[^a-zA-Z0-9_-]/g, '_'),
            input: JSON.stringify(tc.arguments),
          });
        }
        return items;
      }
      items.push({
        role: 'assistant',
        content: [{ type: 'output_text', text: message.content ?? '' }],
      });
      return items;
    }
    return [
      {
        role: 'user',
        content: [{ type: 'input_text', text: message.content ?? '' }],
      },
    ];
  });

  return { system: systemParts.join('\n\n'), input };
}

function extractCodexUsage(rawUsage: unknown): ProviderCompleteResponse['usage'] {
  if (!isRecord(rawUsage)) return undefined;
  const inputTokens = typeof rawUsage.input_tokens === 'number' ? rawUsage.input_tokens : undefined;
  const outputTokens =
    typeof rawUsage.output_tokens === 'number' ? rawUsage.output_tokens : undefined;
  const totalTokens = typeof rawUsage.total_tokens === 'number' ? rawUsage.total_tokens : undefined;
  const reasoningTokens =
    isRecord(rawUsage.output_tokens_details) &&
    typeof rawUsage.output_tokens_details.reasoning_tokens === 'number'
      ? rawUsage.output_tokens_details.reasoning_tokens
      : undefined;
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  return { inputTokens, outputTokens, totalTokens, reasoningTokens };
}

function parseCodexResponsePayload(
  payload: unknown,
  profileId: string,
  model: string,
  startedAt: number,
): ProviderCompleteResponse {
  if (!isRecord(payload)) {
    return {
      providerProfileId: profileId,
      providerType: 'openai-codex',
      model,
      outputText: null,
      outputJson: null,
      toolCalls: [],
      stopReason: null,
    };
  }

  const output = Array.isArray(payload.output) ? payload.output : [];
  const textParts: string[] = [];
  const reasoningParts: string[] = [];
  const toolCalls: ProviderToolCall[] = [];

  for (const item of output) {
    if (!isRecord(item)) continue;
    if (item.type === 'reasoning') {
      // summary array: [{type:'summary_text',text:'...'}]
      const summary = Array.isArray(item.summary) ? item.summary : [];
      for (const s of summary) {
        if (isRecord(s) && typeof s.text === 'string' && s.text) reasoningParts.push(s.text);
      }
      // content array fallback: [{type:'text'|'reasoning_text', text:'...'}]
      const content = Array.isArray(item.content) ? item.content : [];
      for (const c of content) {
        if (isRecord(c) && typeof c.text === 'string' && c.text) reasoningParts.push(c.text);
      }
    } else if (item.type === 'message') {
      const content = Array.isArray(item.content) ? item.content : [];
      for (const block of content) {
        if (isRecord(block) && block.type === 'output_text' && typeof block.text === 'string') {
          textParts.push(block.text);
        }
      }
    } else if (item.type === 'function_call') {
      const callId = typeof item.call_id === 'string' ? item.call_id : '';
      const name = typeof item.name === 'string' ? item.name : '';
      const args = typeof item.arguments === 'string' ? item.arguments : '{}';
      if (name) toolCalls.push({ id: callId || name, name, arguments: parseJsonObject(args) });
    } else if (item.type === 'custom_tool_call') {
      const callId =
        typeof item.call_id === 'string'
          ? item.call_id
          : typeof item.id === 'string'
            ? item.id
            : '';
      const name = typeof item.name === 'string' ? item.name : '';
      const input = typeof item.input === 'string' ? item.input : '{}';
      if (name) toolCalls.push({ id: callId || name, name, arguments: parseJsonObject(input) });
    }
  }

  const outputText = textParts.length > 0 ? textParts.join('\n') : null;
  const reasoningContent = reasoningParts.length > 0 ? reasoningParts.join('\n') : undefined;
  const usage = extractCodexUsage(payload.usage);
  writeDebugEvent({
    component: 'provider',
    level: 'info',
    message: 'codex completion finished',
    data: {
      profileId,
      model,
      toolCalls: toolCalls.length,
      hasReasoning: reasoningParts.length > 0,
      durationMs: Date.now() - startedAt,
    },
  });

  return {
    providerProfileId: profileId,
    providerType: 'openai-codex',
    model,
    outputText,
    outputJson: parseJsonOrNull(outputText),
    toolCalls,
    stopReason: typeof payload.status === 'string' ? payload.status : 'stop',
    ...(reasoningContent ? { reasoningContent } : {}),
    ...(usage ? { usage } : {}),
  };
}

function toCodexTool(tool: NonNullable<ProviderCompleteRequest['tools']>[number]) {
  return {
    type: 'function',
    name: tool.name,
    description: tool.description ?? '',
    parameters: tool.inputSchema,
  };
}

// Context windows for known Codex-compatible models (fallback when API doesn't return them)
const CODEX_KNOWN_CONTEXT_WINDOWS: Record<string, number> = {
  // GPT-5 series (current Codex API models)
  'gpt-5.5': 272_000,
  'gpt-5.4': 272_000,
  'gpt-5.4-mini': 272_000,
  'gpt-5.2': 272_000,
  // Codex-branded
  'codex-mini-latest': 200_000,
  // GPT-4.1 family
  'gpt-4.1': 1_047_576,
  'gpt-4.1-mini': 1_047_576,
  'gpt-4.1-nano': 1_047_576,
  // GPT-4o family
  'gpt-4o': 128_000,
  'gpt-4o-mini': 128_000,
  // Reasoning models
  'o4-mini': 200_000,
  o3: 200_000,
  'o3-mini': 200_000,
  o1: 200_000,
  'o1-mini': 128_000,
};

// Static model list mirrored from Codex CLI models.json (models-manager/models.json).
// Only visibility:"list" models are included — hidden models (codex-auto-review etc.) are excluded.
// The live /codex/models endpoint returns a subset of these; we merge live+static so the
// picker always shows the full set, with live data taking priority.
const CODEX_STATIC_MODELS: ProviderModelPayload[] = [
  { id: 'gpt-5.5', name: 'GPT-5.5', contextWindow: 272_000 },
  { id: 'gpt-5.4', name: 'GPT-5.4', contextWindow: 272_000 },
  { id: 'gpt-5.4-mini', name: 'GPT-5.4-Mini', contextWindow: 272_000 },
  { id: 'gpt-5.3-codex', name: 'gpt-5.3-codex', contextWindow: 272_000 },
  { id: 'gpt-5.2', name: 'gpt-5.2', contextWindow: 272_000 },
];

// Models that should never appear in the picker (visibility:"hide" in Codex models.json).
const CODEX_HIDDEN_MODEL_IDS = new Set(['codex-auto-review']);

// Non-chat modalities that can't be used via /codex/responses
const CODEX_EXCLUDE_FRAGMENTS = [
  'embedding',
  'whisper',
  'tts',
  'dall-e',
  'dall_e',
  'babbage',
  'davinci',
  'ada',
  'curie',
  'transcribe',
  'realtime',
  'audio-',
];

// Show all models except obvious non-chat modalities and known hidden models.
function isCodexCompatibleModelId(id: string): boolean {
  if (CODEX_HIDDEN_MODEL_IDS.has(id.toLowerCase())) return false;
  const lower = id.toLowerCase();
  return !CODEX_EXCLUDE_FRAGMENTS.some((f) => lower.includes(f));
}

function extractCodexCompatibleModels(json: unknown): ProviderModelPayload[] {
  if (!isRecord(json)) return [];

  // Handle both standard OpenAI { data: [] } and ChatGPT backend { models: [] } formats
  const rawList: unknown[] = Array.isArray(json.data)
    ? json.data
    : Array.isArray(json.models)
      ? json.models
      : [];

  const seen = new Set<string>();
  const result: ProviderModelPayload[] = [];

  for (const entry of rawList) {
    if (!isRecord(entry)) continue;

    const id =
      typeof entry.id === 'string' ? entry.id : typeof entry.slug === 'string' ? entry.slug : '';
    if (!id || !isCodexCompatibleModelId(id)) continue;

    const key = id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const name =
      typeof entry.name === 'string'
        ? entry.name
        : typeof entry.title === 'string'
          ? entry.title
          : typeof entry.display_name === 'string'
            ? entry.display_name
            : id;

    const apiContext =
      typeof entry.context_window === 'number'
        ? entry.context_window
        : typeof entry.max_context_length === 'number'
          ? entry.max_context_length
          : null;
    const contextWindow = apiContext ?? CODEX_KNOWN_CONTEXT_WINDOWS[id] ?? null;

    result.push({ id, name, contextWindow });
  }

  // Sort: gpt-5 → codex → gpt-4.1 → gpt-4o → o4 → o3 → o1
  return result.sort((a, b) => {
    const rank = (m: ProviderModelPayload): number => {
      const id = m.id.toLowerCase();
      if (/^gpt-5/.test(id)) return 0;
      if (id.startsWith('codex-')) return 1;
      if (id.startsWith('gpt-4.1')) return 2;
      if (id.startsWith('gpt-4o')) return 3;
      if (/^o4/.test(id)) return 4;
      if (/^o3/.test(id)) return 5;
      if (/^o1/.test(id)) return 6;
      return 7;
    };
    const diff = rank(a) - rank(b);
    return diff !== 0 ? diff : a.id.localeCompare(b.id);
  });
}

class OpenAICodexProviderClient implements ProviderClient {
  readonly #profile: ProviderProfile;
  readonly #fetcher: FetchLike;

  constructor(profile: ProviderProfile, fetcher: FetchLike) {
    this.#profile = profile;
    this.#fetcher = fetcher;
  }

  async #getToken(): Promise<{ access: string; accountId: string }> {
    const stored = readCodexOAuthToken(this.#profile.id);
    if (!stored) {
      throw new Error(
        `No OAuth token for profile "${this.#profile.id}". Run: umbra providers connect openai-codex`,
      );
    }
    if (Date.now() >= stored.expires - 60_000) {
      try {
        const refreshed = await refreshCodexToken(stored.refresh);
        saveCodexOAuthToken(this.#profile.id, refreshed);
        return { access: refreshed.access, accountId: refreshed.accountId };
      } catch (err) {
        if (isRefreshTokenInvalidated(err)) {
          throw new Error(
            'ChatGPT session expired — please reconnect your provider. Run: umbra providers connect openai-codex',
          );
        }
        if (Date.now() < stored.expires)
          return { access: stored.access, accountId: stored.accountId };
        throw new Error(
          'ChatGPT OAuth token expired and refresh failed. Run: umbra providers connect openai-codex',
        );
      }
    }
    return { access: stored.access, accountId: stored.accountId };
  }

  async #forceRefreshToken(): Promise<{ access: string; accountId: string }> {
    const stored = readCodexOAuthToken(this.#profile.id);
    if (!stored) throw new Error(`No OAuth token for profile "${this.#profile.id}".`);
    try {
      const refreshed = await refreshCodexToken(stored.refresh);
      saveCodexOAuthToken(this.#profile.id, refreshed);
      return { access: refreshed.access, accountId: refreshed.accountId };
    } catch (err) {
      if (isRefreshTokenInvalidated(err)) {
        throw new Error(
          'ChatGPT session was invalidated (logged out or password changed). Reconnect: umbra providers connect openai-codex',
        );
      }
      throw err;
    }
  }

  async listModels(): Promise<ProviderModelPayload[]> {
    try {
      const { access, accountId } = await this.#getToken();
      const baseUrl = trimTrailingSlash(this.#profile.baseUrl || 'https://chatgpt.com/backend-api');

      const headers: Record<string, string> = {
        Authorization: `Bearer ${access}`,
        'chatgpt-account-id': accountId,
        originator: 'umbra',
        Accept: 'application/json',
      };

      // client_version is required by the endpoint (validated server-side).
      // Do NOT pass limit= — it truncates the model list on the server side.
      // Try newest client_version first (richer model list), then fall back to older.
      const urls = [
        `${baseUrl}/codex/models?client_version=0.140.0`,
        `${baseUrl}/codex/models?client_version=0.135.0`,
        `${baseUrl}/codex/models?client_version=0.120.0`,
      ];

      for (const url of urls) {
        try {
          const response = await this.#fetcher(url, { headers });
          if (!response.ok) {
            const body = await response.text().catch(() => '');
            writeDebugEvent({
              component: 'provider',
              level: 'info',
              message: 'codex listModels failed',
              data: { url, status: response.status, body: body.slice(0, 200) },
            });
            continue;
          }
          const json = (await response.json()) as unknown;
          const liveModels = extractCodexCompatibleModels(json);
          // Always merge live with static: live data takes priority, static fills gaps.
          const liveIds = new Set(liveModels.map((m) => m.id.toLowerCase()));
          const merged = [
            ...liveModels,
            ...CODEX_STATIC_MODELS.filter((m) => !liveIds.has(m.id.toLowerCase())),
          ].sort((a, b) => {
            const staticIdx = (id: string) => CODEX_STATIC_MODELS.findIndex((m) => m.id === id);
            const ai = staticIdx(a.id);
            const bi = staticIdx(b.id);
            if (ai !== -1 && bi !== -1) return ai - bi;
            if (ai !== -1) return -1;
            if (bi !== -1) return 1;
            return a.id.localeCompare(b.id);
          });
          writeDebugEvent({
            component: 'provider',
            level: 'info',
            message: 'codex listModels live',
            data: { url, liveCount: liveModels.length, totalCount: merged.length },
          });
          return merged;
        } catch (err) {
          writeDebugEvent({
            component: 'provider',
            level: 'info',
            message: 'codex listModels error',
            data: { url, error: err instanceof Error ? err.message : String(err) },
          });
        }
      }
    } catch (err) {
      writeDebugEvent({
        component: 'provider',
        level: 'warn',
        message: 'codex listModels token error',
        data: { error: err instanceof Error ? err.message : String(err) },
      });
    }
    writeDebugEvent({
      component: 'provider',
      level: 'info',
      message: 'codex listModels: static fallback',
      data: { count: CODEX_STATIC_MODELS.length },
    });
    return [...CODEX_STATIC_MODELS];
  }

  async testConnection(): Promise<ProviderConnectionTestPayload> {
    try {
      const { accountId } = await this.#getToken();
      return { ok: true, message: `Connected — account ${accountId.slice(0, 8)}…` };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  async complete(request: ProviderCompleteRequest): Promise<ProviderCompleteResponse> {
    const { sanitizedRequest, restoreNames } = sanitizeRequestToolNames(request);
    const model = resolveModel(this.#profile, sanitizedRequest);
    const thinkInput = (request as ProviderCompleteRequest & { thinkBudget?: ThinkInput })
      .thinkBudget;
    const { access, accountId } = await this.#getToken();
    const startedAt = Date.now();
    const baseUrl = trimTrailingSlash(this.#profile.baseUrl || 'https://chatgpt.com/backend-api');
    const { system, input } = buildCodexInput(sanitizedRequest.messages);

    writeDebugEvent({
      component: 'provider',
      level: 'info',
      message: 'codex completion requested',
      data: { profileId: this.#profile.id, model },
    });

    const reasoningParams =
      thinkInput != null
        ? {
            reasoning: {
              effort:
                typeof thinkInput === 'string'
                  ? thinkInput === 'max'
                    ? 'high'
                    : thinkInput
                  : effortFromBudget(thinkInput),
              summary: 'auto',
            },
          }
        : {};

    const requestBody = JSON.stringify({
      model,
      stream: false,
      store: false,
      instructions: system,
      input,
      text: { verbosity: thinkInput != null ? 'medium' : 'low' },
      ...reasoningParams,
      ...(sanitizedRequest.tools
        ? { tools: sanitizedRequest.tools.map(toCodexTool), tool_choice: 'auto' }
        : {}),
      ...(typeof sanitizedRequest.maxTokens === 'number'
        ? { max_output_tokens: sanitizedRequest.maxTokens }
        : {}),
    });

    let tok = { access, accountId };
    let response = await this.#fetcher(`${baseUrl}/codex/responses`, {
      method: 'POST',
      headers: buildCodexHeaders(tok.access, tok.accountId, this.#profile.extraHeaders),
      body: requestBody,
    });

    if (!response.ok && response.status === 401) {
      tok = await this.#forceRefreshToken();
      response = await this.#fetcher(`${baseUrl}/codex/responses`, {
        method: 'POST',
        headers: buildCodexHeaders(tok.access, tok.accountId, this.#profile.extraHeaders),
        body: requestBody,
      });
    }

    if (!response.ok) {
      const body = await readErrorBody(response);
      if (response.status === 429)
        throw new Error(`ChatGPT usage limit reached. (${response.status})`);
      throw new Error(extractProviderErrorMessage('openai-codex', response.status, body));
    }

    return restoreNames(
      parseCodexResponsePayload(
        (await response.json()) as unknown,
        this.#profile.id,
        model,
        startedAt,
      ),
    );
  }

  async completeStream(
    request: ProviderCompleteRequest,
    observer: ProviderStreamObserver,
  ): Promise<ProviderCompleteResponse> {
    const { sanitizedRequest, restoreNames } = sanitizeRequestToolNames(request);
    const model = resolveModel(this.#profile, sanitizedRequest);
    const thinkInput = (request as ProviderCompleteRequest & { thinkBudget?: ThinkInput })
      .thinkBudget;
    const { access, accountId } = await this.#getToken();
    const startedAt = Date.now();
    const baseUrl = trimTrailingSlash(this.#profile.baseUrl || 'https://chatgpt.com/backend-api');
    const { system, input } = buildCodexInput(sanitizedRequest.messages);

    const reasoningParams =
      thinkInput != null
        ? {
            reasoning: {
              effort:
                typeof thinkInput === 'string'
                  ? thinkInput === 'max'
                    ? 'high'
                    : thinkInput
                  : effortFromBudget(thinkInput),
              summary: 'auto',
            },
          }
        : {};

    const streamBody = JSON.stringify({
      model,
      stream: true,
      store: false,
      instructions: system,
      input,
      text: { verbosity: thinkInput != null ? 'medium' : 'low' },
      ...reasoningParams,
      ...(sanitizedRequest.tools
        ? { tools: sanitizedRequest.tools.map(toCodexTool), tool_choice: 'auto' }
        : {}),
      ...(typeof sanitizedRequest.maxTokens === 'number'
        ? { max_output_tokens: sanitizedRequest.maxTokens }
        : {}),
    });

    let streamTok = { access, accountId };
    let response = await this.#fetcher(`${baseUrl}/codex/responses`, {
      method: 'POST',
      headers: {
        ...buildCodexHeaders(streamTok.access, streamTok.accountId, this.#profile.extraHeaders),
        accept: 'text/event-stream',
      },
      body: streamBody,
    });

    if (!response.ok && response.status === 401) {
      streamTok = await this.#forceRefreshToken();
      response = await this.#fetcher(`${baseUrl}/codex/responses`, {
        method: 'POST',
        headers: {
          ...buildCodexHeaders(streamTok.access, streamTok.accountId, this.#profile.extraHeaders),
          accept: 'text/event-stream',
        },
        body: streamBody,
      });
    }

    if (!response.ok) {
      const body = await readErrorBody(response);
      if (response.status === 429)
        throw new Error(`ChatGPT usage limit reached. (${response.status})`);
      throw new Error(extractProviderErrorMessage('openai-codex', response.status, body));
    }

    const outputTextParts: string[] = [];
    const reasoningParts: string[] = [];
    const toolCallMap = new Map<string, { id: string; name: string; argumentsText: string }>();
    let stopReason: string | null = null;
    let completedPayload: unknown = null;

    await consumeSseStream(response, (payload) => {
      if (!isRecord(payload)) return;
      const type = payload.type as string;

      if (type === 'response.output_text.delta') {
        const delta = typeof payload.delta === 'string' ? payload.delta : '';
        if (delta) {
          outputTextParts.push(delta);
          observer.onTextDelta?.(delta);
        }
      } else if (
        type === 'response.reasoning_summary_text.delta' ||
        type === 'response.reasoning_text.delta'
      ) {
        const delta = typeof payload.delta === 'string' ? payload.delta : '';
        if (delta) {
          reasoningParts.push(delta);
          observer.onReasoningDelta?.(delta);
        }
      } else if (
        type === 'response.reasoning_summary_text.done' ||
        type === 'response.reasoning_text.done'
      ) {
        // Codex sends .done with full text instead of streaming .delta chunks
        const text = typeof payload.text === 'string' ? payload.text : '';
        if (text && reasoningParts.join('').length === 0) {
          reasoningParts.push(text);
          observer.onReasoningDelta?.(text);
        }
      } else if (
        (type === 'response.output_item.added' || type === 'response.output_item.done') &&
        isRecord(payload.item)
      ) {
        const item = payload.item;
        // Both standard function_call and custom_tool_call items
        if (item.type === 'function_call' || item.type === 'custom_tool_call') {
          const callId =
            typeof item.call_id === 'string'
              ? item.call_id
              : typeof item.id === 'string'
                ? item.id
                : '';
          const name = typeof item.name === 'string' ? item.name : '';
          // For output_item.done the arguments/input may already be complete
          const existingArgs =
            type === 'response.output_item.done'
              ? typeof item.arguments === 'string'
                ? item.arguments
                : typeof item.input === 'string'
                  ? item.input
                  : ''
              : '';
          if (callId && name) {
            const existing = toolCallMap.get(callId);
            toolCallMap.set(callId, {
              id: callId,
              name,
              argumentsText: existingArgs || (existing?.argumentsText ?? ''),
            });
          } else if (name && !callId) {
            // Fallback: use name as key when call_id is absent
            toolCallMap.set(`name:${name}`, { id: '', name, argumentsText: existingArgs });
          }
        }
      } else if (
        type === 'response.function_call_arguments.delta' ||
        type === 'response.custom_tool_call_input.delta'
      ) {
        // Both standard and custom tool call argument deltas use call_id or item_id
        const callId =
          typeof payload.call_id === 'string'
            ? payload.call_id
            : typeof payload.item_id === 'string'
              ? payload.item_id
              : '';
        const delta = typeof payload.delta === 'string' ? payload.delta : '';
        if (callId && delta) {
          const tc = toolCallMap.get(callId);
          if (tc) {
            tc.argumentsText += delta;
          } else {
            // Delta arrived before output_item.added — create placeholder
            toolCallMap.set(callId, { id: callId, name: '', argumentsText: delta });
          }
        }
      } else if (type === 'response.completed' || type === 'response.done') {
        completedPayload = isRecord(payload.response) ? payload.response : payload;
        stopReason = 'stop';
      } else if (type === 'error') {
        const msg = typeof payload.message === 'string' ? payload.message : JSON.stringify(payload);
        throw new Error(`Codex error: ${msg}`);
      } else {
        writeDebugEvent({
          component: 'provider',
          level: 'info',
          message: 'codex sse unhandled',
          data: { type },
        });
      }
    });

    // If we got a completed response with output, try to parse from it
    if (completedPayload && isRecord(completedPayload) && Array.isArray(completedPayload.output)) {
      const full = parseCodexResponsePayload(completedPayload, this.#profile.id, model, startedAt);
      if (full.toolCalls.length > 0 || (!outputTextParts.length && full.outputText))
        return restoreNames(full);
    }

    const outputText = outputTextParts.length > 0 ? outputTextParts.join('') : null;
    const reasoningContent = reasoningParts.length > 0 ? reasoningParts.join('') : undefined;
    const toolCalls = [...toolCallMap.values()]
      .map((tc, idx) => ({
        id: tc.id || `tool-call-${idx + 1}`,
        name: tc.name,
        arguments: parseJsonObject(tc.argumentsText),
      }))
      .filter((tc) => tc.name.length > 0);
    const usage =
      completedPayload && isRecord(completedPayload)
        ? extractCodexUsage((completedPayload as Record<string, unknown>).usage)
        : undefined;

    writeDebugEvent({
      component: 'provider',
      level: 'info',
      message: 'codex stream finished',
      data: {
        profileId: this.#profile.id,
        model,
        toolCalls: toolCalls.length,
        hasReasoning: reasoningParts.length > 0,
        durationMs: Date.now() - startedAt,
      },
    });
    return restoreNames({
      providerProfileId: this.#profile.id,
      providerType: 'openai-codex',
      model,
      outputText,
      outputJson: parseJsonOrNull(outputText),
      toolCalls,
      stopReason,
      ...(reasoningContent ? { reasoningContent } : {}),
      ...(usage ? { usage } : {}),
    });
  }
}
