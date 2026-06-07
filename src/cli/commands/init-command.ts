import path from 'node:path';
import type { CliCommandHandler } from '../command-types.js';
import { scaffoldProjectInstructions } from '../scaffold.js';

type InitCommandInput = {
  directory?: string;
  force: boolean;
};

export const runInitCommand: CliCommandHandler = async (input) => {
  const { directory, force } = input as InitCommandInput;
  const targetDir = path.resolve(directory ?? process.cwd());
  const result = await scaffoldProjectInstructions(targetDir, { force });

  console.log(result.summary);
};
