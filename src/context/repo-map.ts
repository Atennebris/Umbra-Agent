import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { unzipSync } from 'fflate';
import yaml from 'js-yaml';
import type { Node } from 'web-tree-sitter';

const _require = createRequire(import.meta.url);
import { type GmlCstNode, parseGmlSource } from './gml-parser-runtime.js';
import { type ScannedProjectFile, scanProjectFiles } from './project-scanner.js';
import { estimateTextTokens } from './token-estimator.js';
import {
  type SupportedTreeSitterLanguage,
  getTreeSitterLanguageForExtension,
  withTreeSitterParse,
} from './tree-sitter-runtime.js';

export type RepoSymbol = {
  name: string;
  kind: string;
  line: number;
  signature: string;
};

export type RepoMapFile = {
  path: string;
  language: string;
  parser: 'tree-sitter' | 'gml-parser' | 'fallback';
  lines: number;
  imports: string[];
  symbols: RepoSymbol[];
};

export type RepoMap = {
  rootPath: string;
  generatedAt: string;
  fileCount: number;
  symbolCount: number;
  files: RepoMapFile[];
};

type RepoMapOptions = {
  maxFiles?: number;
  maxFileSizeBytes?: number;
};

const repoMapCache = new Map<string, { loadedAt: number; value: RepoMap }>();

const languageSymbolTypes: Record<
  SupportedTreeSitterLanguage,
  { imports: string[]; symbols: string[] }
> = {
  javascript: {
    imports: ['import_statement'],
    symbols: [
      'function_declaration',
      'class_declaration',
      'method_definition',
      'lexical_declaration',
      'variable_declaration',
    ],
  },
  typescript: {
    imports: ['import_statement'],
    symbols: [
      'function_declaration',
      'class_declaration',
      'method_definition',
      'interface_declaration',
      'type_alias_declaration',
      'enum_declaration',
      'lexical_declaration',
      'variable_declaration',
    ],
  },
  tsx: {
    imports: ['import_statement'],
    symbols: [
      'function_declaration',
      'class_declaration',
      'method_definition',
      'interface_declaration',
      'type_alias_declaration',
      'enum_declaration',
      'lexical_declaration',
      'variable_declaration',
    ],
  },
  python: {
    imports: ['import_statement', 'import_from_statement'],
    symbols: ['function_definition', 'class_definition'],
  },
  go: {
    imports: ['import_declaration'],
    symbols: ['function_declaration', 'method_declaration', 'type_declaration'],
  },
  bash: {
    imports: ['command'],
    symbols: ['function_definition'],
  },
  rust: {
    imports: ['use_declaration'],
    symbols: ['function_item', 'struct_item', 'enum_item', 'impl_item', 'trait_item', 'type_item'],
  },
  java: {
    imports: ['import_declaration'],
    symbols: [
      'class_declaration',
      'interface_declaration',
      'method_declaration',
      'enum_declaration',
    ],
  },
  css: {
    imports: [],
    symbols: ['rule_set', 'at_rule', 'keyframes_statement'],
  },
  ruby: {
    imports: ['call'],
    symbols: ['method', 'class', 'module', 'singleton_method'],
  },
  csharp: {
    imports: ['using_directive'],
    symbols: [
      'class_declaration',
      'interface_declaration',
      'method_declaration',
      'constructor_declaration',
      'destructor_declaration',
      'property_declaration',
      'field_declaration',
      'struct_declaration',
      'enum_declaration',
      'namespace_declaration',
      'record_declaration',
      'delegate_declaration',
      'event_declaration',
      'event_field_declaration',
      'operator_declaration',
    ],
  },
  php: {
    imports: ['namespace_use_declaration'],
    symbols: [
      'function_definition',
      'class_declaration',
      'interface_declaration',
      'method_declaration',
    ],
  },
  powershell: {
    imports: [],
    symbols: ['function_statement', 'class_statement'],
  },
  ini: {
    imports: [],
    symbols: ['section'],
  },
  cpp: {
    imports: ['preproc_include'],
    symbols: [
      'function_definition',
      'class_specifier',
      'struct_specifier',
      'enum_specifier',
      'namespace_definition',
      'template_declaration',
    ],
  },
};

export async function buildRepoMap(
  rootPath: string,
  options: RepoMapOptions = {},
): Promise<RepoMap> {
  const normalizedRoot = path.resolve(rootPath);
  const cacheKey = `${normalizedRoot}:${options.maxFiles ?? 250}:${options.maxFileSizeBytes ?? 256_000}`;
  const cached = repoMapCache.get(cacheKey);

  if (cached && Date.now() - cached.loadedAt < 15_000) {
    return cached.value;
  }

  const scannedFiles = scanProjectFiles(normalizedRoot, options);
  const files = await Promise.all(scannedFiles.map((file) => summarizeProjectFile(file)));
  const filteredFiles = files.filter(
    (file): file is RepoMapFile =>
      file !== null && (file.symbols.length > 0 || file.imports.length > 0),
  );

  const repoMap: RepoMap = {
    rootPath: normalizedRoot,
    generatedAt: new Date().toISOString(),
    fileCount: filteredFiles.length,
    symbolCount: filteredFiles.reduce((sum, file) => sum + file.symbols.length, 0),
    files: filteredFiles,
  };

  repoMapCache.set(cacheKey, {
    loadedAt: Date.now(),
    value: repoMap,
  });

  return repoMap;
}

export function renderRepoMapMarkdown(repoMap: RepoMap): string {
  const lines = ['# Repo Map'];

  for (const file of repoMap.files) {
    lines.push(
      `- \`${file.path}\` [${file.language}; ${file.parser}; ${file.symbols.length} symbols]`,
    );

    if (file.imports.length > 0) {
      lines.push(`  imports: ${file.imports.slice(0, 4).join(' | ')}`);
    }

    if (file.symbols.length > 0) {
      lines.push(
        `  symbols: ${file.symbols
          .slice(0, 6)
          .map((symbol) => `${symbol.kind} ${symbol.signature}`)
          .join(' | ')}`,
      );
    }
  }

  return lines.join('\n');
}

export function summarizeRepoMap(repoMap: RepoMap) {
  const languages = Array.from(new Set(repoMap.files.map((file) => file.language))).sort();
  const markdown = renderRepoMapMarkdown(repoMap);

  return {
    repoFiles: repoMap.fileCount,
    repoSymbols: repoMap.symbolCount,
    languages,
    markdown,
    tokens: estimateTextTokens(markdown),
  };
}

async function summarizeProjectFile(file: ScannedProjectFile): Promise<RepoMapFile | null> {
  // Binary format extractors — handle before UTF-8 read
  if (file.extension === '.pdf') {
    const result = await summarizePdfBinary(file.relativePath, file.absolutePath);
    return result;
  }
  if (file.extension === '.docx') {
    const result = summarizeDocxBinary(file.relativePath, file.absolutePath);
    return result;
  }

  const source = readUtf8File(file.absolutePath);

  if (source === null || source.trim().length === 0) {
    return null;
  }

  const treeSitterSummary = await withTreeSitterParse(
    file.extension,
    source,
    ({ language, rootNode }) => summarizeTreeSitterFile(file.relativePath, language, rootNode),
  );

  if (treeSitterSummary) {
    return {
      ...treeSitterSummary,
      lines: countLines(source),
    };
  }

  if (file.extension === '.gml') {
    const gmlSummary = await summarizeGmlFile(file.relativePath, source);

    if (gmlSummary) {
      return {
        ...gmlSummary,
        lines: countLines(source),
      };
    }
  }

  const structuredSummary = summarizeStructuredFile(file.relativePath, file.extension, source);
  if (structuredSummary) {
    return { ...structuredSummary, lines: countLines(source) };
  }

  const fallback = summarizeFallbackFile(file.relativePath, file.extension, source);

  if (fallback.symbols.length === 0 && fallback.imports.length === 0) {
    return null;
  }

  return {
    ...fallback,
    lines: countLines(source),
  };
}

async function summarizeGmlFile(
  relativePath: string,
  source: string,
): Promise<Omit<RepoMapFile, 'lines'> | null> {
  const parsed = await parseGmlSource(source);

  if (!parsed) {
    return null;
  }

  const symbols = dedupeSymbols(extractGmlSymbols(parsed.cst, source)).slice(0, 24);

  if (symbols.length === 0 && parsed.errors.length > 0) {
    return null;
  }

  return {
    path: relativePath,
    language: 'gml',
    parser: 'gml-parser',
    imports: [],
    symbols,
  };
}

function summarizeTreeSitterFile(
  relativePath: string,
  language: SupportedTreeSitterLanguage,
  rootNode: Node,
): Omit<RepoMapFile, 'lines'> {
  const config = languageSymbolTypes[language];
  const imports = rootNode
    .descendantsOfType(config.imports)
    .map((node) => compressText(node.text))
    .filter(Boolean)
    .slice(0, 8);

  const symbols = rootNode
    .descendantsOfType(config.symbols)
    .map((node) => toRepoSymbol(node))
    .filter((symbol): symbol is RepoSymbol => symbol !== null)
    .filter(
      (symbol, index, items) =>
        items.findIndex((item) => item.signature === symbol.signature) === index,
    )
    .slice(0, 36);

  const spec = getTreeSitterLanguageForExtension(path.extname(relativePath));
  return {
    path: relativePath,
    language: spec?.id ?? language,
    parser: 'tree-sitter',
    imports,
    symbols,
  };
}

