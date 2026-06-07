import fs from 'node:fs/promises';
import path from 'node:path';
import type { ProjectReferenceItem } from './project-reference-index.js';

const MAX_REFERENCED_FILES = 6;
const MAX_REFERENCED_FILE_CHARS = 12_000;
const MAX_DIRECTORY_ITEMS = 24;

export async function enrichPromptWithReferences(input: {
  prompt: string;
  projectPath: string;
  fileReferences: string[];
  catalog: ProjectReferenceItem[];
}): Promise<string> {
  const uniqueReferences = [...new Set(input.fileReferences.map(normalizeReferencePath))].filter(
    Boolean,
  );

  if (uniqueReferences.length === 0) {
    return input.prompt;
  }

  const sections: string[] = [];

  for (const reference of uniqueReferences.slice(0, MAX_REFERENCED_FILES)) {
    const exactItem = input.catalog.find((item) => item.path === reference) ?? null;

    if (exactItem?.kind === 'directory' || reference.endsWith('/')) {
      const prefix = reference.replace(/\/+$/, '');
      const children = input.catalog
        .filter((item) => item.kind === 'file' && item.path.startsWith(`${prefix}/`))
        .slice(0, MAX_DIRECTORY_ITEMS)
        .map((item) => `- ${item.path}`);

      if (children.length > 0) {
        sections.push([`Directory: ${prefix}/`, children.join('\n')].join('\n'));
      }
      continue;
    }

    const allowedFile =
      exactItem?.kind === 'file'
        ? exactItem.path
        : (input.catalog.find((item) => item.kind === 'file' && item.path === reference)?.path ??
          null);

    if (!allowedFile) {
      continue;
    }

    const absolutePath = path.join(input.projectPath, allowedFile);

    try {
      const content = await fs.readFile(absolutePath, 'utf8');
      const trimmed =
        content.length > MAX_REFERENCED_FILE_CHARS
          ? `${content.slice(0, MAX_REFERENCED_FILE_CHARS)}\n... [truncated]`
          : content;
      sections.push([`File: ${allowedFile}`, '```', trimmed, '```'].join('\n'));
    } catch {}
  }

  if (sections.length === 0) {
    return input.prompt;
  }

  return [input.prompt, 'Referenced project context:', sections.join('\n\n')].join('\n\n');
}

function normalizeReferencePath(value: string): string {
  return value
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/\/{2,}/g, '/')
    .trim();
}
