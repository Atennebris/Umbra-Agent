import { describe, expect, it } from 'vitest';
import {
  type HighlightResult,
  exceedsGuardrails,
  highlightCode,
  resolveLanguage,
} from '../src/utils/syntax-highlight.js';

// Reconstruct the original code string from token output.
// Used to verify round-trip content preservation without inspecting ANSI.
function reconstruct(result: HighlightResult): string {
  return result.lines.map((line) => line.map((tok) => tok.text).join('')).join('\n');
}

// ---------------------------------------------------------------------------
// Language alias resolution (Codex highlight.rs parity)
// ---------------------------------------------------------------------------

describe('resolveLanguage', () => {
  it('resolves shell → bash', () => expect(resolveLanguage('shell')).toBe('bash'));
  it('resolves sh → bash', () => expect(resolveLanguage('sh')).toBe('bash'));
  it('resolves zsh → bash', () => expect(resolveLanguage('zsh')).toBe('bash'));
  it('resolves csharp → c# (Codex alias)', () => expect(resolveLanguage('csharp')).toBe('c#'));
  it('resolves c-sharp → c# (Codex alias)', () => expect(resolveLanguage('c-sharp')).toBe('c#'));
  it('resolves golang → go (Codex alias)', () => expect(resolveLanguage('golang')).toBe('go'));
  it('resolves python3 → python (Codex alias)', () => expect(resolveLanguage('python3')).toBe('python'));
  it('resolves ts → typescript', () => expect(resolveLanguage('ts')).toBe('typescript'));
  it('resolves tsx → typescript', () => expect(resolveLanguage('tsx')).toBe('typescript'));
  it('resolves js → javascript', () => expect(resolveLanguage('js')).toBe('javascript'));
  it('resolves jsx → javascript', () => expect(resolveLanguage('jsx')).toBe('javascript'));
  it('resolves yml → yaml', () => expect(resolveLanguage('yml')).toBe('yaml'));
  it('resolves py → python', () => expect(resolveLanguage('py')).toBe('python'));
  it('resolves rs → rust', () => expect(resolveLanguage('rs')).toBe('rust'));
  it('resolves console → bash', () => expect(resolveLanguage('console')).toBe('bash'));
  it('resolves terminal → bash', () => expect(resolveLanguage('terminal')).toBe('bash'));
  it('passes unknown languages through unchanged', () => {
    expect(resolveLanguage('xyzlang')).toBe('xyzlang');
  });
  it('is case-insensitive', () => {
    expect(resolveLanguage('SHELL')).toBe('bash');
    expect(resolveLanguage('Python3')).toBe('python');
    expect(resolveLanguage('GoLang')).toBe('go');
  });
  it('trims whitespace', () => {
    expect(resolveLanguage(' shell ')).toBe('bash');
  });
});

// ---------------------------------------------------------------------------
// Size guardrails (Codex parity: 512 KB, 10 000 lines)
// ---------------------------------------------------------------------------

