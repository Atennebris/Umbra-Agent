import { exec as execCallback } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { getMergedInstructions } from '../context/instruction-loader.js';
import { PACKET_TOKEN_CAP, maybeCompressSearchResult } from '../context/retrieval-packet.js';
import { SPLIT_TURN_TAIL_SIZE, applySplitTurn } from '../context/split-turn.js';
import { estimateJsonTokens } from '../context/token-estimator.js';
import { truncateForDebug, writeDebugEvent } from '../debug/runtime-debug.js';
import type { MemoryManager } from '../memory/index.js';
import type {
  ProviderCatalog,
  ProviderChatMessage,
  ProviderCompleteRequest,
  ProviderCompleteResponse,
  ProviderGateway,
  ProviderProfilePayload,
} from '../providers/index.js';
import { formatSkillsForPrompt, loadSkills } from '../skills/skill-loader.js';
import { executeToolCall } from '../tools/index.js';
import type { ToolExecuteRequest } from '../tools/runner.js';
import type { ToolExecutionResult } from '../tools/types.js';
import { gatherBootstrapContext, renderBootstrapMarkdown } from './bootstrap.js';
import type { RunEvent, RunTaskPayload, RunTaskRequest } from './contracts.js';
import { resolveRunModeContract } from './mode-contracts.js';
import type { PermissionOutcome, PermissionRequest } from './permissions.js';
import { AGENT_IDENTITY } from './prompts.js';

const execAsync = promisify(execCallback);
const MAX_EXEC_HARNESS_ATTEMPTS = 6;
const MAX_AGENT_TURNS = 40;

export type AgentRuntimeDependencies = {
  memory: MemoryManager;
  providers: ProviderCatalog;
  gateway: ProviderGateway;
  settingsLoader: () => import('../memory/settings-store.js').RuntimeSettings;
};

export type RunLifecycleHooks = {
  appendEvent(event: Omit<RunEvent, 'id' | 'timestamp'>): void;
  setSummary(patch: Partial<RunTaskPayload>): void;
  isStopped(): boolean;
  ensureActive(): void;
  /** Returns the AbortSignal for the current run (used to cancel in-flight streaming). */
  getAbortSignal?(): AbortSignal;
  /** Present an interactive permission dialog to the user in the TUI. */
  requestApproval?(
    approvalId: string,
    toolName: string,
    summary: string,
  ): Promise<PermissionOutcome>;
};

export class AgentRuntime {
  readonly #memory: MemoryManager;
  readonly #providers: ProviderCatalog;
  readonly #gateway: ProviderGateway;
  readonly #settingsLoader: () => import('../memory/settings-store.js').RuntimeSettings;

  constructor(dependencies: AgentRuntimeDependencies) {
    this.#memory = dependencies.memory;
    this.#providers = dependencies.providers;
    this.#gateway = dependencies.gateway;
    this.#settingsLoader = dependencies.settingsLoader;
  }

  async executeRun(
    request: RunTaskRequest,
    hooks: RunLifecycleHooks,
  ): Promise<NonNullable<RunTaskPayload['result']>> {
    const activeProfile = await resolveActiveProviderProfile(
      this.#providers,
      request.providerProfileId,
    );

    if (!activeProfile) {
      throw new Error('No active provider profile is configured.');
    }

    if (!activeProfile.model && !request.model) {
      throw new Error(`Provider "${activeProfile.label}" does not have a model configured.`);
    }

    const resolvedModel = request.model ?? activeProfile.model ?? null;

    const memoryContext = await this.#memory.registerTask(
      {
        task: request.prompt,
        context: {
          projectPath: request.projectPath,
          threadId: request.threadId,
          sessionId: request.sessionId,
        },
      },
      {
        recordUserMessage: false,
        providerProfileId: activeProfile.id,
        model: resolvedModel,
        ...(typeof request.useMemories === 'boolean' ? { useMemories: request.useMemories } : {}),
        ...(typeof request.generateMemories === 'boolean'
          ? { generateMemories: request.generateMemories }
          : {}),
      },
    );
    const projectContext = this.#memory.getProjectContext(memoryContext.projectPath);
    const runtimeSettings = this.#settingsLoader();
    const modeContract = resolveRunModeContract({
      mode: request.mode,
      prompt: request.prompt,
      gitEnabled: request.gitEnabled ?? false,
      webSearch:
        runtimeSettings.webSearch.mode === 'off'
          ? { enabled: false }
          : {
              enabled: true,
              mode: runtimeSettings.webSearch.mode,
            },
    });
    const contextBudget = request.mode === 'full' ? 128_000 : 32_000;

