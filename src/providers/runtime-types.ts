import { z } from 'zod';

export const providerToolDefinitionSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  inputSchema: z.record(z.string(), z.unknown()).default({}),
});

export const providerToolCallSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()).default({}),
});

export const providerChatMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string().nullable().default(null),
  toolCallId: z.string().optional(),
  toolCalls: z.array(providerToolCallSchema).optional(),
  reasoningContent: z.string().optional(),
});

export const providerResponseFormatSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('text'),
  }),
  z.object({
    type: z.literal('json_object'),
  }),
  z.object({
    type: z.literal('json_schema'),
    name: z.string().min(1),
    schema: z.record(z.string(), z.unknown()),
    strict: z.boolean().optional(),
  }),
]);

export const providerCompleteRequestSchema = z.object({
  model: z.string().optional(),
  messages: z.array(providerChatMessageSchema).min(1),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
  tools: z.array(providerToolDefinitionSchema).optional(),
  toolChoice: z.enum(['auto', 'required', 'none']).optional(),
  responseFormat: providerResponseFormatSchema.optional(),
  thinkBudget: z.union([
    z.number().int().positive(),
    z.enum(['low', 'medium', 'high', 'max']),
  ]).nullable().optional(),
});

export const providerCompleteResponseSchema = z.object({
  providerProfileId: z.string().min(1),
  providerType: z.string().min(1),
  model: z.string().min(1),
  outputText: z.string().nullable(),
  outputJson: z.unknown().nullable(),
  toolCalls: z.array(providerToolCallSchema),
  stopReason: z.string().nullable(),
  reasoningContent: z.string().nullable().optional(),
  usage: z
    .object({
      inputTokens: z.number().int().nonnegative().optional(),
      outputTokens: z.number().int().nonnegative().optional(),
      totalTokens: z.number().int().nonnegative().optional(),
      reasoningTokens: z.number().int().nonnegative().optional(),
      cacheReadTokens: z.number().int().nonnegative().optional(),
      cacheWriteTokens: z.number().int().nonnegative().optional(),
    })
    .optional(),
});

export type ProviderToolDefinition = z.infer<typeof providerToolDefinitionSchema>;
export type ProviderToolCall = z.infer<typeof providerToolCallSchema>;
export type ProviderChatMessage = z.infer<typeof providerChatMessageSchema>;
export type ProviderResponseFormat = z.infer<typeof providerResponseFormatSchema>;
export type ProviderCompleteRequest = z.infer<typeof providerCompleteRequestSchema>;
export type ProviderCompleteResponse = z.infer<typeof providerCompleteResponseSchema>;

export type ProviderStreamObserver = {
  onReasoningDelta?(delta: string): void;
  onTextDelta?(delta: string): void;
  /** When provided, the underlying fetch request is aborted when this signal fires. */
  signal?: AbortSignal;
};
