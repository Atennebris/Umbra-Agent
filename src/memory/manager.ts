import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { buildTaskContext, compactSessionEvents } from '../context/index.js';
import type {
  MemoryCitationEntryPayload,
  MemoryCitationPayload,
  MemorySettingsPayload,
  TaskPayload,
  ThreadDetectPayload,
  ThreadImportCandidatePayload,
  ThreadImportPayload,
  ThreadListPayload,
  ThreadListQuery,
  ThreadPayload,
} from '../core/contracts.js';
import { resolveTargetProjectPath } from '../utils/project-root.js';
import { UmbraDatabase } from './database.js';
import { type TextEmbedder, TransformersTextEmbedder } from './embeddings.js';
import {
  ensureProjectRuntime,
  normalizeProjectPath,
  readAgentsRules,
  readGlobalAgentsRules,
  readProjectMemory,
  writeProjectMemory,
} from './project-files.js';
import { resolveRuntimeLayout } from './runtime-layout.js';
import {
  ensureRuntimeSettings,
  loadRuntimeSettings,
  updateRuntimeSettings,
} from './settings-store.js';

export type SessionEventType =
  | 'user_message'
  | 'assistant_message'
  | 'tool_call_started'
  | 'tool_call_finished'
  | 'tool_call_failed'
  | 'command_started'
  | 'command_finished'
  | 'patch_applied'
  | 'session_compacted'
  | 'memory_written';

export type SessionEvent<TPayload = Record<string, unknown>> = {
  id: string;
  threadId: string;
  sessionId: string;
  projectPath: string;
  timestamp: string;
  type: SessionEventType;
  payload: TPayload;
};

export type SessionRecord = {
  id: string;
  threadId: string;
  projectPath: string;
  title: string;
  filePath: string;
  createdAt: string;
  updatedAt: string;
};

export type ThreadRecord = ThreadPayload;

export type MemoryStatus = {
  runtimeHome: string;
  databasePath: string;
  sessionsCount: number;
  projectsCount: number;
  vectorBackend: 'better-sqlite3+sqlite-vec';
  embeddingBackend: 'transformers-js';
  model: string;
  modelDir: string;
  cacheDir: string;
  modelReady: boolean;
  modelLastError: string | null;
};

type TaskMemoryContext = {
  projectPath: string;
  threadId: string;
  sessionId: string;
  memorySettings: MemorySettingsPayload;
};

type RegisterTaskOptions = {
  recordUserMessage?: boolean;
  providerProfileId?: string | null;
  model?: string | null;
  useMemories?: boolean;
  generateMemories?: boolean;
};

type SimilarMemoryRecord = MemoryCitationEntryPayload & {
  content: string;
};

type FindSimilarMemoryOptions = {
  sourceTypes?: string[];
};

const COMPACTION_ALGORITHM_VERSION = 'phase2-v2';

export class MemoryManager {
  readonly #layout = resolveRuntimeLayout();
  readonly #database = new UmbraDatabase(this.#layout.databasePath);
  readonly #embedder: TextEmbedder;

  constructor(embedder: TextEmbedder = new TransformersTextEmbedder()) {
    this.#embedder = embedder;
  }

  initialize(): void {
    ensureRuntimeSettings();
    this.#embedder.startWarmup();
  }

  close(): void {
    this.#database.close();
  }

  getStatus(): MemoryStatus {
    const embedderStatus = this.#embedder.getStatus();

    return {
      runtimeHome: this.#layout.homeDir,
      databasePath: this.#layout.databasePath,
      sessionsCount: this.#database.listMetadataByNamespace<SessionRecord>('session').length,
      projectsCount: this.#database.listMetadataByNamespace('project').length,
      vectorBackend: 'better-sqlite3+sqlite-vec',
      embeddingBackend: 'transformers-js',
      model: embedderStatus.model,
      modelDir: embedderStatus.modelDir,
      cacheDir: embedderStatus.cacheDir,
      modelReady: embedderStatus.ready,
      modelLastError: embedderStatus.lastError,
    };
  }

