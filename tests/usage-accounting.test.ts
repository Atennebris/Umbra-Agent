import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { UsageLogger } from '../src/memory/usage-log.js';

const tmpDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

async function makeTempLogger(): Promise<{ logger: UsageLogger; filePath: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'umbra-usage-'));
  tmpDirs.push(dir);
  const filePath = path.join(dir, 'usage.jsonl');
  const logger = new UsageLogger(filePath);
  return { logger, filePath };
}

describe('UsageRecord schema and AggregatedStats (§8.4)', () => {
  it('aggregates reasoning and cache tokens from records', async () => {
    const { logger } = await makeTempLogger();

    logger.log({
      timestamp: new Date().toISOString(),
      requestId: 'req-1',
      profileId: 'anthropic-1',
      model: 'claude-3-opus',
      inputTokens: 1000,
      outputTokens: 200,
      totalTokens: 1200,
      cacheReadTokens: 800,
      cacheWriteTokens: 100,
      estimateSource: 'actual',
      status: 'success',
    });

    logger.log({
      timestamp: new Date().toISOString(),
      requestId: 'req-2',
      profileId: 'openai-1',
      model: 'o1',
      inputTokens: 500,
      outputTokens: 300,
      totalTokens: 800,
      reasoningTokens: 150,
      estimateSource: 'actual',
      status: 'success',
    });

    const stats = logger.getStats();

    expect(stats.requests).toBe(2);
    expect(stats.inputTokens).toBe(1500);
    expect(stats.outputTokens).toBe(500);
    expect(stats.cacheReadTokens).toBe(800);
    expect(stats.cacheWriteTokens).toBe(100);
    expect(stats.reasoningTokens).toBe(150);
  });

  it('gracefully handles records without extended fields (zero-fills)', async () => {
    const { logger } = await makeTempLogger();

    logger.log({
      timestamp: new Date().toISOString(),
      requestId: 'req-old',
      profileId: 'p1',
      model: 'gpt-4',
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      status: 'success',
    });

    const stats = logger.getStats();
    expect(stats.reasoningTokens).toBe(0);
    expect(stats.cacheReadTokens).toBe(0);
    expect(stats.cacheWriteTokens).toBe(0);
  });

  it('failed records are counted in requests but add zero tokens', async () => {
    const { logger } = await makeTempLogger();

    logger.log({
      timestamp: new Date().toISOString(),
      requestId: 'req-fail',
      profileId: 'p1',
      model: 'unknown',
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      status: 'failed',
      error: 'API Down',
    });

    const stats = logger.getStats();
    expect(stats.requests).toBe(1);
    expect(stats.totalTokens).toBe(0);
  });

  it('returns zero stats when file does not exist', async () => {
    const { logger } = await makeTempLogger();
    const stats = logger.getStats();
    expect(stats.requests).toBe(0);
    expect(stats.totalTokens).toBe(0);
    expect(stats.reasoningTokens).toBe(0);
  });
});

describe('Provider usage schema normalization (§8.4)', () => {
  it('ProviderCompleteResponse usage schema accepts reasoning and cache fields', async () => {
    const { providerCompleteResponseSchema } = await import('../src/providers/runtime-types.js');

    const mockResponse = {
      providerProfileId: 'p1',
      providerType: 'openai',
      model: 'gpt-4',
      outputText: 'hello',
      outputJson: null,
      toolCalls: [],
      stopReason: 'stop',
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        reasoningTokens: 20,
        cacheReadTokens: 30,
      },
    };

    const parsed = providerCompleteResponseSchema.parse(mockResponse);
    expect(parsed.usage?.inputTokens).toBe(100);
    expect(parsed.usage?.outputTokens).toBe(50);
    expect(parsed.usage?.reasoningTokens).toBe(20);
    expect(parsed.usage?.cacheReadTokens).toBe(30);
  });

  it('Anthropic cache fields are accepted in the usage schema', async () => {
    const { providerCompleteResponseSchema } = await import('../src/providers/runtime-types.js');

    const mockResponse = {
      providerProfileId: 'p2',
      providerType: 'anthropic',
      model: 'claude-3-opus',
      outputText: 'hello',
      outputJson: null,
      toolCalls: [],
      stopReason: 'end_turn',
      usage: {
        inputTokens: 200,
        outputTokens: 100,
        totalTokens: 300,
        cacheReadTokens: 150,
        cacheWriteTokens: 50,
      },
    };

    const parsed = providerCompleteResponseSchema.parse(mockResponse);
    expect(parsed.usage?.cacheReadTokens).toBe(150);
    expect(parsed.usage?.cacheWriteTokens).toBe(50);
  });

  it('missing usage is handled gracefully (undefined)', async () => {
    const { providerCompleteResponseSchema } = await import('../src/providers/runtime-types.js');

    const parsed = providerCompleteResponseSchema.parse({
      providerProfileId: 'p1',
      providerType: 'openai',
      model: 'gpt-4',
      outputText: 'hello',
      outputJson: null,
      toolCalls: [],
      stopReason: 'stop',
    });

    expect(parsed.usage).toBeUndefined();
  });
});

