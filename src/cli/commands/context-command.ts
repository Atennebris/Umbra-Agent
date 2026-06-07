import path from 'node:path';
import { buildRepoMap, summarizeRepoMap } from '../../context/repo-map.js';
import type { CliCommandHandler } from '../command-types.js';

export type ContextCommandInput = {
  directory?: string;
};

export const runContextCommand: CliCommandHandler = async (input: unknown) => {
  const { directory } = input as ContextCommandInput;
  const targetDir = directory || process.cwd();
  
  console.log(`\n🔍 Building Repo Map for: ${path.resolve(targetDir)}\n`);

  try {
    const repoMap = await buildRepoMap(targetDir);
    const summary = summarizeRepoMap(repoMap);

    console.log(summary.markdown);
    
    console.log('\n=======================================');
    console.log(`📊 Statistics:`);
    console.log(`- Files in context: ${summary.repoFiles}`);
    console.log(`- Symbols extracted: ${summary.repoSymbols}`);
    console.log(`- Languages: ${summary.languages.join(', ')}`);
    console.log(`- Estimated tokens: ${summary.tokens}`);
    console.log('=======================================\n');
  } catch (err) {
    console.error('Error generating Repo Map:', err instanceof Error ? err.message : String(err));
  }
};
