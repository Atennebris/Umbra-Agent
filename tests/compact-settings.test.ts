/**
 * Round-trip tests for /compact settings persistence.
 * Validates that setCompactSettings / getCompactSettings correctly persist
 * provider/model selections across reads, and that null (Default) path works.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// We override UMBRA_HOME to a temp directory so tests don't touch the real prefs
let tempHome: string;
let origUmbraHome: string | undefined;

beforeEach(() => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'umbra-compact-test-'));
  origUmbraHome = process.env.UMBRA_HOME;
  process.env.UMBRA_HOME = tempHome;
});

afterEach(() => {
  if (origUmbraHome !== undefined) {
    process.env.UMBRA_HOME = origUmbraHome;
  } else {
    delete process.env.UMBRA_HOME;
  }
  fs.rmSync(tempHome, { recursive: true, force: true });
});

async function freshPrefs() {
  // Re-import to bypass module-level caching
  const mod = await import('../src/core/runtime-preferences.js');
  return mod;
}

describe('/compact settings round-trip', () => {
  it('Default path: getCompactSettings returns null/null when nothing saved', async () => {
    const { getCompactSettings } = await freshPrefs();
    const settings = getCompactSettings();
    expect(settings.provider).toBeNull();
    expect(settings.model).toBeNull();
  });

  it('saves custom provider and model, reads them back', async () => {
    const { setCompactSettings, getCompactSettings } = await freshPrefs();
    setCompactSettings('my-provider-id', 'my-model-v2');
    const settings = getCompactSettings();
    expect(settings.provider).toBe('my-provider-id');
    expect(settings.model).toBe('my-model-v2');
  });

  it('persists across re-read (simulates restart)', async () => {
    const { setCompactSettings } = await freshPrefs();
    setCompactSettings('saved-provider', 'saved-model');

    // Re-import module to simulate fresh read (Vitest uses the same process,
    // but readRuntimePreferences reads from disk each time)
    const { getCompactSettings } = await freshPrefs();
    const settings = getCompactSettings();
    expect(settings.provider).toBe('saved-provider');
    expect(settings.model).toBe('saved-model');
  });

  it('resets to Default when setCompactSettings called with null/null', async () => {
    const { setCompactSettings, getCompactSettings } = await freshPrefs();
    setCompactSettings('old-provider', 'old-model');
    setCompactSettings(null, null);
    const settings = getCompactSettings();
    expect(settings.provider).toBeNull();
    expect(settings.model).toBeNull();
  });

  it('preserves other runtime prefs when compact settings are changed', async () => {
    const { setCompactSettings, setDefaultRuntimeMode, readRuntimePreferences } = await freshPrefs();
    setDefaultRuntimeMode('full');
    setCompactSettings('p1', 'm1');
    const prefs = readRuntimePreferences();
    // compact settings updated
    expect(prefs.compactProvider).toBe('p1');
    expect(prefs.compactModel).toBe('m1');
    // other prefs untouched
    expect(prefs.defaultMode).toBe('full');
  });
});
