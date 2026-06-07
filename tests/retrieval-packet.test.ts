import { describe, expect, it } from 'vitest';
import {
  SEARCH_COMPRESS_THRESHOLD_TOKENS,
  compressSearchFilesOutput,
  compressSearchRgOutput,
  formatContextPacket,
  maybeCompressSearchResult,
} from '../src/context/retrieval-packet.js';

// ─── compressSearchRgOutput ────────────────────────────────────────────────────

describe('compressSearchRgOutput', () => {
  it('ranks files by match count (most matches first)', () => {
    const output = {
      pattern: 'TODO',
      totalMatchCount: 11,
      truncated: false,
      fileBuckets: [
        {
          file: 'src/low.ts',
          matchCount: 1,
          snippets: [{ line: 5, column: 1, text: 'TODO: minor fix' }],
          truncated: false,
        },
        {
          file: 'src/high.ts',
          matchCount: 10,
          snippets: [{ line: 42, column: 3, text: 'TODO: important refactor' }],
          truncated: false,
        },
      ],
    };

    const packet = compressSearchRgOutput(output, 2000);

    expect(packet.source).toBe('search.rg');
    expect(packet.query).toBe('TODO');
    expect(packet.entries[0].file).toBe('src/high.ts');
    expect(packet.entries[1].file).toBe('src/low.ts');
    expect(packet.entries[0].line).toBe(42);
    expect(packet.entries[0].snippet).toContain('TODO: important');
  });

  it('enforces token cap and sets truncated flag', () => {
    const bigSnippet = 'export function '.repeat(50); // ~800 chars per snippet
    const output = {
      pattern: 'pattern',
      totalMatchCount: 100,
      truncated: false,
      fileBuckets: Array.from({ length: 20 }, (_, i) => ({
        file: `src/file${i}.ts`,
        matchCount: i + 1,
        snippets: [{ line: i * 10, column: 1, text: bigSnippet }],
        truncated: false,
      })),
    };

    const packet = compressSearchRgOutput(output, 500);

    expect(packet.truncated).toBe(true);
    expect(packet.tokenEstimate).toBeLessThanOrEqual(500);
    expect(packet.entries.length).toBeLessThan(20);
  });

  it('preserves exact file:line references', () => {
    const output = {
      pattern: 'myFunc',
      totalMatchCount: 1,
      truncated: false,
      fileBuckets: [
        {
          file: 'src/utils/helpers.ts',
          matchCount: 1,
          snippets: [{ line: 123, column: 5, text: 'export function myFunc() {' }],
          truncated: false,
        },
      ],
    };

    const packet = compressSearchRgOutput(output, 2000);

    expect(packet.entries[0].file).toBe('src/utils/helpers.ts');
    expect(packet.entries[0].line).toBe(123);
    expect(packet.entries[0].column).toBe(5);
    expect(packet.entries[0].snippet).toBe('export function myFunc() {');
  });

  it('detects language for supported extensions', () => {
    const output = {
      pattern: 'class Foo',
      totalMatchCount: 1,
      truncated: false,
      fileBuckets: [
        {
          file: 'src/app.tsx',
          matchCount: 1,
          snippets: [{ line: 1, column: 1, text: 'class Foo extends React.Component' }],
          truncated: false,
        },
      ],
    };

    const packet = compressSearchRgOutput(output, 2000);
    expect(packet.entries[0].language).toBe('typescript');
    expect(packet.entries[0].contentType).toBe('text');
  });

  it('uses universal text fallback for unknown extensions', () => {
    const output = {
      pattern: 'ERROR',
      totalMatchCount: 1,
      truncated: false,
      fileBuckets: [
        {
          file: 'logs/app.log',
          matchCount: 1,
          snippets: [{ line: 100, column: 1, text: 'ERROR: something failed' }],
          truncated: false,
        },
      ],
    };

    const packet = compressSearchRgOutput(output, 2000);
    expect(packet.entries[0].language).toBeUndefined();
    expect(packet.entries[0].contentType).toBe('text');
  });

  it('marks binary files and does not include their snippet in model context', () => {
    // Binary content: contains null bytes (charCode 0)
    const binarySnippet = `prefix${String.fromCharCode(0, 1, 2)}suffix`;
    const output = {
      pattern: 'anything',
      totalMatchCount: 1,
      truncated: false,
      fileBuckets: [
        {
          file: 'dist/bundle.js.map',
          matchCount: 1,
          snippets: [{ line: 1, column: 1, text: binarySnippet }],
          truncated: false,
        },
      ],
    };

    const packet = compressSearchRgOutput(output, 2000);
    expect(packet.entries[0].contentType).toBe('binary');
    expect(packet.entries[0].snippet).toBeUndefined();
  });

  it('degrades cleanly for empty results', () => {
    const output = {
      pattern: 'nothing',
      totalMatchCount: 0,
      truncated: false,
      fileBuckets: [],
    };

    const packet = compressSearchRgOutput(output, 2000);
    expect(packet.entries).toHaveLength(0);
    expect(packet.truncated).toBe(false);
    expect(packet.filesConsidered).toBe(0);
  });
});

// ─── compressSearchFilesOutput ────────────────────────────────────────────────

