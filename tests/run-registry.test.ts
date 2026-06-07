import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { RunRegistry } from '../src/core/run-registry.js';

describe('RunRegistry', () => {
  it('marks long runs as timed_out when time-box expires', async () => {
    const registry = new RunRegistry({
      async executeRun(_request, hooks) {
        await delay(40);
        hooks.ensureActive();
        return {
          finalText: 'done',
          finalJson: null,
          check: null,
          commit: null,
        };
      },
    } as never);

    const run = registry.create({
      prompt: 'long run',
      mode: 'agent',
      timeLimitMs: 10,
    });
    await registry.start(run.id);
    await delay(80);
    const finished = registry.get(run.id);

    expect(finished?.status).toBe('timed_out');
  });

  it('assigns a session id immediately when a run is created without one', () => {
    const registry = new RunRegistry({
      async executeRun() {
        return {
          finalText: 'ok',
          finalJson: null,
          check: null,
          commit: null,
        };
      },
    } as never);

    const run = registry.create({
      prompt: 'remember this',
      mode: 'agent',
    });

    expect(run.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it('stops and restarts finished runs', async () => {
    const registry = new RunRegistry({
      async executeRun(_request, hooks) {
        await delay(5);
        hooks.ensureActive();
        return {
          finalText: 'ok',
          finalJson: null,
          check: null,
          commit: null,
        };
      },
    } as never);

    const run = registry.create({
      prompt: 'restartable',
      mode: 'plan',
    });
    await registry.start(run.id);
    await delay(20);
    expect(registry.get(run.id)?.status).toBe('completed');

    const restarted = await registry.restart(run.id);
    expect(restarted.attempt).toBe(2);
    await delay(20);
    expect(registry.get(run.id)?.status).toBe('completed');
  });

  it('records stopped status for interrupted runs', async () => {
    const registry = new RunRegistry({
      async executeRun(_request, hooks) {
        await delay(30);
        hooks.ensureActive();
        return {
          finalText: 'should not finish',
          finalJson: null,
          check: null,
          commit: null,
        };
      },
    } as never);

    const run = registry.create({
      prompt: 'stop me',
      mode: 'agent',
    });
    await registry.start(run.id);
    registry.stop(run.id);
    await delay(60);

    expect(registry.get(run.id)?.status).toBe('stopped');
  });
});