  getMemorySettings(): MemorySettingsPayload {
    const settings = loadRuntimeSettings();
    return {
      useMemories: settings.memories.useMemories,
      generateMemories: settings.memories.generateMemories,
      draftPersistence: settings.memories.draftPersistence,
    };
  }

  updateMemorySettings(
    input: Partial<
      Pick<MemorySettingsPayload, 'useMemories' | 'generateMemories' | 'draftPersistence'>
    >,
  ): MemorySettingsPayload {
    const settings = updateRuntimeSettings((current) => ({
      ...current,
      memories: {
        ...current.memories,
        ...(typeof input.useMemories === 'boolean' ? { useMemories: input.useMemories } : {}),
        ...(typeof input.generateMemories === 'boolean'
          ? { generateMemories: input.generateMemories }
          : {}),
        ...(typeof input.draftPersistence === 'boolean'
          ? { draftPersistence: input.draftPersistence }
          : {}),
      },
    }));

    return {
      useMemories: settings.memories.useMemories,
      generateMemories: settings.memories.generateMemories,
      draftPersistence: settings.memories.draftPersistence,
    };
  }

  async registerTask(
    payload: TaskPayload,
    options: RegisterTaskOptions = {},
  ): Promise<TaskMemoryContext> {
    const projectPath = this.#resolveProjectPath(payload);
    const threadId = this.#resolveThreadId(payload);
    const sessionId = this.#resolveSessionId(payload, threadId);
    const title = payload.task.slice(0, 120);
    const sessionFilePath = path.join(this.#layout.sessionsDir, `${sessionId}.jsonl`);
    const now = new Date().toISOString();
    const projectRuntime = ensureProjectRuntime(projectPath);
    const memorySettings = this.#resolveThreadMemorySettings(threadId, {
      ...(typeof options.useMemories === 'boolean' ? { useMemories: options.useMemories } : {}),
      ...(typeof options.generateMemories === 'boolean'
        ? { generateMemories: options.generateMemories }
        : {}),
    });

