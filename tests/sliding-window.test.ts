/**
 * Unit tests for slideMessageWindow — context window framing helper.
 * Validates that the system message is preserved, old messages are dropped
 * when over budget, and hardStop is set when the payload is too large to trim.
 */
import { describe, expect, it } from 'vitest';
import { slideMessageWindow } from '../src/core/agent-runtime.js';
import type { ProviderChatMessage } from '../src/providers/index.js';

function makeMessages(count: number, role: 'user' | 'assistant' = 'user'): ProviderChatMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    role,
    content: `message ${i}`,
  }));
}

describe('slideMessageWindow', () => {
  it('returns messages unchanged when under budget', () => {
    const msgs: ProviderChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hello' },
    ];
    const result = slideMessageWindow(msgs, 100_000);
    expect(result.dropped).toBe(0);
    expect(result.hardStop).toBe(false);
    expect(result.messages).toHaveLength(2);
  });

  it('drops oldest non-system messages when over budget', () => {
    const bigContent = 'x'.repeat(10_000);
    const msgs: ProviderChatMessage[] = [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: bigContent },
      { role: 'assistant', content: bigContent },
      { role: 'user', content: bigContent },
      { role: 'user', content: 'short' },
    ];
    // budget: just enough for system + "short" last message but not all 4
    const budget = JSON.stringify([msgs[0], msgs[msgs.length - 1]]).length * 2;
    const result = slideMessageWindow(msgs, budget);
    expect(result.dropped).toBeGreaterThan(0);
    expect(result.hardStop).toBe(false);
    // system message always preserved
    expect(result.messages[0]?.role).toBe('system');
    // last message should be preserved
    expect(result.messages.at(-1)?.content).toBe('short');
  });

  it('always preserves system message', () => {
    const bigContent = 'x'.repeat(2_000);
    const msgs: ProviderChatMessage[] = [
      { role: 'system', content: 'instructions' },
      { role: 'user', content: bigContent },
      { role: 'assistant', content: bigContent },
    ];
    const budget = JSON.stringify([msgs[0]]).length + 50;
    const result = slideMessageWindow(msgs, budget);
    expect(result.messages[0]?.role).toBe('system');
  });

  it('sets hardStop when even system-only payload exceeds budget', () => {
    const hugeSys: ProviderChatMessage = {
      role: 'system',
      content: 'x'.repeat(100_000),
    };
    const result = slideMessageWindow([hugeSys], 100);
    expect(result.hardStop).toBe(true);
  });

  it('works with no system message — drops from the front', () => {
    const bigContent = 'x'.repeat(5_000);
    const msgs: ProviderChatMessage[] = [
      { role: 'user', content: bigContent },
      { role: 'assistant', content: bigContent },
      { role: 'user', content: 'final' },
    ];
    const budget = JSON.stringify([{ role: 'user', content: 'final' }]).length + 50;
    const result = slideMessageWindow(msgs, budget);
    expect(result.dropped).toBeGreaterThan(0);
    expect(result.messages.at(-1)?.content).toBe('final');
  });

  it('returns dropped=0 for empty message array', () => {
    const result = slideMessageWindow([], 10_000);
    expect(result.dropped).toBe(0);
    expect(result.hardStop).toBe(false);
    expect(result.messages).toHaveLength(0);
  });
});
