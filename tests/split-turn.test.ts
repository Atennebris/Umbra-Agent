import { describe, expect, it } from 'vitest';
import { SPLIT_TURN_TAIL_SIZE, applySplitTurn } from '../src/context/split-turn.js';
import type { ProviderChatMessage } from '../src/providers/index.js';

function makePair(toolName: string, resultText: string, idx: number): ProviderChatMessage[] {
  return [
    {
      role: 'assistant' as const,
      content: null,
      toolCalls: [
        {
          id: `tc-${idx}`,
          name: toolName,
          arguments: { pattern: `query-${idx}` },
        },
      ],
    },
    {
      role: 'tool' as const,
      toolCallId: `tc-${idx}`,
      content: JSON.stringify({ status: 'completed', output: { text: resultText } }),
    },
  ];
}

describe('applySplitTurn', () => {
  it('returns unchanged when messages fit within budget', () => {
    const messages: ProviderChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'task' },
    ];
    const result = applySplitTurn(messages, 100_000);
    expect(result.splitApplied).toBe(false);
    expect(result.messages).toBe(messages);
    expect(result.compressedPairs).toBe(0);
  });

  it('returns unchanged when not enough tool pairs to split', () => {
    const messages: ProviderChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'task' },
      ...makePair('search.rg', 'result1', 1),
      ...makePair('search.rg', 'result2', 2),
    ];
    // Only 2 pairs (= tailSize), not enough to compress prefix
    const result = applySplitTurn(messages, 10);
    expect(result.splitApplied).toBe(false);
  });

  it('returns unchanged when no tool pairs at all', () => {
    const messages: ProviderChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'task' },
      { role: 'assistant', content: 'plain text response without tools' },
    ];
    const result = applySplitTurn(messages, 10);
    expect(result.splitApplied).toBe(false);
  });

  it('applies split-turn when active turn has more pairs than tailSize', () => {
    const bigResult = 'x'.repeat(5000);
    const messages: ProviderChatMessage[] = [
      { role: 'system', content: 'system instructions' },
      { role: 'user', content: 'run many grep searches' },
      ...makePair('search.rg', bigResult, 1),
      ...makePair('search.rg', bigResult, 2),
      ...makePair('search.rg', bigResult, 3),
      ...makePair('search.rg', bigResult, 4),
      ...makePair('search.rg', bigResult, 5),
      ...makePair('search.rg', bigResult, 6),
    ];

    const result = applySplitTurn(messages, 5000);

    expect(result.splitApplied).toBe(true);
    expect(result.compressedPairs).toBe(6 - SPLIT_TURN_TAIL_SIZE);

    // Verify exactly SPLIT_TURN_TAIL_SIZE raw pairs remain
    const rawToolMsgs = result.messages.filter((m) => m.role === 'tool');
    const rawAssistantWithTools = result.messages.filter(
      (m) => m.role === 'assistant' && m.toolCalls?.length,
    );
    expect(rawToolMsgs.length).toBe(SPLIT_TURN_TAIL_SIZE);
    expect(rawAssistantWithTools.length).toBe(SPLIT_TURN_TAIL_SIZE);
  });

  it('preserves exact tail tool call IDs in ascending order', () => {
    const bigResult = 'x'.repeat(3000);
    const messages: ProviderChatMessage[] = [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'task' },
      ...makePair('search.rg', bigResult, 1),
      ...makePair('search.rg', bigResult, 2),
      ...makePair('search.rg', bigResult, 3),
      ...makePair('search.rg', bigResult, 4), // tail[0]
      ...makePair('search.rg', bigResult, 5), // tail[1]
      ...makePair('search.rg', bigResult, 6), // tail[2]
    ];

    const result = applySplitTurn(messages, 2000);
    expect(result.splitApplied).toBe(true);

    const tailToolIds = result.messages.filter((m) => m.role === 'tool').map((m) => m.toolCallId);

    expect(tailToolIds).toEqual(['tc-4', 'tc-5', 'tc-6']);
  });

  it('inserts a summary message before the tail', () => {
    const bigResult = 'x'.repeat(5000);
    const messages: ProviderChatMessage[] = [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'task' },
      ...makePair('search.rg', bigResult, 1),
      ...makePair('search.rg', bigResult, 2),
      ...makePair('search.rg', bigResult, 3),
      ...makePair('search.rg', bigResult, 4),
    ];

    const result = applySplitTurn(messages, 3000);
    expect(result.splitApplied).toBe(true);

    const summaryMsg = result.messages.find(
      (m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('compressed'),
    );
    expect(summaryMsg).toBeDefined();
    expect(summaryMsg?.content).toContain('search.rg');
    expect(summaryMsg?.content).toContain('In-Turn Prefix');
  });

  it('tail context does not get corrupted when context is split', () => {
    // Ensures the suffix (tail) messages preserve full fidelity
    const messages: ProviderChatMessage[] = [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'task' },
      ...makePair('search.rg', 'x'.repeat(4000), 1),
      ...makePair('search.rg', 'x'.repeat(4000), 2),
      ...makePair('search.rg', 'x'.repeat(4000), 3),
      ...makePair('search.rg', 'IMPORTANT_RESULT_DATA', 4),
      ...makePair('search.rg', 'RECENT_RESULT_DATA', 5),
      ...makePair('search.rg', 'NEWEST_RESULT_DATA', 6),
    ];

    const result = applySplitTurn(messages, 3000);
    expect(result.splitApplied).toBe(true);

    const rawContent = result.messages.map((m) => m.content ?? '').join('');
    expect(rawContent).toContain('IMPORTANT_RESULT_DATA');
    expect(rawContent).toContain('RECENT_RESULT_DATA');
    expect(rawContent).toContain('NEWEST_RESULT_DATA');
  });
});
