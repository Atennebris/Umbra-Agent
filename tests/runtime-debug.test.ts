import { describe, expect, it } from 'vitest';
import { formatDebugEvent } from '../src/debug/runtime-debug.js';

describe('formatDebugEvent', () => {
  it('renders object payloads inline instead of [object Object]', () => {
    const rendered = formatDebugEvent({
      timestamp: '2026-05-18T10:00:00.000Z',
      component: 'provider',
      level: 'info',
      message: 'incoming llm response',
      data: {
        requestId: 'req-1',
        tokens: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      },
    });

    expect(rendered).toContain('requestId=req-1');
    expect(rendered).toContain('tokens={"inputTokens":10,"outputTokens":5,"totalTokens":15}');
    expect(rendered).not.toContain('[object Object]');
  });
});
