import { runDebugMonitor } from '../../debug/runtime-debug.js';
import type { CliCommandHandler } from '../command-types.js';

type DebugCommandInput = {
  intervalMs?: number;
};

export const runDebugCommand: CliCommandHandler = async (input) => {
  const options = input as DebugCommandInput;
  await runDebugMonitor({
    ...(typeof options.intervalMs === 'number' ? { intervalMs: options.intervalMs } : {}),
  });
};