describe('Usage comparison and reporting (§8.4)', () => {
  it('getStatsByModel groups records by model', async () => {
    const { logger } = await makeTempLogger();

    logger.log({
      timestamp: new Date().toISOString(),
      requestId: 'r1',
      profileId: 'anthropic',
      model: 'claude-3-opus',
      inputTokens: 1000,
      outputTokens: 200,
      totalTokens: 1200,
      costEstimate: 0.024,
      status: 'success',
    });
    logger.log({
      timestamp: new Date().toISOString(),
      requestId: 'r2',
      profileId: 'anthropic',
      model: 'claude-3-opus',
      inputTokens: 500,
      outputTokens: 100,
      totalTokens: 600,
      costEstimate: 0.012,
      status: 'success',
    });
    logger.log({
      timestamp: new Date().toISOString(),
      requestId: 'r3',
      profileId: 'openai',
      model: 'gpt-4',
      inputTokens: 800,
      outputTokens: 150,
      totalTokens: 950,
      costEstimate: 0.03,
      status: 'success',
    });

    const byModel = logger.getStatsByModel();

    expect(Object.keys(byModel)).toContain('claude-3-opus');
    expect(Object.keys(byModel)).toContain('gpt-4');

    const opus = byModel['claude-3-opus']!;
    expect(opus.requests).toBe(2);
    expect(opus.inputTokens).toBe(1500);
    expect(opus.outputTokens).toBe(300);
    expect(opus.totalCost).toBeCloseTo(0.036);
    expect(opus.avgCostPerRequest).toBeCloseTo(0.018);

    const gpt = byModel['gpt-4']!;
    expect(gpt.requests).toBe(1);
    expect(gpt.totalCost).toBeCloseTo(0.03);
  });

  it('getStatsByProvider groups records by profileId', async () => {
    const { logger } = await makeTempLogger();

    logger.log({
      timestamp: new Date().toISOString(),
      requestId: 'r1',
      profileId: 'anthropic-profile',
      model: 'claude-3-opus',
      inputTokens: 1000,
      outputTokens: 200,
      totalTokens: 1200,
      costEstimate: 0.024,
      status: 'success',
    });
    logger.log({
      timestamp: new Date().toISOString(),
      requestId: 'r2',
      profileId: 'openai-profile',
      model: 'gpt-4',
      inputTokens: 500,
      outputTokens: 100,
      totalTokens: 600,
      costEstimate: 0.02,
      status: 'success',
    });
    logger.log({
      timestamp: new Date().toISOString(),
      requestId: 'r3',
      profileId: 'anthropic-profile',
      model: 'claude-3-haiku',
      inputTokens: 200,
      outputTokens: 50,
      totalTokens: 250,
      costEstimate: 0.001,
      status: 'success',
    });

    const byProvider = logger.getStatsByProvider();

    expect(Object.keys(byProvider)).toContain('anthropic-profile');
    expect(Object.keys(byProvider)).toContain('openai-profile');

    const anthropic = byProvider['anthropic-profile']!;
    expect(anthropic.requests).toBe(2);
    expect(anthropic.totalTokens).toBe(1450);
    expect(anthropic.totalCost).toBeCloseTo(0.025);
    expect(anthropic.avgCostPerRequest).toBeCloseTo(0.0125);
  });

  it('getStatsBySession groups records by sessionId', async () => {
    const { logger } = await makeTempLogger();

    logger.log({
      timestamp: new Date().toISOString(),
      requestId: 'r1',
      profileId: 'p1',
      sessionId: 'sess-A',
      model: 'claude-3-opus',
      inputTokens: 300,
      outputTokens: 100,
      totalTokens: 400,
      costEstimate: 0.01,
      status: 'success',
    });
    logger.log({
      timestamp: new Date().toISOString(),
      requestId: 'r2',
      profileId: 'p1',
      sessionId: 'sess-A',
      model: 'claude-3-opus',
      inputTokens: 200,
      outputTokens: 80,
      totalTokens: 280,
      costEstimate: 0.007,
      status: 'success',
    });
    logger.log({
      timestamp: new Date().toISOString(),
      requestId: 'r3',
      profileId: 'p1',
      sessionId: 'sess-B',
      model: 'claude-3-opus',
      inputTokens: 500,
      outputTokens: 150,
      totalTokens: 650,
      costEstimate: 0.015,
      status: 'success',
    });
    logger.log({
      timestamp: new Date().toISOString(),
      requestId: 'r4',
      profileId: 'p1',
      model: 'claude-3-opus',
      inputTokens: 100,
      outputTokens: 30,
      totalTokens: 130,
      status: 'success',
    });

    const bySess = logger.getStatsBySession();

    expect(Object.keys(bySess)).toContain('sess-A');
    expect(Object.keys(bySess)).toContain('sess-B');
    expect(Object.keys(bySess)).toContain('no-session');

    expect(bySess['sess-A']?.requests).toBe(2);
    expect(bySess['sess-B']?.requests).toBe(1);
    expect(bySess['no-session']?.requests).toBe(1);
  });

  it('generateReport returns formatted string with totals, by-model, by-provider', async () => {
    const { logger } = await makeTempLogger();

    logger.log({
      timestamp: new Date().toISOString(),
      requestId: 'r1',
      profileId: 'anthropic',
      model: 'claude-3-opus',
      inputTokens: 1000,
      outputTokens: 200,
      totalTokens: 1200,
      costEstimate: 0.024,
      status: 'success',
    });
    logger.log({
      timestamp: new Date().toISOString(),
      requestId: 'r2',
      profileId: 'openai',
      model: 'gpt-4',
      inputTokens: 500,
      outputTokens: 100,
      totalTokens: 600,
      costEstimate: 0.012,
      status: 'success',
    });

    const report = logger.generateReport();

    expect(report).toContain('Usage Report');
    expect(report).toContain('2 requests');
    expect(report).toContain('By Model');
    expect(report).toContain('claude-3-opus');
    expect(report).toContain('gpt-4');
    expect(report).toContain('By Provider');
    expect(report).toContain('anthropic');
    expect(report).toContain('openai');
  });
});
