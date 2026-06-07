import type { CliCommandHandler } from '../command-types.js';
import { stopDaemonWithPm2 } from '../pm2-client.js';

export const runStopCommand: CliCommandHandler = async () => {
  const result = await stopDaemonWithPm2();
  console.log(result.message);
};
