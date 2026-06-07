import type { ProviderCompleteRequest, ProviderToolDefinition } from '../providers/index.js';
import { listToolDefinitions } from '../tools/index.js';
import type { ToolPresetId } from '../tools/index.js';
import type { WebSearchMode } from '../tools/web-search.js';
import type { RunModeContractPayload, RuntimeMode } from './contracts.js';
import { PLAN_INSTRUCTION, buildAgentInstruction, buildExecInstruction } from './prompts.js';

const UPDATE_PLAN_TOOL: ProviderToolDefinition = {
  name: 'update_plan',
  description:
    'Submit a structured implementation plan. Call this exactly once with the full ordered list of steps.',
  inputSchema: {
    type: 'object',
    properties: {
      explanation: {
        type: 'string',
        description: 'Optional one-sentence summary of the overall goal.',
      },
      plan: {
        type: 'array',
        description: 'Ordered list of implementation steps.',
        items: {
          type: 'object',
          properties: {
            step: { type: 'string', description: 'Concise description of this step.' },
            status: {
              type: 'string',
              enum: ['pending', 'in_progress', 'completed'],
              description: 'Initial status — always "pending" in a new plan.',
            },
          },
          required: ['step', 'status'],
          additionalProperties: false,
        },
      },
    },
    required: ['plan'],
    additionalProperties: false,
  },
};

type ResolvedRunModeContract = RunModeContractPayload & {
  systemInstruction: string;
  providerTools: ProviderToolDefinition[];
  providerRequest: Pick<ProviderCompleteRequest, 'tools' | 'toolChoice' | 'responseFormat'>;
};

const planSchema = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          reason: { type: 'string' },
          files: {
            type: 'array',
            items: { type: 'string' },
          },
          checks: {
            type: 'array',
            items: { type: 'string' },
          },
        },
        required: ['id', 'title', 'reason', 'files', 'checks'],
        additionalProperties: false,
      },
    },
  },
  required: ['summary', 'steps'],
  additionalProperties: false,
} as const;

const simpleChatPhrases = new Set([
  'hi',
  'hello',
  'hey',
  'yo',
  'sup',
  'thanks',
  'thank you',
  '\u043f\u0440\u0438\u0432\u0435\u0442',
  '\u0437\u0434\u0440\u0430\u0432\u0441\u0442\u0432\u0443\u0439',
  '\u0437\u0434\u0440\u0430\u0432\u0441\u0442\u0432\u0443\u0439\u0442\u0435',
  '\u0441\u043f\u0430\u0441\u0438\u0431\u043e',
  '\u0434\u043e\u0431\u0440\u044b\u0439 \u0434\u0435\u043d\u044c',
  '\u0434\u043e\u0431\u0440\u044b\u0439 \u0432\u0435\u0447\u0435\u0440',
  '\u043a\u0430\u043a \u0434\u0435\u043b\u0430',
  '\u0447\u0442\u043e \u0442\u044b \u0443\u043c\u0435\u0435\u0448\u044c',
]);

