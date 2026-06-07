import type {
  MemorySettingsPayload,
  ProviderCompleteRequest,
  ReviewRequestPayload,
  RunTaskRequest,
  SessionCompactionPayload,
  TaskPayload,
  ThreadCreatePayload,
  ThreadDetectPayload,
  ThreadForkPayload,
  ThreadSettingsPayload,
  WebSearchSettingsUpdatePayload,
} from '../core/contracts.js';
import { writeDebugEvent } from '../debug/runtime-debug.js';
import type { AggregatedStats, UsageRecord } from '../memory/usage-log.js';
import { loadConfig } from '../utils/config.js';

export async function postTask(payload: TaskPayload): Promise<unknown> {
  const response = await requestDaemonJson('/tasks', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  return readJsonResponse(response);
}

export async function getStatus(): Promise<unknown> {
  const response = await requestDaemonJson('/health');
  return readJsonResponse(response);
}

export async function getMemorySettings(): Promise<unknown> {
  const response = await requestDaemonJson('/memory/settings');
  return readJsonResponse(response);
}

export async function updateMemorySettings(
  payload: Partial<MemorySettingsPayload>,
): Promise<unknown> {
  const response = await requestDaemonJson('/memory/settings', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  return readJsonResponse(response);
}

export async function getWebSearchSettings(): Promise<unknown> {
  const response = await requestDaemonJson('/web/settings');
  return readJsonResponse(response);
}

export async function updateWebSearchSettings(
  payload: WebSearchSettingsUpdatePayload,
): Promise<unknown> {
  const response = await requestDaemonJson('/web/settings', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  return readJsonResponse(response);
}

export async function listTrustedPaths(): Promise<unknown> {
  const response = await requestDaemonJson('/trust/paths');
  return readJsonResponse(response);
}

export async function removeTrustedPath(targetPath: string): Promise<unknown> {
  const response = await requestDaemonJson(`/trust/paths/${encodeURIComponent(targetPath)}`, {
    method: 'DELETE',
  });
  return readJsonResponse(response);
}

export async function listPermissionRules(): Promise<unknown> {
  const response = await requestDaemonJson('/permissions/rules');
  return readJsonResponse(response);
}

export async function deletePermissionRule(ruleId: string): Promise<unknown> {
  const response = await requestDaemonJson(`/permissions/rules/${encodeURIComponent(ruleId)}`, {
    method: 'DELETE',
  });
  return readJsonResponse(response);
}

export async function getProviderModelCatalog(): Promise<unknown> {
  const response = await requestDaemonJson('/providers/models/catalog');
  return readJsonResponse(response);
}

export async function getUsageStats(): Promise<AggregatedStats> {
  const response = await requestDaemonJson('/usage/stats');
  return (await readJsonResponse(response)) as AggregatedStats;
}

export async function getLastUsage(): Promise<UsageRecord | null> {
  const response = await requestDaemonJson('/usage/last');
  return (await readJsonResponse(response)) as UsageRecord | null;
}

export async function resetMemories(payload: {
  projectPath?: string;
  threadId?: string;
}): Promise<unknown> {
  const response = await requestDaemonJson('/memory/reset', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  return readJsonResponse(response);
}

export async function listProviderProfiles(): Promise<unknown> {
  const response = await requestDaemonJson('/providers/profiles');
  return readJsonResponse(response);
}

export async function listProviderTypes(): Promise<unknown> {
  const response = await requestDaemonJson('/providers/types');
  return readJsonResponse(response);
}

export async function createProviderProfile(payload: {
  type: string;
  label: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string | null;
  enabled?: boolean;
  extraHeaders?: Record<string, string>;
  options?: Record<string, unknown>;
  makeDefault?: boolean;
}): Promise<unknown> {
  const response = await requestDaemonJson('/providers/profiles', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  return readJsonResponse(response);
}

export async function updateProviderProfile(
  profileId: string,
  payload: {
    type?: string;
    label?: string;
    baseUrl?: string;
    apiKey?: string;
    model?: string | null;
    enabled?: boolean;
    extraHeaders?: Record<string, string>;
    options?: Record<string, unknown>;
    makeDefault?: boolean;
  },
): Promise<unknown> {
  const response = await requestDaemonJson(`/providers/profiles/${encodeURIComponent(profileId)}`, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  return readJsonResponse(response);
}

export async function deleteProviderProfile(profileId: string): Promise<unknown> {
  const response = await requestDaemonJson(`/providers/profiles/${encodeURIComponent(profileId)}`, {
    method: 'DELETE',
  });
  return readJsonResponse(response);
}

export async function testProviderProfile(profileId: string): Promise<unknown> {
  const response = await requestDaemonJson(
    `/providers/profiles/${encodeURIComponent(profileId)}/test`,
    {
      method: 'POST',
    },
  );
  return readJsonResponse(response);
}

export async function listProviderModels(profileId: string): Promise<unknown> {
  const response = await requestDaemonJson(
    `/providers/profiles/${encodeURIComponent(profileId)}/models`,
  );
  return readJsonResponse(response);
}

export async function completeWithProvider(
  profileId: string,
  payload: ProviderCompleteRequest,
): Promise<unknown> {
  const response = await requestDaemonJson(
    `/providers/profiles/${encodeURIComponent(profileId)}/complete`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    },
  );
  return readJsonResponse(response);
}

export async function compactSession(
  sessionId: string,
  payload: SessionCompactionPayload,
): Promise<unknown> {
  const response = await requestDaemonJson(`/sessions/${encodeURIComponent(sessionId)}/compact`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  return readJsonResponse(response);
}

export async function reviewCode(payload: ReviewRequestPayload): Promise<unknown> {
  const response = await requestDaemonJson('/review', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return readJsonResponse(response);
}

export async function readSessionEvents(sessionId: string): Promise<unknown> {
  const response = await requestDaemonJson(`/sessions/${encodeURIComponent(sessionId)}`);
  return readJsonResponse(response);
}

export async function listThreads(
  params: {
    projectPath?: string;
    archived?: boolean;
    searchTerm?: string;
    cursor?: string;
    limit?: number;
  } = {},
): Promise<unknown> {
  const search = new URLSearchParams();

  if (params.projectPath) search.set('projectPath', params.projectPath);
  if (typeof params.archived === 'boolean') search.set('archived', String(params.archived));
  if (params.searchTerm) search.set('searchTerm', params.searchTerm);
  if (params.cursor) search.set('cursor', params.cursor);
  if (typeof params.limit === 'number') search.set('limit', String(params.limit));

  const suffix = search.size > 0 ? `?${search.toString()}` : '';
  const response = await requestDaemonJson(`/threads${suffix}`);
  return readJsonResponse(response);
}

export async function getThread(threadId: string, projectPath?: string): Promise<unknown> {
  const suffix = projectPath ? `?projectPath=${encodeURIComponent(projectPath)}` : '';
  const response = await requestDaemonJson(`/threads/${encodeURIComponent(threadId)}${suffix}`);
  return readJsonResponse(response);
}

export async function resumeThread(threadId: string, projectPath?: string): Promise<unknown> {
  const response = await requestDaemonJson(`/threads/${encodeURIComponent(threadId)}/resume`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(projectPath ? { projectPath } : {}),
  });
  return readJsonResponse(response);
}

export async function createThread(payload: ThreadCreatePayload): Promise<unknown> {
  const response = await requestDaemonJson('/threads', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  return readJsonResponse(response);
}

export async function forkThread(threadId: string, payload: ThreadForkPayload): Promise<unknown> {
  const response = await requestDaemonJson(`/threads/${encodeURIComponent(threadId)}/fork`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  return readJsonResponse(response);
}

export async function updateThreadSettings(
  threadId: string,
  payload: ThreadSettingsPayload,
): Promise<unknown> {
  const response = await requestDaemonJson(`/threads/${encodeURIComponent(threadId)}/settings`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  return readJsonResponse(response);
}

export async function archiveThread(threadId: string): Promise<unknown> {
  const response = await requestDaemonJson(`/threads/${encodeURIComponent(threadId)}/archive`, {
    method: 'POST',
  });
  return readJsonResponse(response);
}

export async function unarchiveThread(threadId: string): Promise<unknown> {
  const response = await requestDaemonJson(`/threads/${encodeURIComponent(threadId)}/unarchive`, {
    method: 'POST',
  });
  return readJsonResponse(response);
}

export async function exportThread(threadId: string): Promise<unknown> {
  const response = await requestDaemonJson(`/threads/${encodeURIComponent(threadId)}/export`, {
    method: 'POST',
  });
  return readJsonResponse(response);
}

export async function detectImportableThreads(payload: ThreadDetectPayload = {}): Promise<unknown> {
  const response = await requestDaemonJson('/threads/detect', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  return readJsonResponse(response);
}

export async function importThread(payload: {
  filePath: string;
  projectPath?: string;
  title?: string;
  archived?: boolean;
}): Promise<unknown> {
  const response = await requestDaemonJson('/threads/import', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  return readJsonResponse(response);
}

export async function createRun(payload: RunTaskRequest): Promise<unknown> {
  const response = await requestDaemonJson('/runs', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  return readJsonResponse(response);
}

export async function getRun(runId: string): Promise<unknown> {
  const response = await requestDaemonJson(`/runs/${encodeURIComponent(runId)}`);
  return readJsonResponse(response);
}

export async function listRuns(): Promise<unknown> {
  const response = await requestDaemonJson('/runs');
  return readJsonResponse(response);
}

export async function stopRun(runId: string): Promise<unknown> {
  const response = await requestDaemonJson(`/runs/${encodeURIComponent(runId)}/stop`, {
    method: 'POST',
  });
  return readJsonResponse(response);
}

export async function approveRunPermission(
  runId: string,
  approvalId: string,
  outcome: 'allow' | 'deny' | 'allow_always',
): Promise<unknown> {
  const response = await requestDaemonJson(`/runs/${encodeURIComponent(runId)}/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ approvalId, outcome }),
  });
  return readJsonResponse(response);
}

export async function restartRun(runId: string): Promise<unknown> {
  const response = await requestDaemonJson(`/runs/${encodeURIComponent(runId)}/restart`, {
    method: 'POST',
  });
  return readJsonResponse(response);
}

export async function listRunContracts(): Promise<unknown> {
  const response = await requestDaemonJson('/runs/contracts');
  return readJsonResponse(response);
}

/**
 * Polls /health until the daemon responds with ok:true or the timeout expires.
 * Resolves silently either way — the TUI handles a non-responsive daemon gracefully.
 */
export async function waitForDaemonReady(timeoutMs = 10_000): Promise<void> {
  const config = loadConfig();
  const url = `http://${config.daemon.host}:${config.daemon.port}/health`;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (res.ok) {
        const body = (await res.json()) as { ok?: boolean };
        if (body.ok) return;
      }
    } catch {
      // daemon not ready yet, keep waiting
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function requestDaemonJson(pathname: string, init: RequestInit = {}): Promise<Response> {
  const config = loadConfig();
  const url = `http://${config.daemon.host}:${config.daemon.port}${pathname}`;
  const method = init.method ?? 'GET';
  const startedAt = Date.now();
  const shouldLogRequest = shouldLogDaemonRequest(method, pathname);

  if (shouldLogRequest) {
    writeDebugEvent({
      component: 'cli',
      level: 'info',
      message: 'daemon request started',
      data: {
        method,
        pathname,
      },
    });
  }

  const response = await fetch(url, init);

  if (shouldLogRequest) {
    writeDebugEvent({
      component: 'cli',
      level: response.ok ? 'info' : 'warn',
      message: 'daemon request finished',
      data: {
        method,
        pathname,
        status: response.status,
        durationMs: Date.now() - startedAt,
      },
    });
  }

  return response;
}

export function shouldLogDaemonRequest(method: string, pathname: string): boolean {
  if (pathname === '/health') {
    return false;
  }

  if (method === 'GET' && pathname === '/usage/stats') {
    return false;
  }

  if (method === 'GET' && /^\/runs\/[^/]+$/.test(pathname)) {
    return false;
  }

  return true;
}

export { requestDaemonJson };

async function readJsonResponse(response: Response): Promise<unknown> {
  const payload = (await response.json()) as unknown;

  if (!response.ok) {
    const detail =
      typeof payload === 'object' &&
      payload !== null &&
      'error' in payload &&
      typeof payload.error === 'string'
        ? payload.error
        : JSON.stringify(payload);
    writeDebugEvent({
      component: 'cli',
      level: 'error',
      message: 'daemon request failed',
      data: {
        status: response.status,
        detail,
      },
    });
    throw new Error(`Daemon request failed with status ${response.status}: ${detail}`);
  }

  return payload;
}
