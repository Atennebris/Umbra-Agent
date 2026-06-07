import { estimateTextTokens } from './token-estimator.js';

/** Which tool or source produced this packet. */
export type ContextPacketSource = 'search.rg' | 'search.files' | 'fallback';

/** Content type for a retrieved entry — drives how the snippet was obtained. */
export type ContextPacketContentType = 'text' | 'binary' | 'unknown';

/** A single file reference within a context packet. */
export type ContextPacketEntry = {
  file: string;
  line?: number;
  column?: number;
  snippet?: string;
  matchCount?: number;
  language?: string;
  contentType?: ContextPacketContentType;
};

/**
 * Structured, token-bounded context packet produced from a large tool result.
 *
 * The raw tool output is written to the debug log; the model receives only this
 * compact form. All file:line references are preserved exactly.
 */
export type ContextPacket = {
  query: string;
  source: ContextPacketSource;
  filesConsidered: number;
  entries: ContextPacketEntry[];
  tokenEstimate: number;
  truncated: boolean;
  provenance: string;
};

/** Per-mode token caps for context packets. */
export const PACKET_TOKEN_CAP: Record<string, number> = {
  plan: 1000,
  agent: 2000,
  full: 2000,
  exec: 3000,
};

/**
 * Raw tool output exceeding this token estimate triggers compression to a packet.
 * ~1500 tokens ≈ 6 000 chars of JSON.
 */
export const SEARCH_COMPRESS_THRESHOLD_TOKENS = 1500;

// Known source-code extensions for language detection
const SUPPORTED_LANGS: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  rs: 'rust',
  go: 'go',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  cpp: 'cpp',
  c: 'c',
  cs: 'csharp',
  rb: 'ruby',
  php: 'php',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  ps1: 'powershell',
};

function detectLanguage(file: string): { language?: string; contentType: ContextPacketContentType } {
  const ext = file.split('.').pop()?.toLowerCase() ?? '';
  const language = SUPPORTED_LANGS[ext];
  return language !== undefined ? { language, contentType: 'text' } : { contentType: 'text' };
}

function isBinaryContent(text: string): boolean {
  // Heuristic: non-printable control chars (except tab, newline, CR) indicate binary
  for (let i = 0; i < Math.min(text.length, 512); i++) {
    const code = text.charCodeAt(i);
    if (code < 9 || (code > 13 && code < 32) || code === 127) return true;
  }
  return false;
}

/**
 * Compress a large `search.rg` output into a ranked ContextPacket.
 * Files are ordered by match count (most matches first).
 * The token cap is enforced; `truncated` is set true when entries are dropped.
 */
export function compressSearchRgOutput(
  output: Record<string, unknown>,
  maxTokens: number,
): ContextPacket {
  const query = typeof output.pattern === 'string' ? output.pattern : '';
  const totalMatchCount =
    typeof output.totalMatchCount === 'number' ? output.totalMatchCount : 0;
  const rawTruncated = Boolean(output.truncated);

  type FileBucket = {
    file: string;
    matchCount: number;
    snippets: Array<{ line: number; column?: number; text: string }>;
    truncated: boolean;
  };

  const fileBuckets = (
    Array.isArray(output.fileBuckets) ? output.fileBuckets : []
  ) as FileBucket[];

  // Sort by match count descending — most relevant files first
  const sorted = [...fileBuckets].sort((a, b) => b.matchCount - a.matchCount);

  const entries: ContextPacketEntry[] = [];
  let usedTokens = 0;
  let truncated = rawTruncated;

  for (const bucket of sorted) {
    const { language, contentType } = detectLanguage(bucket.file);
    const topSnippet = bucket.snippets[0];

    if (!topSnippet) {
      const lineStr = `${bucket.file}: ${bucket.matchCount} match(es)`;
      const t = estimateTextTokens(lineStr);
      if (usedTokens + t > maxTokens) {
        truncated = true;
        break;
      }
      entries.push({
        file: bucket.file,
        matchCount: bucket.matchCount,
        contentType,
        ...(language !== undefined ? { language } : {}),
      });
      usedTokens += t;
      continue;
    }

    // Binary detection: skip binary entries
    if (isBinaryContent(topSnippet.text)) {
      entries.push({ file: bucket.file, contentType: 'binary', matchCount: bucket.matchCount });
      continue;
    }

    const snippet = topSnippet.text.slice(0, 200);
    const snippetStr = `${bucket.file}:${topSnippet.line}: ${snippet}`;
    const t = estimateTextTokens(snippetStr);

    if (usedTokens + t > maxTokens) {
      truncated = true;
      break;
    }

    entries.push({
      file: bucket.file,
      line: topSnippet.line,
      ...(topSnippet.column !== undefined ? { column: topSnippet.column } : {}),
      snippet,
      matchCount: bucket.matchCount,
      contentType,
      ...(language !== undefined ? { language } : {}),
    });
    usedTokens += t;
  }

  return {
    query,
    source: 'search.rg',
    filesConsidered: fileBuckets.length,
    entries,
    tokenEstimate: usedTokens,
    truncated,
    provenance: `${totalMatchCount} match(es) across ${fileBuckets.length} file(s); ranked by match count`,
  };
}

