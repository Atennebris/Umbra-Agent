// Shared syntax highlighting engine for TUI code blocks.
// Returns HighlightToken[][] (per-line spans) for Ink <Text color> rendering.
// No ANSI strings emitted — callers receive hex color codes.

import {
  type BundledLanguage,
  type BundledTheme,
  type ThemeRegistration,
  bundledLanguages,
  createHighlighter,
} from 'shiki';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';

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
  ts: 'typescript',
  yml: 'yaml',
  md: 'markdown',
  docker: 'dockerfile',
  console: 'bash',
  terminal: 'bash',
  'c++': 'cpp',
  ps1: 'powershell',
  psm1: 'powershell',
  gql: 'graphql',
  make: 'makefile',
  pl: 'perl',
  htm: 'html',
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
    case 'keyword':
      return COLOR.keyword!;
    case 'string':
      return COLOR.string!;
    case 'comment':
      return COLOR.comment!;
    case 'number':
      return COLOR.number!;
    case 'operator':
      return COLOR.operator!;
    case 'function':
      return COLOR.function!;
    case 'type-name':
      return COLOR.typeName!;
    case 'diff-add':
      return COLOR.diffAdd!;
    case 'diff-del':
      return COLOR.diffDel!;
    case 'diff-meta':
      return COLOR.diffMeta!;
    case 'diff-header':
      return COLOR.diffHead!;
    case 'plain':
      return COLOR.plain!;
  }
}

// -- Shiki theme: maps TextMate scopes onto the Umbra COLOR palette ------------

const UMBRA_SHIKI_THEME: ThemeRegistration = {
  name: 'umbra',
  type: 'dark',
  colors: {
    'editor.background': '#0d0b14',
    'editor.foreground': COLOR.plain!,
  },
  tokenColors: [
    { settings: { foreground: COLOR.plain! } },
    {
      scope: ['comment', 'punctuation.definition.comment'],
      settings: { foreground: COLOR.comment! },
    },
    {
      scope: ['string', 'string.quoted', 'string.template', 'punctuation.definition.string'],
      settings: { foreground: COLOR.string! },
    },
    { scope: ['constant.numeric'], settings: { foreground: COLOR.number! } },
    {
      scope: [
        'keyword',
        'keyword.control',
        'keyword.operator.new',
        'storage.type',
        'storage.modifier',
        'constant.language',
      ],
      settings: { foreground: COLOR.keyword! },
    },
    {
      scope: ['entity.name.function', 'support.function', 'entity.name.function.member'],
      settings: { foreground: COLOR.function! },
    },
    {
      scope: [
        'entity.name.type',
        'entity.name.class',
        'support.type',
        'support.class',
        'entity.name.tag',
        'entity.other.attribute-name',
      ],
      settings: { foreground: COLOR.typeName! },
    },
    {
      scope: ['keyword.operator', 'punctuation.accessor'],
      settings: { foreground: COLOR.operator! },
    },
    // Markdown-specific scopes
    {
      scope: ['markup.heading', 'entity.name.section.markdown'],
      settings: { foreground: COLOR.keyword! },
    },
    { scope: ['markup.bold'], settings: { foreground: COLOR.typeName! } },
    { scope: ['markup.italic'], settings: { foreground: COLOR.function! } },
    { scope: ['markup.inline.raw'], settings: { foreground: COLOR.string! } },
    {
      scope: ['punctuation.definition.list.begin'],
      settings: { foreground: COLOR.operator! },
    },
    { scope: ['markup.quote'], settings: { foreground: COLOR.comment! } },
    {
      scope: ['markup.underline.link', 'string.other.link.title'],
      settings: { foreground: COLOR.function! },
    },
  ],
};

// -- Reverse color → TokenType map (for callers that branch on `.type`) --------

const COLOR_TO_TYPE: Record<string, TokenType> = {
  [COLOR.keyword!]: 'keyword',
  [COLOR.string!]: 'string',
  [COLOR.comment!]: 'comment',
  [COLOR.number!]: 'number',
  [COLOR.operator!]: 'operator',
  [COLOR.function!]: 'function',
  [COLOR.typeName!]: 'type-name',
};

function shikiColorToType(color: string | undefined): TokenType {
  if (!color) return 'plain';
  return COLOR_TO_TYPE[color.toLowerCase()] ?? 'plain';
}

// -- Shiki highlighter singleton ------------------------------------------------

// Every grammar Shiki ships, preloaded at startup so all of them get real
// highlighting (not just a hand-picked subset) — same coverage as VS Code/Codex.
const PRELOAD_LANGS = Object.keys(bundledLanguages);

function toShikiLangId(lang: string): string {
  return lang === 'c#' ? 'csharp' : lang;
}

type Highlighter = Awaited<ReturnType<typeof createHighlighter>>;

let highlighterInstance: Highlighter | null = null;
let initPromise: Promise<void> | null = null;