function summarizeStructuredFile(
  relativePath: string,
  extension: string,
  source: string,
): Omit<RepoMapFile, 'lines'> | null {
  const basename = path.basename(relativePath);

  if (extension === '.json') return summarizeJsonFile(relativePath, source);
  if (extension === '.yml' || extension === '.yaml') {
    return (
      summarizeGithubActionsFile(relativePath, source) ?? summarizeYamlFile(relativePath, source)
    );
  }
  if (extension === '.md' || extension === '.mdx')
    return summarizeMarkdownFile(relativePath, source);
  if (extension === '.sql') return summarizeSqlFile(relativePath, source);
  if (extension === '.html' || extension === '.htm') return summarizeHtmlFile(relativePath, source);

  // -- New language coverage --

  if (extension === '.toml') return summarizeTomlFile(relativePath, source);
  if (extension === '.graphql' || extension === '.gql')
    return summarizeGraphqlFile(relativePath, source);
  if (extension === '.proto') return summarizeProtoFile(relativePath, source);
  if (extension === '.tf' || extension === '.hcl' || extension === '.tfvars')
    return summarizeTerraformFile(relativePath, source);
  if (extension === '.prisma') return summarizePrismaFile(relativePath, source);
  if (extension === '.sol') return summarizeSolidityFile(relativePath, source);
  if (extension === '.zig') return summarizeZigFile(relativePath, source);
  if (extension === '.dart') return summarizeDartFile(relativePath, source);
  if (extension === '.kt' || extension === '.kts') return summarizeKotlinFile(relativePath, source);
  if (extension === '.swift') return summarizeSwiftFile(relativePath, source);
  if (extension === '.lua') return summarizeLuaFile(relativePath, source);
  if (extension === '.scala' || extension === '.sc')
    return summarizeScalaFile(relativePath, source);
  if (extension === '.ex' || extension === '.exs') return summarizeElixirFile(relativePath, source);
  if (extension === '.erl' || extension === '.hrl')
    return summarizeErlangFile(relativePath, source);
  if (extension === '.hs' || extension === '.lhs')
    return summarizeHaskellFile(relativePath, source);
  if (extension === '.pl' || extension === '.pm') return summarizePerlFile(relativePath, source);
  if (extension === '.r') return summarizeRFile(relativePath, source);
  if (extension === '.clj' || extension === '.cljs' || extension === '.cljc')
    return summarizeClojureFile(relativePath, source);
  if (extension === '.vue') return summarizeVueFile(relativePath, source);
  if (extension === '.svelte') return summarizeSvelteFile(relativePath, source);
  if (extension === '.astro') return summarizeAstroFile(relativePath, source);
  if (extension === '.xml') return summarizeXmlFile(relativePath, source);
  if (extension === '.gradle') return summarizeGradleFile(relativePath, source);
  if (extension === '.gd') return summarizeGdscriptFile(relativePath, source);
  if (extension === '.m') return summarizeMatlabFile(relativePath, source);
  if (extension === '.nix') return summarizeNixFile(relativePath, source);
  if (extension === '.ipynb') return summarizeJupyterFile(relativePath, source);
  if (extension === '.wat' || extension === '.wast') return summarizeWatFile(relativePath, source);
  if (extension === '.asm' || extension === '.nasm' || extension === '.nas')
    return summarizeAssemblyFile(relativePath, source);
  // .s / .S (GAS syntax) - only if clearly assembly (not Scala .sc or Swift)
  if (extension === '.s' || extension === '.S') return summarizeAssemblyFile(relativePath, source);

  // basename-detected (no canonical extension)
  if (
    basename === 'Dockerfile' ||
    basename.startsWith('Dockerfile.') ||
    extension === '.dockerfile'
  )
    return summarizeDockerfile(relativePath, source);

  if (
    basename === 'Makefile' ||
    basename === 'GNUmakefile' ||
    basename === 'makefile' ||
    extension === '.mk' ||
    extension === '.makefile'
  )
    return summarizeMakefile(relativePath, source);

  if (basename === 'CMakeLists.txt' || extension === '.cmake')
    return summarizeCMakeFile(relativePath, source);

  // .env and .env.* (path.extname('.env') = '', so check basename)
  if (basename === '.env' || basename.match(/^\.env\.\w/) !== null) {
    return summarizeEnvFile(relativePath, source);
  }

  if (extension === '.log') return summarizeLogFile(relativePath, source);

  // Lockfiles (detected by basename, extension = .lock)
  if (extension === '.lock') {
    if (basename === 'yarn.lock') return summarizeYarnLockFile(relativePath, source);
    if (basename === 'Cargo.lock') return summarizeCargoLockFile(relativePath, source);
    if (basename === 'Gemfile.lock') return summarizeGemfileLockFile(relativePath, source);
    if (basename === 'composer.lock') return summarizeComposerLockFile(relativePath, source);
  }

  return null;
}

function summarizeJsonFile(
  relativePath: string,
  source: string,
): Omit<RepoMapFile, 'lines'> | null {
  let parsed: unknown;

  try {
    parsed = JSON.parse(source);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object') {
    return null;
  }

  const symbols: RepoSymbol[] = [];

  if (Array.isArray(parsed)) {
    symbols.push({ name: '[]', kind: 'array', line: 1, signature: `array[${parsed.length}]` });
  } else {
    const keys = Object.keys(parsed as Record<string, unknown>);
    const lines = source.split(/\r?\n/);

    for (const key of keys.slice(0, 24)) {
      const lineNum = lines.findIndex((l) => l.includes(`"${key}"`)) + 1;
      const val = (parsed as Record<string, unknown>)[key];
      const valType = Array.isArray(val) ? 'array' : typeof val;
      symbols.push({
        name: key,
        kind: valType,
        line: lineNum || 1,
        signature: `"${key}": ${valType}`,
      });
    }
  }

  return { path: relativePath, language: 'json', parser: 'fallback', imports: [], symbols };
}

function summarizeYamlFile(
  relativePath: string,
  source: string,
): Omit<RepoMapFile, 'lines'> | null {
  let parsed: unknown;

  try {
    parsed = yaml.load(source);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }

  const symbols: RepoSymbol[] = [];
  const lines = source.split(/\r?\n/);
  const topKeys = Object.keys(parsed as Record<string, unknown>);

  for (const key of topKeys.slice(0, 24)) {
    const lineNum = lines.findIndex((l) => l.match(new RegExp(`^${key}\\s*:`))) + 1;
    const val = (parsed as Record<string, unknown>)[key];
    const valType = Array.isArray(val) ? 'list' : typeof val;
    symbols.push({ name: key, kind: valType, line: lineNum || 1, signature: `${key}: ${valType}` });
  }

  return { path: relativePath, language: 'yaml', parser: 'fallback', imports: [], symbols };
}

function summarizeMarkdownFile(
  relativePath: string,
  source: string,
): Omit<RepoMapFile, 'lines'> | null {
  const lines = source.split(/\r?\n/);
  const symbols: RepoSymbol[] = [];

  for (const [i, line] of lines.entries()) {
    const match = /^(#{1,4})\s+(.+)/.exec(line);

    if (match) {
      const level = match[1]?.length ?? 0;
      const title = match[2]?.trim() ?? '';
      symbols.push({
        name: title,
        kind: `h${level}`,
        line: i + 1,
        signature: line.trim().slice(0, 120),
      });
    }
  }

  if (symbols.length === 0) {
    return null;
  }

  return {
    path: relativePath,
    language: 'markdown',
    parser: 'fallback',
    imports: [],
    symbols: symbols.slice(0, 24),
  };
}

function summarizeSqlFile(relativePath: string, source: string): Omit<RepoMapFile, 'lines'> | null {
  const lines = source.split(/\r?\n/);
  const symbols: RepoSymbol[] = [];
  const pattern =
    /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:(TABLE|VIEW|FUNCTION|PROCEDURE|INDEX|TRIGGER)\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:\w+\.)?(\w+))/i;

  for (const [i, line] of lines.entries()) {
    const match = pattern.exec(line);

    if (match) {
      const kind = match[1]?.toLowerCase() ?? '';
      const name = match[2] ?? '';
      symbols.push({ name, kind, line: i + 1, signature: line.trim().slice(0, 120) });
    }
  }

  if (symbols.length === 0) {
    return null;
  }

  return {
    path: relativePath,
    language: 'sql',
    parser: 'fallback',
    imports: [],
    symbols: symbols.slice(0, 24),
  };
}

function summarizeHtmlFile(
  relativePath: string,
  source: string,
): Omit<RepoMapFile, 'lines'> | null {
  const lines = source.split(/\r?\n/);
  const symbols: RepoSymbol[] = [];

  // 1. IDs (id="...")
  const idPattern = /id=["']([^"']+)["']/g;
  // 2. Landmarks (role="..." or common landmark tags)
  const landmarkPattern = /<(header|nav|main|aside|footer|article|section|form)\b/gi;
  const rolePattern = /role=["']([^"']+)["']/g;
  // 3. Scripts and Styles
  const blockPattern = /<(script|style)\b/gi;

  for (const [i, line] of lines.entries()) {
    let match: RegExpExecArray | null;

    // IDs
    idPattern.lastIndex = 0;
    while ((match = idPattern.exec(line)) !== null) {
      const id = match[1];
      if (id) {
        symbols.push({ name: id, kind: 'id', line: i + 1, signature: `id="${id}"` });
      }
    }

    // Landmarks (tags)
    landmarkPattern.lastIndex = 0;
    while ((match = landmarkPattern.exec(line)) !== null) {
      const tag = match[1];
      if (tag) {
        symbols.push({
          name: tag.toLowerCase(),
          kind: 'landmark',
          line: i + 1,
          signature: `<${tag}>`,
        });
      }
    }

    // Landmarks (roles)
    rolePattern.lastIndex = 0;
    while ((match = rolePattern.exec(line)) !== null) {
      const role = match[1];
      if (role) {
        symbols.push({ name: role, kind: 'role', line: i + 1, signature: `role="${role}"` });
      }
    }

    // Blocks
    blockPattern.lastIndex = 0;
    while ((match = blockPattern.exec(line)) !== null) {
      const block = match[1];
      if (block) {
        symbols.push({
          name: block.toLowerCase(),
          kind: 'block',
          line: i + 1,
          signature: `<${block}>`,
        });
      }
    }
  }

  if (symbols.length === 0) {
    return null;
  }

  return {
    path: relativePath,
    language: 'html',
    parser: 'fallback',
    imports: [],
    symbols: dedupeSymbols(symbols).slice(0, 36),
  };
}

// ---------------------------------------------------------------------------
// New partial parsers — Language Coverage Expansion Backlog
// ---------------------------------------------------------------------------

function makePartialFile(
  relativePath: string,
  language: string,
  imports: string[],
  symbols: RepoSymbol[],
): Omit<RepoMapFile, 'lines'> | null {
  if (symbols.length === 0 && imports.length === 0) return null;
  return {
    path: relativePath,
    language,
    parser: 'fallback',
    imports,
    symbols: dedupeSymbols(symbols).slice(0, 36),
  };
}

function symbolsFromLines(
  lines: string[],
  patterns: Array<{ re: RegExp; kind: string; nameGroup?: number }>,
  limit = 36,
): RepoSymbol[] {
  const symbols: RepoSymbol[] = [];
  for (const [i, line] of lines.entries()) {
    if (symbols.length >= limit) break;
    const trimmed = line.trim();
    for (const { re, kind, nameGroup = 1 } of patterns) {
      const m = re.exec(trimmed);
      if (m) {
        const name = m[nameGroup]?.trim();
        if (name) {
          symbols.push({ name, kind, line: i + 1, signature: trimmed.slice(0, 120) });
        }
        break;
      }
    }
  }
  return symbols;
}

