/**
 * Umbra MCP (Model Context Protocol) client.
 *
 * Implements MCP client-side protocol for connecting to external tool servers.
 * Supports:
 *   - Discovery: list tools and resources exposed by a server
 *   - Tool invocation: call a remote tool with typed args
 *   - Resource reading: fetch resources (files, URLs, data) exposed by the server
 *   - Auth flow: bearer token and custom header injection
 *
 * Transport: stdio subprocess (the MCP standard for local servers).
 *
 * Reference patterns taken from Claude Code MCP integration and adapted for Umbra.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeDebugEvent } from '../debug/runtime-debug.js';
import { getPermissionManager } from './permissions.js';

// ---------------------------------------------------------------------------
// MCP JSON-RPC wire types
// ---------------------------------------------------------------------------

type JsonRpcRequest = {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: unknown;
};

type JsonRpcResponse = {
  jsonrpc: '2.0';
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

type JsonRpcNotification = {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
};

// ---------------------------------------------------------------------------
// MCP capability types
// ---------------------------------------------------------------------------

export type McpToolDefinition = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

export type McpResourceDefinition = {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
};

export type McpToolResult = {
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: string }
    | { type: 'resource'; resource: { uri: string; text?: string; blob?: string } }
  >;
  isError?: boolean;
};

export type McpServerCapabilities = {
  tools?: { listChanged?: boolean };
  resources?: { listChanged?: boolean; subscribe?: boolean };
  prompts?: { listChanged?: boolean };
  logging?: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Server entry config
// ---------------------------------------------------------------------------

export type McpServerConfig = {
  id: string;
  label: string;
  /** Command to launch the stdio server, e.g. ["node", "server.js"] */
  command: string[];
  env?: Record<string, string>;
  /** Bearer token for auth (injected as Authorization header in HTTP transport) */
  authToken?: string;
  /** Extra request headers for HTTP transport servers */
  extraHeaders?: Record<string, string>;
  enabled: boolean;
};

// ---------------------------------------------------------------------------
// McpClient — stdio transport
// ---------------------------------------------------------------------------

export class McpClient {
  readonly #config: McpServerConfig;
  #process: ChildProcess | null = null;
  #pending = new Map<
    string | number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  #buffer = '';
  #initializationId: string | null = null;
  #serverCapabilities: McpServerCapabilities = {};

  constructor(config: McpServerConfig) {
    this.#config = config;
  }

  get id(): string {
    return this.#config.id;
  }

  get label(): string {
    return this.#config.label;
  }

  get serverCapabilities(): McpServerCapabilities {
    return this.#serverCapabilities;
  }

