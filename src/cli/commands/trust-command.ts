import type { CliCommandHandler } from '../command-types.js';
import { listTrustedPaths, removeTrustedPath } from '../http-client.js';

export const runTrustCommand: CliCommandHandler = async (input) => {
  const args = Array.isArray(input) ? (input as string[]) : [];
  const subcommand = args[0];

  if (subcommand === 'list') {
    const response = (await listTrustedPaths()) as { paths?: string[] };
    const paths = response.paths ?? [];

    if (paths.length === 0) {
      console.log('No trusted paths configured.');
      return;
    }

    console.log('Trusted paths:');
    for (const p of paths) {
      console.log(`  ${p}`);
    }
    return;
  }

  if (subcommand === 'remove') {
    const targetPath = args[1];
    if (!targetPath) {
      console.error('Usage: umbra trust remove <path>');
      process.exitCode = 1;
      return;
    }

    const response = (await removeTrustedPath(targetPath)) as { removed?: string };
    console.log(`Removed: ${response.removed ?? targetPath}`);
    return;
  }

  console.log('Usage: umbra trust <list|remove <path>>');
};
