import { describe, expect, it } from 'vitest';
import {
  buildInputRenderRows,
  buildRunTimelineEntries,
  buildSessionTranscriptEntries,
  moveCursorVertical,
} from '../src/cli/tui/ink-app.js';
import type { RunTaskPayload } from '../src/core/contracts.js';
import { resolveRunModeContract } from '../src/core/mode-contracts.js';

describe('TUI flow helpers', () => {
  it('keeps greeting-only agent prompts tool-free', () => {
    const contract = resolveRunModeContract({
      mode: 'agent',
      prompt: 'hi',
    });

    expect(contract.toolNames).toEqual([]);
    expect(contract.allowToolExecution).toBe(false);
    expect(contract.providerRequest.toolChoice).toBe('none');
  });

  it('keeps non-trivial agent requests on the default agent surface with approvals', () => {
    const contract = resolveRunModeContract({
      mode: 'agent',
      prompt: 'explain how the current runtime wiring works',
    });

    expect(contract.toolPreset).toBe('agent-default');
    expect(contract.allowEdits).toBe(true);
    expect(contract.allowShell).toBe(true);
    expect(contract.confirmationPolicy).toBe('automatic-within-policy');
    expect(contract.toolNames).toContain('fs.read');
    expect(contract.toolNames).toContain('fs.edit');
    expect(contract.toolNames).toContain('shell.exec');
  });

  it('keeps russian edit requests on the default agent surface with approvals', () => {
    const contract = resolveRunModeContract({
      mode: 'agent',
      prompt:
        '\u0438\u0441\u043f\u0440\u0430\u0432\u044c \u0431\u0430\u0433 \u0438 \u043e\u0442\u0440\u0435\u0434\u0430\u043a\u0442\u0438\u0440\u0443\u0439 \u0444\u0430\u0439\u043b',
    });

    expect(contract.toolPreset).toBe('agent-default');
    expect(contract.allowEdits).toBe(true);
    expect(contract.allowShell).toBe(true);
    expect(contract.toolNames).toContain('fs.write');
    expect(contract.toolNames).toContain('shell.exec');
  });

  it('keeps web.search out of the tool contract until web mode is enabled', () => {
    const disabled = resolveRunModeContract({
      mode: 'agent',
      prompt: 'find the latest TypeScript release on the internet',
      webSearch: { enabled: false },
    });
    const enabled = resolveRunModeContract({
      mode: 'agent',
      prompt: 'find the latest TypeScript release on the internet',
      webSearch: { enabled: true, mode: 'live' },
    });

    expect(disabled.toolNames).not.toContain('web.search');
    expect(enabled.toolNames).toContain('web.search');
    expect(enabled.providerRequest.tools?.some((tool) => tool.name === 'web.search')).toBe(true);
  });

  it('moves the cursor vertically across multiline input without losing the column', () => {
    const value = 'alpha\nxy\nomega';

    expect(moveCursorVertical(value, 2, 1)).toBe(8);
    expect(moveCursorVertical(value, 8, -1)).toBe(2);
    expect(moveCursorVertical(value, 12, -1)).toBe(8);
  });

  it('renders multiline input rows with a visible cursor on the active row', () => {
    const rows = buildInputRenderRows('alpha\nbeta', 7);

    expect(rows).toEqual([
      { before: 'alpha', current: ' ', after: '', active: false },
      { before: 'b', current: 'e', after: 'ta', active: true },
    ]);
  });

  it('keeps reasoning, tool calls, and assistant text in chronological order', () => {
    const run: RunTaskPayload = {
      id: 'run-1',
      prompt: 'inspect repo',
      mode: 'agent',
      status: 'completed',
      projectPath: 'C:/repo',
      threadId: null,
      sessionId: 'session-1',
      providerProfileId: 'profile-1',
      model: 'gpt-5',
      createdAt: '2026-05-08T10:00:00.000Z',
      startedAt: '2026-05-08T10:00:00.000Z',
      finishedAt: '2026-05-08T10:00:03.000Z',
      timeLimitMs: null,
      attempt: 1,
      lastError: null,
      events: [
        {
          id: 'evt-1',
          timestamp: '2026-05-08T10:00:00.100Z',
          type: 'reasoning_delta',
          payload: { delta: 'Thinking...' },
        },
        {
          id: 'evt-2',
          timestamp: '2026-05-08T10:00:00.200Z',
          type: 'tool_call',
          payload: { name: 'fs.read', arguments: { path: 'README.md' } },
        },
        {
          id: 'evt-3',
          timestamp: '2026-05-08T10:00:00.300Z',
          type: 'tool_result',
          payload: { name: 'fs.read', status: 'completed', output: { resolvedPath: 'README.md' } },
        },
        {
          id: 'evt-4',
          timestamp: '2026-05-08T10:00:00.400Z',
          type: 'assistant_delta',
          payload: { delta: 'Found it.' },
        },
        {
          id: 'evt-5',
          timestamp: '2026-05-08T10:00:00.500Z',
          type: 'assistant_message',
          payload: { text: 'Found it.', stopReason: 'stop' },
        },
      ],
      result: {
        finalText: 'Found it.',
        finalJson: null,
        memoryCitation: null,
        check: null,
        commit: null,
      },
    };

    const entries = buildRunTimelineEntries(run);

    expect(entries.map((entry) => entry.kind)).toEqual(['thinking', 'tool-call', 'bubble']);
    expect(entries[0]).toMatchObject({ kind: 'thinking', title: 'Thinking', text: 'Thinking...' });
    expect(entries[1]).toMatchObject({
      kind: 'tool-call',
      toolName: 'fs.read',
      action: 'Reading 1 file',
      status: 'done',
      target: 'README.md',
    });
    expect(entries[2]).toMatchObject({
      kind: 'bubble',
      bubbleRole: 'assistant',
      text: 'Found it.',
    });
  });

  it('rebuilds the visible transcript from resumed session events', () => {
    const entries = buildSessionTranscriptEntries([
      {
        id: 'evt-user',
        timestamp: '2026-05-18T12:00:00.000Z',
        type: 'user_message',
        payload: { text: 'remember Moldova and EU context' },
      },
      {
        id: 'evt-tool',
        timestamp: '2026-05-18T12:00:01.000Z',
        type: 'tool_call_started',
        payload: { toolName: 'fs.read', arguments: { path: 'logs.txt' } },
      },
      {
        id: 'evt-assistant',
        timestamp: '2026-05-18T12:00:02.000Z',
        type: 'assistant_message',
        payload: { text: 'Context restored.' },
      },
    ]);

    expect(entries.map((entry) => entry.kind)).toEqual(['bubble', 'tool-call', 'bubble']);
    expect(entries[0]).toMatchObject({
      kind: 'bubble',
      bubbleRole: 'user',
      text: 'remember Moldova and EU context',
    });
    expect(entries[1]).toMatchObject({
      kind: 'tool-call',
      toolName: 'fs.read',
      action: 'Reading 1 file',
      status: 'running',
      target: 'logs.txt',
    });
    expect(entries[2]).toMatchObject({
      kind: 'bubble',
      bubbleRole: 'assistant',
      text: 'Context restored.',
    });
  });
});
