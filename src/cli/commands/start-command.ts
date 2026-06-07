import type { CliCommandHandler } from '../command-types.js';
import { ensureDaemonWithPm2 } from '../pm2-client.js';

export const runStartCommand: CliCommandHandler = async () => {
  const result = await ensureDaemonWithPm2();
  console.log(result.message);
};
