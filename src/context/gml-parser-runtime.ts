import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

type GmlToken = {
  image: string;
  startColumn?: number;
  startLine?: number;
};

type GmlCstLocation = {
  endColumn: number;
  endLine: number;
  endOffset: number;
  startColumn: number;
  startLine: number;
  startOffset: number;
};

export type GmlCstNode = {
  children: Record<string, Array<GmlCstNode | GmlToken>>;
  location?: GmlCstLocation;
  name: string;
};

type GmlParseResult = {
  cst: GmlCstNode;
  errors: unknown[];
};

type GmlParserModule = {
  parser: {
    parse(source: string): GmlParseResult;
  };
};

let gmlParserModulePromise: Promise<GmlParserModule | null> | null = null;

export async function parseGmlSource(source: string): Promise<GmlParseResult | null> {
  const parserModule = await loadGmlParserModule();

  if (!parserModule) {
    return null;
  }

  return parserModule.parser.parse(source);
}

async function loadGmlParserModule(): Promise<GmlParserModule | null> {
  gmlParserModulePromise ??= (async () => {
    try {
      const currentDir = path.dirname(fileURLToPath(import.meta.url));
      const parserPath = path.resolve(
        currentDir,
        '..',
        '..',
        'node_modules',
        '@bscotch',
        'gml-parser',
        'dist',
        'parser.js',
      );

      return (await import(pathToFileURL(parserPath).href)) as GmlParserModule;
    } catch {
      return null;
    }
  })();

  return gmlParserModulePromise;
}
