/**
 * Umbra plugin system.
 *
 * Dynamically loads TypeScript/JS scripts from a `plugins/` directory in the
 * target project (or from ~/.umbra/plugins/ for global plugins).
 *
 * Plugin lifecycle: discovery → install/register → load → reload → update policy.
 *
 * Each plugin module must export a default UmbraPlugin object.
 * Patterns borrowed from Claude Code tool extensions and adapted for Umbra.
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeDebugEvent } from '../debug/runtime-debug.js';

// ---------------------------------------------------------------------------
// Plugin contract
// ---------------------------------------------------------------------------

export type PluginToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Whether this tool may modify files or run shell commands */
  destructive?: boolean;
  /** Handler — receives validated args, returns result text or JSON */
  execute(args: Record<string, unknown>, context: PluginContext): Promise<unknown>;
};

export type PluginContext = {
  projectPath: string;
  cwd: string;
};

export type UmbraPlugin = {
  /** Unique stable identifier, e.g. "my-org.linter" */
  id: string;
  name: string;
  version: string;
  description?: string;
  tools?: PluginToolDefinition[];
  /** Called once after the plugin is loaded */
  onLoad?(): Promise<void> | void;
  /** Called before the plugin is unloaded */
  onUnload?(): Promise<void> | void;
};

// ---------------------------------------------------------------------------
// Plugin registry entry
// ---------------------------------------------------------------------------

export type PluginEntry = {
  id: string;
  filePath: string;
  plugin: UmbraPlugin;
  loadedAt: string;
  version: string;
};

export type PluginStatus = {
  id: string;
  name: string;
  version: string;
  filePath: string;
  loadedAt: string;
  toolCount: number;
};

// ---------------------------------------------------------------------------
// PluginLoader
// ---------------------------------------------------------------------------

export class PluginLoader {
  #entries = new Map<string, PluginEntry>();
  #searchPaths: string[];

  constructor(searchPaths: string[] = []) {
    this.#searchPaths = searchPaths;
  }

  addSearchPath(dir: string): void {
    if (!this.#searchPaths.includes(dir)) {
      this.#searchPaths.push(dir);
    }
  }

  /** Discover plugin files without loading them */
  discover(): string[] {
    const found: string[] = [];

    for (const dir of this.#searchPaths) {
      if (!fs.existsSync(dir)) continue;

      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });

