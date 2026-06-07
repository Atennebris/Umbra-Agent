import { describe, expect, it } from 'vitest';
import {
  type SearchResultBucket,
  compressSearchResults,
  compressToolOutput,
  condenseMachineOutput,
  condenseProse,
} from '../src/utils/compression.js';

describe('Compression Layer', () => {
  describe('condenseMachineOutput', () => {
    it('does nothing if level is off', () => {
      const text = 'line 1\nline 2\nline 3';
      expect(condenseMachineOutput(text, { level: 'off' })).toBe(text);
    });

    it('truncates middle if lines exceed max', () => {
      const text = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n');
      const result = condenseMachineOutput(text, { level: 'aggressive' });

      expect(result).toContain('TRUNCATED');
      expect(result.split('\n').length).toBeLessThan(100);
      expect(result.startsWith('line 1\n')).toBe(true);
      expect(result.endsWith('\nline 100')).toBe(true);
    });

    // §8.12 golden tests — critical lines must survive truncation
    it('preserves Error lines from truncated middle (golden)', () => {
      const lines = [
        ...Array.from({ length: 30 }, (_, i) => `INFO: log line ${i + 1}`),
        'Error: Test suite failed to run',
        'TypeError: Cannot read properties of undefined (reading "id")',
        '    at Object.<anonymous> (/project/src/core/agent.ts:42:10)',
        ...Array.from({ length: 30 }, (_, i) => `INFO: more log ${i + 1}`),
      ];
      const result = condenseMachineOutput(lines.join('\n'), { level: 'aggressive' });

      expect(result).toContain('Error: Test suite failed to run');
      expect(result).toContain('TypeError: Cannot read properties of undefined');
      expect(result).toContain('at Object.<anonymous>');
      // Non-critical middle lines must be truncated
      expect(result).toContain('TRUNCATED');
      expect(result.split('\n').length).toBeLessThan(lines.length);
    });

    it('preserves FAIL / FAILED markers from truncated middle (golden)', () => {
      const lines = [
        ...Array.from({ length: 30 }, (_, i) => `PASS: test ${i + 1}`),
        'FAIL src/core/agent-runtime.test.ts',
        'FAILED: 1 test suite failed',
        ...Array.from({ length: 30 }, (_, i) => `PASS: test ${i + 31}`),
      ];
      const result = condenseMachineOutput(lines.join('\n'), { level: 'aggressive' });

      expect(result).toContain('FAIL src/core/agent-runtime.test.ts');
      expect(result).toContain('FAILED: 1 test suite failed');
    });

    it('does not emit critical section header when no critical lines exist', () => {
      const text = Array.from({ length: 60 }, (_, i) => `INFO: normal line ${i + 1}`).join('\n');
      const result = condenseMachineOutput(text, { level: 'aggressive' });

      expect(result).toContain('TRUNCATED');
      expect(result).not.toContain('critical line');
    });

    it('short output below threshold is never truncated', () => {
      const text = Array.from({ length: 5 }, (_, i) => `line ${i + 1}`).join('\n');
      expect(condenseMachineOutput(text, { level: 'aggressive' })).toBe(text);
    });
  });

  describe('condenseProse', () => {
    it('strips filler words on aggressive level', () => {
      const text = 'Basically, I just wanted to say that it is actually quite nice.';
      const result = condenseProse(text, { level: 'aggressive' });

      expect(result).not.toContain('Basically');
      expect(result).not.toContain('actually');
      expect(result).toContain('nice');
    });

    it('does nothing on lite level', () => {
      const text = 'Basically, I just wanted to say that it is actually quite nice.';
      expect(condenseProse(text, { level: 'lite' })).toBe(text);
    });
  });
});

// ─── Search-result compression (§8.3 backlog) ────────────────────────────────

function makeSearchResult(fileCount: number, snippetsPerFile: number) {
  const fileBuckets: SearchResultBucket[] = Array.from({ length: fileCount }, (_, i) => ({
    file: `src/file${i + 1}.ts`,
    matchCount: fileCount - i,
    snippets: Array.from({ length: snippetsPerFile }, (__, j) => ({
      line: j + 1,
      column: 1,
      text: `match line ${j + 1} in file ${i + 1}`,
      contextBefore: ['ctx before'],
      contextAfter: ['ctx after'],
    })),
    truncated: false,
  }));
  return { fileBuckets, totalMatchCount: fileCount * snippetsPerFile, pattern: 'foo' };
}

