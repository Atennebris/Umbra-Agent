// Shared syntax highlighting engine for TUI code blocks.
// Returns HighlightToken[][] (per-line spans) for Ink <Text color> rendering.
// No ANSI strings emitted — callers receive hex color codes.

export type TokenType =
  | 'keyword'
  | 'string'
  | 'comment'
  | 'number'
  | 'operator'
  | 'function'
  | 'type-name'
  | 'diff-add'
  | 'diff-del'
  | 'diff-meta'
  | 'diff-header'
  | 'plain';

export type HighlightToken = { text: string; color: string; type: TokenType };
export type HighlightLine = HighlightToken[];

export interface HighlightResult {
  lines: HighlightLine[];
  language: string;
  fallback: boolean;
}

// -- Guardrail constants -------------------------------------------------------

const MAX_BYTES = 512 * 1024;
const MAX_LINES = 10_000;

// -- Language aliases ----------------------------------------------------------

const LANGUAGE_ALIASES: Record<string, string> = {
  shell: 'bash',
  sh: 'bash',
  zsh: 'bash',
  csharp: 'c#',
  'c-sharp': 'c#',
  golang: 'go',
  python3: 'python',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  js: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  yml: 'yaml',
  md: 'markdown',
  docker: 'dockerfile',
  console: 'bash',
  terminal: 'bash',
  'c++': 'cpp',
  ps1: 'powershell',
  psm1: 'powershell',
};

// -- Token colors (Umbra theme hex values) -------------------------------------

const COLOR: Record<string, string> = {
  keyword: '#a78bfa',
  string: '#34d69a',
  comment: '#6b618a',
  number: '#f59e0b',
  operator: '#6d4fc7',
  function: '#38bdf8',
  typeName: '#e879f9',
  diffAdd: '#34d69a',
  diffDel: '#fb7185',
  diffMeta: '#a78bfa',
  diffHead: '#6b618a',
  plain: '#e2d9f3',
};

function colorFor(type: TokenType): string {
  switch (type) {
    case 'keyword': return COLOR['keyword']!;
    case 'string': return COLOR['string']!;
    case 'comment': return COLOR['comment']!;
    case 'number': return COLOR['number']!;
    case 'operator': return COLOR['operator']!;
    case 'function': return COLOR['function']!;
    case 'type-name': return COLOR['typeName']!;
    case 'diff-add': return COLOR['diffAdd']!;
    case 'diff-del': return COLOR['diffDel']!;
    case 'diff-meta': return COLOR['diffMeta']!;
    case 'diff-header': return COLOR['diffHead']!;
    case 'plain': return COLOR['plain']!;
  }
}

// -- Keyword sets per language -------------------------------------------------

