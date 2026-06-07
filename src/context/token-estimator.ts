export const DEFAULT_CHARS_PER_TOKEN = 4;
export const DEFAULT_CONTEXT_TOKEN_BUDGET = 32_000;

export type TokenSection = {
  label: string;
  chars: number;
  tokens: number;
};

export function estimateTextTokens(text: string, charsPerToken = DEFAULT_CHARS_PER_TOKEN): number {
  if (!text) {
    return 0;
  }

  return Math.max(1, Math.ceil(text.length / charsPerToken));
}

export function estimateJsonTokens(
  value: unknown,
  charsPerToken = DEFAULT_CHARS_PER_TOKEN,
): number {
  return estimateTextTokens(JSON.stringify(value), charsPerToken);
}

export function createTokenSection(
  label: string,
  text: string,
  charsPerToken = DEFAULT_CHARS_PER_TOKEN,
): TokenSection {
  return {
    label,
    chars: text.length,
    tokens: estimateTextTokens(text, charsPerToken),
  };
}

export function summarizeTokenSections(
  sections: TokenSection[],
  budgetTokens = DEFAULT_CONTEXT_TOKEN_BUDGET,
) {
  const totalTokens = sections.reduce((sum, section) => sum + section.tokens, 0);
  return {
    budgetTokens,
    totalTokens,
    remainingTokens: budgetTokens - totalTokens,
    withinBudget: totalTokens <= budgetTokens,
    sections,
  };
}
