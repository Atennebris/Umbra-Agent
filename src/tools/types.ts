import type { ZodTypeAny } from 'zod';

export type JsonSchema = Record<string, unknown> | boolean;

export type ToolRiskClass = 'read_only' | 'write' | 'execute';

export type ToolPresetId = 'chat-readonly' | 'agent-default' | 'exec-full';

export type ToolPermissionOutcome = 'allow' | 'ask' | 'deny';

export type ToolExecutionStatus = 'completed' | 'blocked' | 'invalid' | 'failed';

export type ToolPermissionDecision = {
  outcome: ToolPermissionOutcome;
  reason: string;
  requiresApproval: boolean;
  effectiveRisk: ToolRiskClass;
};

export type ToolExecutionContext = {
  cwd: string;
  preset: ToolPresetId;
  projectPath?: string;
  signal?: AbortSignal;
};

export type ToolExecutionResult<TOutput = unknown> = {
  status: ToolExecutionStatus;
  toolName: string;
  permission: ToolPermissionDecision;
  output?: TOutput;
  error?: string;
  issues?: string[];
};

export type ToolMetadata = {
  name: string;
  description: string;
  riskClass: ToolRiskClass;
  readOnly: boolean;
  concurrencySafe: boolean;
  inputJsonSchema: JsonSchema;
  outputJsonSchema: JsonSchema;
};

type BivariantCallback<Args extends unknown[], ReturnValue> = {
  bivarianceHack(...args: Args): ReturnValue;
}['bivarianceHack'];

export type ToolDefinition<TInput = unknown, TOutput = unknown> = ToolMetadata & {
  inputSchema: ZodTypeAny;
  outputSchema: ZodTypeAny;
  classifyRisk?: BivariantCallback<[TInput], ToolRiskClass> | undefined;
  execute: BivariantCallback<[TInput, ToolExecutionContext], Promise<TOutput>>;
};

export type ToolCall = {
  name: string;
  arguments: unknown;
};

export type ToolPreset = {
  id: ToolPresetId;
  description: string;
  allowWrite: boolean;
  allowExecute: boolean;
};

export type ExternalToolSourceMode = 'custom' | 'runtime' | 'system' | 'fallback';

export type ExternalToolStatus = {
  tool: string;
  displayName: string;
  available: boolean;
  sourceMode: ExternalToolSourceMode | null;
  resolvedPath: string | null;
  version: string | null;
  fallbackAvailable: boolean;
  manualPathAllowed: boolean;
  missingReason: string | null;
};
