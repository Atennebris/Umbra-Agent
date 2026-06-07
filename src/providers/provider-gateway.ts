import { writeDebugEvent } from '../debug/runtime-debug.js';
import { getUsageLogger } from '../memory/usage-log.js';
import {
  type CompressionLevel,
  compressToolOutput,
  condenseProse,
} from '../utils/compression.js';
import type { ProviderCatalog } from './index.js';
import type { ModelsRegistry } from './models-registry.js';
import { type FetchLike, createProviderClient } from './provider-client.js';
import { resolveProviderType } from './provider-registry.js';
import type {
  ProviderChatMessage,
  ProviderCompleteRequest,
  ProviderCompleteResponse,
  ProviderStreamObserver,
} from './runtime-types.js';

export type GatewayRequest = ProviderCompleteRequest & {
  profileId?: string;
  chainId?: string;
  projectPath?: string;
  threadId?: string;
  sessionId?: string;
  requestId?: string;
  compressionLevel?: CompressionLevel;
  thinkBudget?: number | 'low' | 'medium' | 'high' | 'max' | null | undefined;
};

export interface ProviderGateway {
  complete(request: GatewayRequest): Promise<ProviderCompleteResponse>;
  completeStream(
    request: GatewayRequest,
    observer: ProviderStreamObserver,
  ): Promise<ProviderCompleteResponse>;
}

export class DefaultProviderGateway implements ProviderGateway {
  #catalog: ProviderCatalog;
  #models: ModelsRegistry;
  #fetcher: FetchLike;

  constructor(input: {
    catalog: ProviderCatalog;
    models: ModelsRegistry;
    fetcher?: FetchLike;
  }) {
    this.#catalog = input.catalog;
    this.#models = input.models;
    this.#fetcher = input.fetcher ?? fetch;
  }

  async complete(request: GatewayRequest): Promise<ProviderCompleteResponse> {
    const {
      profileId,
      chainId,
      requestId = `req-${Math.random().toString(36).slice(2, 12)}`,
      sessionId,
      threadId,
      ...rest
    } = request;

    const preparedRequest = this.#prepareRequest(rest, request.compressionLevel ?? 'off');

    if (chainId) {
      return this.#runChain(chainId, preparedRequest, requestId, (pId, req) =>
        this.#executeSingle(pId, req, requestId, chainId, sessionId, threadId),
      );
    }

    if (!profileId) {
      throw new Error('Gateway: either profileId or chainId must be provided.');
    }

