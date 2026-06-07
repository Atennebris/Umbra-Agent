import { buildRepoMap, summarizeRepoMap } from './repo-map.js';
import { type CompactableSessionEvent, buildSessionWindow } from './session-compact.js';
import {
  DEFAULT_CONTEXT_TOKEN_BUDGET,
  createTokenSection,
  summarizeTokenSections,
} from './token-estimator.js';

export type SimilarMemory = {
  id: string;
  content: string;
  score: number;
  sessionId: string | null;
};

export type ContextBuildInput = {
  projectPath: string;
  task: string;
  memory: string;
  agentsRules: string[];
  similarMemories: SimilarMemory[];
  sessionEvents: CompactableSessionEvent[];
  budgetTokens?: number;
};

export type ContextBuildResult = {
  projectPath: string;
  repoFiles: number;
  repoSymbols: number;
  languages: string[];
  similarMemories: number;
  similarMemoriesText: string;
  sessionSummary: string | null;
  recentEventCount: number;
  tokenReport: ReturnType<typeof summarizeTokenSections>;
  repoMapMarkdown: string;
};

export async function buildTaskContext(input: ContextBuildInput): Promise<ContextBuildResult> {
  const repoMap = await buildRepoMap(input.projectPath);
  const repoSummary = summarizeRepoMap(repoMap);
  const sessionWindow = buildSessionWindow(input.sessionEvents);
  const rulesText = input.agentsRules.join('\n');
  const similarMemoriesText = input.similarMemories.map((memory) => memory.content).join('\n---\n');
  const recentEventsText = sessionWindow.recentEvents
    .map((event) => `${event.type}: ${JSON.stringify(event.payload)}`)
    .join('\n');
  const tokenReport = summarizeTokenSections(
    [
      createTokenSection('task', input.task),
      createTokenSection('agents', rulesText),
      createTokenSection('memory', input.memory),
      createTokenSection('repo_map', repoSummary.markdown),
      createTokenSection('similar_memories', similarMemoriesText),
      createTokenSection('session_summary', sessionWindow.summary ?? ''),
      createTokenSection('recent_events', recentEventsText),
    ],
    input.budgetTokens ?? DEFAULT_CONTEXT_TOKEN_BUDGET,
  );

  return {
    projectPath: input.projectPath,
    repoFiles: repoSummary.repoFiles,
    repoSymbols: repoSummary.repoSymbols,
    languages: repoSummary.languages,
    similarMemories: input.similarMemories.length,
    similarMemoriesText,
    sessionSummary: sessionWindow.summary,
    recentEventCount: sessionWindow.recentEvents.length,
    tokenReport,
    repoMapMarkdown: repoSummary.markdown,
  };
}
