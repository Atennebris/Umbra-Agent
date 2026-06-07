import { buildRepoMap, renderRepoMapMarkdown, summarizeRepoMap } from '../dist/context/repo-map.js';
import { estimateTextTokens } from '../dist/context/token-estimator.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.resolve(__dirname, '../tests/fixtures/lang-coverage');

const map = await buildRepoMap(fixtureDir);

console.log(`\n=== REPO MAP — lang-coverage fixtures ===`);
console.log(`Files:   ${map.fileCount}`);
console.log(`Symbols: ${map.symbolCount}`);
console.log(`\n${'LANGUAGE'.padEnd(14)} ${'PARSER'.padEnd(12)} SYM  IMP  FILE`);
console.log('─'.repeat(72));

for (const f of map.files) {
  const lang = f.language.padEnd(14);
  const parser = f.parser.padEnd(12);
  const syms = String(f.symbols.length).padStart(3);
  const imps = String(f.imports.length).padStart(3);
  console.log(`${lang} ${parser} ${syms}  ${imps}  ${f.path}`);
  if (f.symbols.length > 0) {
    const preview = f.symbols.slice(0, 4).map(s => `${s.kind}:${s.name}`).join(', ');
    const more = f.symbols.length > 4 ? ` +${f.symbols.length - 4}` : '';
    console.log(`${''.padEnd(14)}  → ${preview}${more}`);
  }
}

// Token savings comparison
const summary = summarizeRepoMap(map);
const repoMapTokens = summary.tokens;

// Count raw file bytes/tokens
let rawBytes = 0;
let rawTokens = 0;
const entries = fs.readdirSync(fixtureDir, { withFileTypes: true });
for (const e of entries) {
  if (e.isFile()) {
    try {
      const content = fs.readFileSync(path.join(fixtureDir, e.name), 'utf8');
      rawBytes += Buffer.byteLength(content, 'utf8');
      rawTokens += estimateTextTokens(content);
    } catch {}
  }
}

const saving = rawTokens - repoMapTokens;
const pct = Math.round((saving / rawTokens) * 100);

console.log(`\n${'─'.repeat(72)}`);
console.log(`\n=== TOKEN SAVINGS ===`);
console.log(`Raw files total:  ~${rawTokens.toLocaleString()} tokens  (${(rawBytes / 1024).toFixed(1)} KB)`);
console.log(`Repo map output:  ~${repoMapTokens.toLocaleString()} tokens`);
console.log(`Saved:            ~${saving.toLocaleString()} tokens  (${pct}% reduction)`);
console.log(`\nLanguages covered: ${summary.languages.join(', ')}`);
