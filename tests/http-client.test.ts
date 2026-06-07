import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requestDaemonJson, shouldLogDaemonRequest } from '../src/cli/http-client.js';
import * as runtimeDebug from '../src/debug/runtime-debug.js';

vi.mock('../src/debug/runtime-debug.js', () => ({
  writeDebugEvent: vi.fn(),
}));

vi.mock('../src/utils/config.js', () => ({
  loadConfig: () => ({
    daemon: {
      host: '127.0.0.1',
      port: 4312,
    },
  }),
}));

describe('requestDaemonJson logging', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.clearAllMocks();
  });

  it('suppresses noisy GET polling paths', async () => {
    await requestDaemonJson('/usage/stats');
    await requestDaemonJson('/runs/run-123');

    expect(runtimeDebug.writeDebugEvent).not.toHaveBeenCalled();
  });

  it('keeps structured logs for non-noisy daemon requests', async () => {
    await requestDaemonJson('/tasks', { method: 'POST', body: '{}' });

    expect(runtimeDebug.writeDebugEvent).toHaveBeenCalledTimes(2);
    expect(runtimeDebug.writeDebugEvent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        component: 'cli',
        message: 'daemon request started',
        data: expect.objectContaining({ method: 'POST', pathname: '/tasks' }),
      }),
    );
    expect(runtimeDebug.writeDebugEvent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        component: 'cli',
        message: 'daemon request finished',
        data: expect.objectContaining({ method: 'POST', pathname: '/tasks', status: 200 }),
      }),
    );
  });
});

describe('shouldLogDaemonRequest', () => {
  it('filters only the known noisy GET poll endpoints', () => {
    expect(shouldLogDaemonRequest('GET', '/health')).toBe(false);
    expect(shouldLogDaemonRequest('GET', '/usage/stats')).toBe(false);
    expect(shouldLogDaemonRequest('GET', '/runs/run-123')).toBe(false);
    expect(shouldLogDaemonRequest('POST', '/runs/run-123/stop')).toBe(true);
    expect(shouldLogDaemonRequest('POST', '/tasks')).toBe(true);
  });
});
