import type { Skill } from '../../skills/skill-loader.js';

export type SlashCommandHelp = {
  name: string;
  summary: string;
  /** True when this command was registered from a SKILL.md file */
  isSkill?: boolean;
  /** Argument hint shown in autocomplete, e.g. "<branch-name>" */
  argumentHint?: string;
};

export type InputSnapshot = {
  value: string;
  droppedPaths: string[];
  fileReferences: string[];
};

export const BUILTIN_SLASH_COMMANDS: SlashCommandHelp[] = [
  { name: '/permissions', summary: 'Choose agent access mode (Default / Full Access).' },
  { name: '/mem on', summary: 'Show memory citations panel after each response.' },
  { name: '/mem off', summary: 'Hide memory citations panel (default).' },
  { name: '/agent', summary: 'Switch back to agent mode (from plan).' },
  { name: '/plan', summary: 'Switch to plan mode.' },
  { name: '/full', summary: 'Switch to full context mode (no compression, high budget).' },
  { name: '/git', summary: 'Toggle git tools on/off for this session.' },
  { name: '/web', summary: 'Web search settings: toggle mode (off/cached/live) and switch provider.' },
  { name: '/status', summary: 'Ping daemon and show queue health.' },
  { name: '/init', summary: 'Scaffold AGENTS.md and local checks.' },
  { name: '/compact', summary: 'Summarize older session history and shrink context.' },
  { name: '/thread', summary: 'Manage project threads: list, resume, fork, archive, export…' },
  { name: '/sessions', summary: 'List and manage previous sessions.' },
  { name: '/resume', summary: 'Resume a previous session.' },
  { name: '/memories', summary: 'Inspect and change memory settings.' },
  { name: '/reset memories', summary: 'Clear local memories and project summary.' },
  { name: '/providers', summary: 'Manage providers: connect, add, use, models…' },
  { name: '/models', summary: 'List models for the active provider profile.' },
  { name: '/usage', summary: 'Toggle per-request token stats under each reply.' },
  { name: '/help', summary: 'Show the Umbra TUI command cheatsheet.' },
  {
    name: '/clear',
    summary: 'Start a new conversation (new thread + clean transcript, Codex-parity).',
  },
  { name: '/new', summary: 'Start a new conversation context (keep transcript, Codex-parity).' },
  {
    name: '/skill-create',
    summary: 'Open interactive wizard to create a new skill in this project.',
  },
  {
    name: '/goal',
    summary: 'Set session goal shown in status bar and injected into system prompt.',
    argumentHint: '<text | clear>',
  },
  {
    name: '/think',
    summary: 'Set extended thinking budget (Anthropic only). /think off to disable.',
    argumentHint: '<tokens | off>',
  },
  {
    name: '/compact settings',
    summary: 'Choose provider/model used for session compaction.',
  },
  {
    name: '/review',
    summary: 'Review current changes (staged+unstaged) with structured code analysis.',
    argumentHint: '[staged | <file>]',
  },
  {
    name: '/review staged',
    summary: 'Review only staged changes.',
  },
  {
    name: '/review settings',
    summary: 'Choose provider/model used for code review.',
  },
  { name: '/theme', summary: 'Select TUI color theme (34 themes from OpenCode + Umbra default).' },
  { name: '/path', summary: 'Toggle status bar path display on/off (default: off).' },
];

// Runtime registry of skill-based slash commands (populated by registerSkillCommands)
let _skillCommands: SlashCommandHelp[] = [];

/**
 * Register slash commands derived from loaded skills.
 * Called after skills are loaded (e.g. on TUI mount or project switch).
 */
export function registerSkillCommands(skills: Skill[]): void {
  _skillCommands = skills.map((skill) => {
    const cmd: SlashCommandHelp = {
      name: `/${skill.name}`,
      summary: skill.description,
      isSkill: true,
    };
    if (skill.argumentHint) cmd.argumentHint = skill.argumentHint;
    return cmd;
  });
}

