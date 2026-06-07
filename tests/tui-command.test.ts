import { describe, expect, it } from 'vitest';
import { buildBannerFlags, resolveStartupWebSearchMode } from '../src/cli/commands/tui-command.js';

describe('resolveStartupWebSearchMode', () => {
  it('prefers the explicit --web flag over the environment', () => {
    expect(resolveStartupWebSearchMode('live', 'off')).toBe('live');
  });

  it('maps "on" to cached mode and falls back to the environment', () => {
    expect(resolveStartupWebSearchMode('on')).toBe('cached');
    expect(resolveStartupWebSearchMode(undefined, 'live')).toBe('live');
  });

  it('rejects unsupported values with a clear error', () => {
    expect(() => resolveStartupWebSearchMode('weird')).toThrow(
      'Unsupported --web value "weird". Use one of: off, on, cached, live.',
    );
  });
});

describe('buildBannerFlags', () => {
  it('shows exec and debug launch state in the header banner', () => {
    expect(buildBannerFlags('exec', undefined, true)).toEqual([
      '[ --exec ] autonomous edit/run/check/fix without confirmations',
      '[ --debug ] debug monitor sidecar active',
    ]);
  });

  it('keeps full mode distinct from exec and appends web status', () => {
    expect(buildBannerFlags('full', 'live')).toEqual([
      '[ --mode full ] full tool access without confirmations',
      '[ --web live ] web search enabled',
    ]);
  });
});
