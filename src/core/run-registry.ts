import { randomUUID } from 'node:crypto';
import { resolveTargetProjectPath } from '../utils/project-root.js';
import type { AgentRuntime } from './agent-runtime.js';
import type { RunEvent, RunStatus, RunTaskPayload, RunTaskRequest } from './contracts.js';
import { type PermissionOutcome, getPermissionManager } from './permissions.js';

type PendingApproval = {
  resolve: (outcome: PermissionOutcome) => void;
};

type RunState = {
  task: RunTaskPayload;
  request: RunTaskRequest;
  abortController: AbortController;
  timer: NodeJS.Timeout | null;
};

export class RunRegistry {
  readonly #runtime: AgentRuntime;
  readonly #runs = new Map<string, RunState>();
  readonly #pendingApprovals = new Map<string, PendingApproval>();

  constructor(runtime: AgentRuntime) {
    this.#runtime = runtime;
  }

  /**
   * Called from the agent loop when a tool needs interactive approval.
   * Adds a `permission_requested` event to the run and suspends until
   * `resolveApproval` is called (by the TUI via the HTTP endpoint).
   */
  requestApproval(
    runId: string,
    approvalId: string,
    toolName: string,
    summary: string,
  ): Promise<PermissionOutcome> {
    const state = this.#runs.get(runId);
    if (state) {
      state.task.events.push(
        makeRunEvent('permission_requested', { approvalId, toolName, summary, pending: true }),
      );
    }
    return new Promise<PermissionOutcome>((resolve) => {
      this.#pendingApprovals.set(approvalId, { resolve });
    });
  }

  /**
   * Called by the HTTP endpoint when the user responds to a permission dialog.
   */
  resolveApproval(approvalId: string, outcome: PermissionOutcome): boolean {
    const pending = this.#pendingApprovals.get(approvalId);
    if (!pending) return false;
    this.#pendingApprovals.delete(approvalId);
    pending.resolve(outcome);
    return true;
  }

  create(request: RunTaskRequest): RunTaskPayload {
    const projectPath = resolveTargetProjectPath(request.projectPath);

    // Automatically trust the initial project path
    getPermissionManager().trustManager.addTrustedPath(projectPath);

    const threadId = request.threadId ?? request.sessionId ?? randomUUID();
    const sessionId = request.sessionId ?? threadId;
    const normalizedRequest: RunTaskRequest = {
      ...request,
      projectPath,
      threadId,
      sessionId,
    };
    const now = new Date().toISOString();
    const task: RunTaskPayload = {
      id: randomUUID(),
      prompt: normalizedRequest.prompt,
      mode: normalizedRequest.mode,
      status: 'queued',
      projectPath,
      threadId,
      sessionId,
      providerProfileId: normalizedRequest.providerProfileId ?? null,
      model: normalizedRequest.model ?? null,
      createdAt: now,
      startedAt: null,
      finishedAt: null,
      timeLimitMs: normalizedRequest.timeLimitMs ?? null,
      attempt: 0,
      lastError: null,
      events: [],
      result: null,
    };

    this.#runs.set(task.id, {
      task,
      request: normalizedRequest,
      abortController: new AbortController(),
      timer: null,
    });
    return cloneRun(task);
  }

  list(): RunTaskPayload[] {
    return [...this.#runs.values()].map((entry) => cloneRun(entry.task));
  }

  get(runId: string): RunTaskPayload | null {
    const state = this.#runs.get(runId);
    return state ? cloneRun(state.task) : null;
  }

  async start(runId: string): Promise<RunTaskPayload> {
    const state = this.#requireRun(runId);

    if (state.task.status === 'running') {
      return cloneRun(state.task);
    }

    state.task.status = 'running';
    state.task.startedAt = new Date().toISOString();
    state.task.finishedAt = null;
    state.task.attempt += 1;
    state.task.lastError = null;
    state.task.result = null;
    state.task.events.push(makeRunEvent('status', { status: 'running' }));

    if (state.request.timeLimitMs) {
      state.timer = setTimeout(() => {
        state.abortController.abort('time_limit');
      }, state.request.timeLimitMs);
    }

    void this.#runtime
      .executeRun(state.request, {
        appendEvent: (event) => {
          state.task.events.push(makeRunEvent(event.type, event.payload));
        },
        setSummary: (patch) => {
          state.task = {
            ...state.task,
            ...patch,
          };
        },
        isStopped: () => state.abortController.signal.aborted,
        ensureActive: () => {
          if (state.abortController.signal.aborted) {
            throw new Error(
              state.abortController.signal.reason === 'time_limit'
                ? 'Run time limit exceeded.'
                : 'Run stopped.',
            );
          }
        },
        getAbortSignal: () => state.abortController.signal,
        requestApproval: (approvalId, toolName, summary) =>
          this.requestApproval(runId, approvalId, toolName, summary),
      })
      .then((result) => {
        state.task.result = result;
        state.task.status = 'completed';
        state.task.finishedAt = new Date().toISOString();
        state.task.events.push(makeRunEvent('status', { status: 'completed' }));
      })
      .catch((error: unknown) => {
        const isAborted = state.abortController.signal.aborted;
        const message = error instanceof Error ? error.message : String(error);
        state.task.lastError = isAborted ? null : message;
        state.task.finishedAt = new Date().toISOString();
        state.task.status =
          state.abortController.signal.reason === 'time_limit'
            ? 'timed_out'
            : isAborted
              ? 'stopped'
              : 'failed';
        state.task.events.push(
          makeRunEvent(state.task.status === 'failed' ? 'error' : 'status', {
            status: state.task.status,
            error: message,
          }),
        );
      })
      .finally(() => {
        if (state.timer) {
          clearTimeout(state.timer);
          state.timer = null;
        }
      });

    return cloneRun(state.task);
  }

  stop(runId: string): RunTaskPayload {
    const state = this.#requireRun(runId);

    if (!state.abortController.signal.aborted && state.task.status === 'running') {
      state.abortController.abort('stopped');
    }

    return cloneRun(state.task);
  }

  async restart(runId: string): Promise<RunTaskPayload> {
    const state = this.#requireRun(runId);

    if (!isTerminalStatus(state.task.status)) {
      throw new Error('Only finished runs can be restarted.');
    }

    state.abortController = new AbortController();
    state.task.status = 'queued';
    state.task.finishedAt = null;
    state.task.lastError = null;
    state.task.result = null;
    state.task.events.push(makeRunEvent('status', { status: 'queued', restarted: true }));
    await this.start(runId);
    return cloneRun(state.task);
  }

  #requireRun(runId: string): RunState {
    const state = this.#runs.get(runId);

    if (!state) {
      throw new Error(`Run "${runId}" was not found.`);
    }

    return state;
  }
}

function makeRunEvent(type: RunEvent['type'], payload: Record<string, unknown>): RunEvent {
  return {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    type,
    payload,
  };
}

function cloneRun(run: RunTaskPayload): RunTaskPayload {
  return {
    ...run,
    events: run.events.map((event) => ({
      ...event,
      payload: { ...event.payload },
    })),
    result: run.result
      ? {
          ...run.result,
          memoryCitation: run.result.memoryCitation
            ? {
                ...run.result.memoryCitation,
                entries: run.result.memoryCitation.entries.map((entry) => ({ ...entry })),
              }
            : null,
          check: run.result.check ? { ...run.result.check } : null,
          commit: run.result.commit ? { ...run.result.commit } : null,
        }
      : null,
  };
}

function isTerminalStatus(status: RunStatus): boolean {
  return (
    status === 'completed' || status === 'failed' || status === 'stopped' || status === 'timed_out'
  );
}
