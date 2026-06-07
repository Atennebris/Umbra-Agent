import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getExternalToolStatus } from '../src/tools/index.js';
import { executeToolCall } from '../src/tools/index.js';

const createdDirs: string[] = [];
const gitStatus = getExternalToolStatus('git');
const gitAvailable =
  gitStatus.available && gitStatus.resolvedPath && gitStatus.sourceMode !== 'fallback';

afterEach(async () => {
  await Promise.all(
    createdDirs.splice(0).map(async (directory) => {
      await fs.rm(directory, { recursive: true, force: true });
    }),
  );
});

describe.skipIf(!gitAvailable)('git tools', () => {
  it('covers status, diff, apply, and commit flows', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'umbra-tools-git-'));
    createdDirs.push(workspace);
    execFileSync(gitStatus.resolvedPath as string, ['init'], { cwd: workspace, stdio: 'ignore' });
    execFileSync(gitStatus.resolvedPath as string, ['config', 'user.name', 'Umbra Test'], {
      cwd: workspace,
      stdio: 'ignore',
    });
    execFileSync(gitStatus.resolvedPath as string, ['config', 'user.email', 'umbra@example.com'], {
      cwd: workspace,
      stdio: 'ignore',
    });

    const filePath = path.join(workspace, 'demo.txt');
    await fs.writeFile(filePath, 'base\n', 'utf8');
    execFileSync(gitStatus.resolvedPath as string, ['add', '.'], {
      cwd: workspace,
      stdio: 'ignore',
    });
    execFileSync(gitStatus.resolvedPath as string, ['commit', '-m', 'init'], {
      cwd: workspace,
      stdio: 'ignore',
    });

    await fs.writeFile(filePath, 'base\nchange\n', 'utf8');

    const statusResult = await executeToolCall({
      preset: 'exec-full',
      cwd: workspace,
      call: { name: 'git.status', arguments: {} },
    });
    expect(statusResult.status).toBe('completed');
    expect((statusResult.output as { entries: Array<{ path: string }> }).entries).toEqual([
      { indexStatus: ' ', worktreeStatus: 'M', path: 'demo.txt' },
    ]);

    const diffResult = await executeToolCall({
      preset: 'exec-full',
      cwd: workspace,
      call: { name: 'git.diff', arguments: {} },
    });
    expect(diffResult.status).toBe('completed');
    expect((diffResult.output as { patch: string }).patch).toContain('+change');

    const applyResult = await executeToolCall({
      preset: 'exec-full',
      cwd: workspace,
      call: {
        name: 'git.apply',
        arguments: {
          patch: [
            'diff --git a/demo.txt b/demo.txt',
            '--- a/demo.txt',
            '+++ b/demo.txt',
            '@@ -1,2 +1,3 @@',
            ' base',
            ' change',
            '+applied',
            '',
          ].join('\n'),
        },
      },
    });
    expect(applyResult.status).toBe('completed');
    expect(await fs.readFile(filePath, 'utf8')).toContain('applied');

    execFileSync(gitStatus.resolvedPath as string, ['add', '.'], {
      cwd: workspace,
      stdio: 'ignore',
    });
    const commitResult = await executeToolCall({
      preset: 'exec-full',
      cwd: workspace,
      call: {
        name: 'git.commit',
        arguments: {
          message: 'phase 5 tools test',
        },
      },
    });
    expect(commitResult.status).toBe('completed');
    expect((commitResult.output as { commitHash: string }).commitHash.length).toBeGreaterThan(0);
  });

  it('git.push and git.pull work against a local bare remote', async () => {
    const bare = await fs.mkdtemp(path.join(os.tmpdir(), 'umbra-tools-git-bare-'));
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'umbra-tools-git-push-'));
    createdDirs.push(bare, workspace);

    const git = gitStatus.resolvedPath as string;

    // Set up bare repo as remote
    execFileSync(git, ['init', '--bare', bare], { stdio: 'ignore' });

    // Set up workspace: init, config, remote, initial commit
    execFileSync(git, ['init'], { cwd: workspace, stdio: 'ignore' });
    execFileSync(git, ['config', 'user.name', 'Umbra Test'], { cwd: workspace, stdio: 'ignore' });
    execFileSync(git, ['config', 'user.email', 'umbra@example.com'], { cwd: workspace, stdio: 'ignore' });
    execFileSync(git, ['remote', 'add', 'origin', bare], { cwd: workspace, stdio: 'ignore' });

    await fs.writeFile(path.join(workspace, 'hello.txt'), 'hello\n', 'utf8');
    execFileSync(git, ['add', '.'], { cwd: workspace, stdio: 'ignore' });
    execFileSync(git, ['commit', '-m', 'init'], { cwd: workspace, stdio: 'ignore' });

    // Get current branch name (may be 'main' or 'master' depending on git config)
    const currentBranch = execFileSync(git, ['branch', '--show-current'], {
      cwd: workspace,
      encoding: 'utf8',
    }).trim();

    // Push
    const pushResult = await executeToolCall({
      preset: 'exec-full',
      cwd: workspace,
      call: { name: 'git.push', arguments: { remote: 'origin', branch: currentBranch } },
    });
    expect(pushResult.status).toBe('completed');
    expect((pushResult.output as { remote: string }).remote).toBe('origin');
    expect((pushResult.output as { branch: string }).branch).toBe(currentBranch);

    // Pull (already up to date — remote has same content we just pushed)
    const pullResult = await executeToolCall({
      preset: 'exec-full',
      cwd: workspace,
      call: { name: 'git.pull', arguments: { remote: 'origin', branch: currentBranch } },
    });
    expect(pullResult.status).toBe('completed');
    const pullOut = pullResult.output as { alreadyUpToDate: boolean; branch: string };
    expect(pullOut.alreadyUpToDate).toBe(true);
    expect(pullOut.branch).toBe(currentBranch);
  }, 15_000);
});