    const contextSummary = await this.#memory.buildContextSummary({
      projectPath: memoryContext.projectPath,
      task: request.prompt,
      threadId: memoryContext.threadId,
      sessionId: memoryContext.sessionId,
      useMemories: memoryContext.memorySettings.useMemories,
      budgetTokens: contextBudget,
    });
    const conversationHistory = buildConversationHistoryMessages(
      this.#memory.readSessionEvents(memoryContext.sessionId),
    );

    this.#memory.appendEvent({
      threadId: memoryContext.threadId,
      sessionId: memoryContext.sessionId,
      projectPath: memoryContext.projectPath,
      type: 'user_message',
      payload: {
        text: request.prompt,
      },
    });

    hooks.setSummary({
      projectPath: memoryContext.projectPath,
      threadId: memoryContext.threadId,
      sessionId: memoryContext.sessionId,
      providerProfileId: activeProfile.id,
      model: request.model ?? activeProfile.model,
    });
    this.#memory.updateThreadModelState({
      projectPath: memoryContext.projectPath,
      threadId: memoryContext.threadId,
      providerProfileId: activeProfile.id,
      model: resolvedModel,
    });

    const bootstrapCtx = await gatherBootstrapContext(memoryContext.projectPath);
    const bootstrapMarkdown = renderBootstrapMarkdown(bootstrapCtx);

    const hierarchicalInstructions = getMergedInstructions(memoryContext.projectPath);
    const { skills } = loadSkills({ projectPath: memoryContext.projectPath });
    const skillsText = formatSkillsForPrompt(skills);

    const messages: ProviderChatMessage[] = [
      {
        role: 'system',
        content: buildSystemPrompt({
          bootstrap: bootstrapMarkdown,
          modeInstruction: modeContract.systemInstruction,
          projectPath: memoryContext.projectPath,
          globalAgentsRules: projectContext.globalAgentsRules.raw ?? '',
          agentsRules: projectContext.agentsRules.rules.join('\n'),
          hierarchicalInstructions,
          skillsText,
          memory: memoryContext.memorySettings.useMemories ? projectContext.memory : '',
          similarMemories: contextSummary.similarMemoriesText,
          repoMapMarkdown: contextSummary.repoMapMarkdown,
          sessionSummary: contextSummary.sessionSummary,
          ...(request.goalContext != null ? { goalContext: request.goalContext } : {}),
        }),
      },
      ...conversationHistory,
      {
        role: 'user',
        content: request.prompt,
      },
    ];

    const compressionLevel =
      request.mode === 'full'
        ? 'off'
        : (request.compressionLevel ??
          (request.mode === 'exec' ? 'aggressive' : runtimeSettings.compression.level));

    const thinkBudget = request.thinkBudget ?? null;

    if (request.mode === 'plan') {
      return this.#runPlanTurn({
        profileId: activeProfile.id,
        ...(resolvedModel ? { model: resolvedModel } : {}),
        messages,
        requestOverrides: modeContract.providerRequest,
        hooks,
        threadId: memoryContext.threadId,
        sessionId: memoryContext.sessionId,
        projectPath: memoryContext.projectPath,
        memoryCitation: contextSummary.memoryCitation,
        compressionLevel,
        thinkBudget,
      });
    }

    if (request.mode === 'exec') {
      return this.#runExecLoop({
        profileId: activeProfile.id,
        ...(resolvedModel ? { model: resolvedModel } : {}),
        messages,
        hooks,
        modeContract,
        threadId: memoryContext.threadId,
        sessionId: memoryContext.sessionId,
        projectPath: memoryContext.projectPath,
        memoryCitation: contextSummary.memoryCitation,
        compressionLevel,
        prompt: request.prompt,
        thinkBudget,
      });
    }

    return this.#runAgentLoop({
      profileId: activeProfile.id,
      ...(resolvedModel ? { model: resolvedModel } : {}),
      messages,
      hooks,
      modeContract,
      threadId: memoryContext.threadId,
      sessionId: memoryContext.sessionId,
      projectPath: memoryContext.projectPath,
      memoryCitation: contextSummary.memoryCitation,
      compressionLevel,
      prompt: request.prompt,
      thinkBudget,
    });
  }

  async #buildRefreshedSystemPrompt(
    projectPath: string,
    modeInstruction: string,
    prompt: string,
    threadId: string,
    sessionId: string,
    useMemories: boolean,
  ): Promise<string> {
    const projectContext = this.#memory.getProjectContext(projectPath);
    const contextBudget = 32_000; // default for refresh

    const contextSummary = await this.#memory.buildContextSummary({
      projectPath,
      task: prompt,
      threadId,
      sessionId,
      useMemories,
      budgetTokens: contextBudget,
    });

    const bootstrapCtx = await gatherBootstrapContext(projectPath);
    const bootstrapMarkdown = renderBootstrapMarkdown(bootstrapCtx);

    const hierarchicalInstructions = getMergedInstructions(projectPath);
    const { skills } = loadSkills({ projectPath });
    const skillsText = formatSkillsForPrompt(skills);

    return buildSystemPrompt({
      bootstrap: bootstrapMarkdown,
      modeInstruction,
      projectPath,
      globalAgentsRules: projectContext.globalAgentsRules.raw ?? '',
      agentsRules: projectContext.agentsRules.rules.join('\n'),
      hierarchicalInstructions,
      skillsText,
      memory: useMemories ? projectContext.memory : '',
      similarMemories: contextSummary.similarMemoriesText,
      repoMapMarkdown: contextSummary.repoMapMarkdown,
      sessionSummary: contextSummary.sessionSummary,
    });
  }

  async #runSingleTurn(input: {
    profileId: string;
    model?: string;
    messages: ProviderChatMessage[];
    requestOverrides: Pick<ProviderCompleteRequest, 'tools' | 'toolChoice' | 'responseFormat'>;
    hooks: RunLifecycleHooks;
    threadId: string;
    sessionId: string;
    projectPath: string;
    memoryCitation: NonNullable<RunTaskPayload['result']>['memoryCitation'];
    compressionLevel: import('../utils/compression.js').CompressionLevel;
  }): Promise<NonNullable<RunTaskPayload['result']>> {
    input.hooks.ensureActive();
    input.hooks.appendEvent({
      type: 'status',
      payload: {
        phase: 'thinking',
        model: input.model ?? null,
      },
    });
    const response = await this.#gateway.complete({
      profileId: input.profileId,
      model: input.model,
      messages: input.messages,
      ...input.requestOverrides,
      threadId: input.threadId,
      sessionId: input.sessionId,
      projectPath: input.projectPath,
      compressionLevel: input.compressionLevel,
    });

    if (!response) {
      throw new Error('Provider completion is not available.');
    }

    return this.#recordAssistantResponse(response, input.hooks, {
      threadId: input.threadId,
      sessionId: input.sessionId,
      projectPath: input.projectPath,
      memoryCitation: input.memoryCitation,
    });
  }

  async #runPlanTurn(input: {
    profileId: string;
    model?: string;
    messages: ProviderChatMessage[];
    requestOverrides: Pick<ProviderCompleteRequest, 'tools' | 'toolChoice' | 'responseFormat'>;
    hooks: RunLifecycleHooks;
    threadId: string;
    sessionId: string;
    projectPath: string;
    memoryCitation: NonNullable<RunTaskPayload['result']>['memoryCitation'];
    compressionLevel: import('../utils/compression.js').CompressionLevel;
    thinkBudget?: number | 'low' | 'medium' | 'high' | 'max' | null;
  }): Promise<NonNullable<RunTaskPayload['result']>> {
    input.hooks.ensureActive();
    input.hooks.appendEvent({
      type: 'status',
      payload: { phase: 'thinking', model: input.model ?? null },
    });

    const response = await this.#gateway.complete({
      profileId: input.profileId,
      model: input.model,
      messages: input.messages,
      ...input.requestOverrides,
      threadId: input.threadId,
      sessionId: input.sessionId,
      projectPath: input.projectPath,
      compressionLevel: input.compressionLevel,
      ...(input.thinkBudget ? { thinkBudget: input.thinkBudget } : {}),
    });

    if (!response) {
      throw new Error('Provider completion is not available.');
    }

    const planCall = response.toolCalls.find((c) => c.name === 'update_plan');
    const planData = planCall?.arguments ?? (response.outputJson as Record<string, unknown> | null);
    const displayText =
      response.outputText ??
      (planCall ? formatPlanAsText(planCall.arguments) : JSON.stringify(planData, null, 2));

    if (displayText) {
      input.hooks.appendEvent({
        type: 'assistant_message',
        payload: { text: displayText, stopReason: response.stopReason },
      });
      this.#memory.appendEvent({
        threadId: input.threadId,
        sessionId: input.sessionId,
        projectPath: input.projectPath,
        type: 'assistant_message',
        payload: { text: displayText, stopReason: response.stopReason },
      });
    }

    return {
      finalText: displayText,
      finalJson: planData,
      memoryCitation: input.memoryCitation,
      check: null,
      commit: null,
    };
  }

  async #runAgentLoop(input: {
    profileId: string;
    model?: string;
    messages: ProviderChatMessage[];
    hooks: RunLifecycleHooks;
    modeContract: ReturnType<typeof resolveRunModeContract>;
    threadId: string;
    sessionId: string;
    projectPath: string;
    memoryCitation: NonNullable<RunTaskPayload['result']>['memoryCitation'];
    compressionLevel: import('../utils/compression.js').CompressionLevel;
    prompt: string;
    thinkBudget?: number | 'low' | 'medium' | 'high' | 'max' | null;
  }): Promise<NonNullable<RunTaskPayload['result']>> {
    let hadFailedToolCall = false;

    for (let turn = 0; turn < MAX_AGENT_TURNS; turn += 1) {
      input.hooks.ensureActive();

      writeDebugEvent({
        component: 'runner',
        level: 'info',
        message: 'agent loop turn started',
        data: { turn, messageCount: input.messages.length },
      });

      // Split-turn: when an active tool exchange overflows, compress the prefix,
      // keep the last SPLIT_TURN_TAIL_SIZE pairs as raw context.
      const splitResult = applySplitTurn(input.messages, PAYLOAD_TOKEN_BUDGET);
      if (splitResult.splitApplied) {
        input.messages = splitResult.messages;
        input.hooks.appendEvent({
          type: 'system',
          payload: {
            text: `[Split-turn: compressed ${splitResult.compressedPairs} earlier tool call(s), kept last ${SPLIT_TURN_TAIL_SIZE} raw]`,
          },
        });
        writeDebugEvent({
          component: 'runner',
          level: 'info',
          message: 'split-turn compaction applied',
          data: { compressedPairs: splitResult.compressedPairs, turn },
        });
      }

      const { messages: slidMessages, dropped, hardStop } = slideMessageWindow(input.messages);
      if (hardStop) {
        throw new Error(
          'Context window exceeded: message payload is too large to trim. Use /compact to summarize the session.',
        );
      }
      if (dropped > 0) {
        input.hooks.appendEvent({
          type: 'system',
          payload: {
            text: `[Context window: dropped ${dropped} oldest message(s) to stay within token budget]`,
          },
        });
        writeDebugEvent({
          component: 'runner',
          level: 'warn',
          message: 'sliding window trimmed messages',
          data: { dropped, turn },
        });
      }

      const completeRequest = {
        profileId: input.profileId,
        model: input.model,
        messages: slidMessages,
        ...input.modeContract.providerRequest,
        threadId: input.threadId,
        sessionId: input.sessionId,
        projectPath: input.projectPath,
        compressionLevel: input.compressionLevel,
        ...(input.thinkBudget ? { thinkBudget: input.thinkBudget } : {}),
      };
      const response = await this.#gateway.completeStream(completeRequest, {
        onReasoningDelta: (delta) => {
          if (!delta.trim()) {
            return;
          }

          input.hooks.appendEvent({
            type: 'reasoning_delta',
            payload: {
              delta,
            },
          });
        },
        onTextDelta: (delta) => {
          if (!delta) {
            return;
          }

          input.hooks.appendEvent({
            type: 'assistant_delta',
            payload: {
              delta,
            },
          });
        },
        ...(input.hooks.getAbortSignal ? { signal: input.hooks.getAbortSignal() } : {}),
      });

      if (!response) {
        throw new Error('Provider completion is not available.');
      }

      const assistantResult = await this.#recordAssistantResponse(response, input.hooks, {
        threadId: input.threadId,
        sessionId: input.sessionId,
        projectPath: input.projectPath,
        memoryCitation: input.memoryCitation,
      });

      if (response.toolCalls.length === 0) {
        if (!response.outputText && hadFailedToolCall) {
          const fallbackText =
            '[Run ended with no further response from the model after a tool error — the task may be incomplete. Try again or rephrase your request.]';
          input.hooks.appendEvent({
            type: 'assistant_message',
            payload: { text: fallbackText, stopReason: response.stopReason },
          });
          this.#memory.appendEvent({
            threadId: input.threadId,
            sessionId: input.sessionId,
            projectPath: input.projectPath,
            type: 'assistant_message',
            payload: { text: fallbackText, stopReason: response.stopReason },
          });
          return { ...assistantResult, finalText: fallbackText };
        }
        return assistantResult;
      }

      // Drop reasoning content from earlier turns before adding this turn's —
      // only the most recent turn's reasoning is ever echoed back to the model,
      // otherwise reasoning blocks (often several thousand tokens each) pile up
      // in every subsequent request for the rest of the session.
      for (const message of input.messages) {
        if (message.role === 'assistant' && message.reasoningContent !== undefined) {
          message.reasoningContent = undefined;
        }
      }

      input.messages.push({
        role: 'assistant',
        content: response.outputText,
        toolCalls: response.toolCalls,
        ...(response.reasoningContent ? { reasoningContent: response.reasoningContent } : {}),
      });

      for (const toolCall of response.toolCalls) {
        input.hooks.ensureActive();
        input.hooks.appendEvent({
          type: 'tool_call',
          payload: {
            id: toolCall.id,
            name: toolCall.name,
            arguments: toolCall.arguments,
          },
        });
        this.#memory.appendEvent({
          threadId: input.threadId,
          sessionId: input.sessionId,
          projectPath: input.projectPath,
          type: 'tool_call_started',
          payload: {
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            arguments: toolCall.arguments,
          },
        });
        const toolResult = await this.#executeTool(
          toolCall,
          {
            preset: input.modeContract.toolPreset ?? 'chat-readonly',
            cwd: input.projectPath,
            projectPath: input.projectPath,
          },
          input.hooks,
        );

        if (toolResult.status === 'failed') {
          hadFailedToolCall = true;
        }

        if (toolCall.name === 'fs.cd' && toolResult.status === 'completed') {
          const cdOutput = toolResult.output as { newPath: string };
          if (cdOutput.newPath && cdOutput.newPath !== input.projectPath) {
            const previousPath = input.projectPath;
            input.projectPath = cdOutput.newPath;

            // Notify hooks about path change so TUI can update
            input.hooks.setSummary({ projectPath: input.projectPath });

            writeDebugEvent({
              component: 'daemon',
              level: 'info',
              message: 'project path updated',
              data: { previousPath, newPath: input.projectPath },
            });

            // Refresh context and update system prompt
            const refreshedSystemPrompt = await this.#buildRefreshedSystemPrompt(
              input.projectPath,
              input.modeContract.systemInstruction,
              input.prompt,
              input.threadId,
              input.sessionId,
              input.memoryCitation !== undefined, // simple check if memories were used
            );

            if (input.messages[0]?.role === 'system') {
              input.messages[0].content = refreshedSystemPrompt;
            }
          }
        }

        recordToolResult(this.#memory, input.hooks, toolResult, toolCall, {
          threadId: input.threadId,
          sessionId: input.sessionId,
          projectPath: input.projectPath,
        });

        // Compress large search results to context packets; raw output goes to debug log
        const packetTokenCap = PACKET_TOKEN_CAP[input.modeContract.mode] ?? 2000;
        const compressedContent = maybeCompressSearchResult(
          toolCall.name,
          toolResult as { status: string; output?: unknown },
          packetTokenCap,
        );
        if (compressedContent !== null) {
          writeDebugEvent({
            component: 'runner',
            level: 'info',
            message: 'search result compressed to context packet',
            data: { tool: toolCall.name, rawSize: JSON.stringify(toolResult.output).length },
          });
        }
        input.messages.push({
          role: 'tool',
          toolCallId: toolCall.id,
          content: compressedContent ?? JSON.stringify(toolResult),
        });
      }
    }

    const limitText = `[Run stopped after reaching the ${MAX_AGENT_TURNS}-turn safety limit. The task may be incomplete — try again or break it into smaller steps.]`;
    input.hooks.appendEvent({
      type: 'assistant_message',
      payload: { text: limitText, stopReason: 'max_turns' },
    });
    this.#memory.appendEvent({
      threadId: input.threadId,
      sessionId: input.sessionId,
      projectPath: input.projectPath,
      type: 'assistant_message',
      payload: { text: limitText, stopReason: 'max_turns' },
    });
    return {
      finalText: limitText,
      finalJson: null,
      memoryCitation: input.memoryCitation,
      check: null,
      commit: null,
    };
  }

  async #runExecLoop(input: {
    profileId: string;
    model?: string;
    messages: ProviderChatMessage[];
    hooks: RunLifecycleHooks;
    modeContract: ReturnType<typeof resolveRunModeContract>;
    threadId: string;
    sessionId: string;
    projectPath: string;
    memoryCitation: NonNullable<RunTaskPayload['result']>['memoryCitation'];
    compressionLevel: import('../utils/compression.js').CompressionLevel;
    prompt: string;
    thinkBudget?: number | 'low' | 'medium' | 'high' | 'max' | null;
  }): Promise<NonNullable<RunTaskPayload['result']>> {
    let lastAssistant: NonNullable<RunTaskPayload['result']> = {
      finalText: null,
      finalJson: null,
      memoryCitation: input.memoryCitation,
      check: null,
      commit: null,
    };
    const checkCommand = await resolveCheckCommand(input.projectPath);

    if (!checkCommand) {
      input.hooks.appendEvent({
        type: 'status',
        payload: {
          phase: 'harness_skipped',
          reason: 'No check.sh or check.ps1 found in the target project.',
        },
      });
      return this.#runAgentLoop(input);
    }

    for (let attempt = 0; attempt < MAX_EXEC_HARNESS_ATTEMPTS; attempt += 1) {
      const baseResult = await this.#runAgentLoop(input);
      lastAssistant = baseResult;
      const checkResult = await this.#runCheckCommand(input.hooks, {
        projectPath: input.projectPath,
        threadId: input.threadId,
        sessionId: input.sessionId,
        command: checkCommand,
      });

      if (checkResult.exitCode === 0) {
        const commit = await this.#autoCommitIfNeeded(input.projectPath);

        // Log completed goal to MEMORY.md
        await this.#logGoalToMemory(
          input.projectPath,
          input.prompt,
          input.threadId,
          input.sessionId,
        );

        return {
          finalText: baseResult.finalText,
          finalJson: baseResult.finalJson,
          memoryCitation: baseResult.memoryCitation,
          check: checkResult,
          commit,
        };
      }

      input.messages.push({
        role: 'user',
        content: [
          'Harness check failed.',
          `Command: ${checkResult.command}`,
          `Exit code: ${checkResult.exitCode}`,
          `stderr:\n${checkResult.stderr || '(empty)'}`,
          `stdout:\n${checkResult.stdout || '(empty)'}`,
          'Fix the failure and continue.',
        ].join('\n\n'),
      });
      input.hooks.appendEvent({
        type: 'status',
        payload: {
          phase: 'harness_retry',
          attempt: attempt + 1,
          command: checkResult.command,
          exitCode: checkResult.exitCode,
        },
      });
    }

    return {
      finalText:
        `${lastAssistant.finalText ?? ''}\n\nHarness loop stopped after repeated check failures.`.trim(),
      finalJson: lastAssistant.finalJson,
      memoryCitation: lastAssistant.memoryCitation,
      check: null,
      commit: null,
    };
  }

  async #logGoalToMemory(
    projectPath: string,
    goal: string,
    threadId: string,
    sessionId: string,
  ): Promise<void> {
    try {
      const projectContext = this.#memory.getProjectContext(projectPath);
      const timestamp = new Date().toISOString();
      const entry = `\n### [${timestamp}] Task Accomplished\n- **Goal**: ${goal}\n- **Thread**: ${threadId}\n`;

      const newMemory = projectContext.memory + entry;

      // Update MEMORY.md file via the memory layer rule
      import('../memory/project-files.js').then((m) => {
        m.writeProjectMemory(projectPath, newMemory);
      });

      this.#memory.appendEvent({
        threadId,
        sessionId,
        projectPath,
        type: 'memory_written',
        payload: {
          sourceType: 'goal_accomplished',
          goal,
        },
      });
    } catch (err) {
      writeDebugEvent({
        component: 'daemon',
        level: 'error',
        message: 'failed to log goal to memory',
        data: { error: String(err) },
      });
    }
  }

  async #executeTool(
    toolCall: ProviderCompleteResponse['toolCalls'][number],
    context: {
      preset: ToolExecuteRequest['preset'];
      cwd: string;
      projectPath: string;
    },
    hooks?: RunLifecycleHooks,
  ): Promise<ToolExecutionResult> {
    const baseRequest = {
      preset: context.preset,
      cwd: context.cwd,
      projectPath: context.projectPath,
      call: {
        name: toolCall.name,
        arguments: toolCall.arguments,
      },
    };
    if (hooks?.requestApproval) {
      const requestApproval = hooks.requestApproval;
      return executeToolCall({
        ...baseRequest,
        promptFn: async (request: PermissionRequest): Promise<PermissionOutcome> => {
          const approvalId = randomUUID();
          return requestApproval(approvalId, request.tool, request.summary ?? request.tool);
        },
      });
    }
    return executeToolCall(baseRequest);
  }

  async #runCheckCommand(
    hooks: RunLifecycleHooks,
    context: {
      projectPath: string;
      threadId: string;
      sessionId: string;
      command: string;
    },
  ): Promise<{
    command: string;
    exitCode: number;
    stdout: string;
    stderr: string;
  }> {
    const { command } = context;

    hooks.ensureActive();
    hooks.appendEvent({
      type: 'command',
      payload: {
        phase: 'started',
        command,
      },
    });
    this.#memory.appendEvent({
      threadId: context.threadId,
      sessionId: context.sessionId,
      projectPath: context.projectPath,
      type: 'command_started',
      payload: { command },
    });

    try {
      const completed = await execAsync(command, {
        cwd: context.projectPath,
        windowsHide: true,
      });
      hooks.appendEvent({
        type: 'command',
        payload: {
          phase: 'finished',
          command,
          exitCode: 0,
          stdout: completed.stdout,
          stderr: completed.stderr,
        },
      });
      this.#memory.appendEvent({
        threadId: context.threadId,
        sessionId: context.sessionId,
        projectPath: context.projectPath,
        type: 'command_finished',
        payload: {
          command,
          exitCode: 0,
          stdout: completed.stdout,
          stderr: completed.stderr,
        },
      });
      return {
        command,
        exitCode: 0,
        stdout: completed.stdout,
        stderr: completed.stderr,
      };
    } catch (error) {
      const failed = error as {
        code?: number;
        stdout?: string;
        stderr?: string;
      };
      const exitCode = typeof failed.code === 'number' ? failed.code : 1;
      const stdout = failed.stdout ?? '';
      const stderr = failed.stderr ?? String(error);
      hooks.appendEvent({
        type: 'command',
        payload: {
          phase: 'finished',
          command,
          exitCode,
          stdout,
          stderr,
        },
      });
      this.#memory.appendEvent({
        threadId: context.threadId,
        sessionId: context.sessionId,
        projectPath: context.projectPath,
        type: 'command_finished',
        payload: {
          command,
          exitCode,
          stdout,
          stderr,
        },
      });
      return {
        command,
        exitCode,
        stdout,
        stderr,
      };
    }
  }

  async #autoCommitIfNeeded(
    projectPath: string,
  ): Promise<NonNullable<RunTaskPayload['result']>['commit']> {
    const status = await executeToolCall({
      preset: 'exec-full',
      cwd: projectPath,
      projectPath,
      call: {
        name: 'git.status',
        arguments: {},
      },
    });

    if (status.status !== 'completed') {
      return null;
    }

    const entries = ((status.output as { entries?: unknown[] })?.entries ?? []) as unknown[];

    if (entries.length === 0) {
      return null;
    }

    const commit = await executeToolCall({
      preset: 'exec-full',
      cwd: projectPath,
      projectPath,
      call: {
        name: 'git.commit',
        arguments: {
          message: 'chore: exec harness success',
          all: true,
        },
      },
    });

    if (commit.status !== 'completed') {
      return null;
    }

    const output = commit.output as { commitHash: string; message: string };
    return {
      commitHash: output.commitHash,
      message: output.message,
    };
  }

  #recordAssistantResponse(
    response: ProviderCompleteResponse,
    hooks: RunLifecycleHooks,
    context: {
      threadId: string;
      sessionId: string;
      projectPath: string;
      memoryCitation: NonNullable<RunTaskPayload['result']>['memoryCitation'];
    },
  ): NonNullable<RunTaskPayload['result']> {
    if (response.outputText) {
      hooks.appendEvent({
        type: 'assistant_message',
        payload: {
          text: response.outputText,
          stopReason: response.stopReason,
        },
      });
      this.#memory.appendEvent({
        threadId: context.threadId,
        sessionId: context.sessionId,
        projectPath: context.projectPath,
        type: 'assistant_message',
        payload: {
          text: response.outputText,
          stopReason: response.stopReason,
        },
      });
    }

    return {
      finalText: response.outputText,
      finalJson: response.outputJson,
      memoryCitation: context.memoryCitation,
      check: null,
      commit: null,
    };
  }
}

