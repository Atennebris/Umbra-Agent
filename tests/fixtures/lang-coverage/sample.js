import { readFileSync } from 'node:fs';

export function loadConfig(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

export class ConfigManager {
  constructor(path) {
    this.config = loadConfig(path);
  }

  get(key) {
    return this.config[key];
  }
}
