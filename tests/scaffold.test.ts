import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scaffoldProjectInstructions } from '../src/cli/scaffold.js';

const createdDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    createdDirs.splice(0).map(async (directory) => {
      await fs.rm(directory, { recursive: true, force: true });
    }),
  );
});

describe('scaffoldProjectInstructions', () => {
  it('writes AGENTS.md and check scripts from package scripts', async () => {
    const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), 'umbra-init-'));
    createdDirs.push(targetDir);

    await fs.writeFile(
      path.join(targetDir, 'package.json'),
      JSON.stringify(
        {
          scripts: {
            test: 'pnpm test',
            build: 'pnpm build',
            lint: 'pnpm lint',
          },
        },
        null,
        2,
      ),
      'utf8',
    );

    await scaffoldProjectInstructions(targetDir, { force: false });

    const agents = await fs.readFile(path.join(targetDir, 'AGENTS.md'), 'utf8');
    const checkSh = await fs.readFile(path.join(targetDir, 'check.sh'), 'utf8');
    const checkPs1 = await fs.readFile(path.join(targetDir, 'check.ps1'), 'utf8');

    expect(agents).toContain('## Verification');
    expect(checkSh).toContain('pnpm test');
    expect(checkSh).toContain('pnpm build');
    expect(checkPs1).toContain('"pnpm" test');
  });
});
