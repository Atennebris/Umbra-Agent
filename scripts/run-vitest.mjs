import fs from 'node:fs';
import path from 'node:path';

const nativeRealpathSync = fs.realpathSync.native.bind(fs.realpathSync);
const currentDirectory = path.resolve('./');

Object.defineProperty(fs.realpathSync, 'native', {
  configurable: true,
  value(target, options) {
    if (typeof target === 'string' && path.resolve(target) === currentDirectory) {
      const error = new Error('EISDIR: illegal operation on a directory');
      error.code = 'EISDIR';
      throw error;
    }

    return nativeRealpathSync(target, options);
  },
});

await import('../node_modules/vitest/vitest.mjs');