/**
 * Clear skill commands (e.g. on project switch before reload).
 */
export function clearSkillCommands(): void {
  _skillCommands = [];
}

/**
 * Combined list: built-ins first, then skill commands.
 * Exported as a getter so it always returns the current live list.
 */
export function getAllSlashCommands(): SlashCommandHelp[] {
  return [...BUILTIN_SLASH_COMMANDS, ..._skillCommands];
}

/** @deprecated Use getAllSlashCommands() — kept for backwards compat */
export const slashCommands: SlashCommandHelp[] = BUILTIN_SLASH_COMMANDS;

export function getSlashSuggestions(value: string): SlashCommandHelp[] {
  const trimmed = value.trimStart();

  if (!trimmed.startsWith('/')) {
    return [];
  }

  const query = trimmed.toLowerCase();
  return getAllSlashCommands()
    .filter((command) => command.name.startsWith(query))
    .slice(0, 6); // allow up to 6 suggestions to fit skills
}

export function applySlashSuggestion(value: string, command: SlashCommandHelp): string {
  const trimmedStart = value.trimStart();
  const leadingWhitespace = value.slice(0, value.length - trimmedStart.length);
  return `${leadingWhitespace}${command.name} `;
}

/**
 * Returns the partial /query if the user is typing a slash word after some text.
 * Returns null when the buffer already starts with / (handled by getSlashSuggestions).
 */
export function getInlineSlashQuery(value: string): string | null {
  if (value.trimStart().startsWith('/')) return null;
  const lastSlash = value.lastIndexOf('/');
  if (lastSlash <= 0) return null;
  if (value[lastSlash - 1] !== ' ') return null;
  return value.slice(lastSlash);
}

/** Returns skill-only suggestions for an inline /query (text before the slash is user context). */
export function getInlineSlashSuggestions(value: string): SlashCommandHelp[] {
  const query = getInlineSlashQuery(value);
  if (!query) return [];
  const queryLower = query.toLowerCase();
  return _skillCommands.filter((cmd) => cmd.name.startsWith(queryLower)).slice(0, 6);
}

/** Replaces the trailing inline /partial with the completed command. */
export function applyInlineSlashSuggestion(value: string, command: SlashCommandHelp): string {
  const lastSlash = value.lastIndexOf('/');
  if (lastSlash === -1) return value;
  return `${value.slice(0, lastSlash)}${command.name} `;
}

export function getInputBadges(snapshot: InputSnapshot): string[] {
  const badges: string[] = [];

  if (snapshot.droppedPaths.length > 0) {
    badges.push(`${snapshot.droppedPaths.length} attach`);
  }

  if (snapshot.fileReferences.length > 0) {
    badges.push(`${snapshot.fileReferences.length} refs`);
  }

  if (snapshot.value.trimStart().startsWith('/')) {
    badges.push('slash');
  }

  return badges;
}

export function isThreadResumeDialogCommand(value: string): boolean {
  const command = value.trim();
  return command === '/resume' || command === '/thread resume' || command === '/sessions resume';
}

export function isThreadForkDialogCommand(value: string): boolean {
  const command = value.trim();
  return command === '/fork' || command === '/thread fork' || command === '/sessions fork';
}

/**
 * Check if an input value is a skill invocation command.
 * Returns { skillName, rawArgs } if it matches a registered skill, null otherwise.
 */
export function parseSkillCommand(value: string): { skillName: string; rawArgs: string } | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith('/')) return null;

  for (const cmd of _skillCommands) {
    const skillSlash = cmd.name; // e.g. "/deploy"
    if (trimmed === skillSlash || trimmed.startsWith(`${skillSlash} `)) {
      const rawArgs = trimmed.slice(skillSlash.length).trimStart();
      return { skillName: skillSlash.slice(1), rawArgs };
    }
  }

  return null;
}
