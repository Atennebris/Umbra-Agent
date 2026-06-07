import { MemoryManager } from './manager.js';

let manager: MemoryManager | null = null;

export function getMemoryManager(): MemoryManager {
  if (!manager) {
    manager = new MemoryManager();
    manager.initialize();
  }

  return manager;
}

export function resetMemoryManagerForTests(): void {
  if (manager) {
    manager.close();
    manager = null;
  }
}

export function setMemoryManagerForTests(nextManager: MemoryManager | null): void {
  if (manager && manager !== nextManager) {
    manager.close();
  }

  manager = nextManager;
}

export * from './database.js';
export * from './embeddings.js';
export * from './manager.js';
export * from './project-files.js';
export * from './runtime-layout.js';
export * from './settings-store.js';
