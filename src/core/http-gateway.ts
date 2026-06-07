import { execFileSync } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { writeDebugEvent } from '../debug/runtime-debug.js';
import { getMemoryManager } from '../memory/index.js';
import { loadRuntimeSettings } from '../memory/settings-store.js';
import { getUsageLogger } from '../memory/usage-log.js';
import {
  DefaultProviderGateway,
  ModelsRegistry,
  getProviderCatalog,
  providerCompleteRequestSchema,
} from '../providers/index.js';
import type {
  ProviderChainCreateInput,
  ProviderChainUpdateInput,
} from '../providers/profile-types.js';
import {
  executeToolCall,
  getWebSearchSettings,
  listExternalToolStatuses,
  listToolDefinitions,
  parseToolCustomPathUpdate,
  parseToolExecuteRequest,
  setExternalToolCustomPath,
  updateWebSearchSettings,
  webSearchSettingsUpdateSchema,
} from '../tools/index.js';
import { AgentRuntime } from './agent-runtime.js';
import { getPermissionManager } from './permissions.js';
import type {
  DaemonStatus,
  MemorySettingsPayload,
  RunTaskRequest,
  SessionCompactionPayload,
  TaskPayload,
  ThreadCreatePayload,
  ThreadDetectPayload,
  ThreadForkPayload,
  ThreadImportPayload,
  ThreadListQuery,
  ThreadSettingsPayload,
} from './contracts.js';
import { resolveRunModeContract } from './mode-contracts.js';
import { getCompactSettings, getReviewSettings } from './runtime-preferences.js';
import { RunRegistry } from './run-registry.js';
import { TaskQueue } from './task-queue.js';

type GatewayOptions = {
  host: string;
  port: number;
};