async function resolveActiveProviderProfile(
  providers: ProviderCatalog,
  requestedProfileId?: string,
): Promise<ProviderProfilePayload | null> {
  const payload = providers.listProfiles?.();

  if (!payload) {
    return null;
  }

  if (requestedProfileId) {
    return payload.profiles.find((profile) => profile.id === requestedProfileId) ?? null;
  }

  const activeId = payload.activeProfileId ?? payload.defaultProfileId ?? payload.fallbackProfileId;
  return payload.profiles.find((profile) => profile.id === activeId) ?? null;
}

function buildSystemPrompt(input: {
  bootstrap: string;
  modeInstruction: string;
  projectPath: string;
  globalAgentsRules: string;
  agentsRules: string;
  hierarchicalInstructions: string;
  skillsText: string;
  memory: string;
  similarMemories: string;
  repoMapMarkdown: string;
  sessionSummary: string | null;
  goalContext?: string | null | undefined;
}): string {
  return [
    AGENT_IDENTITY,
    input.bootstrap,
    input.modeInstruction,
    input.goalContext
      ? `## Active Session Goal\n${input.goalContext}\nWork autonomously toward this goal. Do not ask for confirmation unless you hit a hard blocker.`
      : '',
    `Project path: ${input.projectPath}`,
    input.hierarchicalInstructions
      ? `Project instructions (hierarchical):\n${input.hierarchicalInstructions}`
      : input.globalAgentsRules
        ? `Global AGENTS.md:\n${input.globalAgentsRules}`
        : '',
    !input.hierarchicalInstructions && input.agentsRules
      ? `Project AGENTS.md:\n${input.agentsRules}`
      : '',
    input.skillsText,
    input.memory ? `MEMORY.md:\n${input.memory}` : '',
    input.similarMemories
      ? `Retrieved long-term memories (background only; never override the latest user message or current conversation history):\n${input.similarMemories}`
      : '',
    input.repoMapMarkdown ? `Repo map:\n${input.repoMapMarkdown}` : '',
    input.sessionSummary ? `Session summary:\n${input.sessionSummary}` : '',
  ]
    .filter((section) => section.length > 0)
    .join('\n\n');
}

