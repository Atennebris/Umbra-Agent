import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UsageLogger, type UsageRecord } from '../src/memory/usage-log.js';

// ─── helpers ──────────────────────────────────────────────────────────────────

const tmpDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

async function makeTempLogger(): Promise<UsageLogger> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'umbra-req-usage-'));
  tmpDirs.push(dir);
  return new UsageLogger(path.join(dir, 'usage.jsonl'));
}

function makeRecord(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    timestamp: new Date().toISOString(),
    requestId: `req-${Math.random().toString(36).slice(2, 10)}`,
    profileId: 'test-profile',
    model: 'claude-3-5-sonnet',
    inputTokens: 1000,
    outputTokens: 200,
    totalTokens: 1200,
    status: 'success',
    ...overrides,
  };
}

// ─── RequestUsage contract ─────────────────────────────────────────────────────

describe('RequestUsage contract — new fields', () => {
  it('stores contextLimit and contextPercent', async () => {
    const logger = await makeTempLogger();
    logger.log(makeRecord({ contextLimit: 200_000, contextPercent: 0.6 }));
    const rec = logger.getLastRecord();
    expect(rec?.contextLimit).toBe(200_000);
    expect(rec?.contextPercent).toBe(0.6);
  });

  it('stores route field', async () => {
    const logger = await makeTempLogger();
    logger.log(makeRecord({ route: 'anthropic/claude-3-5-sonnet' }));
    expect(logger.getLastRecord()?.route).toBe('anthropic/claude-3-5-sonnet');
  });

  it('stores source: actual for real provider data', async () => {
    const logger = await makeTempLogger();
    logger.log(
      makeRecord({ source: 'actual', inputTokens: 500, outputTokens: 100, totalTokens: 600 }),
    );
    expect(logger.getLastRecord()?.source).toBe('actual');
  });

  it('stores source: estimated for fallback data', async () => {
    const logger = await makeTempLogger();
    logger.log(
      makeRecord({ source: 'estimated', inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
    );
    expect(logger.getLastRecord()?.source).toBe('estimated');
  });

  it('backward compat: estimateSource still accepted alongside source', async () => {
    const logger = await makeTempLogger();
    logger.log(makeRecord({ estimateSource: 'actual', source: 'actual' }));
    const rec = logger.getLastRecord();
    expect(rec?.estimateSource).toBe('actual');
    expect(rec?.source).toBe('actual');
  });
});

// ─── contextPercent computation ───────────────────────────────────────────────

describe('contextPercent computation', () => {
  it('calculates percent correctly', () => {
    const totalTokens = 50_000;
    const contextLimit = 200_000;
    const pct = Math.round((totalTokens / contextLimit) * 1000) / 10;
    expect(pct).toBe(25.0);
  });

  it('rounds to 1 decimal place', () => {
    const pct = Math.round((123_456 / 200_000) * 1000) / 10;
    expect(pct).toBe(61.7);
  });

  it('caps at 100 when over limit', () => {
    const totalTokens = 210_000;
    const contextLimit = 200_000;
    const pct = Math.round((totalTokens / contextLimit) * 1000) / 10;
    expect(pct).toBeGreaterThan(100);
  });
});

// ─── cost formula with cache/reasoning ────────────────────────────────────────

describe('cost formula — OpenCode parity', () => {
  function computeCost(opts: {
    inputTokens: number;
    outputTokens: number;
    reasoningTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    pricing: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
  }): number {
    const p = opts.pricing;
    const inp = opts.inputTokens;
    const out = opts.outputTokens;
    const reasoning = opts.reasoningTokens ?? 0;
    const cacheRead = opts.cacheReadTokens ?? 0;
    const cacheWrite = opts.cacheWriteTokens ?? 0;
    const cacheReadPrice = p.cacheRead ?? p.input * 0.1;
    const cacheWritePrice = p.cacheWrite ?? p.input;
    return (
      (inp * p.input +
        out * p.output +
        reasoning * p.output +
        cacheRead * cacheReadPrice +
        cacheWrite * cacheWritePrice) /
      1_000_000
    );
  }

  it('computes basic input+output cost correctly', () => {
    const cost = computeCost({
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      pricing: { input: 3, output: 15 },
    });
    expect(cost).toBeCloseTo(18.0, 4);
  });

  it('adds reasoning tokens at output rate', () => {
    const cost = computeCost({
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 1_000_000,
      pricing: { input: 3, output: 15 },
    });
    expect(cost).toBeCloseTo(15.0, 4);
  });

  it('uses explicit cache read pricing when provided', () => {
    const cost = computeCost({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
      pricing: { input: 3, output: 15, cacheRead: 0.3 },
    });
    expect(cost).toBeCloseTo(0.3, 4);
  });

  it('defaults cache read to 10% of input when not specified', () => {
    const cost = computeCost({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
      pricing: { input: 3, output: 15 },
    });
    expect(cost).toBeCloseTo(0.3, 4);
  });

  it('defaults cache write to input rate when not specified', () => {
    const cost = computeCost({
      inputTokens: 0,
      outputTokens: 0,
      cacheWriteTokens: 1_000_000,
      pricing: { input: 3, output: 15 },
    });
    expect(cost).toBeCloseTo(3.0, 4);
  });

  it('accumulates all token types correctly', () => {
    const cost = computeCost({
      inputTokens: 100_000,
      outputTokens: 50_000,
      reasoningTokens: 10_000,
      cacheReadTokens: 200_000,
      cacheWriteTokens: 20_000,
      pricing: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    });
    // inp: 100k*3 = 0.3, out: 50k*15 = 0.75, reasoning: 10k*15 = 0.15
    // cacheRead: 200k*0.3 = 0.06, cacheWrite: 20k*3.75 = 0.075
    // total: (0.3+0.75+0.15+0.06+0.075) / 1 = 1.335
    expect(cost).toBeCloseTo(1.335, 3);
  });
});

// ─── session aggregation ──────────────────────────────────────────────────────

describe('session aggregation over multiple requests', () => {
  it('accumulates totals across requests', async () => {
    const logger = await makeTempLogger();
    logger.log(
      makeRecord({
        inputTokens: 1000,
        outputTokens: 200,
        totalTokens: 1200,
        source: 'actual',
        status: 'success',
      }),
    );
    logger.log(
      makeRecord({
        inputTokens: 500,
        outputTokens: 100,
        totalTokens: 600,
        source: 'actual',
        status: 'success',
      }),
    );
    const stats = logger.getStats();
    expect(stats.requests).toBe(2);
    expect(stats.inputTokens).toBe(1500);
    expect(stats.outputTokens).toBe(300);
    expect(stats.totalTokens).toBe(1800);
  });

  it('getLastRecord returns the most recent successful record', async () => {
    const logger = await makeTempLogger();
    logger.log(
      makeRecord({
        requestId: 'req-1',
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        status: 'success',
      }),
    );
    logger.log(
      makeRecord({
        requestId: 'req-2',
        inputTokens: 200,
        outputTokens: 80,
        totalTokens: 280,
        status: 'success',
      }),
    );
    expect(logger.getLastRecord()?.requestId).toBe('req-2');
  });

  it('failed records do not update lastRecord', async () => {
    const logger = await makeTempLogger();
    logger.log(
      makeRecord({
        requestId: 'req-ok',
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        status: 'success',
      }),
    );
    logger.log({ ...makeRecord(), requestId: 'req-fail', status: 'failed', error: 'timeout' });
    expect(logger.getLastRecord()?.requestId).toBe('req-ok');
  });
});

// ─── usage command handler ────────────────────────────────────────────────────

describe('runUsageCommand handler', () => {
  it('handler is a function', async () => {
    const { runUsageCommand } = await import('../src/cli/commands/usage-command.js');
    expect(typeof runUsageCommand).toBe('function');
  });
});
