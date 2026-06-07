import { estimateJsonTokens } from './token-estimator.js';
import type { ProviderChatMessage } from '../providers/index.js';

export type SplitTurnResult = {
  messages: ProviderChatMessage[];
  splitApplied: boolean;
  compressedPairs: number;
};

/** Number of raw tool-call/result pairs kept as the "tail" after split-turn compression. */
export const SPLIT_TURN_TAIL_SIZE = 3;

type ToolPair = {
  assistant: ProviderChatMessage;
  results: ProviderChatMessage[];
};

function extractToolPairs(messages: ProviderChatMessage[]): ToolPair[] {
  const pairs: ToolPair[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg || msg.role !== 'assistant' || !msg.toolCalls?.length) continue;
    const results: ProviderChatMessage[] = [];
    let j = i + 1;
    while (j < messages.length) {
      const next = messages[j];
      if (!next || next.role !== 'tool') break;
      results.push(next);
      j++;
    }
    if (results.length > 0) {
      pairs.push({ assistant: msg, results });
    }
  }
  return pairs;
}

function buildPrefixSummary(pairs: ToolPair[]): string {
  const lines: string[] = [`## In-Turn Prefix (${pairs.length} earlier tool call(s) compressed)`];
  for (const pair of pairs) {
    for (const tc of pair.assistant.toolCalls ?? []) {
      const args = tc.arguments as Record<string, unknown>;
      const argStr = Object.entries(args)
        .slice(0, 2)
        .map(([k, v]) => `${k}=${String(v).slice(0, 40)}`)
        .join(', ');
      lines.push(`- ${tc.name}(${argStr})`);
    }
    for (const result of pair.results) {
      try {
        const parsed = JSON.parse((result.content ?? '{}') as string) as Record<string, unknown>;
        const status = typeof parsed.status === 'string' ? parsed.status : 'done';
        lines.push(`  → ${status}`);
      } catch {
        lines.push(`  → done`);
      }
    }
  }
  return lines.join('\n');
}

/**
 * Apply split-turn compaction when the message window overflows during an active tool exchange.
 *
 * When the agent loop is midway through a turn (many tool calls have been made) and the context
 * overflows, this function compresses the older prefix tool pairs into a brief summary and keeps
 * the most recent `tailSize` pairs as raw messages — preserving full fidelity on the "recent work"
 * while dramatically reducing context cost.
 *
 * Returns the original messages unchanged if:
 * - Messages fit within maxTokens (no action needed)
 * - No active tool exchange detected (no tool pairs in the current turn)
 * - Not enough pairs to split (pairs <= tailSize)
 */
export function applySplitTurn(
  messages: ProviderChatMessage[],
  maxTokens: number,
  tailSize = SPLIT_TURN_TAIL_SIZE,
): SplitTurnResult {
  if (estimateJsonTokens(messages) <= maxTokens) {
    return { messages, splitApplied: false, compressedPairs: 0 };
  }

  const systemMsg = messages[0]?.role === 'system' ? messages[0] : null;
  const body = systemMsg ? messages.slice(1) : [...messages];

  // Find the last user message — marks the start of the active agent turn
  let lastUserIdx = -1;
  for (let i = body.length - 1; i >= 0; i--) {
    const m = body[i];
    if (m && m.role === 'user') {
      lastUserIdx = i;
      break;
    }
  }

  if (lastUserIdx < 0) return { messages, splitApplied: false, compressedPairs: 0 };

  const activeTurnMsgs = body.slice(lastUserIdx + 1);
  const toolPairs = extractToolPairs(activeTurnMsgs);

  if (toolPairs.length <= tailSize) {
    return { messages, splitApplied: false, compressedPairs: 0 };
  }

  const prefixPairs = toolPairs.slice(0, toolPairs.length - tailSize);
  const suffixPairs = toolPairs.slice(-tailSize);

  const summaryMsg: ProviderChatMessage = {
    role: 'user',
    content: `[Turn prefix compressed — ${prefixPairs.length} earlier tool call(s)]\n${buildPrefixSummary(prefixPairs)}`,
  };

  const tailMsgs: ProviderChatMessage[] = [];
  for (const pair of suffixPairs) {
    tailMsgs.push(pair.assistant);
    for (const r of pair.results) tailMsgs.push(r);
  }

  const currentUserMsg = body[lastUserIdx] as ProviderChatMessage;
  const oldHistory = body.slice(0, lastUserIdx).filter((m): m is ProviderChatMessage => m !== undefined);

  // core = system + currentUser + summary + tail (everything we must keep)
  const coreSize = (systemMsg ? 1 : 0) + 1 + 1 + tailMsgs.length;

  let result: ProviderChatMessage[] = [
    ...(systemMsg ? [systemMsg] : []),
    ...oldHistory,
    currentUserMsg,
    summaryMsg,
    ...tailMsgs,
  ];

  // If still over budget, drop old conversation history from front
  const dropFrom = systemMsg ? 1 : 0;
  while (result.length > coreSize && estimateJsonTokens(result) > maxTokens) {
    result.splice(dropFrom, 1);
  }

  return { messages: result, splitApplied: true, compressedPairs: prefixPairs.length };
}
