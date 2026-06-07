import { createLazyValue } from '../utils/lazy-value.js';

const loadDaemonModule = createLazyValue(async () => import('./daemon.js'));

export async function startDaemonRuntime() {
  const daemonModule = await loadDaemonModule();
  return daemonModule.startDaemon();
}