export function resolveRunModeContract(input: {
  mode: RuntimeMode;
  prompt: string;
  webSearch?: {
    enabled: boolean;
    mode?: Exclude<WebSearchMode, 'off'>;
  };
  gitEnabled?: boolean;
}): ResolvedRunModeContract {
  const intent = detectTaskIntent(input.prompt);

  if (input.mode === 'plan') {
    return {
      mode: 'plan',
      title: 'Planning Mode',
      description: 'Structured plan generation without tool execution or code edits.',
      toolPreset: null,
      toolNames: ['update_plan'],
      allowToolExecution: false,
      allowEdits: false,
      allowShell: false,
      allowGit: false,
      confirmationPolicy: 'none',
      responseFormat: 'json_plan',
      timeBoxDefaultMs: null,
      systemInstruction: PLAN_INSTRUCTION,
      providerTools: [UPDATE_PLAN_TOOL],
      providerRequest: {
        tools: [UPDATE_PLAN_TOOL],
        toolChoice: 'required',
        responseFormat: { type: 'text' },
      },
    };
  }

  if (input.mode === 'exec') {
    const toolNames = collectTools({
      includeWrites: true,
      includeExecute: true,
      webSearchEnabled: input.webSearch?.enabled ?? false,
      gitEnabled: input.gitEnabled ?? false,
    });
    return {
      mode: 'exec',
      title: 'Exec Mode',
      description: 'Autonomous edit-run-fix loop with full execution policy.',
      toolPreset: 'exec-full',
      toolNames,
      allowToolExecution: true,
      allowEdits: true,
      allowShell: true,
      allowGit: true,
      confirmationPolicy: 'automatic-within-policy',
      responseFormat: 'text',
      timeBoxDefaultMs: 30 * 60 * 1000,
      systemInstruction: buildExecInstruction(input.webSearch),
      providerTools: mapProviderTools(toolNames),
      providerRequest: {
        tools: mapProviderTools(toolNames),
        toolChoice: 'auto',
        responseFormat: { type: 'text' },
      },
    };
  }

  if (input.mode === 'full') {
    const toolPreset: ToolPresetId | null = intent.simpleChat ? null : 'exec-full';
    const toolNames = intent.simpleChat
      ? []
      : collectTools({
          includeWrites: true,
          includeExecute: true,
          webSearchEnabled: input.webSearch?.enabled ?? false,
          gitEnabled: input.gitEnabled ?? false,
        });

    return {
      mode: 'full',
      title: 'Full Access Mode',
      description: 'Interactive mode with full read/write tool access without asking.',
      toolPreset,
      toolNames,
      allowToolExecution: toolNames.length > 0,
      allowEdits: !intent.simpleChat,
      allowShell: !intent.simpleChat,
      allowGit: !intent.simpleChat,
      confirmationPolicy: intent.simpleChat ? 'none' : 'automatic-within-policy',
      responseFormat: 'text',
      timeBoxDefaultMs: null,
      systemInstruction: buildAgentInstruction({
        simpleChat: intent.simpleChat,
        ...(input.webSearch ? { webSearch: input.webSearch } : {}),
      }),
      providerTools: mapProviderTools(toolNames),
      providerRequest: {
        tools: mapProviderTools(toolNames),
        toolChoice: toolNames.length > 0 ? 'auto' : 'none',
        responseFormat: { type: 'text' },
      },
    };
  }

  const toolPreset: ToolPresetId | null = intent.simpleChat ? null : 'agent-default';
  const toolNames = intent.simpleChat
    ? []
    : collectTools({
        includeWrites: true,
        includeExecute: true,
        webSearchEnabled: input.webSearch?.enabled ?? false,
        gitEnabled: input.gitEnabled ?? false,
      });

  return {
    mode: 'agent',
    title: 'Moderate Mode',
    description: 'Interactive mode with write/exec tools gated by permission approvals.',
    toolPreset,
    toolNames,
    allowToolExecution: toolNames.length > 0,
    allowEdits: !intent.simpleChat,
    allowShell: !intent.simpleChat,
    allowGit: !intent.simpleChat,
    confirmationPolicy: intent.simpleChat ? 'none' : 'automatic-within-policy',
    responseFormat: 'text',
    timeBoxDefaultMs: null,
    systemInstruction: buildAgentInstruction({
      simpleChat: intent.simpleChat,
      ...(input.webSearch ? { webSearch: input.webSearch } : {}),
    }),
    providerTools: mapProviderTools(toolNames),
    providerRequest: {
      tools: mapProviderTools(toolNames),
      toolChoice: toolNames.length > 0 ? 'auto' : 'none',
      responseFormat: { type: 'text' },
    },
  };
}

function collectTools(input: {
  includeWrites: boolean;
  includeExecute: boolean;
  webSearchEnabled?: boolean;
  gitEnabled?: boolean;
}): string[] {
  return listToolDefinitions()
    .filter((tool) => {
      if (tool.name.startsWith('git.') && !input.gitEnabled) {
        return false;
      }

      if ((tool.name === 'web.search' || tool.name === 'web.fetch') && !input.webSearchEnabled) {
        return false;
      }

      if (tool.riskClass === 'read_only') {
        return true;
      }

      if (tool.riskClass === 'write') {
        return input.includeWrites;
      }

      return input.includeExecute;
    })
    .map((tool) => tool.name);
}

function mapProviderTools(toolNames: string[]): ProviderToolDefinition[] {
  const allowed = new Set(toolNames);
  return listToolDefinitions()
    .filter((tool) => allowed.has(tool.name))
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: isRecord(tool.inputJsonSchema) ? tool.inputJsonSchema : {},
    }));
}

function detectTaskIntent(prompt: string): {
  simpleChat: boolean;
} {
  const normalized = prompt.trim().toLowerCase();
  const tokenCount = normalized.split(/\s+/).filter(Boolean).length;
  const simpleChat =
    tokenCount > 0 &&
    tokenCount <= 8 &&
    !/[`@/\\]/.test(prompt) &&
    simpleChatPhrases.has(normalized);

  return { simpleChat };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export type { ResolvedRunModeContract };
