import { createLazyValue } from '../utils/lazy-value.js';
import type { CliCommandHandler } from './command-types.js';

export type CliCommandName =
  | 'start'
  | 'stop'
  | 'status'
  | 'task:add'
  | 'init'
  | 'doctor'
  | 'debug'
  | 'tui'
  | 'exec'
  | 'providers'
  | 'permission'
  | 'context'
  | 'trust'
  | 'usage';

const commandLoaders: Record<
  CliCommandName,
  ReturnType<typeof createLazyValue<CliCommandHandler>>
> = {
  start: createLazyValue(async () => {
    const module = await import('./commands/start-command.js');
    return module.runStartCommand;
  }),
  stop: createLazyValue(async () => {
    const module = await import('./commands/stop-command.js');
    return module.runStopCommand;
  }),
  status: createLazyValue(async () => {
    const module = await import('./commands/status-command.js');
    return module.runStatusCommand;
  }),
  'task:add': createLazyValue(async () => {
    const module = await import('./commands/task-add-command.js');
    return module.runTaskAddCommand;
  }),
  init: createLazyValue(async () => {
    const module = await import('./commands/init-command.js');
    return module.runInitCommand;
  }),
  doctor: createLazyValue(async () => {
    const module = await import('./commands/doctor-command.js');
    return module.runDoctorCommand;
  }),
  debug: createLazyValue(async () => {
    const module = await import('./commands/debug-command.js');
    return module.runDebugCommand;
  }),
  tui: createLazyValue(async () => {
    const module = await import('./commands/tui-command.js');
    return module.runTuiCommand;
  }),
  exec: createLazyValue(async () => {
    const module = await import('./commands/exec-command.js');
    return module.runExecCommand;
  }),
  providers: createLazyValue(async () => {
    const module = await import('./commands/providers-command.js');
    return module.runProvidersCommand;
  }),
  permission: createLazyValue(async () => {
    const module = await import('./commands/permission-command.js');
    return module.runPermissionCommand;
  }),
  context: createLazyValue(async () => {
    const module = await import('./commands/context-command.js');
    return module.runContextCommand;
  }),
  trust: createLazyValue(async () => {
    const module = await import('./commands/trust-command.js');
    return module.runTrustCommand;
  }),
  usage: createLazyValue(async () => {
    const module = await import('./commands/usage-command.js');
    return module.runUsageCommand;
  }),
};

export async function loadCliCommand(command: CliCommandName): Promise<CliCommandHandler> {
  return commandLoaders[command]();
}
