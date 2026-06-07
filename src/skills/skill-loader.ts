/**
 * Umbra Skills System (Phase 14.2)
 *
 * Loads SKILL.md files from:
 *   - ~/.umbra/skills/  (global)
 *   - <project>/.umbra/skills/  (project-local, takes precedence on name collision)
 *
 * Each skill lives in its own named sub-directory:
 *   .umbra/skills/<skill-name>/SKILL.md
 *
 * SKILL.md format:
 *   ---
 *   name: <skill-name>
 *   description: <one-line description>
 *   disable-model-invocation: true   # optional, default false
 *   argument-hint: "<hint>"          # optional, shown in autocomplete
 *   ---
 *   <markdown body>
 *
 * Shell injection in the body (executed at invocation time):
 *   inline:  !`command`
 *   block:   ```!\n...\n```
 *
 * Argument substitution in the body:
 *   $1, $2, ... positional args
 *   $@ or $ARGUMENTS — all args joined
 *   ${@:N}, ${@:N:L} — bash-style slice
 *
 */

import { exec as execCallback } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { writeDebugEvent } from '../debug/runtime-debug.js';
import { resolveRuntimeLayout } from '../memory/runtime-layout.js';

const execAsync = promisify(execCallback);

const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
const INLINE_SHELL_PATTERN = /(?:^|\s)!`([^`]+)`/gm;
const BLOCK_SHELL_PATTERN = /```!\s*\n([\s\S]*?)\n?```/g;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SkillFrontmatter = {
  name?: string;
  description?: string;
  'disable-model-invocation'?: boolean;
  'argument-hint'?: string;
  [key: string]: unknown;
};

export type Skill = {
  /** Unique skill name (from frontmatter or parent dir name) */
  name: string;
  /** Short description shown in autocomplete */
  description: string;
  /** Raw markdown body (without frontmatter) */
  content: string;
  /** Absolute path to the SKILL.md file */
  filePath: string;
  /** Whether the model can invoke this skill autonomously */
  disableModelInvocation: boolean;
  /** Hint shown in TUI autocomplete: e.g. "<branch-name>" */
  argumentHint?: string;
  /** Source scope: "global" | "project" */
  source: 'global' | 'project';
};

export type SkillDiagnostic = {
  type: 'warning';
  message: string;
  path: string;
};

export type LoadSkillsResult = {
  skills: Skill[];
  diagnostics: SkillDiagnostic[];
};

// ---------------------------------------------------------------------------
// YAML frontmatter parser (simple key-value, no external dep)
// ---------------------------------------------------------------------------

// Tolerates optional leading whitespace on opening/closing --- (common editor indentation)
const FRONTMATTER_RE = /^[ \t]*---[ \t]*\n([\s\S]*?)\n[ \t]*---[ \t]*(?:\n|$)/;

function parseFrontmatter(raw: string): { frontmatter: SkillFrontmatter; body: string } {
  const normalized = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  const match = normalized.match(FRONTMATTER_RE);
  if (!match) {
    return { frontmatter: {}, body: normalized.trim() };
  }

  const yamlBlock = match[1] ?? '';
  const body = normalized.slice(match[0].length).trim();

  const frontmatter: SkillFrontmatter = {};

  for (const line of yamlBlock.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;

    const rawKey = line.slice(0, colonIdx).trim();
    const rawVal = line.slice(colonIdx + 1).trim();

    if (!rawKey) continue;

    if (rawVal === 'true') {
      frontmatter[rawKey] = true;
    } else if (rawVal === 'false') {
      frontmatter[rawKey] = false;
    } else {
      // Strip surrounding quotes
      frontmatter[rawKey] = rawVal.replace(/^["']|["']$/g, '');
    }
  }

  return { frontmatter, body };
}

/** Fallback: extract first non-empty non-heading line as description */
function extractDescriptionFromBody(body: string): string {
  for (const line of body.split('\n')) {
    const trimmed = line.replace(/^#+\s*/, '').trim();
    if (trimmed) return trimmed.slice(0, 200);
  }
  return '';
}

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

function validateName(name: string): string[] {
  const errors: string[] = [];
  if (name.length > MAX_NAME_LENGTH)
    errors.push(`name exceeds ${MAX_NAME_LENGTH} chars (${name.length})`);
  if (!/^[a-z0-9-]+$/.test(name)) errors.push('name must be lowercase a-z, 0-9, hyphens only');
  if (name.startsWith('-') || name.endsWith('-'))
    errors.push('name must not start or end with hyphen');
  if (name.includes('--')) errors.push('name must not contain consecutive hyphens');
  return errors;
}

function validateDescription(description: string | undefined): string[] {
  if (!description || description.trim() === '') return ['description is required'];
  if (description.length > MAX_DESCRIPTION_LENGTH)
    return [`description exceeds ${MAX_DESCRIPTION_LENGTH} chars`];
  return [];
}

// ---------------------------------------------------------------------------
// Single file loader
// ---------------------------------------------------------------------------

function loadSkillFromFile(
  filePath: string,
  source: 'global' | 'project',
): { skill: Skill | null; diagnostics: SkillDiagnostic[] } {
  const diagnostics: SkillDiagnostic[] = [];

  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const { frontmatter, body } = parseFrontmatter(raw);

    const skillDir = path.dirname(filePath);
    const parentDirName = path.basename(skillDir);

    // Fallback to body text when frontmatter description is absent
    const rawDesc = frontmatter.description as string | undefined;
    const description = rawDesc?.trim() || extractDescriptionFromBody(body);

    const descErrors = validateDescription(description);
    for (const e of descErrors) diagnostics.push({ type: 'warning', message: e, path: filePath });

    if (!description) {
      return { skill: null, diagnostics };
    }

    const name = (frontmatter.name as string | undefined) || parentDirName;
    const nameErrors = validateName(name);
    for (const e of nameErrors) diagnostics.push({ type: 'warning', message: e, path: filePath });

    const skill: Skill = {
      name,
      description,
      content: body,
      filePath,
      disableModelInvocation: frontmatter['disable-model-invocation'] === true,
      source,
    };

    const hint = frontmatter['argument-hint'] as string | undefined;
    if (hint) skill.argumentHint = hint;

    return { skill, diagnostics };
  } catch (err) {
    diagnostics.push({
      type: 'warning',
      message: err instanceof Error ? err.message : 'failed to read skill file',
      path: filePath,
    });
    return { skill: null, diagnostics };
  }
}

// ---------------------------------------------------------------------------
// Directory loader
// ---------------------------------------------------------------------------

function loadSkillsFromDir(
  dir: string,
  source: 'global' | 'project',
  includeRootMd = true,
): LoadSkillsResult {
  const skills: Skill[] = [];
  const diagnostics: SkillDiagnostic[] = [];

  if (!fs.existsSync(dir)) return { skills, diagnostics };

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { skills, diagnostics };
  }

  writeDebugEvent({
    component: 'skills',
    level: 'info',
    message: 'skills dir scan',
    data: { dir, entries: entries.map((e) => `${e.isDirectory() ? 'd' : 'f'}:${e.name}`) },
  });

  for (const entry of entries) {
    if (entry.name.toLowerCase() === 'skill.md') {
      // Root-level SKILL.md (skill dir pattern) — case-insensitive for Windows
      const fullPath = path.join(dir, entry.name);
      const result = loadSkillFromFile(fullPath, source);
      if (result.skill) skills.push(result.skill);
      diagnostics.push(...result.diagnostics);
      // If this dir IS a skill dir, don't recurse further
      return { skills, diagnostics };
    }
  }

  // Recurse into subdirectories
  const sortedEntries = [...entries].sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of sortedEntries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;

    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      const sub = loadSkillsFromDir(fullPath, source, false);
      skills.push(...sub.skills);
      diagnostics.push(...sub.diagnostics);
      continue;
    }

    if (includeRootMd && entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      const result = loadSkillFromFile(fullPath, source);
      if (result.skill) skills.push(result.skill);
      diagnostics.push(...result.diagnostics);
    }
  }

  return { skills, diagnostics };
}

// ---------------------------------------------------------------------------
// Public loader: global + project-local, dedup by name (project wins)
// ---------------------------------------------------------------------------

export function loadSkills(opts: {
  projectPath: string;
  umbraHome?: string;
}): LoadSkillsResult {
  const home = opts.umbraHome ?? resolveRuntimeLayout().homeDir;

  const globalDir = path.join(home, 'skills');
  const projectDir = path.join(opts.projectPath, '.umbra', 'skills');

  const globalResult = loadSkillsFromDir(globalDir, 'global');
  const projectResult = loadSkillsFromDir(projectDir, 'project');

  const skillMap = new Map<string, Skill>();

  // Global first, then project overwrites (project takes precedence)
  for (const skill of globalResult.skills) skillMap.set(skill.name, skill);
  for (const skill of projectResult.skills) skillMap.set(skill.name, skill);

  writeDebugEvent({
    component: 'skills',
    level: 'info',
    message: 'skills loaded',
    data: {
      global: globalResult.skills.length,
      project: projectResult.skills.length,
      total: skillMap.size,
      globalDir,
      projectDir,
      globalDirExists: fs.existsSync(globalDir),
      projectDirExists: fs.existsSync(projectDir),
    },
  });

  const allDiagnostics = [...globalResult.diagnostics, ...projectResult.diagnostics];

  for (const diag of allDiagnostics) {
    writeDebugEvent({
      component: 'skills',
      level: 'warn',
      message: `skill validation: ${diag.message}`,
      data: { path: diag.path },
    });
  }

  return {
    skills: Array.from(skillMap.values()),
    diagnostics: allDiagnostics,
  };
}

// ---------------------------------------------------------------------------
// Shell injection — executed at invocation time (not load time)
// ---------------------------------------------------------------------------

export async function expandShellInjections(content: string, cwd: string): Promise<string> {
  let result = content;

  // Block pattern: ```!\ncommand\n```
  const blockMatches = [...result.matchAll(BLOCK_SHELL_PATTERN)];
  for (const match of blockMatches.reverse()) {
    const command = match[1]?.trim() ?? '';
    let output = '';
    try {
      const { stdout } = await execAsync(command, { cwd, timeout: 10_000 });
      output = stdout.trimEnd();
    } catch (err) {
      output = `[shell error: ${err instanceof Error ? err.message : String(err)}]`;
    }
    result =
      result.slice(0, match.index) + output + result.slice((match.index ?? 0) + match[0].length);
  }

  // Inline pattern: !`command` (preceded by whitespace or BOL)
  const inlineMatches = [...result.matchAll(INLINE_SHELL_PATTERN)];
  for (const match of inlineMatches.reverse()) {
    const command = match[1]?.trim() ?? '';
    let output = '';
    try {
      const { stdout } = await execAsync(command, { cwd, timeout: 10_000 });
      output = stdout.trimEnd();
    } catch (err) {
      output = `[shell error: ${err instanceof Error ? err.message : String(err)}]`;
    }
    // Preserve leading whitespace before !`cmd`
    const leadingWs = match[0].startsWith(' ') || match[0].startsWith('\t') ? match[0][0] : '';
    result =
      result.slice(0, match.index) +
      leadingWs +
      output +
      result.slice((match.index ?? 0) + match[0].length);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Argument substitution
// ---------------------------------------------------------------------------

export function parseCommandArgs(argsString: string): string[] {
  const args: string[] = [];
  let current = '';
  let inQuote: string | null = null;

  for (const char of argsString) {
    if (inQuote) {
      if (char === inQuote) inQuote = null;
      else current += char;
    } else if (char === '"' || char === "'") {
      inQuote = char;
    } else if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = '';
      }
    } else {
      current += char;
    }
  }

  if (current) args.push(current);
  return args;
}

export function substituteArgs(content: string, args: string[]): string {
  let result = content;

  // $1, $2, ... positional
  result = result.replace(/\$(\d+)/g, (_, num) => {
    const index = Number.parseInt(num, 10) - 1;
    return args[index] ?? '';
  });

  // ${@:start} or ${@:start:length}
  result = result.replace(/\$\{@:(\d+)(?::(\d+))?\}/g, (_, startStr, lengthStr) => {
    let start = Number.parseInt(startStr, 10) - 1;
    if (start < 0) start = 0;
    if (lengthStr) return args.slice(start, start + Number.parseInt(lengthStr, 10)).join(' ');
    return args.slice(start).join(' ');
  });

  const allArgs = args.join(' ');
  result = result.replace(/\$ARGUMENTS/g, allArgs);
  result = result.replace(/\$@/g, allArgs);

  return result;
}

// ---------------------------------------------------------------------------
// Format skills for LLM system prompt (XML, per Agent Skills standard)
// ---------------------------------------------------------------------------

export function formatSkillsForPrompt(skills: Skill[]): string {
  const visible = skills.filter((s) => !s.disableModelInvocation);
  if (visible.length === 0) return '';

  const lines = [
    '',
    'The following skills provide specialized instructions for specific tasks.',
    'When a user invokes /<skill-name> [args], expand the skill body with argument substitution.',
    'Skills marked as user-invocable only appear here for reference.',
    '',
    '<available_skills>',
  ];

  for (const skill of visible) {
    lines.push('  <skill>');
    lines.push(`    <name>${escapeXml(skill.name)}</name>`);
    lines.push(`    <description>${escapeXml(skill.description)}</description>`);
    lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
    lines.push('  </skill>');
  }

  lines.push('</available_skills>');
  return lines.join('\n');
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ---------------------------------------------------------------------------
// Skill invocation: expand content with args + shell injection
// ---------------------------------------------------------------------------

export async function invokeSkill(skill: Skill, rawArgs: string, cwd: string): Promise<string> {
  const args = parseCommandArgs(rawArgs);
  let content = substituteArgs(skill.content, args);
  content = await expandShellInjections(content, cwd);

  const userLine = rawArgs.trim()
    ? `The user ran: /${skill.name} ${rawArgs.trim()}\n`
    : `The user ran: /${skill.name}\n`;

  return `${userLine}\nExecute the following skill instructions now:\n\n${content}`;
}

export async function runSkillScript(content: string, cwd: string): Promise<string> {
  try {
    const { stdout, stderr } = await execAsync(content, { cwd, timeout: 60_000 });
    return [stdout, stderr].filter(Boolean).join('\n').trim() || '(no output)';
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    const out = [e.stdout, e.stderr].filter(Boolean).join('\n').trim();
    return out || (err instanceof Error ? err.message : String(err));
  }
}

// ---------------------------------------------------------------------------
// Skill creation: /skill-new <name> [description...]
// ---------------------------------------------------------------------------

export type CreateSkillResult =
  | { ok: true; filePath: string; name: string }
  | { ok: false; error: string };

const SKILL_TEMPLATE = (name: string, description: string) =>
  `---
name: ${name}
description: ${description}
argument-hint: <args>
---

$ARGUMENTS
`.trimEnd();

export function createSkill(rawArgs: string, projectPath: string): CreateSkillResult {
  const args = parseCommandArgs(rawArgs);
  const name = args[0]?.trim() ?? '';
  const description = args.slice(1).join(' ').trim() || `${name} skill`;

  if (!name) {
    return { ok: false, error: 'Usage: /skill-new <name> [description...]' };
  }

  const nameErrors = validateName(name);
  if (nameErrors.length > 0) {
    return { ok: false, error: `Invalid skill name: ${nameErrors.join(', ')}` };
  }

  const skillDir = path.join(projectPath, '.umbra', 'skills', name);
  const skillFile = path.join(skillDir, 'SKILL.md');

  if (fs.existsSync(skillFile)) {
    return {
      ok: false,
      error: `Skill "${name}" already exists at ${skillFile}`,
    };
  }

  try {
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(skillFile, SKILL_TEMPLATE(name, description), 'utf8');
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'failed to create skill file',
    };
  }

  writeDebugEvent({
    component: 'skills',
    level: 'info',
    message: 'skill created',
    data: { name, filePath: skillFile },
  });

  return { ok: true, filePath: skillFile, name };
}