    return this.#executeSingle(profileId, preparedRequest, requestId, undefined, sessionId, threadId);
  }

  async completeStream(
    request: GatewayRequest,
    observer: ProviderStreamObserver,
  ): Promise<ProviderCompleteResponse> {
    const {
      profileId,
      chainId,
      requestId = `req-${Math.random().toString(36).slice(2, 12)}`,
      sessionId,
      threadId,
      ...rest
    } = request;

    const preparedRequest = this.#prepareRequest(rest, request.compressionLevel ?? 'off');

    if (chainId) {
      return this.#runChain(chainId, preparedRequest, requestId, (pId, req) =>
        this.#executeSingleStream(pId, req, observer, requestId, chainId, sessionId, threadId),
      );
    }

    if (!profileId) {
      throw new Error('Gateway: either profileId or chainId must be provided.');
    }

    return this.#executeSingleStream(profileId, preparedRequest, observer, requestId, undefined, sessionId, threadId);
  }

  async #executeSingle(
    profileId: string,
    request: ProviderCompleteRequest,
    requestId: string,
    chainId?: string,
    sessionId?: string,
    threadId?: string,
  ): Promise<ProviderCompleteResponse> {
    this.#logRequest(requestId, profileId, request, false, chainId);

    try {
      const result = await this.#withRetries(
        () =>
          this.#catalog.completeProfile
            ? this.#catalog.completeProfile(profileId, request)
            : this.#fallbackComplete(profileId, request),
        requestId,
      );

      await this.#logResponse(requestId, result, chainId, sessionId, threadId);
      return result;
    } catch (error) {
      this.#logError(requestId, error, chainId);
      throw error;
    }
  }

  async #executeSingleStream(
    profileId: string,
    request: ProviderCompleteRequest,
    observer: ProviderStreamObserver,
    requestId: string,
    chainId?: string,
    sessionId?: string,
    threadId?: string,
  ): Promise<ProviderCompleteResponse> {
    this.#logRequest(requestId, profileId, request, true, chainId);

    try {
      const result = await this.#withRetries(
        () =>
          this.#catalog.completeProfileStream
            ? this.#catalog.completeProfileStream(profileId, request, observer)
            : this.#executeSingle(profileId, request, requestId, chainId, sessionId, threadId),
        requestId,
      );

      await this.#logResponse(requestId, result, chainId, sessionId, threadId);
      return result;
    } catch (error) {
      this.#logError(requestId, error, chainId);
      throw error;
    }
  }

  #prepareRequest(
    request: ProviderCompleteRequest,
    level: CompressionLevel,
  ): ProviderCompleteRequest {
    if (level === 'off') return request;

    const compressedMessages: ProviderChatMessage[] = request.messages.map((msg) => {
      if (!msg.content) return msg;

      if (msg.role === 'tool') {
        return {
          ...msg,
          content: compressToolOutput(msg.content ?? '', { level }),
        };
      }

      if (msg.role === 'user' || msg.role === 'assistant') {
        return {
          ...msg,
          content: condenseProse(msg.content, { level }),
        };
      }

      return msg;
    });

    return {
      ...request,
      messages: compressedMessages,
    };
  }

  async #runChain(
    chainId: string,
    request: ProviderCompleteRequest,
    requestId: string,
    runner: (profileId: string, req: ProviderCompleteRequest) => Promise<ProviderCompleteResponse>,
  ): Promise<ProviderCompleteResponse> {
    const chain = this.#catalog.listChains?.().find((c) => c.id === chainId);
    if (!chain) throw new Error(`Gateway: chain ${chainId} not found.`);

    let lastError: unknown = null;
    for (const entry of chain.entries) {
      try {
        const finalRequest = {
          ...request,
          model: entry.model ?? request.model,
        };
        return await runner(entry.profileId, finalRequest);
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError ?? new Error(`Chain ${chainId} failed with no results.`);
  }

  async #withRetries<T>(fn: () => Promise<T>, requestId: string, maxAttempts = 2): Promise<T> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        const status = getErrorStatus(error);
        const message = getErrorMessage(error);
        const name = getErrorName(error);
        const isRetryable =
          status === 429 ||
          (status !== null && status >= 500) ||
          name === 'AbortError' ||
          message.includes('fetch failed');
        if (!isRetryable || attempt === maxAttempts - 1) {
          throw error;
        }
        writeDebugEvent({
          component: 'provider',
          level: 'warn',
          message: 'llm request retryable failure',
          data: { requestId, attempt: attempt + 1, error: message },
        });
        await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
      }
    }
    throw lastError;
  }

  async #fallbackComplete(
    profileId: string,
    request: ProviderCompleteRequest,
  ): Promise<ProviderCompleteResponse> {
    const profiles = this.#catalog.listProfiles?.().profiles ?? [];
    const profile = profiles.find((entry) => entry.id === profileId);

    if (!profile) {
      throw new Error(`Gateway: profile ${profileId} not found.`);
    }

    throw new Error(
      `Gateway: provider catalog cannot complete profile "${profile.label}" because completeProfile() is not implemented.`,
    );
  }

  #logRequest(
    requestId: string,
    profileId: string,
    request: ProviderCompleteRequest,
    streaming = false,
    chainId?: string,
  ) {
    const assistantMsgsWithReasoning = request.messages.filter(
      (m) =>
        m.role === 'assistant' &&
        typeof m.reasoningContent === 'string' &&
        m.reasoningContent.length > 0,
    ).length;
    const assistantMsgsWithoutReasoning = request.messages.filter(
      (m) => m.role === 'assistant' && !m.reasoningContent,
    ).length;

    const thinkBudget = (request as ProviderCompleteRequest & { thinkBudget?: unknown }).thinkBudget;
    writeDebugEvent({
      component: 'provider',
      level: 'info',
      message: 'outgoing llm request',
      data: {
        requestId,
        profileId,
        ...(chainId ? { chainId } : {}),
        model: request.model,
        messages: request.messages.length,
        tools: request.tools?.length ?? 0,
        toolNames: request.tools?.map((t) => t.name) ?? [],
        streaming,
        assistantMsgsWithReasoning,
        assistantMsgsWithoutReasoning,
        thinkBudget: thinkBudget ?? null,
      },
    });
  }

  async #logResponse(
    requestId: string,
    response: ProviderCompleteResponse,
    chainId?: string,
    sessionId?: string,
    threadId?: string,
  ) {
    const profileId = response.providerProfileId;
    const model = response.model;
    const usage = response.usage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

    let costEstimate: number | undefined;
    let contextLimit: number | undefined;
    try {
      const capabilities = await this.#models.getModelCapabilities(model);
      if (capabilities.contextWindow) contextLimit = capabilities.contextWindow;
      if (capabilities.pricingPerMillion) {
        const p = capabilities.pricingPerMillion;
        const inp = usage.inputTokens ?? 0;
        const out = usage.outputTokens ?? 0;
        const reasoning = usage.reasoningTokens ?? 0;
        const cacheRead = usage.cacheReadTokens ?? 0;
        const cacheWrite = usage.cacheWriteTokens ?? 0;
        // Cache read defaults to 10% of input rate; cache write defaults to input rate
        const cacheReadPrice = p.cacheRead ?? p.input * 0.1;
        const cacheWritePrice = p.cacheWrite ?? p.input;
        costEstimate =
          (inp * p.input +
            out * p.output +
            reasoning * p.output +
            cacheRead * cacheReadPrice +
            cacheWrite * cacheWritePrice) /
          1_000_000;
      }
    } catch {
      // best effort
    }

    const actualInput = usage.inputTokens ?? 0;
    const actualOutput = usage.outputTokens ?? 0;
    const totalTokens = usage.totalTokens ?? actualInput + actualOutput;
    const isActual = actualInput > 0 || actualOutput > 0;

    const contextPercent =
      contextLimit && contextLimit > 0
        ? Math.round((totalTokens / contextLimit) * 1000) / 10
        : undefined;

    const route = `${profileId}/${model}`;

    getUsageLogger().log({
      timestamp: new Date().toISOString(),
      requestId,
      profileId,
      ...(chainId ? { chainId } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(threadId ? { threadId } : {}),
      model,
      route,
      inputTokens: actualInput,
      outputTokens: actualOutput,
      totalTokens,
      ...(usage.reasoningTokens !== undefined ? { reasoningTokens: usage.reasoningTokens } : {}),
      ...(usage.cacheReadTokens !== undefined ? { cacheReadTokens: usage.cacheReadTokens } : {}),
      ...(usage.cacheWriteTokens !== undefined ? { cacheWriteTokens: usage.cacheWriteTokens } : {}),
      ...(costEstimate !== undefined ? { costEstimate } : {}),
      ...(contextLimit !== undefined ? { contextLimit } : {}),
      ...(contextPercent !== undefined ? { contextPercent } : {}),
      source: isActual ? 'actual' : 'estimated',
      estimateSource: isActual ? 'actual' : 'estimate',
      status: 'success',
    });

    writeDebugEvent({
      component: 'provider',
      level: 'info',
      message: 'incoming llm response',
      data: {
        requestId,
        ...(chainId ? { chainId } : {}),
        model: response.model,
        stopReason: response.stopReason,
        tokens: usage,
      },
    });
  }

  #logError(requestId: string, error: unknown, chainId?: string) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    getUsageLogger().log({
      timestamp: new Date().toISOString(),
      requestId,
      profileId: 'unknown', // Profile might not be resolved yet in some error cases
      ...(chainId ? { chainId } : {}),
      model: 'unknown',
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      status: 'failed',
      error: errorMessage,
    });

    writeDebugEvent({
      component: 'provider',
      level: 'error',
      message: 'llm request failed',
      data: {
        requestId,
        ...(chainId ? { chainId } : {}),
        error: errorMessage,
      },
    });
  }
}

function getErrorStatus(error: unknown): number | null {
  if (typeof error !== 'object' || error === null || !('status' in error)) {
    return null;
  }

  return typeof error.status === 'number' ? error.status : null;
}

function getErrorName(error: unknown): string {
  if (error instanceof Error) {
    return error.name;
  }

  if (typeof error !== 'object' || error === null || !('name' in error)) {
    return '';
  }

  return typeof error.name === 'string' ? error.name : '';
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error !== 'object' || error === null || !('message' in error)) {
    return String(error);
  }

  return typeof error.message === 'string' ? error.message : String(error);
}
