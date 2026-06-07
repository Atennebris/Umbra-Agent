import type { CliCommandHandler } from '../command-types.js';
import { getLastUsage, getUsageStats } from '../http-client.js';

export const runUsageCommand: CliCommandHandler = async (input) => {
  const args = Array.isArray(input) ? (input as string[]) : [];
  const sub = args[0];

  if (sub === 'last' || sub === undefined || sub === '') {
    // Default: show last request + session totals
    const [stats, last] = (await Promise.all([
      getUsageStats().catch(() => null),
      getLastUsage().catch(() => null),
    ])) as [
      import('../../memory/usage-log.js').AggregatedStats | null,
      import('../../memory/usage-log.js').UsageRecord | null,
    ];

    if (last) {
      console.log('\nLast request:');
      console.log(`  In        : ${last.inputTokens.toLocaleString()} tokens`);
      console.log(`  Out       : ${last.outputTokens.toLocaleString()} tokens`);
      if ((last.reasoningTokens ?? 0) > 0) {
        console.log(`  Reasoning : ${(last.reasoningTokens ?? 0).toLocaleString()} tokens`);
      }
      if ((last.cacheReadTokens ?? 0) > 0) {
        console.log(`  Cache read: ${(last.cacheReadTokens ?? 0).toLocaleString()} tokens`);
      }
      if ((last.cacheWriteTokens ?? 0) > 0) {
        console.log(`  Cache wrt : ${(last.cacheWriteTokens ?? 0).toLocaleString()} tokens`);
      }
      console.log(`  Total     : ${last.totalTokens.toLocaleString()} tokens`);
      if (last.contextPercent != null) {
        console.log(
          `  Ctx used  : ${last.contextPercent.toFixed(1)}%${last.contextLimit ? ` of ${last.contextLimit.toLocaleString()}` : ''}`,
        );
      }
      if (last.costEstimate != null) {
        console.log(`  Cost      : $${last.costEstimate.toFixed(6)}`);
      }
      if (last.route) {
        console.log(`  Route     : ${last.route}`);
      }
      if (last.source) {
        console.log(`  Source    : ${last.source}`);
      }
    } else {
      console.log('\nNo request data available yet.');
    }

    if (stats && stats.requests > 0) {
      console.log('\nSession totals:');
      console.log(`  Requests  : ${stats.requests}`);
      console.log(`  In        : ${stats.inputTokens.toLocaleString()} tokens`);
      console.log(`  Out       : ${stats.outputTokens.toLocaleString()} tokens`);
      if (stats.reasoningTokens > 0) {
        console.log(`  Reasoning : ${stats.reasoningTokens.toLocaleString()} tokens`);
      }
      if (stats.cacheReadTokens > 0) {
        console.log(`  Cache read: ${stats.cacheReadTokens.toLocaleString()} tokens`);
      }
      console.log(`  Total     : ${stats.totalTokens.toLocaleString()} tokens`);
      console.log(`  Cost      : $${stats.totalCost.toFixed(6)}`);
    }
    return;
  }

  console.log('Usage: umbra usage [last]');
};
