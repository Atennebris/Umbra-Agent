import { getMemoryManager } from '../memory/index.js';
import { loadConfig } from '../utils/config.js';
import { HttpGateway } from './http-gateway.js';

export async function startDaemon(): Promise<HttpGateway> {
  const config = loadConfig();
  getMemoryManager();
  const gateway = new HttpGateway(config.daemon);

  await gateway.start();
  return gateway;
}