export class HttpGateway {
  #server: http.Server;
  #queue = new TaskQueue();
  #startedAt = Date.now();
  #host: string;
  #port: number;
  #memory = getMemoryManager();
  #providers = getProviderCatalog();
  #models = new ModelsRegistry();
  #providerGateway = new DefaultProviderGateway({
    catalog: this.#providers,
    models: this.#models,
  });
  #runs = new RunRegistry(
    new AgentRuntime({
      memory: this.#memory,
      providers: this.#providers,
      gateway: this.#providerGateway,
      settingsLoader: () => loadRuntimeSettings(),
    }),
  );

  constructor(options: GatewayOptions) {
    this.#host = options.host;
    this.#port = options.port;
    this.#server = http.createServer((request, response) => {
      void this.#handleRequest(request, response);
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.#server.once('error', reject);
      this.#server.listen(this.#port, this.#host, () => {
        this.#server.off('error', reject);
        const address = this.#server.address();

        if (address && typeof address !== 'string') {
          this.#port = address.port;
        }

        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.#server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }

  get address(): AddressInfo | string | null {
    return this.#server.address();
  }

  async #handleRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    const method = request.method ?? 'GET';
    const url = request.url ?? '/';
    (
      response as http.ServerResponse & {
        __umbraDebugMeta?: { method: string; url: string; startedAt: number };
      }
    ).__umbraDebugMeta = {
      method,
      url,
      startedAt: Date.now(),
    };

    if (method === 'GET' && url === '/health') {
      this.#sendJson(response, 200, this.#createStatusPayload());
      return;
    }

    if (shouldLogDaemonRequest(method, url)) {
      writeDebugEvent({
        component: 'daemon',
        level: 'info',
        message: 'request received',
        data: { method, url },
      });
    }

    if (method === 'GET' && url.startsWith('/providers/types')) {
      this.#sendJson(response, 200, this.#providers.listTypes());
      return;
    }

    if (method === 'GET' && url === '/providers/profiles') {
      this.#sendJson(response, 200, this.#providers.listProfiles?.() ?? emptyProfilesPayload());
      return;
    }

    if (method === 'GET' && url === '/providers/default-models') {
      this.#sendJson(response, 200, this.#providers.getDefaults?.() ?? emptyDefaultsPayload());
      return;
    }

    if (method === 'GET' && url === '/tools') {
      this.#sendJson(response, 200, {
        presets: [
          { id: 'chat-readonly', description: 'Read-only chat surface.' },
          { id: 'agent-default', description: 'Read by default, write/exec require approval.' },
          { id: 'exec-full', description: 'Full write and execution surface.' },
        ],
        tools: listToolDefinitions(),
      });
      return;
    }

    if (method === 'GET' && url === '/tools/health') {
      this.#sendJson(response, 200, {
        tools: listExternalToolStatuses(),
      });
      return;
    }

    if (method === 'GET' && url === '/runs/contracts') {
      const settings = loadRuntimeSettings();
      const webSearch =
        settings.webSearch.mode === 'off'
          ? { enabled: false }
          : { enabled: true, mode: settings.webSearch.mode };
      this.#sendJson(response, 200, {
        modes: [
          resolveRunModeContract({ mode: 'plan', prompt: '', webSearch }),
          resolveRunModeContract({ mode: 'agent', prompt: '', webSearch }),
          resolveRunModeContract({ mode: 'exec', prompt: '', webSearch }),
        ].map((contract) => ({
          mode: contract.mode,
          title: contract.title,
          description: contract.description,
          toolPreset: contract.toolPreset,
          toolNames: contract.toolNames,
          allowToolExecution: contract.allowToolExecution,
          allowEdits: contract.allowEdits,
          allowShell: contract.allowShell,
          allowGit: contract.allowGit,
          confirmationPolicy: contract.confirmationPolicy,
          responseFormat: contract.responseFormat,
          timeBoxDefaultMs: contract.timeBoxDefaultMs,
        })),
      });
      return;
    }

    if (method === 'GET' && url === '/web/settings') {
      this.#sendJson(response, 200, getWebSearchSettings());
      return;
    }

    if (method === 'GET' && url === '/memory/settings') {
      this.#sendJson(response, 200, this.#memory.getMemorySettings());
      return;
    }

    if (method === 'GET' && url === '/runs') {
      this.#sendJson(response, 200, {
        runs: this.#runs.list(),
      });
      return;
    }

    if (method === 'GET' && url.startsWith('/providers/resolve')) {
      const requestUrl = new URL(url, 'http://127.0.0.1');
      const providerType = requestUrl.searchParams.get('type');

      if (!providerType) {
        this.#sendJson(response, 400, {
          error: 'Query parameter "type" is required.',
        });
        return;
      }

      this.#sendJson(response, 200, this.#providers.resolveType(providerType));
      return;
    }

    if (method === 'GET' && url.startsWith('/providers/profiles/')) {
      const requestUrl = new URL(url, 'http://127.0.0.1');
      const segments = requestUrl.pathname.split('/').filter(Boolean);
      const profileId = segments[2];
      const action = segments[3];

      if (!profileId) {
        this.#sendJson(response, 404, { error: 'Not found' });
        return;
      }

      if (action === 'models') {
        const modelId = requestUrl.searchParams.get('model');

        try {
          if (modelId) {
            const payload = await this.#providers.getProfileModelCapabilities?.(profileId, modelId);

            if (!payload) {
              this.#sendJson(response, 501, {
                error: 'Profile model capabilities are not available.',
              });
              return;
            }

            this.#sendJson(response, 200, payload);
            return;
          }

          const models = await this.#providers.listProfileModels?.(profileId);

          if (!models) {
            this.#sendJson(response, 501, { error: 'Profile model listing is not available.' });
            return;
          }

          this.#sendJson(response, 200, { models });
        } catch (error) {
          this.#sendJson(response, 400, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }
    }

    if (method === 'GET' && url === '/providers/models/catalog') {
      try {
        const dataset = await this.#models.getDataset();
        this.#sendJson(response, 200, { catalog: dataset });
      } catch (error) {
        this.#sendJson(response, 502, { error: 'Failed to fetch model catalog' });
      }
      return;
    }

    if (method === 'GET' && url.startsWith('/providers/models/capabilities')) {
      const requestUrl = new URL(url, 'http://127.0.0.1');
      const modelId = requestUrl.searchParams.get('model');

      if (!modelId) {
        this.#sendJson(response, 400, {
          error: 'Query parameter "model" is required.',
        });
        return;
      }

      try {
        const payload = await this.#providers.getModelCapabilities(modelId);
        this.#sendJson(response, 200, payload);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.#sendJson(response, 502, {
          error: 'Failed to resolve model capabilities.',
          details: message,
        });
      }
      return;
    }

    if (method === 'GET' && url === '/providers/chains') {
      this.#sendJson(response, 200, {
        chains: this.#providers.listChains?.() ?? [],
      });
      return;
    }

    if (method === 'POST' && url === '/providers/chains') {
      let requestBody: unknown;
      try {
        requestBody = await this.#readJsonBody(request);
      } catch {
        this.#sendJson(response, 400, { error: 'Request body must be valid JSON' });
        return;
      }
      try {
        const created = this.#providers.createChain?.(requestBody as ProviderChainCreateInput);
        if (!created) {
          this.#sendJson(response, 501, { error: 'Provider chain creation is not available.' });
          return;
        }
        writeDebugEvent({
          component: 'daemon',
          level: 'info',
          message: 'provider chain created',
          data: { chainId: created.id, label: created.label },
        });
        this.#sendJson(response, 201, created);
      } catch (error) {
        this.#sendJson(response, 400, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    if (method === 'PATCH' && url.startsWith('/providers/chains/')) {
      const chainId = url.split('/').pop();
      if (!chainId) {
        this.#sendJson(response, 400, { error: 'Chain ID is required' });
        return;
      }
      let requestBody: unknown;
      try {
        requestBody = await this.#readJsonBody(request);
      } catch {
        this.#sendJson(response, 400, { error: 'Request body must be valid JSON' });
        return;
      }
      try {
        const updated = this.#providers.updateChain?.(
          chainId,
          requestBody as ProviderChainUpdateInput,
        );
        if (!updated) {
          this.#sendJson(response, 501, { error: 'Provider chain update is not available.' });
          return;
        }
        writeDebugEvent({
          component: 'daemon',
          level: 'info',
          message: 'provider chain updated',
          data: { chainId: updated.id },
        });
        this.#sendJson(response, 200, updated);
      } catch (error) {
        this.#sendJson(response, 400, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    if (method === 'DELETE' && url.startsWith('/providers/chains/')) {
      const chainId = url.split('/').pop();
      if (!chainId) {
        this.#sendJson(response, 400, { error: 'Chain ID is required' });
        return;
      }
      try {
        const remaining = this.#providers.deleteChain?.(chainId);
        if (!remaining) {
          this.#sendJson(response, 501, { error: 'Provider chain deletion is not available.' });
          return;
        }
        writeDebugEvent({
          component: 'daemon',
          level: 'info',
          message: 'provider chain deleted',
          data: { chainId },
        });
        this.#sendJson(response, 200, { chains: remaining });
      } catch (error) {
        this.#sendJson(response, 400, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    if (method === 'POST' && url.startsWith('/providers/chains/')) {
      const chainId = url.split('/')[3];
      const action = url.split('/')[4];

      if (action === 'complete' && chainId) {
        let requestBody: unknown;
        try {
          requestBody = await this.#readJsonBody(request);
        } catch {
          this.#sendJson(response, 400, { error: 'Request body must be valid JSON' });
          return;
        }

        const parsed = providerCompleteRequestSchema.safeParse(requestBody);
        if (!parsed.success) {
          this.#sendJson(response, 400, {
            error: 'Invalid provider completion payload',
            issues: parsed.error.issues.map((issue) => issue.message),
          });
          return;
        }

        try {
          const result = await this.#providerGateway.complete({
            chainId,
            ...parsed.data,
          });
          this.#sendJson(response, 200, result);
        } catch (error) {
          this.#sendJson(response, 400, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }
    }

    if (method === 'GET' && url === '/usage/stats') {
      this.#sendJson(response, 200, getUsageLogger().getStats());
      return;
    }

    if (method === 'GET' && url === '/usage/last') {
      this.#sendJson(response, 200, getUsageLogger().getLastRecord() ?? null);
      return;
    }

    if (method === 'GET' && url === '/permissions/rules') {
      this.#sendJson(response, 200, {
        rules: this.#providers.listPermissionRules?.() ?? [],
      });
      return;
    }

    if (method === 'DELETE' && url.startsWith('/permissions/rules/')) {
      const ruleId = url.split('/').pop();
      if (!ruleId) {
        this.#sendJson(response, 400, { error: 'Rule ID is required' });
        return;
      }
      const success = this.#providers.deletePermissionRule?.(ruleId);
      this.#sendJson(response, 200, { success });
      return;
    }

    if (method === 'GET' && url === '/trust/paths') {
      const paths = getPermissionManager().trustManager.listTrustedPaths();
      this.#sendJson(response, 200, { paths });
      return;
    }

    if (method === 'DELETE' && url.startsWith('/trust/paths/')) {
      const encoded = url.slice('/trust/paths/'.length);
      if (!encoded) {
        this.#sendJson(response, 400, { error: 'Path is required' });
        return;
      }
      const targetPath = decodeURIComponent(encoded);
      getPermissionManager().trustManager.removeTrustedPath(targetPath);
      this.#sendJson(response, 200, { removed: targetPath });
      return;
    }

    if (method === 'POST' && url === '/providers/profiles') {
      let requestBody: unknown;

      try {
        requestBody = await this.#readJsonBody(request);
      } catch {
        this.#sendJson(response, 400, {
          error: 'Request body must be valid JSON',
        });
        return;
      }

      const parsedPayload = parseProviderProfileCreatePayload(requestBody);

      if (!parsedPayload.ok) {
        this.#sendJson(response, 400, {
          error: 'Invalid provider profile payload',
          issues: parsedPayload.issues,
        });
        return;
      }

      try {
        const created = this.#providers.createProfile?.(parsedPayload.data);

        if (!created) {
          this.#sendJson(response, 501, { error: 'Provider profile creation is not available.' });
          return;
        }

        writeDebugEvent({
          component: 'daemon',
          level: 'info',
          message: 'provider profile created',
          data: {
            profileId: created.id,
            type: created.type,
            status: created.status,
          },
        });
        this.#sendJson(response, 201, created);
      } catch (error) {
        this.#sendJson(response, 400, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    if (method === 'POST' && url.startsWith('/providers/profiles/')) {
      const requestUrl = new URL(url, 'http://127.0.0.1');
      const segments = requestUrl.pathname.split('/').filter(Boolean);
      const profileId = segments[2];
      const action = segments[3];

      if (action === 'test' && profileId) {
        try {
          const result = await this.#providers.testProfile?.(profileId);

          if (!result) {
            this.#sendJson(response, 501, { error: 'Provider profile testing is not available.' });
            return;
          }

          writeDebugEvent({
            component: 'daemon',
            level: 'info',
            message: 'provider profile tested',
            data: {
              profileId,
              ok: result.ok,
            },
          });
          this.#sendJson(response, 200, result);
        } catch (error) {
          this.#sendJson(response, 400, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }

      if (action === 'complete' && profileId) {
        let requestBody: unknown;

        try {
          requestBody = await this.#readJsonBody(request);
        } catch {
          this.#sendJson(response, 400, {
            error: 'Request body must be valid JSON',
          });
          return;
        }

        const parsed = providerCompleteRequestSchema.safeParse(requestBody);

        if (!parsed.success) {
          this.#sendJson(response, 400, {
            error: 'Invalid provider completion payload',
            issues: parsed.error.issues.map((issue) => issue.message),
          });
          return;
        }

        try {
          const result = await this.#providerGateway.complete({
            profileId,
            ...parsed.data,
          });

          if (!result) {
            this.#sendJson(response, 501, {
              error: 'Provider profile completion is not available.',
            });
            return;
          }

          writeDebugEvent({
            component: 'daemon',
            level: 'info',
            message: 'provider completion served',
            data: {
              profileId,
              providerType: result.providerType,
              model: result.model,
              stopReason: result.stopReason,
              toolCalls: result.toolCalls.length,
            },
          });
          this.#sendJson(response, 200, result);
        } catch (error) {
          this.#sendJson(response, 400, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }
    }

    if (method === 'POST' && url === '/tools/execute') {
      let requestBody: unknown;

      try {
        requestBody = await this.#readJsonBody(request);
      } catch {
        this.#sendJson(response, 400, {
          error: 'Request body must be valid JSON',
        });
        return;
      }

      const parsed = parseToolExecuteRequest(requestBody);

      if (!parsed.ok) {
        this.#sendJson(response, 400, {
          error: 'Invalid tool execution payload',
          issues: parsed.issues,
        });
        return;
      }

      const result = await executeToolCall(parsed.data);
      this.#sendJson(
        response,
        result.status === 'invalid' ? 400 : result.status === 'blocked' ? 409 : 200,
        result,
      );
      return;
    }

    if (method === 'PATCH' && url.startsWith('/providers/profiles/')) {
      const requestUrl = new URL(url, 'http://127.0.0.1');
      const profileId = requestUrl.pathname.split('/').filter(Boolean)[2];

      if (!profileId) {
        this.#sendJson(response, 404, { error: 'Not found' });
        return;
      }

      let requestBody: unknown;

      try {
        requestBody = await this.#readJsonBody(request);
      } catch {
        this.#sendJson(response, 400, {
          error: 'Request body must be valid JSON',
        });
        return;
      }

      const parsedPayload = parseProviderProfileUpdatePayload(requestBody);

      if (!parsedPayload.ok) {
        this.#sendJson(response, 400, {
          error: 'Invalid provider profile payload',
          issues: parsedPayload.issues,
        });
        return;
      }

      try {
        const updated = this.#providers.updateProfile?.(profileId, parsedPayload.data);

        if (!updated) {
          this.#sendJson(response, 501, { error: 'Provider profile updates are not available.' });
          return;
        }

        writeDebugEvent({
          component: 'daemon',
          level: 'info',
          message: 'provider profile updated',
          data: {
            profileId: updated.id,
            status: updated.status,
            model: updated.model,
          },
        });
        this.#sendJson(response, 200, updated);
      } catch (error) {
        this.#sendJson(response, 400, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    if (method === 'PATCH' && url.startsWith('/tools/health/')) {
      const requestUrl = new URL(url, 'http://127.0.0.1');
      const segments = requestUrl.pathname.split('/').filter(Boolean);
      const toolName = segments[2];
      const action = segments[3];

      if (!toolName || action !== 'custom-path') {
        this.#sendJson(response, 404, { error: 'Not found' });
        return;
      }

      let requestBody: unknown;

      try {
        requestBody = await this.#readJsonBody(request);
      } catch {
        this.#sendJson(response, 400, {
          error: 'Request body must be valid JSON',
        });
        return;
      }

      const parsed = parseToolCustomPathUpdate(requestBody);

      if (!parsed.ok) {
        this.#sendJson(response, 400, {
          error: 'Invalid tool custom path payload',
          issues: parsed.issues,
        });
        return;
      }

      try {
        if (toolName !== 'git' && toolName !== 'rg') {
          this.#sendJson(response, 404, { error: 'Unknown external tool.' });
          return;
        }

        const status = setExternalToolCustomPath(toolName, parsed.data.path);
        this.#sendJson(response, 200, status);
      } catch (error) {
        this.#sendJson(response, 400, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    if (method === 'DELETE' && url.startsWith('/providers/profiles/')) {
      const requestUrl = new URL(url, 'http://127.0.0.1');
      const profileId = requestUrl.pathname.split('/').filter(Boolean)[2];

      if (!profileId) {
        this.#sendJson(response, 404, { error: 'Not found' });
        return;
      }

      try {
        const payload = this.#providers.deleteProfile?.(profileId);

        if (!payload) {
          this.#sendJson(response, 501, { error: 'Provider profile deletion is not available.' });
          return;
        }

        writeDebugEvent({
          component: 'daemon',
          level: 'info',
          message: 'provider profile deleted',
          data: {
            profileId,
            remainingProfiles: payload.profiles.length,
          },
        });
        this.#sendJson(response, 200, payload);
      } catch (error) {
        this.#sendJson(response, 400, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    if (method === 'GET' && url.startsWith('/sessions')) {
      const requestUrl = new URL(url, 'http://127.0.0.1');
      const sessionId = requestUrl.pathname.split('/')[2];
      const projectPath = requestUrl.searchParams.get('projectPath') ?? undefined;

      if (sessionId) {
        this.#sendJson(response, 200, this.#memory.readSessionEvents(sessionId));
        return;
      }

      this.#sendJson(response, 200, this.#memory.listSessions(projectPath));
      return;
    }

    if (method === 'GET' && url.startsWith('/threads')) {
      const requestUrl = new URL(url, 'http://127.0.0.1');
      const segments = requestUrl.pathname.split('/').filter(Boolean);
      const threadId = segments[1];

      if (threadId) {
        const thread = this.#memory.getThread(
          threadId,
          requestUrl.searchParams.get('projectPath') ?? undefined,
        );

        if (!thread) {
          this.#sendJson(response, 404, { error: 'Thread was not found.' });
          return;
        }

        this.#sendJson(response, 200, thread);
        return;
      }

      const query: ThreadListQuery = {};
      const projectPath = requestUrl.searchParams.get('projectPath');
      const searchTerm = requestUrl.searchParams.get('searchTerm');
      const cursor = requestUrl.searchParams.get('cursor');
      const limit = requestUrl.searchParams.get('limit');
      const archived = requestUrl.searchParams.get('archived');

      if (projectPath) query.projectPath = projectPath;
      if (searchTerm) query.searchTerm = searchTerm;
      if (cursor) query.cursor = cursor;
      if (limit) query.limit = Number(limit);
      if (archived) query.archived = archived === 'true';
      this.#sendJson(response, 200, this.#memory.listThreads(query));
      return;
    }

    if (method === 'GET' && url.startsWith('/runs/')) {
      const requestUrl = new URL(url, 'http://127.0.0.1');
      const runId = requestUrl.pathname.split('/').filter(Boolean)[1];

      if (!runId) {
        this.#sendJson(response, 404, { error: 'Not found' });
        return;
      }

      const run = this.#runs.get(runId);

      if (!run) {
        this.#sendJson(response, 404, { error: 'Run was not found.' });
        return;
      }

      this.#sendJson(response, 200, run);
      return;
    }

    if (method === 'POST' && url.startsWith('/sessions/')) {
      const requestUrl = new URL(url, 'http://127.0.0.1');
      const segments = requestUrl.pathname.split('/').filter(Boolean);
      const sessionId = segments[1];
      const action = segments[2];

      if (action === 'compact' && sessionId) {
        let requestBody: unknown;

        try {
          requestBody = await this.#readJsonBody(request);
        } catch {
          this.#sendJson(response, 400, {
            error: 'Request body must be valid JSON',
          });
          return;
        }

        const parsedPayload = parseSessionCompactionPayload(requestBody);

        if (!parsedPayload.ok) {
          this.#sendJson(response, 400, {
            error: 'Invalid compaction payload',
            issues: parsedPayload.issues,
          });
          return;
        }

        try {
          let overrideSummary: string | undefined;
          const compactSettings = getCompactSettings();
          if (compactSettings.provider) {
            try {
              const events = this.#memory.readSessionEvents(sessionId);
              const transcript = events
                .filter((e) => e.type === 'user_message' || e.type === 'assistant_message' || e.type === 'tool_call_finished')
                .map((e) => {
                  const p = e.payload as Record<string, unknown>;
                  return `[${e.type}] ${JSON.stringify(p).slice(0, 400)}`;
                })
                .join('\n');
              const llmResult = await this.#providerGateway.complete({
                profileId: compactSettings.provider,
                ...(compactSettings.model ? { model: compactSettings.model } : {}),
                messages: [
                  {
                    role: 'user',
                    content: `Summarize the following AI assistant session into a concise context summary (max 500 words). Focus on: goals accomplished, key decisions made, files changed, errors resolved, and current state. Output only the summary text.\n\n${transcript}`,
                  },
                ],
              });
              if (llmResult.outputText) {
                overrideSummary = llmResult.outputText;
              }
            } catch (llmError) {
              writeDebugEvent({
                component: 'daemon',
                level: 'warn',
                message: 'LLM compaction failed, falling back to algorithmic',
                data: { error: llmError instanceof Error ? llmError.message : String(llmError) },
              });
            }
          }

          const compacted = this.#memory.compactSession({
            sessionId,
            ...(parsedPayload.data.projectPath
              ? { projectPath: parsedPayload.data.projectPath }
              : {}),
            ...(parsedPayload.data.instructions
              ? { instructions: parsedPayload.data.instructions }
              : {}),
            ...(overrideSummary ? { overrideSummary } : {}),
          });
          writeDebugEvent({
            component: 'daemon',
            level: 'info',
            message: 'session compacted',
            data: {
              sessionId,
              summarySource: overrideSummary ? 'llm' : 'algorithmic',
              oldTokens: compacted.oldTokens,
              newTokens: compacted.newTokens,
            },
          });
          this.#sendJson(response, 200, compacted);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.#sendJson(response, 404, { error: message });
        }
        return;
      }
    }

    if (method === 'POST' && url === '/memory/settings') {
      let requestBody: unknown;

      try {
        requestBody = await this.#readJsonBody(request);
      } catch {
        this.#sendJson(response, 400, {
          error: 'Request body must be valid JSON',
        });
        return;
      }

      const parsed = parseMemorySettingsPayload(requestBody);

      if (!parsed.ok) {
        this.#sendJson(response, 400, {
          error: 'Invalid memory settings payload',
          issues: parsed.issues,
        });
        return;
      }

      this.#sendJson(response, 200, this.#memory.updateMemorySettings(parsed.data));
      return;
    }

    if (method === 'POST' && url === '/web/settings') {
      let requestBody: unknown;

      try {
        requestBody = await this.#readJsonBody(request);
      } catch {
        this.#sendJson(response, 400, {
          error: 'Request body must be valid JSON',
        });
        return;
      }

      const parsed = webSearchSettingsUpdateSchema.safeParse(requestBody);
      if (!parsed.success) {
        this.#sendJson(response, 400, {
          error: 'Invalid web search settings payload',
          issues: parsed.error.issues.map((issue) => issue.message),
        });
        return;
      }

      try {
        const payload = {
          ...(parsed.data.mode ? { mode: parsed.data.mode } : {}),
          ...(parsed.data.providerId ? { providerId: parsed.data.providerId } : {}),
          ...(parsed.data.providerConfig
            ? {
                providerConfig: {
                  id: parsed.data.providerConfig.id,
                  ...(parsed.data.providerConfig.apiKey !== undefined
                    ? { apiKey: parsed.data.providerConfig.apiKey }
                    : {}),
                  ...(parsed.data.providerConfig.baseUrl !== undefined
                    ? { baseUrl: parsed.data.providerConfig.baseUrl }
                    : {}),
                },
              }
            : {}),
        };
        this.#sendJson(response, 200, updateWebSearchSettings(payload));
      } catch (error) {
        this.#sendJson(response, 400, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    if (method === 'POST' && url === '/memory/reset') {
      let requestBody: unknown;

      try {
        requestBody = await this.#readJsonBody(request);
      } catch {
        requestBody = {};
      }

      if (!isRecord(requestBody)) {
        this.#sendJson(response, 400, {
          error: 'Request body must be an object when provided.',
        });
        return;
      }

      try {
        this.#sendJson(
          response,
          200,
          this.#memory.resetMemories({
            ...(typeof requestBody.projectPath === 'string'
              ? { projectPath: requestBody.projectPath }
              : {}),
            ...(typeof requestBody.threadId === 'string' ? { threadId: requestBody.threadId } : {}),
          }),
        );
      } catch (error) {
        this.#sendJson(response, 400, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    if (method === 'POST' && url === '/review') {
      let requestBody: unknown;

      try {
        requestBody = await this.#readJsonBody(request);
      } catch {
        this.#sendJson(response, 400, { error: 'Request body must be valid JSON' });
        return;
      }

      if (!isRecord(requestBody) || typeof requestBody.projectPath !== 'string') {
        this.#sendJson(response, 400, { error: 'Missing required field: projectPath' });
        return;
      }

      const reviewProjectPath = requestBody.projectPath;
      const reviewTarget = typeof requestBody.target === 'string' ? requestBody.target : 'uncommitted';

      try {
        const diff = getGitDiffForReview(reviewProjectPath, reviewTarget);

        if (!diff.trim()) {
          this.#sendJson(response, 200, {
            findings: [],
            overall_correctness: 'patch is correct',
            overall_explanation: 'No changes to review.',
            overall_confidence_score: 1.0,
          });
          return;
        }

        const reviewSettings = getReviewSettings();
        const profileId = reviewSettings.provider
          ?? this.#providers.listProfiles?.()?.activeProfileId
          ?? null;

        if (!profileId) {
          this.#sendJson(response, 400, {
            error: 'No provider configured. Use /review settings or /provider connect first.',
          });
          return;
        }

        const systemPrompt = buildReviewSystemPrompt();
        const userMessage = `Here is the diff to review:\n\n\`\`\`diff\n${diff}\n\`\`\``;

        const llmResult = await this.#providerGateway.complete({
          profileId,
          ...(reviewSettings.model ? { model: reviewSettings.model } : {}),
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage },
          ],
          responseFormat: {
            type: 'json_schema',
            name: 'review_output',
            schema: REVIEW_OUTPUT_SCHEMA,
            strict: false,
          },
        });

        let result: unknown;
        if (llmResult.outputJson) {
          result = llmResult.outputJson;
        } else if (llmResult.outputText) {
          try {
            result = JSON.parse(llmResult.outputText);
          } catch {
            result = {
              findings: [],
              overall_correctness: 'patch is correct',
              overall_explanation: llmResult.outputText,
              overall_confidence_score: 0.5,
            };
          }
        } else {
          result = {
            findings: [],
            overall_correctness: 'patch is correct',
            overall_explanation: 'Reviewer did not produce a response.',
            overall_confidence_score: 0.0,
          };
        }

        this.#sendJson(response, 200, result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.#sendJson(response, 500, { error: message });
      }
      return;
    }

    if (method === 'POST' && url === '/threads') {
      let requestBody: unknown;

      try {
        requestBody = await this.#readJsonBody(request);
      } catch {
        requestBody = {};
      }

      const parsed = parseThreadCreatePayload(requestBody);

      if (!parsed.ok) {
        this.#sendJson(response, 400, {
          error: 'Invalid thread create payload',
          issues: parsed.issues,
        });
        return;
      }

      this.#sendJson(
        response,
        201,
        this.#memory.createThread({
          projectPath: parsed.data.projectPath ?? process.cwd(),
          ...(parsed.data.title ? { title: parsed.data.title } : {}),
          ...(typeof parsed.data.useMemories === 'boolean'
            ? { useMemories: parsed.data.useMemories }
            : {}),
          ...(typeof parsed.data.generateMemories === 'boolean'
            ? { generateMemories: parsed.data.generateMemories }
            : {}),
        }),
      );
      return;
    }

    if (method === 'POST' && url === '/threads/detect') {
      let requestBody: unknown;

      try {
        requestBody = await this.#readJsonBody(request);
      } catch {
        requestBody = {};
      }

      const parsed = parseThreadDetectPayload(requestBody);

      if (!parsed.ok) {
        this.#sendJson(response, 400, {
          error: 'Invalid thread detect payload',
          issues: parsed.issues,
        });
        return;
      }

      this.#sendJson(response, 200, {
        candidates: this.#memory.detectImportableSessions(parsed.data),
      });
      return;
    }

    if (method === 'POST' && url === '/threads/import') {
      let requestBody: unknown;

      try {
        requestBody = await this.#readJsonBody(request);
      } catch {
        this.#sendJson(response, 400, {
          error: 'Request body must be valid JSON',
        });
        return;
      }

      const parsed = parseThreadImportPayload(requestBody);

      if (!parsed.ok) {
        this.#sendJson(response, 400, {
          error: 'Invalid thread import payload',
          issues: parsed.issues,
        });
        return;
      }

      try {
        this.#sendJson(response, 201, this.#memory.importThread(parsed.data));
      } catch (error) {
        this.#sendJson(response, 400, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    if (method === 'POST' && url.startsWith('/threads/')) {
      const requestUrl = new URL(url, 'http://127.0.0.1');
      const segments = requestUrl.pathname.split('/').filter(Boolean);
      const threadId = segments[1];
      const action = segments[2];

      if (!threadId || !action) {
        this.#sendJson(response, 404, { error: 'Not found' });
        return;
      }

      if (action === 'archive' || action === 'unarchive') {
        try {
          this.#sendJson(response, 200, this.#memory.archiveThread(threadId, action === 'archive'));
        } catch (error) {
          this.#sendJson(response, 404, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }

      if (action === 'resume') {
        try {
          let requestBody: unknown;

          try {
            requestBody = await this.#readJsonBody(request);
          } catch {
            requestBody = {};
          }

          const projectPath =
            isRecord(requestBody) && typeof requestBody.projectPath === 'string'
              ? requestBody.projectPath
              : undefined;
          const thread = this.#memory.getThread(threadId, projectPath);

          if (!thread) {
            this.#sendJson(response, 404, { error: 'Thread was not found.' });
            return;
          }

          this.#sendJson(response, 200, thread);
        } catch (error) {
          this.#sendJson(response, 404, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }

      if (action === 'settings') {
        let requestBody: unknown;

        try {
          requestBody = await this.#readJsonBody(request);
        } catch {
          this.#sendJson(response, 400, {
            error: 'Request body must be valid JSON',
          });
          return;
        }

        const parsed = parseThreadSettingsPayload(requestBody);

        if (!parsed.ok) {
          this.#sendJson(response, 400, {
            error: 'Invalid thread settings payload',
            issues: parsed.issues,
          });
          return;
        }

        try {
          this.#sendJson(
            response,
            200,
            this.#memory.updateThreadSettings({
              threadId,
              ...(parsed.data.projectPath ? { projectPath: parsed.data.projectPath } : {}),
              ...(typeof parsed.data.useMemories === 'boolean'
                ? { useMemories: parsed.data.useMemories }
                : {}),
              ...(typeof parsed.data.generateMemories === 'boolean'
                ? { generateMemories: parsed.data.generateMemories }
                : {}),
            }),
          );
        } catch (error) {
          this.#sendJson(response, 404, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }

      if (action === 'fork') {
        let requestBody: unknown;

        try {
          requestBody = await this.#readJsonBody(request);
        } catch {
          requestBody = {};
        }

        const parsed = parseThreadForkPayload(requestBody);

        if (!parsed.ok) {
          this.#sendJson(response, 400, {
            error: 'Invalid thread fork payload',
            issues: parsed.issues,
          });
          return;
        }

        try {
          this.#sendJson(response, 201, this.#memory.forkThread(threadId, parsed.data));
        } catch (error) {
          this.#sendJson(response, 404, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }

      if (action === 'export') {
        try {
          this.#sendJson(response, 200, this.#memory.exportThread(threadId));
        } catch (error) {
          this.#sendJson(response, 404, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }
    }

    if (method === 'POST' && url === '/runs') {
      let requestBody: unknown;

      try {
        requestBody = await this.#readJsonBody(request);
      } catch {
        this.#sendJson(response, 400, {
          error: 'Request body must be valid JSON',
        });
        return;
      }

      const parsedPayload = parseRunTaskPayload(requestBody);

      if (!parsedPayload.ok) {
        this.#sendJson(response, 400, {
          error: 'Invalid run payload',
          issues: parsedPayload.issues,
        });
        return;
      }

      const run = this.#runs.create(parsedPayload.data);
      await this.#runs.start(run.id);
      this.#sendJson(response, 202, this.#runs.get(run.id));
      return;
    }

    if (method === 'POST' && url.startsWith('/runs/')) {
      const requestUrl = new URL(url, 'http://127.0.0.1');
      const segments = requestUrl.pathname.split('/').filter(Boolean);
      const runId = segments[1];
      const action = segments[2];

      if (!runId || (action !== 'stop' && action !== 'restart' && action !== 'approve')) {
        this.#sendJson(response, 404, { error: 'Not found' });
        return;
      }

      try {
        if (action === 'stop') {
          this.#sendJson(response, 200, this.#runs.stop(runId));
          return;
        }

        if (action === 'approve') {
          let body: unknown;
          try {
            body = await this.#readJsonBody(request);
          } catch {
            this.#sendJson(response, 400, { error: 'Request body must be valid JSON' });
            return;
          }
          const approvalId =
            body && typeof body === 'object' && 'approvalId' in body
              ? String((body as Record<string, unknown>).approvalId)
              : '';
          const outcome =
            body && typeof body === 'object' && 'outcome' in body
              ? String((body as Record<string, unknown>).outcome)
              : '';
          if (
            !approvalId ||
            (outcome !== 'allow' && outcome !== 'deny' && outcome !== 'allow_always')
          ) {
            this.#sendJson(response, 400, {
              error: 'approvalId and outcome (allow|deny|allow_always) required',
            });
            return;
          }
          const resolved = this.#runs.resolveApproval(
            approvalId,
            outcome as 'allow' | 'deny' | 'allow_always',
          );
          this.#sendJson(response, 200, { ok: resolved });
          return;
        }

        this.#sendJson(response, 200, await this.#runs.restart(runId));
      } catch (error) {
        this.#sendJson(response, 400, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    if (method === 'POST' && url === '/tasks') {
      let requestBody: unknown;

      try {
        requestBody = await this.#readJsonBody(request);
      } catch {
        this.#sendJson(response, 400, {
          error: 'Request body must be valid JSON',
        });
        return;
      }

      const parsedPayload = parseTaskPayload(requestBody);

      if (!parsedPayload.ok) {
        this.#sendJson(response, 400, {
          error: 'Invalid task payload',
          issues: parsedPayload.issues,
        });
        return;
      }

      const memoryContext = await this.#memory.registerTask(parsedPayload.data);
      const taskRecord = this.#queue.enqueue(parsedPayload.data);
      taskRecord.projectPath = memoryContext.projectPath;
      taskRecord.sessionId = memoryContext.sessionId;
      if (
        parsedPayload.data.context &&
        typeof parsedPayload.data.context.projectPath === 'string' &&
        parsedPayload.data.context.projectPath.trim().length > 0
      ) {
        taskRecord.contextSummary = await this.#memory.buildContextSummary({
          projectPath: memoryContext.projectPath,
          task: parsedPayload.data.task,
          sessionId: memoryContext.sessionId,
        });
      }
      writeDebugEvent({
        component: 'daemon',
        level: 'info',
        message: 'task accepted',
        data: {
          taskId: taskRecord.id,
          sessionId: taskRecord.sessionId,
          projectPath: taskRecord.projectPath,
        },
      });
      this.#sendJson(response, 202, taskRecord);
      return;
    }

    this.#sendJson(response, 404, { error: 'Not found' });
  }

  #createStatusPayload(): DaemonStatus {
    const providerProfiles = this.#providers.listProfiles?.() ?? emptyProfilesPayload();
    const activeProfile =
      providerProfiles.profiles.find(
        (profile) => profile.id === providerProfiles.activeProfileId,
      ) ?? null;
    const webSettings = getWebSearchSettings();

    const lastUsageRec = getUsageLogger().getLastRecord();
    const lastRequestUsage = lastUsageRec
      ? {
          inputTokens: lastUsageRec.inputTokens,
          outputTokens: lastUsageRec.outputTokens,
          totalTokens: lastUsageRec.totalTokens,
          ...(lastUsageRec.reasoningTokens !== undefined
            ? { reasoningTokens: lastUsageRec.reasoningTokens }
            : {}),
          ...(lastUsageRec.cacheReadTokens !== undefined
            ? { cacheReadTokens: lastUsageRec.cacheReadTokens }
            : {}),
          ...(lastUsageRec.cacheWriteTokens !== undefined
            ? { cacheWriteTokens: lastUsageRec.cacheWriteTokens }
            : {}),
          ...(lastUsageRec.costEstimate !== undefined
            ? { costEstimate: lastUsageRec.costEstimate }
            : {}),
          ...(lastUsageRec.contextLimit !== undefined
            ? { contextLimit: lastUsageRec.contextLimit }
            : {}),
          ...(lastUsageRec.contextPercent !== undefined
            ? { contextPercent: lastUsageRec.contextPercent }
            : {}),
          ...(lastUsageRec.route !== undefined ? { route: lastUsageRec.route } : {}),
          ...(lastUsageRec.source !== undefined ? { source: lastUsageRec.source } : {}),
        }
      : undefined;

    return {
      ok: true,
      host: this.#host,
      port: this.#port,
      queueDepth: this.#queue.size(),
      uptimeSeconds: Math.floor((Date.now() - this.#startedAt) / 1000),
      ...(lastRequestUsage !== undefined ? { lastRequestUsage } : {}),
      activeProvider: {
        id: activeProfile?.id ?? null,
        label: activeProfile?.label ?? null,
        model: activeProfile?.model ?? null,
      },
      webSearch: {
        mode: webSettings.mode,
        providerId: webSettings.providerId,
        configured: webSettings.configured,
      },
      memory: this.#memory.getStatus(),
    };
  }

  async #readJsonBody(request: http.IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];

    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    if (chunks.length === 0) {
      return {};
    }

    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  }

  #sendJson(response: http.ServerResponse, statusCode: number, payload: unknown): void {
    const debugMeta = (
      response as http.ServerResponse & {
        __umbraDebugMeta?: { method: string; url: string; startedAt: number };
      }
    ).__umbraDebugMeta;

    if (statusCode >= 400) {
      writeDebugEvent({
        component: 'daemon',
        level: 'warn',
        message: 'http error response',
        data: { statusCode, payload },
      });
    }

    if (debugMeta && shouldLogDaemonRequest(debugMeta.method, debugMeta.url)) {
      writeDebugEvent({
        component: 'daemon',
        level: statusCode >= 400 ? 'warn' : 'info',
        message: 'request completed',
        data: {
          method: debugMeta.method,
          url: debugMeta.url,
          statusCode,
          durationMs: Date.now() - debugMeta.startedAt,
        },
      });
    }

    response.writeHead(statusCode, {
      'content-type': 'application/json; charset=utf-8',
    });
    response.end(JSON.stringify(payload, null, 2));
  }
}

