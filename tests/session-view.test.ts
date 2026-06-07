import { afterEach, describe, expect, it } from 'vitest';
import {
  applySlashSuggestion,
  clearSkillCommands,
  getInputBadges,
  getSlashSuggestions,
  isThreadForkDialogCommand,
  isThreadResumeDialogCommand,
  parseSkillCommand,
  registerSkillCommands,
} from '../src/cli/tui/session-view.js';

afterEach(() => {
  clearSkillCommands();
});

describe('session-view helpers', () => {
  it('returns slash suggestions for matching command prefixes', () => {
    const names = getSlashSuggestions('/c').map((item) => item.name);
    expect(names).toContain('/compact');
    expect(names).toContain('/clear');
  });

  it('creates compact input badges for the prompt footer', () => {
    expect(
      getInputBadges({
        value: '/status @src/main.ts',
        droppedPaths: [],
        fileReferences: ['src/main.ts'],
      }),
    ).toEqual(['1 refs', 'slash']);
  });

  it('applies a slash suggestion like a command completion', () => {
    const suggestion = getSlashSuggestions('/st')[0];

    expect(suggestion?.name).toBe('/status');
    expect(suggestion).toBeDefined();

    if (!suggestion) {
      throw new Error('Expected a slash suggestion for /st');
    }

    expect(applySlashSuggestion('/st', suggestion)).toBe('/status ');
  });

  it('exposes common session resume aliases', () => {
    expect(getSlashSuggestions('/res').map((item) => item.name)).toContain('/resume');
    expect(getSlashSuggestions('/ses').map((item) => item.name)).toContain('/sessions');
    expect(isThreadResumeDialogCommand('/resume')).toBe(true);
    expect(isThreadResumeDialogCommand('/sessions resume')).toBe(true);
    expect(isThreadForkDialogCommand('/sessions fork')).toBe(true);
  });
});

describe('skill slash commands', () => {
  it('registerSkillCommands makes skills appear in autocomplete', () => {
    registerSkillCommands([
      {
        name: 'deploy',
        description: 'Deploy the app.',
        content: '',
        filePath: '/skills/deploy/SKILL.md',
        disableModelInvocation: false,
        source: 'project',
      },
    ]);

    const suggestions = getSlashSuggestions('/dep');
    expect(suggestions.map((s) => s.name)).toContain('/deploy');
    expect(suggestions.find((s) => s.name === '/deploy')?.isSkill).toBe(true);
  });

  it('clearSkillCommands removes skill suggestions', () => {
    registerSkillCommands([
      {
        name: 'test-cmd',
        description: 'Test command.',
        content: '',
        filePath: '/skills/test-cmd/SKILL.md',
        disableModelInvocation: false,
        source: 'project',
      },
    ]);

    clearSkillCommands();
    const suggestions = getSlashSuggestions('/test-cmd');
    expect(suggestions.map((s) => s.name)).not.toContain('/test-cmd');
  });

  it('parseSkillCommand identifies a skill invocation with no args', () => {
    registerSkillCommands([
      {
        name: 'review',
        description: 'Code review.',
        content: '',
        filePath: '/skills/review/SKILL.md',
        disableModelInvocation: false,
        source: 'project',
      },
    ]);

    const result = parseSkillCommand('/review');
    expect(result).toEqual({ skillName: 'review', rawArgs: '' });
  });

  it('parseSkillCommand extracts arguments after the skill name', () => {
    registerSkillCommands([
      {
        name: 'test-cmd',
        description: 'Run tests.',
        content: '',
        filePath: '/skills/test-cmd/SKILL.md',
        disableModelInvocation: false,
        source: 'project',
      },
    ]);

    const result = parseSkillCommand('/test-cmd src/foo.ts verbose');
    expect(result).toEqual({ skillName: 'test-cmd', rawArgs: 'src/foo.ts verbose' });
  });

  it('parseSkillCommand returns null for non-skill commands', () => {
    expect(parseSkillCommand('/clear')).toBeNull();
    expect(parseSkillCommand('/status')).toBeNull();
    expect(parseSkillCommand('')).toBeNull();
  });

  it('applySlashSuggestion fills command name with trailing space (argument-hint is visual-only)', () => {
    registerSkillCommands([
      {
        name: 'checkout',
        description: 'Checkout branch.',
        content: '',
        filePath: '/skills/checkout/SKILL.md',
        disableModelInvocation: false,
        source: 'project',
        argumentHint: '<branch-name>',
      },
    ]);

    const suggestion = getSlashSuggestions('/che')[0];
    expect(suggestion).toBeDefined();
    if (!suggestion) return;
    // argument-hint is now shown as ghost text in the UI, not inserted into the buffer
    expect(applySlashSuggestion('/che', suggestion)).toBe('/checkout ');
  });
});
