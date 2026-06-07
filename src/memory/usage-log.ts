import fs from 'node:fs';
import path from 'node:path';
import { resolveRuntimeLayout } from './runtime-layout.js';

export type UsageRecord = {
  timestamp: string;
  requestId: string;
  profileId: string;
  chainId?: string;
  sessionId?: string;
  threadId?: string;
  model: string;
  /** Provider/model combo, e.g. "anthropic/claude-3-5-sonnet" */
  route?: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costEstimate?: number;
  /** Model context window size in tokens */
  contextLimit?: number;
  /** Percentage of context window used, 0–100 with one decimal */
  contextPercent?: number;
  /** Whether usage figures came from provider (actual), local estimator (estimated), or both (mixed) */
  source?: 'actual' | 'estimated' | 'mixed';
  /** @deprecated use source */
  estimateSource?: 'actual' | 'estimate';
  status: 'success' | 'failed';
  error?: string;
};

export type AggregatedStats = {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  requests: number;
  totalCost: number;
};

export class UsageLogger {
  #usagePath: string | null = null;
  #lastRecord: UsageRecord | null = null;

  constructor(overridePath?: string) {
    if (overridePath) this.#usagePath = overridePath;
  }

  #ensurePath() {
    if (this.#usagePath) return;
    try {
      const layout = resolveRuntimeLayout();
      if (layout?.homeDir) {
        this.#usagePath = path.join(layout.homeDir, 'usage.jsonl');
      }
    } catch {
      // Ignore errors during path resolution in tests
    }
  }

  getLastRecord(): UsageRecord | null {
    return this.#lastRecord;
  }