const KEYWORDS: Record<string, string[]> = {
  javascript: [
    'const', 'let', 'var', 'function', 'return', 'if', 'else', 'class',
    'import', 'export', 'default', 'async', 'await', 'for', 'while', 'do',
    'break', 'continue', 'typeof', 'instanceof', 'new', 'delete', 'this',
    'super', 'null', 'undefined', 'true', 'false', 'try', 'catch', 'finally',
    'throw', 'switch', 'case', 'of', 'in', 'from', 'extends', 'static',
    'yield', 'void', 'with', 'debugger',
  ],
  typescript: [
    'const', 'let', 'var', 'function', 'return', 'if', 'else', 'class',
    'import', 'export', 'default', 'async', 'await', 'for', 'while', 'do',
    'break', 'continue', 'typeof', 'instanceof', 'new', 'delete', 'this',
    'super', 'null', 'undefined', 'true', 'false', 'try', 'catch', 'finally',
    'throw', 'switch', 'case', 'of', 'in', 'from', 'extends', 'static',
    'yield', 'void', 'with', 'debugger',
    'type', 'interface', 'enum', 'readonly', 'abstract', 'implements',
    'namespace', 'declare', 'as', 'keyof', 'never', 'unknown', 'any',
    'string', 'number', 'boolean', 'object', 'symbol',
    'public', 'private', 'protected', 'override', 'satisfies',
  ],
  python: [
    'def', 'class', 'return', 'if', 'elif', 'else', 'for', 'while', 'import',
    'from', 'as', 'with', 'try', 'except', 'finally', 'lambda', 'None',
    'True', 'False', 'and', 'or', 'not', 'in', 'is', 'pass', 'break',
    'continue', 'raise', 'yield', 'global', 'nonlocal', 'del', 'assert',
    'async', 'await', 'match', 'case',
  ],
  bash: [
    'if', 'then', 'else', 'fi', 'for', 'do', 'done', 'while', 'case',
    'esac', 'function', 'echo', 'export', 'local', 'source', 'return',
    'exit', 'in', 'select', 'until', 'read', 'declare', 'unset', 'shift',
    'break', 'continue',
  ],
  go: [
    'func', 'type', 'struct', 'interface', 'var', 'const', 'if', 'else',
    'for', 'range', 'return', 'import', 'package', 'defer', 'go', 'chan',
    'map', 'nil', 'true', 'false', 'switch', 'case', 'default', 'break',
    'continue', 'fallthrough', 'goto', 'select', 'make', 'new', 'append',
    'len', 'cap', 'delete', 'close', 'copy', 'recover', 'panic',
  ],
  rust: [
    'fn', 'struct', 'impl', 'trait', 'enum', 'let', 'mut', 'use', 'pub',
    'mod', 'if', 'else', 'for', 'while', 'match', 'return', 'async', 'await',
    'move', 'where', 'type', 'const', 'static', 'ref', 'in', 'loop',
    'break', 'continue', 'crate', 'super', 'self', 'Self', 'true', 'false',
    'as', 'dyn', 'extern', 'unsafe', 'box',
  ],
  java: [
    'class', 'interface', 'extends', 'implements', 'public', 'private',
    'protected', 'static', 'final', 'void', 'return', 'if', 'else', 'for',
    'while', 'do', 'import', 'package', 'new', 'this', 'super', 'try',
    'catch', 'finally', 'throw', 'throws', 'abstract', 'synchronized',
    'instanceof', 'null', 'true', 'false', 'boolean', 'int', 'long',
    'double', 'float', 'char', 'byte', 'short', 'switch', 'case', 'break',
    'continue', 'enum', 'default', 'record', 'sealed', 'permits',
  ],
  'c#': [
    'class', 'interface', 'struct', 'enum', 'namespace', 'using', 'public',
    'private', 'protected', 'internal', 'static', 'readonly', 'const',
    'void', 'return', 'if', 'else', 'for', 'foreach', 'while', 'do',
    'new', 'this', 'base', 'try', 'catch', 'finally', 'throw', 'abstract',
    'virtual', 'override', 'sealed', 'null', 'true', 'false', 'var',
    'async', 'await', 'get', 'set', 'value', 'typeof', 'is', 'as',
    'bool', 'int', 'long', 'double', 'float', 'string', 'object', 'dynamic',
    'switch', 'case', 'break', 'continue', 'default', 'delegate', 'event',
    'in', 'out', 'ref', 'params', 'where', 'record', 'init',
  ],
  cpp: [
    'class', 'struct', 'enum', 'namespace', 'template', 'typename', 'public',
    'private', 'protected', 'virtual', 'override', 'final', 'const', 'static',
    'void', 'return', 'if', 'else', 'for', 'while', 'do', 'new', 'delete',
    'this', 'try', 'catch', 'throw', 'nullptr', 'true', 'false', 'auto',
    'using', 'inline', 'explicit', 'mutable', 'volatile', 'operator',
    'switch', 'case', 'break', 'continue', 'default', 'sizeof', 'alignof',
    'decltype', 'constexpr', 'noexcept', 'friend', 'typedef', 'int', 'long',
    'char', 'bool', 'double', 'float', 'unsigned', 'short',
  ],
  sql: [
    'SELECT', 'FROM', 'WHERE', 'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET',
    'DELETE', 'CREATE', 'TABLE', 'INDEX', 'VIEW', 'DROP', 'ALTER', 'ADD',
    'COLUMN', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'FULL', 'CROSS',
    'ON', 'AND', 'OR', 'NOT', 'IN', 'IS', 'NULL', 'AS', 'ORDER', 'BY',
    'GROUP', 'HAVING', 'LIMIT', 'OFFSET', 'DISTINCT', 'COUNT', 'SUM',
    'AVG', 'MAX', 'MIN', 'PRIMARY', 'KEY', 'FOREIGN', 'REFERENCES',
    'DEFAULT', 'CONSTRAINT', 'TRUNCATE', 'BEGIN', 'COMMIT', 'ROLLBACK',
    'TRANSACTION', 'PROCEDURE', 'FUNCTION', 'TRIGGER', 'CASCADE', 'UNIQUE',
    'CHECK', 'UNION', 'ALL', 'EXCEPT', 'INTERSECT', 'CASE', 'WHEN', 'THEN',
    'ELSE', 'END', 'LIKE', 'BETWEEN', 'EXISTS', 'COALESCE', 'NULLIF',
  ],
};

