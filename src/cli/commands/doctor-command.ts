import type { CliCommandHandler } from '../command-types.js';
import { runDoctor } from '../doctor.js';
import { renderDoctorReport } from '../tui/frame.js';

type DoctorCommandInput = {
  json: boolean;
  fix: boolean;
};

export const runDoctorCommand: CliCommandHandler = async (input) => {
  const { json, fix } = input as DoctorCommandInput;
  const report = await runDoctor({ fix });

  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(renderDoctorReport(report));
};