  log(record: UsageRecord): void {
    if (record.status === 'success') this.#lastRecord = record;
    this.#ensurePath();
    if (!this.#usagePath) return;

    try {
      const line = `${JSON.stringify(record)}\n`;
      const dir = path.dirname(this.#usagePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(this.#usagePath, line, 'utf8');
    } catch (error) {
      // best effort
    }
  }

  #readAllRecords(): UsageRecord[] {
    this.#ensurePath();
    if (!this.#usagePath || !fs.existsSync(this.#usagePath)) return [];
    try {
      return fs
        .readFileSync(this.#usagePath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => { try { return JSON.parse(line) as UsageRecord; } catch { return null; } })
        .filter((r): r is UsageRecord => r !== null);
    } catch {
      return [];
    }
  }

  getStatsByModel(): Record<string, AggregatedStats & { avgCostPerRequest: number }> {
    const map: Record<string, AggregatedStats & { avgCostPerRequest: number }> = {};
    for (const r of this.#readAllRecords()) {
      if (!map[r.model]) map[r.model] = { totalTokens: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 0, totalCost: 0, avgCostPerRequest: 0 };
      const s = map[r.model]!;
      s.totalTokens += r.totalTokens || 0;
      s.inputTokens += r.inputTokens || 0;
      s.outputTokens += r.outputTokens || 0;
      s.reasoningTokens += r.reasoningTokens || 0;
      s.cacheReadTokens += r.cacheReadTokens || 0;
      s.cacheWriteTokens += r.cacheWriteTokens || 0;
      s.requests += 1;
      s.totalCost += r.costEstimate || 0;
    }
    for (const s of Object.values(map)) {
      s.avgCostPerRequest = s.requests > 0 ? s.totalCost / s.requests : 0;
    }
    return map;
  }

  getStatsByProvider(): Record<string, AggregatedStats & { avgCostPerRequest: number }> {
    const map: Record<string, AggregatedStats & { avgCostPerRequest: number }> = {};
    for (const r of this.#readAllRecords()) {
      const key = r.profileId || 'unknown';
      if (!map[key]) map[key] = { totalTokens: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 0, totalCost: 0, avgCostPerRequest: 0 };
      const s = map[key]!;
      s.totalTokens += r.totalTokens || 0;
      s.inputTokens += r.inputTokens || 0;
      s.outputTokens += r.outputTokens || 0;
      s.reasoningTokens += r.reasoningTokens || 0;
      s.cacheReadTokens += r.cacheReadTokens || 0;
      s.cacheWriteTokens += r.cacheWriteTokens || 0;
      s.requests += 1;
      s.totalCost += r.costEstimate || 0;
    }
    for (const s of Object.values(map)) {
      s.avgCostPerRequest = s.requests > 0 ? s.totalCost / s.requests : 0;
    }
    return map;
  }

  getStatsBySession(): Record<string, AggregatedStats & { avgCostPerRequest: number }> {
    const map: Record<string, AggregatedStats & { avgCostPerRequest: number }> = {};
    for (const r of this.#readAllRecords()) {
      const key = r.sessionId || 'no-session';
      if (!map[key]) map[key] = { totalTokens: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 0, totalCost: 0, avgCostPerRequest: 0 };
      const s = map[key]!;
      s.totalTokens += r.totalTokens || 0;
      s.inputTokens += r.inputTokens || 0;
      s.outputTokens += r.outputTokens || 0;
      s.reasoningTokens += r.reasoningTokens || 0;
      s.cacheReadTokens += r.cacheReadTokens || 0;
      s.cacheWriteTokens += r.cacheWriteTokens || 0;
      s.requests += 1;
      s.totalCost += r.costEstimate || 0;
    }
    for (const s of Object.values(map)) {
      s.avgCostPerRequest = s.requests > 0 ? s.totalCost / s.requests : 0;
    }
    return map;
  }

  generateReport(): string {
    const byModel = this.getStatsByModel();
    const byProvider = this.getStatsByProvider();
    const total = this.getStats();

    const lines: string[] = [
      `=== Usage Report ===`,
      `Total: ${total.requests} requests | ${total.totalTokens.toLocaleString()} tokens | $${total.totalCost.toFixed(4)}`,
      '',
      '--- By Model ---',
    ];
    for (const [model, s] of Object.entries(byModel).sort((a, b) => b[1].totalCost - a[1].totalCost)) {
      lines.push(`  ${model}: ${s.requests} req | ${s.totalTokens.toLocaleString()} tok | $${s.totalCost.toFixed(4)} | avg $${s.avgCostPerRequest.toFixed(4)}/req`);
    }
    lines.push('', '--- By Provider ---');
    for (const [provider, s] of Object.entries(byProvider).sort((a, b) => b[1].totalCost - a[1].totalCost)) {
      lines.push(`  ${provider}: ${s.requests} req | ${s.totalTokens.toLocaleString()} tok | $${s.totalCost.toFixed(4)}`);
    }
    return lines.join('\n');
  }

  getStats(): AggregatedStats {
    this.#ensurePath();
    const stats: AggregatedStats = {
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      requests: 0,
      totalCost: 0,
    };

    if (!this.#usagePath || !fs.existsSync(this.#usagePath)) {
      return stats;
    }

    try {
      const content = fs.readFileSync(this.#usagePath, 'utf8');
      const lines = content.split('\n').filter(Boolean);
      stats.requests = lines.length;

      for (const line of lines) {
        try {
          const record = JSON.parse(line) as UsageRecord;
          stats.totalTokens += record.totalTokens || 0;
          stats.inputTokens += record.inputTokens || 0;
          stats.outputTokens += record.outputTokens || 0;
          stats.reasoningTokens += record.reasoningTokens || 0;
          stats.cacheReadTokens += record.cacheReadTokens || 0;
          stats.cacheWriteTokens += record.cacheWriteTokens || 0;
          stats.totalCost += record.costEstimate || 0;
        } catch {}
      }
    } catch {
      // best effort
    }

    return stats;
  }
}

let globalLogger: UsageLogger | null = null;
export function getUsageLogger(): UsageLogger {
  if (!globalLogger) globalLogger = new UsageLogger();
  return globalLogger;
}

export function resetUsageLoggerForTests(): void {
  globalLogger = null;
}