export function shouldLogDaemonRequest(method: string, url: string): boolean {
  const pathname = url.split('?')[0] ?? url;

  if (pathname === '/health') {
    return false;
  }

  if (method === 'GET' && pathname === '/usage/stats') {
    return false;
  }

  if (method === 'GET' && pathname === '/usage/last') {
    return false;
  }

  if (method === 'GET' && pathname === '/runs/contracts') {
    return true;
  }

  if (method === 'GET' && /^\/runs\/[^/]+$/.test(pathname)) {
    return false;
  }

  return true;
}

function parseTaskPayload(
  value: unknown,
): { ok: true; data: TaskPayload } | { ok: false; issues: string[] } {
  if (!isRecord(value)) {
    return { ok: false, issues: ['Payload must be a JSON object.'] };
  }

  if (typeof value.task !== 'string' || value.task.trim().length === 0) {
    return { ok: false, issues: ['Payload field "task" must be a non-empty string.'] };
  }

  if (value.context !== undefined && !isRecord(value.context)) {
    return { ok: false, issues: ['Payload field "context" must be an object when provided.'] };
  }

  return {
    ok: true,
    data: buildTaskPayload(value.task.trim(), value.context),
  };
}

function parseSessionCompactionPayload(value: unknown):
  | {
      ok: true;
      data: SessionCompactionPayload;
    }
  | { ok: false; issues: string[] } {
  if (value === undefined || value === null) {
    return {
      ok: true,
      data: {},
    };
  }

  if (!isRecord(value)) {
    return {
      ok: false,
      issues: ['Payload must be a JSON object when provided.'],
    };
  }

  if (value.projectPath !== undefined && typeof value.projectPath !== 'string') {
    return {
      ok: false,
      issues: ['Payload field "projectPath" must be a string when provided.'],
    };
  }

  if (value.instructions !== undefined && typeof value.instructions !== 'string') {
    return {
      ok: false,
      issues: ['Payload field "instructions" must be a string when provided.'],
    };
  }

  return {
    ok: true,
    data: {
      ...(typeof value.projectPath === 'string' ? { projectPath: value.projectPath } : {}),
      ...(typeof value.instructions === 'string' ? { instructions: value.instructions } : {}),
    },
  };
}

