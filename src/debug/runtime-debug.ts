import fs from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { resolveRuntimeLayout } from '../memory/runtime-layout.js';
import { loadConfig } from '../utils/config.js';

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

export async function runDebugMonitor(options: { intervalMs?: number } = {}): Promise<void> {
  const intervalMs = options.intervalMs ?? 10000;
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
        console.log(formatDebugEvent(JSON.parse(line) as DebugEvent));
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
      console.log(formatDebugEvent(JSON.parse(line) as DebugEvent));
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