/** Loads the Shiki highlighter and TextMate grammars. Safe to call multiple times. */
export function initHighlighter(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    try {
      highlighterInstance = await createHighlighter({
        themes: [UMBRA_SHIKI_THEME],
        langs: PRELOAD_LANGS,
        engine: createJavaScriptRegexEngine({ forgiving: true }),
      });
    } catch {
      highlighterInstance = null;
    }
  })();
  return initPromise;
}

export function isHighlighterReady(): boolean {
  return highlighterInstance !== null;
}

// -- Diff tokenizer ------------------------------------------------------------

// Matches `@@ -oldStart,oldLines +newStart,newLines @@` (the line-count parts
// are optional, matching git's output for single-line hunks).
const HUNK_HEADER_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const GUTTER_NUM_WIDTH = 4;

// Renders the left-hand line-number gutter: old-file number, new-file number,
// each blank when the line doesn't exist on that side (added/removed lines)
// or before the first @@ header has been seen.
function diffGutter(oldLineNum: number | null, newLineNum: number | null): string {
  const oldText = oldLineNum === null ? ' '.repeat(GUTTER_NUM_WIDTH) : String(oldLineNum).padStart(GUTTER_NUM_WIDTH);
  const newText = newLineNum === null ? ' '.repeat(GUTTER_NUM_WIDTH) : String(newLineNum).padStart(GUTTER_NUM_WIDTH);
  return `${oldText} ${newText} │ `;
}

// Renders a unified diff with a Codex-style line-number gutter instead of raw
// `@@ -a,b +c,d @@` hunk headers — those headers are dropped entirely and their
// old/new line numbers feed the gutter for every following line instead.
function tokenizeDiff(code: string): HighlightLine[] {
  const lines: HighlightLine[] = [];
  let oldLineNum: number | null = null;
  let newLineNum: number | null = null;

  for (const line of code.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('\\')) {
      lines.push([
        { text: diffGutter(null, null), color: colorFor('diff-meta'), type: 'diff-meta' },
        { text: line, color: colorFor('diff-header'), type: 'diff-header' },
      ]);
      continue;
    }

    const hunkMatch = line.match(HUNK_HEADER_RE);
    if (hunkMatch) {
      oldLineNum = Number(hunkMatch[1]);
      newLineNum = Number(hunkMatch[2]);
      continue;
    }

    if (line.startsWith('+')) {
      lines.push([
        { text: diffGutter(null, newLineNum), color: colorFor('diff-meta'), type: 'diff-meta' },
        { text: line, color: colorFor('diff-add'), type: 'diff-add' },
      ]);
      if (newLineNum !== null) newLineNum += 1;
      continue;
    }

    if (line.startsWith('-')) {
      lines.push([
        { text: diffGutter(oldLineNum, null), color: colorFor('diff-meta'), type: 'diff-meta' },
        { text: line, color: colorFor('diff-del'), type: 'diff-del' },
      ]);
      if (oldLineNum !== null) oldLineNum += 1;
      continue;
    }

    lines.push([
      { text: diffGutter(oldLineNum, newLineNum), color: colorFor('diff-meta'), type: 'diff-meta' },
      { text: line, color: COLOR.plain!, type: 'plain' },
    ]);
    if (oldLineNum !== null) oldLineNum += 1;
    if (newLineNum !== null) newLineNum += 1;
  }

  return lines;
}

// -- Plain text helper ---------------------------------------------------------

function makePlainResult(code: string, lang: string): HighlightResult {
  const lines = code
    .split('\n')
    .map((line): HighlightLine => [{ text: line, color: COLOR.plain!, type: 'plain' }]);
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
 * - Returns `fallback: true` when the language is unsupported, the highlighter
 *   isn't ready yet, or the input is oversized.
 * - Returns structural `HighlightLine[]` (no ANSI codes) — callers use `.color` directly.
 */
export function highlightCode(code: string, rawLang: string): HighlightResult {
  const lang = resolveLanguage(rawLang);

  if (exceedsGuardrails(code)) {
    return makePlainResult(code, lang);
  }

  if (lang === 'diff' || lang === 'patch') {
    return { lines: tokenizeDiff(code), language: lang, fallback: false };
  }

  const shikiLang = toShikiLangId(lang);
  const highlighter = highlighterInstance;
  if (highlighter === null || !PRELOAD_LANGS.includes(shikiLang)) {
    return makePlainResult(code, lang);
  }

  try {
    const tokenLines = highlighter.codeToTokensBase(code, {
      lang: shikiLang as BundledLanguage,
      theme: 'umbra' as BundledTheme,
    });
    const lines: HighlightLine[] = tokenLines.map((lineTokens) =>
      lineTokens.length === 0
        ? [{ text: '', color: COLOR.plain!, type: 'plain' as const }]
        : lineTokens.map((tok) => ({
            text: tok.content,
            color: (tok.color ?? COLOR.plain!).toLowerCase(),
            type: shikiColorToType(tok.color),
          })),
    );
    return { lines, language: lang, fallback: false };
  } catch {
    return makePlainResult(code, lang);
  }
}
