import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildRepoMap } from '../src/context/repo-map.js';

describe('Universal Text Fallback', () => {
  async function createTempFixture(files: Record<string, string>) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'umbra-fallback-test-'));
    for (const [name, content] of Object.entries(files)) {
      await fs.writeFile(path.join(dir, name), content, 'utf8');
    }
    return dir;
  }

  it('redacts secrets from .env files', async () => {
    const dir = await createTempFixture({
      '.env': 'API_KEY=super_secret_value\nDEBUG=true',
      '.env.production': 'TOKEN=123456',
    });

    try {
      const repoMap = await buildRepoMap(dir);
      const envFile = repoMap.files.find((f) => f.path === '.env');
      const prodFile = repoMap.files.find((f) => f.path === '.env.production');

      expect(envFile).toBeDefined();
      expect(envFile?.symbols).toContainEqual(
        expect.objectContaining({ name: 'API_KEY', signature: 'API_KEY=***REDACTED***' }),
      );
      expect(envFile?.symbols).toContainEqual(
        expect.objectContaining({ name: 'DEBUG', signature: 'DEBUG=***REDACTED***' }),
      );

      expect(prodFile).toBeDefined();
      expect(prodFile?.symbols).toContainEqual(
        expect.objectContaining({ name: 'TOKEN', signature: 'TOKEN=***REDACTED***' }),
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('extracts classes, exports and headings from unknown extensions', async () => {
    const dir = await createTempFixture({
      // Use .myvue — no dedicated parser, so hits the fallback
      'component.myvue': `
<template>
  <div>Hello</div>
</template>
<script>
export function myHelper() {}
class MyComponent { }
// TODO: Fix this
</script>
      `,
      'README.foo': `
# Main Header
Some text
## Sub header
More text
      `,
    });

    try {
      const repoMap = await buildRepoMap(dir);

      const vueFile = repoMap.files.find((f) => f.path === 'component.myvue');
      expect(vueFile).toBeDefined();
      expect(vueFile?.symbols).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'myHelper', kind: 'function' }),
          expect.objectContaining({ name: 'MyComponent', kind: 'class' }),
          expect.objectContaining({ name: 'TODO', kind: 'comment' }),
        ]),
      );

      const fooFile = repoMap.files.find((f) => f.path === 'README.foo');
      expect(fooFile).toBeDefined();
      expect(fooFile?.symbols).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'Main Header', kind: 'h1' }),
          expect.objectContaining({ name: 'Sub header', kind: 'h2' }),
        ]),
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('extracts config-like keys from Dockerfile and limits config matches', async () => {
    const dir = await createTempFixture({
      Dockerfile: `
FROM node:18
ENV NODE_ENV=production
WORKDIR /app
COPY . .
RUN npm install
      `,
    });

    try {
      const repoMap = await buildRepoMap(dir);
      const dockerfile = repoMap.files.find((f) => f.path === 'Dockerfile');

      expect(dockerfile).toBeDefined();
      // "ENV NODE_ENV=production" — structured Dockerfile parser uses kind 'env'
      expect(dockerfile?.symbols).toContainEqual(
        expect.objectContaining({ name: 'NODE_ENV', kind: 'env' }),
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
