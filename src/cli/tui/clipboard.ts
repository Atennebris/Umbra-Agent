import { execFileSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export async function readClipboardText(): Promise<string | null> {
  const value = readClipboardTextSync();
  return value && value.length > 0 ? value : null;
}

function readClipboardTextSync(): string {
  try {
    if (process.platform === 'win32') {
      return execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Get-Clipboard -Raw'], {
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    }

    if (process.platform === 'darwin') {
      return execFileSync('pbpaste', [], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    }

    for (const candidate of [
      ['wl-paste', ['--no-newline']],
      ['xclip', ['-selection', 'clipboard', '-o']],
      ['xsel', ['--clipboard', '--output']],
    ] as const) {
      try {
        return execFileSync(candidate[0], candidate[1], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
      } catch {}
    }
  } catch {}

  return '';
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

export function writeClipboardText(text: string): void {
  try {
    if (process.platform === 'win32') {
      // Pass text via stdin to avoid shell-quoting issues with special chars
      execFileSync('powershell.exe', ['-NoProfile', '-Command', '$input | Set-Clipboard'], {
        encoding: 'utf8',
        windowsHide: true,
        input: text,
        stdio: ['pipe', 'ignore', 'ignore'],
      });
      return;
    }

    if (process.platform === 'darwin') {
      execFileSync('pbcopy', [], {
        encoding: 'utf8',
        input: text,
        stdio: ['pipe', 'ignore', 'ignore'],
      });
      return;
    }

    for (const candidate of [
      ['wl-copy', [] as string[]],
      ['xclip', ['-selection', 'clipboard']],
      ['xsel', ['--clipboard', '--input']],
    ] as const) {
      try {
        execFileSync(candidate[0], candidate[1], {
          encoding: 'utf8',
          input: text,
          stdio: ['pipe', 'ignore', 'ignore'],
        });
        return;
      } catch {}
    }
  } catch {}
}
