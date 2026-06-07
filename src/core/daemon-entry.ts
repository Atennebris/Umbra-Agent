import { writeDebugEvent } from '../debug/runtime-debug.js';
import { startDaemonRuntime } from './daemon-runtime.js';

async function main(): Promise<void> {
  const gateway = await startDaemonRuntime();
  const address = gateway.address;

  if (typeof address === 'string' || address === null) {
    console.log('Umbra daemon started.');
    writeDebugEvent({
      component: 'daemon',
      level: 'info',
      message: 'daemon started',
    });
    return;
  }

  console.log(`Umbra daemon started on http://${address.address}:${address.port}`);
  writeDebugEvent({
    component: 'daemon',
    level: 'info',
    message: 'daemon started',
    data: {
      address: address.address,
      port: address.port,
    },
  });
}

main().catch((error: unknown) => {
  console.error('Failed to start Umbra daemon.');
  console.error(error);

  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('NODE_MODULE_VERSION') || message.includes('better_sqlite3.node')) {
    console.error('');
    console.error(
      'better-sqlite3 was compiled for a different Node.js ABI than this process. Fix:',
    );
    console.error('  1) From the Umbra repo folder run:  pnpm rebuild:natives:match-daemon');
    console.error(
      '  2) Or pass the Node.exe PM2 uses:  node scripts/rebuild-better-sqlite-for-daemon-node.mjs "C:\\\\path\\\\to\\\\node.exe"',
    );
    console.error('  3) Then:  pnpm daemon:delete  &&  umbra start');
    console.error('');
  }

  writeDebugEvent({
    component: 'daemon',
    level: 'error',
    message: 'daemon failed to start',
    data: {
      error: message,
    },
  });
  process.exitCode = 1;
});
