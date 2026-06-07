import path from 'node:path';
import { z } from 'zod';
import { getPermissionManager, resolvePermissionMode } from '../core/permissions.js';
import {
  classifyShellCommand,
  executeFsCd,
  executeFsEdit,
  executeFsList,
  executeFsRead,
  executeFsWrite,
  executeGitApply,
  executeGitCommit,
  executeGitDiff,
  executeGitPull,
  executeGitPush,
  executeGitStatus,
  executeSearchFiles,
  executeSearchFuzzy,
  executeSearchRg,
  executeShellExec,
  fsCdInputSchema,
  fsCdOutputSchema,
  fsEditInputSchema,
  fsEditOutputSchema,
  fsListInputSchema,
  fsListOutputSchema,
  fsReadInputSchema,
  fsReadOutputSchema,
  fsWriteInputSchema,
  fsWriteOutputSchema,
  gitApplyInputSchema,
  gitApplyOutputSchema,
  gitCommitInputSchema,
  gitCommitOutputSchema,
  gitDiffInputSchema,
  gitDiffOutputSchema,
  gitPullInputSchema,
  gitPullOutputSchema,
  gitPushInputSchema,
  gitPushOutputSchema,
  gitStatusInputSchema,
  gitStatusOutputSchema,
  searchFilesInputSchema,
  searchFilesOutputSchema,
  searchFuzzyInputSchema,
  searchFuzzyOutputSchema,
  searchRgInputSchema,
  searchRgOutputSchema,
  shellExecInputSchema,
  shellExecOutputSchema,
} from './builtins.js';
import type {
  JsonSchema,
  ToolCall,
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolMetadata,
  ToolPermissionDecision,
  ToolPreset,
  ToolPresetId,
  ToolRiskClass,
} from './types.js';
import { executeWebFetch, webFetchInputSchema, webFetchOutputSchema } from './web-fetch.js';
import { executeWebSearch, webSearchInputSchema, webSearchOutputSchema } from './web-search.js';

const toolPresets: Record<ToolPresetId, ToolPreset> = {
  'chat-readonly': {
    id: 'chat-readonly',
    description: 'Read-only chat surface. No edits, no shell writes, no git mutations.',
    allowWrite: false,
    allowExecute: false,
  },
  'agent-default': {
    id: 'agent-default',
    description: 'Agent surface with read access by default and approval gates for mutations.',
    allowWrite: false,
    allowExecute: false,
  },
  'exec-full': {
    id: 'exec-full',
    description: 'Full execution surface with writes, shell, and git mutations enabled.',
    allowWrite: true,
    allowExecute: true,
  },
};

