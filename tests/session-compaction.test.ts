import { describe, expect, it } from 'vitest';
import { buildSessionWindow, compactSessionEvents } from '../src/context/session-compact.js';
import { estimateTextTokens } from '../src/context/token-estimator.js';

describe('session compaction snapshots', () => {
  it('estimates tokens deterministically', () => {
    const text = 'Umbra CLI is a local AI agent orchestrator.';
    const tokens = estimateTextTokens(text);
    expect({ text, tokens }).toMatchSnapshot();
  });

  it('compacts events with a deterministic summary', () => {
    const events = [
      {
        id: 'evt-1',
        type: 'user_message',
        timestamp: '2026-05-14T09:00:00.000Z',
        payload: { text: 'How do I setup Tree-sitter?' },
      },
      {
        id: 'evt-2',
        type: 'assistant_message',
        timestamp: '2026-05-14T09:00:05.000Z',
        payload: { text: 'Use the `tree-sitter-runtime.ts` module.' },
      },
      {
        id: 'evt-3',
        type: 'command_finished',
        timestamp: '2026-05-14T09:00:10.000Z',
        payload: { command: 'npm install', exitCode: 0, stdout: 'success' },
      },
    ];

    const compacted = compactSessionEvents(events, {
      instructions: 'Focus on technical setup.',
      maxRecentEvents: 1,
    });

    // Stability: normalize volatile values if any (though here they should be stable)
    expect(compacted).toMatchSnapshot();
  });

  it('produces iterative UPDATE summary when previous compaction exists', () => {
    const events = [
      {
        id: 'evt-prev',
        type: 'session_compacted',
        timestamp: '2026-05-14T08:00:00.000Z',
        payload: { summary: '# Session Compact\n## Goals\n- set up tree-sitter' },
      },
      {
        id: 'evt-u2',
        type: 'user_message',
        timestamp: '2026-05-14T09:00:00.000Z',
        payload: { text: 'Now configure the LSP server' },
      },
      {
        id: 'evt-a2',
        type: 'tool_result',
        timestamp: '2026-05-14T09:00:10.000Z',
        payload: { text: 'LSP server configured' },
      },
    ];

    const result = compactSessionEvents(events, { maxRecentEvents: 1 });
    expect(result.summary).toContain('# Session Update');
    expect(result.summary).toContain('## Previous Summary');
    expect(result.summary).toContain('## New Progress');
    expect(result).toMatchSnapshot();
  });

  it('builds a stable session window', () => {
    const events = [
      {
        id: 'evt-c',
        type: 'session_compacted',
        timestamp: '2026-05-14T09:05:00.000Z',
        payload: { summary: 'Previous session summarized here.' },
      },
      {
        id: 'evt-u',
        type: 'user_message',
        timestamp: '2026-05-14T09:06:00.000Z',
        payload: { text: 'What was the last step?' },
      },
    ];

    const window = buildSessionWindow(events, 2);
    expect(window).toMatchSnapshot();
  });
});
