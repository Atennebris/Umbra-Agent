import { estimateJsonTokens, estimateTextTokens } from './token-estimator.js';

export type CompactableSessionEvent = {
  id: string;
  type: string;
  timestamp: string;
  payload: Record<string, unknown>;
};

export type SessionWindow = {
  summary: string | null;
  recentEvents: CompactableSessionEvent[];
};

export type SessionCompactionResult = {
  summary: string;
  oldTokens: number;
  newTokens: number;
  compactedEventCount: number;
  recentEventCount: number;
};

type CompactionOptions = {
  instructions?: string;
  maxRecentEvents?: number;
};

export function buildSessionWindow(
  events: CompactableSessionEvent[],
  maxRecentEvents = 6,
): SessionWindow {
  const lastCompaction = [...events].reverse().find((event) => event.type === 'session_compacted');

  if (lastCompaction) {
    const summary =
      typeof lastCompaction.payload.summary === 'string' ? lastCompaction.payload.summary : null;
    const recentEvents = events
      .filter((event) => event.timestamp > lastCompaction.timestamp)
      .slice(-maxRecentEvents);

    return {
      summary,
      recentEvents,
    };
  }

  return {
    summary: null,
    recentEvents: events.slice(-maxRecentEvents),
  };
}

export function compactSessionEvents(
  events: CompactableSessionEvent[],
  options: CompactionOptions = {},
): SessionCompactionResult {
  const maxRecentEvents = options.maxRecentEvents ?? 6;
  const retainedEvents = events.slice(-maxRecentEvents);
  const compactedEvents = events.slice(0, Math.max(0, events.length - retainedEvents.length));

  // Extract previous summary for iterative compaction (UPDATE mode)
  const previousCompaction = [...compactedEvents]
    .reverse()
    .find((e) => e.type === 'session_compacted');
  const previousSummary =
    previousCompaction && typeof previousCompaction.payload.summary === 'string'
      ? previousCompaction.payload.summary
      : null;

  const summary = renderSessionSummary(compactedEvents, retainedEvents, options, previousSummary);
  const oldTokens = estimateJsonTokens(events);
  const newTokens = estimateTextTokens(summary) + estimateJsonTokens(retainedEvents);

  return {
    summary,
    oldTokens,
    newTokens,
    compactedEventCount: compactedEvents.length,
    recentEventCount: retainedEvents.length,
  };
}

function renderSessionSummary(
  compactedEvents: CompactableSessionEvent[],
  retainedEvents: CompactableSessionEvent[],
  options: CompactionOptions,
  previousSummary: string | null,
): string {
  const goals = compactedEvents
    .filter((e) => e.type === 'user_message')
    .map((e) => readPayloadText(e.payload))
    .filter(Boolean)
    .slice(-5);

  const files = new Set<string>();
  const failures: string[] = [];
  const doneItems: string[] = [];

  for (const event of compactedEvents) {
    for (const file of readPayloadFiles(event.payload)) {
      files.add(file);
    }
    if (event.type === 'tool_result') {
      const txt = readPayloadText(event.payload);
      if (txt.length > 0) doneItems.push(txt.slice(0, 80));
    }
    if (event.type.includes('failed') || event.type === 'error') {
      const msg = readPayloadText(event.payload);
      if (msg) failures.push(msg);
    }
  }

  const recentTail = retainedEvents
    .map((e) => `${e.type}: ${readPayloadText(e.payload)}`.trim())
    .filter((line) => !line.endsWith(':'))
    .slice(-4);

  const noteSection = options.instructions ? `- Note: ${options.instructions.trim()}` : null;

  if (previousSummary) {
    // UPDATE mode: iterative compaction — build on top of previous summary
    return [
      '# Session Update',
      '## Previous Summary',
      previousSummary,
      '## New Progress',
      `- Goals: ${goals.slice(-2).join(' | ') || 'none'}`,
      doneItems.length > 0 ? `- Completed: ${doneItems.slice(-3).join(' | ')}` : null,
      files.size > 0 ? `- Files touched: ${Array.from(files).slice(0, 8).join(' | ')}` : null,
      failures.length > 0 ? `- Failures: ${failures.slice(-2).join(' | ')}` : null,
      recentTail.length > 0 ? `- Preserved tail: ${recentTail.join(' | ')}` : null,
      noteSection,
    ]
      .filter((line): line is string => line !== null)
      .join('\n');
  }

  // INITIAL mode: first compaction — structured summary with sections
  return [
    '# Session Compact',
    '## Goals',
    goals.length > 0 ? goals.map((g) => `- ${g.slice(0, 120)}`).join('\n') : '- none',
    '## Progress',
    doneItems.length > 0 ? `- Done: ${doneItems.slice(-4).join(' | ')}` : '- Done: none',
    files.size > 0 ? `- Files: ${Array.from(files).slice(0, 8).join(' | ')}` : '- Files: none',
    failures.length > 0 ? `- Failures: ${failures.slice(-3).join(' | ')}` : null,
    '## Next Steps',
    recentTail.length > 0
      ? `- Preserved tail: ${recentTail.join(' | ')}`
      : '- Preserved tail: none',
    noteSection,
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
}

function readPayloadText(payload: Record<string, unknown>): string {
  if (typeof payload.text === 'string') {
    return payload.text.trim();
  }

  if (typeof payload.error === 'string') {
    return payload.error.trim();
  }

  if (typeof payload.stderr === 'string') {
    return payload.stderr.trim();
  }

  if (typeof payload.summary === 'string') {
    return payload.summary.trim();
  }

  return '';
}

function readPayloadFiles(payload: Record<string, unknown>): string[] {
  const collected: string[] = [];
  const fileReferences = payload.fileReferences;
  const droppedPaths = payload.droppedPaths;

  if (Array.isArray(fileReferences)) {
    for (const value of fileReferences) {
      if (typeof value === 'string') {
        collected.push(value);
      }
    }
  }

  if (Array.isArray(droppedPaths)) {
    for (const value of droppedPaths) {
      if (typeof value === 'string') {
        collected.push(value);
      }
    }
  }

  return collected;
}
