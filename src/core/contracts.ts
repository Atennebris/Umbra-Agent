export type TaskPayload = {
  task: string;
  context?: Record<string, unknown>;
};

export type RuntimeMode = 'plan' | 'agent' | 'full' | 'exec';

export type RunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'stopped' | 'timed_out';

export type RunEventType =
  | 'status'
  | 'reasoning_delta'
  | 'assistant_delta'
  | 'assistant_message'
  | 'tool_call'
  | 'tool_result'
  | 'command'
  | 'system'
  | 'error'
  | 'permission_requested';

export type RunTaskRequest = {
  prompt: string;
  mode: RuntimeMode;
  projectPath?: string;
  threadId?: string;
  sessionId?: string;
  providerProfileId?: string;
  model?: string;
  timeLimitMs?: number;
  background?: boolean;
  useMemories?: boolean;
  generateMemories?: boolean;
  compressionLevel?: import('../utils/compression.js').CompressionLevel;
  /** Session goal injected into system prompt for mission-mode context */
  goalContext?: string | null;
  /** Extended thinking: budget_tokens (Anthropic) or effort level for OpenAI-type reasoning models. null = disabled. */
  thinkBudget?: number | 'low' | 'medium' | 'high' | 'max' | null;
  /** Whether git tools (git.status, git.diff, git.apply, git.commit, git.push, git.pull) are exposed to the agent. Default: false. */
  gitEnabled?: boolean;
};

export type RunEvent = {
  id: string;
  timestamp: string;
  type: RunEventType;
  payload: Record<string, unknown>;
};

export type RunSummary = {
  id: string;
  prompt: string;
  mode: RuntimeMode;
  status: RunStatus;
  projectPath: string;
  threadId: string | null;
  sessionId: string | null;
  providerProfileId: string | null;
  model: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  timeLimitMs: number | null;
  attempt: number;
  lastError: string | null;
};

export type RunTaskPayload = RunSummary & {
  events: RunEvent[];
  result: {
    finalText: string | null;
    finalJson: unknown | null;
    memoryCitation: MemoryCitationPayload | null;
    check: {
      command: string;
      exitCode: number;
      stdout: string;
      stderr: string;
    } | null;
    commit: {
      commitHash: string;
      message: string;
    } | null;
  } | null;
};

export type TaskRecord = TaskPayload & {
  id: string;
  receivedAt: string;
  status: 'accepted';
  projectPath?: string;
  sessionId?: string;
  contextSummary?: ContextSummary;
};

export type ContextSummary = {
  projectPath: string;
  repoFiles: number;
  repoSymbols: number;
  languages: string[];
  similarMemories: number;
  sessionSummary: string | null;
  recentEventCount: number;
  tokenReport: {
    budgetTokens: number;
    totalTokens: number;
    remainingTokens: number;
    withinBudget: boolean;
    sections: Array<{
      label: string;
      chars: number;
      tokens: number;
    }>;
  };
};

export type LastRequestUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costEstimate?: number;
  contextLimit?: number;
  contextPercent?: number;
  route?: string;
  source?: 'actual' | 'estimated' | 'mixed';
};