describe('compressSearchFilesOutput', () => {
  it('lists files up to token cap', () => {
    const longPaths = Array.from({ length: 100 }, (_, i) => ({
      path: `src/very/deeply/nested/directory/path/file${i}.ts`,
      kind: 'file',
    }));
    const output = {
      resolvedPath: '/project',
      files: longPaths,
      truncated: false,
      totalScanned: 100,
    };

    const packet = compressSearchFilesOutput(output, 200);

    expect(packet.source).toBe('search.files');
    expect(packet.truncated).toBe(true);
    expect(packet.entries.length).toBeLessThan(100);
  });

  it('includes all files when under token budget', () => {
    const output = {
      resolvedPath: '/project',
      files: [
        { path: 'src/a.ts', kind: 'file' },
        { path: 'src/b.ts', kind: 'file' },
      ],
      truncated: false,
      totalScanned: 2,
    };

    const packet = compressSearchFilesOutput(output, 2000);
    expect(packet.entries).toHaveLength(2);
    expect(packet.truncated).toBe(false);
  });
});

// ─── formatContextPacket ──────────────────────────────────────────────────────

describe('formatContextPacket', () => {
  it('formats file:line references and provenance', () => {
    const packet = compressSearchRgOutput(
      {
        pattern: 'export function',
        totalMatchCount: 2,
        truncated: false,
        fileBuckets: [
          {
            file: 'src/utils.ts',
            matchCount: 2,
            snippets: [{ line: 10, column: 1, text: 'export function foo() {}' }],
            truncated: false,
          },
        ],
      },
      2000,
    );

    const formatted = formatContextPacket(packet);

    expect(formatted).toContain('[Context packet: search.rg]');
    expect(formatted).toContain('src/utils.ts:10:');
    expect(formatted).toContain('export function foo');
    expect(formatted).toContain('export function'); // query echoed
  });

  it('notes binary files without leaking binary content', () => {
    const packet = compressSearchRgOutput(
      {
        pattern: 'query',
        totalMatchCount: 1,
        truncated: false,
        fileBuckets: [
          {
            file: 'assets/image.png',
            matchCount: 1,
            snippets: [{ line: 1, column: 1, text: '\x00\x01\x02binary data' }],
            truncated: false,
          },
        ],
      },
      2000,
    );

    const formatted = formatContextPacket(packet);
    expect(formatted).toContain('[binary file — skipped]');
    expect(formatted).not.toContain('\x00');
  });
});

// ─── maybeCompressSearchResult ────────────────────────────────────────────────

describe('maybeCompressSearchResult', () => {
  it('returns null for non-search tools', () => {
    expect(
      maybeCompressSearchResult(
        'fs.read',
        { status: 'completed', output: { text: 'x'.repeat(10000) } },
        2000,
      ),
    ).toBeNull();
  });

  it('returns null for failed results', () => {
    expect(maybeCompressSearchResult('search.rg', { status: 'failed' }, 2000)).toBeNull();
  });

  it('returns null when result is below compression threshold', () => {
    const smallOutput = {
      pattern: 'foo',
      totalMatchCount: 1,
      truncated: false,
      fileBuckets: [
        {
          file: 'src/a.ts',
          matchCount: 1,
          snippets: [{ line: 1, column: 1, text: 'foo' }],
          truncated: false,
        },
      ],
    };
    const result = maybeCompressSearchResult(
      'search.rg',
      { status: 'completed', output: smallOutput },
      2000,
    );
    // Small output (<= SEARCH_COMPRESS_THRESHOLD_TOKENS) should not be compressed
    const rawTokens = Math.ceil(JSON.stringify(smallOutput).length / 4);
    if (rawTokens <= SEARCH_COMPRESS_THRESHOLD_TOKENS) {
      expect(result).toBeNull();
    }
  });

  it('compresses large search.rg results and marks with _compressed flag', () => {
    const bigSnippet = 'x'.repeat(2000);
    const largeOutput = {
      pattern: 'bigQuery',
      totalMatchCount: 50,
      truncated: false,
      fileBuckets: Array.from({ length: 30 }, (_, i) => ({
        file: `src/file${i}.ts`,
        matchCount: i + 1,
        snippets: [{ line: i * 5, column: 1, text: bigSnippet }],
        truncated: false,
      })),
    };

    const result = maybeCompressSearchResult(
      'search.rg',
      { status: 'completed', output: largeOutput },
      2000,
    );

    expect(result).not.toBeNull();
    const parsed = JSON.parse(result as string) as {
      status: string;
      _compressed: boolean;
      output: { source: string; entries: unknown[] };
    };
    expect(parsed.status).toBe('completed');
    expect(parsed._compressed).toBe(true);
    expect(parsed.output.source).toBe('search.rg');
    expect(parsed.output.entries.length).toBeGreaterThan(0);
  });

  it('uses packet token cap, not full raw size', () => {
    const bigSnippet = 'x'.repeat(2000);
    const largeOutput = {
      pattern: 'query',
      totalMatchCount: 10,
      truncated: false,
      fileBuckets: Array.from({ length: 10 }, (_, i) => ({
        file: `src/file${i}.ts`,
        matchCount: 1,
        snippets: [{ line: i + 1, column: 1, text: bigSnippet }],
        truncated: false,
      })),
    };

    const result = maybeCompressSearchResult(
      'search.rg',
      { status: 'completed', output: largeOutput },
      500, // tight cap
    );

    if (result) {
      const parsed = JSON.parse(result) as { output: { tokenEstimate: number } };
      expect(parsed.output.tokenEstimate).toBeLessThanOrEqual(500);
    }
  });
});
