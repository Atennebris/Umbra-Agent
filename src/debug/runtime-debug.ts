import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { resolveRuntimeLayout } from '../memory/runtime-layout.js';
import { loadConfig } from '../utils/config.js';

// ANSI color codes for terminal-only output (never written to log files)
const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  white: '\x1b[37m',
};

const COMPONENT_COLOR: Record<string, string> = {
  runner: C.cyan,
  provider: C.blue,
  permissions: C.yellow,
  daemon: C.magenta,
  cli: C.white,
  tui: C.white,
  debug: C.dim,
  mcp: C.magenta,
  skills: C.green,
  plugins: C.green,
};

export type DebugEvent = {
  timestamp: string;
  component:
    | 'runner'
    | 'cli'
    | 'daemon'
    | 'provider'
    | 'tui'
    | 'debug'
    | 'mcp'
    | 'permissions'
    | 'plugins'
    | 'skills';
  level: 'info' | 'warn' | 'error';
  message: string;
  data?: Record<string, unknown>;
};

export function writeDebugEvent(event: Omit<DebugEvent, 'timestamp'>): void {
  try {
    const layout = resolveRuntimeLayout();
    const payload: DebugEvent = {
      timestamp: new Date().toISOString(),
      ...event,
    };
    const line = JSON.stringify(payload);
    fs.appendFileSync(layout.debugEventsPath, `${line}\n`, 'utf8');
    fs.appendFileSync(layout.debugLogPath, `${formatDebugEvent(payload)}\n`, 'utf8');
  } catch {
    // Debug logging must never break the CLI or daemon path.
  }
}

// Windows only — on other platforms run `umbra debug` in another terminal.
export function spawnDebugConsole(): void {
  if (process.platform !== 'win32') {
    return;
  }

  const scriptPath = process.argv[1];
  if (!scriptPath) {
    return;
  }

  const isTsEntry = scriptPath.endsWith('.ts') || scriptPath.endsWith('.tsx');
  const args = isTsEntry
    ? ['/c', 'start', 'Umbra Debug', 'npx', 'tsx', scriptPath, 'debug']
    : ['/c', 'start', 'Umbra Debug', process.execPath, scriptPath, 'debug'];

  spawn('cmd.exe', args, { detached: true, stdio: 'ignore', windowsHide: false }).unref();
}

export async function runDebugMonitor(options: { intervalMs?: number } = {}): Promise<void> {
  const intervalMs = options.intervalMs ?? 1000;
  const layout = resolveRuntimeLayout();
  fs.writeFileSync(layout.debugLogPath, '', { flag: 'a', encoding: 'utf8' });
  const YELLOW = '\x1b[33m';
  const BOLD = '\x1b[1m';
  const RESET = '\x1b[0m';
  console.log(`${BOLD}${YELLOW}[ DEBUG MODE — daemon event monitor ]${RESET}`);
  console.log('Umbra debug monitor');
  console.log(`events: ${layout.debugEventsPath}`);
  console.log(`log:    ${layout.debugLogPath}`);
  writeDebugEvent({
    component: 'debug',
    level: 'info',
    message: 'debug monitor started',
  });

  let position = 0;
  position = printRecentEvents(layout.debugEventsPath, 30);

  let lastHealthLine = '';

  // Give the daemon ~1.5 s to boot before the first health ping so the
  // debug window doesn't log a spurious "health offline" on every start.
  await delay(1500);

  while (true) {
    lastHealthLine = await printHealthSnapshot(lastHealthLine);
    position = printNewEvents(layout.debugEventsPath, position);
    await delay(intervalMs);
  }
}

function printNewEvents(eventsPath: string, position: number): number {
  if (!fs.existsSync(eventsPath)) {
    return 0;
  }

  const stat = fs.statSync(eventsPath);
  const nextPosition = stat.size < position ? 0 : position;

  if (stat.size === nextPosition) {
    return nextPosition;
  }

  const file = fs.openSync(eventsPath, 'r');
  try {
    const length = stat.size - nextPosition;
    const buffer = Buffer.alloc(length);
    fs.readSync(file, buffer, 0, length, nextPosition);

    for (const line of buffer.toString('utf8').split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }

      try {
        console.log(formatDebugEventForTerminal(JSON.parse(line) as DebugEvent));
      } catch {
        console.log(line);
      }
    }
  } finally {
    fs.closeSync(file);
  }

  return stat.size;
}

function printRecentEvents(eventsPath: string, lineCount: number): number {
  if (!fs.existsSync(eventsPath)) {
    return 0;
  }

  const content = fs.readFileSync(eventsPath, 'utf8');
  const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const recent = lines.slice(-lineCount);

  if (recent.length > 0) {
    console.log(`recent events: ${recent.length}`);
  }

  for (const line of recent) {
    try {
      console.log(formatDebugEventForTerminal(JSON.parse(line) as DebugEvent));
    } catch {
      console.log(line);
    }
  }

  return Buffer.byteLength(content, 'utf8');
}