const toolRegistry: ToolDefinition[] = [
  defineTool({
    name: 'fs.list',
    description: 'List files and directories under a target path.',
    riskClass: 'read_only',
    readOnly: true,
    concurrencySafe: true,
    inputJsonSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        recursive: { type: 'boolean' },
        includeHidden: { type: 'boolean' },
        maxEntries: { type: 'integer', minimum: 1, maximum: 5000 },
      },
      required: ['path'],
      additionalProperties: false,
    },
    outputJsonSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        resolvedPath: { type: 'string' },
        entries: { type: 'array' },
        truncated: { type: 'boolean' },
      },
      required: ['path', 'resolvedPath', 'entries', 'truncated'],
      additionalProperties: false,
    },
    inputSchema: fsListInputSchema,
    outputSchema: fsListOutputSchema,
    execute: executeFsList,
  }),
  defineTool({
    name: 'fs.read',
    description: 'Read a text file as UTF-8 with optional offset/limit slicing.',
    riskClass: 'read_only',
    readOnly: true,
    concurrencySafe: true,
    inputJsonSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        offset: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 512000 },
      },
      required: ['path'],
      additionalProperties: false,
    },
    outputJsonSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        resolvedPath: { type: 'string' },
        content: { type: 'string' },
        truncated: { type: 'boolean' },
        totalBytes: { type: 'integer' },
      },
      required: ['path', 'resolvedPath', 'content', 'truncated', 'totalBytes'],
      additionalProperties: false,
    },
    inputSchema: fsReadInputSchema,
    outputSchema: fsReadOutputSchema,
    execute: executeFsRead,
  }),
  defineTool({
    name: 'fs.cd',
    description: 'Change the current working directory (project path) of the agent.',
    riskClass: 'execute',
    readOnly: false,
    concurrencySafe: false,
    inputJsonSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    outputJsonSchema: {
      type: 'object',
      properties: {
        previousPath: { type: 'string' },
        newPath: { type: 'string' },
        status: { type: 'string', enum: ['completed', 'failed'] },
        error: { type: 'string' },
      },
      required: ['previousPath', 'newPath', 'status'],
      additionalProperties: false,
    },
    inputSchema: fsCdInputSchema,
    outputSchema: fsCdOutputSchema,
    execute: executeFsCd,
  }),
  defineTool({
    name: 'fs.write',
    description: 'Write a full file payload to disk.',
    riskClass: 'write',
    readOnly: false,
    concurrencySafe: false,
    inputJsonSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
        createDirectories: { type: 'boolean' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    outputJsonSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        resolvedPath: { type: 'string' },
        bytesWritten: { type: 'integer' },
        createdDirectories: { type: 'boolean' },
      },
      required: ['path', 'resolvedPath', 'bytesWritten', 'createdDirectories'],
      additionalProperties: false,
    },
    inputSchema: fsWriteInputSchema,
    outputSchema: fsWriteOutputSchema,
    execute: executeFsWrite,
  }),
  defineTool({
    name: 'fs.edit',
    description: 'Apply Unified Diff patches to one or more files.',
    riskClass: 'write',
    readOnly: false,
    concurrencySafe: false,
    inputJsonSchema: {
      type: 'object',
      properties: {
        patch: { type: 'string' },
        dryRun: { type: 'boolean' },
      },
      required: ['patch'],
      additionalProperties: false,
    },
    outputJsonSchema: {
      type: 'object',
      properties: {
        dryRun: { type: 'boolean' },
        changedFiles: { type: 'array' },
      },
      required: ['dryRun', 'changedFiles'],
      additionalProperties: false,
    },
    inputSchema: fsEditInputSchema,
    outputSchema: fsEditOutputSchema,
    classifyRisk: () => 'write',
    execute: executeFsEdit,
  }),
  defineTool({
    name: 'shell.exec',
    description: 'Execute a terminal command through the host shell.',
    riskClass: 'execute',
    readOnly: false,
    concurrencySafe: false,
    inputJsonSchema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        cwd: { type: 'string' },
        timeoutMs: { type: 'integer', minimum: 1, maximum: 120000 },
      },
      required: ['command'],
      additionalProperties: false,
    },
    outputJsonSchema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        cwd: { type: 'string' },
        exitCode: { type: 'integer' },
        stdout: { type: 'string' },
        stderr: { type: 'string' },
        timedOut: { type: 'boolean' },
      },
      required: ['command', 'cwd', 'exitCode', 'stdout', 'stderr', 'timedOut'],
      additionalProperties: false,
    },
    inputSchema: shellExecInputSchema,
    outputSchema: shellExecOutputSchema,
    classifyRisk: (input) => classifyShellCommand(input.command),
    execute: executeShellExec,
  }),
  defineTool({
    name: 'search.rg',
    description:
      'Search file contents with ripgrep (or Node fallback). Returns grouped file buckets with snippets and optional context lines for model consumption.',
    riskClass: 'read_only',
    readOnly: true,
    concurrencySafe: true,
    inputJsonSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        path: { type: 'string' },
        glob: { type: 'string' },
        caseSensitive: { type: 'boolean' },
        maxMatches: { type: 'integer', minimum: 1, maximum: 5000 },
        contextLines: { type: 'integer', minimum: 0, maximum: 5 },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
    outputJsonSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        resolvedPath: { type: 'string' },
        engine: { type: 'string' },
        fileBuckets: { type: 'array' },
        totalMatchCount: { type: 'integer' },
        truncatedFiles: { type: 'boolean' },
        matches: { type: 'array' },
        truncated: { type: 'boolean' },
      },
      required: ['pattern', 'resolvedPath', 'engine', 'fileBuckets', 'totalMatchCount', 'truncatedFiles', 'matches', 'truncated'],
      additionalProperties: false,
    },
    inputSchema: searchRgInputSchema,
    outputSchema: searchRgOutputSchema,
    execute: executeSearchRg,
  }),
  defineTool({
    name: 'search.files',
    description:
      'List project files respecting .gitignore and common ignore rules (node_modules, dist, .git). Use rg --files if available, falls back to Node walker.',
    riskClass: 'read_only',
    readOnly: true,
    concurrencySafe: true,
    inputJsonSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        glob: { type: 'string' },
        includeHidden: { type: 'boolean' },
        maxResults: { type: 'integer', minimum: 1, maximum: 5000 },
      },
      additionalProperties: false,
    },
    outputJsonSchema: {
      type: 'object',
      properties: {
        resolvedPath: { type: 'string' },
        engine: { type: 'string' },
        files: { type: 'array' },
        truncated: { type: 'boolean' },
        totalScanned: { type: 'integer' },
      },
      required: ['resolvedPath', 'engine', 'files', 'truncated', 'totalScanned'],
      additionalProperties: false,
    },
    inputSchema: searchFilesInputSchema,
    outputSchema: searchFilesOutputSchema,
    execute: executeSearchFiles,
  }),
  defineTool({
    name: 'search.fuzzy',
    description:
      'Fuzzy search over project file paths. Returns ranked matches with match indices for highlighting. Ignores node_modules, dist, .git.',
    riskClass: 'read_only',
    readOnly: true,
    concurrencySafe: true,
    inputJsonSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        path: { type: 'string' },
        maxResults: { type: 'integer', minimum: 1, maximum: 100 },
        includeDirectories: { type: 'boolean' },
        includeHidden: { type: 'boolean' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    outputJsonSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        resolvedPath: { type: 'string' },
        results: { type: 'array' },
        truncated: { type: 'boolean' },
      },
      required: ['query', 'resolvedPath', 'results', 'truncated'],
      additionalProperties: false,
    },
    inputSchema: searchFuzzyInputSchema,
    outputSchema: searchFuzzyOutputSchema,
    execute: executeSearchFuzzy,
  }),
  defineTool({
    name: 'web.search',
    description:
      'Search the external web and return a ranked list of URLs with snippets. Requires web mode to be enabled. ' +
      'IMPORTANT: snippets are short previews — they do NOT contain live data like current time, weather, prices, or scores. ' +
      'For questions requiring live/current data, always follow up by calling web.fetch on one of the result URLs to read the actual page content.',
    riskClass: 'execute',
    readOnly: false,
    concurrencySafe: true,
    inputJsonSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        maxResults: { type: 'integer', minimum: 1, maximum: 10 },
        domains: {
          type: 'array',
          items: { type: 'string' },
          maxItems: 10,
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
    outputJsonSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        mode: { type: 'string' },
        providerId: { type: 'string' },
        results: { type: 'array' },
      },
      required: ['query', 'mode', 'providerId', 'results'],
      additionalProperties: false,
    },
    inputSchema: webSearchInputSchema,
    outputSchema: webSearchOutputSchema,
    execute: executeWebSearch,
  }),
  defineTool({
    name: 'web.fetch',
    description:
      'Fetch a URL and return its full content as clean markdown text. Use this after web.search to get actual live data from a page (current time, weather, prices, article body, etc.). Uses Jina Reader by default with a raw HTML fallback.',
    riskClass: 'execute',
    readOnly: true,
    concurrencySafe: true,
    inputJsonSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', format: 'uri' },
        mode: { type: 'string', enum: ['reader', 'raw'] },
        maxChars: { type: 'integer', minimum: 500, maximum: 100000 },
      },
      required: ['url'],
      additionalProperties: false,
    },
    outputJsonSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        title: { type: 'string' },
        content: { type: 'string' },
        mode: { type: 'string' },
        truncated: { type: 'boolean' },
        statusCode: { type: 'integer' },
        error: { type: 'string' },
      },
      required: ['url', 'title', 'content', 'mode', 'truncated'],
      additionalProperties: false,
    },
    inputSchema: webFetchInputSchema,
    outputSchema: webFetchOutputSchema,
    execute: executeWebFetch,
  }),
  defineTool({
    name: 'git.status',
    description: 'Return git branch and porcelain status entries.',
    riskClass: 'execute',
    readOnly: false,
    concurrencySafe: false,
    inputJsonSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string' },
      },
      additionalProperties: false,
    },
    outputJsonSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string' },
        branch: { type: ['string', 'null'] },
        upstream: { type: ['string', 'null'] },
        ahead: { type: 'integer' },
        behind: { type: 'integer' },
        entries: { type: 'array' },
        raw: { type: 'string' },
      },
      required: ['cwd', 'branch', 'upstream', 'ahead', 'behind', 'entries', 'raw'],
      additionalProperties: false,
    },
    inputSchema: gitStatusInputSchema,
    outputSchema: gitStatusOutputSchema,
    execute: executeGitStatus,
  }),
  defineTool({
    name: 'git.diff',
    description: 'Return git patch output and numstat metadata.',
    riskClass: 'execute',
    readOnly: false,
    concurrencySafe: false,
    inputJsonSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string' },
        cached: { type: 'boolean' },
        contextLines: { type: 'integer', minimum: 0, maximum: 20 },
      },
      additionalProperties: false,
    },
    outputJsonSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string' },
        cached: { type: 'boolean' },
        patch: { type: 'string' },
        files: { type: 'array' },
      },
      required: ['cwd', 'cached', 'patch', 'files'],
      additionalProperties: false,
    },
    inputSchema: gitDiffInputSchema,
    outputSchema: gitDiffOutputSchema,
    execute: executeGitDiff,
  }),
  defineTool({
    name: 'git.apply',
    description: 'Apply a patch through git apply.',
    riskClass: 'write',
    readOnly: false,
    concurrencySafe: false,
    inputJsonSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string' },
        patch: { type: 'string' },
        check: { type: 'boolean' },
        cached: { type: 'boolean' },
      },
      required: ['patch'],
      additionalProperties: false,
    },
    outputJsonSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string' },
        applied: { type: 'boolean' },
        check: { type: 'boolean' },
        cached: { type: 'boolean' },
        stdout: { type: 'string' },
        stderr: { type: 'string' },
      },
      required: ['cwd', 'applied', 'check', 'cached', 'stdout', 'stderr'],
      additionalProperties: false,
    },
    inputSchema: gitApplyInputSchema,
    outputSchema: gitApplyOutputSchema,
    execute: executeGitApply,
  }),
  defineTool({
    name: 'git.commit',
    description: 'Create a git commit with a fixed message.',
    riskClass: 'write',
    readOnly: false,
    concurrencySafe: false,
    inputJsonSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string' },
        message: { type: 'string' },
        all: { type: 'boolean' },
      },
      required: ['message'],
      additionalProperties: false,
    },
    outputJsonSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string' },
        commitHash: { type: 'string' },
        message: { type: 'string' },
        stdout: { type: 'string' },
        stderr: { type: 'string' },
      },
      required: ['cwd', 'commitHash', 'message', 'stdout', 'stderr'],
      additionalProperties: false,
    },
    inputSchema: gitCommitInputSchema,
    outputSchema: gitCommitOutputSchema,
    execute: executeGitCommit,
  }),
  defineTool({
    name: 'git.push',
    description: 'Push the current branch (or a specified branch) to a remote.',
    riskClass: 'execute',
    readOnly: false,
    concurrencySafe: false,
    inputJsonSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string' },
        remote: { type: 'string' },
        branch: { type: 'string' },
        force: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    outputJsonSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string' },
        remote: { type: 'string' },
        branch: { type: 'string' },
        stdout: { type: 'string' },
        stderr: { type: 'string' },
      },
      required: ['cwd', 'remote', 'branch', 'stdout', 'stderr'],
      additionalProperties: false,
    },
    inputSchema: gitPushInputSchema,
    outputSchema: gitPushOutputSchema,
    execute: executeGitPush,
  }),
  defineTool({
    name: 'git.pull',
    description: 'Pull from a remote into the current branch.',
    riskClass: 'execute',
    readOnly: false,
    concurrencySafe: false,
    inputJsonSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string' },
        remote: { type: 'string' },
        branch: { type: 'string' },
        rebase: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    outputJsonSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string' },
        remote: { type: 'string' },
        branch: { type: 'string' },
        alreadyUpToDate: { type: 'boolean' },
        stdout: { type: 'string' },
        stderr: { type: 'string' },
      },
      required: ['cwd', 'remote', 'branch', 'alreadyUpToDate', 'stdout', 'stderr'],
      additionalProperties: false,
    },
    inputSchema: gitPullInputSchema,
    outputSchema: gitPullOutputSchema,
    execute: executeGitPull,
  }),
];

