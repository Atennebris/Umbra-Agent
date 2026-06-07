import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type LoadInstructionsResult,
  loadHierarchicalInstructions,
} from '../src/context/instruction-loader.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'umbra-instr-test-'));
}

function writeFile(dir: string, name: string, content: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), content, 'utf8');
}

let tmpRoot: string;
let tmpHome: string;

beforeEach(() => {
  tmpRoot = makeTmpDir();
  tmpHome = makeTmpDir();
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// loadHierarchicalInstructions
// ---------------------------------------------------------------------------

describe('loadHierarchicalInstructions', () => {
  it('returns empty merged string when no instruction files exist', () => {
    const projectPath = path.join(tmpRoot, 'proj');
    fs.mkdirSync(projectPath, { recursive: true });

    const result = loadHierarchicalInstructions({ projectPath, umbraHome: tmpHome });
    expect(result.merged).toBe('');
    expect(result.sources).toHaveLength(0);
  });

  it('reads a local AGENTS.md in the project directory', () => {
    const projectPath = path.join(tmpRoot, 'proj');
    writeFile(projectPath, 'AGENTS.md', '# Local Rules\n- Always test.');

    const result = loadHierarchicalInstructions({ projectPath, umbraHome: tmpHome });
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]?.level).toBe('local');
    expect(result.merged).toContain('Always test');
  });

  it('reads UMBRA.md in preference to AGENTS.md at the same level', () => {
    const projectPath = path.join(tmpRoot, 'proj');
    writeFile(projectPath, 'UMBRA.md', '# Umbra Rules');
    writeFile(projectPath, 'AGENTS.md', '# Agents Rules');

    const result = loadHierarchicalInstructions({ projectPath, umbraHome: tmpHome });
    expect(result.sources).toHaveLength(1);
    expect(result.merged).toContain('Umbra Rules');
    expect(result.merged).not.toContain('Agents Rules');
  });

  it('reads global UMBRA.md from umbraHome', () => {
    const projectPath = path.join(tmpRoot, 'proj');
    fs.mkdirSync(projectPath, { recursive: true });
    writeFile(tmpHome, 'UMBRA.md', '# Global Rules\n- Be concise.');

    const result = loadHierarchicalInstructions({ projectPath, umbraHome: tmpHome });
    expect(result.sources.some((s) => s.level === 'global')).toBe(true);
    expect(result.merged).toContain('Be concise');
  });

  it('reads global AGENTS.md when UMBRA.md is absent', () => {
    const projectPath = path.join(tmpRoot, 'proj');
    fs.mkdirSync(projectPath, { recursive: true });
    writeFile(tmpHome, 'AGENTS.md', '# Global Agents\n- Do not overwrite.');

    const result = loadHierarchicalInstructions({ projectPath, umbraHome: tmpHome });
    expect(result.sources.some((s) => s.level === 'global')).toBe(true);
    expect(result.merged).toContain('Do not overwrite');
  });

  it('merges global + local with local appearing last (higher priority)', () => {
    const projectPath = path.join(tmpRoot, 'proj');
    writeFile(projectPath, 'AGENTS.md', '# Local');
    writeFile(tmpHome, 'AGENTS.md', '# Global');

    const result = loadHierarchicalInstructions({ projectPath, umbraHome: tmpHome });
    const globalIdx = result.merged.indexOf('# Global');
    const localIdx = result.merged.indexOf('# Local');
    expect(globalIdx).toBeGreaterThanOrEqual(0);
    expect(localIdx).toBeGreaterThanOrEqual(0);
    expect(localIdx).toBeGreaterThan(globalIdx); // local appears after global
  });

  it('supports CLAUDE.md, CODEX.md, GEMINI.md, QWEN.md, SYSTEM.md formats', () => {
    const formats = ['CLAUDE.md', 'CODEX.md', 'GEMINI.md', 'QWEN.md', 'SYSTEM.md'];

    for (const filename of formats) {
      const projectPath = path.join(tmpRoot, `proj-${filename.replace('.', '-')}`);
      writeFile(projectPath, filename, `# ${filename} content`);

      const result = loadHierarchicalInstructions({ projectPath, umbraHome: tmpHome });
      expect(result.merged).toContain(`# ${filename} content`);
    }
  });

  it('includes ancestor directory instruction files', () => {
    // Layout: tmpRoot/parent/child/
    const parentDir = path.join(tmpRoot, 'parent');
    const childDir = path.join(parentDir, 'child');
    fs.mkdirSync(childDir, { recursive: true });

    writeFile(parentDir, 'AGENTS.md', '# Parent Rules');
    writeFile(childDir, 'AGENTS.md', '# Child Rules');

    const result = loadHierarchicalInstructions({ projectPath: childDir, umbraHome: tmpHome });
    expect(result.merged).toContain('Parent Rules');
    expect(result.merged).toContain('Child Rules');

    const parentIdx = result.merged.indexOf('Parent Rules');
    const childIdx = result.merged.indexOf('Child Rules');
    expect(childIdx).toBeGreaterThan(parentIdx); // child/local appears last
  });
});
