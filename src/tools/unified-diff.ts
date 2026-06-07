import fs from 'node:fs/promises';
import path from 'node:path';

type Hunk = {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
};

type FilePatch = {
  oldPath: string;
  newPath: string;
  hunks: Hunk[];
};

export type AppliedPatchFile = {
  path: string;
  operation: 'modified' | 'added' | 'deleted';
  hunksApplied: number;
};

export async function applyUnifiedDiffPatch(
  patchText: string,
  cwd: string,
  dryRun = false,
): Promise<AppliedPatchFile[]> {
  const patches = parseUnifiedDiff(patchText);
  const applied: AppliedPatchFile[] = [];

  for (const patch of patches) {
    const oldIsNull = patch.oldPath === '/dev/null';
    const newIsNull = patch.newPath === '/dev/null';

    if (
      !oldIsNull &&
      !newIsNull &&
      normalizePatchPath(patch.oldPath) !== normalizePatchPath(patch.newPath)
    ) {
      throw new Error(`Renames are not supported by fs.edit: ${patch.oldPath} -> ${patch.newPath}`);
    }

    const filePath = oldIsNull
      ? normalizePatchPath(patch.newPath)
      : normalizePatchPath(patch.oldPath);
    const absolutePath = path.resolve(cwd, filePath);
    const originalContent = oldIsNull ? '' : await readIfExists(absolutePath);
    const updatedContent = applyFilePatch(originalContent, patch);

    if (!dryRun) {
      if (newIsNull) {
        await fs.rm(absolutePath, { force: true });
      } else {
        await fs.mkdir(path.dirname(absolutePath), { recursive: true });
        await fs.writeFile(absolutePath, updatedContent, 'utf8');
      }
    }

    applied.push({
      path: absolutePath,
      operation: oldIsNull ? 'added' : newIsNull ? 'deleted' : 'modified',
      hunksApplied: patch.hunks.length,
    });
  }

  return applied;
}

function parseUnifiedDiff(patchText: string): FilePatch[] {
  const lines = patchText.replace(/\r\n/g, '\n').split('\n');
  const patches: FilePatch[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (!line || !line.startsWith('--- ')) {
      index += 1;
      continue;
    }

    const oldPath = line.slice(4).trim().split('\t', 1)[0] ?? '';
    const nextLine = lines[index + 1];

    if (!nextLine?.startsWith('+++ ')) {
      throw new Error('Invalid unified diff: missing +++ header.');
    }

    const newPath = nextLine.slice(4).trim().split('\t', 1)[0] ?? '';
    index += 2;
    const hunks: Hunk[] = [];

    while (index < lines.length) {
      const hunkHeader = lines[index];

      if (hunkHeader?.startsWith('@@ ')) {
        const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(hunkHeader);

        if (!match) {
          throw new Error(`Invalid unified diff hunk header: ${hunkHeader}`);
        }

        index += 1;
        const hunkLines: string[] = [];

        while (index < lines.length) {
          const hunkLine = lines[index];

          if (hunkLine === undefined || hunkLine.startsWith('@@ ') || hunkLine.startsWith('--- ')) {
            break;
          }

          if (hunkLine === '\\ No newline at end of file') {
            index += 1;
            continue;
          }

          hunkLines.push(hunkLine);
          index += 1;
        }

        hunks.push({
          oldStart: Number(match[1]),
          oldLines: Number(match[2] ?? '1'),
          newStart: Number(match[3]),
          newLines: Number(match[4] ?? '1'),
          lines: hunkLines,
        });
        continue;
      }

      if (hunkHeader?.startsWith('--- ')) {
        break;
      }

      index += 1;
    }

    patches.push({ oldPath, newPath, hunks });
  }

  if (patches.length === 0) {
    throw new Error('Unified diff does not contain any file patches.');
  }

  return patches;
}

function normalizePatchPath(filePath: string): string {
  if (filePath === '/dev/null') {
    return filePath;
  }

  return filePath.replace(/^[ab]\//, '');
}

function applyFilePatch(content: string, patch: FilePatch): string {
  const { lines: sourceLines, eol, hasTrailingNewline } = splitLines(content);
  const output: string[] = [];
  let sourceIndex = 0;

  for (const hunk of patch.hunks) {
    const targetIndex = Math.max(0, hunk.oldStart - 1);

    while (sourceIndex < targetIndex) {
      output.push(sourceLines[sourceIndex] ?? '');
      sourceIndex += 1;
    }

    for (const line of hunk.lines) {
      const prefix = line[0];
      const value = line.slice(1);

      if (prefix === ' ') {
        const sourceLine = sourceLines[sourceIndex];
        if (sourceLine !== value) {
          throw new Error(`Patch context mismatch at ${patch.oldPath}`);
        }
        output.push(sourceLine);
        sourceIndex += 1;
        continue;
      }

      if (prefix === '-') {
        const sourceLine = sourceLines[sourceIndex];
        if (sourceLine !== value) {
          throw new Error(`Patch deletion mismatch at ${patch.oldPath}`);
        }
        sourceIndex += 1;
        continue;
      }

      if (prefix === '+') {
        output.push(value);
        continue;
      }

      throw new Error(`Unsupported unified diff line: ${line}`);
    }
  }

  while (sourceIndex < sourceLines.length) {
    output.push(sourceLines[sourceIndex] ?? '');
    sourceIndex += 1;
  }

  if (patch.newPath === '/dev/null') {
    return '';
  }

  return joinLines(output, eol, hasTrailingNewline || patch.oldPath === '/dev/null');
}

function splitLines(content: string): {
  lines: string[];
  eol: string;
  hasTrailingNewline: boolean;
} {
  const eolMatch = content.match(/\r\n|\n|\r/);
  const eol = eolMatch?.[0] ?? '\n';
  const hasTrailingNewline = content.endsWith('\n') || content.endsWith('\r');

  if (content.length === 0) {
    return { lines: [], eol, hasTrailingNewline: false };
  }

  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const rawLines = normalized.split('\n');

  if (hasTrailingNewline) {
    rawLines.pop();
  }

  return { lines: rawLines, eol, hasTrailingNewline };
}

function joinLines(lines: string[], eol: string, trailingNewline: boolean): string {
  const joined = lines.join(eol);
  return trailingNewline ? `${joined}${eol}` : joined;
}

async function readIfExists(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (isNotFoundError(error)) {
      return '';
    }
    throw error;
  }
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
