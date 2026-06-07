import { resolveTargetProjectPath } from '../../utils/project-root.js';
import type { CliCommandHandler } from '../command-types.js';
import { postTask } from '../http-client.js';
import { renderKeyValueCard } from '../tui/frame.js';

type TaskAddCommandInput = {
  taskText: string;
  json: boolean;
  source?: string;
  projectPath?: string;
};

export const runTaskAddCommand: CliCommandHandler = async (input) => {
  const { taskText, json, source, projectPath } = input as TaskAddCommandInput;
  const targetProjectPath = resolveTargetProjectPath(projectPath);

  if (!taskText) {
    throw new Error('Task text is required.');
  }

  const payload = await postTask({
    task: taskText,
    context: {
      ...(source ? { source } : {}),
      projectPath: targetProjectPath,
    },
  });

  if (json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  const taskRecord = payload as Record<string, unknown>;

  console.log(
    renderKeyValueCard('Task Accepted', [
      ['ID', String(taskRecord.id ?? 'unknown')],
      ['Task', String(taskRecord.task ?? taskText)],
      ['Status', String(taskRecord.status ?? 'accepted')],
      ['Session', String(taskRecord.sessionId ?? 'unknown')],
      ['Received', String(taskRecord.receivedAt ?? 'unknown')],
    ]),
  );
};
