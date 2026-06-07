import { randomUUID } from 'node:crypto';
import type { TaskPayload, TaskRecord } from './contracts.js';

export class TaskQueue {
  #tasks: TaskRecord[] = [];

  enqueue(payload: TaskPayload): TaskRecord {
    const taskRecord: TaskRecord = {
      id: randomUUID(),
      task: payload.task,
      receivedAt: new Date().toISOString(),
      status: 'accepted',
    };

    if (payload.context) {
      taskRecord.context = payload.context;
    }

    this.#tasks.push(taskRecord);
    return taskRecord;
  }

  size(): number {
    return this.#tasks.length;
  }

  list(): TaskRecord[] {
    return [...this.#tasks];
  }
}