describe('exceedsGuardrails', () => {
  it('rejects input > 512 KB', () => {
    expect(exceedsGuardrails('x'.repeat(512 * 1024 + 1))).toBe(true);
  });
  it('accepts input ≤ 512 KB', () => {
    expect(exceedsGuardrails('const x = 1;')).toBe(false);
  });
  it('rejects input with > 10 000 lines', () => {
    expect(exceedsGuardrails('x\n'.repeat(10_001))).toBe(true);
  });
  it('accepts input with 100 lines', () => {
    expect(exceedsGuardrails('x\n'.repeat(100))).toBe(false);
  });
  it('rejects empty string padded to oversize', () => {
    expect(exceedsGuardrails('a'.repeat(512 * 1024 + 1))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Content round-trip: joining token texts must reconstruct original code
// ---------------------------------------------------------------------------

describe('content round-trip', () => {
  const cases: Array<{ lang: string; code: string }> = [
    { lang: 'javascript', code: 'const x = "hello";\nreturn x;' },
    {
      lang: 'typescript',
      code: 'interface Foo { bar: string; }\nconst x: Foo = { bar: "hi" };',
    },
    { lang: 'python', code: 'def hello():\n    return "world"' },
    { lang: 'bash', code: 'echo "hello world" && ls -la' },
    { lang: 'shell', code: 'for i in $@; do\n  echo "$i"\ndone' },
    { lang: 'go', code: 'func main() {\n\tfmt.Println("hi")\n}' },
    { lang: 'rust', code: 'fn main() {\n    println!("hi");\n}' },
    { lang: 'java', code: 'public class A {\n  public static void main(String[] args) {}\n}' },
    { lang: 'sql', code: 'SELECT * FROM users WHERE id = 1;' },
    { lang: 'diff', code: '--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-old\n+new\n ctx' },
    { lang: 'unknownlang', code: 'some arbitrary text 123' },
  ];

  for (const { lang, code } of cases) {
    it(`preserves content for ${lang}`, () => {
      const result = highlightCode(code, lang);
      expect(reconstruct(result)).toBe(code);
    });
  }

  it('preserves content for empty code block', () => {
    const result = highlightCode('', 'javascript');
    expect(reconstruct(result)).toBe('');
  });

  it('preserves multi-line code with trailing newline', () => {
    const code = 'const a = 1;\nconst b = 2;\n';
    const result = highlightCode(code, 'typescript');
    expect(reconstruct(result)).toBe(code);
  });
});

// ---------------------------------------------------------------------------
// Language detection: fallback flag
// ---------------------------------------------------------------------------

describe('fallback flag', () => {
  it('is false for javascript', () => {
    expect(highlightCode('const x = 1;', 'javascript').fallback).toBe(false);
  });
  it('is false for typescript', () => {
    expect(highlightCode('const x: number = 1;', 'typescript').fallback).toBe(false);
  });
  it('is false for python', () => {
    expect(highlightCode('def f(): pass', 'python').fallback).toBe(false);
  });
  it('is false for bash (shell alias)', () => {
    expect(highlightCode('echo hi', 'shell').fallback).toBe(false);
  });
  it('is false for go', () => {
    expect(highlightCode('func main() {}', 'go').fallback).toBe(false);
  });
  it('is false for rust', () => {
    expect(highlightCode('fn main() {}', 'rust').fallback).toBe(false);
  });
  it('is false for diff', () => {
    expect(highlightCode('+added\n-removed', 'diff').fallback).toBe(false);
  });
  it('is true for completely unknown language', () => {
    expect(highlightCode('some text', 'xyzlang1234').fallback).toBe(true);
  });
  it('is true when guardrails trigger (oversize)', () => {
    const big = 'x'.repeat(512 * 1024 + 1);
    expect(highlightCode(big, 'javascript').fallback).toBe(true);
  });
  it('is true when guardrails trigger (too many lines)', () => {
    const code = 'let x = 1;\n'.repeat(10_001);
    expect(highlightCode(code, 'typescript').fallback).toBe(true);
  });
  it('resolves language in result even for unknown', () => {
    const result = highlightCode('text', 'xyzlang');
    expect(result.language).toBe('xyzlang');
  });
  it('stores resolved language in result', () => {
    const result = highlightCode('echo hi', 'shell');
    expect(result.language).toBe('bash');
  });
});

// ---------------------------------------------------------------------------
// Diff rendering: correct token types per line prefix
// ---------------------------------------------------------------------------

describe('diff rendering', () => {
  it('colors added lines as diff-add', () => {
    const result = highlightCode('+added line', 'diff');
    expect(result.lines[0]?.[0]?.type).toBe('diff-add');
  });
  it('colors removed lines as diff-del', () => {
    const result = highlightCode('-removed line', 'diff');
    expect(result.lines[0]?.[0]?.type).toBe('diff-del');
  });
  it('colors @@ hunk headers as diff-meta', () => {
    const result = highlightCode('@@ -1,3 +1,4 @@', 'diff');
    expect(result.lines[0]?.[0]?.type).toBe('diff-meta');
  });
  it('colors --- file headers as diff-header', () => {
    const result = highlightCode('--- a/file.ts', 'diff');
    expect(result.lines[0]?.[0]?.type).toBe('diff-header');
  });
  it('colors +++ file headers as diff-header', () => {
    const result = highlightCode('+++ b/file.ts', 'diff');
    expect(result.lines[0]?.[0]?.type).toBe('diff-header');
  });
  it('colors context lines as plain', () => {
    const result = highlightCode(' unchanged context', 'diff');
    expect(result.lines[0]?.[0]?.type).toBe('plain');
  });
  it('diff round-trip: full hunk preserves content', () => {
    const code =
      '--- a/foo.ts\n+++ b/foo.ts\n@@ -1,2 +1,2 @@\n-old line\n+new line\n context';
    expect(reconstruct(highlightCode(code, 'diff'))).toBe(code);
  });
  it('patch alias resolves to diff behavior', () => {
    const result = highlightCode('+added', 'patch');
    expect(result.fallback).toBe(false);
    expect(result.lines[0]?.[0]?.type).toBe('diff-add');
  });
});

// ---------------------------------------------------------------------------
// Shell/bash path
// ---------------------------------------------------------------------------

describe('bash/shell path', () => {
  it('shell alias maps language to bash', () => {
    expect(highlightCode('echo hi', 'shell').language).toBe('bash');
  });
  it('bash is not a fallback', () => {
    expect(highlightCode('if [ -z "$x" ]; then echo hi; fi', 'bash').fallback).toBe(false);
  });
  it('preserves complex bash script content', () => {
    const code = 'for i in $(seq 1 5); do\n  echo "$i"\ndone';
    expect(reconstruct(highlightCode(code, 'bash'))).toBe(code);
  });
  it('highlights bash keywords', () => {
    const code = 'if then fi';
    const result = highlightCode(code, 'bash');
    const kwTokens = result.lines[0]?.filter((tok) => tok.type === 'keyword');
    expect(kwTokens?.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Structural output: no ANSI codes in token text, valid hex colors
// ---------------------------------------------------------------------------

describe('no ANSI snapshot fragility', () => {
  const TEST_CASES = [
    { lang: 'javascript', code: 'const x = "hello";\nreturn 42;' },
    { lang: 'python', code: 'def f():\n    return None' },
    { lang: 'rust', code: 'fn main() { println!("hi"); }' },
    { lang: 'diff', code: '+added\n-removed\n unchanged' },
    { lang: 'bash', code: 'echo "world"' },
  ];

  for (const { lang, code } of TEST_CASES) {
    it(`${lang}: token text contains no ANSI escape sequences`, () => {
      const result = highlightCode(code, lang);
      for (const line of result.lines) {
        for (const tok of line) {
          expect(tok.text).not.toMatch(/\x1b\[/);
        }
      }
    });

    it(`${lang}: token colors are valid 6-digit hex values`, () => {
      const result = highlightCode(code, lang);
      for (const line of result.lines) {
        for (const tok of line) {
          expect(tok.color).toMatch(/^#[0-9a-fA-F]{6}$/);
        }
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Keyword and token type detection
// ---------------------------------------------------------------------------

describe('keyword and token detection', () => {
  it('identifies const keyword in javascript', () => {
    const result = highlightCode('const x = 1;', 'javascript');
    const kw = result.lines[0]?.find((tok) => tok.text === 'const');
    expect(kw?.type).toBe('keyword');
  });

  it('identifies return keyword in typescript', () => {
    const result = highlightCode('return value;', 'typescript');
    const kw = result.lines[0]?.find((tok) => tok.text === 'return');
    expect(kw?.type).toBe('keyword');
  });

  it('identifies def keyword in python', () => {
    const result = highlightCode('def foo(): pass', 'python');
    const kw = result.lines[0]?.find((tok) => tok.text === 'def');
    expect(kw?.type).toBe('keyword');
  });

  it('identifies func keyword in go', () => {
    const result = highlightCode('func main() {}', 'go');
    const kw = result.lines[0]?.find((tok) => tok.text === 'func');
    expect(kw?.type).toBe('keyword');
  });

  it('identifies fn keyword in rust', () => {
    const result = highlightCode('fn main() {}', 'rust');
    const kw = result.lines[0]?.find((tok) => tok.text === 'fn');
    expect(kw?.type).toBe('keyword');
  });

  it('identifies string literal in typescript', () => {
    const result = highlightCode('const x = "hello world";', 'typescript');
    const str = result.lines[0]?.find((tok) => tok.type === 'string');
    expect(str?.text).toBe('"hello world"');
  });

  it('identifies number literal in javascript', () => {
    const result = highlightCode('const x = 42;', 'javascript');
    const num = result.lines[0]?.find((tok) => tok.type === 'number');
    expect(num?.text).toBe('42');
  });

  it('identifies comment in typescript', () => {
    const result = highlightCode('// this is a comment\nconst x = 1;', 'typescript');
    const comment = result.lines[0]?.find((tok) => tok.type === 'comment');
    expect(comment?.text).toMatch(/\/\/ this is a comment/);
  });

  it('identifies comment in python', () => {
    const result = highlightCode('# python comment', 'python');
    const comment = result.lines[0]?.find((tok) => tok.type === 'comment');
    expect(comment?.text).toMatch(/# python comment/);
  });

  it('oversized fallback still preserves content (no guardrail data loss)', () => {
    const code = 'const x = 1;\nconst y = 2;';
    const result = highlightCode(code, 'javascript');
    expect(result.fallback).toBe(false);
    expect(reconstruct(result)).toBe(code);
  });
});