function parseRunTaskPayload(
  value: unknown,
): { ok: true; data: RunTaskRequest } | { ok: false; issues: string[] } {
  if (!isRecord(value)) {
    return { ok: false, issues: ['Payload must be a JSON object.'] };
  }

  const prompt = value.prompt;
  const mode = value.mode;
  const issues: string[] = [];

  if (typeof prompt !== 'string' || prompt.trim().length === 0) {
    issues.push('Payload field "prompt" must be a non-empty string.');
  }

  if (mode !== 'plan' && mode !== 'agent' && mode !== 'exec' && mode !== 'full') {
    issues.push('Payload field "mode" must be one of: plan, agent, full, exec.');
  }

  if (value.projectPath !== undefined && typeof value.projectPath !== 'string') {
    issues.push('Payload field "projectPath" must be a string when provided.');
  }

  if (value.sessionId !== undefined && typeof value.sessionId !== 'string') {
    issues.push('Payload field "sessionId" must be a string when provided.');
  }

  if (value.threadId !== undefined && typeof value.threadId !== 'string') {
    issues.push('Payload field "threadId" must be a string when provided.');
  }

  if (value.providerProfileId !== undefined && typeof value.providerProfileId !== 'string') {
    issues.push('Payload field "providerProfileId" must be a string when provided.');
  }

  if (value.model !== undefined && typeof value.model !== 'string') {
    issues.push('Payload field "model" must be a string when provided.');
  }

  if (
    value.timeLimitMs !== undefined &&
    (!Number.isInteger(value.timeLimitMs) || Number(value.timeLimitMs) <= 0)
  ) {
    issues.push('Payload field "timeLimitMs" must be a positive integer when provided.');
  }

  if (value.background !== undefined && typeof value.background !== 'boolean') {
    issues.push('Payload field "background" must be a boolean when provided.');
  }

  if (value.useMemories !== undefined && typeof value.useMemories !== 'boolean') {
    issues.push('Payload field "useMemories" must be a boolean when provided.');
  }

  if (value.generateMemories !== undefined && typeof value.generateMemories !== 'boolean') {
    issues.push('Payload field "generateMemories" must be a boolean when provided.');
  }

  const VALID_THINK_BUDGETS = new Set(['low', 'medium', 'high', 'max']);
  if (
    value.thinkBudget !== undefined &&
    value.thinkBudget !== null &&
    !(typeof value.thinkBudget === 'string' && VALID_THINK_BUDGETS.has(value.thinkBudget)) &&
    !(typeof value.thinkBudget === 'number' && Number.isInteger(value.thinkBudget) && value.thinkBudget > 0)
  ) {
    issues.push('Payload field "thinkBudget" must be null, a positive integer, or one of: low, medium, high, max.');
  }

  if (value.goalContext !== undefined && value.goalContext !== null && typeof value.goalContext !== 'string') {
    issues.push('Payload field "goalContext" must be a string or null when provided.');
  }

  if (value.gitEnabled !== undefined && typeof value.gitEnabled !== 'boolean') {
    issues.push('Payload field "gitEnabled" must be a boolean when provided.');
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  const normalizedPrompt = prompt as string;
  const normalizedMode = mode as RunTaskRequest['mode'];

  return {
    ok: true,
    data: {
      prompt: normalizedPrompt.trim(),
      mode: normalizedMode,
      ...(typeof value.projectPath === 'string' ? { projectPath: value.projectPath } : {}),
      ...(typeof value.threadId === 'string' ? { threadId: value.threadId } : {}),
      ...(typeof value.sessionId === 'string' ? { sessionId: value.sessionId } : {}),
      ...(typeof value.providerProfileId === 'string'
        ? { providerProfileId: value.providerProfileId }
        : {}),
      ...(typeof value.model === 'string' ? { model: value.model } : {}),
      ...(typeof value.timeLimitMs === 'number' ? { timeLimitMs: value.timeLimitMs } : {}),
      ...(typeof value.background === 'boolean' ? { background: value.background } : {}),
      ...(typeof value.useMemories === 'boolean' ? { useMemories: value.useMemories } : {}),
      ...(typeof value.generateMemories === 'boolean'
        ? { generateMemories: value.generateMemories }
        : {}),
      ...(value.thinkBudget !== undefined
        ? { thinkBudget: value.thinkBudget as number | 'low' | 'medium' | 'high' | 'max' | null }
        : {}),
      ...(typeof value.goalContext === 'string' ? { goalContext: value.goalContext } : {}),
      ...(typeof value.gitEnabled === 'boolean' ? { gitEnabled: value.gitEnabled } : {}),
    },
  };
}

function parseMemorySettingsPayload(
  value: unknown,
): { ok: true; data: Partial<MemorySettingsPayload> } | { ok: false; issues: string[] } {
  if (!isRecord(value)) {
    return { ok: false, issues: ['Payload must be a JSON object.'] };
  }

  const issues: string[] = [];

  if (value.useMemories !== undefined && typeof value.useMemories !== 'boolean') {
    issues.push('Payload field "useMemories" must be a boolean when provided.');
  }

  if (value.generateMemories !== undefined && typeof value.generateMemories !== 'boolean') {
    issues.push('Payload field "generateMemories" must be a boolean when provided.');
  }

  if (value.draftPersistence !== undefined && typeof value.draftPersistence !== 'boolean') {
    issues.push('Payload field "draftPersistence" must be a boolean when provided.');
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  return {
    ok: true,
    data: {
      ...(typeof value.useMemories === 'boolean' ? { useMemories: value.useMemories } : {}),
      ...(typeof value.generateMemories === 'boolean'
        ? { generateMemories: value.generateMemories }
        : {}),
      ...(typeof value.draftPersistence === 'boolean'
        ? { draftPersistence: value.draftPersistence }
        : {}),
    },
  };
}

function parseThreadCreatePayload(
  value: unknown,
): { ok: true; data: ThreadCreatePayload } | { ok: false; issues: string[] } {
  if (value === undefined || value === null) {
    return { ok: true, data: {} };
  }

  if (!isRecord(value)) {
    return { ok: false, issues: ['Payload must be a JSON object when provided.'] };
  }

  const issues: string[] = [];

  if (value.projectPath !== undefined && typeof value.projectPath !== 'string') {
    issues.push('Payload field "projectPath" must be a string when provided.');
  }

  if (value.title !== undefined && typeof value.title !== 'string') {
    issues.push('Payload field "title" must be a string when provided.');
  }

  if (value.useMemories !== undefined && typeof value.useMemories !== 'boolean') {
    issues.push('Payload field "useMemories" must be a boolean when provided.');
  }

  if (value.generateMemories !== undefined && typeof value.generateMemories !== 'boolean') {
    issues.push('Payload field "generateMemories" must be a boolean when provided.');
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  return {
    ok: true,
    data: {
      ...(typeof value.projectPath === 'string' ? { projectPath: value.projectPath } : {}),
      ...(typeof value.title === 'string' ? { title: value.title } : {}),
      ...(typeof value.useMemories === 'boolean' ? { useMemories: value.useMemories } : {}),
      ...(typeof value.generateMemories === 'boolean'
        ? { generateMemories: value.generateMemories }
        : {}),
    },
  };
}

function parseThreadForkPayload(
  value: unknown,
): { ok: true; data: ThreadForkPayload } | { ok: false; issues: string[] } {
  if (value === undefined || value === null) {
    return { ok: true, data: {} };
  }

  if (!isRecord(value)) {
    return { ok: false, issues: ['Payload must be a JSON object when provided.'] };
  }

  const issues: string[] = [];

  if (value.projectPath !== undefined && typeof value.projectPath !== 'string') {
    issues.push('Payload field "projectPath" must be a string when provided.');
  }

  if (value.title !== undefined && typeof value.title !== 'string') {
    issues.push('Payload field "title" must be a string when provided.');
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  return {
    ok: true,
    data: {
      ...(typeof value.projectPath === 'string' ? { projectPath: value.projectPath } : {}),
      ...(typeof value.title === 'string' ? { title: value.title } : {}),
    },
  };
}

function parseThreadSettingsPayload(
  value: unknown,
): { ok: true; data: ThreadSettingsPayload } | { ok: false; issues: string[] } {
  if (value === undefined || value === null) {
    return { ok: true, data: {} };
  }

  if (!isRecord(value)) {
    return { ok: false, issues: ['Payload must be a JSON object when provided.'] };
  }

  const issues: string[] = [];

  if (value.projectPath !== undefined && typeof value.projectPath !== 'string') {
    issues.push('Payload field "projectPath" must be a string when provided.');
  }

  if (value.useMemories !== undefined && typeof value.useMemories !== 'boolean') {
    issues.push('Payload field "useMemories" must be a boolean when provided.');
  }

  if (value.generateMemories !== undefined && typeof value.generateMemories !== 'boolean') {
    issues.push('Payload field "generateMemories" must be a boolean when provided.');
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  return {
    ok: true,
    data: {
      ...(typeof value.projectPath === 'string' ? { projectPath: value.projectPath } : {}),
      ...(typeof value.useMemories === 'boolean' ? { useMemories: value.useMemories } : {}),
      ...(typeof value.generateMemories === 'boolean'
        ? { generateMemories: value.generateMemories }
        : {}),
    },
  };
}

function parseThreadDetectPayload(
  value: unknown,
): { ok: true; data: ThreadDetectPayload } | { ok: false; issues: string[] } {
  if (value === undefined || value === null) {
    return { ok: true, data: {} };
  }

  if (!isRecord(value)) {
    return { ok: false, issues: ['Payload must be a JSON object when provided.'] };
  }

  if (
    value.paths !== undefined &&
    (!Array.isArray(value.paths) || !value.paths.every((entry) => typeof entry === 'string'))
  ) {
    return { ok: false, issues: ['Payload field "paths" must be an array of strings.'] };
  }

  return {
    ok: true,
    data: {
      ...(Array.isArray(value.paths) ? { paths: value.paths as string[] } : {}),
    },
  };
}

function parseThreadImportPayload(
  value: unknown,
): { ok: true; data: ThreadImportPayload } | { ok: false; issues: string[] } {
  if (!isRecord(value)) {
    return { ok: false, issues: ['Payload must be a JSON object.'] };
  }

  const issues: string[] = [];

  if (typeof value.filePath !== 'string' || value.filePath.trim().length === 0) {
    issues.push('Payload field "filePath" must be a non-empty string.');
  }

  if (value.projectPath !== undefined && typeof value.projectPath !== 'string') {
    issues.push('Payload field "projectPath" must be a string when provided.');
  }

  if (value.title !== undefined && typeof value.title !== 'string') {
    issues.push('Payload field "title" must be a string when provided.');
  }

  if (value.archived !== undefined && typeof value.archived !== 'boolean') {
    issues.push('Payload field "archived" must be a boolean when provided.');
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  return {
    ok: true,
    data: {
      filePath: (value.filePath as string).trim(),
      ...(typeof value.projectPath === 'string' ? { projectPath: value.projectPath } : {}),
      ...(typeof value.title === 'string' ? { title: value.title } : {}),
      ...(typeof value.archived === 'boolean' ? { archived: value.archived } : {}),
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function buildTaskPayload(task: string, context: unknown): TaskPayload {
  const payload: TaskPayload = { task };

  if (context && isRecord(context)) {
    payload.context = context;
  }

  return payload;
}

function parseProviderProfileCreatePayload(value: unknown):
  | {
      ok: true;
      data: {
        type: string;
        label: string;
        baseUrl?: string;
        apiKey?: string;
        model?: string | null;
        enabled?: boolean;
        extraHeaders?: Record<string, string>;
        options?: Record<string, unknown>;
        makeDefault?: boolean;
      };
    }
  | { ok: false; issues: string[] } {
  if (!isRecord(value)) {
    return { ok: false, issues: ['Payload must be a JSON object.'] };
  }

  const issues: string[] = [];

  if (!('type' in value) || typeof value.type !== 'string' || value.type.trim().length === 0) {
    issues.push('Payload field "type" must be a non-empty string.');
  }

  if (!('label' in value) || typeof value.label !== 'string' || value.label.trim().length === 0) {
    issues.push('Payload field "label" must be a non-empty string.');
  }

  if (value.type !== undefined && typeof value.type !== 'string') {
    issues.push('Payload field "type" must be a string when provided.');
  }

  if (value.label !== undefined && typeof value.label !== 'string') {
    issues.push('Payload field "label" must be a string when provided.');
  }

  if (value.baseUrl !== undefined && typeof value.baseUrl !== 'string') {
    issues.push('Payload field "baseUrl" must be a string when provided.');
  }

  if (value.apiKey !== undefined && typeof value.apiKey !== 'string') {
    issues.push('Payload field "apiKey" must be a string when provided.');
  }

  if (value.model !== undefined && value.model !== null && typeof value.model !== 'string') {
    issues.push('Payload field "model" must be a string or null when provided.');
  }

  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') {
    issues.push('Payload field "enabled" must be a boolean when provided.');
  }

  if (value.makeDefault !== undefined && typeof value.makeDefault !== 'boolean') {
    issues.push('Payload field "makeDefault" must be a boolean when provided.');
  }

  if (value.extraHeaders !== undefined && !isStringRecord(value.extraHeaders)) {
    issues.push('Payload field "extraHeaders" must be an object with string values.');
  }

  if (value.options !== undefined && !isRecord(value.options)) {
    issues.push('Payload field "options" must be an object when provided.');
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  const type = value.type;
  const label = value.label;

  if (typeof type !== 'string' || typeof label !== 'string') {
    return { ok: false, issues: ['Payload fields "type" and "label" must be strings.'] };
  }

  return {
    ok: true,
    data: {
      type: type.trim(),
      label: label.trim(),
      ...(typeof value.baseUrl === 'string' ? { baseUrl: value.baseUrl } : {}),
      ...(typeof value.apiKey === 'string' ? { apiKey: value.apiKey } : {}),
      ...('model' in value && (value.model === null || typeof value.model === 'string')
        ? { model: value.model }
        : {}),
      ...(typeof value.enabled === 'boolean' ? { enabled: value.enabled } : {}),
      ...(isStringRecord(value.extraHeaders) ? { extraHeaders: value.extraHeaders } : {}),
      ...(isRecord(value.options) ? { options: value.options } : {}),
      ...(typeof value.makeDefault === 'boolean' ? { makeDefault: value.makeDefault } : {}),
    },
  };
}

function parseProviderProfileUpdatePayload(value: unknown):
  | {
      ok: true;
      data: {
        type?: string;
        label?: string;
        baseUrl?: string;
        apiKey?: string;
        model?: string | null;
        enabled?: boolean;
        extraHeaders?: Record<string, string>;
        options?: Record<string, unknown>;
        makeDefault?: boolean;
      };
    }
  | { ok: false; issues: string[] } {
  if (!isRecord(value)) {
    return { ok: false, issues: ['Payload must be a JSON object.'] };
  }

  const issues: string[] = [];

  if (value.type !== undefined && typeof value.type !== 'string') {
    issues.push('Payload field "type" must be a string when provided.');
  }

  if (value.label !== undefined && typeof value.label !== 'string') {
    issues.push('Payload field "label" must be a string when provided.');
  }

  if (value.baseUrl !== undefined && typeof value.baseUrl !== 'string') {
    issues.push('Payload field "baseUrl" must be a string when provided.');
  }

  if (value.apiKey !== undefined && typeof value.apiKey !== 'string') {
    issues.push('Payload field "apiKey" must be a string when provided.');
  }

  if (value.model !== undefined && value.model !== null && typeof value.model !== 'string') {
    issues.push('Payload field "model" must be a string or null when provided.');
  }

  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') {
    issues.push('Payload field "enabled" must be a boolean when provided.');
  }

  if (value.makeDefault !== undefined && typeof value.makeDefault !== 'boolean') {
    issues.push('Payload field "makeDefault" must be a boolean when provided.');
  }

  if (value.extraHeaders !== undefined && !isStringRecord(value.extraHeaders)) {
    issues.push('Payload field "extraHeaders" must be an object with string values.');
  }

  if (value.options !== undefined && !isRecord(value.options)) {
    issues.push('Payload field "options" must be an object when provided.');
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  return {
    ok: true,
    data: {
      ...(typeof value.type === 'string' ? { type: value.type.trim() } : {}),
      ...(typeof value.label === 'string' ? { label: value.label.trim() } : {}),
      ...(typeof value.baseUrl === 'string' ? { baseUrl: value.baseUrl } : {}),
      ...(typeof value.apiKey === 'string' ? { apiKey: value.apiKey } : {}),
      ...('model' in value && (value.model === null || typeof value.model === 'string')
        ? { model: value.model }
        : {}),
      ...(typeof value.enabled === 'boolean' ? { enabled: value.enabled } : {}),
      ...(isStringRecord(value.extraHeaders) ? { extraHeaders: value.extraHeaders } : {}),
      ...(isRecord(value.options) ? { options: value.options } : {}),
      ...(typeof value.makeDefault === 'boolean' ? { makeDefault: value.makeDefault } : {}),
    },
  };
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === 'string');
}

function emptyProfilesPayload() {
  return {
    profiles: [],
    defaultProfileId: null,
    fallbackProfileId: null,
    activeProfileId: null,
  };
}

function emptyDefaultsPayload() {
  return {
    defaultProfileId: null,
    fallbackProfileId: null,
    activeProfileId: null,
    profiles: [],
  };
}

function getGitDiffForReview(projectPath: string, target: string): string {
  const opts = { cwd: projectPath, encoding: 'utf8' as const, timeout: 30_000, maxBuffer: 2 * 1024 * 1024 };
  try {
    if (target === 'staged') {
      return execFileSync('git', ['diff', '--cached'], opts);
    }
    if (target !== 'uncommitted') {
      // treat as a file path: git diff HEAD -- <file>
      return execFileSync('git', ['diff', 'HEAD', '--', target], opts);
    }
    // uncommitted: staged + unstaged
    const staged = execFileSync('git', ['diff', '--cached'], opts);
    const unstaged = execFileSync('git', ['diff'], opts);
    return [staged, unstaged].filter(Boolean).join('\n');
  } catch (err) {
    throw new Error(`git diff failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function buildReviewSystemPrompt(): string {
  return `You are acting as a code reviewer. Analyze the provided diff and output a JSON object with review findings.

Guidelines:
- Flag issues that meaningfully impact correctness, performance, security, or maintainability.
- Only flag bugs introduced in the diff (not pre-existing issues).
- Be concise: finding body should be one paragraph, max.
- Priority levels: [P0] Drop everything, [P1] Urgent, [P2] Normal, [P3] Nice-to-have.
- Prefix finding titles with priority, e.g. "[P1] Un-padding slices along wrong tensor dimensions".
- If there are no real issues, return an empty findings array.
- For overall_correctness: "patch is correct" means no blocking bugs; "patch is incorrect" means there are blocking issues.

You MUST respond with ONLY a valid JSON object matching this exact schema (no markdown fences, no extra prose):
{
  "findings": [
    {
      "title": "<≤80 chars, imperative, starts with [P0]-[P3]>",
      "body": "<Markdown explaining why this is a problem>",
      "confidence_score": <float 0.0-1.0>,
      "priority": <int 0-3>,
      "code_location": {
        "absolute_file_path": "<file path>",
        "line_range": {"start": <int>, "end": <int>}
      }
    }
  ],
  "overall_correctness": "patch is correct" | "patch is incorrect",
  "overall_explanation": "<1-3 sentence justification>",
  "overall_confidence_score": <float 0.0-1.0>
}`;
}

const REVIEW_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['findings', 'overall_correctness', 'overall_explanation', 'overall_confidence_score'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['title', 'body', 'confidence_score', 'code_location'],
        properties: {
          title: { type: 'string' },
          body: { type: 'string' },
          confidence_score: { type: 'number' },
          priority: { type: 'integer', minimum: 0, maximum: 3 },
          code_location: {
            type: 'object',
            required: ['absolute_file_path', 'line_range'],
            properties: {
              absolute_file_path: { type: 'string' },
              line_range: {
                type: 'object',
                required: ['start', 'end'],
                properties: {
                  start: { type: 'integer' },
                  end: { type: 'integer' },
                },
              },
            },
          },
        },
      },
    },
    overall_correctness: { type: 'string', enum: ['patch is correct', 'patch is incorrect'] },
    overall_explanation: { type: 'string' },
    overall_confidence_score: { type: 'number' },
  },
};