async function printHealthSnapshot(lastLine: string): Promise<string> {
  const config = loadConfig();
  const timestamp = new Date().toISOString();

  try {
    const response = await fetch(`http://${config.daemon.host}:${config.daemon.port}/health`);
    if (!response.ok) {
      const line = `health error ${response.status}`;
      if (line !== lastLine) {
        console.log(`[${timestamp}] ${line}`);
      }
      return line;
    }

    const payload = (await response.json()) as Record<string, unknown>;
    const queueDepth = payload.queueDepth ?? 'unknown';
    const activeProvider = isRecord(payload.activeProvider) ? payload.activeProvider : null;
    const providerLabel =
      activeProvider && typeof activeProvider.label === 'string' ? activeProvider.label : 'none';
    const model =
      activeProvider && typeof activeProvider.model === 'string' ? activeProvider.model : 'none';
    const line = `health ok queue=${queueDepth} provider=${providerLabel} model=${model}`;
    if (line !== lastLine) {
      console.log(`[${timestamp}] ${line}`);
    }
    return line;
  } catch (error) {
    const line = `health offline ${error instanceof Error ? error.message : String(error)}`;
    if (line !== lastLine) {
      console.log(`[${timestamp}] ${line}`);
    }
    return line;
  }
}

export function formatDebugEvent(event: DebugEvent): string {
  const ts = event.timestamp.replace('T', ' ').replace('Z', '').slice(0, 23);
  const level = event.level.toUpperCase().padEnd(5);
  const component = event.component.padEnd(11);

  if (!event.data || Object.keys(event.data).length === 0) {
    return `[${ts}] ${level} ${component} ${event.message}`;
  }

  if (event.level === 'warn' || event.level === 'error') {
    const lines = [`[${ts}] ${level} ${component} ${event.message}`];
    for (const [key, val] of Object.entries(event.data)) {
      if (val === undefined || val === null) continue;
      const rendered = renderDebugValue(val, true);
      lines.push(`  ${key}: ${rendered}`);
    }
    return lines.join('\n');
  }

  const inlineData = Object.entries(event.data)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${renderDebugValue(v)}`)
    .join(' ');

  return `[${ts}] ${level} ${component} ${event.message} ${inlineData}`;
}

function renderDebugValue(value: unknown, spacedArray = false): string {
  if (Array.isArray(value)) {
    const separator = spacedArray ? ', ' : ',';
    return `[${value.map((item) => renderDebugValue(item, spacedArray)).join(separator)}]`;
  }

  if (typeof value === 'object' && value !== null) {
    try {
      return JSON.stringify(value);
    } catch {
      return '[unserializable]';
    }
  }

  return String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Terminal-only colored formatter — never write ANSI codes to log files.
function formatDebugEventForTerminal(event: DebugEvent): string {
  const ts = event.timestamp.replace('T', ' ').replace('Z', '').slice(0, 23);
  const level = event.level.toUpperCase().padEnd(5);
  const color = event.level === 'error' ? C.red : event.level === 'warn' ? C.yellow : (COMPONENT_COLOR[event.component] ?? C.white);
  const component = event.component.padEnd(11);
  const header = `${C.dim}[${ts}]${C.reset} ${color}${level}${C.reset} ${color}${C.bold}${component}${C.reset}`;

  if (!event.data || Object.keys(event.data).length === 0) {
    return `${header} ${event.message}`;
  }

  if (event.level === 'warn' || event.level === 'error') {
    const lines = [`${header} ${color}${event.message}${C.reset}`];
    for (const [key, val] of Object.entries(event.data)) {
      if (val === undefined || val === null) continue;
      lines.push(`  ${C.dim}${key}:${C.reset} ${renderDebugValue(val, true)}`);
    }
    return lines.join('\n');
  }

  const inlineData = Object.entries(event.data)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${C.dim}${k}=${C.reset}${renderDebugValue(v)}`)
    .join(' ');

  return `${header} ${event.message} ${inlineData}`;
}

// Writes the complete tool call payload (arguments + result) to a JSON file
// in debug/tool-calls/ when the data is too large for the inline log.
// Returns the file path, or null on failure.
export function writeToolCallDump(
  callId: string,
  toolName: string,
  args: unknown,
  result: unknown,
): string | null {
  try {
    const layout = resolveRuntimeLayout();
    const dir = path.join(layout.debugDir, 'tool-calls');
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${callId}.json`);
    const payload = {
      callId,
      toolName,
      timestamp: new Date().toISOString(),
      arguments: args,
      result,
    };
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
    return filePath;
  } catch {
    return null;
  }
}

// Collapses newlines and caps length so multi-line blobs (reasoning content,
// patches, file bodies) stay on one line in latest.log and don't blow up
// events.jsonl.
export function truncateForDebug(text: string, maxLength = 800): string {
  const singleLine = text.replace(/\r\n|\r|\n/g, '\\n');

  if (singleLine.length <= maxLength) {
    return singleLine;
  }

  return `${singleLine.slice(0, maxLength)}…(+${singleLine.length - maxLength} more chars)`;
}

// Writes the full, untruncated reasoning text for one LLM response to
// debug/reasoning/<requestId>.txt so it can be inspected even when it's far
// too large for the inline `reasoningPreview` in events.jsonl/latest.log.
// Returns the file path, or null if the content is short enough that the
// inline preview already covers it in full, or on write failure.
export function writeReasoningDump(requestId: string, reasoningContent: string): string | null {
  if (reasoningContent.length <= 800) {
    return null;
  }

  try {
    const layout = resolveRuntimeLayout();
    const dir = path.join(layout.debugDir, 'reasoning');
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${requestId}.txt`);
    fs.writeFileSync(filePath, reasoningContent, 'utf8');
    return filePath;
  } catch {
    return null;
  }
}
