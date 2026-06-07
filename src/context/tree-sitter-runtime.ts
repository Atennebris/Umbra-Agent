import { createRequire } from 'node:module';
import path from 'node:path';
import { Language, type Node, Parser } from 'web-tree-sitter';

export type SupportedTreeSitterLanguage =
  | 'javascript'
  | 'typescript'
  | 'tsx'
  | 'python'
  | 'go'
  | 'bash'
  | 'rust'
  | 'java'
  | 'css'
  | 'ruby'
  | 'csharp'
  | 'php'
  | 'powershell'
  | 'ini'
  | 'cpp';

type LanguageSpec = {
  id: SupportedTreeSitterLanguage;
  wasmFile: string;
};

const require = createRequire(import.meta.url);
const webTreeSitterDir = path.dirname(require.resolve('web-tree-sitter'));
const languageSpecs = new Map<string, LanguageSpec>([
  ['.js', { id: 'javascript', wasmFile: 'tree-sitter-javascript.wasm' }],
  ['.jsx', { id: 'javascript', wasmFile: 'tree-sitter-javascript.wasm' }],
  ['.cjs', { id: 'javascript', wasmFile: 'tree-sitter-javascript.wasm' }],
  ['.mjs', { id: 'javascript', wasmFile: 'tree-sitter-javascript.wasm' }],
  ['.ts', { id: 'typescript', wasmFile: 'tree-sitter-typescript.wasm' }],
  ['.tsx', { id: 'tsx', wasmFile: 'tree-sitter-tsx.wasm' }],
  ['.py', { id: 'python', wasmFile: 'tree-sitter-python.wasm' }],
  ['.go', { id: 'go', wasmFile: 'tree-sitter-go.wasm' }],
  ['.sh', { id: 'bash', wasmFile: 'tree-sitter-bash.wasm' }],
  ['.bash', { id: 'bash', wasmFile: 'tree-sitter-bash.wasm' }],
  ['.zsh', { id: 'bash', wasmFile: 'tree-sitter-bash.wasm' }],
  ['.rs', { id: 'rust', wasmFile: 'tree-sitter-rust.wasm' }],
  ['.java', { id: 'java', wasmFile: 'tree-sitter-java.wasm' }],
  ['.css', { id: 'css', wasmFile: 'tree-sitter-css.wasm' }],
  ['.rb', { id: 'ruby', wasmFile: 'tree-sitter-ruby.wasm' }],
  ['.cs', { id: 'csharp', wasmFile: 'tree-sitter-c-sharp.wasm' }],
  ['.php', { id: 'php', wasmFile: 'tree-sitter-php.wasm' }],
  ['.ps1', { id: 'powershell', wasmFile: 'tree-sitter-powershell.wasm' }],
  ['.psm1', { id: 'powershell', wasmFile: 'tree-sitter-powershell.wasm' }],
  ['.ini', { id: 'ini', wasmFile: 'tree-sitter-ini.wasm' }],
  ['.cfg', { id: 'ini', wasmFile: 'tree-sitter-ini.wasm' }],
  // C and C++ share the cpp wasm grammar for symbol extraction
  ['.c', { id: 'cpp', wasmFile: 'tree-sitter-cpp.wasm' }],
  ['.h', { id: 'cpp', wasmFile: 'tree-sitter-cpp.wasm' }],
  ['.cpp', { id: 'cpp', wasmFile: 'tree-sitter-cpp.wasm' }],
  ['.cc', { id: 'cpp', wasmFile: 'tree-sitter-cpp.wasm' }],
  ['.cxx', { id: 'cpp', wasmFile: 'tree-sitter-cpp.wasm' }],
  ['.hpp', { id: 'cpp', wasmFile: 'tree-sitter-cpp.wasm' }],
  ['.hh', { id: 'cpp', wasmFile: 'tree-sitter-cpp.wasm' }],
  ['.hxx', { id: 'cpp', wasmFile: 'tree-sitter-cpp.wasm' }],
]);

let parserReadyPromise: Promise<void> | null = null;
const languageCache = new Map<SupportedTreeSitterLanguage, Promise<Language>>();

export function getTreeSitterLanguageForExtension(extension: string): LanguageSpec | null {
  return languageSpecs.get(extension.toLowerCase()) ?? null;
}

export async function withTreeSitterParse<TResult>(
  extension: string,
  source: string,
  visit: (input: { language: SupportedTreeSitterLanguage; rootNode: Node }) => TResult,
): Promise<TResult | null> {
  const spec = getTreeSitterLanguageForExtension(extension);

  if (!spec) {
    return null;
  }

  await ensureParserReady();
  const language = await loadLanguage(spec);
  const parser = new Parser();

  try {
    parser.setLanguage(language);
    const tree = parser.parse(source);

    if (!tree) {
      return null;
    }

    try {
      return visit({
        language: spec.id,
        rootNode: tree.rootNode,
      });
    } finally {
      tree.delete();
    }
  } finally {
    parser.delete();
  }
}

async function ensureParserReady(): Promise<void> {
  parserReadyPromise ??= Parser.init({
    locateFile(scriptName: string) {
      return path.join(webTreeSitterDir, scriptName);
    },
  });

  await parserReadyPromise;
}

async function loadLanguage(spec: LanguageSpec): Promise<Language> {
  const existing = languageCache.get(spec.id);

  if (existing) {
    return existing;
  }

  const next = Language.load(require.resolve(`@vscode/tree-sitter-wasm/wasm/${spec.wasmFile}`));
  languageCache.set(spec.id, next);
  return next;
}