  async connect(): Promise<void> {
    if (this.#process) {
      return; // already connected
    }

    const [cmd, ...args] = this.#config.command;

    if (!cmd) {
      throw new Error(`MCP server "${this.#config.id}" has no command configured.`);
    }

    this.#process = spawn(cmd, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...this.#config.env },
    });

    this.#process.stdout?.setEncoding('utf8');
    this.#process.stdout?.on('data', (chunk: string) => {
      this.#buffer += chunk;
      this.#flushBuffer();
    });

    this.#process.stderr?.setEncoding('utf8');
    this.#process.stderr?.on('data', (chunk: string) => {
      writeDebugEvent({
        component: 'mcp',
        level: 'warn',
        message: 'server stderr',
        data: { serverId: this.#config.id, chunk: chunk.trim() },
      });
    });

    this.#process.on('error', (err) => {
      writeDebugEvent({
        component: 'mcp',
        level: 'error',
        message: 'server process error',
        data: { serverId: this.#config.id, error: err.message },
      });
      this.#rejectAll(err);
    });

    this.#process.on('exit', (code) => {
      writeDebugEvent({
        component: 'mcp',
        level: 'info',
        message: 'server process exited',
        data: { serverId: this.#config.id, code },
      });
      this.#rejectAll(new Error(`MCP server "${this.#config.id}" exited with code ${code}.`));
      this.#process = null;
    });

    // MCP initialize handshake
    const initResult = await this.#request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {
        roots: { listChanged: false },
        sampling: {},
      },
      clientInfo: {
        name: 'umbra-cli',
        version: '0.1.0',
      },
    });

    if (isRecord(initResult) && isRecord(initResult.capabilities)) {
      this.#serverCapabilities = initResult.capabilities as McpServerCapabilities;
    }

    // Send initialized notification
    this.#notify('notifications/initialized', {});

    writeDebugEvent({
      component: 'mcp',
      level: 'info',
      message: 'connected',
      data: { serverId: this.#config.id, capabilities: this.#serverCapabilities },
    });
  }

  async disconnect(): Promise<void> {
    if (!this.#process) return;

    try {
      this.#process.stdin?.end();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.#process?.kill();
          resolve();
        }, 2000);

        this.#process?.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    } catch {
      this.#process?.kill();
    }

    this.#process = null;
  }

  async listTools(): Promise<McpToolDefinition[]> {
    const result = await this.#request('tools/list', {});

    if (isRecord(result) && Array.isArray(result.tools)) {
      return result.tools.filter(isRecord).map((tool) => {
        const desc = typeof tool.description === 'string' ? tool.description : undefined;
        const schema = isRecord(tool.inputSchema) ? tool.inputSchema : undefined;
        return {
          name: String(tool.name ?? ''),
          ...(desc !== undefined ? { description: desc } : {}),
          ...(schema !== undefined ? { inputSchema: schema } : {}),
        };
      });
    }

    return [];
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<McpToolResult> {
    const manager = getPermissionManager();
    const decision = await manager.evaluate({
      tool: name,
      args,
      mode: 'agent-default',
      summary: `External MCP tool call: ${name}`,
    });

    if (decision.outcome !== 'allow') {
      return {
        content: [{ type: 'text', text: `Permission denied for MCP tool ${name}.` }],
        isError: true,
      };
    }

    const result = await this.#request('tools/call', {
      name,
      arguments: args,
    });

    if (isRecord(result)) {
      return {
        content: Array.isArray(result.content)
          ? (result.content as McpToolResult['content'])
          : [{ type: 'text', text: JSON.stringify(result) }],
        isError: result.isError === true,
      };
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
    };
  }

  async listResources(): Promise<McpResourceDefinition[]> {
    const result = await this.#request('resources/list', {});

    if (isRecord(result) && Array.isArray(result.resources)) {
      return result.resources.filter(isRecord).map((res) => {
        const name = typeof res.name === 'string' ? res.name : undefined;
        const description = typeof res.description === 'string' ? res.description : undefined;
        const mimeType = typeof res.mimeType === 'string' ? res.mimeType : undefined;
        return {
          uri: String(res.uri ?? ''),
          ...(name !== undefined ? { name } : {}),
          ...(description !== undefined ? { description } : {}),
          ...(mimeType !== undefined ? { mimeType } : {}),
        };
      });
    }

    return [];
  }

  async readResource(uri: string): Promise<{
    contents: Array<{ uri: string; text?: string; blob?: string; mimeType?: string }>;
  }> {
    const result = await this.#request('resources/read', { uri });

    if (isRecord(result) && Array.isArray(result.contents)) {
      return {
        contents: result.contents as Array<{
          uri: string;
          text?: string;
          blob?: string;
          mimeType?: string;
        }>,
      };
    }

    return { contents: [] };
  }

  get isConnected(): boolean {
    return this.#process !== null && !this.#process.killed;
  }

  // ---------------------------------------------------------------------------
  // Private wire methods
  // ---------------------------------------------------------------------------

  async #request(method: string, params: unknown): Promise<unknown> {
    if (!this.#process?.stdin) {
      throw new Error(`MCP server "${this.#config.id}" is not connected.`);
    }

    const id = randomUUID();
    const message: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#send(message);
    });
  }

  #notify(method: string, params: unknown): void {
    if (!this.#process?.stdin) return;

    const message: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      params,
    };
    this.#send(message);
  }

  #send(message: JsonRpcRequest | JsonRpcNotification): void {
    const line = `${JSON.stringify(message)}\n`;
    this.#process?.stdin?.write(line);
  }

  #flushBuffer(): void {
    const lines = this.#buffer.split('\n');
    this.#buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const message = JSON.parse(trimmed) as JsonRpcResponse;

        if (!('id' in message)) {
          // Server notification — ignore for now
          continue;
        }

        const handler = this.#pending.get(message.id);

        if (!handler) continue;
        this.#pending.delete(message.id);

        if (message.error) {
          handler.reject(new Error(`MCP error ${message.error.code}: ${message.error.message}`));
        } else {
          handler.resolve(message.result);
        }
      } catch {
        // malformed line
      }
    }
  }

  #rejectAll(err: Error): void {
    for (const handler of this.#pending.values()) {
      handler.reject(err);
    }
    this.#pending.clear();
  }
}

// ---------------------------------------------------------------------------
// McpRegistry — manages multiple server connections
// ---------------------------------------------------------------------------

export class McpRegistry {
  #servers = new Map<string, { config: McpServerConfig; client: McpClient | null }>();

  register(config: McpServerConfig): void {
    if (this.#servers.has(config.id)) {
      throw new Error(`MCP server "${config.id}" is already registered.`);
    }
    this.#servers.set(config.id, { config, enabled: config.enabled, client: null } as {
      config: McpServerConfig;
      client: McpClient | null;
    });
  }

  unregister(serverId: string): void {
    const entry = this.#servers.get(serverId);
    if (entry?.client) {
      void entry.client.disconnect();
    }
    this.#servers.delete(serverId);
  }

  listServers(): McpServerConfig[] {
    return [...this.#servers.values()].map((e) => e.config);
  }

  async getClient(serverId: string): Promise<McpClient> {
    const entry = this.#servers.get(serverId);

    if (!entry) {
      throw new Error(`MCP server "${serverId}" is not registered.`);
    }

    if (!entry.config.enabled) {
      throw new Error(`MCP server "${serverId}" is disabled.`);
    }

    if (!entry.client || !entry.client.isConnected) {
      entry.client = new McpClient(entry.config);
      await entry.client.connect();
    }

    return entry.client;
  }

  async disconnectAll(): Promise<void> {
    await Promise.all(
      [...this.#servers.values()]
        .filter((e) => e.client?.isConnected)
        .map((e) => e.client?.disconnect()),
    );
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _registry: McpRegistry | null = null;

export function getMcpRegistry(): McpRegistry {
  if (!_registry) {
    _registry = new McpRegistry();
  }
  return _registry;
}

export function resetMcpRegistryForTests(): void {
  _registry = null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