export type DaemonStatus = {
  ok: true;
  host: string;
  port: number;
  queueDepth: number;
  uptimeSeconds: number;
  lastRequestUsage?: LastRequestUsage;
  activeProvider: {
    id: string | null;
    label: string | null;
    model: string | null;
    capabilities?: {
      vision: boolean;
      tools: boolean;
      reasoning: boolean;
      contextWindow: number | null;
    };
  };
  webSearch: {
    mode: 'off' | 'cached' | 'live';
    providerId: string;
    configured: boolean;
  };
  memory: {
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
};

export type SessionCompactionPayload = {
  projectPath?: string;
  instructions?: string;
};

export type SessionCompactionResult = {
  sessionId: string;
  projectPath: string;
  summary: string;
  oldTokens: number;
  newTokens: number;
  compactedEventCount: number;
  recentEventCount: number;
};

export type MemorySettingsPayload = {
  useMemories: boolean;
  generateMemories: boolean;
  draftPersistence: boolean;
};

export type WebSearchProviderPayload = {
  id: string;
  label: string;
  type: 'serp-only' | 'neural' | 'crawl';
  configured: boolean;
  selected: boolean;
  baseUrl: string;
  authSource: 'env' | 'runtime' | 'default' | 'missing';
};

export type WebSearchSettingsPayload = {
  mode: 'off' | 'cached' | 'live';
  enabled: boolean;
  providerId: string;
  providerLabel: string;
  configured: boolean;
  availableProviders: WebSearchProviderPayload[];
};

export type WebSearchSettingsUpdatePayload = {
  mode?: 'off' | 'cached' | 'live';
  providerId?: string;
  providerConfig?: {
    id: string;
    apiKey?: string | null;
    baseUrl?: string | null;
  };
};

export type MemoryCitationEntryPayload = {
  memoryId: string;
  sourceType: string;
  sessionId: string | null;
  projectPath: string;
  createdAt: string;
  score: number | null;
  excerpt: string;
};

export type MemoryCitationPayload = {
  threadId: string | null;
  entries: MemoryCitationEntryPayload[];
  projectMemoryUsed: boolean;
  sessionSummaryUsed: boolean;
};

export type ThreadPayload = {
  id: string;
  sessionId: string;
  projectPath: string;
  cwd: string;
  title: string;
  archived: boolean;
  summaryPreview: string | null;
  providerProfileId: string | null;
  model: string | null;
  useMemories: boolean;
  generateMemories: boolean;
  draftPath: string | null;
  exportedSessionPath: string | null;
  createdAt: string;
  updatedAt: string;
  lastCompactionAt: string | null;
  eventCount: number;
};

export type ThreadListPayload = {
  threads: ThreadPayload[];
  nextCursor: string | null;
};

export type ThreadListQuery = {
  projectPath?: string;
  archived?: boolean;
  searchTerm?: string;
  cursor?: string;
  limit?: number;
};

export type ThreadCreatePayload = {
  projectPath?: string;
  title?: string;
  useMemories?: boolean;
  generateMemories?: boolean;
};

export type ThreadForkPayload = {
  projectPath?: string;
  title?: string;
};

export type ThreadSettingsPayload = {
  projectPath?: string;
  useMemories?: boolean;
  generateMemories?: boolean;
};

export type ThreadImportPayload = {
  filePath: string;
  projectPath?: string;
  title?: string;
  archived?: boolean;
};

export type ThreadDetectPayload = {
  paths?: string[];
};

export type ThreadImportCandidatePayload = {
  filePath: string;
  fileName: string;
};

export type ProviderTypePayload = {
  value: string;
  label: string;
  defaultUrl: string;
  needsKey: boolean;
  keyOptional: boolean;
  keyHint: string;
  cloud: boolean;
  aliases: string[];
};

export type ProviderTypeResolution = {
  requestedType: string;
  normalizedType: string;
  available: boolean;
  resolvedType: string;
  fallbackType: string | null;
  reason: string | null;
};

export type ModelCapabilitiesPayload = {
  modelId: string;
  normalizedModelId: string;
  matchedModelId: string | null;
  source: 'models.dev' | 'huggingface' | 'heuristic';
  contextWindow: number | null;
  supportsTools: boolean;
  supportsVision: boolean;
  supportsReasoning: boolean;
  supportsStructuredOutput: boolean;
  supportsAttachments: boolean;
  supportsTemperature: boolean;
  longContext: boolean;
  interleaved: 'reasoning_content' | 'reasoning_details' | null;
  inputModalities: string[];
  outputModalities: string[];
};

export type ProviderProfilePayload = {
  id: string;
  type: string;
  normalizedType: string;
  label: string;
  baseUrl: string;
  model: string | null;
  enabled: boolean;
  extraHeaders: Record<string, string>;
  options: Record<string, unknown>;
  hasApiKey: boolean;
  needsKey: boolean;
  keyOptional: boolean;
  keyHint: string;
  cloud: boolean;
  available: boolean;
  status: 'connected' | 'available' | 'unavailable';
  fallbackType: string | null;
  fallbackProfileId: string | null;
  reason: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ProviderProfilesListPayload = {
  profiles: ProviderProfilePayload[];
  defaultProfileId: string | null;
  fallbackProfileId: string | null;
  activeProfileId: string | null;
};

export type ProviderConnectionTestPayload = {
  ok: boolean;
  message: string;
};

export type ProviderModelPayload = {
  id: string;
  name: string;
  contextWindow: number | null;
  tags?: string[];
};

export type ProviderDefaultsPayload = {
  defaultProfileId: string | null;
  fallbackProfileId: string | null;
  activeProfileId: string | null;
  profiles: Array<{
    id: string;
    model: string | null;
    enabled: boolean;
  }>;
};

export type ProviderToolDefinition = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
};

export type ProviderToolCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type ProviderChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  toolCallId?: string;
  toolCalls?: ProviderToolCall[];
};

export type ProviderResponseFormat =
  | {
      type: 'text';
    }
  | {
      type: 'json_object';
    }
  | {
      type: 'json_schema';
      name: string;
      schema: Record<string, unknown>;
      strict?: boolean;
    };

export type ProviderCompleteRequest = {
  model?: string;
  messages: ProviderChatMessage[];
  temperature?: number;
  maxTokens?: number;
  tools?: ProviderToolDefinition[];
  toolChoice?: 'auto' | 'required' | 'none';
  responseFormat?: ProviderResponseFormat;
  /** Extended thinking: budget_tokens (Anthropic) or effort level (OpenAI o-series). null = disabled. */
  thinkBudget?: number | 'low' | 'medium' | 'high' | 'max' | null;
};

export type ProviderCompleteResponse = {
  providerProfileId: string;
  providerType: string;
  model: string;
  outputText: string | null;
  outputJson: unknown | null;
  toolCalls: ProviderToolCall[];
  stopReason: string | null;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
};

export type ReviewFinding = {
  title: string;
  body: string;
  confidence_score: number;
  priority?: 0 | 1 | 2 | 3 | null;
  code_location: {
    absolute_file_path: string;
    line_range: { start: number; end: number };
  };
};

export type ReviewResult = {
  findings: ReviewFinding[];
  overall_correctness: 'patch is correct' | 'patch is incorrect';
  overall_explanation: string;
  overall_confidence_score: number;
};

export type ReviewRequestPayload = {
  projectPath: string;
  /** 'uncommitted' = staged+unstaged (git diff HEAD), 'staged' = only staged (git diff --cached), or a specific file path */
  target: 'uncommitted' | 'staged' | string;
};

export type RunModeContractPayload = {
  mode: RuntimeMode;
  title: string;
  description: string;
  toolPreset: 'chat-readonly' | 'agent-default' | 'exec-full' | null;
  toolNames: string[];
  allowToolExecution: boolean;
  allowEdits: boolean;
  allowShell: boolean;
  allowGit: boolean;
  confirmationPolicy: 'none' | 'approval-required' | 'automatic-within-policy';
  responseFormat: 'text' | 'json_plan';
  timeBoxDefaultMs: number | null;
};