/**
 * Compress a large `search.files` output into a ContextPacket.
 */
export function compressSearchFilesOutput(
  output: Record<string, unknown>,
  maxTokens: number,
): ContextPacket {
  type FileEntry = { path: string; kind: string };
  const files = (Array.isArray(output.files) ? output.files : []) as FileEntry[];
  const rawTruncated = Boolean(output.truncated);
  const totalScanned = typeof output.totalScanned === 'number' ? output.totalScanned : files.length;

  const entries: ContextPacketEntry[] = [];
  let usedTokens = 0;
  let truncated = rawTruncated;

  for (const f of files) {
    const { language, contentType } = detectLanguage(f.path);
    const t = estimateTextTokens(f.path);
    if (usedTokens + t > maxTokens) {
      truncated = true;
      break;
    }
    entries.push({
      file: f.path,
      contentType,
      ...(language !== undefined ? { language } : {}),
    });
    usedTokens += t;
  }

  return {
    query: typeof output.resolvedPath === 'string' ? output.resolvedPath : '',
    source: 'search.files',
    filesConsidered: files.length,
    entries,
    tokenEstimate: usedTokens,
    truncated,
    provenance: `${files.length} file(s) from ${totalScanned} scanned`,
  };
}

/**
 * Render a ContextPacket as a compact, model-readable string.
 * Preserves exact file:line references throughout.
 */
export function formatContextPacket(packet: ContextPacket): string {
  const lines: string[] = [
    `[Context packet: ${packet.source}]`,
    `Query: ${packet.query}`,
    `Files considered: ${packet.filesConsidered} | ${packet.provenance}`,
    '',
  ];

  for (const entry of packet.entries) {
    if (entry.contentType === 'binary') {
      lines.push(`${entry.file} [binary file — skipped]`);
    } else if (entry.snippet !== undefined) {
      const langTag = entry.language ? ` (${entry.language})` : '';
      lines.push(`${entry.file}:${entry.line ?? 0}:${entry.column ?? 0}:${langTag} ${entry.snippet.trim()}`);
    } else if (entry.matchCount !== undefined) {
      lines.push(`${entry.file} (${entry.matchCount} match(es))`);
    } else {
      lines.push(entry.file);
    }
  }

  if (packet.truncated) {
    lines.push(`[... truncated — ${packet.tokenEstimate} tokens used of budget]`);
  }

  return lines.join('\n');
}

/**
 * Check if a completed tool result should be compressed to a context packet.
 * Returns the replacement content string (JSON) if compression was applied, null otherwise.
 *
 * Compression is applied when:
 * - The tool is search.rg or search.files
 * - The raw output exceeds SEARCH_COMPRESS_THRESHOLD_TOKENS
 */
export function maybeCompressSearchResult(
  toolName: string,
  toolResult: { status: string; output?: unknown },
  maxPacketTokens: number,
): string | null {
  if (toolResult.status !== 'completed' || toolResult.output == null) return null;
  if (toolName !== 'search.rg' && toolName !== 'search.files') return null;

  const rawTokens = estimateTextTokens(JSON.stringify(toolResult.output));
  if (rawTokens <= SEARCH_COMPRESS_THRESHOLD_TOKENS) return null;

  const output = toolResult.output as Record<string, unknown>;
  const packet =
    toolName === 'search.rg'
      ? compressSearchRgOutput(output, maxPacketTokens)
      : compressSearchFilesOutput(output, maxPacketTokens);

  if (packet.entries.length === 0 && packet.filesConsidered > 0) {
    // Hard cap: no useful context could be selected — fail loudly
    const failPacket: ContextPacket = {
      ...packet,
      provenance: `${packet.provenance} — no entries fit within token budget (${maxPacketTokens} tokens)`,
    };
    return JSON.stringify({ status: 'completed', output: failPacket, _compressed: true });
  }

  return JSON.stringify({ status: 'completed', output: packet, _compressed: true });
}
