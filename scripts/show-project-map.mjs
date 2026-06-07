import { buildRepoMap, summarizeRepoMap } from '../dist/context/repo-map.js';
import { estimateTextTokens } from '../dist/context/token-estimator.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(__dirname, '..');

const map = await buildRepoMap(projectDir, { maxFiles: 300, maxFileSizeBytes: 256_000 });
const summary = summarizeRepoMap(map);

console.log(`\n=== Umbra CLI — PROJECT REPO MAP ===`);
console.log(`Files indexed:  ${map.fileCount}`);
console.log(`Total symbols:  ${map.symbolCount}`);
console.log(`Languages:      ${summary.languages.join(', ')}`);
console.log(`Repo map size:  ~${summary.tokens.toLocaleString()} tokens`);

// Language distribution
const byLang = {};
for (const f of map.files) {
  byLang[f.language] = (byLang[f.language] ?? 0) + 1;
}
const sorted = Object.entries(byLang).sort((a, b) => b[1] - a[1]);

console.log(`\n=== LANGUAGE DISTRIBUTION ===`);
for (const [lang, count] of sorted) {
  const bar = '█'.repeat(Math.min(count * 2, 40));
  console.log(`  ${lang.padEnd(14)} ${String(count).padStart(3)}  ${bar}`);
}

console.log(`\n=== PARSER DISTRIBUTION ===`);
const byParser = {};
for (const f of map.files) {
  byParser[f.parser] = (byParser[f.parser] ?? 0) + 1;
}
for (const [p, c] of Object.entries(byParser).sort((a,b)=>b[1]-a[1])) {
  console.log(`  ${p.padEnd(14)} ${c} files`);
}
