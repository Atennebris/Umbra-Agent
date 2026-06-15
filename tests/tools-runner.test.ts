import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeToolCall, listToolDefinitions } from '../src/tools/index.js';

const createdDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    createdDirs.splice(0).map(async (directory) => {
      await fs.rm(directory, { recursive: true, force: true });
    }),
  );
});

describe('tools runner', () => {
  it('exposes the phase 5 tool catalog', () => {
    const names = listToolDefinitions().map((tool) => tool.name);

    expect(names).toEqual([
      'fs.list',
      'fs.read',
      'fs.cd',
      'fs.write',
      'fs.edit',
      'shell.exec',
      'search.rg',
      'search.files',
      'search.fuzzy',
      'web.search',
      'web.fetch',
      'git.status',
      'git.diff',
      'git.apply',
      'git.commit',
      'git.push',
      'git.pull',
    ]);
  });

  it('enforces preset-based permission gates for writes', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'umbra-tools-runner-'));
    createdDirs.push(workspace);

    const blocked = await executeToolCall({
      preset: 'agent-default',
      cwd: workspace,
      call: {
        name: 'fs.write',
        arguments: {
          path: 'note.txt',
          content: 'blocked',
        },
      },
    });

    expect(blocked.status).toBe('blocked');
    expect(blocked.permission.outcome).toBe('deny');

    const allowed = await executeToolCall({
      preset: 'exec-full',
      cwd: workspace,
      call: {
        name: 'fs.write',
        arguments: {
          path: 'note.txt',
          content: 'allowed',
        },
      },
    });

    expect(allowed.status).toBe('completed');
    expect(await fs.readFile(path.join(workspace, 'note.txt'), 'utf8')).toBe('allowed');
  });

  it('reads a file slice using line-based offset/limit', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'umbra-tools-read-'));
    createdDirs.push(workspace);
    const lines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`);
    await fs.writeFile(path.join(workspace, 'multiline.txt'), `${lines.join('\n')}\n`, 'utf8');

    const result = await executeToolCall({
      preset: 'chat-readonly',
      cwd: workspace,
      call: {
        name: 'fs.read',
        arguments: { path: 'multiline.txt', offset: 2, limit: 3 },
      },
    });

    expect(result.status).toBe('completed');
    expect(result.output).toMatchObject({
      content: 'line3\nline4\nline5',
      truncated: true,
      totalLines: 11,
    });
  });

  it('replaces an exact string through fs.edit', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'umbra-tools-edit-'));
    createdDirs.push(workspace);
    const filePath = path.join(workspace, 'alpha.txt');
    await fs.writeFile(filePath, 'one\ntwo\n', 'utf8');

    const result = await executeToolCall({
      preset: 'exec-full',
      cwd: workspace,
      call: {
        name: 'fs.edit',
        arguments: {
          path: 'alpha.txt',
          oldString: 'two',
          newString: 'three',
        },
      },
    });

    expect(result.status).toBe('completed');
    expect(await fs.readFile(filePath, 'utf8')).toBe('one\nthree\n');
    expect(result.output).toMatchObject({ replacements: 1 });
  });

  it('replaces every occurrence when replaceAll is set', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'umbra-tools-edit-all-'));
    createdDirs.push(workspace);
    const filePath = path.join(workspace, 'beta.txt');
    await fs.writeFile(filePath, 'foo bar foo baz foo\n', 'utf8');

    const result = await executeToolCall({
      preset: 'exec-full',
      cwd: workspace,
      call: {
        name: 'fs.edit',
        arguments: {
          path: 'beta.txt',
          oldString: 'foo',
          newString: 'qux',
          replaceAll: true,
        },
      },
    });

    expect(result.status).toBe('completed');
    expect(await fs.readFile(filePath, 'utf8')).toBe('qux bar qux baz qux\n');
    expect(result.output).toMatchObject({ replacements: 3 });
  });

  it('fails when oldString matches more than once without replaceAll', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'umbra-tools-edit-ambiguous-'));
    createdDirs.push(workspace);
    const filePath = path.join(workspace, 'gamma.txt');
    await fs.writeFile(filePath, 'foo bar foo\n', 'utf8');

    const result = await executeToolCall({
      preset: 'exec-full',
      cwd: workspace,
      call: {
        name: 'fs.edit',
        arguments: {
          path: 'gamma.txt',
          oldString: 'foo',
          newString: 'qux',
        },
      },
    });

    expect(result.status).toBe('failed');
    expect(result.error).toContain('matches 2 locations');
    expect(await fs.readFile(filePath, 'utf8')).toBe('foo bar foo\n');
  });

  it('fails when oldString is not found in the file', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'umbra-tools-edit-missing-'));
    createdDirs.push(workspace);
    const filePath = path.join(workspace, 'delta.txt');
    await fs.writeFile(filePath, 'one\ntwo\n', 'utf8');

    const result = await executeToolCall({
      preset: 'exec-full',
      cwd: workspace,
      call: {
        name: 'fs.edit',
        arguments: {
          path: 'delta.txt',
          oldString: 'not-there',
          newString: 'still-not-there',
        },
      },
    });

    expect(result.status).toBe('failed');
    expect(result.error).toContain('not found');
    expect(await fs.readFile(filePath, 'utf8')).toBe('one\ntwo\n');
  });

  it('runs readonly shell commands in chat-readonly preset', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'umbra-tools-shell-'));
    createdDirs.push(workspace);

    const result = await executeToolCall({
      preset: 'chat-readonly',
      cwd: workspace,
      call: {
        name: 'shell.exec',
        arguments: {
          command: process.platform === 'win32' ? 'Get-Location' : 'pwd',
        },
      },
    });

    expect(result.status).toBe('completed');
    expect(result.permission.outcome).toBe('allow');
    expect(result.output).toMatchObject({
      exitCode: 0,
      timedOut: false,
    });
  });

  it('searches text with ripgrep wrapper or fallback engine', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'umbra-tools-search-'));
    createdDirs.push(workspace);
    await fs.writeFile(path.join(workspace, 'search.txt'), 'alpha\nbravo alpha\n', 'utf8');

    const result = await executeToolCall({
      preset: 'chat-readonly',
      cwd: workspace,
      call: {
        name: 'search.rg',
        arguments: {
          pattern: 'alpha',
          path: '.',
        },
      },
    });

    expect(result.status).toBe('completed');
    expect((result.output as { matches: Array<{ text: string }> }).matches.length).toBeGreaterThan(
      0,
    );
  });

  it('returns an empty result instead of failing when ripgrep finds nothing', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'umbra-tools-search-empty-'));
    createdDirs.push(workspace);
    await fs.writeFile(path.join(workspace, 'search.txt'), 'alpha\nbravo\n', 'utf8');

    const result = await executeToolCall({
      preset: 'chat-readonly',
      cwd: workspace,
      call: {
        name: 'search.rg',
        arguments: {
          pattern: 'charlie',
          path: '.',
        },
      },
    });

    expect(result.status).toBe('completed');
    expect(result.output).toMatchObject({
      pattern: 'charlie',
      truncated: false,
      matches: [],
    });
  });

  it('keeps file-path search results relative to the workspace', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'umbra-tools-search-file-'));
    createdDirs.push(workspace);
    await fs.writeFile(path.join(workspace, 'single.txt'), 'alpha\nbravo alpha\n', 'utf8');

    const result = await executeToolCall({
      preset: 'chat-readonly',
      cwd: workspace,
      call: {
        name: 'search.rg',
        arguments: {
          pattern: 'alpha',
          path: 'single.txt',
        },
      },
    });

    expect(result.status).toBe('completed');
    const matches = (result.output as { matches: Array<{ path: string }> }).matches;
    expect(matches.length).toBeGreaterThan(0);
    expect(matches.every((entry) => entry.path === 'single.txt')).toBe(true);
  });

  it('captures non-zero shell exits without crashing the tool runner', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'umbra-tools-shell-error-'));
    createdDirs.push(workspace);

    const result = await executeToolCall({
      preset: 'exec-full',
      cwd: workspace,
      call: {
        name: 'shell.exec',
        arguments: {
          command:
            process.platform === 'win32'
              ? 'Write-Output "before fail"; Write-Error "boom"; exit 7'
              : 'echo "before fail"; echo "boom" >&2; exit 7',
        },
      },
    });

    expect(result.status).toBe('completed');
    expect(result.output).toMatchObject({
      exitCode: 7,
      timedOut: false,
    });
    expect((result.output as { stdout: string }).stdout).toContain('before fail');
    expect((result.output as { stderr: string }).stderr).toContain('boom');
  });

  it('returns a structured web.fetch miss instead of failing on HTTP 404', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('{}', { status: 404, statusText: 'Not Found' }))
      .mockResolvedValueOnce(new Response('missing', { status: 404, statusText: 'Not Found' }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await executeToolCall({
      preset: 'chat-readonly',
      call: {
        name: 'web.fetch',
        arguments: {
          url: 'https://example.com/missing-page',
        },
      },
    });

    expect(result.status).toBe('completed');
    expect(result.output).toMatchObject({
      url: 'https://example.com/missing-page',
      title: '',
      mode: 'raw',
      truncated: false,
      statusCode: 404,
      error: 'HTTP 404 Not Found',
    });
    expect((result.output as { content: string }).content).toContain('Unable to fetch this URL');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
