/**
 * Compression Layer (§8.3)
 * Provides utilities to condense tool outputs and prose to save tokens.
 */

export type CompressionLevel = 'off' | 'lite' | 'standard' | 'aggressive' | 'ultra';

export type CompressionOptions = {
  level: CompressionLevel;
  preserveHead?: number; // Lines to keep at the start
  preserveTail?: number; // Lines to keep at the end
};

// Lines matching these patterns are always preserved from truncated sections (§8.3 guard).
const CRITICAL_LINE_PATTERNS: RegExp[] = [
  /\bError:/,
  /\bException:/,
  /^FAIL\b/,
  /^FAILED\b/,
  /\bSyntaxError\b/,
  /\bTypeError\b/,
  /\bReferenceError\b/,
  /exit code [1-9]/i,
  /^\s+at\s+\S/, // stack trace frame
];

function isCriticalLine(line: string): boolean {
  return CRITICAL_LINE_PATTERNS.some((p) => p.test(line));
}

/**
 * RTK-style compression for machine outputs (logs, diffs, shell stdout).
 * Condenses repetitive patterns and truncates long middle sections.
 * Critical lines (errors, stack traces) are always extracted from truncated sections.
 */
export function condenseMachineOutput(text: string, options: CompressionOptions): string {
  if (options.level === 'off' || !text) return text;

  const lines = text.split('\n');
  const maxLines = resolveMaxLines(options.level);

  if (lines.length <= maxLines) return text;

  const headCount = options.preserveHead ?? Math.floor(maxLines * 0.4);
  const tailCount = options.preserveTail ?? Math.floor(maxLines * 0.4);

  const head = lines.slice(0, headCount);
  const tail = lines.slice(-tailCount);
  const truncatedSection = lines.slice(headCount, lines.length - tailCount);
  const criticalLines = truncatedSection.filter(isCriticalLine);

  const output: string[] = [...head];

  if (criticalLines.length > 0) {
    const normalTruncatedCount = truncatedSection.length - criticalLines.length;
    output.push(
      `... [TRUNCATED ${normalTruncatedCount} LINES (${options.level} mode), ${criticalLines.length} critical line(s) extracted below] ...`,
    );
    output.push(...criticalLines);
  } else {
    output.push(`... [TRUNCATED ${truncatedSection.length} LINES (${options.level} mode)] ...`);
  }

  output.push(...tail);

  return output.join('\n');
}

/**
 * Caveman-style compression for prose.
 * Strips filler words and reduces verbosity while keeping technical keywords.
 * (Basic heuristic implementation for Phase 8.3 initial version).
 */
export function condenseProse(text: string, options: CompressionOptions): string {
  if (options.level === 'off' || options.level === 'lite' || !text) return text;

  // Simple heuristic: remove common filler words if aggressive
  if (options.level === 'aggressive' || options.level === 'ultra') {
    return text
      .replace(
        /\b(actually|basically|literally|very|really|quite|kind of|sort of|just|so|then)\b/gi,
        '',
      )
      .replace(/\s+/g, ' ')
      .trim();
  }

  return text;
}

function resolveMaxLines(level: CompressionLevel): number {
  switch (level) {
    case 'lite':
      return 500;
    case 'standard':
      return 200;
    case 'aggressive':
      return 50;
    case 'ultra':
      return 20;
    default:
      return 1000;
  }
}

// ─── Search-result context compression (§8.3 backlog) ────────────────────────

export type SearchResultBucket = {
  file: string;
  matchCount: number;
  snippets: Array<{
    line: number;
    column: number;
    text: string;
    contextBefore?: string[];
    contextAfter?: string[];
  }>;
  truncated: boolean;
};

type SearchResultLike = {
  fileBuckets: SearchResultBucket[];
  totalMatchCount?: number;
  truncated?: boolean;
  truncatedFiles?: boolean;
  [key: string]: unknown;
};

function resolveSearchLimits(level: CompressionLevel): {
  maxFiles: number;
  maxSnippets: number;
  stripContext: boolean;
} {
  switch (level) {
    case 'lite':
      return { maxFiles: 30, maxSnippets: 10, stripContext: false };
    case 'standard':
      return { maxFiles: 20, maxSnippets: 5, stripContext: false };
    case 'aggressive':
      return { maxFiles: 10, maxSnippets: 3, stripContext: true };
    case 'ultra':
      return { maxFiles: 5, maxSnippets: 1, stripContext: true };
    default:
      return { maxFiles: 50, maxSnippets: 20, stripContext: false };
  }
}

/**
 * Search result compression: ranked file groups with representative snippets.
 * Preserves exact file:line:column references for all kept matches (§8.3).
 */
export function compressSearchResults(
  result: SearchResultLike,
  options: CompressionOptions,
): SearchResultLike {
  if (options.level === 'off') return result;

  const { maxFiles, maxSnippets, stripContext } = resolveSearchLimits(options.level);

  const sorted = [...result.fileBuckets].sort((a, b) => b.matchCount - a.matchCount);
  const keptFiles = sorted.slice(0, maxFiles);
  const droppedFileCount = sorted.length - keptFiles.length;

  const compressedBuckets = keptFiles.map((bucket) => {
    const keptSnippets = bucket.snippets.slice(0, maxSnippets);
    const droppedSnippets = bucket.snippets.length - keptSnippets.length;

    return {
      file: bucket.file,
      matchCount: bucket.matchCount,
      snippets: keptSnippets.map((s) => ({
        line: s.line,
        column: s.column,
        text: s.text,
        ...(stripContext ? {} : { contextBefore: s.contextBefore, contextAfter: s.contextAfter }),
      })),
      truncated: bucket.truncated || droppedSnippets > 0,
      ...(droppedSnippets > 0 ? { droppedSnippets } : {}),
    };
  });

  return {
    ...result,
    fileBuckets: compressedBuckets,
    truncatedFiles: result.truncatedFiles || droppedFileCount > 0,
    ...(droppedFileCount > 0 ? { droppedFileGroups: droppedFileCount } : {}),
  };
}

function isSearchResultLike(value: unknown): value is SearchResultLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    'fileBuckets' in value &&
    Array.isArray((value as Record<string, unknown>).fileBuckets)
  );
}

/**
 * Unified tool output compressor: applies search-specific compression for structured
 * search results; falls back to machine-output compression for plain text (§8.3).
 */
export function compressToolOutput(content: string, options: CompressionOptions): string {
  if (options.level === 'off' || !content) return content;

  try {
    const parsed = JSON.parse(content) as unknown;
    if (isSearchResultLike(parsed)) {
      return JSON.stringify(compressSearchResults(parsed, options));
    }
  } catch {
    // Not JSON; fall through to generic compression
  }

  return condenseMachineOutput(content, options);
}
