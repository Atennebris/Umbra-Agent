import { buildRepoMap, summarizeRepoMap } from '../src/context/repo-map.js';
import path from 'node:path';

async function main() {
  const targetDir = process.argv[2] || process.cwd();
  console.log(`\n🔍 Строим Repo Map для: ${path.resolve(targetDir)}\n`);

  try {
    const repoMap = await buildRepoMap(targetDir);
    const summary = summarizeRepoMap(repoMap);

    console.log(summary.markdown);
    
    console.log('\n=======================================');
    console.log(`📊 Статистика:`);
    console.log(`- Файлов в контексте: ${summary.repoFiles}`);
    console.log(`- Извлечено символов: ${summary.repoSymbols}`);
    console.log(`- Языки: ${summary.languages.join(', ')}`);
    console.log(`- Примерно токенов: ${summary.tokens}`);
    console.log('=======================================\n');
  } catch (err) {
    console.error('Ошибка при генерации Repo Map:', err);
  }
}

main();
