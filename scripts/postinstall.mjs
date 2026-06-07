import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';

const require = createRequire(import.meta.url);

try {
  require('better-sqlite3');
} catch {
  try {
    execSync('npm rebuild better-sqlite3', { stdio: 'inherit' });
  } catch {
    console.warn(
      '[umbra] Could not build better-sqlite3 from source.\n' +
      '  If the app fails to start, install build tools:\n' +
      '  Windows: https://visualstudio.microsoft.com/visual-cpp-build-tools\n' +
      '  Mac:     xcode-select --install\n' +
      '  Linux:   sudo apt install build-essential python3'
    );
  }
}