    this.#database.upsertMetadata(projectPath, 'project', projectPath, {
      projectPath,
      projectKey: projectRuntime.projectKey,
      lastSeenAt: now,
      agentsPath: readAgentsRules(projectPath).path,
      memoryPath: projectRuntime.memoryPath,
    });

    const existingSession = this.getSession(sessionId, projectPath);

    this.#database.upsertMetadata(projectPath, 'session', sessionId, {
      id: sessionId,
      threadId,
      projectPath,
      title,
      filePath: sessionFilePath,
      createdAt: existingSession?.createdAt ?? now,
      updatedAt: now,
    } satisfies SessionRecord);

    this.#upsertThreadRecord(projectPath, threadId, {
      title,
      sessionId,
      providerProfileId: options.providerProfileId ?? null,
      model: options.model ?? null,
      useMemories: memorySettings.useMemories,
      generateMemories: memorySettings.generateMemories,
      updatedAt: now,
    });

    if (options.recordUserMessage ?? true) {
      this.appendEvent({
        threadId,
        sessionId,
        projectPath,
        type: 'user_message',
        payload: {
          text: payload.task,
          context: payload.context ?? {},
        },
      });
    }

    if (memorySettings.generateMemories) {
      const embedding = await this.#embedder.embedText(payload.task);

      this.#database.insertVector({
        projectKey: projectRuntime.projectKey,
        projectPath,
        sessionId,
        sourceType: 'task',
        sourceRef: threadId,
        content: payload.task,
        embedding: embedding.values,
        model: embedding.model,
      });
    }

    return {
      projectPath,
      threadId,
      sessionId,
      memorySettings,
    };
  }

  appendEvent<TPayload extends Record<string, unknown>>(input: {
    threadId?: string;
    sessionId: string;
    projectPath: string;
    type: SessionEventType;
    payload: TPayload;
  }): SessionEvent<TPayload> {
    const threadId = input.threadId ?? input.sessionId;
    const event: SessionEvent<TPayload> = {
      id: randomUUID(),
      threadId,
      sessionId: input.sessionId,
      projectPath: input.projectPath,
      timestamp: new Date().toISOString(),
      type: input.type,
      payload: input.payload,
    };

    fs.appendFileSync(
      path.join(this.#layout.sessionsDir, `${input.sessionId}.jsonl`),
      `${JSON.stringify(event)}\n`,
      'utf8',
    );

    const session = this.getSession(input.sessionId, input.projectPath);

    if (session) {
      this.#database.upsertMetadata(input.projectPath, 'session', input.sessionId, {
        ...session,
        updatedAt: event.timestamp,
      } satisfies SessionRecord);
    }

    this.#touchThreadRecord(input.projectPath, threadId, event);
    return event;
  }

  getSession(sessionId: string, projectPath: string): SessionRecord | null {
    const record = this.#database.getMetadata<SessionRecord>(projectPath, 'session', sessionId);
    return record?.value ?? null;
  }

  listSessions(projectPath?: string): SessionRecord[] {
    return this.#database
      .listMetadataByNamespace<SessionRecord>('session', projectPath)
      .map((record) => record.value);
  }

  readSessionEvents(sessionId: string): SessionEvent[] {
    const sessionPath = path.join(this.#layout.sessionsDir, `${sessionId}.jsonl`);

    if (!fs.existsSync(sessionPath)) {
      return [];
    }

    return fs
      .readFileSync(sessionPath, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as SessionEvent);
  }

  getProjectContext(projectPath: string): {
    projectPath: string;
    memory: string;
    agentsRules: ReturnType<typeof readAgentsRules>;
    globalAgentsRules: ReturnType<typeof readGlobalAgentsRules>;
  } {
    const normalizedProjectPath = normalizeProjectPath(projectPath);
    ensureProjectRuntime(normalizedProjectPath);

    return {
      projectPath: normalizedProjectPath,
      memory: readProjectMemory(normalizedProjectPath),
      agentsRules: readAgentsRules(normalizedProjectPath),
      globalAgentsRules: readGlobalAgentsRules(),
    };
  }

  getThread(threadId: string, projectPath?: string): ThreadRecord | null {
    const records = this.#database.listMetadataByNamespace<ThreadRecord>('thread', projectPath);
    const match = records.find((record) => record.key === threadId || record.value.id === threadId);
    return match?.value ?? null;
  }

  listThreads(query: ThreadListQuery = {}): ThreadListPayload {
    const threads = this.#database
      .listMetadataByNamespace<ThreadRecord>('thread', query.projectPath)
      .map((record) => record.value)
      .filter((thread) =>
        typeof query.archived === 'boolean' ? thread.archived === query.archived : true,
      )
      .filter((thread) =>
        query.searchTerm
          ? [thread.title, thread.summaryPreview ?? '', thread.id]
              .join('\n')
              .toLowerCase()
              .includes(query.searchTerm.toLowerCase())
          : true,
      )
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

    const offset = query.cursor ? Number.parseInt(query.cursor, 10) || 0 : 0;
    const limit = Math.max(1, Math.min(query.limit ?? 20, 100));
    const slice = threads.slice(offset, offset + limit);
    const nextCursor = offset + limit < threads.length ? String(offset + limit) : null;

    return {
      threads: slice,
      nextCursor,
    };
  }

  createThread(input: {
    projectPath: string;
    title?: string;
    useMemories?: boolean;
    generateMemories?: boolean;
  }): ThreadRecord {
    const projectPath = normalizeProjectPath(resolveTargetProjectPath(input.projectPath));
    const now = new Date().toISOString();
    const threadId = randomUUID();
    const sessionId = threadId;
    this.#upsertThreadRecord(projectPath, threadId, {
      sessionId,
      title: input.title?.trim() || 'Untitled thread',
      providerProfileId: null,
      model: null,
      useMemories: input.useMemories ?? this.getMemorySettings().useMemories,
      generateMemories: input.generateMemories ?? this.getMemorySettings().generateMemories,
      updatedAt: now,
      createdAt: now,
    });
    this.#database.upsertMetadata(projectPath, 'session', sessionId, {
      id: sessionId,
      threadId,
      projectPath,
      title: input.title?.trim() || 'Untitled thread',
      filePath: path.join(this.#layout.sessionsDir, `${sessionId}.jsonl`),
      createdAt: now,
      updatedAt: now,
    } satisfies SessionRecord);

    return this.#requireThread(threadId, projectPath);
  }

  archiveThread(threadId: string, archived: boolean): ThreadRecord {
    const thread = this.#requireThread(threadId);
    this.#upsertThreadRecord(thread.projectPath, threadId, {
      ...thread,
      archived,
      updatedAt: new Date().toISOString(),
    });
    return this.#requireThread(threadId, thread.projectPath);
  }

  updateThreadModelState(input: {
    projectPath: string;
    threadId: string;
    providerProfileId: string | null;
    model: string | null;
  }): ThreadRecord {
    const thread = this.#requireThread(input.threadId, input.projectPath);
    this.#upsertThreadRecord(input.projectPath, input.threadId, {
      ...thread,
      providerProfileId: input.providerProfileId,
      model: input.model,
      updatedAt: new Date().toISOString(),
    });
    return this.#requireThread(input.threadId, input.projectPath);
  }

  updateThreadSettings(input: {
    threadId: string;
    projectPath?: string;
    useMemories?: boolean;
    generateMemories?: boolean;
  }): ThreadRecord {
    const thread = this.#requireThread(input.threadId, input.projectPath);
    this.#upsertThreadRecord(thread.projectPath, thread.id, {
      ...thread,
      useMemories: input.useMemories ?? thread.useMemories,
      generateMemories: input.generateMemories ?? thread.generateMemories,
      updatedAt: new Date().toISOString(),
    });
    return this.#requireThread(thread.id, thread.projectPath);
  }

  forkThread(threadId: string, input: { projectPath?: string; title?: string } = {}): ThreadRecord {
    const source = this.#requireThread(threadId);
    const nextProjectPath = normalizeProjectPath(
      resolveTargetProjectPath(input.projectPath ?? source.projectPath),
    );
    const forked = this.createThread({
      projectPath: nextProjectPath,
      title: input.title?.trim() || `${source.title} (fork)`,
      useMemories: source.useMemories,
      generateMemories: source.generateMemories,
    });
    const sourceEvents = this.readSessionEvents(source.sessionId);

    for (const event of sourceEvents) {
      this.appendEvent({
        threadId: forked.id,
        sessionId: forked.sessionId,
        projectPath: forked.projectPath,
        type: event.type,
        payload: event.payload,
      });
    }

    return this.#requireThread(forked.id, forked.projectPath);
  }

  async findSimilarMemories(
    projectPath: string,
    query: string,
    limit = 5,
    options: FindSimilarMemoryOptions = {},
  ): Promise<SimilarMemoryRecord[]> {
    const normalizedProjectPath = normalizeProjectPath(projectPath);
    const projectRuntime = ensureProjectRuntime(normalizedProjectPath);
    const queryEmbedding = await this.#embedder.embedText(query);
    const searchLimit = options.sourceTypes ? Math.max(limit * 4, 20) : limit;
    const matches = this.#database.searchVectors(
      projectRuntime.projectKey,
      queryEmbedding.values,
      searchLimit,
    );
    const records = this.#database.listVectorsByRowIds(matches.map((match) => match.rowid));
    const recordsByRowId = new Map(records.map((record) => [record.rowid, record]));
    const allowedSourceTypes = options.sourceTypes ? new Set(options.sourceTypes) : null;

    return matches
      .map((match): SimilarMemoryRecord | null => {
        const record = recordsByRowId.get(match.rowid);

        if (!record) {
          return null;
        }

        if (allowedSourceTypes && !allowedSourceTypes.has(record.sourceType)) {
          return null;
        }

        return {
          memoryId: record.id,
          sourceType: record.sourceType,
          sessionId: record.sessionId,
          projectPath: record.projectPath,
          createdAt: record.createdAt,
          score: 1 / (1 + match.distance),
          excerpt: record.content.slice(0, 220),
          content: record.content,
        } satisfies SimilarMemoryRecord;
      })
      .filter((value): value is SimilarMemoryRecord => value !== null)
      .slice(0, limit);
  }

  async buildContextSummary(input: {
    projectPath: string;
    task: string;
    threadId?: string;
    sessionId?: string;
    budgetTokens?: number;
    useMemories?: boolean;
  }) {
    const context = this.getProjectContext(input.projectPath);
    const thread = input.threadId ? this.getThread(input.threadId, input.projectPath) : null;
    const settings = this.#resolveThreadMemorySettings(input.threadId ?? null, {
      ...(typeof input.useMemories === 'boolean' ? { useMemories: input.useMemories } : {}),
    });
    const similarMemories = settings.useMemories
      ? await this.findSimilarMemories(input.projectPath, input.task, 5, {
          sourceTypes: ['session_compaction'],
        })
      : [];
    const sessionEvents = input.sessionId ? this.readSessionEvents(input.sessionId) : [];
    const result = await buildTaskContext({
      projectPath: input.projectPath,
      task: input.task,
      memory: settings.useMemories ? context.memory : '',
      agentsRules: context.agentsRules.rules,
      similarMemories: similarMemories.map((memory) => ({
        id: memory.memoryId,
        content: formatMemoryForPrompt(memory),
        score: memory.score ?? 0,
        sessionId: memory.sessionId,
      })),
      sessionEvents,
      ...(input.budgetTokens !== undefined ? { budgetTokens: input.budgetTokens } : {}),
    });

    return {
      ...result,
      memoryCitation: {
        threadId: thread?.id ?? input.threadId ?? null,
        entries: similarMemories.map((memory) => ({
          memoryId: memory.memoryId,
          sourceType: memory.sourceType,
          sessionId: memory.sessionId,
          projectPath: memory.projectPath,
          createdAt: memory.createdAt,
          score: memory.score,
          excerpt: memory.excerpt,
        })),
        projectMemoryUsed: settings.useMemories && context.memory.trim().length > 0,
        sessionSummaryUsed: result.sessionSummary !== null,
      } satisfies MemoryCitationPayload,
    };
  }

  compactSession(input: {
    sessionId: string;
    projectPath?: string;
    instructions?: string;
    /** Optional LLM-generated summary that overrides the algorithmic one. */
    overrideSummary?: string;
  }): {
    sessionId: string;
    projectPath: string;
    summary: string;
    oldTokens: number;
    newTokens: number;
    compactedEventCount: number;
    recentEventCount: number;
  } {
    const session = this.listSessions().find((record) => record.id === input.sessionId);

    if (!session && !input.projectPath) {
      throw new Error(`Session "${input.sessionId}" was not found.`);
    }

    const projectPath = input.projectPath ?? session?.projectPath;

    if (!projectPath) {
      throw new Error(`Project path for session "${input.sessionId}" is unavailable.`);
    }

    const threadId = session?.threadId ?? input.sessionId;
    const events = this.readSessionEvents(input.sessionId);
    const compaction = compactSessionEvents(events, {
      ...(input.instructions ? { instructions: input.instructions } : {}),
    });
    // Use LLM-generated summary when provided, otherwise keep the algorithmic one
    const finalSummary = input.overrideSummary ?? compaction.summary;

    this.appendEvent({
      threadId,
      sessionId: input.sessionId,
      projectPath,
      type: 'session_compacted',
      payload: {
        summary: finalSummary,
        oldTokens: compaction.oldTokens,
        newTokens: compaction.newTokens,
        compactedEventCount: compaction.compactedEventCount,
        recentEventCount: compaction.recentEventCount,
        instructions: input.instructions ?? null,
        algorithmVersion: COMPACTION_ALGORITHM_VERSION,
        ...(input.overrideSummary ? { summarySource: 'llm' } : { summarySource: 'algorithmic' }),
      },
    });

    const thread = this.getThread(threadId, projectPath);
    const settings = this.#resolveThreadMemorySettings(threadId, {});

    if (settings.generateMemories) {
      const projectRuntime = ensureProjectRuntime(projectPath);
      const embedding = this.#embedder.getStatus().ready ? null : null;
      void embedding;
      this.#writeCompactionMemory(
        projectRuntime.projectKey,
        projectPath,
        input.sessionId,
        threadId,
        finalSummary,
      );
    }

    this.#upsertThreadRecord(projectPath, threadId, {
      ...(thread ?? this.createThread({ projectPath, title: session?.title ?? 'Thread' })),
      id: threadId,
      sessionId: input.sessionId,
      projectPath,
      cwd: projectPath,
      title: thread?.title ?? session?.title ?? 'Thread',
      archived: thread?.archived ?? false,
      summaryPreview: finalSummary.slice(0, 280),
      providerProfileId: thread?.providerProfileId ?? null,
      model: thread?.model ?? null,
      useMemories: settings.useMemories,
      generateMemories: settings.generateMemories,
      draftPath: this.getDraftPath(threadId),
      exportedSessionPath: thread?.exportedSessionPath ?? null,
      createdAt: thread?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastCompactionAt: new Date().toISOString(),
      eventCount: events.length + 1,
    });

    return {
      sessionId: input.sessionId,
      projectPath,
      summary: finalSummary,
      oldTokens: compaction.oldTokens,
      newTokens: compaction.newTokens,
      compactedEventCount: compaction.compactedEventCount,
      recentEventCount: compaction.recentEventCount,
    };
  }

  exportThread(threadId: string): { thread: ThreadRecord; exportPath: string } {
    const thread = this.#requireThread(threadId);
    const exportPath = path.join(this.#layout.exportsDir, `${threadId}.session.jsonl`);
    const sourcePath = path.join(this.#layout.sessionsDir, `${thread.sessionId}.jsonl`);

    // Touch the source file if it doesn't exist yet (thread was created but no events appended)
    if (!fs.existsSync(sourcePath)) {
      fs.writeFileSync(sourcePath, '', 'utf8');
    }

    fs.copyFileSync(sourcePath, exportPath);
    const updated = this.#upsertThreadRecord(thread.projectPath, threadId, {
      ...thread,
      exportedSessionPath: exportPath,
      updatedAt: new Date().toISOString(),
    });
    return {
      thread: updated,
      exportPath,
    };
  }

  detectImportableSessions(input: ThreadDetectPayload = {}): ThreadImportCandidatePayload[] {
    const roots = input.paths?.length ? input.paths : [this.#layout.homeDir];
    const candidates: ThreadImportCandidatePayload[] = [];

    for (const root of roots) {
      for (const filePath of scanJsonlFiles(root)) {
        candidates.push({
          filePath,
          fileName: path.basename(filePath),
        });
      }
    }

    return candidates;
  }

  importThread(input: ThreadImportPayload): ThreadRecord {
    const resolvedPath = path.resolve(input.filePath);

    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`Import file "${resolvedPath}" was not found.`);
    }

    const projectPath = normalizeProjectPath(
      resolveTargetProjectPath(input.projectPath ?? process.cwd()),
    );
    const thread = this.createThread({
      projectPath,
      title: input.title?.trim() || path.basename(resolvedPath),
    });
    const lines = fs.readFileSync(resolvedPath, 'utf8').split(/\r?\n/).filter(Boolean);

    for (const line of lines) {
      const event = parseImportedEvent(line, thread);

      if (!event) {
        continue;
      }

      this.appendEvent({
        threadId: thread.id,
        sessionId: thread.sessionId,
        projectPath: thread.projectPath,
        type: event.type,
        payload: event.payload,
      });
    }

    if (input.archived) {
      return this.archiveThread(thread.id, true);
    }

    return this.#requireThread(thread.id, thread.projectPath);
  }

  resetMemories(input: { projectPath?: string; threadId?: string } = {}): {
    clearedVectors: number;
    clearedProjectMemory: boolean;
    threadId: string | null;
  } {
    const projectPath =
      input.projectPath ??
      (input.threadId ? this.#requireThread(input.threadId).projectPath : null) ??
      null;

    if (!projectPath) {
      throw new Error('reset memories requires projectPath or threadId.');
    }

    writeProjectMemory(projectPath, '');
    const thread = input.threadId ? this.#requireThread(input.threadId, projectPath) : null;
    const clearedVectors = this.#database.deleteVectors(projectPath, thread?.sessionId ?? null);

    if (thread) {
      this.#upsertThreadRecord(projectPath, thread.id, {
        ...thread,
        summaryPreview: null,
        lastCompactionAt: null,
        updatedAt: new Date().toISOString(),
      });
    }

    return {
      clearedVectors,
      clearedProjectMemory: true,
      threadId: thread?.id ?? null,
    };
  }

  saveDraft(threadId: string, value: string): string {
    const draftPath = this.getDraftPath(threadId);

    if (value.length === 0) {
      if (fs.existsSync(draftPath)) {
        fs.rmSync(draftPath, { force: true });
      }
      return draftPath;
    }

    fs.writeFileSync(draftPath, value, 'utf8');
    return draftPath;
  }

  loadDraft(threadId: string): string {
    const draftPath = this.getDraftPath(threadId);
    return fs.existsSync(draftPath) ? fs.readFileSync(draftPath, 'utf8') : '';
  }

  clearDraft(threadId: string): void {
    const draftPath = this.getDraftPath(threadId);

    if (fs.existsSync(draftPath)) {
      fs.rmSync(draftPath, { force: true });
    }
  }

  getDraftPath(threadId: string): string {
    return path.join(this.#layout.draftsDir, `${threadId}.txt`);
  }

  getRuntimeLayout() {
    return this.#layout;
  }

  #resolveProjectPath(payload: TaskPayload): string {
    const context = isRecord(payload.context) ? payload.context : {};
    const candidate = typeof context.projectPath === 'string' ? context.projectPath : null;
    return normalizeProjectPath(resolveTargetProjectPath(candidate ?? undefined));
  }

  #resolveThreadId(payload: TaskPayload): string {
    const context = isRecord(payload.context) ? payload.context : {};
    const threadId = typeof context.threadId === 'string' ? context.threadId : null;
    const sessionId = typeof context.sessionId === 'string' ? context.sessionId : null;
    return threadId ?? sessionId ?? randomUUID();
  }

  #resolveSessionId(payload: TaskPayload, fallbackThreadId: string): string {
    const context = isRecord(payload.context) ? payload.context : {};
    const sessionId = typeof context.sessionId === 'string' ? context.sessionId : null;
    return sessionId ?? fallbackThreadId;
  }

  #resolveThreadMemorySettings(
    threadId: string | null,
    overrides: {
      useMemories?: boolean;
      generateMemories?: boolean;
    },
  ): MemorySettingsPayload {
    const base = this.getMemorySettings();
    const thread = threadId ? this.getThread(threadId) : null;

    return {
      useMemories: overrides.useMemories ?? thread?.useMemories ?? base.useMemories,
      generateMemories:
        overrides.generateMemories ?? thread?.generateMemories ?? base.generateMemories,
      draftPersistence: base.draftPersistence,
    };
  }

  #requireThread(threadId: string, projectPath?: string): ThreadRecord {
    const thread = this.getThread(threadId, projectPath);

    if (!thread) {
      throw new Error(`Thread "${threadId}" was not found.`);
    }

    return thread;
  }

  #touchThreadRecord(projectPath: string, threadId: string, event: SessionEvent): void {
    const current = this.getThread(threadId, projectPath);

    if (!current) {
      return;
    }

    this.#upsertThreadRecord(projectPath, threadId, {
      ...current,
      updatedAt: event.timestamp,
      eventCount: current.eventCount + 1,
      summaryPreview:
        event.type === 'assistant_message' && typeof event.payload.text === 'string'
          ? event.payload.text.slice(0, 280)
          : current.summaryPreview,
    });
  }

  #upsertThreadRecord(
    projectPath: string,
    threadId: string,
    patch: Partial<ThreadRecord> & {
      title: string;
      sessionId: string;
      providerProfileId: string | null;
      model: string | null;
      useMemories: boolean;
      generateMemories: boolean;
      updatedAt: string;
    },
  ): ThreadRecord {
    const current = this.getThread(threadId, projectPath);
    const nextRecord: ThreadRecord = {
      id: threadId,
      sessionId: patch.sessionId,
      projectPath,
      cwd: projectPath,
      title: patch.title,
      archived: patch.archived ?? current?.archived ?? false,
      summaryPreview: patch.summaryPreview ?? current?.summaryPreview ?? null,
      providerProfileId: patch.providerProfileId,
      model: patch.model,
      useMemories: patch.useMemories,
      generateMemories: patch.generateMemories,
      draftPath: patch.draftPath ?? current?.draftPath ?? this.getDraftPath(threadId),
      exportedSessionPath: patch.exportedSessionPath ?? current?.exportedSessionPath ?? null,
      createdAt: patch.createdAt ?? current?.createdAt ?? patch.updatedAt,
      updatedAt: patch.updatedAt,
      lastCompactionAt: patch.lastCompactionAt ?? current?.lastCompactionAt ?? null,
      eventCount: patch.eventCount ?? current?.eventCount ?? 0,
    };

    this.#database.upsertMetadata(projectPath, 'thread', threadId, nextRecord);
    return nextRecord;
  }

  async #writeCompactionMemory(
    projectKey: string,
    projectPath: string,
    sessionId: string,
    threadId: string,
    summary: string,
  ): Promise<void> {
    const embedding = await this.#embedder.embedText(summary);

    this.#database.insertVector({
      projectKey,
      projectPath,
      sessionId,
      sourceType: 'session_compaction',
      sourceRef: threadId,
      content: summary,
      embedding: embedding.values,
      model: embedding.model,
    });

    this.appendEvent({
      threadId,
      sessionId,
      projectPath,
      type: 'memory_written',
      payload: {
        sourceType: 'session_compaction',
        sourceRef: threadId,
        algorithmVersion: COMPACTION_ALGORITHM_VERSION,
      },
    });
  }
}