const toolExecuteRequestSchema = z.object({
  preset: z.enum(['chat-readonly', 'agent-default', 'exec-full']).default('agent-default'),
  cwd: z.string().optional(),
  projectPath: z.string().optional(),
  call: z.object({
    name: z.string().min(1),
    arguments: z.unknown(),
  }),
});

const toolCustomPathUpdateSchema = z.object({
  path: z.string().min(1).nullable(),
});

export type ToolExecuteRequest = z.infer<typeof toolExecuteRequestSchema> & {
  promptFn?: (
    request: import('../core/permissions.js').PermissionRequest,
  ) => Promise<import('../core/permissions.js').PermissionOutcome>;
};
export type ToolCustomPathUpdate = z.infer<typeof toolCustomPathUpdateSchema>;

export function listToolDefinitions(): ToolMetadata[] {
  return toolRegistry.map((tool) => ({
    name: tool.name,
    description: tool.description,
    riskClass: tool.riskClass,
    readOnly: tool.readOnly,
    concurrencySafe: tool.concurrencySafe,
    inputJsonSchema: tool.inputJsonSchema,
    outputJsonSchema: tool.outputJsonSchema,
  }));
}

export function getToolPresets(): ToolPreset[] {
  return Object.values(toolPresets);
}

export function parseToolExecuteRequest(
  value: unknown,
): { ok: true; data: ToolExecuteRequest } | { ok: false; issues: string[] } {
  const parsed = toolExecuteRequestSchema.safeParse(value);

  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => issue.message),
    };
  }

  return { ok: true, data: parsed.data };
}