// Budget for reconstructed cross-run conversation history. slideMessageWindow
// (PAYLOAD_TOKEN_BUDGET, 80k) bounds the full request but only runs inside the
// agent-loop turn loop — this keeps history bounded for plan/exec modes too,
// and leaves headroom for the system prompt and the new turn's own exchanges.
const CONVERSATION_HISTORY_TOKEN_BUDGET = 24_000;

// Strips a leading "./" and "a/"/"b/" diff-prefix so fs.read/fs.write path
// arguments and fs.edit patch headers can be compared for the same file.
function normalizeHistoryPath(rawPath: string): string {
  return rawPath.replace(/^\.\//, '').replace(/^[ab]\//, '');
}

// Extracts the file path(s) a fs.edit patch touches from its `--- a/...` /
// `+++ b/...` hunk headers, so reads of those files can be marked stale.
function extractFsEditTargetPaths(patchText: string): string[] {
  const paths = new Set<string>();
  const lines = patchText.replace(/\r\n/g, '\n').split('\n');
  for (let index = 0; index < lines.length - 1; index++) {
    const oldLine = lines[index];
    const newLine = lines[index + 1];
    if (!oldLine?.startsWith('--- ') || !newLine?.startsWith('+++ ')) continue;
    for (const headerLine of [oldLine, newLine]) {
      const raw = headerLine.slice(4).trim().split('\t', 1)[0] ?? '';
      if (!raw || raw === '/dev/null') continue;
      paths.add(normalizeHistoryPath(raw));
    }
  }
  return [...paths];
}

// Reconstructs prior tool calls and their results alongside the text exchanges
// so a new run in this thread sees what files were already read and what the
// tools returned. Without this, only `user_message`/`assistant_message` text
// events survived across runs — every new prompt started with zero memory of
// earlier tool work, so the model re-read the same files from scratch on every
// turn.
function buildConversationHistoryMessages(
  events: Array<{
    type: string;
    payload: Record<string, unknown>;
  }>,
): ProviderChatMessage[] {
  const lastCompactionIndex = [...events]
    .map((event) => event.type)
    .lastIndexOf('session_compacted');
  const relevantEvents = events.slice(lastCompactionIndex >= 0 ? lastCompactionIndex + 1 : 0);

  // Only reconstruct tool calls that have a matching result later in the log.
  // An orphaned tool_call_started (e.g. from a run stopped mid-tool-call) would
  // otherwise produce an assistant message with toolCalls and no matching tool
  // response, which providers reject.
  const resolvedToolCallIds = new Set<string>();
  for (const event of relevantEvents) {
    if (event.type === 'tool_call_finished' || event.type === 'tool_call_failed') {
      const toolCallId = event.payload.toolCallId;
      if (typeof toolCallId === 'string') {
        resolvedToolCallIds.add(toolCallId);
      }
    }
  }

  // Each unit is either a single text message, or an assistant tool-call
  // message paired with its tool result — units are dropped as a whole when
  // trimming to budget so the remaining sequence never references a tool call
  // without its result.
  const units: ProviderChatMessage[][] = [];

  // Tracks, per file path, every unit index that "touches" it (fs.read,
  // fs.write, or fs.edit) and the subset that are fs.read units — used below
  // to drop stale full-file fs.read results once a fresher read or edit of
  // the same file exists later in the history.
  const fsReadUnitIndicesByPath = new Map<string, number[]>();
  const touchUnitIndicesByPath = new Map<string, number[]>();
  const recordTouch = (rawPath: string, unitIndex: number, isRead: boolean) => {
    const key = normalizeHistoryPath(rawPath);
    const touches = touchUnitIndicesByPath.get(key) ?? [];
    touches.push(unitIndex);
    touchUnitIndicesByPath.set(key, touches);
    if (isRead) {
      const reads = fsReadUnitIndicesByPath.get(key) ?? [];
      reads.push(unitIndex);
      fsReadUnitIndicesByPath.set(key, reads);
    }
  };

  for (const event of relevantEvents) {
    if (event.type === 'user_message' || event.type === 'assistant_message') {
      const text = typeof event.payload.text === 'string' ? event.payload.text.trim() : '';
      if (!text) continue;
      units.push([{ role: event.type === 'assistant_message' ? 'assistant' : 'user', content: text }]);
      continue;
    }

    if (event.type === 'tool_call_started') {
      const toolCallId = event.payload.toolCallId;
      const toolName = event.payload.toolName;
      if (typeof toolCallId !== 'string' || typeof toolName !== 'string') continue;
      if (!resolvedToolCallIds.has(toolCallId)) continue;

      const args = event.payload.arguments;
      units.push([
        {
          role: 'assistant',
          content: null,
          toolCalls: [
            {
              id: toolCallId,
              name: toolName,
              arguments: args && typeof args === 'object' ? (args as Record<string, unknown>) : {},
            },
          ],
        },
      ]);

      const unitIndex = units.length - 1;
      const argsRecord = args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
      if (toolName === 'fs.read' && typeof argsRecord.path === 'string') {
        recordTouch(argsRecord.path, unitIndex, true);
      } else if (toolName === 'fs.write' && typeof argsRecord.path === 'string') {
        recordTouch(argsRecord.path, unitIndex, false);
      } else if (toolName === 'fs.edit' && typeof argsRecord.patch === 'string') {
        for (const targetPath of extractFsEditTargetPaths(argsRecord.patch)) {
          recordTouch(targetPath, unitIndex, false);
        }
      }
      continue;
    }

    if (event.type === 'tool_call_finished' || event.type === 'tool_call_failed') {
      const toolCallId = event.payload.toolCallId;
      if (typeof toolCallId !== 'string') continue;

      const pendingUnit = units[units.length - 1];
      if (!pendingUnit) continue;
      const pendingCall = pendingUnit[0];
      if (pendingCall?.role !== 'assistant' || pendingCall.toolCalls?.[0]?.id !== toolCallId) {
        continue;
      }

      pendingUnit.push({
        role: 'tool',
        toolCallId,
        content: JSON.stringify(event.payload.result ?? null),
      });
    }
  }

  // Drop full-file content from fs.read results that were superseded by a
  // later read or edit of the same file — only the freshest copy of a file's
  // content is worth its tokens; older copies would otherwise sit in history
  // alongside the newer one for the rest of the session.
  for (const [filePath, readIndices] of fsReadUnitIndicesByPath) {
    const touches = touchUnitIndicesByPath.get(filePath) ?? [];
    for (const readIndex of readIndices) {
      const hasLaterTouch = touches.some((touchIndex) => touchIndex > readIndex);
      if (!hasLaterTouch) continue;
      const toolResult = units[readIndex]?.[1];
      if (toolResult?.role === 'tool') {
        toolResult.content = JSON.stringify({
          path: filePath,
          note: 'stale snapshot — this file was read or edited again later in the conversation; refer to the more recent tool result for its current content',
        });
      }
    }
  }

  let messages = units.flat();
  while (units.length > 0 && estimateJsonTokens(messages) > CONVERSATION_HISTORY_TOKEN_BUDGET) {
    units.shift();
    messages = units.flat();
  }

  return messages;
}

const PAYLOAD_TOKEN_BUDGET = 80_000;

export function slideMessageWindow(
  messages: ProviderChatMessage[],
  maxTokens = PAYLOAD_TOKEN_BUDGET,
): { messages: ProviderChatMessage[]; dropped: number; hardStop: boolean } {
  if (estimateJsonTokens(messages) <= maxTokens) {
    return { messages, dropped: 0, hardStop: false };
  }
  const [systemMsg, ...rest] = messages;
  const hasSystem = systemMsg?.role === 'system';
  const head = hasSystem ? [systemMsg] : [];
  const body = hasSystem ? rest : messages;

  let dropped = 0;
  let current = [...body];
  while (current.length > 0 && estimateJsonTokens([...head, ...current]) > maxTokens) {
    current = current.slice(1);
    dropped++;
  }

  const hardStop = current.length === 0 && estimateJsonTokens([...head, ...current]) > maxTokens;
  return { messages: [...head, ...current], dropped, hardStop };
}

function recordToolResult(
  memory: MemoryManager,
  hooks: RunLifecycleHooks,
  result: ToolExecutionResult,
  toolCall: ProviderCompleteResponse['toolCalls'][number],
  context: {
    threadId: string;
    sessionId: string;
    projectPath: string;
  },
): void {
  memory.appendEvent({
    threadId: context.threadId,
    sessionId: context.sessionId,
    projectPath: context.projectPath,
    type: result.status === 'completed' ? 'tool_call_finished' : 'tool_call_failed',
    payload: {
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      result,
    },
  });

  // Tool execution results never reached the debug log before — only the
  // permission decision did. This is what makes "fs.edit doesn't work" or
  // similar reports impossible to diagnose from ~/.umbra/debug alone.
  writeDebugEvent({
    component: 'runner',
    level: result.status === 'completed' ? 'info' : 'warn',
    message: `tool call ${result.status}`,
    data: {
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      status: result.status,
      permissionOutcome: result.permission?.outcome,
      arguments: summarizeForDebug(toolCall.arguments),
      ...(result.error ? { error: result.error } : {}),
      ...(result.issues?.length ? { issues: result.issues } : {}),
      ...(result.status === 'completed' ? { output: summarizeForDebug(result.output) } : {}),
    },
  });

  if (toolCall.name === 'fs.edit' && result.status === 'completed') {
    memory.appendEvent({
      threadId: context.threadId,
      sessionId: context.sessionId,
      projectPath: context.projectPath,
      type: 'patch_applied',
      payload: {
        toolCallId: toolCall.id,
        output: result.output ?? null,
      },
    });
  }

  hooks.appendEvent({
    type: 'tool_result',
    payload: {
      id: toolCall.id,
      name: toolCall.name,
      status: result.status,
      permission: result.permission,
      output: result.status === 'completed' ? (result.output ?? null) : null,
      error: 'error' in result ? (result.error ?? null) : null,
      issues: result.issues ?? [],
    },
  });
}

const DEBUG_SUMMARY_MAX_DEPTH = 3;
const DEBUG_SUMMARY_MAX_ARRAY_ITEMS = 20;

// Shrinks tool arguments/results to something safe to drop into the debug
// log: long strings (patches, file contents, search dumps) are collapsed to
// one line and truncated, large arrays are capped, deep objects are cut off.
function summarizeForDebug(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    return truncateForDebug(value);
  }

  if (Array.isArray(value)) {
    if (depth >= DEBUG_SUMMARY_MAX_DEPTH) {
      return `[array(${value.length})]`;
    }
    const items = value
      .slice(0, DEBUG_SUMMARY_MAX_ARRAY_ITEMS)
      .map((item) => summarizeForDebug(item, depth + 1));
    if (value.length > DEBUG_SUMMARY_MAX_ARRAY_ITEMS) {
      items.push(`…(+${value.length - DEBUG_SUMMARY_MAX_ARRAY_ITEMS} more items)`);
    }
    return items;
  }

  if (value !== null && typeof value === 'object') {
    if (depth >= DEBUG_SUMMARY_MAX_DEPTH) {
      return '[object]';
    }
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, val]) => [
        key,
        summarizeForDebug(val, depth + 1),
      ]),
    );
  }

  return value;
}

function formatPlanAsText(args: Record<string, unknown>): string {
  const lines: string[] = [];

  if (typeof args.explanation === 'string' && args.explanation.length > 0) {
    lines.push(`**Goal:** ${args.explanation}`, '');
  }

  const plan = Array.isArray(args.plan) ? args.plan : [];
  plan.forEach((item, index) => {
    const step = typeof item === 'object' && item !== null ? (item as Record<string, unknown>) : {};
    const text = typeof step.step === 'string' ? step.step : JSON.stringify(item);
    lines.push(`${index + 1}. ${text}`);
  });

  return lines.join('\n');
}

async function resolveCheckCommand(projectPath: string): Promise<string | null> {
  const fs = await import('node:fs/promises');

  try {
    await fs.access(`${projectPath}/check.sh`);
    return process.platform === 'win32' ? 'bash ./check.sh' : './check.sh';
  } catch {}

  try {
    await fs.access(`${projectPath}/check.ps1`);
    return process.platform === 'win32'
      ? 'powershell -ExecutionPolicy Bypass -File ./check.ps1'
      : 'pwsh -ExecutionPolicy Bypass -File ./check.ps1';
  } catch {}

  return null;
}