describe('compressSearchResults', () => {
  it('returns unchanged result on level off', () => {
    const result = makeSearchResult(3, 5);
    expect(compressSearchResults(result, { level: 'off' })).toBe(result);
  });

  it('ranks files by matchCount descending', () => {
    const result = makeSearchResult(5, 2);
    const compressed = compressSearchResults(result, { level: 'standard' });
    const matchCounts = compressed.fileBuckets.map((b) => b.matchCount);
    expect(matchCounts).toEqual([...matchCounts].sort((a, b) => b - a));
  });

  it('limits file count per level', () => {
    const result = makeSearchResult(30, 2);
    const aggressive = compressSearchResults(result, { level: 'aggressive' });
    expect(aggressive.fileBuckets.length).toBeLessThanOrEqual(10);

    const ultra = compressSearchResults(result, { level: 'ultra' });
    expect(ultra.fileBuckets.length).toBeLessThanOrEqual(5);
  });

  it('limits snippets per file per level', () => {
    const result = makeSearchResult(3, 20);
    const aggressive = compressSearchResults(result, { level: 'aggressive' });
    for (const bucket of aggressive.fileBuckets) {
      expect(bucket.snippets.length).toBeLessThanOrEqual(3);
    }

    const ultra = compressSearchResults(result, { level: 'ultra' });
    for (const bucket of ultra.fileBuckets) {
      expect(bucket.snippets.length).toBeLessThanOrEqual(1);
    }
  });

  it('preserves exact file:line:column references in kept snippets', () => {
    const result = makeSearchResult(2, 5);
    const compressed = compressSearchResults(result, { level: 'aggressive' });
    for (const bucket of compressed.fileBuckets) {
      for (const snippet of bucket.snippets) {
        expect(typeof snippet.line).toBe('number');
        expect(typeof snippet.column).toBe('number');
        expect(typeof snippet.text).toBe('string');
      }
    }
  });

  it('strips context lines in aggressive mode', () => {
    const result = makeSearchResult(2, 3);
    const compressed = compressSearchResults(result, { level: 'aggressive' });
    for (const bucket of compressed.fileBuckets) {
      for (const snippet of bucket.snippets) {
        expect(snippet.contextBefore).toBeUndefined();
        expect(snippet.contextAfter).toBeUndefined();
      }
    }
  });

  it('keeps context lines in standard mode', () => {
    const result = makeSearchResult(2, 3);
    const compressed = compressSearchResults(result, { level: 'standard' });
    for (const bucket of compressed.fileBuckets) {
      for (const snippet of bucket.snippets) {
        expect(snippet.contextBefore).toBeDefined();
        expect(snippet.contextAfter).toBeDefined();
      }
    }
  });

  it('marks truncatedFiles when files are dropped', () => {
    const result = makeSearchResult(20, 1);
    const compressed = compressSearchResults(result, { level: 'ultra' });
    expect(compressed.truncatedFiles).toBe(true);
    expect(compressed.fileBuckets.length).toBeLessThan(20);
  });
});

describe('compressToolOutput', () => {
  it('applies search compression to JSON search results', () => {
    const result = makeSearchResult(20, 10);
    const json = JSON.stringify(result);
    const compressed = compressToolOutput(json, { level: 'aggressive' });
    const parsed = JSON.parse(compressed) as { fileBuckets: unknown[] };
    expect(parsed.fileBuckets.length).toBeLessThanOrEqual(10);
  });

  it('falls back to machine-output compression for plain text', () => {
    const text = Array.from({ length: 100 }, (_, i) => `log line ${i}`).join('\n');
    const compressed = compressToolOutput(text, { level: 'aggressive' });
    expect(compressed).toContain('TRUNCATED');
    expect(compressed.split('\n').length).toBeLessThan(100);
  });

  it('returns content unchanged when level is off', () => {
    const text = 'some output';
    expect(compressToolOutput(text, { level: 'off' })).toBe(text);
  });
});