        for (const entry of entries) {
          if (!entry.isFile()) continue;
          const ext = path.extname(entry.name).toLowerCase();
          if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
            found.push(path.join(dir, entry.name));
          }
        }
      } catch {
        // unreadable dir
      }
    }

    return found;
  }

  /** Load a plugin from a file path. Replaces any previously loaded plugin from the same file. */
  async load(filePath: string): Promise<PluginEntry> {
    const resolvedPath = path.resolve(filePath);

    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`Plugin file "${resolvedPath}" does not exist.`);
    }

    // Unload existing if same file is already loaded
    for (const entry of this.#entries.values()) {
      if (entry.filePath === resolvedPath) {
        await this.unload(entry.id);
        break;
      }
    }

    writeDebugEvent({
      component: 'plugins',
      level: 'info',
      message: 'loading plugin',
      data: { filePath: resolvedPath },
    });

    let mod: unknown;

    try {
      // Cache-bust with ?t= to support reloads
      const fileUrl = `${pathToFileURL(resolvedPath).href}?t=${Date.now()}`;
      mod = await import(fileUrl);
    } catch (err) {
      throw new Error(
        `Failed to load plugin "${resolvedPath}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const plugin = extractPlugin(mod, resolvedPath);
    validatePlugin(plugin);

    // Deduplicate id: if another file exports same plugin id, reject
    const existing = this.#entries.get(plugin.id);
    if (existing && existing.filePath !== resolvedPath) {
      throw new Error(
        `Plugin id "${plugin.id}" is already registered from "${existing.filePath}".`,
      );
    }

    if (plugin.onLoad) {
      try {
        await plugin.onLoad();
      } catch (err) {
        throw new Error(
          `Plugin "${plugin.id}" onLoad failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const entry: PluginEntry = {
      id: plugin.id,
      filePath: resolvedPath,
      plugin,
      loadedAt: new Date().toISOString(),
      version: plugin.version,
    };

    this.#entries.set(plugin.id, entry);

    writeDebugEvent({
      component: 'plugins',
      level: 'info',
      message: 'plugin loaded',
      data: {
        id: plugin.id,
        name: plugin.name,
        version: plugin.version,
        tools: plugin.tools?.length ?? 0,
      },
    });

    return entry;
  }

  /** Unload a plugin by id. */
  async unload(pluginId: string): Promise<void> {
    const entry = this.#entries.get(pluginId);

    if (!entry) {
      throw new Error(`Plugin "${pluginId}" is not loaded.`);
    }

    if (entry.plugin.onUnload) {
      try {
        await entry.plugin.onUnload();
      } catch (err) {
        writeDebugEvent({
          component: 'plugins',
          level: 'warn',
          message: 'plugin onUnload error',
          data: { id: pluginId, error: err instanceof Error ? err.message : String(err) },
        });
      }
    }

    this.#entries.delete(pluginId);

    writeDebugEvent({
      component: 'plugins',
      level: 'info',
      message: 'plugin unloaded',
      data: { id: pluginId },
    });
  }

  /** Reload a plugin from its file (calls unload then load). */
  async reload(pluginId: string): Promise<PluginEntry> {
    const entry = this.#entries.get(pluginId);

    if (!entry) {
      throw new Error(`Plugin "${pluginId}" is not loaded.`);
    }

    const filePath = entry.filePath;
    await this.unload(pluginId);
    return this.load(filePath);
  }

  /** Load all discovered plugins from search paths. Errors are collected, not thrown. */
  async loadAll(): Promise<{
    loaded: PluginEntry[];
    errors: Array<{ filePath: string; error: string }>;
  }> {
    const files = this.discover();
    const loaded: PluginEntry[] = [];
    const errors: Array<{ filePath: string; error: string }> = [];

    for (const filePath of files) {
      try {
        const entry = await this.load(filePath);
        loaded.push(entry);
      } catch (err) {
        errors.push({
          filePath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return { loaded, errors };
  }

  /** Unload all plugins. */
  async unloadAll(): Promise<void> {
    for (const id of [...this.#entries.keys()]) {
      try {
        await this.unload(id);
      } catch {
        // best-effort
      }
    }
  }

  listPlugins(): PluginStatus[] {
    return [...this.#entries.values()].map((entry) => ({
      id: entry.id,
      name: entry.plugin.name,
      version: entry.version,
      filePath: entry.filePath,
      loadedAt: entry.loadedAt,
      toolCount: entry.plugin.tools?.length ?? 0,
    }));
  }

  getPlugin(pluginId: string): UmbraPlugin | null {
    return this.#entries.get(pluginId)?.plugin ?? null;
  }

  /** Get all tools exposed by all loaded plugins */
  getAllTools(): Array<PluginToolDefinition & { pluginId: string }> {
    const tools: Array<PluginToolDefinition & { pluginId: string }> = [];

    for (const entry of this.#entries.values()) {
      for (const tool of entry.plugin.tools ?? []) {
        tools.push({ ...tool, pluginId: entry.id });
      }
    }

    return tools;
  }

  /** Get a specific plugin tool by qualified name "pluginId:toolName" or plain "toolName" */
  getTool(toolRef: string): (PluginToolDefinition & { pluginId: string }) | null {
    if (toolRef.includes(':')) {
      const [pluginId, toolName] = toolRef.split(':', 2) as [string, string];
      const entry = this.#entries.get(pluginId);
      const tool = entry?.plugin.tools?.find((t) => t.name === toolName);
      return tool ? { ...tool, pluginId } : null;
    }

    for (const entry of this.#entries.values()) {
      const tool = entry.plugin.tools?.find((t) => t.name === toolRef);
      if (tool) return { ...tool, pluginId: entry.id };
    }

    return null;
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _loader: PluginLoader | null = null;

export function getPluginLoader(): PluginLoader {
  if (!_loader) {
    _loader = new PluginLoader();
  }
  return _loader;
}

export function setPluginLoaderForTests(loader: PluginLoader): void {
  _loader = loader;
}

export function resetPluginLoaderForTests(): void {
  _loader = null;
}

/** Standard plugin search paths for a given project and umbra home */
export function getDefaultPluginSearchPaths(projectPath: string, umbraHome: string): string[] {
  return [path.join(projectPath, 'plugins'), path.join(umbraHome, 'plugins')];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractPlugin(mod: unknown, filePath: string): UmbraPlugin {
  if (!isRecord(mod)) {
    throw new Error(`Plugin module "${filePath}" did not export an object.`);
  }

  // Support: export default plugin, or module.exports = plugin
  const candidate = mod.default ?? mod;

  if (!isRecord(candidate)) {
    throw new Error(`Plugin module "${filePath}" did not export a plugin object as default.`);
  }

  return candidate as UmbraPlugin;
}

function validatePlugin(plugin: UmbraPlugin): void {
  if (typeof plugin.id !== 'string' || plugin.id.trim().length === 0) {
    throw new Error('Plugin must have a non-empty "id" string.');
  }

  if (typeof plugin.name !== 'string' || plugin.name.trim().length === 0) {
    throw new Error(`Plugin "${plugin.id}" must have a non-empty "name" string.`);
  }

  if (typeof plugin.version !== 'string' || plugin.version.trim().length === 0) {
    throw new Error(`Plugin "${plugin.id}" must have a non-empty "version" string.`);
  }

  if (plugin.tools) {
    if (!Array.isArray(plugin.tools)) {
      throw new Error(`Plugin "${plugin.id}" tools must be an array.`);
    }

    for (const tool of plugin.tools) {
      if (typeof tool.name !== 'string' || tool.name.trim().length === 0) {
        throw new Error(`Plugin "${plugin.id}" has a tool missing a valid "name".`);
      }

      if (typeof tool.execute !== 'function') {
        throw new Error(
          `Plugin "${plugin.id}" tool "${tool.name}" must export an "execute" function.`,
        );
      }
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
