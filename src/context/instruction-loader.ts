/**
 * Hierarchical Instruction File Loader (Phase 14.2 — Context Interop)
 *
 * Walks from the project CWD upward to root, discovering instruction files
 * at each level. Supported formats (checked in priority order):
 *   UMBRA.md > AGENTS.md > CLAUDE.md > CODEX.md > GEMINI.md > QWEN.md > SYSTEM.md
 *
 * Additionally reads global scope:
 *   ~/.umbra/UMBRA.md  (highest global priority)
 *   ~/.umbra/AGENTS.md
 *
 * Content is merged: outer/global content first, local (CWD) content last so
 * local rules take precedence when the LLM evaluates conflicting instructions.
 *
 * Implements the "loose-coupling" principle: caller can still fall back to the
 * legacy readAgentsRules() if this loader returns nothing.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveRuntimeLayout } from '../memory/runtime-layout.js';

const INSTRUCTION_FILE_NAMES = [
  'UMBRA.md',
  'AGENTS.md',
  'CLAUDE.md',
  'CODEX.md',
  'GEMINI.md',
  'QWEN.md',
  'SYSTEM.md',
] as const;

export type InstructionSource = {
  filePath: string;
  content: string;
  level: 'global' | 'ancestor' | 'local';
};

export type LoadInstructionsResult = {
  sources: InstructionSource[];
  /** Merged content (global → ancestor → local), ready for system prompt */
  merged: string;
};

// ---------------------------------------------------------------------------
// Walk from a directory upward, collecting the first instruction file found
// at each level.
// ---------------------------------------------------------------------------

function findInstructionFileInDir(dir: string): string | null {
  for (const name of INSTRUCTION_FILE_NAMES) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) {
      try {
        const stat = fs.statSync(candidate);
        if (stat.isFile()) return candidate;
      } catch {
        // skip
      }
    }
  }
  return null;
}

function readFileSafe(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf8').trim();
  } catch {
    return '';
  }
}

function getPathRoot(p: string): string {
  return path.parse(p).root || p;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function loadHierarchicalInstructions(opts: {
  projectPath: string;
  umbraHome?: string;
}): LoadInstructionsResult {
  const projectPath = path.resolve(opts.projectPath);
  const home = opts.umbraHome ?? resolveRuntimeLayout().homeDir;
  const sources: InstructionSource[] = [];

  // --- 1. Global scope (prepended first — lowest priority) ---
  const globalCandidates = [path.join(home, 'UMBRA.md'), path.join(home, 'AGENTS.md')];

  for (const globalPath of globalCandidates) {
    if (fs.existsSync(globalPath)) {
      const content = readFileSafe(globalPath);
      if (content) {
        sources.push({ filePath: globalPath, content, level: 'global' });
        break; // one global file is enough (UMBRA.md takes priority over AGENTS.md)
      }
    }
  }

  // --- 2. Ancestor walk: from root down to projectPath, excluding the last dir ---
  const segments: string[] = [];
  let current = projectPath;
  const root = getPathRoot(current);

  // Walk upward from projectPath's parent to root, collecting dirs
  while (true) {
    const parent = path.dirname(current);
    if (parent === current) break; // at root
    current = parent;
    segments.push(current);
    if (current === root) break;
  }

  // Reverse so we go root → project-parent order
  segments.reverse();

  for (const dir of segments) {
    const found = findInstructionFileInDir(dir);
    if (found) {
      const content = readFileSafe(found);
      if (content) sources.push({ filePath: found, content, level: 'ancestor' });
    }
  }

  // --- 3. Local scope: the project directory itself (highest priority) ---
  const localFound = findInstructionFileInDir(projectPath);
  if (localFound) {
    const content = readFileSafe(localFound);
    if (content) sources.push({ filePath: localFound, content, level: 'local' });
  }

  // Merge: global → ancestor → local (local content appears last = highest priority)
  const merged = sources.map((s) => `<!-- ${s.filePath} -->\n${s.content}`).join('\n\n---\n\n');

  return { sources, merged };
}

// ---------------------------------------------------------------------------
// Convenience: get just the merged string (used by agent-runtime)
// ---------------------------------------------------------------------------

export function getMergedInstructions(projectPath: string, umbraHome?: string): string {
  const opts: { projectPath: string; umbraHome?: string } = { projectPath };
  if (umbraHome) opts.umbraHome = umbraHome;
  return loadHierarchicalInstructions(opts).merged;
}