// TOML — sections [section] and top-level key = value
function summarizeTomlFile(
  relativePath: string,
  source: string,
): Omit<RepoMapFile, 'lines'> | null {
  const lines = source.split(/\r?\n/);
  const symbols: RepoSymbol[] = [];
  for (const [i, line] of lines.entries()) {
    const trimmed = line.trim();
    const section = /^\[([^\[\]#]+)\]/.exec(trimmed);
    if (section?.[1]) {
      symbols.push({
        name: section[1].trim(),
        kind: 'section',
        line: i + 1,
        signature: trimmed.slice(0, 120),
      });
      continue;
    }
    const kv = /^([A-Za-z_][\w.-]*)\s*=/.exec(trimmed);
    if (kv?.[1] && symbols.length < 36) {
      symbols.push({ name: kv[1], kind: 'key', line: i + 1, signature: trimmed.slice(0, 120) });
    }
  }
  return makePartialFile(relativePath, 'toml', [], symbols);
}

// Dockerfile — FROM stages, EXPOSE, CMD, ENTRYPOINT, ARG, ENV labels
function summarizeDockerfile(
  relativePath: string,
  source: string,
): Omit<RepoMapFile, 'lines'> | null {
  const lines = source.split(/\r?\n/);
  const symbols = symbolsFromLines(lines, [
    { re: /^FROM\s+\S+(?:\s+AS\s+(\S+))?/i, kind: 'stage', nameGroup: 1 },
    { re: /^FROM\s+(\S+)/i, kind: 'base', nameGroup: 1 },
    { re: /^EXPOSE\s+(\d+)/i, kind: 'port', nameGroup: 1 },
    { re: /^ARG\s+([A-Za-z_]\w*)/i, kind: 'arg', nameGroup: 1 },
    { re: /^ENV\s+([A-Za-z_]\w*)/i, kind: 'env', nameGroup: 1 },
    { re: /^LABEL\s+(\S+)/i, kind: 'label', nameGroup: 1 },
    { re: /^ENTRYPOINT\s+(.+)/, kind: 'entrypoint', nameGroup: 1 },
    { re: /^CMD\s+(.+)/, kind: 'cmd', nameGroup: 1 },
  ]);
  return makePartialFile(relativePath, 'dockerfile', [], symbols);
}

// Makefile — targets (lines with `target:` not preceded by whitespace)
function summarizeMakefile(
  relativePath: string,
  source: string,
): Omit<RepoMapFile, 'lines'> | null {
  const lines = source.split(/\r?\n/);
  const symbols: RepoSymbol[] = [];
  const imports: string[] = [];
  for (const [i, line] of lines.entries()) {
    if (line.startsWith('\t') || line.startsWith(' ') || line.startsWith('#')) continue;
    const include = /^include\s+(.+)/.exec(line);
    if (include?.[1]) {
      imports.push(include[1].trim());
      continue;
    }
    // Variables at top level
    const varMatch = /^([A-Za-z_][\w.-]*)\s*[:?!]?=/.exec(line);
    if (varMatch?.[1] && varMatch[1].toUpperCase() === varMatch[1]) {
      symbols.push({
        name: varMatch[1],
        kind: 'variable',
        line: i + 1,
        signature: line.slice(0, 120),
      });
      continue;
    }
    // Targets: name: [deps...]
    const target = /^([A-Za-z0-9_][A-Za-z0-9_./%-]*)(\s+[A-Za-z0-9_./%-]*)*\s*:/.exec(line);
    if (target?.[1] && !target[1].startsWith('.')) {
      symbols.push({ name: target[1], kind: 'target', line: i + 1, signature: line.slice(0, 120) });
    }
  }
  return makePartialFile(relativePath, 'makefile', imports.slice(0, 8), symbols);
}

// CMake — add_library, add_executable, function(), macro()
function summarizeCMakeFile(
  relativePath: string,
  source: string,
): Omit<RepoMapFile, 'lines'> | null {
  const lines = source.split(/\r?\n/);
  const symbols = symbolsFromLines(lines, [
    { re: /^add_executable\s*\(\s*(\S+)/i, kind: 'executable' },
    { re: /^add_library\s*\(\s*(\S+)/i, kind: 'library' },
    { re: /^function\s*\(\s*(\S+)/i, kind: 'function' },
    { re: /^macro\s*\(\s*(\S+)/i, kind: 'macro' },
    { re: /^project\s*\(\s*(\S+)/i, kind: 'project' },
    { re: /^option\s*\(\s*(\S+)/i, kind: 'option' },
    { re: /^set\s*\(\s*([A-Z_][A-Z0-9_]+)/i, kind: 'variable' },
  ]);
  return makePartialFile(relativePath, 'cmake', [], symbols);
}

// GraphQL — type, query, mutation, subscription, fragment, interface, enum, input, union
function summarizeGraphqlFile(
  relativePath: string,
  source: string,
): Omit<RepoMapFile, 'lines'> | null {
  const lines = source.split(/\r?\n/);
  const symbols = symbolsFromLines(lines, [
    { re: /^type\s+(\w+)/, kind: 'type' },
    { re: /^interface\s+(\w+)/, kind: 'interface' },
    { re: /^enum\s+(\w+)/, kind: 'enum' },
    { re: /^union\s+(\w+)/, kind: 'union' },
    { re: /^input\s+(\w+)/, kind: 'input' },
    { re: /^scalar\s+(\w+)/, kind: 'scalar' },
    { re: /^query\s+(\w+)/, kind: 'query' },
    { re: /^mutation\s+(\w+)/, kind: 'mutation' },
    { re: /^subscription\s+(\w+)/, kind: 'subscription' },
    { re: /^fragment\s+(\w+)/, kind: 'fragment' },
    { re: /^directive\s+@(\w+)/, kind: 'directive' },
  ]);
  return makePartialFile(relativePath, 'graphql', [], symbols);
}

// Protocol Buffers — message, service, enum, rpc
function summarizeProtoFile(
  relativePath: string,
  source: string,
): Omit<RepoMapFile, 'lines'> | null {
  const lines = source.split(/\r?\n/);
  const imports: string[] = [];
  const symbols = symbolsFromLines(lines, [
    { re: /^message\s+(\w+)/, kind: 'message' },
    { re: /^service\s+(\w+)/, kind: 'service' },
    { re: /^enum\s+(\w+)/, kind: 'enum' },
    { re: /^\s*rpc\s+(\w+)/, kind: 'rpc' },
    { re: /^oneof\s+(\w+)/, kind: 'oneof' },
  ]);
  for (const line of lines) {
    const m = /^import\s+"([^"]+)"/.exec(line.trim());
    if (m?.[1] && imports.length < 8) imports.push(m[1]);
  }
  return makePartialFile(relativePath, 'protobuf', imports, symbols);
}

// Terraform / HCL — resource, module, variable, output, data, provider, locals
function summarizeTerraformFile(
  relativePath: string,
  source: string,
): Omit<RepoMapFile, 'lines'> | null {
  const lines = source.split(/\r?\n/);
  const symbols: RepoSymbol[] = [];
  for (const [i, line] of lines.entries()) {
    if (symbols.length >= 36) break;
    const trimmed = line.trim();
    const m =
      /^(resource|data|module|variable|output|provider|locals)\s+"([^"]+)"\s+"([^"]*)"/.exec(
        trimmed,
      ) ?? /^(resource|data|module|variable|output|provider|locals)\s+"([^"]+)"/.exec(trimmed);
    if (m) {
      const kind = m[1] ?? '';
      const name = m[3] ? `${m[2]}.${m[3]}` : (m[2] ?? '');
      symbols.push({ name, kind, line: i + 1, signature: trimmed.slice(0, 120) });
    }
  }
  return makePartialFile(relativePath, 'terraform', [], symbols);
}

// Prisma — model, enum, type
function summarizePrismaFile(
  relativePath: string,
  source: string,
): Omit<RepoMapFile, 'lines'> | null {
  const lines = source.split(/\r?\n/);
  const symbols = symbolsFromLines(lines, [
    { re: /^model\s+(\w+)/, kind: 'model' },
    { re: /^enum\s+(\w+)/, kind: 'enum' },
    { re: /^type\s+(\w+)/, kind: 'type' },
    { re: /^datasource\s+(\w+)/, kind: 'datasource' },
    { re: /^generator\s+(\w+)/, kind: 'generator' },
  ]);
  return makePartialFile(relativePath, 'prisma', [], symbols);
}

// Solidity — contract, interface, library, function, event, struct, enum, modifier
function summarizeSolidityFile(
  relativePath: string,
  source: string,
): Omit<RepoMapFile, 'lines'> | null {
  const lines = source.split(/\r?\n/);
  const imports: string[] = [];
  const symbols = symbolsFromLines(lines, [
    { re: /^contract\s+(\w+)/, kind: 'contract' },
    { re: /^interface\s+(\w+)/, kind: 'interface' },
    { re: /^library\s+(\w+)/, kind: 'library' },
    { re: /^\s*function\s+(\w+)/, kind: 'function' },
    { re: /^\s*event\s+(\w+)/, kind: 'event' },
    { re: /^\s*struct\s+(\w+)/, kind: 'struct' },
    { re: /^\s*enum\s+(\w+)/, kind: 'enum' },
    { re: /^\s*modifier\s+(\w+)/, kind: 'modifier' },
    { re: /^\s*error\s+(\w+)/, kind: 'error' },
  ]);
  for (const line of lines) {
    const m = /^import\s+(?:"([^"]+)"|'([^']+)')/.exec(line.trim());
    const imp = m?.[1] ?? m?.[2];
    if (imp && imports.length < 8) imports.push(imp);
  }
  return makePartialFile(relativePath, 'solidity', imports, symbols);
}

// Zig — pub fn, fn, const struct, const enum, pub const
function summarizeZigFile(relativePath: string, source: string): Omit<RepoMapFile, 'lines'> | null {
  const lines = source.split(/\r?\n/);
  const symbols = symbolsFromLines(lines, [
    { re: /^(?:pub\s+)?fn\s+(\w+)/, kind: 'function' },
    { re: /^(?:pub\s+)?const\s+(\w+)\s*=\s*struct/, kind: 'struct' },
    { re: /^(?:pub\s+)?const\s+(\w+)\s*=\s*enum/, kind: 'enum' },
    { re: /^(?:pub\s+)?const\s+(\w+)\s*=\s*union/, kind: 'union' },
    { re: /^(?:pub\s+)?const\s+(\w+)\s*:/, kind: 'const' },
    { re: /^(?:pub\s+)?var\s+(\w+)/, kind: 'var' },
  ]);
  return makePartialFile(relativePath, 'zig', [], symbols);
}

// Dart — class, abstract class, mixin, extension, enum, void/Future/Widget functions
function summarizeDartFile(
  relativePath: string,
  source: string,
): Omit<RepoMapFile, 'lines'> | null {
  const lines = source.split(/\r?\n/);
  const imports: string[] = [];
  const symbols = symbolsFromLines(lines, [
    { re: /^(?:abstract\s+)?class\s+(\w+)/, kind: 'class' },
    { re: /^mixin\s+(\w+)/, kind: 'mixin' },
    { re: /^extension\s+(\w+)/, kind: 'extension' },
    { re: /^enum\s+(\w+)/, kind: 'enum' },
    {
      re: /^(?:static\s+)?(?:void|Future|Widget|String|int|bool|double|dynamic)\s+(\w+)\s*\(/,
      kind: 'function',
    },
  ]);
  for (const line of lines) {
    const m = /^import\s+'([^']+)'/.exec(line.trim());
    if (m?.[1] && imports.length < 8) imports.push(m[1]);
  }
  return makePartialFile(relativePath, 'dart', imports, symbols);
}

// Kotlin — class, object, fun, interface, data class, sealed class, typealias
function summarizeKotlinFile(
  relativePath: string,
  source: string,
): Omit<RepoMapFile, 'lines'> | null {
  const lines = source.split(/\r?\n/);
  const imports: string[] = [];
  const symbols = symbolsFromLines(lines, [
    { re: /^(?:data\s+|sealed\s+|abstract\s+|open\s+|inner\s+)?class\s+(\w+)/, kind: 'class' },
    { re: /^(?:companion\s+)?object\s+(\w+)/, kind: 'object' },
    { re: /^interface\s+(\w+)/, kind: 'interface' },
    { re: /^fun\s+(\w+)/, kind: 'function' },
    { re: /^typealias\s+(\w+)/, kind: 'typealias' },
    { re: /^enum\s+class\s+(\w+)/, kind: 'enum' },
    { re: /^val\s+(\w+)/, kind: 'val' },
    { re: /^var\s+(\w+)/, kind: 'var' },
  ]);
  for (const line of lines) {
    const m = /^import\s+(\S+)/.exec(line.trim());
    if (m?.[1] && imports.length < 8) imports.push(m[1]);
  }
  return makePartialFile(relativePath, 'kotlin', imports, symbols);
}

// Swift — class, struct, protocol, enum, extension, func, typealias, actor
function summarizeSwiftFile(
  relativePath: string,
  source: string,
): Omit<RepoMapFile, 'lines'> | null {
  const lines = source.split(/\r?\n/);
  const imports: string[] = [];
  const symbols = symbolsFromLines(lines, [
    { re: /^(?:public\s+|private\s+|internal\s+|open\s+|final\s+)*class\s+(\w+)/, kind: 'class' },
    { re: /^(?:public\s+|private\s+|internal\s+)*struct\s+(\w+)/, kind: 'struct' },
    { re: /^(?:public\s+|private\s+|internal\s+)*protocol\s+(\w+)/, kind: 'protocol' },
    { re: /^(?:public\s+|private\s+|internal\s+)*enum\s+(\w+)/, kind: 'enum' },
    { re: /^(?:public\s+|private\s+|internal\s+)*extension\s+(\w+)/, kind: 'extension' },
    {
      re: /^(?:public\s+|private\s+|internal\s+|static\s+|class\s+)*func\s+(\w+)/,
      kind: 'function',
    },
    { re: /^typealias\s+(\w+)/, kind: 'typealias' },
    { re: /^actor\s+(\w+)/, kind: 'actor' },
  ]);
  for (const line of lines) {
    const m = /^import\s+(\w+)/.exec(line.trim());
    if (m?.[1] && imports.length < 8) imports.push(m[1]);
  }
  return makePartialFile(relativePath, 'swift', imports, symbols);
}

// Lua — function foo(), local function foo(), Foo = {}, Module:method()
function summarizeLuaFile(relativePath: string, source: string): Omit<RepoMapFile, 'lines'> | null {
  const lines = source.split(/\r?\n/);
  const symbols = symbolsFromLines(lines, [
    { re: /^(?:local\s+)?function\s+([\w.:]+)\s*\(/, kind: 'function' },
    { re: /^([\w.]+)\s*=\s*\{/, kind: 'module' },
    { re: /^local\s+(\w+)\s*=\s*require/, kind: 'import' },
  ]);
  return makePartialFile(relativePath, 'lua', [], symbols);
}

// Scala — class, object, trait, case class, def, type
function summarizeScalaFile(
  relativePath: string,
  source: string,
): Omit<RepoMapFile, 'lines'> | null {
  const lines = source.split(/\r?\n/);
  const imports: string[] = [];
  const symbols = symbolsFromLines(lines, [
    { re: /^(?:case\s+)?class\s+(\w+)/, kind: 'class' },
    { re: /^(?:case\s+)?object\s+(\w+)/, kind: 'object' },
    { re: /^trait\s+(\w+)/, kind: 'trait' },
    { re: /^(?:sealed\s+)?abstract\s+class\s+(\w+)/, kind: 'class' },
    { re: /^\s*def\s+(\w+)/, kind: 'def' },
    { re: /^\s*type\s+(\w+)/, kind: 'type' },
    { re: /^\s*val\s+(\w+)/, kind: 'val' },
    { re: /^given\s+(\w+)/, kind: 'given' },
  ]);
  for (const line of lines) {
    const m = /^import\s+(\S+)/.exec(line.trim());
    if (m?.[1] && imports.length < 8) imports.push(m[1]);
  }
  return makePartialFile(relativePath, 'scala', imports, symbols);
}

// Elixir — defmodule, def, defp, defmacro, defstruct, defprotocol
function summarizeElixirFile(
  relativePath: string,
  source: string,
): Omit<RepoMapFile, 'lines'> | null {
  const lines = source.split(/\r?\n/);
  const symbols = symbolsFromLines(lines, [
    { re: /^defmodule\s+([\w.]+)/, kind: 'module' },
    { re: /^\s*defprotocol\s+([\w.]+)/, kind: 'protocol' },
    { re: /^\s*defimpl\s+([\w.]+)/, kind: 'impl' },
    { re: /^\s*def\s+(\w+)/, kind: 'def' },
    { re: /^\s*defp\s+(\w+)/, kind: 'defp' },
    { re: /^\s*defmacro\s+(\w+)/, kind: 'macro' },
    { re: /^\s*defstruct\s+(.+)/, kind: 'struct' },
  ]);
  return makePartialFile(relativePath, 'elixir', [], symbols);
}

// Erlang — -module, -export, function/arity heads
function summarizeErlangFile(
  relativePath: string,
  source: string,
): Omit<RepoMapFile, 'lines'> | null {
  const lines = source.split(/\r?\n/);
  const symbols: RepoSymbol[] = [];
  const imports: string[] = [];
  for (const [i, line] of lines.entries()) {
    if (symbols.length >= 36) break;
    const trimmed = line.trim();
    const modM = /^-module\s*\(\s*(\w+)\s*\)/.exec(trimmed);
    if (modM?.[1]) {
      symbols.push({
        name: modM[1],
        kind: 'module',
        line: i + 1,
        signature: trimmed.slice(0, 120),
      });
      continue;
    }
    const expM = /^-export\s*\(\s*\[(.+)\]\s*\)/.exec(trimmed);
    if (expM?.[1]) {
      imports.push(expM[1].slice(0, 80));
      continue;
    }
    const fnM = /^(\w+)\s*\(/.exec(trimmed);
    if (fnM?.[1] && !trimmed.startsWith('-')) {
      symbols.push({
        name: fnM[1],
        kind: 'function',
        line: i + 1,
        signature: trimmed.slice(0, 120),
      });
    }
  }
  return makePartialFile(relativePath, 'erlang', imports.slice(0, 4), symbols);
}

// Haskell — module, data, type, newtype, class, instance
function summarizeHaskellFile(
  relativePath: string,
  source: string,
): Omit<RepoMapFile, 'lines'> | null {
  const lines = source.split(/\r?\n/);
  const imports: string[] = [];
  const symbols = symbolsFromLines(lines, [
    { re: /^module\s+([\w.]+)/, kind: 'module' },
    { re: /^data\s+(\w+)/, kind: 'data' },
    { re: /^newtype\s+(\w+)/, kind: 'newtype' },
    { re: /^type\s+(\w+)/, kind: 'type' },
    { re: /^class\s+.*\s+(\w+)(?:\s+\w+)*\s+where/, kind: 'class' },
    { re: /^instance\s+.*\s+(\w+)(?:\s+\w+)*\s+where/, kind: 'instance' },
    { re: /^(\w+)\s*::/, kind: 'function' },
  ]);
  for (const line of lines) {
    const m = /^import\s+(?:qualified\s+)?([\w.]+)/.exec(line.trim());
    if (m?.[1] && imports.length < 8) imports.push(m[1]);
  }
  return makePartialFile(relativePath, 'haskell', imports, symbols);
}

// Perl — package, sub, use
function summarizePerlFile(
  relativePath: string,
  source: string,
): Omit<RepoMapFile, 'lines'> | null {
  const lines = source.split(/\r?\n/);
  const imports: string[] = [];
  const symbols = symbolsFromLines(lines, [
    { re: /^package\s+([\w:]+)/, kind: 'package' },
    { re: /^sub\s+(\w+)/, kind: 'sub' },
    { re: /^my\s+(\$\w+)\s*=/, kind: 'var' },
    { re: /^our\s+(\$\w+)\s*=/, kind: 'var' },
  ]);
  for (const line of lines) {
    const m = /^use\s+([\w:]+)/.exec(line.trim());
    if (m?.[1] && imports.length < 8) imports.push(m[1]);
  }
  return makePartialFile(relativePath, 'perl', imports, symbols);
}

// R — function assignments: foo <- function(, foo = function(
function summarizeRFile(relativePath: string, source: string): Omit<RepoMapFile, 'lines'> | null {
  const lines = source.split(/\r?\n/);
  const imports: string[] = [];
  const symbols = symbolsFromLines(lines, [
    { re: /^(\w+)\s*(?:<-|=)\s*function\s*\(/, kind: 'function' },
    { re: /^(\w+)\s*(?:<-|=)\s*\bsetRefClass\b/, kind: 'class' },
    { re: /^(\w+)\s*(?:<-|=)\s*\bR6Class\b/, kind: 'class' },
    { re: /^(\w+)\s*(?:<-|=)\s*list\s*\(/, kind: 'module' },
  ]);
  for (const line of lines) {
    const m = /^(?:library|require)\(["']?([\w.]+)/.exec(line.trim());
    if (m?.[1] && imports.length < 8) imports.push(m[1]);
  }
  return makePartialFile(relativePath, 'r', imports, symbols);
}

// Clojure — ns, def, defn, defmacro, defprotocol, defrecord
function summarizeClojureFile(
  relativePath: string,
  source: string,
): Omit<RepoMapFile, 'lines'> | null {
  const lines = source.split(/\r?\n/);
  const symbols = symbolsFromLines(lines, [
    { re: /^\(ns\s+([\w.-]+)/, kind: 'namespace' },
    { re: /^\(defn-?\s+(\w+)/, kind: 'function' },
    { re: /^\(def\s+(\w+)/, kind: 'def' },
    { re: /^\(defmacro\s+(\w+)/, kind: 'macro' },
    { re: /^\(defprotocol\s+(\w+)/, kind: 'protocol' },
    { re: /^\(defrecord\s+(\w+)/, kind: 'record' },
    { re: /^\(defmulti\s+(\w+)/, kind: 'multimethod' },
  ]);
  return makePartialFile(relativePath, 'clojure', [], symbols);
}

// Vue — single-file component: script, template, style + component name from filename
function summarizeVueFile(relativePath: string, source: string): Omit<RepoMapFile, 'lines'> | null {
  const lines = source.split(/\r?\n/);
  const basename = path.basename(relativePath, '.vue');
  const symbols: RepoSymbol[] = [
    { name: basename, kind: 'component', line: 1, signature: `<component>${basename}</component>` },
  ];
  let inScript = false;
  for (const [i, line] of lines.entries()) {
    const trimmed = line.trim();
    if (/^<script/.test(trimmed)) {
      inScript = true;
      continue;
    }
    if (/^<\/script>/.test(trimmed)) {
      inScript = false;
      continue;
    }
    if (!inScript) continue;
    const m =
      /^(?:export\s+)?(?:const\s+)?(\w+)\s*(?:=\s*defineComponent|:\s*Component)/.exec(trimmed) ??
      /^(?:function|const|let)\s+(\w+)\s*[\(=]/.exec(trimmed) ??
      /^\s*(\w+)\s*\(/.exec(trimmed);
    if (m?.[1] && !['export', 'const', 'let', 'var', 'import', 'return'].includes(m[1])) {
      symbols.push({ name: m[1], kind: 'script', line: i + 1, signature: trimmed.slice(0, 120) });
    }
  }
  return makePartialFile(relativePath, 'vue', [], symbols);
}

// Svelte — single-file component: script exports + component name
function summarizeSvelteFile(
  relativePath: string,
  source: string,
): Omit<RepoMapFile, 'lines'> | null {
  const lines = source.split(/\r?\n/);
  const basename = path.basename(relativePath, '.svelte');
  const symbols: RepoSymbol[] = [
    { name: basename, kind: 'component', line: 1, signature: `<component>${basename}</component>` },
  ];
  let inScript = false;
  for (const [i, line] of lines.entries()) {
    const trimmed = line.trim();
    if (/^<script/.test(trimmed)) {
      inScript = true;
      continue;
    }
    if (/^<\/script>/.test(trimmed)) {
      inScript = false;
      continue;
    }
    if (!inScript) continue;
    const m =
      /^export\s+let\s+(\w+)/.exec(trimmed) ??
      /^export\s+(?:const|function)\s+(\w+)/.exec(trimmed) ??
      /^(?:const|let|var)\s+(\w+)/.exec(trimmed);
    if (m?.[1]) {
      symbols.push({ name: m[1], kind: 'export', line: i + 1, signature: trimmed.slice(0, 120) });
    }
  }
  return makePartialFile(relativePath, 'svelte', [], symbols);
}

// Astro — single-file component: frontmatter + component name
function summarizeAstroFile(
  relativePath: string,
  source: string,
): Omit<RepoMapFile, 'lines'> | null {
  const lines = source.split(/\r?\n/);
  const basename = path.basename(relativePath, '.astro');
  const symbols: RepoSymbol[] = [
    { name: basename, kind: 'component', line: 1, signature: `<component>${basename}</component>` },
  ];
  let inFrontmatter = false;
  let frontmatterEnd = false;
  for (const [i, line] of lines.entries()) {
    const trimmed = line.trim();
    if (i === 0 && trimmed === '---') {
      inFrontmatter = true;
      continue;
    }
    if (inFrontmatter && trimmed === '---') {
      frontmatterEnd = true;
      continue;
    }
    if (inFrontmatter && !frontmatterEnd) {
      const m = /^(?:import|const|let|function)\s+(\w+)/.exec(trimmed);
      if (m?.[1])
        symbols.push({
          name: m[1],
          kind: 'frontmatter',
          line: i + 1,
          signature: trimmed.slice(0, 120),
        });
    }
  }
  return makePartialFile(relativePath, 'astro', [], symbols);
}

// XML — tag names, id attributes, key attributes
function summarizeXmlFile(relativePath: string, source: string): Omit<RepoMapFile, 'lines'> | null {
  const lines = source.split(/\r?\n/);
  const symbols: RepoSymbol[] = [];
  const seenTags = new Set<string>();
  for (const [i, line] of lines.entries()) {
    if (symbols.length >= 36) break;
    // Named elements with id
    const idMatch = /id=["']([^"']+)["']/.exec(line);
    if (idMatch?.[1]) {
      symbols.push({
        name: idMatch[1],
        kind: 'id',
        line: i + 1,
        signature: line.trim().slice(0, 120),
      });
    }
    // First occurrence of each tag name
    const tagMatch = /<([A-Za-z][\w:.-]+)[\s/>]/.exec(line);
    const tag = tagMatch?.[1];
    if (tag && !seenTags.has(tag)) {
      seenTags.add(tag);
      symbols.push({
        name: tag,
        kind: 'element',
        line: i + 1,
        signature: line.trim().slice(0, 120),
      });
    }
    // key/name attributes for config XML
    const keyMatch = /\b(?:name|key)\s*=\s*["']([^"']+)["']/.exec(line);
    if (keyMatch?.[1] && keyMatch[1] !== idMatch?.[1]) {
      symbols.push({
        name: keyMatch[1],
        kind: 'attr',
        line: i + 1,
        signature: line.trim().slice(0, 120),
      });
    }
  }
  return makePartialFile(relativePath, 'xml', [], symbols);
}

// Gradle (.gradle, .gradle.kts) — plugins, tasks, dependencies section headers
function summarizeGradleFile(
  relativePath: string,
  source: string,
): Omit<RepoMapFile, 'lines'> | null {
  const lines = source.split(/\r?\n/);
  const symbols = symbolsFromLines(lines, [
    { re: /^\s*id\s*[('"]([^'"]+)['"]\)?/, kind: 'plugin' },
    { re: /^\s*task\s+(\w+)/, kind: 'task' },
    { re: /^(?:def|val)\s+(\w+)/, kind: 'variable' },
    { re: /^\s*implementation\s*[('"]([^'"]+)['")]/, kind: 'dependency' },
    { re: /^\s*api\s*[('"]([^'"]+)['")]/, kind: 'dependency' },
  ]);
  return makePartialFile(relativePath, 'gradle', [], symbols);
}

// .env files — key=VALUE (values are redacted for security)
function summarizeEnvFile(relativePath: string, source: string): Omit<RepoMapFile, 'lines'> | null {
  const lines = source.split(/\r?\n/);
  const symbols: RepoSymbol[] = [];
  for (const [i, line] of lines.entries()) {
    if (symbols.length >= 36) break;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)(?:\s*=|\s*:)/.exec(trimmed);
    if (m?.[1]) {
      symbols.push({
        name: m[1],
        kind: 'config',
        line: i + 1,
        signature: `${m[1]}=***REDACTED***`,
      });
    }
  }
  return makePartialFile(relativePath, 'env', [], symbols);
}

// Log files — ERROR, WARN, FATAL, exception class names
function summarizeLogFile(relativePath: string, source: string): Omit<RepoMapFile, 'lines'> | null {
  const lines = source.split(/\r?\n/);
  const symbols: RepoSymbol[] = [];
  const errorPattern = /\b(ERROR|FATAL|CRITICAL|EXCEPTION|Exception|Error)\b/;
  const warnPattern = /\b(WARN(?:ING)?)\b/;
  for (const [i, line] of lines.entries()) {
    if (symbols.length >= 36) break;
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (errorPattern.test(trimmed)) {
      symbols.push({ name: 'ERROR', kind: 'error', line: i + 1, signature: trimmed.slice(0, 120) });
    } else if (warnPattern.test(trimmed)) {
      symbols.push({ name: 'WARN', kind: 'warn', line: i + 1, signature: trimmed.slice(0, 120) });
    }
  }
  return makePartialFile(relativePath, 'log', [], symbols);
}

// GDScript (.gd) — Godot Engine scripting language (no WASM grammar available)
function summarizeGdscriptFile(
  relativePath: string,
  source: string,
): Omit<RepoMapFile, 'lines'> | null {
  const lines = source.split(/\r?\n/);
  const imports: string[] = [];
  const symbols: RepoSymbol[] = [];

  for (const [i, line] of lines.entries()) {
    if (symbols.length >= 36) break;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // extends ClassName → import
    const ext = /^extends\s+([\w.]+)/.exec(trimmed);
    if (ext?.[1]) {
      imports.push(ext[1]);
      continue;
    }

    // class_name MyName → class
    const cn = /^class_name\s+(\w+)/.exec(trimmed);
    if (cn?.[1]) {
      symbols.push({ name: cn[1], kind: 'class', line: i + 1, signature: trimmed.slice(0, 120) });
      continue;
    }

    // func my_func(...): → function
    const fn = /^func\s+(\w+)\s*\(/.exec(trimmed);
    if (fn?.[1]) {
      symbols.push({
        name: fn[1],
        kind: 'function',
        line: i + 1,
        signature: trimmed.slice(0, 120),
      });
      continue;
    }

    // signal my_signal → signal (Godot-specific)
    const sig = /^signal\s+(\w+)/.exec(trimmed);
    if (sig?.[1]) {
      symbols.push({ name: sig[1], kind: 'signal', line: i + 1, signature: trimmed.slice(0, 120) });
      continue;
    }

    // enum MyEnum { ... } → enum
    const en = /^enum\s+(\w+)/.exec(trimmed);
    if (en?.[1]) {
      symbols.push({ name: en[1], kind: 'enum', line: i + 1, signature: trimmed.slice(0, 120) });
      continue;
    }

    // class InnerClass: → inner class
    const ic = /^class\s+(\w+)\s*(?:extends\s+\w+)?\s*:/.exec(trimmed);
    if (ic?.[1]) {
      symbols.push({ name: ic[1], kind: 'class', line: i + 1, signature: trimmed.slice(0, 120) });
      continue;
    }

    // const MAX = ... / const MAX := ... → const (:= is GDScript walrus)
    const co = /^const\s+(\w+)\s*(?::\s*\w+)?\s*:?=/.exec(trimmed);
    if (co?.[1]) {
      symbols.push({ name: co[1], kind: 'const', line: i + 1, signature: trimmed.slice(0, 120) });
      continue;
    }

    // @export var / @onready var / var → var
    const va = /^(?:@\w+\s+)*var\s+(\w+)/.exec(trimmed);
    if (va?.[1]) {
      symbols.push({ name: va[1], kind: 'var', line: i + 1, signature: trimmed.slice(0, 120) });
    }
  }

  return makePartialFile(relativePath, 'gdscript', imports.slice(0, 8), symbols);
}

// MATLAB / Octave (.m) — function, classdef, sections, properties/methods blocks
function summarizeMatlabFile(
  relativePath: string,
  source: string,
): Omit<RepoMapFile, 'lines'> | null {
  const lines = source.split(/\r?\n/);
  const imports: string[] = [];
  const symbols: RepoSymbol[] = [];

  for (const [i, line] of lines.entries()) {
    if (symbols.length >= 36) break;
    const trimmed = line.trim();
    if (!trimmed) continue;

    // %% Section Title (Live Script / script section markers)
    const sec = /^%%\s*(.+)/.exec(trimmed);
    if (sec?.[1]) {
      symbols.push({
        name: sec[1].trim(),
        kind: 'section',
        line: i + 1,
        signature: trimmed.slice(0, 120),
      });
      continue;
    }

    // Skip other comments
    if (trimmed.startsWith('%')) continue;

    // classdef ClassName or classdef ClassName < SuperClass
    const cd = /^classdef\s+(\w+)/.exec(trimmed);
    if (cd?.[1]) {
      symbols.push({ name: cd[1], kind: 'class', line: i + 1, signature: trimmed.slice(0, 120) });
      continue;
    }

    // function [out1,out2] = name(args)  |  function out = name(args)  |  function name(args)  |  function name
    // Pattern: after 'function', optional return spec (word/bracket before '='), then the function name
    const fn = /^function\s+(?:[\w\s,[\]]+?=\s*)?(\w+)\s*(?:\(|$)/.exec(trimmed);
    if (fn?.[1] && fn[1] !== 'end') {
      symbols.push({
        name: fn[1],
        kind: 'function',
        line: i + 1,
        signature: trimmed.slice(0, 120),
      });
      continue;
    }

    // properties / methods / events / enumeration block keywords (inside classdef)
    const blk = /^(properties|methods|events|enumeration)\s*(?:\(|%|$)/.exec(trimmed);
    if (blk?.[1]) {
      symbols.push({ name: blk[1], kind: 'block', line: i + 1, signature: trimmed.slice(0, 120) });
      continue;
    }

    // import java.util.*  /  addpath(...)
    const imp = /^(?:import|addpath)\s+['"]?([^\s'"(]+)/.exec(trimmed);
    if (imp?.[1]) {
      imports.push(imp[1]);
    }
  }

  return makePartialFile(relativePath, 'matlab', imports.slice(0, 8), symbols);
}

// GitHub Actions / CI YAML — detected by content (has 'on:' trigger + 'jobs:' sections)
function summarizeGithubActionsFile(
  relativePath: string,
  source: string,
): Omit<RepoMapFile, 'lines'> | null {
  // Raw-text detection first — js-yaml YAML 1.1 parses 'on' as boolean true
  if (!/^on\s*:/m.test(source) || !/^jobs\s*:/m.test(source)) return null;

  let parsed: unknown;
  try {
    parsed = yaml.load(source);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const doc = parsed as Record<string, unknown>;

  const symbols: RepoSymbol[] = [];
  const imports: string[] = [];

  // Workflow name
  if (typeof doc.name === 'string') {
    symbols.push({ name: doc.name, kind: 'workflow', line: 1, signature: `workflow: ${doc.name}` });
  }

  // Triggers from raw source (YAML 1.1 parses 'on' as true, so we use regex)
  const knownTriggers = [
    'push',
    'pull_request',
    'workflow_dispatch',
    'schedule',
    'release',
    'issues',
    'create',
    'delete',
    'workflow_call',
    'issue_comment',
    'check_run',
    'deployment',
    'fork',
    'label',
    'milestone',
    'public',
    'watch',
  ];
  const foundTriggers: string[] = [];
  for (const t of knownTriggers) {
    if (
      new RegExp(`^[ \\t]+${t}\\b`, 'm').test(source) ||
      new RegExp(`^on:\\s*\\[?[^\\n]*\\b${t}\\b`, 'm').test(source)
    ) {
      foundTriggers.push(t);
    }
  }
  for (const trigger of foundTriggers.slice(0, 4)) {
    symbols.push({ name: trigger, kind: 'trigger', line: 1, signature: `on: ${trigger}` });
  }

  // Jobs: js-yaml parses 'jobs' correctly
  if (doc.jobs && typeof doc.jobs === 'object' && !Array.isArray(doc.jobs)) {
    for (const [jobId, job] of Object.entries(doc.jobs as Record<string, unknown>).slice(0, 12)) {
      const jobObj = (job ?? {}) as Record<string, unknown>;
      const display = typeof jobObj.name === 'string' ? jobObj.name : jobId;
      symbols.push({ name: jobId, kind: 'job', line: 1, signature: `job: ${display}` });
      // Action imports from steps
      if (Array.isArray(jobObj.steps)) {
        for (const step of (jobObj.steps as Array<Record<string, unknown>>).slice(0, 8)) {
          if (typeof step.uses === 'string') {
            const action = step.uses.split('@')[0];
            if (action && !imports.includes(action)) imports.push(action);
          }
        }
      }
    }
  }

  return makePartialFile(relativePath, 'github-actions', imports.slice(0, 8), symbols);
}

// Nix expression language (.nix) — derivations, functions, attribute sets
function summarizeNixFile(relativePath: string, source: string): Omit<RepoMapFile, 'lines'> | null {
  const lines = source.split(/\r?\n/);
  const imports: string[] = [];
  const symbols: RepoSymbol[] = [];
  const seen = new Set<string>();
  const skipWords = new Set([
    'let',
    'in',
    'if',
    'then',
    'else',
    'with',
    'assert',
    'rec',
    'inherit',
    'builtins',
  ]);

  for (const [i, line] of lines.entries()) {
    if (symbols.length >= 36) break;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // import <nixpkgs> / import ./path / import ../path
    const imp = /\bimport\s+(<[^>]+>|\.\.?\/[\w./:-]+)/.exec(trimmed);
    if (imp?.[1] && !imports.includes(imp[1])) imports.push(imp[1]);

    // Top-level (col 0) attribute: name = ...
    if (!line.startsWith(' ') && !line.startsWith('\t')) {
      const attr = /^([\w][\w-]*)\s*=/.exec(trimmed);
      if (attr?.[1] && !skipWords.has(attr[1]) && !seen.has(attr[1])) {
        seen.add(attr[1]);
        const isMk =
          /\bmk(Derivation|Shell|Package|PythonApp|HaskellApp)\b|\bstdenv\.mkDerivation\b/.test(
            trimmed,
          );
        symbols.push({
          name: attr[1],
          kind: isMk ? 'derivation' : 'attr',
          line: i + 1,
          signature: trimmed.slice(0, 120),
        });
      }
    }

    // mkDerivation / mkShell with pname/name on same line
    const mkCall = /\b(mkDerivation|mkShell|mkPackage|stdenv\.mkDerivation)\s*(?:\{|rec\s*\{)/.exec(
      trimmed,
    );
    if (mkCall) {
      const pname =
        /\bpname\s*=\s*"([^"]+)"/.exec(trimmed) ?? /\bname\s*=\s*"([^"]+)"/.exec(trimmed);
      if (pname?.[1] && !seen.has(pname[1])) {
        seen.add(pname[1]);
        symbols.push({
          name: pname[1],
          kind: 'derivation',
          line: i + 1,
          signature: trimmed.slice(0, 120),
        });
      }
    }
  }

  return makePartialFile(relativePath, 'nix', imports.slice(0, 8), symbols);
}

// Jupyter Notebook (.ipynb) — cell headings, code defs, imports
function summarizeJupyterFile(
  relativePath: string,
  source: string,
): Omit<RepoMapFile, 'lines'> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return null;
  }
  const nb = parsed as Record<string, unknown>;
  if (!Array.isArray(nb.cells)) return null;

  const symbols: RepoSymbol[] = [];
  const imports: string[] = [];
  let lineNum = 1;

  // Kernel name from metadata
  const meta = nb.metadata as Record<string, unknown> | undefined;
  const kernelName = ((meta?.kernelspec as Record<string, unknown>)?.display_name as string) ?? '';
  if (kernelName) {
    symbols.push({ name: kernelName, kind: 'kernel', line: 1, signature: `kernel: ${kernelName}` });
  }

  for (const cell of nb.cells as Array<Record<string, unknown>>) {
    if (symbols.length >= 36) break;
    const cellType = cell.cell_type as string;
    const srcRaw = cell.source as string[] | string | undefined;
    const src = Array.isArray(srcRaw) ? srcRaw.join('') : (srcRaw ?? '');

    if (cellType === 'markdown') {
      const h = /^(#{1,4})\s+(.+)/m.exec(src);
      if (h?.[2] && h[1]) {
        symbols.push({
          name: h[2].trim(),
          kind: `h${h[1].length}`,
          line: lineNum,
          signature: h[0].trim().slice(0, 120),
        });
      }
    } else if (cellType === 'code') {
      for (const raw of src.split('\n').slice(0, 30)) {
        const t = raw.trim();
        const pyImp = /^(?:import|from)\s+([\w.]+)/.exec(t);
        if (pyImp?.[1] && !imports.includes(pyImp[1])) {
          imports.push(pyImp[1]);
          continue;
        }
        const def = /^(?:def|async def|class)\s+(\w+)/.exec(t);
        if (def?.[1]) {
          symbols.push({
            name: def[1],
            kind: t.startsWith('class') ? 'class' : 'function',
            line: lineNum,
            signature: t.slice(0, 120),
          });
        }
      }
    }

    lineNum += src.split('\n').length + 1;
  }

  return makePartialFile(relativePath, 'jupyter', imports.slice(0, 8), symbols);
}

// yarn.lock — package name + version entries
function summarizeYarnLockFile(
  relativePath: string,
  source: string,
): Omit<RepoMapFile, 'lines'> | null {
  const lines = source.split(/\r?\n/);
  const symbols: RepoSymbol[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (symbols.length >= 36) break;
    const line = lines[i];
    if (!line || line.startsWith('#') || line.startsWith(' ') || line.startsWith('\t')) continue;
    // "name@^ver", "name@ver": or name@ver:
    const m = /^"?(@?[\w./-]+)@/.exec(line.trim());
    if (!m?.[1]) continue;
    let version = '?';
    for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
      const vMatch = /^\s+version\s+"?([^\s"]+)"?/.exec(lines[j] ?? '');
      if (vMatch?.[1]) {
        version = vMatch[1];
        break;
      }
    }
    symbols.push({ name: m[1], kind: 'package', line: i + 1, signature: `${m[1]}@${version}` });
  }

  return makePartialFile(relativePath, 'yarn-lock', [], symbols);
}

// Cargo.lock — Rust crate names + versions
function summarizeCargoLockFile(
  relativePath: string,
  source: string,
): Omit<RepoMapFile, 'lines'> | null {
  const lines = source.split(/\r?\n/);
  const symbols: RepoSymbol[] = [];
  let name = '';
  let version = '';

  const flush = (lineNum: number) => {
    if (name && symbols.length < 36) {
      symbols.push({ name, kind: 'crate', line: lineNum, signature: `${name} ${version}` });
    }
    name = '';
    version = '';
  };

  for (const [i, line] of lines.entries()) {
    const trimmed = line.trim();
    if (trimmed === '[[package]]') {
      flush(i + 1);
      continue;
    }
    const nm = /^name\s*=\s*"([^"]+)"/.exec(trimmed);
    if (nm?.[1]) {
      name = nm[1];
      continue;
    }
    const vm = /^version\s*=\s*"([^"]+)"/.exec(trimmed);
    if (vm?.[1]) {
      version = vm[1];
    }
  }
  flush(lines.length);

  return makePartialFile(relativePath, 'cargo-lock', [], symbols);
}

// Gemfile.lock — Ruby gem names + versions from SPECS section
function summarizeGemfileLockFile(
  relativePath: string,
  source: string,
): Omit<RepoMapFile, 'lines'> | null {
  const lines = source.split(/\r?\n/);
  const symbols: RepoSymbol[] = [];
  let inSpecs = false;

  for (const [i, line] of lines.entries()) {
    if (symbols.length >= 36) break;
    const trimmed = line.trim();
    if (trimmed === 'specs:') {
      inSpecs = true;
      continue;
    }
    if (trimmed === '' && inSpecs) {
      inSpecs = false;
      continue;
    }
    if (/^[A-Z]/.test(trimmed)) {
      inSpecs = false;
    }

    // 4-space-indented top-level gems: "    name (version)"
    if (inSpecs && /^ {4}\S/.test(line)) {
      const m = /^ {4}([\w-]+(?:\/[\w-]+)?)\s+\(([^)]+)\)/.exec(line);
      if (m?.[1]) {
        symbols.push({ name: m[1], kind: 'gem', line: i + 1, signature: `${m[1]} (${m[2]})` });
      }
    }
  }

  return makePartialFile(relativePath, 'gemfile-lock', [], symbols);
}

// composer.lock — PHP Composer package names + versions (JSON format)
function summarizeComposerLockFile(
  relativePath: string,
  source: string,
): Omit<RepoMapFile, 'lines'> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return null;
  }
  const lock = parsed as Record<string, unknown>;
  const allPkgs = [
    ...(Array.isArray(lock.packages) ? lock.packages : []),
    ...(Array.isArray(lock['packages-dev']) ? lock['packages-dev'] : []),
  ];
  const symbols: RepoSymbol[] = [];

  for (const pkg of allPkgs.slice(0, 36)) {
    const p = pkg as Record<string, unknown>;
    if (typeof p.name === 'string' && typeof p.version === 'string') {
      symbols.push({ name: p.name, kind: 'package', line: 1, signature: `${p.name} ${p.version}` });
    }
  }

  return makePartialFile(relativePath, 'composer-lock', [], symbols);
}

// WebAssembly Text Format (.wat / .wast) — S-expression based
function summarizeWatFile(relativePath: string, source: string): Omit<RepoMapFile, 'lines'> | null {
  const lines = source.split(/\r?\n/);
  const imports: string[] = [];
  const symbols: RepoSymbol[] = [];

  for (const [i, line] of lines.entries()) {
    if (symbols.length >= 36) break;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(';;')) continue;

    // (import "module" "name" ...) → import
    const imp = /\(import\s+"([^"]+)"\s+"([^"]+)"/.exec(trimmed);
    if (imp?.[1] && imp[2]) {
      imports.push(`${imp[1]}::${imp[2]}`);
      continue;
    }

    // (func $name ...) — named function
    const namedFn = /\(func\s+(\$[\w.]+)/.exec(trimmed);
    if (namedFn?.[1]) {
      symbols.push({
        name: namedFn[1],
        kind: 'func',
        line: i + 1,
        signature: trimmed.slice(0, 120),
      });
      continue;
    }

    // (func (export "name") ...) — anonymous exported function
    const expFn = /\(func\s+\(export\s+"([^"]+)"\)/.exec(trimmed);
    if (expFn?.[1]) {
      symbols.push({
        name: `export:${expFn[1]}`,
        kind: 'func',
        line: i + 1,
        signature: trimmed.slice(0, 120),
      });
      continue;
    }

    // (export "name" ...) — standalone export declaration
    const exp = /^\(export\s+"([^"]+)"/.exec(trimmed);
    if (exp?.[1]) {
      symbols.push({ name: exp[1], kind: 'export', line: i + 1, signature: trimmed.slice(0, 120) });
      continue;
    }

    // (global $name ...) — global variable
    const glob = /\(global\s+(\$[\w.]+)/.exec(trimmed);
    if (glob?.[1]) {
      symbols.push({
        name: glob[1],
        kind: 'global',
        line: i + 1,
        signature: trimmed.slice(0, 120),
      });
      continue;
    }

    // (type $name ...) — type definition
    const type_ = /\(type\s+(\$[\w.]+)/.exec(trimmed);
    if (type_?.[1]) {
      symbols.push({ name: type_[1], kind: 'type', line: i + 1, signature: trimmed.slice(0, 120) });
      continue;
    }

    // (memory ...) / (table ...) — module resources
    const res = /^\((memory|table)\b/.exec(trimmed);
    if (res?.[1]) {
      symbols.push({ name: res[1], kind: res[1], line: i + 1, signature: trimmed.slice(0, 120) });
      continue;
    }

    // (data ...) / (elem ...) — data segments
    const seg = /^\((data|elem)\b/.exec(trimmed);
    if (seg?.[1]) {
      symbols.push({
        name: seg[1],
        kind: 'segment',
        line: i + 1,
        signature: trimmed.slice(0, 120),
      });
    }
  }

  return makePartialFile(relativePath, 'webassembly', imports.slice(0, 8), symbols);
}

// Assembly (.asm, .s, .S, .nasm) — supports NASM (Intel), GAS (AT&T), and ARM syntax
function summarizeAssemblyFile(
  relativePath: string,
  source: string,
): Omit<RepoMapFile, 'lines'> | null {
  const lines = source.split(/\r?\n/);
  const imports: string[] = [];
  const symbols: RepoSymbol[] = [];

  for (const [i, line] of lines.entries()) {
    if (symbols.length >= 36) break;
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Skip pure comment lines (; NASM, # GAS, @ ARM, // C-style)
    if (/^[;#@]|^\/\//.test(trimmed)) continue;

    // GAS .type name, @function → function label
    const gasTypeFn = /^\.type\s+(\w+)\s*,\s*[@%]function/i.exec(trimmed);
    if (gasTypeFn?.[1]) {
      symbols.push({
        name: gasTypeFn[1],
        kind: 'function',
        line: i + 1,
        signature: trimmed.slice(0, 120),
      });
      continue;
    }

    // NASM %macro name / GAS .macro name → macro definition
    const macroDecl = /^(?:%macro|\.macro)\s+(\w+)/i.exec(trimmed);
    if (macroDecl?.[1]) {
      symbols.push({
        name: macroDecl[1],
        kind: 'macro',
        line: i + 1,
        signature: trimmed.slice(0, 120),
      });
      continue;
    }

    // NASM %define NAME / GAS .equ NAME / ARM .set NAME → constants
    const constDecl = /^(?:%define|\.equ|\.set|\.equiv)\s+(\w+)/i.exec(trimmed);
    if (constDecl?.[1]) {
      symbols.push({
        name: constDecl[1],
        kind: 'const',
        line: i + 1,
        signature: trimmed.slice(0, 120),
      });
      continue;
    }

    // MASM/NASM EQU: NAME EQU value
    const equDecl = /^(\w+)\s+EQU\s+/i.exec(trimmed);
    if (equDecl?.[1]) {
      symbols.push({
        name: equDecl[1],
        kind: 'const',
        line: i + 1,
        signature: trimmed.slice(0, 120),
      });
      continue;
    }

    // NASM global / GAS .global → exported symbols
    const globalDecl = /^(?:global|\.global|\.globl)\s+(\w+)/i.exec(trimmed);
    if (globalDecl?.[1]) {
      symbols.push({
        name: globalDecl[1],
        kind: 'global',
        line: i + 1,
        signature: trimmed.slice(0, 120),
      });
      continue;
    }

    // NASM extern / GAS .extern → imports
    const externDecl = /^(?:extern|\.extern)\s+(\w+)/i.exec(trimmed);
    if (externDecl?.[1]) {
      imports.push(externDecl[1]);
      continue;
    }

    // Section markers: NASM "section .text" / GAS ".text" / ".section .data"
    const sectionDecl =
      /^(?:section\s+)?(\.(text|data|bss|rodata|code|const|init|fini|plt|got|tdata|tbss))\b/i.exec(
        trimmed,
      );
    if (sectionDecl?.[1]) {
      symbols.push({
        name: sectionDecl[1],
        kind: 'section',
        line: i + 1,
        signature: trimmed.slice(0, 120),
      });
      continue;
    }

    // GAS .include / NASM %include → file imports
    const includeDecl = /^(?:\.include|%include)\s+["']([^"']+)["']/i.exec(trimmed);
    if (includeDecl?.[1]) {
      imports.push(includeDecl[1]);
      continue;
    }

    // Top-level labels only (lines not starting with whitespace): name:
    if (!line.startsWith(' ') && !line.startsWith('\t')) {
      const labelDecl = /^(\w+)\s*:(?:\s|$)/.exec(trimmed);
      if (labelDecl?.[1]) {
        // Skip data directives used as label names
        const skip = new Set([
          'DB',
          'DW',
          'DD',
          'DQ',
          'DT',
          'RESB',
          'RESW',
          'RESD',
          'RESQ',
          'BYTE',
          'WORD',
          'DWORD',
          'QWORD',
        ]);
        if (!skip.has(labelDecl[1].toUpperCase())) {
          symbols.push({
            name: labelDecl[1],
            kind: 'label',
            line: i + 1,
            signature: trimmed.slice(0, 120),
          });
        }
      }
    }
  }

  return makePartialFile(relativePath, 'asm', imports.slice(0, 8), symbols);
}

// ---------------------------------------------------------------------------

function summarizeFallbackFile(
  relativePath: string,
  extension: string,
  source: string,
): Omit<RepoMapFile, 'lines'> {
  const isSecretFile =
    relativePath === '.env' ||
    relativePath.startsWith('.env.') ||
    relativePath.toLowerCase().includes('secret') ||
    extension === '.env';

  const imports: string[] = [];
  const symbols: RepoSymbol[] = [];
  const lines = source.split(/\r?\n/);

  const symbolPatterns = [
    { regex: /^(?:export\s+)?function\s+([A-Za-z_]\w*)\s*\(/, kind: 'function' },
    { regex: /^([A-Za-z_]\w*)\s*=\s*function\s*\(/, kind: 'function' },
    { regex: /^(?:export\s+)?class\s+([A-Za-z_]\w*)\b/, kind: 'class' },
    { regex: /^def\s+([A-Za-z_]\w*)\s*\(/, kind: 'function' },
    { regex: /^(?:export\s+)?const\s+([A-Za-z_]\w*)\s*=/, kind: 'export' },
    { regex: /^module\s+([A-Za-z_]\w*)\b/, kind: 'module' },
  ];

  const commentPatterns = [{ regex: /\b(TODO|FIXME|ERROR|BUG)\b/i, kind: 'comment' }];

  const headingPattern = /^(#{1,6})\s+(.+)$/;
  const altHeadingPattern1 = /^={3,}$/;
  const altHeadingPattern2 = /^-{3,}$/;

  const configPattern = /^(?:export\s+|ENV\s+|ARG\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*[:=]\s*(.*)$/;

  let previousLine = '';

  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim();

    // Imports
    if (/^(import\s|from\s.+\simport\s|#include\b)/.test(line)) {
      if (imports.length < 8) {
        imports.push(line);
      }
      previousLine = rawLine;
      continue;
    }

    // Config / Env files
    if (isSecretFile && line && !line.startsWith('#')) {
      const configMatch = configPattern.exec(line);
      if (configMatch?.[1]) {
        symbols.push({
          name: configMatch[1],
          kind: 'config',
          line: index + 1,
          signature: `${configMatch[1]}=***REDACTED***`,
        });
        previousLine = rawLine;
        continue;
      }
    } else if (
      !isSecretFile &&
      extension !== '.gml' &&
      extension !== '.js' &&
      extension !== '.ts'
    ) {
      // Config-like keys for generic text
      const configMatch = configPattern.exec(line);
      if (configMatch?.[1] && line.length < 100) {
        symbols.push({
          name: configMatch[1],
          kind: 'config',
          line: index + 1,
          signature: compressText(line),
        });
        previousLine = rawLine;
        continue;
      }
    }

    // Headings
    const headingMatch = headingPattern.exec(line);
    if (headingMatch) {
      symbols.push({
        name: headingMatch[2]?.trim() ?? '',
        kind: `h${headingMatch[1]?.length ?? 0}`,
        line: index + 1,
        signature: compressText(line),
      });
      previousLine = rawLine;
      continue;
    }

    // Markdown alt headings (=== / ---)
    if ((altHeadingPattern1.test(line) || altHeadingPattern2.test(line)) && previousLine.trim()) {
      symbols.push({
        name: previousLine.trim(),
        kind: altHeadingPattern1.test(line) ? 'h1' : 'h2',
        line: index, // points to the text line
        signature: compressText(previousLine),
      });
      previousLine = rawLine;
      continue;
    }

    // Symbols (functions, classes, modules, exports)
    let matchedSymbol = false;
    for (const { regex, kind } of symbolPatterns) {
      const match = regex.exec(line);
      if (match?.[1]) {
        symbols.push({
          name: match[1],
          kind,
          line: index + 1,
          signature: compressText(line),
        });
        matchedSymbol = true;
        break;
      }
    }
    if (matchedSymbol) {
      previousLine = rawLine;
      continue;
    }

    // GML special cases
    if (extension === '.gml') {
      const gmlMatch =
        /^(?:function\s+)?([A-Za-z_]\w*)\s*=\s*function\s*\(|^function\s+([A-Za-z_]\w*)\s*\(/.exec(
          line,
        );
      const name = gmlMatch?.[1] ?? gmlMatch?.[2];
      if (name) {
        symbols.push({
          name,
          kind: 'function',
          line: index + 1,
          signature: compressText(line),
        });
        previousLine = rawLine;
        continue;
      }
    }

    // TODO / FIXME / ERROR
    for (const { regex, kind } of commentPatterns) {
      const match = regex.exec(line);
      if (match?.[1]) {
        symbols.push({
          name: match[1].toUpperCase(),
          kind,
          line: index + 1,
          signature: compressText(line),
        });
        break;
      }
    }

    previousLine = rawLine;
  }

  return {
    path: relativePath,
    language: extension === '.gml' ? 'gml' : inferLanguageLabel(extension),
    parser: 'fallback',
    imports,
    symbols: dedupeSymbols(symbols).slice(0, 36),
  };
}

function extractGmlSymbols(rootNode: GmlCstNode, source: string): RepoSymbol[] {
  const symbols: RepoSymbol[] = [];

  visitGmlCst(rootNode, (node) => {
    if (node.name === 'functionStatement') {
      const functionExpression = firstGmlNode(node.children.functionExpression);
      const identifier = firstToken(functionExpression?.children.Identifier);

      if (identifier?.image) {
        // GML 2.3 OOP: function Foo() constructor {} → kind: 'constructor'
        const isConstructor = (functionExpression?.children.constructorSuffix?.length ?? 0) > 0;
        symbols.push({
          name: identifier.image,
          kind: isConstructor ? 'constructor' : 'function',
          line: identifier.startLine ?? functionExpression?.location?.startLine ?? 1,
          signature: getSourceSignature(source, functionExpression?.location?.startLine ?? 1),
        });
      }

      return;
    }

    if (node.name === 'variableAssignment') {
      const identifier = firstToken(node.children.Identifier);
      const functionExpression = findFirstNamedNode(
        node.children.assignmentRightHandSide,
        'functionExpression',
      );

      if (identifier?.image && functionExpression) {
        const isConstructor = (functionExpression.children.constructorSuffix?.length ?? 0) > 0;
        symbols.push({
          name: identifier.image,
          kind: isConstructor ? 'constructor' : 'function',
          line: identifier.startLine ?? functionExpression.location?.startLine ?? 1,
          signature: getSourceSignature(source, functionExpression.location?.startLine ?? 1),
        });
      }

      return;
    }

    if (node.name === 'macroStatement') {
      const identifier = firstToken(node.children.Identifier);

      if (identifier?.image) {
        symbols.push({
          name: identifier.image,
          kind: 'macro',
          line: identifier.startLine ?? node.location?.startLine ?? 1,
          signature: getSourceSignature(source, node.location?.startLine ?? 1),
        });
      }

      return;
    }

    if (node.name === 'enumStatement') {
      const identifier = firstToken(node.children.Identifier);

      if (identifier?.image) {
        symbols.push({
          name: identifier.image,
          kind: 'enum',
          line: identifier.startLine ?? node.location?.startLine ?? 1,
          signature: getSourceSignature(source, node.location?.startLine ?? 1),
        });
      }

      return;
    }

    // GML globalvar declarations: globalvar foo, bar;
    if (node.name === 'globalVarDeclaration') {
      const identifier = firstToken(node.children.Identifier);
      if (identifier?.image) {
        symbols.push({
          name: identifier.image,
          kind: 'globalvar',
          line: identifier.startLine ?? node.location?.startLine ?? 1,
          signature: getSourceSignature(source, node.location?.startLine ?? 1),
        });
      }
    }
  });

  return symbols;
}

function toRepoSymbol(node: Node): RepoSymbol | null {
  let name: string | null;

  if (node.type === 'function_definition') {
    // C/C++ function_definition nests the name inside a declarator chain
    name = extractCppFunctionName(node) ?? genericNodeName(node);
  } else if (node.type === 'field_declaration' || node.type === 'event_field_declaration') {
    // C# fields: field_declaration → variable_declaration → variable_declarator → .name
    name = extractCsharpFieldName(node);
  } else {
    name = genericNodeName(node);
  }

  if (!name) return null;

  const bodyNode = node.childForFieldName('body');
  const rawSignature = bodyNode
    ? node.text.slice(0, Math.max(0, bodyNode.startIndex - node.startIndex))
    : (node.text.split(/\r?\n/, 1)[0] ?? node.text);

  return {
    name,
    kind: node.type,
    line: node.startPosition.row + 1,
    signature: compressText(rawSignature),
  };
}

function genericNodeName(node: Node): string | null {
  const nameNode =
    node.childForFieldName('name') ??
    node.namedChildren.find((child) => child.type.includes('identifier')) ??
    node.namedChildren.find((child) => child.type.includes('name'));
  return nameNode?.text?.trim() ?? null;
}

// C# field/event_field: name lives at field_declaration → variable_declaration → variable_declarator → .name
function extractCsharpFieldName(node: Node): string | null {
  const varDecl = node.namedChildren.find((c) => c.type === 'variable_declaration');
  if (!varDecl) return null;
  const varDecltor = varDecl.namedChildren.find((c) => c.type === 'variable_declarator');
  if (!varDecltor) return null;
  const nameNode =
    varDecltor.childForFieldName('name') ??
    varDecltor.namedChildren.find((c) => c.type === 'identifier');
  return nameNode?.text?.trim() ?? null;
}

// Traverses the C/C++ declarator chain to find the leaf function identifier.
// tree-sitter cpp: function_definition → declarator: function_declarator → declarator: identifier
function extractCppFunctionName(node: Node): string | null {
  let decl: Node | null = node.childForFieldName('declarator');
  while (decl) {
    switch (decl.type) {
      case 'function_declarator': {
        const inner = decl.childForFieldName('declarator');
        if (!inner) return null;
        if (
          inner.type === 'identifier' ||
          inner.type === 'destructor_name' ||
          inner.type === 'operator_name'
        ) {
          return inner.text?.trim() ?? null;
        }
        if (inner.type === 'qualified_identifier') {
          const nameField = inner.childForFieldName('name');
          return nameField?.text?.trim() ?? inner.text?.trim() ?? null;
        }
        decl = inner;
        break;
      }
      case 'pointer_declarator':
      case 'reference_declarator':
      case 'rvalue_reference_declarator': {
        decl =
          decl.childForFieldName('declarator') ??
          decl.namedChildren.find((c) => c.type.includes('declarator')) ??
          null;
        break;
      }
      case 'identifier':
        return decl.text?.trim() ?? null;
      default:
        return null;
    }
  }
  return null;
}

function compressText(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .replace(/\s*{\s*$/, '')
    .trim()
    .slice(0, 180);
}

function inferLanguageLabel(extension: string): string {
  return extension.replace(/^\./, '') || 'text';
}

function dedupeSymbols(symbols: RepoSymbol[]): RepoSymbol[] {
  const seen = new Set<string>();
  return symbols.filter((symbol) => {
    const key = `${symbol.name}:${symbol.line}:${symbol.signature}`;

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function visitGmlCst(node: GmlCstNode, visitor: (node: GmlCstNode) => void): void {
  visitor(node);

  for (const entries of Object.values(node.children)) {
    for (const entry of entries) {
      if (isGmlCstNode(entry)) {
        visitGmlCst(entry, visitor);
      }
    }
  }
}

function isGmlCstNode(value: GmlCstNode | { image: string }): value is GmlCstNode {
  return 'name' in value && 'children' in value;
}

function firstGmlNode(entries?: Array<GmlCstNode | { image: string }>): GmlCstNode | null {
  if (!entries) {
    return null;
  }

  for (const entry of entries) {
    if (isGmlCstNode(entry)) {
      return entry;
    }
  }

  return null;
}

function firstToken(
  entries?: Array<GmlCstNode | { image: string; startLine?: number }>,
): { image: string; startLine?: number } | null {
  if (!entries) {
    return null;
  }

  for (const entry of entries) {
    if (!isGmlCstNode(entry)) {
      return entry;
    }
  }

  return null;
}

function findFirstNamedNode(
  entries: Array<GmlCstNode | { image: string }> | undefined,
  nodeName: string,
): GmlCstNode | null {
  if (!entries) {
    return null;
  }

  for (const entry of entries) {
    if (!isGmlCstNode(entry)) {
      continue;
    }

    if (entry.name === nodeName) {
      return entry;
    }

    const nested = findFirstNamedNode(Object.values(entry.children).flat(), nodeName);

    if (nested) {
      return nested;
    }
  }

  return null;
}

function getSourceSignature(source: string, lineNumber: number): string {
  const lines = source.split(/\r?\n/);
  const line = lines[Math.max(0, lineNumber - 1)] ?? '';
  return compressText(line);
}

function readUtf8File(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function countLines(source: string): number {
  return source.length === 0 ? 0 : source.split(/\r?\n/).length;
}

function readBinaryFile(filePath: string): Buffer | null {
  try {
    return fs.readFileSync(filePath);
  } catch {
    return null;
  }
}

// PDF extractor — uses pdf-parse v2 (PDFParse class) to extract text, then derives structure
async function summarizePdfBinary(
  relativePath: string,
  absolutePath: string,
): Promise<RepoMapFile | null> {
  const buf = readBinaryFile(absolutePath);
  if (!buf) return null;

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { PDFParse } = _require('pdf-parse') as { PDFParse: new (opts: { data: Buffer }) => any };
    const parser = new PDFParse({ data: buf });

    let text = '';
    let totalPages = 1;
    let meta: Record<string, unknown> | undefined;

    try {
      const textResult = await parser.getText();
      text = textResult.text ?? '';
      totalPages = textResult.pages?.length ?? 1;
    } catch {
      /* best effort */
    }

    try {
      const infoResult = await parser.getInfo();
      meta = infoResult.info as Record<string, unknown> | undefined;
    } catch {
      /* best effort */
    }

    try {
      await parser.destroy();
    } catch {
      /* ignore */
    }

    if (!text.trim()) return null;

    const symbols: RepoSymbol[] = [];
    const lines = text.split(/\r?\n/);

    // Document metadata
    if (meta?.Title && typeof meta.Title === 'string') {
      symbols.push({ name: meta.Title, kind: 'title', line: 1, signature: `Title: ${meta.Title}` });
    }
    if (meta?.Author && typeof meta.Author === 'string') {
      symbols.push({
        name: meta.Author,
        kind: 'author',
        line: 1,
        signature: `Author: ${meta.Author}`,
      });
    }

    // Extract headings (lines that look like titles: short, no punctuation at end, <= 80 chars)
    let lineNum = 1;
    for (const line of lines) {
      if (symbols.length >= 36) break;
      const trimmed = line.trim();
      if (!trimmed || trimmed.length > 100) {
        lineNum++;
        continue;
      }
      // Heuristic: headings are relatively short, start with uppercase, no period at end
      if (trimmed.length <= 80 && /^[A-ZÀ-ÿ0-9]/.test(trimmed) && !trimmed.endsWith('.')) {
        symbols.push({
          name: trimmed,
          kind: 'heading',
          line: lineNum,
          signature: trimmed.slice(0, 120),
        });
      }
      lineNum++;
    }

    if (symbols.length === 0) {
      // Fallback: first non-empty lines as paragraph content
      for (const line of lines.slice(0, 10)) {
        const t = line.trim();
        if (t && symbols.length < 6) {
          symbols.push({
            name: t.slice(0, 60),
            kind: 'paragraph',
            line: 1,
            signature: t.slice(0, 120),
          });
        }
      }
    }

    if (symbols.length === 0) return null;

    return {
      path: relativePath,
      language: 'pdf',
      parser: 'fallback',
      imports: [],
      lines: totalPages,
      symbols: symbols.slice(0, 24),
    };
  } catch {
    return null;
  }
}

// DOCX extractor — unzips the DOCX (ZIP), extracts word/document.xml, parses <w:t> elements
function summarizeDocxBinary(relativePath: string, absolutePath: string): RepoMapFile | null {
  const buf = readBinaryFile(absolutePath);
  if (!buf) return null;

  try {
    const files = unzipSync(new Uint8Array(buf));
    // Accept both forward and backslash paths (Windows-created ZIPs use backslashes)
    const docXmlBytes = files['word/document.xml'] ?? files['word\\document.xml'];
    if (!docXmlBytes) return null;

    const xml = new TextDecoder('utf-8').decode(docXmlBytes);
    const symbols: RepoSymbol[] = [];
    let lineNum = 1;

    // Extract paragraph text: collect <w:t> content between <w:p> tags
    const paraPattern = /<w:p[\s>]([\s\S]*?)<\/w:p>/g;
    let paraMatch: RegExpExecArray | null;

    while ((paraMatch = paraPattern.exec(xml)) !== null) {
      if (symbols.length >= 36) break;
      const paraContent = paraMatch[1] ?? '';

      // Collect all text runs in this paragraph
      const textPattern = /<w:t[^>]*>([^<]*)<\/w:t>/g;
      let textMatch: RegExpExecArray | null;
      const parts: string[] = [];

      while ((textMatch = textPattern.exec(paraContent)) !== null) {
        const t = textMatch[1];
        if (t) parts.push(t);
      }

      const text = parts.join('').trim();
      if (!text || text.length < 2) {
        lineNum++;
        continue;
      }

      // Check for heading style (w:pStyle with Heading)
      const isHeading = /<w:pStyle[^>]*w:val="Heading/i.test(paraContent);
      const kind = isHeading ? 'heading' : 'paragraph';

      if (isHeading || symbols.length < 12) {
        symbols.push({
          name: text.slice(0, 80),
          kind,
          line: lineNum,
          signature: text.slice(0, 120),
        });
      }
      lineNum++;
    }

    if (symbols.length === 0) return null;

    return {
      path: relativePath,
      language: 'docx',
      parser: 'fallback',
      imports: [],
      lines: lineNum,
      symbols: symbols.slice(0, 24),
    };
  } catch {
    return null;
  }
}
