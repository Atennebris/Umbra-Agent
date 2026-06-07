import type { CliCommandHandler } from '../command-types.js';
import { getStatus } from '../http-client.js';
import { renderKeyValueCard } from '../tui/frame.js';

type StatusCommandInput = {
  json?: boolean;
};

export const runStatusCommand: CliCommandHandler = async (input) => {
  const options = (input as StatusCommandInput | undefined) ?? {};
  const status = await getStatus();

  if (options.json) {
    console.log(JSON.stringify(status, null, 2));
    return;
  }

  const statusRecord = status as Record<string, unknown>;

  console.log(
    renderKeyValueCard('Umbra Daemon Status', [
      ['State', String(statusRecord.ok === true ? 'healthy' : 'offline')],
      ['Host', String(statusRecord.host ?? 'unknown')],
      ['Port', String(statusRecord.port ?? 'unknown')],
      ['Queue depth', String(statusRecord.queueDepth ?? '0')],
      ['Uptime', `${String(statusRecord.uptimeSeconds ?? '0')}s`],
    ]),
  );
};