export function parseToolCustomPathUpdate(
  value: unknown,
): { ok: true; data: ToolCustomPathUpdate } | { ok: false; issues: string[] } {
  const parsed = toolCustomPathUpdateSchema.safeParse(value);

  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => issue.message),
    };
  }

  return { ok: true, data: parsed.data };
}

export async function executeToolCall(request: ToolExecuteRequest): Promise<ToolExecutionResult> {
  const tool = findToolDefinition(request.call.name);

  if (!tool) {
    return {
      status: 'invalid',
      toolName: request.call.name,
      permission: denyDecision('Unknown tool.', 'execute'),
      issues: [`Unknown tool: ${request.call.name}`],
    };
  }

  const parsedInput = tool.inputSchema.safeParse(request.call.arguments);

  if (!parsedInput.success) {
    return {
      status: 'invalid',
      toolName: tool.name,
      permission: denyDecision(
        'Input validation failed.',
        resolveToolRisk(tool, request.call.arguments),
      ),
      issues: parsedInput.error.issues.map((issue) => issue.message),
    };
  }

  const decision = await evaluatePermission(
    tool,
    parsedInput.data,
    request.preset,
    request.promptFn,
    request.projectPath,
  );

  if (decision.outcome !== 'allow') {
    return {
      status: 'blocked',
      toolName: tool.name,
      permission: decision,
      issues: [decision.reason],
    };
  }

  const context: ToolExecutionContext = {
    cwd: path.resolve(request.cwd ?? '.'),
    preset: request.preset,
    ...(request.projectPath ? { projectPath: request.projectPath } : {}),
  };

  try {
    const output = await tool.execute(parsedInput.data, context);
    const parsedOutput = tool.outputSchema.safeParse(output);

    if (!parsedOutput.success) {
      return {
        status: 'failed',
        toolName: tool.name,
        permission: decision,
        error: 'Tool returned an invalid machine-readable payload.',
        issues: parsedOutput.error.issues.map((issue) => issue.message),
      };
    }

    return {
      status: 'completed',
      toolName: tool.name,
      permission: decision,
      output: parsedOutput.data,
    };
  } catch (error) {
    return {
      status: 'failed',
      toolName: tool.name,
      permission: decision,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function findToolDefinition(toolName: string): ToolDefinition | undefined {
  return toolRegistry.find((tool) => tool.name === toolName);
}

function defineTool<TInput, TOutput>(
  definition: ToolDefinition<TInput, TOutput>,
): ToolDefinition<TInput, TOutput> {
  return definition;
}

async function evaluatePermission(
  tool: ToolDefinition,
  input: unknown,
  presetId: ToolPresetId,
  promptFn?: (
    request: import('../core/permissions.js').PermissionRequest,
  ) => Promise<import('../core/permissions.js').PermissionOutcome>,
  projectPath?: string,
): Promise<ToolPermissionDecision> {
  const manager = getPermissionManager();
  const mode = resolvePermissionMode(presetId);
  const effectiveRisk = resolveToolRisk(tool, input);

  if (effectiveRisk === 'read_only') {
    return allowDecision('Read-only tool is allowed in this preset.', effectiveRisk);
  }

  const evalRequest: import('../core/permissions.js').PermissionRequest = {
    tool: tool.name,
    args: input as Record<string, unknown>,
    mode,
    summary: tool.description,
    ...(projectPath ? { projectPath } : {}),
  };
  const result = await manager.evaluate(evalRequest, promptFn);

  if (result.outcome === 'allow') {
    return allowDecision(
      `Tool allowed by permission manager (${result.ruleId ? 'rule' : 'mode'}).`,
      effectiveRisk,
    );
  }

  return denyDecision(
    `Tool blocked by permission manager (${result.ruleId ? 'rule' : 'mode'}).`,
    effectiveRisk,
  );
}

function resolveToolRisk(tool: ToolDefinition, input: unknown): ToolRiskClass {
  if (!tool.classifyRisk) {
    return tool.riskClass;
  }

  try {
    return tool.classifyRisk(input);
  } catch {
    return tool.riskClass;
  }
}

function allowDecision(reason: string, effectiveRisk: ToolRiskClass): ToolPermissionDecision {
  return {
    outcome: 'allow',
    reason,
    requiresApproval: false,
    effectiveRisk,
  };
}

function askDecision(reason: string, effectiveRisk: ToolRiskClass): ToolPermissionDecision {
  return {
    outcome: 'ask',
    reason,
    requiresApproval: true,
    effectiveRisk,
  };
}

function denyDecision(reason: string, effectiveRisk: ToolRiskClass): ToolPermissionDecision {
  return {
    outcome: 'deny',
    reason,
    requiresApproval: false,
    effectiveRisk,
  };
}

export { toolCustomPathUpdateSchema, toolExecuteRequestSchema };