function formatMemoryForPrompt(memory: SimilarMemoryRecord): string {
  const score = memory.score === null ? 'n/a' : memory.score.toFixed(3);
  return `[memory ${memory.memoryId}] score=${score} source=${memory.sourceType} session=${
    memory.sessionId ?? 'none'
  } created=${memory.createdAt}\n${memory.content}`;
}

function parseImportedEvent(
  line: string,
  thread: ThreadRecord,
): { type: SessionEventType; payload: Record<string, unknown> } | null {
  try {
    const parsed = JSON.parse(line) as unknown;

    if (isRecord(parsed) && typeof parsed.type === 'string' && isRecord(parsed.payload)) {
      const type = parsed.type as SessionEventType;

      if (isKnownSessionEventType(type)) {
        return {
          type,
          payload: parsed.payload,
        };
      }
    }

    if (
      isRecord(parsed) &&
      typeof parsed.role === 'string' &&
      (typeof parsed.content === 'string' || parsed.content === null)
    ) {
      return {
        type: parsed.role === 'assistant' ? 'assistant_message' : 'user_message',
        payload: {
          text: parsed.content ?? '',
          importedFrom: thread.id,
        },
      };
    }
  } catch {}

  return null;
}

function scanJsonlFiles(rootPath: string): string[] {
  const resolvedRoot = path.resolve(rootPath);

  if (!fs.existsSync(resolvedRoot)) {
    return [];
  }

  const stat = fs.statSync(resolvedRoot);

  if (stat.isFile()) {
    return resolvedRoot.toLowerCase().endsWith('.jsonl') ? [resolvedRoot] : [];
  }

  const results: string[] = [];
  const stack = [resolvedRoot];

  while (stack.length > 0) {
    const current = stack.pop();

    if (!current) {
      continue;
    }

    const entries = fs.readdirSync(current, { withFileTypes: true });

    for (const entry of entries) {
      const nextPath = path.join(current, entry.name);

      if (entry.isDirectory()) {
        stack.push(nextPath);
        continue;
      }

      if (entry.isFile() && nextPath.toLowerCase().endsWith('.jsonl')) {
        results.push(nextPath);
      }
    }
  }

  return results;
}

function isKnownSessionEventType(value: string): value is SessionEventType {
  return [
    'user_message',
    'assistant_message',
    'tool_call_started',
    'tool_call_finished',
    'tool_call_failed',
    'command_started',
    'command_finished',
    'patch_applied',
    'session_compacted',
    'memory_written',
  ].includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