// -- Rule types ----------------------------------------------------------------

type CommentStyle = 'slash' | 'hash' | 'sql' | 'none';

type TokenRule = { re: RegExp; type: TokenType };

function makeRules(langKeywords: string[], commentStyle: CommentStyle, caseInsensitive = false): TokenRule[] {
  const flags = caseInsensitive ? 'iy' : 'y';
  const rules: TokenRule[] = [];

  if (commentStyle === 'slash') {
    rules.push({ re: /\/\/.*$/y, type: 'comment' });
    rules.push({ re: /\/\*[\s\S]*?\*\//y, type: 'comment' });
  } else if (commentStyle === 'hash') {
    rules.push({ re: /#.*$/y, type: 'comment' });
  } else if (commentStyle === 'sql') {
    rules.push({ re: /--.*$/y, type: 'comment' });
    rules.push({ re: /\/\*[\s\S]*?\*\//y, type: 'comment' });
  }

  // Strings: double-quoted, single-quoted, backtick template literals
  rules.push({ re: /(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/y, type: 'string' });

  // Numbers: hex, float, integer, scientific notation
  rules.push({ re: /\b(?:0x[\da-fA-F]+|\d+\.?\d*(?:[eE][+-]?\d+)?)\b/y, type: 'number' });

  // Keywords
  if (langKeywords.length > 0) {
    const pattern = `\\b(?:${langKeywords.join('|')})\\b`;
    rules.push({ re: new RegExp(pattern, flags), type: 'keyword' });
  }

  // Function calls: identifier immediately before (
  rules.push({ re: /\b([a-zA-Z_]\w*)\s*(?=\()/y, type: 'function' });

  // Type names: PascalCase identifiers
  rules.push({ re: /\b[A-Z][a-zA-Z0-9_]*\b/y, type: 'type-name' });

  // Operators and punctuation
  rules.push({ re: /[+\-*/<>=!&|%^~?:@,;.[\]{}()]+/y, type: 'operator' });

  return rules;
}

// -- Rule cache ----------------------------------------------------------------

const rulesCache = new Map<string, TokenRule[]>();

type LangFamily =
  | 'jsts' | 'python' | 'bash' | 'go' | 'rust'
  | 'java' | 'csharp' | 'cpp' | 'css' | 'json'
  | 'yaml' | 'sql' | 'diff' | 'generic';

function getLangFamily(lang: string): LangFamily {
  switch (lang) {
    case 'javascript': case 'typescript': return 'jsts';
    case 'python': case 'ruby': return 'python';
    case 'bash': return 'bash';
    case 'go': return 'go';
    case 'rust': return 'rust';
    case 'java': case 'kotlin': case 'scala': return 'java';
    case 'c#': return 'csharp';
    case 'c': case 'cpp': return 'cpp';
    case 'css': case 'scss': case 'sass': return 'css';
    case 'json': return 'json';
    case 'yaml': return 'yaml';
    case 'sql': return 'sql';
    case 'diff': case 'patch': return 'diff';
    default: return 'generic';
  }
}

function buildRulesForLang(lang: string): TokenRule[] {
  const family = getLangFamily(lang);
  switch (family) {
    case 'jsts':
      return makeRules(
        lang === 'typescript' ? KEYWORDS['typescript']! : KEYWORDS['javascript']!,
        'slash',
      );
    case 'python':
      return makeRules(KEYWORDS['python']!, 'hash');
    case 'bash':
      return makeRules(KEYWORDS['bash']!, 'hash');
    case 'go':
      return makeRules(KEYWORDS['go']!, 'slash');
    case 'rust':
      return makeRules(KEYWORDS['rust']!, 'slash');
    case 'java':
      return makeRules(KEYWORDS['java']!, 'slash');
    case 'csharp':
      return makeRules(KEYWORDS['c#']!, 'slash');
    case 'cpp':
      return makeRules(KEYWORDS['cpp']!, 'slash');
    case 'css':
      return makeRules([], 'slash');
    case 'json':
      return makeRules([], 'none');
    case 'yaml':
      return makeRules([], 'hash');
    case 'sql':
      return makeRules(KEYWORDS['sql']!, 'sql', true);
    default:
      return [];
  }
}

function getRules(lang: string): TokenRule[] {
  const cached = rulesCache.get(lang);
  if (cached) return cached;
  const rules = buildRulesForLang(lang);
  rulesCache.set(lang, rules);
  return rules;
}

// -- Single-pass line tokenizer ------------------------------------------------

function tokenizeLine(line: string, rules: TokenRule[]): HighlightLine {
  const tokens: HighlightToken[] = [];
  let pos = 0;
  let plainStart = -1;

  function flushPlain(end: number): void {
    if (plainStart >= 0 && plainStart < end) {
      tokens.push({ text: line.slice(plainStart, end), color: COLOR['plain']!, type: 'plain' });
      plainStart = -1;
    }
  }

  while (pos < line.length) {
    let matched = false;
    for (const rule of rules) {
      rule.re.lastIndex = pos;
      const m = rule.re.exec(line);
      if (m !== null) {
        flushPlain(pos);
        tokens.push({ text: m[0], color: colorFor(rule.type), type: rule.type });
        pos += m[0].length;
        matched = true;
        break;
      }
    }
    if (!matched) {
      if (plainStart < 0) plainStart = pos;
      pos++;
    }
  }
  flushPlain(pos);

  // Empty line → single empty plain token so callers always get at least one token
  if (tokens.length === 0) {
    tokens.push({ text: '', color: COLOR['plain']!, type: 'plain' });
  }
  return tokens;
}

// -- Diff tokenizer ------------------------------------------------------------

function tokenizeDiff(code: string): HighlightLine[] {
  return code.split('\n').map((line): HighlightLine => {
    if (line.startsWith('+++') || line.startsWith('---')) {
      return [{ text: line, color: colorFor('diff-header'), type: 'diff-header' }];
    }
    if (line.startsWith('+')) {
      return [{ text: line, color: colorFor('diff-add'), type: 'diff-add' }];
    }
    if (line.startsWith('-')) {
      return [{ text: line, color: colorFor('diff-del'), type: 'diff-del' }];
    }
    if (line.startsWith('@@')) {
      return [{ text: line, color: colorFor('diff-meta'), type: 'diff-meta' }];
    }
    return [{ text: line, color: COLOR['plain']!, type: 'plain' }];
  });
}

// -- Plain text helper ---------------------------------------------------------

function makePlainResult(code: string, lang: string): HighlightResult {
  const lines = code.split('\n').map((line): HighlightLine => [
    { text: line, color: COLOR['plain']!, type: 'plain' },
  ]);
  return { lines, language: lang, fallback: true };
}

// -- Public API ----------------------------------------------------------------

export function resolveLanguage(lang: string): string {
  const lower = lang.toLowerCase().trim();
  return LANGUAGE_ALIASES[lower] ?? lower;
}

export function exceedsGuardrails(code: string): boolean {
  return code.length > MAX_BYTES || code.split('\n').length > MAX_LINES;
}

/**
 * Highlight `code` for a given fence language tag.
 * - Resolves language aliases (shell→bash, csharp→c#, etc.)
 * - Returns `fallback: true` when the language is unsupported or input is oversized.
 * - Returns structural `HighlightLine[]` (no ANSI codes) — callers use `.color` directly.
 */
export function highlightCode(code: string, rawLang: string): HighlightResult {
  const lang = resolveLanguage(rawLang);

  if (exceedsGuardrails(code)) {
    return makePlainResult(code, lang);
  }

  const family = getLangFamily(lang);

  if (family === 'diff') {
    return { lines: tokenizeDiff(code), language: lang, fallback: false };
  }

  if (family === 'generic') {
    return makePlainResult(code, lang);
  }

  const rules = getRules(lang);
  const lines = code.split('\n').map((line) => tokenizeLine(line, rules));
  return { lines, language: lang, fallback: false };
}
