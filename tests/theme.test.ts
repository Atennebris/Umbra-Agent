import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('TUI Themes', () => {
  it('exports exactly 42 theme names', async () => {
    const { THEME_NAMES } = await import('../src/cli/tui/theme.js');
    expect(THEME_NAMES).toHaveLength(42);
    // OpenCode originals
    expect(THEME_NAMES).toContain('umbra');
    expect(THEME_NAMES).toContain('dracula');
    expect(THEME_NAMES).toContain('tokyonight');
    expect(THEME_NAMES).toContain('catppuccin');
    expect(THEME_NAMES).toContain('nord');
    // GMSync originals
    expect(THEME_NAMES).toContain('vscode-default');
    expect(THEME_NAMES).toContain('classic');
    expect(THEME_NAMES).toContain('dark-pro');
    expect(THEME_NAMES).toContain('pastel');
    expect(THEME_NAMES).toContain('hacker');
    expect(THEME_NAMES).toContain('retro');
    expect(THEME_NAMES).toContain('snow');
    expect(THEME_NAMES).toContain('midnight');
  });

  it('applyTheme mutates umbraTheme in place for dracula', async () => {
    const { umbraTheme, applyTheme } = await import('../src/cli/tui/theme.js');
    applyTheme('dracula');
    expect(umbraTheme.frame).toBe('#bd93f9');
    expect(umbraTheme.danger).toBe('#ff5555');
    expect(umbraTheme.success).toBe('#50fa7b');
  });

  it('applyTheme falls back to umbra for unknown theme', async () => {
    const { umbraTheme, applyTheme, THEMES } = await import('../src/cli/tui/theme.js');
    applyTheme('nonexistent-theme-xyz');
    expect(umbraTheme.frame).toBe((THEMES as Record<string, typeof umbraTheme>).umbra.frame);
  });

  it('all themes have required fields', async () => {
    const { THEMES, THEME_NAMES } = await import('../src/cli/tui/theme.js');
    const required = [
      'frame',
      'frameDim',
      'accent',
      'accentSoft',
      'skillHighlight',
      'text',
      'muted',
      'success',
      'warning',
      'danger',
      'code',
      'thinking',
      'userBackground',
      'assistantBackground',
      'systemBackground',
    ] as const;
    for (const name of THEME_NAMES) {
      const t = (THEMES as Record<string, Record<string, string>>)[name];
      for (const field of required) {
        expect(t[field], `${name}.${field}`).toBeTruthy();
      }
    }
  });
});

describe('Theme persistence (runtime-preferences)', () => {
  let tmpDir: string;
  let origHome: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'umbra-theme-test-'));
    origHome = process.env.UMBRA_HOME;
    process.env.UMBRA_HOME = tmpDir;
  });

  afterEach(() => {
    if (origHome === undefined) {
      process.env.UMBRA_HOME = undefined;
    } else {
      process.env.UMBRA_HOME = origHome;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('setThemePreference / getThemePreference round-trip', async () => {
    const { setThemePreference, getThemePreference } = await import(
      '../src/core/runtime-preferences.js'
    );
    expect(getThemePreference()).toBe('umbra');
    setThemePreference('dracula');
    expect(getThemePreference()).toBe('dracula');
    setThemePreference('nord');
    expect(getThemePreference()).toBe('nord');
  });
});
