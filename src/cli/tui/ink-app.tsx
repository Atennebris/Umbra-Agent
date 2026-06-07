import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { Box, Text, useApp, useInput } from 'ink';
import React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  DaemonStatus,
  MemorySettingsPayload,
  ProviderProfilePayload,
  ReviewResult,
  RunTaskPayload,
  SessionCompactionResult,
  ThreadPayload,
  WebSearchProviderPayload,
  WebSearchSettingsPayload,
} from '../../core/contracts.js';
import { buildSkillCreatePrompt } from '../../core/prompts.js';
import {
  type UsageDetailMode,
  getCompactSettings,
  getReviewSettings,
  getThemePreference,
  getUsageDetailMode,
  readRuntimePreferences,
  setCompactSettings,
  setDefaultRuntimeMode,
  setReviewSettings,
  setThemePreference,
  setUsageDetailMode,
} from '../../core/runtime-preferences.js';
import { writeDebugEvent } from '../../debug/runtime-debug.js';
import { createSkill, invokeSkill, loadSkills, runSkillScript } from '../../skills/skill-loader.js';
import {
  approveRunPermission,
  archiveThread,
  compactSession,
  createProviderProfile,
  createRun,
  createThread,
  deleteProviderProfile,
  detectImportableThreads,
  exportThread,
  forkThread,
  getLastUsage,
  getMemorySettings,
  getRun,
  getStatus,
  getThread,
  getWebSearchSettings,
  importThread,
  listProviderModels,
  listProviderProfiles,
  listProviderTypes,
  listThreads,
  readSessionEvents,
  resetMemories,
  resumeThread,
  reviewCode,
  stopRun,
  unarchiveThread,
  updateMemorySettings,
  updateProviderProfile,
  updateThreadSettings,
  updateWebSearchSettings,
} from '../http-client.js';
import { saveOAuthToken } from '../oauth/oauth-storage.js';
import { loginOpenAICodex } from '../oauth/openai-codex-oauth.js';
import { scaffoldProjectInstructions } from '../scaffold.js';
import { readClipboardText, writeClipboardText } from './clipboard.js';
import { parseDroppedPaths } from './drop-paths.js';
import { parseFileReferences } from './file-references.js';
import {
  InkChatBubble,
  InkKeyValueCard,
  InkMetricsPanel,
  InkReferenceOverlay,
  InkSlashOverlay,
  InkStatusLine,
} from './ink-cards.js';
import { InkMarkdown } from './ink-markdown.js';
import {
  type ProjectReferenceItem,
  applyAtSuggestion,
  getAtReferenceQuery,
  getAtSuggestions,
  loadProjectReferenceCatalog,
} from './project-reference-index.js';
import { enrichPromptWithReferences } from './referenced-context.js';
import {
  applyInlineSlashSuggestion,
  applySlashSuggestion,
  getAllSlashCommands,
  getInlineSlashSuggestions,
  getInputBadges,
  getSlashSuggestions,
  isThreadForkDialogCommand,
  isThreadResumeDialogCommand,
  parseSkillCommand,
  registerSkillCommands,
  slashCommands,
} from './session-view.js';
import {
  THEMES,
  THEME_NAMES,
  applyTheme,
  getCurrentThemeName,
  setCurrentThemeName,
  umbraTheme,
} from './theme.js';

type SessionEntry =
  | { id: string; kind: 'markdown'; title: string; markdown: string }
  | { id: string; kind: 'card'; title: string; entries: Array<[string, string]> }
  | { id: string; kind: 'thinking'; title: string; text: string }
  | {
      id: string;
      kind: 'citations';
      threadId: string | null;
      projectMemoryUsed: boolean;
      sessionSummaryUsed: boolean;
      entries: Array<{
        memoryId: string;
        sourceType: string;
        score: number | null;
        excerpt: string;
      }>;
    }
  | {
      id: string;
      kind: 'bubble';
      bubbleRole: 'user' | 'assistant' | 'system';
      title?: string | null;
      text: string;
      reasoning?: string | null;
      tone?: 'default' | 'muted' | 'danger';
      durationMs?: number;
      usage?: {
        inputTokens: number;
        outputTokens: number;
        reasoningTokens?: number;
        costEstimate?: number;
        mode: UsageDetailMode;
      };
    }
  | {
      id: string;
      kind: 'event';
      tone: 'info' | 'success' | 'danger';
      text: string;
      inputUsage?: { inputTokens: number; mode: UsageDetailMode };
    }
  | {
      id: string;
      kind: 'skill-invoke';
      skillName: string;
      args: string;
      status: 'running' | 'done' | 'failed';
    }
  | {
      id: string;
      kind: 'tool-call';
      toolName: string;
      action: string;
      status: 'running' | 'done' | 'failed';
      target: string;
      result: string;
      seqFirst?: boolean;
      seqLast?: boolean;
    }
  | { id: string; kind: 'banner'; flags?: string[] }
  | { id: string; kind: 'mode-badge'; mode: 'exec' | 'debug' };

type SessionLogEvent = {
  id: string;
  timestamp: string;
  type: string;
  payload: Record<string, unknown>;
};

type ProviderTypePayload = {
  value: string;
  label: string;
  defaultUrl: string;
  needsKey: boolean;
  keyOptional: boolean;
  keyHint: string;
  cloud: boolean;
  aliases: string[];
};

type ListedModel = {
  id: string;
  name: string;
  contextWindow: number | null;
  tags?: string[];
};

type ProviderDialogState =
  | {
      kind: 'permission-mode';
      selectedIndex: number;
      currentMode: 'agent' | 'full';
    }
  | {
      kind: 'provider-menu';
      selectedIndex: number;
    }
  | {
      kind: 'provider-list';
      query: string;
      selectedIndex: number;
      providers: ProviderTypePayload[];
      profiles: ProviderProfilePayload[];
    }
  | {
      kind: 'provider-profile-list';
      query: string;
      selectedIndex: number;
      profiles: ProviderProfilePayload[];
    }
  | {
      kind: 'provider-remove-list';
      query: string;
      selectedIndex: number;
      profiles: ProviderProfilePayload[];
    }
  | {
      kind: 'provider-method';
      provider: ProviderTypePayload;
      selectedIndex: number;
      clipboardPreview: string | null;
    }
  | {
      kind: 'provider-oauth';
      provider: ProviderTypePayload;
      message: string;
    }
  | {
      kind: 'provider-api-key';
      provider: ProviderTypePayload;
      value: string;
      cursor: number;
      clipboardPreview: string | null;
    }
  | {
      kind: 'provider-base-url';
      provider: ProviderTypePayload;
      apiKey: string;
      value: string;
      cursor: number;
      clipboardPreview: string | null;
    }
  | {
      kind: 'provider-custom';
      label: string;
      baseUrl: string;
      apiKey: string;
      activeField: 'label' | 'baseUrl' | 'apiKey' | 'confirm';
      cursor: number;
      clipboardPreview: string | null;
    }
  | {
      kind: 'model-list';
      query: string;
      selectedIndex: number;
      profile: ProviderProfilePayload;
      models: ListedModel[];
    }
  | {
      kind: 'thread-list';
      action: 'resume' | 'fork';
      query: string;
      selectedIndex: number;
      threads: ThreadPayload[];
    }
  | {
      kind: 'memory-settings';
      selectedIndex: number;
      runtimeSettings: MemorySettingsPayload;
      thread: ThreadPayload | null;
      confirmReset: 'thread' | 'project' | null;
    }
  | {
      kind: 'skill-create-name';
      value: string;
      cursor: number;
    }
  | {
      kind: 'skill-create-description';
      name: string;
      value: string;
      cursor: number;
    }
  | {
      kind: 'usage-toggle';
      selectedIndex: number;
      currentMode: UsageDetailMode;
    }
  | {
      kind: 'compact-settings-provider';
      query: string;
      selectedIndex: number;
      profiles: ProviderProfilePayload[];
      currentProvider: string | null;
      currentModel: string | null;
    }
  | {
      kind: 'compact-settings-model';
      query: string;
      selectedIndex: number;
      profile: ProviderProfilePayload;
      models: ListedModel[];
      currentModel: string | null;
    }
  | {
      kind: 'think-mode';
      selectedIndex: number;
      customInput: string;
      customCursor: number;
      currentValue: number | 'low' | 'medium' | 'high' | 'max' | null;
      thinkProfile: ThinkProfile;
    }
  | {
      kind: 'thread-mode';
      selectedIndex: number;
    }
  | {
      kind: 'review-settings-provider';
      query: string;
      selectedIndex: number;
      profiles: ProviderProfilePayload[];
      currentProvider: string | null;
      currentModel: string | null;
    }
  | {
      kind: 'review-settings-model';
      query: string;
      selectedIndex: number;
      profile: ProviderProfilePayload;
      models: ListedModel[];
      currentModel: string | null;
    }
  | {
      kind: 'reset-memories-confirm';
      step: 1 | 2;
      projectPath: string;
      threadId?: string;
    }
  | {
      kind: 'git-mode';
      selectedIndex: number;
      currentEnabled: boolean;
    }
  | {
      kind: 'web-mode';
      selectedIndex: number;
      currentMode: 'off' | 'cached' | 'live';
      currentProviderId: string;
      providers: WebSearchProviderPayload[];
    }
  | {
      kind: 'web-provider-menu';
      provider: WebSearchProviderPayload;
      selectedIndex: number;
    }
  | {
      kind: 'web-provider-api-key';
      provider: WebSearchProviderPayload;
      value: string;
      cursor: number;
      clipboardPreview: string | null;
    }
  | {
      kind: 'web-provider-base-url';
      provider: WebSearchProviderPayload;
      value: string;
      cursor: number;
      clipboardPreview: string | null;
    }
  | {
      kind: 'theme-select';
      selectedIndex: number;
      query: string;
      currentTheme: string;
    }
  | {
      kind: 'path-visibility';
      selectedIndex: number;
      currentVisible: boolean;
    }
  | {
      kind: 'no-provider-prompt';
      selectedIndex: number;
    };

export function UmbraInkApp({
  projectPath: initialProjectPath,
  initialMode,
  launchMode,
  launchFlags,
}: {
  projectPath: string;
  initialMode?: 'agent' | 'full' | 'plan' | 'exec';
  launchMode?: 'exec' | 'debug';
  launchFlags?: string[];
}) {
  const { exit } = useApp();
  const [projectPath, setProjectPath] = useState(initialProjectPath);
  const [buffer, setBuffer] = useState('');
  const [cursorPosition, setCursorPosition] = useState(0);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [runtimeMode, setRuntimeMode] = useState<'agent' | 'plan' | 'full' | 'exec'>(
    () => initialMode ?? readRuntimePreferences().defaultMode,
  );
  const [busy, setBusy] = useState(false);
  const [entries, setEntries] = useState<SessionEntry[]>(() => {
    return launchFlags
      ? [{ id: 'umbra-banner', kind: 'banner', flags: launchFlags }]
      : [{ id: 'umbra-banner', kind: 'banner' }];
  });
  const [error, setError] = useState<string | null>(null);
  const [skillsEpoch, setSkillsEpoch] = useState(0);
  const [activeSkillName, setActiveSkillName] = useState<string | null>(null);
  const prevBusyRef = useRef(false);
  const [daemonStatus, setDaemonStatus] = useState<DaemonStatus | null>(null);
  const [providerDialog, setProviderDialog] = useState<ProviderDialogState | null>(null);
  const [selectedOverlayIndex, setSelectedOverlayIndex] = useState(0);
  const [projectReferences, setProjectReferences] = useState<ProjectReferenceItem[]>([]);
  const [referenceCatalogReady, setReferenceCatalogReady] = useState(false);
  const [currentThread, setCurrentThread] = useState<ThreadPayload | null>(null);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [runtimeMemorySettings, setRuntimeMemorySettings] = useState<MemorySettingsPayload | null>(
    null,
  );
  const [activeRun, setActiveRun] = useState<RunTaskPayload | null>(null);
  const [runElapsedSec, setRunElapsedSec] = useState(0);
  const runStartedAtRef = useRef<number>(0);
  const [pendingPermission, setPendingPermission] = useState<{
    runId: string;
    approvalId: string;
    toolName: string;
    summary: string;
  } | null>(null);
  const [escConfirmPending, setEscConfirmPending] = useState(false);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [showCitations, setShowCitations] = useState(false);
  const [usageDetailMode, setUsageDetailMode_] = useState<UsageDetailMode>(() =>
    getUsageDetailMode(),
  );
  const usageDetailModeRef = useRef<UsageDetailMode>(usageDetailMode);
  const lastUserEntryIdRef = useRef<string | null>(null);
  const [usageStats, setUsageStats] = useState<{
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
    reasoningTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    requests: number;
    totalCost: number;
  } | null>(null);
  const draftThreadPromiseRef = useRef<Promise<ThreadPayload> | null>(null);
  const draftRestoreDoneRef = useRef(false);
  const [currentGoal, setCurrentGoal] = useState<string | null>(null);
  const [thinkBudget, setThinkBudget] = useState<number | 'low' | 'medium' | 'high' | 'max' | null>(
    null,
  );
  const [gitEnabled, setGitEnabled] = useState(false);
  const [showPath, setShowPath] = useState(false);
  const [activeThemeName, setActiveThemeName] = useState<string>(() => {
    const saved = getThemePreference();
    applyTheme(saved);
    setCurrentThemeName(saved);
    return saved;
  });

  const currentThreadId = currentThread?.id ?? null;
  const effectiveMemorySettings: MemorySettingsPayload | null = runtimeMemorySettings
    ? {
        useMemories: currentThread?.useMemories ?? runtimeMemorySettings.useMemories,
        generateMemories: currentThread?.generateMemories ?? runtimeMemorySettings.generateMemories,
        draftPersistence: runtimeMemorySettings.draftPersistence,
      }
    : null;

  const droppedPaths = parseDroppedPaths(buffer);
  const fileReferences = parseFileReferences(buffer);
  const badges = getInputBadges({ value: buffer, droppedPaths, fileReferences });
  const slashSuggestions = getSlashSuggestions(buffer);
  const inlineSlashSuggestions = getInlineSlashSuggestions(buffer);
  const atQuery = getAtReferenceQuery(buffer);
  const referenceSuggestions = getAtSuggestions(buffer, projectReferences);
  const slashOverlayVisible =
    providerDialog === null &&
    slashSuggestions.length > 0 &&
    buffer.trimStart().startsWith('/') &&
    atQuery === null;
  const inlineSlashOverlayVisible =
    providerDialog === null &&
    inlineSlashSuggestions.length > 0 &&
    atQuery === null &&
    !buffer.trimStart().startsWith('/');
  const referenceOverlayVisible = providerDialog === null && atQuery !== null;
  const activeOverlayItems = referenceOverlayVisible
    ? referenceSuggestions
    : inlineSlashOverlayVisible
      ? inlineSlashSuggestions
      : slashSuggestions;

  // Viewport scroll: show all entries from the visible start to the BOTTOM (bottom-anchored).
  // Ink re-renders its ENTIRE non-Static area on every state update. The taller that area is,
  // the further the cursor jumps — causing the "teleport" the user sees.
  // When a dialog is open we render ZERO history entries — the render area shrinks to only the
  // dialog + input + status bar (~20 lines) so arrow-key navigation causes no visible teleport.
  // History is still visible in the terminal scrollback above.
  const VIEWPORT_ENTRIES = 30; // idle: how many entries are kept in the live render area
  const BUSY_CLIP = 6; // during generation: keep render area small to reduce cursor travel
  const isScrolled = scrollOffset > 0 && !providerDialog;
  const effectiveViewport = busy ? BUSY_CLIP : VIEWPORT_ENTRIES;
  // When scrolled: end moves BACK by scrollOffset (no effectiveViewport floor — that was the
  // bug that prevented scrolling when entries < viewport). At least 1 entry stays visible.
  const scrollVisibleEnd =
    providerDialog !== null
      ? entries.length
      : isScrolled
        ? Math.max(1, entries.length - scrollOffset)
        : entries.length;
  const scrollVisibleStart =
    providerDialog !== null
      ? entries.length // dialog open → empty history slice, dialog nav won't teleport
      : Math.max(0, scrollVisibleEnd - effectiveViewport);
  const visibleEntries = entries.slice(scrollVisibleStart, scrollVisibleEnd);

  // Ghost hint: argument placeholder shown as dim text at end of input (only when cursor is at end)
  const ghostHint = useMemo(() => {
    if (cursorPosition !== buffer.length) return null;
    if (slashOverlayVisible) {
      return slashSuggestions[selectedOverlayIndex]?.argumentHint ?? null;
    }
    const trimmed = buffer.trimEnd();
    if (!trimmed.startsWith('/') || trimmed.includes(' ')) return null;
    const exact = getAllSlashCommands().find((c) => c.name === trimmed && c.argumentHint);
    return exact?.argumentHint ?? null;
  }, [buffer, cursorPosition, slashOverlayVisible, slashSuggestions, selectedOverlayIndex]);

  // Skill highlight: range in buffer to render in skillHighlight color
  const skillHighlight = useMemo((): { start: number; len: number } | null => {
    const trimmed = buffer.trimStart();

    // Start-of-buffer: /skill-name args
    if (trimmed.startsWith('/')) {
      const spaceIdx = trimmed.indexOf(' ');
      if (spaceIdx === -1) return null;
      const cmdPart = trimmed.slice(0, spaceIdx);
      const isSkill = getAllSlashCommands().some((c) => c.name === cmdPart && c.isSkill);
      if (!isSkill) return null;
      const leadingWs = buffer.length - trimmed.length;
      return { start: 0, len: leadingWs + spaceIdx };
    }

    // Inline: "prefix text /skill-name args" — find last space-preceded slash
    const lastSlash = buffer.lastIndexOf('/');
    if (lastSlash > 0 && buffer[lastSlash - 1] === ' ') {
      const afterSlash = buffer.slice(lastSlash + 1);
      const spaceAfter = afterSlash.indexOf(' ');
      if (spaceAfter !== -1) {
        const cmdPart = `/${afterSlash.slice(0, spaceAfter)}`;
        const isSkill = getAllSlashCommands().some((c) => c.name === cmdPart && c.isSkill);
        if (isSkill) return { start: lastSlash, len: 1 + spaceAfter };
      }
    }

    return null;
  }, [buffer]);

  useInput((input, key) => {
    // PageUp / PageDown — viewport scroll, always active (even during run)
    if (key.pageUp && !providerDialog) {
      const step = Math.max(3, Math.floor((process.stdout.rows ?? 24) / 4));
      const maxOffset = Math.max(0, entries.length - 1); // leave at least 1 entry visible
      setScrollOffset((prev) => Math.min(prev + step, maxOffset));
      return;
    }
    if (key.pageDown && !providerDialog) {
      const step = Math.max(3, Math.floor((process.stdout.rows ?? 24) / 4));
      setScrollOffset((prev) => Math.max(0, prev - step));
      return;
    }

    // ESC during an active run → two-stage interrupt confirmation
    if (key.escape && busy && activeRun?.status === 'running') {
      if (!escConfirmPending) {
        setEscConfirmPending(true);
      } else {
        setEscConfirmPending(false);
        void stopRun(activeRun.id).catch(() => {});
      }
      return;
    }

    // Cancel ESC-confirm with 'n'
    if (escConfirmPending && (input === 'n' || input === 'N')) {
      setEscConfirmPending(false);
      return;
    }

    // Handle pending permission approval (y / a / n / esc)
    if (pendingPermission && busy) {
      const p = pendingPermission;
      if (input === 'y' || input === 'Y') {
        setPendingPermission(null);
        void approveRunPermission(p.runId, p.approvalId, 'allow').catch(() => {});
      } else if (input === 'a' || input === 'A') {
        setPendingPermission(null);
        void approveRunPermission(p.runId, p.approvalId, 'allow_always').catch(() => {});
      } else if (input === 'n' || input === 'N' || key.escape) {
        setPendingPermission(null);
        void approveRunPermission(p.runId, p.approvalId, 'deny').catch(() => {});
      }
      return;
    }

    if (busy) {
      return;
    }

    if (providerDialog) {
      void handleProviderDialogInput(providerDialog, input, key, {
        setProviderDialog,
        appendEntries,
        replaceEntries: setEntries,
        refreshStatus,
        setRuntimeMode: applyRuntimeMode,
        projectPath,
        currentThread,
        setCurrentThread,
        setCurrentSessionId,
        setRuntimeMemorySettings,
        submitPrompt: runUserPrompt,
        resetSessionStats: () => setUsageStats(null),
        setThinkBudget: (v) => setThinkBudget(v),
        setUsageDetailMode: (m: UsageDetailMode) => {
          setUsageDetailMode_(m);
          try {
            setUsageDetailMode(m);
          } catch {}
          // Note: existing Static entries cannot be re-rendered due to Ink's Static limitation.
          // New entries after this toggle will correctly use the new mode.
        },
        setGitEnabled: (enabled: boolean) => setGitEnabled(enabled),
        setShowPath: (visible: boolean) => setShowPath(visible),
        setActiveThemeName: (name: string) => {
          applyTheme(name);
          setCurrentThemeName(name);
          setActiveThemeName(name);
          setThemePreference(name);
        },
        previewTheme: (name: string) => {
          applyTheme(name);
          setActiveThemeName(name);
        },
      });
      return;
    }

    // Ctrl+C: copy buffer to clipboard and clear line; exit only when already empty
    if (key.ctrl && input === 'c') {
      if (buffer.length > 0) {
        writeClipboardText(buffer);
        setBuffer('');
        setCursorPosition(0);
        setHistoryIndex(null);
      } else {
        exit();
      }
      return;
    }

    if (key.escape) {
      // If scrolled and not mid-run: reset scroll on ESC before anything else
      if (isScrolled && !busy) {
        setScrollOffset(0);
        return;
      }

      if (busy && activeRun) {
        if (escConfirmPending) {
          void stopRun(activeRun.id);
          setEscConfirmPending(false);
          appendEntries([
            {
              id: createEntryId(),
              kind: 'event',
              tone: 'danger',
              text: 'system> interrupting agent...',
            },
          ]);
        } else {
          setEscConfirmPending(true);
        }
        return;
      }

      setEscConfirmPending(false);
      if (buffer.length > 0) {
        setBuffer('');
        setCursorPosition(0);
        setHistoryIndex(null);
        setSelectedOverlayIndex(0);
      } else {
        exit();
      }
      return;
    }

    if (escConfirmPending && !busy) {
      setEscConfirmPending(false);
    }

    if (activeOverlayItems.length > 0) {
      if (key.upArrow) {
        setSelectedOverlayIndex((current) =>
          current <= 0 ? activeOverlayItems.length - 1 : current - 1,
        );
        return;
      }

      if (key.downArrow) {
        setSelectedOverlayIndex((current) =>
          current >= activeOverlayItems.length - 1 ? 0 : current + 1,
        );
        return;
      }

      if (key.tab) {
        const selectedItem = activeOverlayItems[selectedOverlayIndex] ?? activeOverlayItems[0];

        if (selectedItem) {
          setBuffer(
            (() => {
              const nextValue = referenceOverlayVisible
                ? applyAtSuggestion(buffer, selectedItem as ProjectReferenceItem)
                : inlineSlashOverlayVisible
                  ? applyInlineSlashSuggestion(
                      buffer,
                      selectedItem as (typeof inlineSlashSuggestions)[number],
                    )
                  : applySlashSuggestion(buffer, selectedItem as (typeof slashSuggestions)[number]);
              setCursorPosition(nextValue.length);
              return nextValue;
            })(),
          );
          setSelectedOverlayIndex(0);
        }
        return;
      }

      if (key.return && referenceOverlayVisible) {
        const selectedItem = activeOverlayItems[selectedOverlayIndex] ?? activeOverlayItems[0];

        if (selectedItem) {
          const nextValue = applyAtSuggestion(buffer, selectedItem as ProjectReferenceItem);
          setBuffer(nextValue);
          setCursorPosition(nextValue.length);
          setSelectedOverlayIndex(0);
          return;
        }
      }
    }

    if (key.leftArrow) {
      setCursorPosition((current) => Math.max(0, current - 1));
      return;
    }

    if (key.rightArrow) {
      setCursorPosition((current) => Math.min(buffer.length, current + 1));
      return;
    }

    if (key.upArrow) {
      const nextCursor = moveCursorVertical(buffer, cursorPosition, -1);

      if (nextCursor !== cursorPosition) {
        setCursorPosition(nextCursor);
        return;
      }

      if (history.length > 0) {
        const nextIndex =
          historyIndex === null ? history.length - 1 : Math.max(0, historyIndex - 1);
        const nextValue = history[nextIndex] ?? '';
        setHistoryIndex(nextIndex);
        setBuffer(nextValue);
        setCursorPosition(nextValue.length);
      }
      return;
    }

    if (key.downArrow) {
      const nextCursor = moveCursorVertical(buffer, cursorPosition, 1);

      if (nextCursor !== cursorPosition) {
        setCursorPosition(nextCursor);
        return;
      }

      if (history.length > 0) {
        if (historyIndex === null) {
          return;
        }

        const nextIndex = historyIndex + 1;
        const nextValue = nextIndex >= history.length ? '' : (history[nextIndex] ?? '');
        setHistoryIndex(nextIndex >= history.length ? null : nextIndex);
        setBuffer(nextValue);
        setCursorPosition(nextValue.length);
      }
      return;
    }

    if (key.return) {
      const value = buffer.trim();

      if (!value) {
        return;
      }

      if (value === '/clear') {
        // Codex-parity /clear: physically wipe the terminal screen (ANSI
        // escape) so old entries actually disappear, then create a fresh
        // thread on the backend so the next run starts with an isolated
        // sessionId.  Old thread stays in history but leaves the active view.
        setBuffer('');
        setCursorPosition(0);
        // ESC[2J  — erase entire screen
        // ESC[3J  — erase scrollback buffer
        // ESC[H   — move cursor to row 1, col 1
        process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
        void (async () => {
          try {
            const newThread = (await createThread({
              projectPath,
              title: 'New conversation',
              ...(effectiveMemorySettings
                ? {
                    useMemories: effectiveMemorySettings.useMemories,
                    generateMemories: effectiveMemorySettings.generateMemories,
                  }
                : {}),
            })) as ThreadPayload;
            setCurrentThread(newThread);
            setCurrentSessionId(newThread.sessionId);
            setEntries([]);
            setUsageStats(null);
            setError(null);
            draftThreadPromiseRef.current = null;
            writeDebugEvent({
              component: 'tui',
              level: 'info',
              message: 'transcript cleared — new thread created',
              data: { threadId: newThread.id, sessionId: newThread.sessionId },
            });
            // Single system marker confirming the fresh conversation
            setEntries([
              {
                id: createEntryId(),
                kind: 'event',
                tone: 'info',
                text: `system> new conversation started (thread ${newThread.id.slice(0, 8)})`,
              },
            ]);
          } catch (cause) {
            // Fallback: daemon unavailable — still clear the screen
            process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
            setEntries([]);
            setUsageStats(null);
            setError(null);
            setCurrentThread(null);
            setCurrentSessionId(null);
            const message = cause instanceof Error ? cause.message : String(cause);
            writeDebugEvent({
              component: 'tui',
              level: 'warn',
              message: '/clear fallback — daemon unavailable',
              data: { error: message },
            });
          }
        })();
        return;
      }

      if (value === '/new') {
        setBuffer('');
        setCursorPosition(0);
        void (async () => {
          try {
            const newThread = (await createThread({
              projectPath,
              title: 'Continued session',
              ...(effectiveMemorySettings
                ? {
                    useMemories: effectiveMemorySettings.useMemories,
                    generateMemories: effectiveMemorySettings.generateMemories,
                  }
                : {}),
            })) as ThreadPayload;
            setCurrentThread(newThread);
            setCurrentSessionId(newThread.sessionId);
            setUsageStats(null);
            setError(null);
            draftThreadPromiseRef.current = null;
            writeDebugEvent({
              component: 'tui',
              level: 'info',
              message: 'new session started — continuing transcript',
              data: { threadId: newThread.id, sessionId: newThread.sessionId },
            });
            setEntries((prev) => [
              ...prev,
              {
                id: createEntryId(),
                kind: 'event',
                tone: 'info',
                text: `system> new session context started (thread ${newThread.id.slice(0, 8)})`,
              },
            ]);
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
          }
        })();
        return;
      }

      if (value === '/agent') {
        setRuntimeMode('agent');
        setBuffer('');
        setCursorPosition(0);
        appendEntries([
          {
            id: createEntryId(),
            kind: 'event',
            tone: 'info',
            text: 'system> Switched to agent mode.',
          },
        ]);
        return;
      }

      if (value === '/permissions') {
        setBuffer('');
        setCursorPosition(0);
        setProviderDialog({
          kind: 'permission-mode',
          selectedIndex: 0,
          currentMode: runtimeMode === 'full' || runtimeMode === 'exec' ? 'full' : 'agent',
        });
        return;
      }

      if (value === '/git') {
        setBuffer('');
        setCursorPosition(0);
        setProviderDialog({
          kind: 'git-mode',
          selectedIndex: 0,
          currentEnabled: gitEnabled,
        });
        return;
      }

      if (value === '/web') {
        setBuffer('');
        setCursorPosition(0);
        void (async () => {
          try {
            const settings = (await getWebSearchSettings()) as WebSearchSettingsPayload;
            const modeOrder = ['off', 'cached', 'live'] as const;
            const modeIndex = modeOrder.indexOf(settings.mode);
            setProviderDialog({
              kind: 'web-mode',
              selectedIndex: modeIndex >= 0 ? modeIndex : 0,
              currentMode: settings.mode,
              currentProviderId: settings.providerId,
              providers: settings.availableProviders,
            });
          } catch {
            setProviderDialog({
              kind: 'web-mode',
              selectedIndex: 0,
              currentMode: 'off',
              currentProviderId: 'ddg',
              providers: [],
            });
          }
        })();
        return;
      }

      if (value === '/path') {
        setBuffer('');
        setCursorPosition(0);
        setProviderDialog({
          kind: 'path-visibility',
          selectedIndex: 0,
          currentVisible: showPath,
        });
        return;
      }

      if (value === '/theme') {
        setBuffer('');
        setCursorPosition(0);
        setProviderDialog({
          kind: 'theme-select',
          selectedIndex: THEME_NAMES.indexOf(getCurrentThemeName()),
          query: '',
          currentTheme: getCurrentThemeName(),
        });
        return;
      }

      if (value === '/plan') {
        setRuntimeMode('plan');
        setBuffer('');
        setCursorPosition(0);
        appendEntries([
          {
            id: createEntryId(),
            kind: 'event',
            tone: 'info',
            text: 'system> mode plan',
          },
        ]);
        writeDebugEvent({
          component: 'tui',
          level: 'info',
          message: 'mode changed',
          data: {
            mode: 'plan',
          },
        });
        return;
      }

      if (value === '/full') {
        setRuntimeMode('full');
        setBuffer('');
        setCursorPosition(0);
        appendEntries([
          {
            id: createEntryId(),
            kind: 'event',
            tone: 'info',
            text: 'system> mode full context (compression disabled)',
          },
        ]);
        writeDebugEvent({
          component: 'tui',
          level: 'info',
          message: 'mode changed',
          data: {
            mode: 'full',
          },
        });
        return;
      }

      if (value === '/providers') {
        setBuffer('');
        setCursorPosition(0);
        setProviderDialog({ kind: 'provider-menu', selectedIndex: 0 });
        return;
      }

      if (value === '/provider connect' || value === '/provider add') {
        setBuffer('');
        setCursorPosition(0);
        void openProviderDialog(setProviderDialog).catch((cause: unknown) => {
          reportDialogFailure(cause, setError, appendEntries, 'provider connect dialog failed');
        });
        writeDebugEvent({
          component: 'tui',
          level: 'info',
          message: 'provider connect dialog opened',
        });
        return;
      }

      if (
        value === '/thread' ||
        value === '/threads' ||
        value === '/sessions' ||
        value === '/resume'
      ) {
        setBuffer('');
        setCursorPosition(0);
        setProviderDialog({ kind: 'thread-mode', selectedIndex: 0 });
        writeDebugEvent({
          component: 'tui',
          level: 'info',
          message: 'thread menu dialog opened',
        });
        return;
      }

      if (value.startsWith('/thread archive')) {
        setBuffer('');
        setCursorPosition(0);
        void (async () => {
          try {
            const arg = value.slice('/thread archive'.length).trim();
            const threadId = arg || currentThread?.id;
            if (!threadId) {
              appendEntries([
                {
                  id: createEntryId(),
                  kind: 'event',
                  tone: 'danger',
                  text: 'system> no active thread to archive',
                },
              ]);
              return;
            }
            const archived = (await archiveThread(threadId)) as ThreadPayload;
            if (threadId === currentThread?.id) {
              setCurrentThread(null);
              setCurrentSessionId(null);
            }
            appendEntries([
              {
                id: createEntryId(),
                kind: 'event',
                tone: 'success',
                text: `system> thread archived: ${archived.title}`,
              },
            ]);
          } catch (cause) {
            reportDialogFailure(cause, setError, appendEntries, 'thread archive failed');
          }
        })();
        return;
      }

      if (value.startsWith('/thread unarchive')) {
        const threadId = value.slice('/thread unarchive'.length).trim();
        if (!threadId) {
          appendEntries([
            {
              id: createEntryId(),
              kind: 'event',
              tone: 'danger',
              text: 'system> please provide a thread id: /thread unarchive <id>',
            },
          ]);
          return;
        }
        setBuffer('');
        setCursorPosition(0);
        void (async () => {
          try {
            const unarchived = (await unarchiveThread(threadId)) as ThreadPayload;
            appendEntries([
              {
                id: createEntryId(),
                kind: 'event',
                tone: 'success',
                text: `system> thread unarchived: ${unarchived.title}`,
              },
            ]);
          } catch (cause) {
            reportDialogFailure(cause, setError, appendEntries, 'thread unarchive failed');
          }
        })();
        return;
      }

      if (value === '/thread export') {
        if (!currentThread) {
          appendEntries([
            {
              id: createEntryId(),
              kind: 'event',
              tone: 'danger',
              text: 'system> no active thread to export',
            },
          ]);
          return;
        }
        setBuffer('');
        setCursorPosition(0);
        void (async () => {
          try {
            const result = (await exportThread(currentThread.id)) as { exportPath: string };
            appendEntries([
              {
                id: createEntryId(),
                kind: 'event',
                tone: 'success',
                text: `system> thread exported to ${result.exportPath}`,
              },
            ]);
          } catch (cause) {
            reportDialogFailure(cause, setError, appendEntries, 'thread export failed');
          }
        })();
        return;
      }

      if (value === '/thread detect' || value === '/threads detect') {
        setBuffer('');
        setCursorPosition(0);
        void (async () => {
          try {
            const result = (await detectImportableThreads()) as {
              candidates: Array<{ filePath: string; fileName: string }>;
            };
            if (result.candidates.length === 0) {
              appendEntries([
                {
                  id: createEntryId(),
                  kind: 'event',
                  tone: 'info',
                  text: 'system> no importable session logs detected in home dir',
                },
              ]);
              return;
            }
            appendEntries([
              {
                id: createEntryId(),
                kind: 'event',
                tone: 'success',
                text: `system> detected ${result.candidates.length} potential session logs. Use /thread import <path>`,
              },
              ...result.candidates.map((c) => ({
                id: createEntryId(),
                kind: 'event' as const,
                tone: 'info' as const,
                text: `  - ${c.filePath}`,
              })),
            ]);
          } catch (cause) {
            reportDialogFailure(cause, setError, appendEntries, 'thread detect failed');
          }
        })();
        return;
      }

      if (value.startsWith('/thread import') || value.startsWith('/threads import')) {
        const filePath = value
          .slice(
            value.startsWith('/thread import') ? '/thread import'.length : '/threads import'.length,
          )
          .trim();
        if (!filePath) {
          appendEntries([
            {
              id: createEntryId(),
              kind: 'event',
              tone: 'danger',
              text: `system> please provide a file path: ${value.startsWith('/thread import') ? '/thread import' : '/threads import'} <path>`,
            },
          ]);
          return;
        }
        setBuffer('');
        setCursorPosition(0);
        void (async () => {
          try {
            const thread = (await importThread({ filePath, projectPath })) as ThreadPayload;
            appendEntries([
              {
                id: createEntryId(),
                kind: 'event',
                tone: 'success',
                text: `system> session imported as thread: ${thread.title}`,
              },
            ]);
          } catch (cause) {
            reportDialogFailure(cause, setError, appendEntries, 'thread import failed');
          }
        })();
        return;
      }

      if (isThreadResumeDialogCommand(value) || isThreadForkDialogCommand(value)) {
        setBuffer('');
        setCursorPosition(0);
        setProviderDialog({ kind: 'thread-mode', selectedIndex: 0 });
        return;
      }

      if (value === '/reset memories') {
        setBuffer('');
        setCursorPosition(0);
        setProviderDialog({
          kind: 'reset-memories-confirm',
          step: 1,
          projectPath,
          ...(currentThread?.id ? { threadId: currentThread.id } : {}),
        });
        return;
      }

      if (value === '/memories') {
        setBuffer('');
        setCursorPosition(0);
        void openMemorySettingsDialog(
          projectPath,
          currentThread,
          runtimeMemorySettings,
          setProviderDialog,
        ).catch((cause: unknown) => {
          reportDialogFailure(cause, setError, appendEntries, 'memory settings dialog failed');
        });
        return;
      }

      if (value === '/provider use') {
        setBuffer('');
        setCursorPosition(0);
        void openProviderProfileDialog(setProviderDialog, appendEntries).catch((cause: unknown) => {
          reportDialogFailure(cause, setError, appendEntries, 'provider selection dialog failed');
        });
        writeDebugEvent({
          component: 'tui',
          level: 'info',
          message: 'provider selection dialog opened',
        });
        return;
      }

      if (value === '/provider models' || value === '/models') {
        setBuffer('');
        setCursorPosition(0);
        void openModelDialog(setProviderDialog, appendEntries).catch((cause: unknown) => {
          reportDialogFailure(cause, setError, appendEntries, 'model selection dialog failed');
        });
        writeDebugEvent({
          component: 'tui',
          level: 'info',
          message: 'model selection dialog opened',
        });
        return;
      }

      if (value === '/skill-create') {
        setBuffer('');
        setCursorPosition(0);
        setProviderDialog({ kind: 'skill-create-name', value: '', cursor: 0 });
        return;
      }

      if (value === '/mem on' || value === '/mem off') {
        setBuffer('');
        setCursorPosition(0);
        const next = value === '/mem on';
        setShowCitations(next);
        appendEntries([
          {
            id: createEntryId(),
            kind: 'event',
            tone: 'info',
            text: `system> memory panel ${next ? 'on — citations visible after next response' : 'off'}`,
          },
        ]);
        return;
      }

      if (value === '/usage') {
        setBuffer('');
        setCursorPosition(0);
        const modeIdx = usageDetailMode === 'off' ? 0 : usageDetailMode === 'compact' ? 1 : 2;
        setProviderDialog({
          kind: 'usage-toggle',
          selectedIndex: modeIdx,
          currentMode: usageDetailMode,
        });
        return;
      }

      if (value.startsWith('/goal')) {
        setBuffer('');
        setCursorPosition(0);
        const arg = value.slice('/goal'.length).trim();
        if (!arg) {
          appendEntries([
            {
              id: createEntryId(),
              kind: 'event',
              tone: 'info',
              text: `system> current goal: ${currentGoal ?? '(none)'}`,
            },
          ]);
          return;
        }
        if (arg === 'clear') {
          setCurrentGoal(null);
          appendEntries([
            {
              id: createEntryId(),
              kind: 'event',
              tone: 'info',
              text: 'system> goal cleared',
            },
          ]);
          return;
        }
        setCurrentGoal(arg);
        appendEntries([
          {
            id: createEntryId(),
            kind: 'event',
            tone: 'success',
            text: `system> goal set: ${arg}`,
          },
        ]);
        return;
      }

      if (value.startsWith('/think')) {
        setBuffer('');
        setCursorPosition(0);
        const arg = value.slice('/think'.length).trim();
        if (!arg) {
          const profile = detectThinkProfile(daemonStatus?.activeProvider.model ?? null);
          const opts = getThinkOptions(profile);
          setProviderDialog({
            kind: 'think-mode',
            thinkProfile: profile,
            selectedIndex: thinkBudgetToIndex(thinkBudget, opts),
            customInput: typeof thinkBudget === 'number' ? String(thinkBudget) : '',
            customCursor: typeof thinkBudget === 'number' ? String(thinkBudget).length : 0,
            currentValue: thinkBudget,
          });
          return;
        }
        if (arg === 'off' || arg === '0') {
          setThinkBudget(null);
          appendEntries([
            {
              id: createEntryId(),
              kind: 'event',
              tone: 'info',
              text: 'system> extended thinking disabled',
            },
          ]);
          return;
        }
        // Effort level (Anthropic adaptive / OpenAI reasoning_effort / Mistral magistral)
        if (arg === 'low' || arg === 'medium' || arg === 'high' || arg === 'max') {
          setThinkBudget(arg);
          const profile = detectThinkProfile(daemonStatus?.activeProvider.model ?? null);
          const profileNote =
            profile === 'mistral-magistral'
              ? 'reasoning_effort: high + temperature: 1.0'
              : profile === 'openai-o'
                ? `reasoning_effort: ${arg}`
                : 'Anthropic budget_tokens mapped';
          appendEntries([
            {
              id: createEntryId(),
              kind: 'event',
              tone: 'success',
              text: `system> thinking effort: ${arg}  (${profileNote})`,
            },
          ]);
          return;
        }
        // Numeric budget_tokens (Anthropic direct)
        const budget = Number.parseInt(arg, 10);
        if (!Number.isFinite(budget) || budget <= 0) {
          appendEntries([
            {
              id: createEntryId(),
              kind: 'event',
              tone: 'danger',
              text: 'system> usage: /think low|medium|high|max  or  /think <N tokens>  or  /think off',
            },
          ]);
          return;
        }
        setThinkBudget(budget);
        appendEntries([
          {
            id: createEntryId(),
            kind: 'event',
            tone: 'success',
            text: `system> thinking enabled — budget: ${budget.toLocaleString()} tokens (Anthropic)`,
          },
        ]);
        return;
      }

      if (value === '/compact settings') {
        setBuffer('');
        setCursorPosition(0);
        void openCompactSettingsDialog(setProviderDialog, appendEntries).catch((cause: unknown) => {
          reportDialogFailure(cause, setError, appendEntries, 'compact settings dialog failed');
        });
        return;
      }

      if (value === '/review settings') {
        setBuffer('');
        setCursorPosition(0);
        void openReviewSettingsDialog(setProviderDialog, appendEntries).catch((cause: unknown) => {
          reportDialogFailure(cause, setError, appendEntries, 'review settings dialog failed');
        });
        return;
      }

      setBusy(true);
      setScrollOffset(0); // return to bottom when submitting
      runStartedAtRef.current = Date.now();
      setRunElapsedSec(0);
      setHistory((current) => [...current, value].slice(-100));
      setHistoryIndex(null);
      setBuffer('');
      setCursorPosition(0);
      const mainUserEventId = createEntryId();
      lastUserEntryIdRef.current = mainUserEventId;
      appendEntries([
        {
          id: mainUserEventId,
          kind: 'event',
          tone: 'info',
          text: `user> ${value}`,
        },
      ]);
      writeDebugEvent({
        component: 'tui',
        level: 'info',
        message: 'prompt submitted',
        data: {
          mode: runtimeMode,
          prompt: value.startsWith('/') ? value : undefined,
        },
      });
      let _mainSkillInvokeId: string | null = null;
      void handlePrompt(value, {
        runtimeMode,
        currentThread,
        currentSessionId,
        projectPath,
        projectReferences,
        fileReferences,
        memorySettings: effectiveMemorySettings,
        goalContext: currentGoal,
        thinkBudget,
        gitEnabled,
        onGitToggle: setGitEnabled,
        onSkillFound: (skillName, args) => {
          setActiveSkillName(skillName);
          _mainSkillInvokeId = createEntryId();
          appendEntries([
            {
              id: _mainSkillInvokeId,
              kind: 'skill-invoke',
              skillName,
              args,
              status: 'running',
            },
          ]);
        },
      })
        .then((next) => {
          if (_mainSkillInvokeId) {
            setEntries((prev) =>
              prev.map((e) =>
                e.id === _mainSkillInvokeId && e.kind === 'skill-invoke'
                  ? { ...e, status: 'done' }
                  : e,
              ),
            );
          }
          if (next.kind === 'entries') {
            if (next.replaceEntries) {
              setEntries(next.entries);
            } else {
              appendEntries(next.entries);
            }
            if (next.thread) {
              setCurrentThread(next.thread);
            }
            if (next.sessionId) {
              setCurrentSessionId(next.sessionId);
            }
            setBusy(false);
            void refreshStatus();
          } else {
            setActiveRun(next.run);
            if (next.run.threadId) {
              void syncCurrentThread(next.run.threadId);
            }
            if (next.run.sessionId) {
              setCurrentSessionId(next.run.sessionId);
            }
            void watchRun(next.run.id);
          }
          setError(null);
          writeDebugEvent({
            component: 'tui',
            level: 'info',
            message: 'prompt completed',
            data: {
              kind: next.kind,
              sessionId:
                next.kind === 'entries'
                  ? (next.sessionId ?? currentSessionId)
                  : (next.run.sessionId ?? currentSessionId),
            },
          });
          if (effectiveMemorySettings?.draftPersistence && currentThreadId) {
            void clearDraftForThread(currentThreadId);
          }
        })
        .catch((cause: unknown) => {
          const message = cause instanceof Error ? cause.message : String(cause);
          setError(message);
          appendEntries([
            {
              id: createEntryId(),
              kind: 'event',
              tone: 'danger',
              text: `error> ${message}`,
            },
          ]);
          writeDebugEvent({
            component: 'tui',
            level: 'error',
            message: 'prompt failed',
            data: {
              error: message,
            },
          });
          setBusy(false);
          setActiveRun(null);
          void refreshStatus();
        });
      return;
    }

    // ── Ctrl+V — paste clipboard at cursor ───────────────────────────────
    if (key.ctrl && input === 'v') {
      void readClipboardText().then((text) => {
        if (!text) return;
        setBuffer(
          (current) => `${current.slice(0, cursorPosition)}${text}${current.slice(cursorPosition)}`,
        );
        setCursorPosition((current) => current + text.length);
        setHistoryIndex(null);
      });
      return;
    }

    // ── Ctrl+A — jump to start of line ───────────────────────────────────
    if (key.ctrl && input === 'a') {
      setCursorPosition(0);
      return;
    }

    // ── Ctrl+E — jump to end of line ─────────────────────────────────────
    if (key.ctrl && input === 'e') {
      setCursorPosition(buffer.length);
      return;
    }

    // ── Ctrl+K — kill from cursor to end, copy to clipboard ──────────────
    if (key.ctrl && input === 'k') {
      const killed = buffer.slice(cursorPosition);
      if (killed.length > 0) writeClipboardText(killed);
      setBuffer((current) => current.slice(0, cursorPosition));
      return;
    }

    // ── Ctrl+U — kill from start to cursor, copy to clipboard ────────────
    if (key.ctrl && input === 'u') {
      const killed = buffer.slice(0, cursorPosition);
      if (killed.length > 0) writeClipboardText(killed);
      setBuffer((current) => current.slice(cursorPosition));
      setCursorPosition(0);
      return;
    }

    // ── Ctrl+W — kill word backwards, copy to clipboard ──────────────────
    if (key.ctrl && input === 'w') {
      const before = buffer.slice(0, cursorPosition);
      const after = buffer.slice(cursorPosition);
      const trimmed = before.trimEnd();
      const spaceIdx = trimmed.lastIndexOf(' ');
      const newBefore = spaceIdx === -1 ? '' : trimmed.slice(0, spaceIdx + 1);
      const killed = before.slice(newBefore.length);
      if (killed.length > 0) writeClipboardText(killed);
      setBuffer(newBefore + after);
      setCursorPosition(newBefore.length);
      return;
    }

    // ── Ctrl+← / Ctrl+→ — jump word by word ─────────────────────────────
    if (key.ctrl && key.leftArrow) {
      // move to start of previous word
      let pos = cursorPosition;
      while (pos > 0 && buffer[pos - 1] === ' ') pos--;
      while (pos > 0 && buffer[pos - 1] !== ' ') pos--;
      setCursorPosition(pos);
      return;
    }

    if (key.ctrl && key.rightArrow) {
      // move to end of next word
      let pos = cursorPosition;
      while (pos < buffer.length && buffer[pos] === ' ') pos++;
      while (pos < buffer.length && buffer[pos] !== ' ') pos++;
      setCursorPosition(pos);
      return;
    }

    if (key.backspace || key.delete) {
      if (key.backspace) {
        setBuffer((current) =>
          cursorPosition <= 0
            ? current
            : `${current.slice(0, cursorPosition - 1)}${current.slice(cursorPosition)}`,
        );
        setCursorPosition((current) => Math.max(0, current - 1));
        return;
      }

      setBuffer((current) =>
        cursorPosition >= current.length
          ? current
          : `${current.slice(0, cursorPosition)}${current.slice(cursorPosition + 1)}`,
      );
      return;
    }

    if (!key.ctrl && !key.meta && input) {
      setBuffer(
        (current) => `${current.slice(0, cursorPosition)}${input}${current.slice(cursorPosition)}`,
      );
      setCursorPosition((current) => current + input.length);
      setHistoryIndex(null);
      setSelectedOverlayIndex(0);
    }
  });

  // Live chronometer — ticks every second while run is active
  useEffect(() => {
    if (!busy) return;
    // Tick immediately to show 0s, then every 1s
    setRunElapsedSec(Math.floor((Date.now() - runStartedAtRef.current) / 1000));
    const tick = setInterval(() => {
      setRunElapsedSec(Math.floor((Date.now() - runStartedAtRef.current) / 1000));
    }, 1000);
    return () => clearInterval(tick);
  }, [busy]);

  useEffect(() => {
    void refreshStatus();
    const timer = setInterval(() => {
      void refreshStatus();
    }, 30000);

    return () => {
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const payload = (await listProviderProfiles()) as { profiles: ProviderProfilePayload[] };
        if (!cancelled && payload.profiles.length === 0) {
          setProviderDialog({ kind: 'no-provider-prompt', selectedIndex: 0 });
        }
      } catch {}
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    void loadProjectReferenceCatalog(projectPath).then((items) => {
      if (!cancelled) {
        setProjectReferences(items);
        setReferenceCatalogReady(true);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [projectPath]);

  // Register skill-based slash commands on mount, project change, or after skill creation
  // biome-ignore lint/correctness/useExhaustiveDependencies: skillsEpoch is an epoch counter — intentional trigger, not a value used inside the effect
  useEffect(() => {
    try {
      const { skills } = loadSkills({ projectPath });
      registerSkillCommands(skills);
      writeDebugEvent({
        component: 'tui',
        level: 'info',
        message: 'skill commands registered',
        data: { count: skills.length, projectPath },
      });
    } catch {
      // skills are optional; failure must not crash the TUI
    }
  }, [projectPath, skillsEpoch]);

  useEffect(() => {
    usageDetailModeRef.current = usageDetailMode;
  }, [usageDetailMode]);

  // Reload skills and clear active skill name when a run completes
  useEffect(() => {
    if (prevBusyRef.current && !busy) {
      setActiveSkillName(null);
      setSkillsEpoch((n) => n + 1);
    }
    prevBusyRef.current = busy;
  }, [busy]);

  useEffect(() => {
    let cancelled = false;

    void getMemorySettings()
      .then((payload) => {
        if (!cancelled) {
          setRuntimeMemorySettings(payload as MemorySettingsPayload);
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, []);

  // Session stats are accumulated locally from each completed run (not polled from daemon)
  // so the panel shows stats for the current conversation only, not all-time usage.

  useEffect(() => {
    if (draftRestoreDoneRef.current) {
      return;
    }

    draftRestoreDoneRef.current = true;
    // Restore the latest draft if available to satisfy Codex-parity requirement.
    void restoreLatestDraft(projectPath);
  }, [projectPath]);

  useEffect(() => {
    if (!effectiveMemorySettings?.draftPersistence || busy) {
      return;
    }

    if (!buffer.trim()) {
      return;
    }

    if (buffer.trimStart().startsWith('/')) {
      return;
    }

    void ensureDraftThread().then((thread) => {
      void saveDraftForThread(thread, buffer);
    });
  }, [buffer, busy, effectiveMemorySettings?.draftPersistence]);

  return (
    <Box flexDirection="column">
      <Box flexDirection="column">
        {visibleEntries.map((entry) => (
          <MemoSessionEntryView key={entry.id} entry={entry} />
        ))}
      </Box>
      {activeRun ? <LiveRunView run={activeRun} /> : null}
      {isScrolled ? (
        <Box>
          <Text color={umbraTheme.warning} bold>
            {'── SCROLL '}
          </Text>
          <Text
            color={umbraTheme.muted}
          >{`[${scrollVisibleStart + 1}–${scrollVisibleEnd} of ${entries.length}]  PageDown / Esc — scroll down`}</Text>
        </Box>
      ) : null}
      {escConfirmPending ? (
        <Box marginTop={1} flexDirection="column">
          <Text color={umbraTheme.warning}>
            {'[!] '}press <Text bold>ESC</Text> again to interrupt, or <Text bold>N</Text> to
            cancel.
          </Text>
        </Box>
      ) : null}
      {pendingPermission ? (
        <PermissionApprovalView
          toolName={pendingPermission.toolName}
          summary={pendingPermission.summary}
        />
      ) : null}
      {providerDialog ? <ProviderDialogView state={providerDialog} /> : null}
      {slashOverlayVisible ? (
        <InkSlashOverlay commands={slashSuggestions} selectedIndex={selectedOverlayIndex} />
      ) : null}
      {inlineSlashOverlayVisible ? (
        <InkSlashOverlay commands={inlineSlashSuggestions} selectedIndex={selectedOverlayIndex} />
      ) : null}
      {referenceOverlayVisible ? (
        <InkReferenceOverlay
          items={referenceSuggestions}
          selectedIndex={selectedOverlayIndex}
          statusText={
            !referenceCatalogReady
              ? 'indexing project resources...'
              : referenceSuggestions.length === 0
                ? `no matches for @${atQuery ?? ''}`
                : `${referenceSuggestions.length} matches`
          }
        />
      ) : null}
      <Box marginTop={1} flexDirection="column">
        <InputLine
          value={buffer}
          cursorPosition={cursorPosition}
          muted={busy}
          {...(!busy && ghostHint ? { ghost: ghostHint } : {})}
          {...(skillHighlight
            ? { highlightStart: skillHighlight.start, highlightLen: skillHighlight.len }
            : {})}
        />
        {busy ? (
          <Box>
            <Text color={umbraTheme.warning}>{'  '}</Text>
            <BusySpinner />
            <Text color={umbraTheme.warning}> </Text>
            {activeSkillName ? (
              <>
                <Text bold color={umbraTheme.skillHighlight}>{`◆ /${activeSkillName}`}</Text>
                <Text color={umbraTheme.frameDim}>{' · '}</Text>
              </>
            ) : null}
            <Text color={umbraTheme.muted}>{formatElapsed(runElapsedSec * 1000)}</Text>
          </Box>
        ) : null}
        {badges.length > 0 ? (
          <Text color={umbraTheme.muted}>{`[${badges.join(' | ')}]`}</Text>
        ) : null}
      </Box>
      {launchMode ? (
        <Box marginTop={0}>
          <Text color={umbraTheme.warning} bold>
            {launchMode === 'exec' ? '! EXEC MODE — autonomous, no confirmations' : '! DEBUG MODE'}
          </Text>
        </Box>
      ) : null}
      <InkStatusLine
        daemon={daemonStatus ? 'online' : 'offline'}
        cwd={truncateCwd(projectPath)}
        mode={runtimeMode === 'full' ? 'agent' : runtimeMode === 'exec' ? 'exec' : runtimeMode}
        provider={daemonStatus?.activeProvider.label ?? 'none'}
        model={daemonStatus?.activeProvider.model ?? 'none'}
        web={
          daemonStatus?.webSearch.mode === 'off'
            ? 'off'
            : `${daemonStatus?.webSearch.mode ?? 'off'}:${WEB_PROVIDER_LABELS[daemonStatus?.webSearch.providerId ?? ''] ?? daemonStatus?.webSearch.providerId ?? 'none'}`
        }
        showPath={showPath}
        goal={currentGoal}
        thinkBudget={thinkBudget}
        lastRequest={daemonStatus?.lastRequestUsage ?? null}
      />
      {usageDetailMode !== 'off' ? (
        <InkMetricsPanel mode={usageDetailMode} stats={usageStats} />
      ) : null}
    </Box>
  );

  function appendEntries(nextEntries: SessionEntry[]) {
    setEntries((current) => [...current, ...nextEntries]);
  }

  function runUserPrompt(value: string) {
    setBusy(true);
    runStartedAtRef.current = Date.now();
    setRunElapsedSec(0);
    setHistory((current) => [...current, value].slice(-100));
    setHistoryIndex(null);
    setBuffer('');
    setCursorPosition(0);
    const userEventId = createEntryId();
    lastUserEntryIdRef.current = userEventId;
    appendEntries([{ id: userEventId, kind: 'event', tone: 'info', text: `user> ${value}` }]);

    let skillInvokeId: string | null = null;

    function markSkillDone(status: 'done' | 'failed') {
      if (!skillInvokeId) return;
      setEntries((prev) =>
        prev.map((e) =>
          e.id === skillInvokeId && e.kind === 'skill-invoke' ? { ...e, status } : e,
        ),
      );
    }

    void handlePrompt(value, {
      runtimeMode,
      currentThread,
      currentSessionId,
      projectPath,
      projectReferences,
      fileReferences: parseFileReferences(''),
      memorySettings: effectiveMemorySettings,
      goalContext: currentGoal,
      thinkBudget,
      gitEnabled,
      onGitToggle: setGitEnabled,
      onSkillFound: (skillName, args) => {
        setActiveSkillName(skillName);
        skillInvokeId = createEntryId();
        appendEntries([
          {
            id: skillInvokeId,
            kind: 'skill-invoke',
            skillName,
            args,
            status: 'running',
          },
        ]);
      },
    })
      .then((next) => {
        markSkillDone('done');
        if (next.kind === 'entries') {
          if (next.replaceEntries) setEntries(next.entries);
          else appendEntries(next.entries);
          if (next.thread) setCurrentThread(next.thread);
          if (next.sessionId) setCurrentSessionId(next.sessionId);
          setBusy(false);
          void refreshStatus();
        } else {
          setActiveRun(next.run);
          if (next.run.threadId) void syncCurrentThread(next.run.threadId);
          if (next.run.sessionId) setCurrentSessionId(next.run.sessionId);
          void watchRun(next.run.id);
        }
      })
      .catch((cause: unknown) => {
        markSkillDone('failed');
        reportDialogFailure(cause, setError, appendEntries, 'prompt failed');
        setBusy(false);
      });
  }

  function applyRuntimeMode(mode: 'agent' | 'full') {
    setRuntimeMode(mode);
    try {
      setDefaultRuntimeMode(mode);
    } catch {}
  }

  async function syncCurrentThread(threadId: string) {
    try {
      const thread = (await getThread(threadId, projectPath)) as ThreadPayload;
      setCurrentThread(thread);
      setCurrentSessionId(thread.sessionId);
    } catch {}
  }

  async function ensureDraftThread(): Promise<ThreadPayload> {
    if (currentThread) {
      return currentThread;
    }

    if (draftThreadPromiseRef.current) {
      return draftThreadPromiseRef.current;
    }

    draftThreadPromiseRef.current = (async () => {
      const created = (await createThread({
        projectPath,
        title: 'Draft thread',
        ...(effectiveMemorySettings
          ? {
              useMemories: effectiveMemorySettings.useMemories,
              generateMemories: effectiveMemorySettings.generateMemories,
            }
          : {}),
      })) as ThreadPayload;
      setCurrentThread(created);
      setCurrentSessionId(created.sessionId);
      return created;
    })();

    try {
      return await draftThreadPromiseRef.current;
    } finally {
      draftThreadPromiseRef.current = null;
    }
  }

  async function clearAllDrafts(targetProjectPath: string) {
    try {
      const payload = (await listThreads({
        projectPath: targetProjectPath,
        limit: 20,
      })) as { threads: ThreadPayload[] };

      for (const thread of payload.threads) {
        if (thread.draftPath) {
          await fs.rm(thread.draftPath, { force: true }).catch(() => {});
        }
      }
    } catch {}
  }

  async function restoreLatestDraft(targetProjectPath: string) {
    try {
      const payload = (await listThreads({
        projectPath: targetProjectPath,
        limit: 20,
      })) as { threads: ThreadPayload[] };

      for (const thread of payload.threads) {
        if (!thread.draftPath) {
          continue;
        }

        try {
          const draft = await fs.readFile(thread.draftPath, 'utf8');
          if (!draft.trim()) continue;
          // Restore thread context only — don't pre-fill the input buffer
          setCurrentThread(thread);
          setCurrentSessionId(thread.sessionId);
          // Delete the stale draft file so it doesn't accumulate
          await fs.rm(thread.draftPath, { force: true }).catch(() => {});
          return;
        } catch {}
      }
    } catch {}
  }

  async function saveDraftForThread(thread: ThreadPayload, value: string) {
    if (!thread.draftPath) {
      return;
    }

    if (!value.trim()) {
      await clearDraftForThread(thread.id);
      return;
    }

    await fs.writeFile(thread.draftPath, value, 'utf8');
  }

  async function clearDraftForThread(threadId: string) {
    try {
      const thread =
        currentThread?.id === threadId
          ? currentThread
          : ((await getThread(threadId)) as ThreadPayload);

      if (!thread?.draftPath) {
        return;
      }

      await fs.rm(thread.draftPath, { force: true });
    } catch {}
  }

  async function watchRun(runId: string) {
    const watchStartedAt = Date.now();
    let lastFingerprint = '';
    const seenApprovals = new Set<string>();
    let consecutiveFetchErrors = 0;

    try {
      while (true) {
        let nextRun: RunTaskPayload;
        try {
          nextRun = (await getRun(runId)) as RunTaskPayload;
          consecutiveFetchErrors = 0;
        } catch (fetchErr) {
          consecutiveFetchErrors++;
          // Transient fetch errors (daemon hiccup) — retry up to 5 times
          if (consecutiveFetchErrors <= 5) {
            await new Promise((resolve) => setTimeout(resolve, 500));
            continue;
          }
          throw fetchErr;
        }
        const fingerprint = `${nextRun.status}:${nextRun.events.length}:${nextRun.lastError ?? ''}:${nextRun.result?.finalText ?? ''}`;
        const runChanged = fingerprint !== lastFingerprint;

        if (runChanged) {
          setActiveRun(nextRun);
          lastFingerprint = fingerprint;

          if (nextRun.projectPath && nextRun.projectPath !== projectPath) {
            setProjectPath(nextRun.projectPath);
          }

          // Check for new pending permission requests and skill usage in events
          for (const event of nextRun.events) {
            if (event.type === 'permission_requested' && event.payload.pending === true) {
              const approvalId = String(event.payload.approvalId ?? '');
              if (approvalId && !seenApprovals.has(approvalId)) {
                seenApprovals.add(approvalId);
                setPendingPermission({
                  runId,
                  approvalId,
                  toolName: String(event.payload.toolName ?? 'tool'),
                  summary: String(event.payload.summary ?? ''),
                });
              }
            }

            // Detect when agent autonomously reads a SKILL.md — show skill indicator
            if (event.type === 'tool_call') {
              const toolName = String(event.payload.name ?? '');
              if (toolName === 'fs.read' || toolName === 'fs_read') {
                const args = isRecord(event.payload.arguments) ? event.payload.arguments : {};
                const filePath = typeof args.path === 'string' ? args.path : '';
                const normalizedPath = filePath.replace(/\\/g, '/');
                const skillMdMatch = normalizedPath.match(/\.umbra\/skills\/([^/]+)\/SKILL\.md$/i);
                if (skillMdMatch?.[1]) {
                  setActiveSkillName(skillMdMatch[1]);
                }
              }
            }
          }
        }

        if (nextRun.status !== 'queued' && nextRun.status !== 'running') {
          writeRunDebugMetadata(nextRun);
          const runDurationMs = Date.now() - watchStartedAt;
          const runEntries = formatRunEntries(nextRun, showCitations, runDurationMs);
          // Read preference directly to avoid stale-closure on startup
          const detailMode =
            usageDetailModeRef.current !== 'off'
              ? usageDetailModeRef.current
              : getUsageDetailMode();
          // Always fetch usageRec for session stats accumulation (even when display is off)
          let usageRec: Awaited<ReturnType<typeof getLastUsage>> = null;
          try {
            usageRec = await getLastUsage();
          } catch {}
          if (usageRec) {
            if (detailMode !== 'off') {
              // Attach usage to last assistant bubble
              for (let i = runEntries.length - 1; i >= 0; i--) {
                const e = runEntries[i];
                if (e?.kind === 'bubble' && e.bubbleRole === 'assistant') {
                  e.usage = {
                    inputTokens: usageRec.inputTokens,
                    outputTokens: usageRec.outputTokens,
                    ...(usageRec.reasoningTokens != null
                      ? { reasoningTokens: usageRec.reasoningTokens }
                      : {}),
                    ...(usageRec.costEstimate != null
                      ? { costEstimate: usageRec.costEstimate }
                      : {}),
                    mode: detailMode,
                  };
                  break;
                }
              }
              // Prepend a NEW entry showing input tokens near "You" message.
              // Using a new Static entry (not setEntries update) because Ink's <Static>
              // never re-renders already-output items, so updating existing entries is a no-op.
              if (usageRec.inputTokens > 0) {
                runEntries.unshift({
                  id: createEntryId(),
                  kind: 'event',
                  tone: 'info',
                  text: 'user-ctx>',
                  inputUsage: { inputTokens: usageRec.inputTokens, mode: detailMode },
                });
              }
            }
            // Accumulate per-session stats regardless of display mode
            const rec = usageRec;
            setUsageStats((prev) => ({
              totalTokens: (prev?.totalTokens ?? 0) + (rec.totalTokens || 0),
              inputTokens: (prev?.inputTokens ?? 0) + rec.inputTokens,
              outputTokens: (prev?.outputTokens ?? 0) + rec.outputTokens,
              reasoningTokens: (prev?.reasoningTokens ?? 0) + (rec.reasoningTokens ?? 0),
              cacheReadTokens: (prev?.cacheReadTokens ?? 0) + (rec.cacheReadTokens ?? 0),
              cacheWriteTokens: (prev?.cacheWriteTokens ?? 0) + (rec.cacheWriteTokens ?? 0),
              requests: (prev?.requests ?? 0) + 1,
              totalCost: (prev?.totalCost ?? 0) + (rec.costEstimate ?? 0),
            }));
          }
          appendEntries(runEntries);
          if (nextRun.threadId) {
            await syncCurrentThread(nextRun.threadId);
          }
          if (nextRun.sessionId) {
            setCurrentSessionId(nextRun.sessionId);
          }
          setActiveRun(null);
          setPendingPermission(null);
          setEscConfirmPending(false);
          setBusy(false);
          void refreshStatus();
          return;
        }

        await new Promise((resolve) => {
          setTimeout(resolve, runChanged ? 250 : 500);
        });
      }
    } catch (watchError) {
      // Network error, daemon stopped, or any other failure.
      // Always release the busy state so the input field becomes usable again.
      const msg = watchError instanceof Error ? watchError.message : 'connection lost';
      writeDebugEvent({
        component: 'tui',
        level: 'error',
        message: 'watchRun failed',
        data: { error: msg },
      });
      setActiveRun(null);
      setPendingPermission(null);
      setEscConfirmPending(false);
      setBusy(false);
      appendEntries([
        {
          id: createEntryId(),
          kind: 'event' as const,
          tone: 'danger' as const,
          text: `system> Run interrupted: ${msg}`,
        },
      ]);
    }
  }

  async function refreshStatus() {
    try {
      const nextStatus = (await getStatus()) as DaemonStatus;
      setDaemonStatus((current) => {
        if (
          current?.activeProvider.id === nextStatus.activeProvider.id &&
          current?.activeProvider.model === nextStatus.activeProvider.model &&
          current?.queueDepth === nextStatus.queueDepth &&
          current?.ok === nextStatus.ok &&
          current?.webSearch.mode === nextStatus.webSearch.mode &&
          current?.webSearch.providerId === nextStatus.webSearch.providerId &&
          current?.webSearch.configured === nextStatus.webSearch.configured
        ) {
          return current;
        }

        return nextStatus;
      });
    } catch {
      setDaemonStatus(null);
    }
  }
}

function BubbleUsageLine(props: {
  usage: {
    inputTokens: number;
    outputTokens: number;
    reasoningTokens?: number;
    costEstimate?: number;
    mode: UsageDetailMode;
  };
}) {
  const { inputTokens, outputTokens, reasoningTokens, costEstimate, mode } = props.usage;
  const costStr = costEstimate != null ? `$${costEstimate.toFixed(4)}` : null;

  const thinkStr =
    reasoningTokens && reasoningTokens > 0 ? ` ·think ${reasoningTokens.toLocaleString()}` : '';

  if (mode === 'verbose') {
    // ↑ ctx 3,079  ↓ out 456 ·think 89  $0.0018
    return (
      <Box marginTop={0} flexDirection="row">
        <Text color={umbraTheme.muted}>{'  '}</Text>
        <Text color={umbraTheme.warning}>{'↑'}</Text>
        <Text color={umbraTheme.muted}>{' ctx '}</Text>
        <Text color={umbraTheme.text}>{inputTokens.toLocaleString()}</Text>
        <Text color={umbraTheme.frameDim}>{' · '}</Text>
        <Text color={umbraTheme.accent}>{'↓'}</Text>
        <Text color={umbraTheme.muted}>{' out '}</Text>
        <Text color={umbraTheme.text}>{outputTokens.toLocaleString()}</Text>
        {thinkStr ? <Text color={umbraTheme.muted}>{thinkStr}</Text> : null}
        {costStr ? (
          <>
            <Text color={umbraTheme.frameDim}>{'  '}</Text>
            <Text color={umbraTheme.accentSoft}>{costStr}</Text>
          </>
        ) : null}
      </Box>
    );
  }

  // compact: ↑ 3,079  ↓ 456 ·think 89  $0.0018
  const line = `↑ ${inputTokens.toLocaleString()}  ↓ ${outputTokens.toLocaleString()}${thinkStr}${costStr ? `  ${costStr}` : ''}`;
  return (
    <Box marginTop={0}>
      <Text color={umbraTheme.muted}>{`  ${line}`}</Text>
    </Box>
  );
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function BusySpinner() {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), 80);
    return () => clearInterval(t);
  }, []);
  return (
    <Text color={umbraTheme.warning} bold>
      {SPINNER_FRAMES[frame]}
    </Text>
  );
}

function InputLine(props: {
  value: string;
  cursorPosition: number;
  muted: boolean;
  ghost?: string;
  /** Start position (buffer offset) for the skill-highlight range. Default 0. */
  highlightStart?: number;
  /** Number of characters from highlightStart to render in skillHighlight color. */
  highlightLen?: number;
}) {
  const color = props.muted ? umbraTheme.muted : umbraTheme.text;
  const rows = buildInputRenderRows(props.value, props.cursorPosition);
  const promptChar = '>';
  const promptColor = props.muted ? umbraTheme.muted : umbraTheme.warning;
  const hlStart = props.highlightStart ?? 0;
  const hlLen = props.highlightLen ?? 0;
  const hlEnd = hlStart + hlLen;

  return (
    <Box flexDirection="column">
      {rows.map((row, index) => {
        const isLast = index === rows.length - 1;
        const isFirst = index === 0;
        const ghost = isLast ? props.ghost : undefined;

        // Skill name highlight: render [hlStart, hlEnd) in skillHighlight color
        if (isFirst && hlLen > 0) {
          const fullLine = row.before + row.current + row.after;
          const curPos = row.before.length;

          let rendered: React.ReactNode;
          if (row.active) {
            if (curPos < hlStart) {
              // cursor is before the highlight range
              rendered = (
                <>
                  <Text color={color}>{fullLine.slice(0, curPos)}</Text>
                  <Text inverse color={color}>
                    {fullLine[curPos] ?? ' '}
                  </Text>
                  <Text color={color}>{fullLine.slice(curPos + 1, hlStart)}</Text>
                  <Text bold color={umbraTheme.skillHighlight}>
                    {fullLine.slice(hlStart, hlEnd)}
                  </Text>
                  <Text color={color}>{fullLine.slice(hlEnd)}</Text>
                </>
              );
            } else if (curPos < hlEnd) {
              // cursor is within the highlight range
              rendered = (
                <>
                  <Text color={color}>{fullLine.slice(0, hlStart)}</Text>
                  <Text bold color={umbraTheme.skillHighlight}>
                    {fullLine.slice(hlStart, curPos)}
                  </Text>
                  <Text bold inverse color={umbraTheme.skillHighlight}>
                    {fullLine[curPos] ?? ' '}
                  </Text>
                  <Text bold color={umbraTheme.skillHighlight}>
                    {fullLine.slice(curPos + 1, hlEnd)}
                  </Text>
                  <Text color={color}>{fullLine.slice(hlEnd)}</Text>
                </>
              );
            } else {
              // cursor is after the highlight range
              rendered = (
                <>
                  <Text color={color}>{fullLine.slice(0, hlStart)}</Text>
                  <Text bold color={umbraTheme.skillHighlight}>
                    {fullLine.slice(hlStart, hlEnd)}
                  </Text>
                  <Text color={color}>{fullLine.slice(hlEnd, curPos)}</Text>
                  <Text inverse color={color}>
                    {fullLine[curPos] ?? ' '}
                  </Text>
                  <Text color={color}>{fullLine.slice(curPos + 1)}</Text>
                </>
              );
            }
          } else {
            rendered = (
              <>
                <Text color={color}>{fullLine.slice(0, hlStart)}</Text>
                <Text bold color={umbraTheme.skillHighlight}>
                  {fullLine.slice(hlStart, hlEnd)}
                </Text>
                <Text color={color}>{fullLine.slice(hlEnd)}</Text>
              </>
            );
          }

          return (
            <Box key={`${index}:${row.before.length}:${row.after.length}`}>
              <Text color={promptColor}>{`${promptChar} `}</Text>
              {rendered}
              {ghost ? <Text color={umbraTheme.frameDim}>{ghost}</Text> : null}
            </Box>
          );
        }

        // Normal rendering
        return (
          <Box key={`${index}:${row.before.length}:${row.after.length}`}>
            <Text color={isFirst ? promptColor : umbraTheme.frameDim}>
              {isFirst ? `${promptChar} ` : '  '}
            </Text>
            {row.active ? (
              <>
                <Text color={color}>{row.before}</Text>
                <Text inverse color={color}>
                  {row.current}
                </Text>
                <Text color={color}>{row.after}</Text>
                {ghost ? <Text color={umbraTheme.frameDim}>{ghost}</Text> : null}
              </>
            ) : (
              <>
                <Text color={color}>{row.before}</Text>
                {ghost ? <Text color={umbraTheme.frameDim}>{ghost}</Text> : null}
              </>
            )}
          </Box>
        );
      })}
    </Box>
  );
}

export function buildInputRenderRows(
  value: string,
  cursorPosition: number,
): Array<{ before: string; current: string; after: string; active: boolean }> {
  const rows: Array<{ before: string; current: string; after: string; active: boolean }> = [];
  const lineStarts = collectLineStarts(value);
  const clampedCursor = clampCursor(value, cursorPosition);

  for (let index = 0; index < lineStarts.length; index += 1) {
    const start = lineStarts[index] ?? 0;
    const nextStart = lineStarts[index + 1] ?? value.length + 1;
    const lineEnd = Math.min(nextStart - 1, value.length);
    const lineText = value.slice(start, lineEnd);
    const cursorOnLine = clampedCursor >= start && clampedCursor <= lineEnd;

    if (!cursorOnLine) {
      rows.push({
        before: lineText,
        current: ' ',
        after: '',
        active: false,
      });
      continue;
    }

    const relativeCursor = Math.min(clampedCursor - start, lineText.length);
    rows.push({
      before: lineText.slice(0, relativeCursor),
      current: lineText[relativeCursor] ?? ' ',
      after: lineText.slice(relativeCursor + 1),
      active: true,
    });
  }

  return rows.length > 0 ? rows : [{ before: '', current: ' ', after: '', active: true }];
}

export function moveCursorVertical(
  value: string,
  cursorPosition: number,
  direction: -1 | 1,
): number {
  const lineStarts = collectLineStarts(value);

  if (lineStarts.length <= 1) {
    return cursorPosition;
  }

  const clampedCursor = clampCursor(value, cursorPosition);
  const currentLineIndex = findLineIndex(lineStarts, clampedCursor);
  const targetLineIndex = currentLineIndex + direction;

  if (targetLineIndex < 0 || targetLineIndex >= lineStarts.length) {
    return cursorPosition;
  }

  const currentStart = lineStarts[currentLineIndex] ?? 0;
  const currentNextStart = lineStarts[currentLineIndex + 1] ?? value.length + 1;
  const currentLineLength = Math.max(
    0,
    Math.min(currentNextStart - 1, value.length) - currentStart,
  );
  const desiredColumn = Math.min(clampedCursor - currentStart, currentLineLength);

  const targetStart = lineStarts[targetLineIndex] ?? 0;
  const targetNextStart = lineStarts[targetLineIndex + 1] ?? value.length + 1;
  const targetLineLength = Math.max(0, Math.min(targetNextStart - 1, value.length) - targetStart);

  return targetStart + Math.min(desiredColumn, targetLineLength);
}

function PermissionApprovalView({ toolName, summary }: { toolName: string; summary: string }) {
  return (
    <Box
      marginTop={1}
      flexDirection="column"
      paddingX={1}
      borderStyle="round"
      borderColor={umbraTheme.warning}
    >
      <Text color={umbraTheme.warning} bold>
        {'[!] permission required'}
      </Text>
      <Text>
        {'tool: '}
        <Text bold color={umbraTheme.text}>
          {toolName}
        </Text>
      </Text>
      {summary ? <Text color={umbraTheme.muted}>{summary}</Text> : null}
      <Box marginTop={1}>
        <Text color={umbraTheme.success} bold>
          {'y'}
        </Text>
        <Text color={umbraTheme.muted}>{' allow  '}</Text>
        <Text color={umbraTheme.accent} bold>
          {'a'}
        </Text>
        <Text color={umbraTheme.muted}>{' always  '}</Text>
        <Text color={umbraTheme.danger} bold>
          {'n'}
        </Text>
        <Text color={umbraTheme.muted}>{' deny'}</Text>
      </Box>
    </Box>
  );
}

function virtualListWindow<T>(
  items: T[],
  selectedIndex: number,
  windowSize: number,
): { visible: T[]; startIndex: number } {
  if (items.length <= windowSize) return { visible: items, startIndex: 0 };
  const half = Math.floor(windowSize / 2);
  const rawStart = selectedIndex - half;
  const startIndex = Math.max(0, Math.min(rawStart, items.length - windowSize));
  return { visible: items.slice(startIndex, startIndex + windowSize), startIndex };
}

type ThinkProfile = 'anthropic' | 'openai-o' | 'mistral-magistral' | 'mistral-adjustable' | 'none';
type ThinkOption = { id: string; label: string; summary: string };

const THINK_OPTIONS_ANTHROPIC: ThinkOption[] = [
  { id: 'off', label: 'off', summary: 'Disable extended thinking' },
  { id: 'low', label: 'low  (~4K tokens)', summary: 'Low effort — budget_tokens: 4,000' },
  { id: 'medium', label: 'medium (~10K tokens)', summary: 'Medium effort — budget_tokens: 10,000' },
  { id: 'high', label: 'high (~16K tokens)', summary: 'High effort — budget_tokens: 16,000' },
  { id: 'max', label: 'max  (~32K tokens)', summary: 'Max effort — budget_tokens: 32,000' },
  {
    id: 'custom',
    label: 'custom tokens...',
    summary: 'Set exact budget_tokens (type number below)',
  },
];

const THINK_OPTIONS_OPENAI_O: ThinkOption[] = [
  { id: 'off', label: 'off', summary: 'Disable reasoning (reasoning_effort not sent)' },
  { id: 'low', label: 'low', summary: 'Low reasoning effort' },
  { id: 'medium', label: 'medium', summary: 'Medium reasoning effort' },
  { id: 'high', label: 'high', summary: 'High reasoning effort' },
];

// Magistral models always reason — no parameter to send. Menu is informational only.
const THINK_OPTIONS_MAGISTRAL: ThinkOption[] = [
  {
    id: 'always-on',
    label: 'always reasoning (built-in)',
    summary:
      'Magistral always generates reasoning traces. No parameter needed — thinking cannot be disabled.',
  },
];

// mistral-small / mistral-medium support optional reasoning_effort
const THINK_OPTIONS_MISTRAL_ADJUSTABLE: ThinkOption[] = [
  { id: 'off', label: 'off', summary: 'No reasoning_effort sent — model answers directly' },
  { id: 'low', label: 'low', summary: 'Low reasoning effort' },
  { id: 'medium', label: 'medium', summary: 'Medium reasoning effort' },
  { id: 'high', label: 'high', summary: 'High reasoning effort' },
];

const THINK_OPTIONS_NONE: ThinkOption[] = [
  { id: 'off', label: 'off', summary: 'Extended thinking not supported by this model' },
];

function detectThinkProfile(model: string | null): ThinkProfile {
  if (!model) return 'none';
  const m = model.toLowerCase();
  if (m.startsWith('magistral')) return 'mistral-magistral';
  if (m.startsWith('mistral-small') || m.startsWith('mistral-medium')) return 'mistral-adjustable';
  if (m.startsWith('claude')) return 'anthropic';
  if (/^o\d/.test(m)) return 'openai-o';
  if (m.startsWith('gpt-5') || m.startsWith('codex-')) return 'openai-o';
  return 'none';
}

function getThinkOptions(profile: ThinkProfile): ThinkOption[] {
  if (profile === 'anthropic') return THINK_OPTIONS_ANTHROPIC;
  if (profile === 'openai-o') return THINK_OPTIONS_OPENAI_O;
  if (profile === 'mistral-magistral') return THINK_OPTIONS_MAGISTRAL;
  if (profile === 'mistral-adjustable') return THINK_OPTIONS_MISTRAL_ADJUSTABLE;
  return THINK_OPTIONS_NONE;
}

function thinkBudgetToIndex(
  budget: number | 'low' | 'medium' | 'high' | 'max' | null,
  opts: ThinkOption[],
): number {
  if (budget === null) return opts.findIndex((o) => o.id === 'off') ?? 0;
  if (typeof budget === 'number')
    return Math.max(
      0,
      opts.findIndex((o) => o.id === 'custom'),
    );
  return Math.max(
    0,
    opts.findIndex((o) => o.id === budget),
  );
}

// Legacy alias kept so any remaining references compile
const THINK_OPTIONS = THINK_OPTIONS_ANTHROPIC;

function ProviderDialogView({ state }: { state: ProviderDialogState }) {
  if (state.kind === 'no-provider-prompt') {
    const items = ['Yes — connect a provider', 'No — skip for now'];
    return (
      <Box marginTop={1} flexDirection="column">
        <Text color={umbraTheme.danger}>No provider connected</Text>
        <Text color={umbraTheme.danger}>
          Connect a free provider now? OpenCode Zen works without an API key.
        </Text>
        <Text color={umbraTheme.muted}>↑↓ navigate Enter select Esc skip</Text>
        {items.map((item, index) => (
          <Text
            key={item}
            color={index === state.selectedIndex ? umbraTheme.danger : umbraTheme.text}
          >
            {index === state.selectedIndex ? '>' : ' '} {item}
          </Text>
        ))}
      </Box>
    );
  }

  if (state.kind === 'provider-menu') {
    return (
      <Box marginTop={1} flexDirection="column">
        <Text color={umbraTheme.accent}>Providers</Text>
        <Text color={umbraTheme.muted}>↑↓ navigate Enter select Esc close</Text>
        {PROVIDER_MENU_ITEMS.map((item, index) => (
          <Box key={item.id} flexDirection="row" marginTop={0}>
            <Text color={index === state.selectedIndex ? umbraTheme.accent : umbraTheme.text}>
              {index === state.selectedIndex ? '> ' : '  '}
              {item.label}
            </Text>
            <Text color={umbraTheme.muted}>
              {'  '}
              {item.hint}
            </Text>
          </Box>
        ))}
      </Box>
    );
  }

  if (state.kind === 'permission-mode') {
    const options = permissionModeOptions(state.currentMode);

    return (
      <Box marginTop={1} flexDirection="column">
        <Text color={umbraTheme.accent}>Update Permissions</Text>
        <Text color={umbraTheme.muted}>Choose how much access Umbra should have.</Text>
        <Text color={umbraTheme.muted}>Enter confirm Esc cancel</Text>
        {options.map((option, index) => (
          <Box key={option.id} flexDirection="column">
            <Text color={index === state.selectedIndex ? umbraTheme.accent : umbraTheme.text}>
              {index === state.selectedIndex ? '>' : ' '} {index + 1}. {option.label}
              {option.mode === state.currentMode ? ' (current)' : ''}
            </Text>
            <Text color={umbraTheme.muted}>{option.summary}</Text>
          </Box>
        ))}
      </Box>
    );
  }

  if (state.kind === 'web-mode') {
    const modeItems = [
      { id: 'off', label: 'Off', summary: 'Disable web search', mode: 'off' as const },
      {
        id: 'cached',
        label: 'Cached',
        summary: 'Search with result caching',
        mode: 'cached' as const,
      },
      { id: 'live', label: 'Live', summary: 'Always fetch fresh results', mode: 'live' as const },
    ];
    return (
      <Box marginTop={1} flexDirection="column">
        <Text color={umbraTheme.accent}>Web Search</Text>
        <Text color={umbraTheme.muted}>↑↓ navigate Enter apply Esc close</Text>
        <Text color={umbraTheme.muted}>── Mode ──────────────────────</Text>
        {modeItems.map((item, index) => {
          const isSelected = index === state.selectedIndex;
          const isCurrent = item.mode === state.currentMode;
          return (
            <Box key={item.id} flexDirection="row">
              <Text
                color={
                  isSelected ? umbraTheme.accent : isCurrent ? umbraTheme.success : umbraTheme.text
                }
              >
                {isSelected ? '>' : isCurrent ? '*' : ' '} {item.label.padEnd(8, ' ')}
              </Text>
              <Text color={umbraTheme.muted}>{item.summary}</Text>
            </Box>
          );
        })}
        {state.providers.length > 0 ? (
          <Text color={umbraTheme.muted}>── Provider ──────────────────</Text>
        ) : null}
        {state.providers.map((p, index) => {
          const globalIndex = modeItems.length + index;
          const isSelected = globalIndex === state.selectedIndex;
          return (
            <Box key={p.id} flexDirection="row">
              <Text
                color={
                  isSelected ? umbraTheme.accent : p.selected ? umbraTheme.success : umbraTheme.text
                }
              >
                {isSelected ? '>' : p.selected ? '*' : ' '} {p.label.padEnd(22, ' ')}
              </Text>
              <Text color={p.configured ? umbraTheme.muted : umbraTheme.warning}>
                {p.configured ? 'free' : '⚠ needs API key'}
              </Text>
            </Box>
          );
        })}
      </Box>
    );
  }

  if (state.kind === 'web-provider-menu') {
    const p = state.provider;
    const hasKey = p.configured && p.authSource === 'runtime';
    const items = [
      { id: 'use', label: 'Use this provider' },
      { id: 'apikey', label: hasKey ? 'Change API key' : 'Set API key' },
      { id: 'baseurl', label: 'Set base URL' },
      ...(hasKey ? [{ id: 'clearkey', label: 'Clear API key' }] : []),
    ];
    return (
      <Box marginTop={1} flexDirection="column">
        <Text color={umbraTheme.accent}>{p.label}</Text>
        <Text color={p.configured ? umbraTheme.success : umbraTheme.warning}>
          {p.configured ? '✓ configured' : '⚠ not configured — set API key below'}
        </Text>
        <Text color={umbraTheme.muted}>base URL: {p.baseUrl}</Text>
        <Text color={umbraTheme.muted}>↑↓ navigate Enter select Esc back</Text>
        {items.map((item, index) => (
          <Box key={item.id} flexDirection="row" marginTop={0}>
            <Text color={index === state.selectedIndex ? umbraTheme.accent : umbraTheme.text}>
              {index === state.selectedIndex ? '>' : ' '} {index + 1}. {item.label}
            </Text>
          </Box>
        ))}
      </Box>
    );
  }

  if (state.kind === 'web-provider-api-key') {
    return (
      <Box marginTop={1} flexDirection="column">
        <Text color={umbraTheme.accent}>API key — {state.provider.label}</Text>
        <Text color={umbraTheme.muted}>
          {state.provider.configured
            ? 'Key is set. Enter new key or leave empty to clear.'
            : 'Paste or type the API key.'}
        </Text>
        <Text color={umbraTheme.muted}>Ctrl+Y paste Enter save Esc back</Text>
        {state.clipboardPreview ? (
          <Text color={umbraTheme.code}>
            clipboard: {maskSecretPreview(state.clipboardPreview)}
          </Text>
        ) : null}
        <Box marginTop={1}>
          <Text color={umbraTheme.accent}>{'> '}</Text>
          <InputLine value={maskSecret(state.value)} cursorPosition={state.cursor} muted={false} />
        </Box>
      </Box>
    );
  }

  if (state.kind === 'web-provider-base-url') {
    return (
      <Box marginTop={1} flexDirection="column">
        <Text color={umbraTheme.accent}>Base URL — {state.provider.label}</Text>
        <Text color={umbraTheme.muted}>
          Default: {state.provider.baseUrl} (leave empty to reset)
        </Text>
        <Text color={umbraTheme.muted}>Ctrl+Y paste Enter save Esc back</Text>
        {state.clipboardPreview ? (
          <Text color={umbraTheme.code}>clipboard: {truncatePreview(state.clipboardPreview)}</Text>
        ) : null}
        <Box marginTop={1}>
          <Text color={umbraTheme.accent}>{'> '}</Text>
          <InputLine value={state.value} cursorPosition={state.cursor} muted={false} />
        </Box>
      </Box>
    );
  }

  if (state.kind === 'git-mode') {
    const options = [
      { id: 'on', label: 'Enable git tools', value: true },
      { id: 'off', label: 'Disable git tools', value: false },
    ];
    return (
      <Box marginTop={1} flexDirection="column">
        <Text color={umbraTheme.accent}>Git Tools</Text>
        <Text color={umbraTheme.muted}>↑↓ navigate Enter confirm Esc cancel</Text>
        {options.map((option, index) => (
          <Box key={option.id} flexDirection="column">
            <Text color={index === state.selectedIndex ? umbraTheme.accent : umbraTheme.text}>
              {index === state.selectedIndex ? '>' : ' '} {index + 1}. {option.label}
              {option.value === state.currentEnabled ? ' (current)' : ''}
            </Text>
          </Box>
        ))}
      </Box>
    );
  }

  if (state.kind === 'path-visibility') {
    const options = [
      { id: 'on', label: 'Show path in status bar', value: true },
      { id: 'off', label: 'Hide path in status bar', value: false },
    ];
    return (
      <Box marginTop={1} flexDirection="column">
        <Text color={umbraTheme.accent}>Path Visibility</Text>
        <Text color={umbraTheme.muted}>↑↓ navigate Enter confirm Esc cancel</Text>
        {options.map((option, index) => (
          <Box key={option.id} flexDirection="column">
            <Text color={index === state.selectedIndex ? umbraTheme.accent : umbraTheme.text}>
              {index === state.selectedIndex ? '>' : ' '} {index + 1}. {option.label}
              {option.value === state.currentVisible ? ' (current)' : ''}
            </Text>
          </Box>
        ))}
      </Box>
    );
  }

  if (state.kind === 'theme-select') {
    const filtered = state.query
      ? THEME_NAMES.filter((n) => n.includes(state.query.toLowerCase()))
      : THEME_NAMES;
    const { visible, startIndex } = virtualListWindow(filtered, state.selectedIndex, 10);
    const hasAbove = startIndex > 0;
    const hasBelow = startIndex + visible.length < filtered.length;
    const hoveredName = filtered[state.selectedIndex] ?? state.currentTheme;
    const hT = (THEMES as Record<string, typeof umbraTheme>)[hoveredName] ?? umbraTheme;
    return (
      <Box marginTop={1} flexDirection="column">
        <Text color={umbraTheme.accent}>Select Theme</Text>
        <Text color={umbraTheme.muted}>
          {'Filter: '}
          {state.query || '(type to search)'}
          {'   ↑↓ navigate  Enter apply  Esc cancel'}
        </Text>
        <Text color={umbraTheme.muted}>{`${filtered.length} of ${THEME_NAMES.length} themes`}</Text>
        <Box flexDirection="row" gap={4}>
          <Box flexDirection="column">
            {hasAbove ? <Text color={umbraTheme.muted}>{`  ↑ ${startIndex} more`}</Text> : null}
            {visible.map((name, i) => {
              const index = startIndex + i;
              const isCurrent = name === state.currentTheme;
              const isSelected = index === state.selectedIndex;
              const t = (THEMES as Record<string, typeof umbraTheme>)[name] ?? umbraTheme;
              return (
                <Box key={name} flexDirection="row">
                  <Text color={isSelected ? umbraTheme.accent : umbraTheme.text}>
                    {isSelected ? '>' : isCurrent ? '*' : ' '} {name.padEnd(22)}
                  </Text>
                  <Text color={t.frame}>{'█'}</Text>
                  <Text color={t.accent}>{'█'}</Text>
                  <Text color={t.skillHighlight}>{'█'}</Text>
                  <Text color={t.success}>{'█'}</Text>
                  <Text color={t.warning}>{'█'}</Text>
                  <Text color={t.danger}>{'█'}</Text>
                </Box>
              );
            })}
            {hasBelow ? (
              <Text
                color={umbraTheme.muted}
              >{`  ↓ ${filtered.length - startIndex - visible.length} more`}</Text>
            ) : null}
          </Box>
          <Box flexDirection="column">
            <Box flexDirection="row">
              <Text color={hT.frame}>{'    .-=-.'}</Text>
            </Box>
            <Box flexDirection="row">
              <Text color={hT.frame}>{'   ('}</Text>
              <Text color={hT.accentSoft}>{'.-.'}</Text>
              <Text color={hT.frame}>{')'}</Text>
            </Box>
            <Box flexDirection="row">
              <Text color={hT.frame}>{'  ('}</Text>
              <Text color={hT.accent}>{'('}</Text>
              <Text color={hT.accentSoft}>{'('}</Text>
              <Text color={hT.skillHighlight}>{'@'}</Text>
              <Text color={hT.accentSoft}>{')'}</Text>
              <Text color={hT.accent}>{')'}</Text>
              <Text color={hT.frame}>{')'}</Text>
            </Box>
            <Box flexDirection="row">
              <Text color={hT.frame}>{'   ('}</Text>
              <Text color={hT.accentSoft}>{"'-'"}</Text>
              <Text color={hT.frame}>{')'}</Text>
            </Box>
            <Box flexDirection="row">
              <Text color={hT.frame}>{"    '-^-'"}</Text>
            </Box>
            <Box flexDirection="row">
              <Text color={hT.success}>{'     \\|'}</Text>
            </Box>
            <Box flexDirection="row">
              <Text color={hT.success}>{'    <'}</Text>
              <Text color={hT.warning}>{'>'}</Text>
              <Text color={hT.success}>{'|'}</Text>
            </Box>
            <Box flexDirection="row">
              <Text color={hT.success}>{'      |'}</Text>
            </Box>
            <Box flexDirection="row" marginTop={1}>
              <Text color={hT.frame}>{'█'}</Text>
              <Text color={hT.accent}>{'█'}</Text>
              <Text color={hT.skillHighlight}>{'█'}</Text>
              <Text color={hT.success}>{'█'}</Text>
              <Text color={hT.warning}>{'█'}</Text>
              <Text color={hT.danger}>{'█'}</Text>
            </Box>
            <Text color={umbraTheme.text}>{hoveredName}</Text>
          </Box>
        </Box>
      </Box>
    );
  }

  if (state.kind === 'provider-list') {
    const items = filterProviders(state.providers, state.query);
    const { visible, startIndex } = virtualListWindow(items, state.selectedIndex, 8);
    const hasAbove = startIndex > 0;
    const hasBelow = startIndex + visible.length < items.length;

    return (
      <Box marginTop={1} flexDirection="column">
        <Text color={umbraTheme.accent}>Connect provider</Text>
        <Text color={umbraTheme.muted}>Search: {state.query || '(type to filter)'}</Text>
        <Text color={umbraTheme.muted}>Enter select Esc close</Text>
        {hasAbove ? <Text color={umbraTheme.muted}>{`  ↑ ${startIndex} more`}</Text> : null}
        {visible.map((provider, i) => {
          const index = startIndex + i;
          const isZen = provider.value === 'opencode-zen';
          const labelColor = isZen
            ? umbraTheme.danger
            : index === state.selectedIndex
              ? umbraTheme.accent
              : umbraTheme.text;
          return (
            <Box key={provider.value}>
              <Text color={labelColor}>
                {index === state.selectedIndex ? '>' : ' '} {provider.label.padEnd(28, ' ')}
                {isZen ? ' [FREE]' : ''}
              </Text>
              <Text color={umbraTheme.muted}>
                {provider.needsKey && !provider.keyOptional ? 'api key required' : 'key optional'}
                {provider.defaultUrl ? `  ${provider.defaultUrl}` : '  custom url required'}
              </Text>
            </Box>
          );
        })}
        {hasBelow ? (
          <Text
            color={umbraTheme.muted}
          >{`  ↓ ${items.length - startIndex - visible.length} more`}</Text>
        ) : null}
      </Box>
    );
  }

  if (state.kind === 'provider-profile-list') {
    const items = filterProviderProfiles(state.profiles, state.query);
    const { visible, startIndex } = virtualListWindow(items, state.selectedIndex, 8);
    const hasAbove = startIndex > 0;
    const hasBelow = startIndex + visible.length < items.length;

    return (
      <Box marginTop={1} flexDirection="column">
        <Text color={umbraTheme.accent}>Select active provider</Text>
        <Text color={umbraTheme.muted}>Search: {state.query || '(type to filter)'}</Text>
        <Text color={umbraTheme.muted}>Enter select Esc close</Text>
        {hasAbove ? <Text color={umbraTheme.muted}>{`  ↑ ${startIndex} more`}</Text> : null}
        {visible.map((profile, i) => {
          const index = startIndex + i;
          return (
            <Box key={profile.id}>
              <Text color={index === state.selectedIndex ? umbraTheme.accent : umbraTheme.text}>
                {index === state.selectedIndex ? '>' : ' '} {profile.label.padEnd(24, ' ')}
              </Text>
              <Text color={umbraTheme.muted}>
                {profile.type} {profile.status} model {profile.model ?? 'none'}
              </Text>
            </Box>
          );
        })}
        {hasBelow ? (
          <Text
            color={umbraTheme.muted}
          >{`  ↓ ${items.length - startIndex - visible.length} more`}</Text>
        ) : null}
      </Box>
    );
  }

  if (state.kind === 'provider-remove-list') {
    const items = filterProviderProfiles(state.profiles, state.query);
    const { visible, startIndex } = virtualListWindow(items, state.selectedIndex, 8);
    const hasAbove = startIndex > 0;
    const hasBelow = startIndex + visible.length < items.length;

    return (
      <Box marginTop={1} flexDirection="column">
        <Text color={umbraTheme.danger}>Remove provider</Text>
        <Text color={umbraTheme.muted}>Search: {state.query || '(type to filter)'}</Text>
        <Text color={umbraTheme.muted}>Enter remove Esc close</Text>
        {hasAbove ? <Text color={umbraTheme.muted}>{`  ↑ ${startIndex} more`}</Text> : null}
        {visible.map((profile, i) => {
          const index = startIndex + i;
          return (
            <Box key={profile.id}>
              <Text color={index === state.selectedIndex ? umbraTheme.danger : umbraTheme.text}>
                {index === state.selectedIndex ? '>' : ' '} {profile.label.padEnd(24, ' ')}
              </Text>
              <Text color={umbraTheme.muted}>
                {profile.type} {profile.status} model {profile.model ?? 'none'}
              </Text>
            </Box>
          );
        })}
        {hasBelow ? (
          <Text
            color={umbraTheme.muted}
          >{`  ↓ ${items.length - startIndex - visible.length} more`}</Text>
        ) : null}
      </Box>
    );
  }

  if (state.kind === 'provider-method') {
    const methods = getProviderMethodOptions(state.provider);

    return (
      <Box marginTop={1} flexDirection="column">
        <Text color={umbraTheme.accent}>Connect {state.provider.label}</Text>
        <Text color={umbraTheme.muted}>{getProviderNote(state.provider)}</Text>
        <Text color={umbraTheme.muted}>Choose method Enter select Esc close</Text>
        {state.clipboardPreview ? (
          <Text color={umbraTheme.code}>
            clipboard: {maskSecretPreview(state.clipboardPreview)}
          </Text>
        ) : (
          <Text color={umbraTheme.muted}>clipboard: empty or unavailable</Text>
        )}
        {methods.map((method, index) => {
          const isFreeZen = state.provider.value === 'opencode-zen' && method.id === 'skip';
          const methodColor = isFreeZen
            ? umbraTheme.danger
            : index === state.selectedIndex
              ? umbraTheme.accent
              : umbraTheme.text;
          return (
            <Box key={method.id} flexDirection="column">
              <Text color={methodColor}>
                {index === state.selectedIndex ? '>' : ' '} {method.label}
                {isFreeZen ? ' [FREE — no key needed]' : ''}
              </Text>
              <Text color={umbraTheme.muted}>{method.summary}</Text>
            </Box>
          );
        })}
      </Box>
    );
  }

  if (state.kind === 'provider-oauth') {
    return (
      <Box marginTop={1} flexDirection="column">
        <Text color={umbraTheme.accent}>Connect {state.provider.label}</Text>
        <Text color={umbraTheme.muted}>OAuth flow in progress…</Text>
        <Text color={umbraTheme.text}>{state.message}</Text>
      </Box>
    );
  }

  if (state.kind === 'thread-list') {
    const items = filterThreads(state.threads, state.query);
    const { visible, startIndex } = virtualListWindow(items, state.selectedIndex, 4);
    const hasAbove = startIndex > 0;
    const hasBelow = startIndex + visible.length < items.length;

    return (
      <Box marginTop={1} flexDirection="column">
        <Text color={umbraTheme.accent}>
          {state.action === 'resume' ? 'Resume thread' : 'Fork thread'}
        </Text>
        <Text color={umbraTheme.muted}>Search: {state.query || '(type to filter)'}</Text>
        <Text color={umbraTheme.muted}>Enter select Esc close</Text>
        {hasAbove ? <Text color={umbraTheme.muted}>{`  ↑ ${startIndex} more`}</Text> : null}
        {visible.map((thread, i) => {
          const index = startIndex + i;
          return (
            <Box key={thread.id} flexDirection="column">
              <Text color={index === state.selectedIndex ? umbraTheme.accent : umbraTheme.text}>
                {index === state.selectedIndex ? '>' : ' '} {thread.title}
              </Text>
              <Text color={umbraTheme.muted}>
                {`${thread.id.slice(0, 8)}  ${thread.model ?? 'no model'}  ${thread.eventCount} events  ${formatThreadDate(thread.updatedAt)}`}
              </Text>
              {thread.summaryPreview ? (
                <Text color={umbraTheme.frameDim}>
                  {truncatePreview(thread.summaryPreview, 96)}
                </Text>
              ) : null}
            </Box>
          );
        })}
        {hasBelow ? (
          <Text
            color={umbraTheme.muted}
          >{`  ↓ ${items.length - startIndex - visible.length} more`}</Text>
        ) : null}
      </Box>
    );
  }

  if (state.kind === 'model-list') {
    const items = filterModels(state.models, state.query);
    const { visible, startIndex } = virtualListWindow(items, state.selectedIndex, 10);
    const hasAbove = startIndex > 0;
    const hasBelow = startIndex + visible.length < items.length;

    return (
      <Box marginTop={1} flexDirection="column">
        <Text color={umbraTheme.accent}>Select model for {state.profile.label}</Text>
        <Text color={umbraTheme.muted}>Search: {state.query || '(type to filter)'}</Text>
        <Text color={umbraTheme.muted}>Enter select Esc close</Text>
        {hasAbove ? <Text color={umbraTheme.muted}>{`  ↑ ${startIndex} more`}</Text> : null}
        {visible.map((model, i) => {
          const index = startIndex + i;
          const isSelected = index === state.selectedIndex;
          const contextStr =
            model.contextWindow === null
              ? 'unknown ctx'
              : `${Math.round(model.contextWindow / 1024)}k ctx`;

          const tags = [...(model.tags ?? [])];
          if (
            model.id.toLowerCase().includes('reasoning') ||
            model.id.toLowerCase().includes('r1')
          ) {
            tags.push('reasoning');
          }
          const tagsStr = tags.map((t) => `[${t.charAt(0).toUpperCase() + t.slice(1)}]`).join(' ');

          return (
            <Box key={model.id}>
              <Text color={isSelected ? umbraTheme.accent : umbraTheme.text}>
                {isSelected ? '> ' : '  '}
              </Text>
              <Box width={36}>
                <Text color={isSelected ? umbraTheme.accent : umbraTheme.text}>{model.name}</Text>
              </Box>
              <Text color={umbraTheme.muted}>{`${contextStr}  ${tagsStr}`}</Text>
            </Box>
          );
        })}
        {hasBelow ? (
          <Text
            color={umbraTheme.muted}
          >{`  ↓ ${items.length - startIndex - visible.length} more`}</Text>
        ) : null}
      </Box>
    );
  }

  if (state.kind === 'memory-settings') {
    const rows = buildMemoryDialogRows(state);

    return (
      <Box marginTop={1} flexDirection="column">
        <Text color={umbraTheme.accent}>Memory controls</Text>
        <Text color={umbraTheme.muted}>Enter toggle or execute reset Esc close</Text>
        {state.confirmReset ? (
          <Text color={umbraTheme.danger}>
            Confirm reset {state.confirmReset} memories with Enter
          </Text>
        ) : null}
        {rows.map((row, index) => (
          <Box key={row.id}>
            <Text color={index === state.selectedIndex ? umbraTheme.accent : umbraTheme.text}>
              {index === state.selectedIndex ? '>' : ' '} {row.label}
            </Text>
            <Text color={umbraTheme.muted}>{row.value}</Text>
          </Box>
        ))}
      </Box>
    );
  }

  if (state.kind === 'skill-create-name' || state.kind === 'skill-create-description') {
    return <SkillCreateDialogView state={state} />;
  }

  if (state.kind === 'compact-settings-provider') {
    const allItems = [
      { id: '__default__', label: 'Default (same as agent)', isDefault: true },
      ...filterProviderProfiles(state.profiles, state.query).map((p) => ({
        id: p.id,
        label: p.label,
        isDefault: false,
      })),
    ];
    const { visible, startIndex } = virtualListWindow(allItems, state.selectedIndex, 8);
    const hasAbove = startIndex > 0;
    const hasBelow = startIndex + visible.length < allItems.length;
    const currentLabel =
      state.currentProvider === null
        ? 'Default'
        : (state.profiles.find((p) => p.id === state.currentProvider)?.label ??
          state.currentProvider);

    return (
      <Box marginTop={1} flexDirection="column">
        <Text color={umbraTheme.accent}>Compact settings — provider</Text>
        <Text
          color={umbraTheme.muted}
        >{`Current: ${currentLabel}${state.currentModel ? ` / ${state.currentModel}` : ''}`}</Text>
        <Text color={umbraTheme.muted}>Search: {state.query || '(type to filter)'}</Text>
        <Text color={umbraTheme.muted}>Enter select Esc close</Text>
        {hasAbove ? <Text color={umbraTheme.muted}>{`  ↑ ${startIndex} more`}</Text> : null}
        {visible.map((item, i) => {
          const index = startIndex + i;
          return (
            <Box key={item.id}>
              <Text color={index === state.selectedIndex ? umbraTheme.accent : umbraTheme.text}>
                {index === state.selectedIndex ? '>' : ' '} {item.label}
              </Text>
            </Box>
          );
        })}
        {hasBelow ? (
          <Text
            color={umbraTheme.muted}
          >{`  ↓ ${allItems.length - startIndex - visible.length} more`}</Text>
        ) : null}
      </Box>
    );
  }

  if (state.kind === 'thread-mode') {
    return (
      <Box marginTop={1} flexDirection="column">
        <Text color={umbraTheme.accent}>Threads</Text>
        <Text color={umbraTheme.muted}>↑↓ navigate Enter select Esc close</Text>
        {THREAD_MENU_ITEMS.map((item, index) => (
          <Box key={item.id} flexDirection="row" marginTop={0}>
            <Text color={index === state.selectedIndex ? umbraTheme.accent : umbraTheme.text}>
              {index === state.selectedIndex ? '> ' : '  '}
              {item.label}
            </Text>
            <Text color={umbraTheme.muted}>
              {'  '}
              {item.hint}
            </Text>
          </Box>
        ))}
      </Box>
    );
  }

  if (state.kind === 'compact-settings-model') {
    const items = filterModels(state.models, state.query);
    const { visible, startIndex } = virtualListWindow(items, state.selectedIndex, 8);
    const hasAbove = startIndex > 0;
    const hasBelow = startIndex + visible.length < items.length;

    return (
      <Box marginTop={1} flexDirection="column">
        <Text color={umbraTheme.accent}>Compact settings — model for {state.profile.label}</Text>
        <Text color={umbraTheme.muted}>{`Current model: ${state.currentModel ?? 'none'}`}</Text>
        <Text color={umbraTheme.muted}>Search: {state.query || '(type to filter)'}</Text>
        <Text color={umbraTheme.muted}>Enter select Esc close</Text>
        {hasAbove ? <Text color={umbraTheme.muted}>{`  ↑ ${startIndex} more`}</Text> : null}
        {visible.map((model, i) => {
          const index = startIndex + i;
          return (
            <Box key={model.id}>
              <Text color={index === state.selectedIndex ? umbraTheme.accent : umbraTheme.text}>
                {index === state.selectedIndex ? '> ' : '  '}
                {model.name}
              </Text>
            </Box>
          );
        })}
        {hasBelow ? (
          <Text
            color={umbraTheme.muted}
          >{`  ↓ ${items.length - startIndex - visible.length} more`}</Text>
        ) : null}
      </Box>
    );
  }

  if (state.kind === 'review-settings-provider') {
    const allItems = [
      { id: '__default__', label: 'Default (same as agent)', isDefault: true },
      ...filterProviderProfiles(state.profiles, state.query).map((p) => ({
        id: p.id,
        label: p.label,
        isDefault: false,
      })),
    ];
    const { visible, startIndex } = virtualListWindow(allItems, state.selectedIndex, 8);
    const hasAbove = startIndex > 0;
    const hasBelow = startIndex + visible.length < allItems.length;
    const currentLabel =
      state.currentProvider === null
        ? 'Default'
        : (state.profiles.find((p) => p.id === state.currentProvider)?.label ??
          state.currentProvider);

    return (
      <Box marginTop={1} flexDirection="column">
        <Text color={umbraTheme.accent}>Review settings — provider</Text>
        <Text
          color={umbraTheme.muted}
        >{`Current: ${currentLabel}${state.currentModel ? ` / ${state.currentModel}` : ''}`}</Text>
        <Text color={umbraTheme.muted}>Search: {state.query || '(type to filter)'}</Text>
        <Text color={umbraTheme.muted}>Enter select Esc close</Text>
        {hasAbove ? <Text color={umbraTheme.muted}>{`  ↑ ${startIndex} more`}</Text> : null}
        {visible.map((item, i) => {
          const index = startIndex + i;
          return (
            <Box key={item.id}>
              <Text color={index === state.selectedIndex ? umbraTheme.accent : umbraTheme.text}>
                {index === state.selectedIndex ? '>' : ' '} {item.label}
              </Text>
            </Box>
          );
        })}
        {hasBelow ? (
          <Text
            color={umbraTheme.muted}
          >{`  ↓ ${allItems.length - startIndex - visible.length} more`}</Text>
        ) : null}
      </Box>
    );
  }

  if (state.kind === 'review-settings-model') {
    const items = filterModels(state.models, state.query);
    const { visible, startIndex } = virtualListWindow(items, state.selectedIndex, 8);
    const hasAbove = startIndex > 0;
    const hasBelow = startIndex + visible.length < items.length;

    return (
      <Box marginTop={1} flexDirection="column">
        <Text color={umbraTheme.accent}>Review settings — model for {state.profile.label}</Text>
        <Text color={umbraTheme.muted}>{`Current model: ${state.currentModel ?? 'none'}`}</Text>
        <Text color={umbraTheme.muted}>Search: {state.query || '(type to filter)'}</Text>
        <Text color={umbraTheme.muted}>Enter select Esc close</Text>
        {hasAbove ? <Text color={umbraTheme.muted}>{`  ↑ ${startIndex} more`}</Text> : null}
        {visible.map((model, i) => {
          const index = startIndex + i;
          return (
            <Box key={model.id}>
              <Text color={index === state.selectedIndex ? umbraTheme.accent : umbraTheme.text}>
                {index === state.selectedIndex ? '> ' : '  '}
                {model.name}
              </Text>
            </Box>
          );
        })}
        {hasBelow ? (
          <Text
            color={umbraTheme.muted}
          >{`  ↓ ${items.length - startIndex - visible.length} more`}</Text>
        ) : null}
      </Box>
    );
  }

  if (state.kind === 'think-mode') {
    const opts = getThinkOptions(state.thinkProfile);
    const currentLabel =
      state.currentValue === null
        ? 'off'
        : typeof state.currentValue === 'string'
          ? state.currentValue
          : `${state.currentValue.toLocaleString()} tokens`;
    const isCustomSelected =
      state.selectedIndex === opts.length - 1 && opts.at(-1)?.id === 'custom';
    const profileLabel =
      state.thinkProfile === 'anthropic'
        ? 'Anthropic (budget_tokens)'
        : state.thinkProfile === 'openai-o'
          ? 'OpenAI o-series (reasoning_effort)'
          : state.thinkProfile === 'mistral-magistral'
            ? 'Mistral magistral — always reasoning, built-in'
            : state.thinkProfile === 'mistral-adjustable'
              ? 'Mistral (reasoning_effort: low/medium/high)'
              : 'Not supported by this model';

    return (
      <Box marginTop={1} flexDirection="column">
        <Text color={umbraTheme.accent}>Extended thinking</Text>
        <Text color={umbraTheme.muted}>{`Model: ${profileLabel}`}</Text>
        <Text color={umbraTheme.muted}>{`Current: ${currentLabel}`}</Text>
        <Text color={umbraTheme.muted}>↑↓ navigate Enter confirm Esc cancel</Text>
        {opts.map((opt, index) => {
          const isSelected = index === state.selectedIndex;
          const isCurrent =
            opt.id === 'off'
              ? state.currentValue === null
              : opt.id !== 'custom'
                ? state.currentValue === opt.id
                : typeof state.currentValue === 'number';
          return (
            <Box key={opt.id} flexDirection="column">
              <Text color={isSelected ? umbraTheme.accent : umbraTheme.text}>
                {isSelected ? '>' : ' '} {opt.label}
                {isCurrent ? ' (current)' : ''}
              </Text>
              <Text color={umbraTheme.muted}>{`   ${opt.summary}`}</Text>
            </Box>
          );
        })}
        {isCustomSelected ? (
          <Box marginTop={0}>
            <Text color={umbraTheme.accent}>{'> '}</Text>
            <InputLine
              value={state.customInput}
              cursorPosition={state.customCursor}
              muted={false}
            />
            <Text color={umbraTheme.muted}>{' tokens'}</Text>
          </Box>
        ) : null}
      </Box>
    );
  }

  if (state.kind === 'usage-toggle') {
    const options = [
      { label: 'Off', summary: 'No token counters, clean view.', mode: 'off' as const },
      {
        label: 'Compact  (↑ ↓ symbols)',
        summary: 'Compact: ↑ prompt  ↓ reply  think N  $X.',
        mode: 'compact' as const,
      },
      {
        label: 'Verbose  (words + symbols)',
        summary: 'Verbose: prompt N  reply N  think N  $X.',
        mode: 'verbose' as const,
      },
    ];
    return (
      <Box marginTop={1} flexDirection="column">
        <Text color={umbraTheme.accent}>Token stats</Text>
        <Text color={umbraTheme.muted}>↑↓ navigate 1-3 shortcut Enter confirm Esc cancel</Text>
        {options.map((opt, index) => (
          <Box key={opt.mode} flexDirection="column">
            <Text color={index === state.selectedIndex ? umbraTheme.accent : umbraTheme.text}>
              {index === state.selectedIndex ? '>' : ' '} {index + 1}. {opt.label}
              {opt.mode === state.currentMode ? ' (current)' : ''}
            </Text>
            <Text color={umbraTheme.muted}>{`   ${opt.summary}`}</Text>
          </Box>
        ))}
      </Box>
    );
  }

  if (state.kind === 'provider-custom') {
    const rows = [
      {
        key: 'label',
        label: 'Display name',
        value: state.label,
      },
      {
        key: 'baseUrl',
        label: 'Base URL',
        value: state.baseUrl,
      },
      {
        key: 'apiKey',
        label: 'API key',
        value: maskSecret(state.apiKey),
      },
    ] as const;

    const isConfirm = state.activeField === 'confirm';

    return (
      <Box marginTop={1} flexDirection="column">
        <Text color={umbraTheme.accent}>Custom provider</Text>
        <Text color={umbraTheme.muted}>OpenAI-compatible endpoint</Text>
        {isConfirm ? (
          <Text color={umbraTheme.muted}>Tab — back to edit Enter — create Esc — cancel</Text>
        ) : (
          <Text color={umbraTheme.muted}>Tab — next field Ctrl+Y — paste Enter — confirm</Text>
        )}
        {state.clipboardPreview ? (
          <Text color={umbraTheme.code}>clipboard: {truncatePreview(state.clipboardPreview)}</Text>
        ) : null}
        {rows.map((row) => (
          <Box key={row.key}>
            <Text
              color={
                !isConfirm && state.activeField === row.key ? umbraTheme.accent : umbraTheme.muted
              }
            >
              {!isConfirm && state.activeField === row.key ? '>' : ' '} {row.label.padEnd(14, ' ')}
            </Text>
            <Text
              color={
                !isConfirm && state.activeField === row.key ? umbraTheme.text : umbraTheme.frameDim
              }
            >
              {row.value || '(empty)'}
            </Text>
          </Box>
        ))}
        {isConfirm ? (
          <Box marginTop={1}>
            <Text color={umbraTheme.accent}>{'>  '}</Text>
            <Text color={umbraTheme.accent}>Create provider</Text>
            <Text color={umbraTheme.muted}>{'  ·  Esc to cancel'}</Text>
          </Box>
        ) : null}
      </Box>
    );
  }

  if (state.kind === 'reset-memories-confirm') {
    const isStep2 = state.step === 2;
    return (
      <Box marginTop={1} flexDirection="column">
        <Text color={umbraTheme.danger} bold>
          {isStep2 ? '⚠⚠  Are you REALLY sure?' : '⚠  Reset all local memories?'}
        </Text>
        <Box marginTop={1} flexDirection="column">
          {isStep2 ? (
            <>
              <Text color={umbraTheme.danger}>This action cannot be undone.</Text>
              <Text color={umbraTheme.danger}>All semantic memory for this project will be</Text>
              <Text color={umbraTheme.danger}>permanently wiped from this machine.</Text>
            </>
          ) : (
            <>
              <Text color={umbraTheme.muted}>What gets deleted (LOCAL only, nothing cloud):</Text>
              <Text color={umbraTheme.muted}>{'  · MEMORY.md — project long-term memory'}</Text>
              <Text color={umbraTheme.muted}>
                {'  · Vector embeddings in ~/.umbra/main.sqlite'}
              </Text>
            </>
          )}
        </Box>
        <Box marginTop={1}>
          <Text color={umbraTheme.danger} bold>
            {isStep2 ? 'Y / Enter — WIPE IT' : 'Y / Enter — yes, continue'}
          </Text>
          <Text color={umbraTheme.muted}>{'  ·  '}</Text>
          <Text color={umbraTheme.muted}>{'N / Esc — cancel'}</Text>
        </Box>
      </Box>
    );
  }

  const title =
    state.kind === 'provider-api-key'
      ? `API key for ${state.provider.label}`
      : `Base URL for ${state.provider.label}`;

  return (
    <Box marginTop={1} flexDirection="column">
      <Text color={umbraTheme.accent}>{title}</Text>
      <Text color={umbraTheme.muted}>
        {state.kind === 'provider-api-key'
          ? `${getProviderNote(state.provider)}`
          : 'Enter the provider endpoint URL'}
      </Text>
      <Text color={umbraTheme.muted}>Enter continue Esc close Ctrl+Y paste clipboard</Text>
      {state.clipboardPreview ? (
        <Text color={umbraTheme.code}>clipboard: {truncatePreview(state.clipboardPreview)}</Text>
      ) : (
        <Text color={umbraTheme.muted}>clipboard: empty or unavailable</Text>
      )}
      <Box>
        <Text color={umbraTheme.accent}>{'> '}</Text>
        <InputLine
          value={state.kind === 'provider-api-key' ? maskSecret(state.value) : state.value}
          cursorPosition={state.cursor}
          muted={false}
        />
      </Box>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Skill-create wizard views
// ---------------------------------------------------------------------------

function SkillCreateDialogView({
  state,
}: {
  state: Extract<ProviderDialogState, { kind: 'skill-create-name' | 'skill-create-description' }>;
}) {
  const stepLabel = state.kind === 'skill-create-name' ? '1 / 2' : '2 / 2';
  const title =
    state.kind === 'skill-create-name'
      ? 'Create skill — name'
      : `Create skill "${(state as { name: string }).name}" — what should it do?`;
  const hint =
    state.kind === 'skill-create-name'
      ? 'lowercase letters, numbers and hyphens only  (e.g. deploy, lint-fix)'
      : 'Describe your intent — the model will generate the full skill  (e.g. Search the web for anything and summarize results)';

  return (
    <Box marginTop={1} flexDirection="column">
      <Box>
        <Text color={umbraTheme.accent}>{'◆ '}</Text>
        <Text bold color={umbraTheme.text}>
          {title}
        </Text>
        <Text color={umbraTheme.frameDim}>
          {'  '}
          {stepLabel}
        </Text>
      </Box>
      <Text color={umbraTheme.muted}>{hint}</Text>
      <Text color={umbraTheme.muted}>Enter continue Esc cancel</Text>
      <Box marginTop={1}>
        <Text color={umbraTheme.accent}>{'> '}</Text>
        <InputLine value={state.value} cursorPosition={state.cursor} muted={false} />
      </Box>
    </Box>
  );
}

async function openProviderDialog(
  setProviderDialog: (state: ProviderDialogState | null) => void,
): Promise<void> {
  const [providers, profiles] = await Promise.all([
    listProviderTypes() as Promise<ProviderTypePayload[]>,
    listProviderProfiles() as Promise<{ profiles: ProviderProfilePayload[] }>,
  ]);
  const sorted = [...providers].sort((a, b) => {
    if (a.value === 'opencode-zen') return -1;
    if (b.value === 'opencode-zen') return 1;
    return 0;
  });
  setProviderDialog({
    kind: 'provider-list',
    query: '',
    selectedIndex: 0,
    providers: sorted,
    profiles: profiles.profiles,
  });
}

async function openModelDialog(
  setProviderDialog: (state: ProviderDialogState | null) => void,
  appendEntries: (entries: SessionEntry[]) => void,
): Promise<void> {
  const active = await resolveActiveProviderProfile();

  if (!active.profile) {
    appendEntries([
      {
        id: createEntryId(),
        kind: 'event',
        tone: 'danger',
        text: 'system> no active provider. Use /provider connect first.',
      },
    ]);
    return;
  }

  const payload = (await listProviderModels(active.profile.id)) as {
    models: ListedModel[];
  };
  setProviderDialog({
    kind: 'model-list',
    query: '',
    selectedIndex: 0,
    profile: active.profile,
    models: payload.models,
  });
}

async function openProviderProfileDialog(
  setProviderDialog: (state: ProviderDialogState | null) => void,
  appendEntries: (entries: SessionEntry[]) => void,
): Promise<void> {
  const payload = (await listProviderProfiles()) as {
    profiles: ProviderProfilePayload[];
  };
  const profiles = payload.profiles.filter((profile) => profile.status !== 'unavailable');

  if (profiles.length === 0) {
    appendEntries([
      {
        id: createEntryId(),
        kind: 'event',
        tone: 'danger',
        text: 'system> no usable provider profiles. Use /provider connect first.',
      },
    ]);
    return;
  }

  setProviderDialog({
    kind: 'provider-profile-list',
    query: '',
    selectedIndex: 0,
    profiles,
  });
}

async function openProviderRemoveDialog(
  setProviderDialog: (state: ProviderDialogState | null) => void,
  appendEntries: (entries: SessionEntry[]) => void,
): Promise<void> {
  const payload = (await listProviderProfiles()) as { profiles: ProviderProfilePayload[] };
  const profiles = payload.profiles;

  if (profiles.length === 0) {
    appendEntries([
      {
        id: createEntryId(),
        kind: 'event',
        tone: 'info',
        text: 'system> no provider profiles configured.',
      },
    ]);
    return;
  }

  setProviderDialog({ kind: 'provider-remove-list', query: '', selectedIndex: 0, profiles });
}

async function openThreadDialog(
  action: 'resume' | 'fork',
  projectPath: string,
  setProviderDialog: (state: ProviderDialogState | null) => void,
  appendEntries: (entries: SessionEntry[]) => void,
): Promise<void> {
  const payload = (await listThreads({
    projectPath,
    archived: false,
    limit: 30,
  })) as { threads: ThreadPayload[] };

  if (payload.threads.length === 0) {
    appendEntries([
      {
        id: createEntryId(),
        kind: 'event',
        tone: 'danger',
        text: 'system> no recent threads for this project yet.',
      },
    ]);
    return;
  }

  setProviderDialog({
    kind: 'thread-list',
    action,
    query: '',
    selectedIndex: 0,
    threads: payload.threads,
  });
}

async function openMemorySettingsDialog(
  projectPath: string,
  currentThread: ThreadPayload | null,
  runtimeSettings: MemorySettingsPayload | null,
  setProviderDialog: (state: ProviderDialogState | null) => void,
): Promise<void> {
  const settings = runtimeSettings ?? ((await getMemorySettings()) as MemorySettingsPayload);
  const thread =
    currentThread ??
    (await resolveCurrentThread(projectPath).catch(() => {
      return null;
    }));

  setProviderDialog({
    kind: 'memory-settings',
    selectedIndex: 0,
    runtimeSettings: settings,
    thread,
    confirmReset: null,
  });
}

async function openCompactSettingsDialog(
  setProviderDialog: (state: ProviderDialogState | null) => void,
  appendEntries: (entries: SessionEntry[]) => void,
): Promise<void> {
  const payload = (await listProviderProfiles()) as { profiles: ProviderProfilePayload[] };
  const profiles = payload.profiles.filter((p) => p.status !== 'unavailable');

  if (profiles.length === 0) {
    appendEntries([
      {
        id: createEntryId(),
        kind: 'event',
        tone: 'danger',
        text: 'system> no usable provider profiles. Use /provider connect first.',
      },
    ]);
    return;
  }

  const current = getCompactSettings();
  setProviderDialog({
    kind: 'compact-settings-provider',
    query: '',
    selectedIndex: 0,
    profiles,
    currentProvider: current.provider,
    currentModel: current.model,
  });
}

async function openReviewSettingsDialog(
  setProviderDialog: (state: ProviderDialogState | null) => void,
  appendEntries: (entries: SessionEntry[]) => void,
): Promise<void> {
  const payload = (await listProviderProfiles()) as { profiles: ProviderProfilePayload[] };
  const profiles = payload.profiles.filter((p) => p.status !== 'unavailable');

  if (profiles.length === 0) {
    appendEntries([
      {
        id: createEntryId(),
        kind: 'event',
        tone: 'danger',
        text: 'system> no usable provider profiles. Use /provider connect first.',
      },
    ]);
    return;
  }

  const current = getReviewSettings();
  setProviderDialog({
    kind: 'review-settings-provider',
    query: '',
    selectedIndex: 0,
    profiles,
    currentProvider: current.provider,
    currentModel: current.model,
  });
}

async function handleProviderDialogInput(
  state: ProviderDialogState,
  input: string,
  key: Parameters<Parameters<typeof useInput>[0]>[1],
  actions: {
    setProviderDialog: (state: ProviderDialogState | null) => void;
    appendEntries: (entries: SessionEntry[]) => void;
    replaceEntries: (entries: SessionEntry[]) => void;
    refreshStatus: () => Promise<void>;
    setRuntimeMode: (mode: 'agent' | 'full') => void;
    projectPath: string;
    currentThread: ThreadPayload | null;
    setCurrentThread: (thread: ThreadPayload | null) => void;
    setCurrentSessionId: (sessionId: string | null) => void;
    setRuntimeMemorySettings: (settings: MemorySettingsPayload | null) => void;
    submitPrompt?: (prompt: string) => void;
    setThinkBudget?: (value: number | 'low' | 'medium' | 'high' | 'max' | null) => void;
    setUsageDetailMode?: (m: UsageDetailMode) => void;
    resetSessionStats?: () => void;
    setGitEnabled?: (enabled: boolean) => void;
    setShowPath?: (visible: boolean) => void;
    setActiveThemeName?: (name: string) => void;
    previewTheme?: (name: string) => void;
  },
): Promise<void> {
  // theme-select: Esc reverts to the original theme before closing
  if (state.kind === 'theme-select' && (key.escape || (key.ctrl && input === 'c'))) {
    actions.previewTheme?.(state.currentTheme);
    actions.setProviderDialog(null);
    return;
  }

  // web sub-dialogs: Esc goes back to parent, not close
  if (
    (state.kind === 'web-provider-api-key' || state.kind === 'web-provider-base-url') &&
    (key.escape || (key.ctrl && input === 'c'))
  ) {
    actions.setProviderDialog({
      kind: 'web-provider-menu',
      provider: state.provider,
      selectedIndex: 0,
    });
    return;
  }
  if (state.kind === 'web-provider-menu' && (key.escape || (key.ctrl && input === 'c'))) {
    void (async () => {
      try {
        const settings = (await getWebSearchSettings()) as WebSearchSettingsPayload;
        const modeOrder = ['off', 'cached', 'live'] as const;
        const modeIndex = modeOrder.indexOf(settings.mode);
        actions.setProviderDialog({
          kind: 'web-mode',
          selectedIndex: modeIndex >= 0 ? modeIndex : 0,
          currentMode: settings.mode,
          currentProviderId: settings.providerId,
          providers: settings.availableProviders,
        });
      } catch {
        actions.setProviderDialog(null);
      }
    })();
    return;
  }

  if (key.escape || (key.ctrl && input === 'c')) {
    actions.setProviderDialog(null);
    return;
  }

  if (state.kind === 'no-provider-prompt') {
    if (key.upArrow || key.downArrow) {
      actions.setProviderDialog({ ...state, selectedIndex: state.selectedIndex === 0 ? 1 : 0 });
      return;
    }
    if (key.return) {
      if (state.selectedIndex === 0) {
        void openProviderDialog(actions.setProviderDialog).catch(() => {});
      } else {
        actions.setProviderDialog(null);
      }
      return;
    }
    return;
  }

  if (state.kind === 'provider-menu') {
    const items = PROVIDER_MENU_ITEMS;
    if (key.upArrow || key.downArrow) {
      actions.setProviderDialog({
        ...state,
        selectedIndex: key.upArrow
          ? state.selectedIndex <= 0
            ? items.length - 1
            : state.selectedIndex - 1
          : state.selectedIndex >= items.length - 1
            ? 0
            : state.selectedIndex + 1,
      });
      return;
    }
    if (key.return) {
      const item = items[state.selectedIndex];
      if (!item) return;
      if (item.id === 'connect') {
        void openProviderDialog(actions.setProviderDialog).catch(() => {});
      } else if (item.id === 'use') {
        void openProviderProfileDialog(actions.setProviderDialog, actions.appendEntries).catch(
          () => {},
        );
      } else if (item.id === 'models') {
        void openModelDialog(actions.setProviderDialog, actions.appendEntries).catch(() => {});
      } else if (item.id === 'remove') {
        void openProviderRemoveDialog(actions.setProviderDialog, actions.appendEntries).catch(
          () => {},
        );
      } else if (item.id === 'list') {
        actions.setProviderDialog(null);
        void (async () => {
          const payload = (await listProviderProfiles()) as {
            profiles: Array<{
              id: string;
              label: string;
              type: string;
              status: string;
              model: string | null;
            }>;
            defaultProfileId: string | null;
            activeProfileId: string | null;
          };
          if (payload.profiles.length === 0) {
            actions.appendEntries([
              {
                id: createEntryId(),
                kind: 'event',
                tone: 'info',
                text: 'system> no provider profiles configured.',
              },
            ]);
            return;
          }
          for (const p of payload.profiles) {
            const flags = [
              p.type,
              p.status,
              p.model ?? 'no model',
              payload.defaultProfileId === p.id ? 'default' : '',
              payload.activeProfileId === p.id ? 'active' : '',
            ]
              .filter(Boolean)
              .join('  ');
            actions.appendEntries([
              {
                id: createEntryId(),
                kind: 'event',
                tone: 'info',
                text: `  ${p.label}  [${flags}]`,
              },
            ]);
          }
        })();
      }
    }
    return;
  }

  if (state.kind === 'thread-mode') {
    const items = THREAD_MENU_ITEMS;
    if (key.upArrow || key.downArrow) {
      actions.setProviderDialog({
        ...state,
        selectedIndex: key.upArrow
          ? state.selectedIndex <= 0
            ? items.length - 1
            : state.selectedIndex - 1
          : state.selectedIndex >= items.length - 1
            ? 0
            : state.selectedIndex + 1,
      });
      return;
    }

    if (key.return) {
      const item = items[state.selectedIndex];
      if (!item) return;

      if (item.id === 'list') {
        actions.setProviderDialog(null);
        void (async () => {
          const payload = (await listThreads({
            projectPath: actions.projectPath,
            archived: false,
            limit: 20,
          })) as { threads: ThreadPayload[] };
          if (payload.threads.length === 0) {
            actions.appendEntries([
              {
                id: createEntryId(),
                kind: 'event',
                tone: 'info',
                text: 'system> no threads found for this project.',
              },
            ]);
            return;
          }
          actions.appendEntries([
            { id: createEntryId(), kind: 'event', tone: 'info', text: 'system> Recent threads:' },
          ]);
          for (const t of payload.threads) {
            actions.appendEntries([
              {
                id: createEntryId(),
                kind: 'event',
                tone: 'info',
                text: `  ${t.id.slice(0, 8)}  ${t.title}  [${t.eventCount} events, ${formatThreadDate(t.updatedAt)}]`,
              },
            ]);
          }
        })();
      } else if (item.id === 'resume') {
        void openThreadDialog(
          'resume',
          actions.projectPath,
          actions.setProviderDialog,
          actions.appendEntries,
        ).catch(() => {});
      } else if (item.id === 'fork') {
        void openThreadDialog(
          'fork',
          actions.projectPath,
          actions.setProviderDialog,
          actions.appendEntries,
        ).catch(() => {});
      } else if (item.id === 'archive') {
        actions.setProviderDialog(null);
        if (!actions.currentThread) {
          actions.appendEntries([
            {
              id: createEntryId(),
              kind: 'event',
              tone: 'danger',
              text: 'system> no active thread to archive',
            },
          ]);
          return;
        }
        void (async () => {
          try {
            const archived = (await archiveThread(
              actions.currentThread?.id ?? '',
            )) as ThreadPayload;
            actions.setCurrentThread(null);
            actions.setCurrentSessionId(null);
            actions.appendEntries([
              {
                id: createEntryId(),
                kind: 'event',
                tone: 'success',
                text: `system> thread archived: ${archived.title}`,
              },
            ]);
          } catch (e: unknown) {
            const message = e instanceof Error ? e.message : String(e);
            actions.appendEntries([
              {
                id: createEntryId(),
                kind: 'event',
                tone: 'danger',
                text: `system> archive failed: ${message}`,
              },
            ]);
          }
        })();
      } else if (item.id === 'export') {
        actions.setProviderDialog(null);
        if (!actions.currentThread) {
          actions.appendEntries([
            {
              id: createEntryId(),
              kind: 'event',
              tone: 'danger',
              text: 'system> no active thread to export',
            },
          ]);
          return;
        }
        void (async () => {
          try {
            const result = (await exportThread(actions.currentThread?.id ?? '')) as {
              exportPath: string;
            };
            actions.appendEntries([
              {
                id: createEntryId(),
                kind: 'event',
                tone: 'success',
                text: `system> thread exported to ${result.exportPath}`,
              },
            ]);
          } catch (e: unknown) {
            const message = e instanceof Error ? e.message : String(e);
            actions.appendEntries([
              {
                id: createEntryId(),
                kind: 'event',
                tone: 'danger',
                text: `system> export failed: ${message}`,
              },
            ]);
          }
        })();
      } else if (item.id === 'detect') {
        actions.setProviderDialog(null);
        void (async () => {
          try {
            const result = (await detectImportableThreads()) as {
              candidates: Array<{ filePath: string; fileName: string }>;
            };
            if (result.candidates.length === 0) {
              actions.appendEntries([
                {
                  id: createEntryId(),
                  kind: 'event',
                  tone: 'info',
                  text: 'system> no importable session logs detected',
                },
              ]);
              return;
            }
            actions.appendEntries([
              {
                id: createEntryId(),
                kind: 'event',
                tone: 'success',
                text: `system> detected ${result.candidates.length} logs. Use /thread import <path>`,
              },
            ]);
            for (const c of result.candidates) {
              actions.appendEntries([
                { id: createEntryId(), kind: 'event', tone: 'info', text: `  - ${c.filePath}` },
              ]);
            }
          } catch (e: unknown) {
            const message = e instanceof Error ? e.message : String(e);
            actions.appendEntries([
              {
                id: createEntryId(),
                kind: 'event',
                tone: 'danger',
                text: `system> detect failed: ${message}`,
              },
            ]);
          }
        })();
      }
    }
    return;
  }

  if (state.kind === 'permission-mode') {
    const options = permissionModeOptions(state.currentMode);

    if (key.upArrow || key.downArrow) {
      actions.setProviderDialog({
        ...state,
        selectedIndex: key.upArrow
          ? state.selectedIndex <= 0
            ? Math.max(0, options.length - 1)
            : state.selectedIndex - 1
          : state.selectedIndex >= options.length - 1
            ? 0
            : state.selectedIndex + 1,
      });
      return;
    }

    if (key.return) {
      const selected = options[state.selectedIndex] ?? options[0];
      if (!selected) {
        return;
      }

      actions.setRuntimeMode(selected.mode);
      actions.setProviderDialog(null);
      actions.appendEntries([
        {
          id: createEntryId(),
          kind: 'event',
          tone: 'success',
          text: `system> Permissions updated to ${selected.label}`,
        },
      ]);
      return;
    }

    if (!key.ctrl && !key.meta && /^[123]$/.test(input)) {
      const selected = options[Number(input) - 1];
      if (!selected) {
        return;
      }
      actions.setRuntimeMode(selected.mode);
      actions.setProviderDialog(null);
      actions.appendEntries([
        {
          id: createEntryId(),
          kind: 'event',
          tone: 'success',
          text: `system> Permissions updated to ${selected.label}`,
        },
      ]);
      return;
    }
  }

  if (state.kind === 'web-mode') {
    const modeItems = [
      { id: 'off', mode: 'off' as const },
      { id: 'cached', mode: 'cached' as const },
      { id: 'live', mode: 'live' as const },
    ];
    const allCount = modeItems.length + state.providers.length;

    if (key.upArrow || key.downArrow) {
      actions.setProviderDialog({
        ...state,
        selectedIndex: key.upArrow
          ? state.selectedIndex <= 0
            ? allCount - 1
            : state.selectedIndex - 1
          : state.selectedIndex >= allCount - 1
            ? 0
            : state.selectedIndex + 1,
      });
      return;
    }

    if (key.return) {
      if (state.selectedIndex < modeItems.length) {
        const item = modeItems[state.selectedIndex]!;
        const updated = (await updateWebSearchSettings({
          mode: item.mode,
        })) as WebSearchSettingsPayload;
        actions.setProviderDialog(null);
        actions.appendEntries([
          {
            id: createEntryId(),
            kind: 'event',
            tone: updated.enabled ? 'success' : 'info',
            text: `system> web search ${updated.mode} / ${updated.providerLabel}`,
          },
        ]);
        void actions.refreshStatus();
      } else {
        const provider = state.providers[state.selectedIndex - modeItems.length];
        if (!provider) return;
        actions.setProviderDialog({ kind: 'web-provider-menu', provider, selectedIndex: 0 });
      }
      return;
    }

    if (!key.ctrl && !key.meta && /^\d$/.test(input)) {
      const num = Number(input) - 1;
      if (num >= 0 && num < allCount) {
        actions.setProviderDialog({ ...state, selectedIndex: num });
      }
      return;
    }

    return;
  }

  if (state.kind === 'web-provider-menu') {
    const p = state.provider;
    const hasKey = p.configured && p.authSource === 'runtime';
    const items = [
      { id: 'use', label: 'Use this provider' },
      { id: 'apikey', label: hasKey ? 'Change API key' : 'Set API key' },
      { id: 'baseurl', label: 'Set base URL' },
      ...(hasKey ? [{ id: 'clearkey', label: 'Clear API key' }] : []),
    ];

    if (key.upArrow || key.downArrow) {
      actions.setProviderDialog({
        ...state,
        selectedIndex: key.upArrow
          ? state.selectedIndex <= 0
            ? items.length - 1
            : state.selectedIndex - 1
          : state.selectedIndex >= items.length - 1
            ? 0
            : state.selectedIndex + 1,
      });
      return;
    }

    if (key.return) {
      const item = items[state.selectedIndex];
      if (!item) return;

      if (item.id === 'use') {
        const updated = (await updateWebSearchSettings({
          providerId: p.id,
        })) as WebSearchSettingsPayload;
        actions.appendEntries([
          {
            id: createEntryId(),
            kind: 'event',
            tone: 'success',
            text: `system> web search provider → ${updated.providerLabel}`,
          },
        ]);
        void actions.refreshStatus();
        const modeOrder = ['off', 'cached', 'live'] as const;
        const modeIndex = modeOrder.indexOf(updated.mode);
        actions.setProviderDialog({
          kind: 'web-mode',
          selectedIndex: modeIndex >= 0 ? modeIndex : 0,
          currentMode: updated.mode,
          currentProviderId: updated.providerId,
          providers: updated.availableProviders,
        });
        return;
      }

      if (item.id === 'apikey') {
        const clipboardPreview = await readClipboardText();
        actions.setProviderDialog({
          kind: 'web-provider-api-key',
          provider: p,
          value: '',
          cursor: 0,
          clipboardPreview,
        });
        return;
      }

      if (item.id === 'baseurl') {
        const clipboardPreview = await readClipboardText();
        actions.setProviderDialog({
          kind: 'web-provider-base-url',
          provider: p,
          value: p.baseUrl ?? '',
          cursor: (p.baseUrl ?? '').length,
          clipboardPreview,
        });
        return;
      }

      if (item.id === 'clearkey') {
        await updateWebSearchSettings({ providerConfig: { id: p.id, apiKey: null } });
        actions.appendEntries([
          {
            id: createEntryId(),
            kind: 'event',
            tone: 'info',
            text: `system> API key cleared for ${p.label}`,
          },
        ]);
        const settings = (await getWebSearchSettings()) as WebSearchSettingsPayload;
        const fresh = settings.availableProviders.find((x) => x.id === p.id) ?? p;
        actions.setProviderDialog({ kind: 'web-provider-menu', provider: fresh, selectedIndex: 0 });
        return;
      }
    }

    if (!key.ctrl && !key.meta && /^\d$/.test(input)) {
      const num = Number(input) - 1;
      if (num >= 0 && num < items.length) {
        actions.setProviderDialog({ ...state, selectedIndex: num });
      }
      return;
    }
    return;
  }

  if (state.kind === 'web-provider-api-key') {
    if (key.ctrl && input.toLowerCase() === 'y' && state.clipboardPreview) {
      const val = state.clipboardPreview.trim();
      actions.setProviderDialog({ ...state, value: val, cursor: val.length });
      return;
    }
    if (key.leftArrow) {
      actions.setProviderDialog({ ...state, cursor: Math.max(0, state.cursor - 1) });
      return;
    }
    if (key.rightArrow) {
      actions.setProviderDialog({
        ...state,
        cursor: Math.min(state.value.length, state.cursor + 1),
      });
      return;
    }
    if (key.backspace) {
      if (state.cursor <= 0) return;
      const next = `${state.value.slice(0, state.cursor - 1)}${state.value.slice(state.cursor)}`;
      actions.setProviderDialog({ ...state, value: next, cursor: state.cursor - 1 });
      return;
    }
    if (key.return) {
      const apiKey = state.value.trim() || null;
      await updateWebSearchSettings({ providerConfig: { id: state.provider.id, apiKey } });
      actions.appendEntries([
        {
          id: createEntryId(),
          kind: 'event',
          tone: 'success',
          text: apiKey
            ? `system> API key saved for ${state.provider.label}`
            : `system> API key cleared for ${state.provider.label}`,
        },
      ]);
      const settings = (await getWebSearchSettings()) as WebSearchSettingsPayload;
      const fresh =
        settings.availableProviders.find((x) => x.id === state.provider.id) ?? state.provider;
      actions.setProviderDialog({ kind: 'web-provider-menu', provider: fresh, selectedIndex: 0 });
      return;
    }
    if (!key.ctrl && !key.meta && input) {
      const next = `${state.value.slice(0, state.cursor)}${input}${state.value.slice(state.cursor)}`;
      actions.setProviderDialog({ ...state, value: next, cursor: state.cursor + input.length });
      return;
    }
    return;
  }

  if (state.kind === 'web-provider-base-url') {
    if (key.ctrl && input.toLowerCase() === 'y' && state.clipboardPreview) {
      const val = state.clipboardPreview.trim();
      actions.setProviderDialog({ ...state, value: val, cursor: val.length });
      return;
    }
    if (key.leftArrow) {
      actions.setProviderDialog({ ...state, cursor: Math.max(0, state.cursor - 1) });
      return;
    }
    if (key.rightArrow) {
      actions.setProviderDialog({
        ...state,
        cursor: Math.min(state.value.length, state.cursor + 1),
      });
      return;
    }
    if (key.backspace) {
      if (state.cursor <= 0) return;
      const next = `${state.value.slice(0, state.cursor - 1)}${state.value.slice(state.cursor)}`;
      actions.setProviderDialog({ ...state, value: next, cursor: state.cursor - 1 });
      return;
    }
    if (key.return) {
      const baseUrl = state.value.trim() || null;
      await updateWebSearchSettings({ providerConfig: { id: state.provider.id, baseUrl } });
      actions.appendEntries([
        {
          id: createEntryId(),
          kind: 'event',
          tone: 'success',
          text: baseUrl
            ? `system> base URL saved for ${state.provider.label}: ${baseUrl}`
            : `system> base URL reset to default for ${state.provider.label}`,
        },
      ]);
      const settings = (await getWebSearchSettings()) as WebSearchSettingsPayload;
      const fresh =
        settings.availableProviders.find((x) => x.id === state.provider.id) ?? state.provider;
      actions.setProviderDialog({ kind: 'web-provider-menu', provider: fresh, selectedIndex: 0 });
      return;
    }
    if (!key.ctrl && !key.meta && input) {
      const next = `${state.value.slice(0, state.cursor)}${input}${state.value.slice(state.cursor)}`;
      actions.setProviderDialog({ ...state, value: next, cursor: state.cursor + input.length });
      return;
    }
    return;
  }

  if (state.kind === 'git-mode') {
    const options = [
      { id: 'on', label: 'Enable git tools', value: true },
      { id: 'off', label: 'Disable git tools', value: false },
    ];

    if (key.upArrow || key.downArrow) {
      actions.setProviderDialog({
        ...state,
        selectedIndex: key.upArrow
          ? state.selectedIndex <= 0
            ? options.length - 1
            : state.selectedIndex - 1
          : state.selectedIndex >= options.length - 1
            ? 0
            : state.selectedIndex + 1,
      });
      return;
    }

    if (key.return) {
      const selected = options[state.selectedIndex] ?? options[0];
      if (!selected) return;
      actions.setGitEnabled?.(selected.value);
      actions.setProviderDialog(null);
      actions.appendEntries([
        {
          id: createEntryId(),
          kind: 'event',
          tone: selected.value ? 'success' : 'info',
          text: `system> git tools ${selected.value ? 'enabled' : 'disabled'} for this session`,
        },
      ]);
      return;
    }

    if (!key.ctrl && !key.meta && /^[12]$/.test(input)) {
      const selected = options[Number(input) - 1];
      if (!selected) return;
      actions.setGitEnabled?.(selected.value);
      actions.setProviderDialog(null);
      actions.appendEntries([
        {
          id: createEntryId(),
          kind: 'event',
          tone: selected.value ? 'success' : 'info',
          text: `system> git tools ${selected.value ? 'enabled' : 'disabled'} for this session`,
        },
      ]);
      return;
    }
  }

  if (state.kind === 'path-visibility') {
    const options = [
      { id: 'on', label: 'Show path in status bar', value: true },
      { id: 'off', label: 'Hide path in status bar', value: false },
    ];

    if (key.upArrow || key.downArrow) {
      actions.setProviderDialog({
        ...state,
        selectedIndex: key.upArrow
          ? state.selectedIndex <= 0
            ? options.length - 1
            : state.selectedIndex - 1
          : state.selectedIndex >= options.length - 1
            ? 0
            : state.selectedIndex + 1,
      });
      return;
    }

    if (key.return) {
      const selected = options[state.selectedIndex] ?? options[0];
      if (!selected) return;
      actions.setShowPath?.(selected.value);
      actions.setProviderDialog(null);
      actions.appendEntries([
        {
          id: createEntryId(),
          kind: 'event',
          tone: 'info',
          text: `system> path display ${selected.value ? 'shown' : 'hidden'}`,
        },
      ]);
      return;
    }

    if (!key.ctrl && !key.meta && /^[12]$/.test(input)) {
      const selected = options[Number(input) - 1];
      if (!selected) return;
      actions.setShowPath?.(selected.value);
      actions.setProviderDialog(null);
      actions.appendEntries([
        {
          id: createEntryId(),
          kind: 'event',
          tone: 'info',
          text: `system> path display ${selected.value ? 'shown' : 'hidden'}`,
        },
      ]);
      return;
    }
  }

  if (state.kind === 'theme-select') {
    const filtered = state.query
      ? THEME_NAMES.filter((n) => n.includes(state.query.toLowerCase()))
      : THEME_NAMES;

    if (key.upArrow || key.downArrow) {
      const next = key.upArrow
        ? state.selectedIndex <= 0
          ? filtered.length - 1
          : state.selectedIndex - 1
        : state.selectedIndex >= filtered.length - 1
          ? 0
          : state.selectedIndex + 1;
      const previewName = filtered[next] ?? state.currentTheme;
      actions.previewTheme?.(previewName);
      actions.setProviderDialog({ ...state, selectedIndex: next });
      return;
    }

    if (key.return) {
      const name = filtered[state.selectedIndex] ?? state.currentTheme;
      // persist: update module tracker + save to disk
      setCurrentThemeName(name);
      setThemePreference(name);
      actions.setProviderDialog(null);
      actions.appendEntries([
        {
          id: createEntryId(),
          kind: 'event',
          tone: 'success',
          text: `system> theme switched to "${name}"`,
        },
      ]);
      return;
    }

    if (!key.ctrl && !key.meta && input.length === 1) {
      const newQuery = state.query + input;
      const newFiltered = THEME_NAMES.filter((n) => n.includes(newQuery.toLowerCase()));
      const previewName = newFiltered[0] ?? state.currentTheme;
      actions.previewTheme?.(previewName);
      actions.setProviderDialog({ ...state, query: newQuery, selectedIndex: 0 });
      return;
    }

    if (key.backspace || key.delete) {
      const newQuery = state.query.slice(0, -1);
      const newFiltered = newQuery
        ? THEME_NAMES.filter((n) => n.includes(newQuery.toLowerCase()))
        : THEME_NAMES;
      const previewName = newFiltered[0] ?? state.currentTheme;
      actions.previewTheme?.(previewName);
      actions.setProviderDialog({ ...state, query: newQuery, selectedIndex: 0 });
      return;
    }
  }

  if (state.kind === 'usage-toggle') {
    const options: Array<{ label: string; mode: UsageDetailMode }> = [
      { label: 'Off', mode: 'off' },
      { label: 'Compact  (↑ ↓ symbols)', mode: 'compact' },
      { label: 'Verbose  (words + symbols)', mode: 'verbose' },
    ];

    if (key.upArrow || key.downArrow) {
      actions.setProviderDialog({
        ...state,
        selectedIndex: key.upArrow
          ? state.selectedIndex <= 0
            ? options.length - 1
            : state.selectedIndex - 1
          : state.selectedIndex >= options.length - 1
            ? 0
            : state.selectedIndex + 1,
      });
      return;
    }

    if (key.return || (!key.ctrl && !key.meta && /^[123]$/.test(input))) {
      const idx = /^[123]$/.test(input) ? Number(input) - 1 : state.selectedIndex;
      const selected = options[idx] ?? options[state.selectedIndex];
      if (selected && actions.setUsageDetailMode) {
        actions.setUsageDetailMode(selected.mode);
      }
      actions.setProviderDialog(null);
      const label = selected?.mode === 'off' ? 'off' : `on (${selected?.mode})`;
      actions.appendEntries([
        {
          id: createEntryId(),
          kind: 'event',
          tone: 'info',
          text: `system> token stats ${label}`,
        },
      ]);
      return;
    }
  }

  if (state.kind === 'thread-list') {
    const items = filterThreads(state.threads, state.query);

    if (key.upArrow || key.downArrow) {
      actions.setProviderDialog({
        ...state,
        selectedIndex: key.upArrow
          ? state.selectedIndex <= 0
            ? Math.max(0, items.length - 1)
            : state.selectedIndex - 1
          : state.selectedIndex >= items.length - 1
            ? 0
            : state.selectedIndex + 1,
      });
      return;
    }

    if (key.backspace || key.delete) {
      actions.setProviderDialog({
        ...state,
        query: state.query.slice(0, -1),
        selectedIndex: 0,
      });
      return;
    }

    if (key.return) {
      const thread = items[state.selectedIndex] ?? items[0];

      if (!thread) {
        return;
      }

      const nextThread =
        state.action === 'resume'
          ? ((await resumeThread(thread.id, actions.projectPath)) as ThreadPayload)
          : ((await forkThread(thread.id, { projectPath: actions.projectPath })) as ThreadPayload);
      actions.setCurrentThread(nextThread);
      actions.setCurrentSessionId(nextThread.sessionId);
      actions.setProviderDialog(null);
      actions.resetSessionStats?.();
      actions.replaceEntries(await buildThreadRestoreEntries(nextThread, state.action));
      return;
    }

    if (!key.ctrl && !key.meta && input) {
      actions.setProviderDialog({
        ...state,
        query: `${state.query}${input}`,
        selectedIndex: 0,
      });
    }
    return;
  }

  if (state.kind === 'memory-settings') {
    const rows = buildMemoryDialogRows(state);

    if (key.upArrow || key.downArrow) {
      actions.setProviderDialog({
        ...state,
        selectedIndex: key.upArrow
          ? state.selectedIndex <= 0
            ? Math.max(0, rows.length - 1)
            : state.selectedIndex - 1
          : state.selectedIndex >= rows.length - 1
            ? 0
            : state.selectedIndex + 1,
      });
      return;
    }

    if (!key.return) {
      return;
    }

    const selected = rows[state.selectedIndex];

    if (!selected) {
      return;
    }

    if (selected.id === 'thread-use' && state.thread) {
      const updated = (await updateThreadSettings(state.thread.id, {
        projectPath: state.thread.projectPath,
        useMemories: !state.thread.useMemories,
      })) as ThreadPayload;
      actions.setCurrentThread(updated);
      actions.setProviderDialog({
        ...state,
        thread: updated,
      });
      return;
    }

    if (selected.id === 'thread-generate' && state.thread) {
      const updated = (await updateThreadSettings(state.thread.id, {
        projectPath: state.thread.projectPath,
        generateMemories: !state.thread.generateMemories,
      })) as ThreadPayload;
      actions.setCurrentThread(updated);
      actions.setProviderDialog({
        ...state,
        thread: updated,
      });
      return;
    }

    if (selected.id === 'runtime-use') {
      const updated = (await updateMemorySettings({
        useMemories: !state.runtimeSettings.useMemories,
      })) as MemorySettingsPayload;
      actions.setRuntimeMemorySettings(updated);
      actions.setProviderDialog({
        ...state,
        runtimeSettings: updated,
      });
      return;
    }

    if (selected.id === 'runtime-generate') {
      const updated = (await updateMemorySettings({
        generateMemories: !state.runtimeSettings.generateMemories,
      })) as MemorySettingsPayload;
      actions.setRuntimeMemorySettings(updated);
      actions.setProviderDialog({
        ...state,
        runtimeSettings: updated,
      });
      return;
    }

    if (selected.id === 'runtime-draft') {
      const updated = (await updateMemorySettings({
        draftPersistence: !state.runtimeSettings.draftPersistence,
      })) as MemorySettingsPayload;
      actions.setRuntimeMemorySettings(updated);
      actions.setProviderDialog({
        ...state,
        runtimeSettings: updated,
      });
      return;
    }

    if (selected.id === 'reset-thread' || selected.id === 'reset-project') {
      const scope = selected.id === 'reset-thread' ? 'thread' : 'project';

      if (state.confirmReset !== scope) {
        actions.setProviderDialog({
          ...state,
          confirmReset: scope,
        });
        return;
      }

      const result = (await resetMemories({
        ...(scope === 'thread' && state.thread ? { threadId: state.thread.id } : {}),
        ...(scope === 'project' ? { projectPath: actions.projectPath } : {}),
      })) as {
        clearedVectors: number;
        clearedProjectMemory: boolean;
        threadId: string | null;
      };
      actions.setProviderDialog({
        ...state,
        confirmReset: null,
      });
      actions.appendEntries([
        {
          id: createEntryId(),
          kind: 'card',
          title: 'Memory Reset',
          entries: [
            ['Scope', scope],
            ['Vectors', String(result.clearedVectors)],
            ['Project memory', result.clearedProjectMemory ? 'cleared' : 'unchanged'],
          ],
        },
      ]);

      if (scope === 'thread' && state.thread) {
        const refreshed = (await getThread(
          state.thread.id,
          state.thread.projectPath,
        )) as ThreadPayload;
        actions.setCurrentThread(refreshed);
        actions.setProviderDialog({
          ...state,
          confirmReset: null,
          thread: refreshed,
        });
      }
      return;
    }
  }

  // --- skill-create wizard ---------------------------------------------------
  if (state.kind === 'skill-create-name') {
    if (key.return) {
      const name = state.value.trim();
      if (!name) return;
      actions.setProviderDialog({ kind: 'skill-create-description', name, value: '', cursor: 0 });
      return;
    }
    actions.setProviderDialog(applyTextInput(state, input, key));
    return;
  }

  if (state.kind === 'skill-create-description') {
    if (key.return) {
      const name = state.name;
      const userRequest = state.value.trim() || `${name} skill`;
      actions.setProviderDialog(null);

      const skillsDir = `${actions.projectPath}/.umbra/skills`;
      const skillFile = `${skillsDir}/${name}/SKILL.md`;
      const agentPrompt = buildSkillCreatePrompt({ name, userRequest, skillsDir, skillFile });

      actions.submitPrompt?.(agentPrompt);
      return;
    }
    actions.setProviderDialog(applyTextInput(state, input, key));
    return;
  }
  // ---------------------------------------------------------------------------

  if (state.kind === 'provider-list') {
    const items = filterProviders(state.providers, state.query);

    if (key.upArrow || key.downArrow) {
      actions.setProviderDialog({
        ...state,
        selectedIndex: key.upArrow
          ? state.selectedIndex <= 0
            ? Math.max(0, items.length - 1)
            : state.selectedIndex - 1
          : state.selectedIndex >= items.length - 1
            ? 0
            : state.selectedIndex + 1,
      });
      return;
    }

    if (key.backspace || key.delete) {
      actions.setProviderDialog({
        ...state,
        query: state.query.slice(0, -1),
        selectedIndex: 0,
      });
      return;
    }

    if (key.return) {
      const provider = items[state.selectedIndex] ?? items[0];

      if (!provider) {
        return;
      }

      if (provider.value === 'openai_compatible' && !provider.defaultUrl) {
        const clipboardPreview = await readClipboardText();
        actions.setProviderDialog({
          kind: 'provider-custom',
          label: '',
          baseUrl: '',
          apiKey: '',
          activeField: 'label',
          cursor: 0,
          clipboardPreview,
        });
        return;
      }

      if (provider.needsKey || provider.keyOptional) {
        const clipboardPreview = await readClipboardText();
        actions.setProviderDialog({
          kind: 'provider-method',
          provider,
          selectedIndex: 0,
          clipboardPreview,
        });
        return;
      }

      await createAndActivateProvider(provider, '', undefined, actions);
      return;
    }

    if (!key.ctrl && !key.meta && input) {
      actions.setProviderDialog({
        ...state,
        query: `${state.query}${input}`,
        selectedIndex: 0,
      });
    }
    return;
  }

  if (state.kind === 'provider-method') {
    const items = getProviderMethodOptions(state.provider);

    if (key.upArrow || key.downArrow) {
      actions.setProviderDialog({
        ...state,
        selectedIndex: key.upArrow
          ? state.selectedIndex <= 0
            ? Math.max(0, items.length - 1)
            : state.selectedIndex - 1
          : state.selectedIndex >= items.length - 1
            ? 0
            : state.selectedIndex + 1,
      });
      return;
    }

    if (!key.return) {
      return;
    }

    const selected = items[state.selectedIndex] ?? items[0];

    if (!selected) {
      return;
    }

    if (selected.id === 'oauth') {
      const provider = state.provider;
      actions.setProviderDialog({ kind: 'provider-oauth', provider, message: 'Opening browser…' });
      void (async () => {
        try {
          const creds = await loginOpenAICodex({
            onAuth: (url) => {
              openBrowserFromTui(url);
              actions.setProviderDialog({
                kind: 'provider-oauth',
                provider,
                message: 'Waiting for browser callback on localhost:1455…',
              });
            },
            onPrompt: async () => '',
            onProgress: (msg) => {
              actions.setProviderDialog({ kind: 'provider-oauth', provider, message: msg });
            },
            originator: 'umbra',
          });

          const profilesPayload = (await listProviderProfiles()) as {
            profiles: Array<{ id: string; type: string }>;
          };
          const existing = profilesPayload.profiles.find((p) => p.type === 'openai-codex');
          let profileId: string;

          if (existing) {
            profileId = existing.id;
            await updateProviderProfile(existing.id, { makeDefault: true });
          } else {
            const created = (await createProviderProfile({
              type: 'openai-codex',
              label: 'ChatGPT Plus/Pro',
              baseUrl: 'https://chatgpt.com/backend-api',
              model: 'codex-mini-latest',
              makeDefault: true,
            })) as ProviderProfilePayload;
            profileId = created.id;
          }

          saveOAuthToken(profileId, {
            access: creds.access,
            refresh: creds.refresh,
            expires: creds.expires,
            accountId: creds.accountId,
          });

          actions.setProviderDialog(null);
          actions.appendEntries([
            {
              id: createEntryId(),
              kind: 'event',
              tone: 'success',
              text: `system> ChatGPT Plus/Pro connected. Account: ${creds.accountId.slice(0, 8)}… Use /models to choose a model.`,
            },
          ]);
          await actions.refreshStatus();
        } catch (error) {
          actions.setProviderDialog(null);
          actions.appendEntries([
            {
              id: createEntryId(),
              kind: 'event',
              tone: 'danger',
              text: `system> OAuth failed: ${error instanceof Error ? error.message : String(error)}`,
            },
          ]);
        }
      })();
      return;
    }

    if (selected.id === 'skip') {
      await createAndActivateProvider(state.provider, '', undefined, actions);
      return;
    }

    if (selected.id === 'paste') {
      const clipboardValue = state.clipboardPreview ?? (await readClipboardText()) ?? '';

      if (!clipboardValue.trim()) {
        actions.setProviderDialog({
          kind: 'provider-api-key',
          provider: state.provider,
          value: '',
          cursor: 0,
          clipboardPreview: null,
        });
        return;
      }

      if (state.provider.value === 'openai_compatible' && !state.provider.defaultUrl) {
        actions.setProviderDialog({
          kind: 'provider-custom',
          label: '',
          baseUrl: '',
          apiKey: '',
          activeField: 'label',
          cursor: 0,
          clipboardPreview: clipboardValue,
        });
        return;
      }

      await createAndActivateProvider(state.provider, clipboardValue.trim(), undefined, actions);
      return;
    }

    actions.setProviderDialog({
      kind: 'provider-api-key',
      provider: state.provider,
      value: '',
      cursor: 0,
      clipboardPreview: state.clipboardPreview,
    });
    return;
  }

  if (state.kind === 'provider-oauth') {
    // OAuth flow is in progress — block all input until done
    return;
  }

  if (state.kind === 'provider-profile-list') {
    const items = filterProviderProfiles(state.profiles, state.query);

    if (key.upArrow || key.downArrow) {
      actions.setProviderDialog({
        ...state,
        selectedIndex: key.upArrow
          ? state.selectedIndex <= 0
            ? Math.max(0, items.length - 1)
            : state.selectedIndex - 1
          : state.selectedIndex >= items.length - 1
            ? 0
            : state.selectedIndex + 1,
      });
      return;
    }

    if (key.backspace || key.delete) {
      actions.setProviderDialog({
        ...state,
        query: state.query.slice(0, -1),
        selectedIndex: 0,
      });
      return;
    }

    if (key.return) {
      const profile = items[state.selectedIndex] ?? items[0];

      if (!profile) {
        return;
      }

      const updated = (await updateProviderProfile(profile.id, {
        makeDefault: true,
      })) as ProviderProfilePayload;
      actions.setProviderDialog(null);
      actions.appendEntries([
        {
          id: createEntryId(),
          kind: 'event',
          tone: 'success',
          text: `system> provider selected ${updated.label}${updated.model ? ` / ${updated.model}` : ''}`,
        },
      ]);
      writeDebugEvent({
        component: 'tui',
        level: 'info',
        message: 'provider selected',
        data: {
          profileId: updated.id,
          label: updated.label,
          model: updated.model,
        },
      });
      await actions.refreshStatus();
      return;
    }

    if (!key.ctrl && !key.meta && input) {
      actions.setProviderDialog({
        ...state,
        query: `${state.query}${input}`,
        selectedIndex: 0,
      });
    }
    return;
  }

  if (state.kind === 'provider-remove-list') {
    const items = filterProviderProfiles(state.profiles, state.query);

    if (key.upArrow || key.downArrow) {
      actions.setProviderDialog({
        ...state,
        selectedIndex: key.upArrow
          ? state.selectedIndex <= 0
            ? Math.max(0, items.length - 1)
            : state.selectedIndex - 1
          : state.selectedIndex >= items.length - 1
            ? 0
            : state.selectedIndex + 1,
      });
      return;
    }

    if (key.backspace || key.delete) {
      actions.setProviderDialog({ ...state, query: state.query.slice(0, -1), selectedIndex: 0 });
      return;
    }

    if (key.return) {
      const profile = items[state.selectedIndex] ?? items[0];
      if (!profile) return;

      try {
        await deleteProviderProfile(profile.id);
        actions.setProviderDialog(null);
        actions.appendEntries([
          {
            id: createEntryId(),
            kind: 'event',
            tone: 'success',
            text: `system> provider removed: ${profile.label}`,
          },
        ]);
        await actions.refreshStatus();
      } catch (err) {
        actions.setProviderDialog(null);
        actions.appendEntries([
          {
            id: createEntryId(),
            kind: 'event',
            tone: 'danger',
            text: `system> failed to remove provider: ${err instanceof Error ? err.message : String(err)}`,
          },
        ]);
      }
      return;
    }

    if (!key.ctrl && !key.meta && input) {
      actions.setProviderDialog({ ...state, query: `${state.query}${input}`, selectedIndex: 0 });
    }
    return;
  }

  if (state.kind === 'model-list') {
    const items = filterModels(state.models, state.query);

    if (key.upArrow || key.downArrow) {
      actions.setProviderDialog({
        ...state,
        selectedIndex: key.upArrow
          ? state.selectedIndex <= 0
            ? Math.max(0, items.length - 1)
            : state.selectedIndex - 1
          : state.selectedIndex >= items.length - 1
            ? 0
            : state.selectedIndex + 1,
      });
      return;
    }

    if (key.backspace || key.delete) {
      actions.setProviderDialog({
        ...state,
        query: state.query.slice(0, -1),
        selectedIndex: 0,
      });
      return;
    }

    if (key.return) {
      const model = items[state.selectedIndex] ?? items[0];

      if (!model) {
        return;
      }

      const updated = (await updateProviderProfile(state.profile.id, {
        model: model.id,
        makeDefault: true,
      })) as ProviderProfilePayload;

      // After model selection, if the model supports reasoning, auto-open the think level menu
      const autoThinkProfile = detectThinkProfile(model.id);
      if (autoThinkProfile !== 'none' && autoThinkProfile !== 'mistral-magistral') {
        actions.setProviderDialog({
          kind: 'think-mode',
          thinkProfile: autoThinkProfile,
          selectedIndex: 0,
          customInput: '',
          customCursor: 0,
          currentValue: null,
        });
      } else {
        actions.setProviderDialog(null);
      }

      actions.appendEntries([
        {
          id: createEntryId(),
          kind: 'event',
          tone: 'success',
          text: `system> model selected ${updated.label} / ${model.id}`,
        },
      ]);
      writeDebugEvent({
        component: 'tui',
        level: 'info',
        message: 'model selected',
        data: {
          profileId: updated.id,
          label: updated.label,
          model: model.id,
        },
      });
      await actions.refreshStatus();
      return;
    }

    if (!key.ctrl && !key.meta && input) {
      actions.setProviderDialog({
        ...state,
        query: `${state.query}${input}`,
        selectedIndex: 0,
      });
    }
    return;
  }

  if (state.kind === 'provider-custom') {
    const nextCustomState = await updateCustomProviderInput(state, input, key);

    if (nextCustomState !== state) {
      actions.setProviderDialog(nextCustomState);
      return;
    }

    if (!key.return) {
      return;
    }

    // On confirm step: create the provider
    if (state.activeField === 'confirm') {
      if (!state.label.trim() || !state.baseUrl.trim()) {
        actions.appendEntries([
          {
            id: createEntryId(),
            kind: 'event',
            tone: 'danger',
            text: 'error> custom provider requires display name and base URL',
          },
        ]);
        actions.setProviderDialog({ ...state, activeField: 'label', cursor: 0 });
        return;
      }
      await createAndActivateProvider(
        {
          value: 'openai_compatible',
          label: state.label.trim(),
          defaultUrl: '',
          needsKey: true,
          keyOptional: true,
          keyHint: '',
          cloud: true,
          aliases: ['custom'],
        },
        state.apiKey.trim(),
        state.baseUrl.trim(),
        actions,
      );
      return;
    }

    // On any input field: validate and advance to confirm step
    if (!state.label.trim() || !state.baseUrl.trim()) {
      actions.appendEntries([
        {
          id: createEntryId(),
          kind: 'event',
          tone: 'danger',
          text: 'error> display name and base URL are required',
        },
      ]);
      return;
    }
    actions.setProviderDialog({ ...state, activeField: 'confirm', cursor: 0 });
    return;
  }

  if (state.kind === 'compact-settings-provider') {
    const allItems = [
      { id: '__default__', label: 'Default (same as agent)', profileId: null as string | null },
      ...filterProviderProfiles(state.profiles, state.query).map((p) => ({
        id: p.id,
        label: p.label,
        profileId: p.id,
      })),
    ];

    if (key.upArrow || key.downArrow) {
      actions.setProviderDialog({
        ...state,
        selectedIndex: key.upArrow
          ? state.selectedIndex <= 0
            ? Math.max(0, allItems.length - 1)
            : state.selectedIndex - 1
          : state.selectedIndex >= allItems.length - 1
            ? 0
            : state.selectedIndex + 1,
      });
      return;
    }

    if (key.backspace || key.delete) {
      actions.setProviderDialog({ ...state, query: state.query.slice(0, -1), selectedIndex: 0 });
      return;
    }

    if (key.return) {
      const selected = allItems[state.selectedIndex] ?? allItems[0];
      if (!selected) return;

      if (!selected.profileId) {
        setCompactSettings(null, null);
        actions.setProviderDialog(null);
        actions.appendEntries([
          {
            id: createEntryId(),
            kind: 'event',
            tone: 'success',
            text: 'system> compact provider reset to default',
          },
        ]);
        return;
      }

      const profile = state.profiles.find((p) => p.id === selected.profileId);
      if (!profile) return;

      const modelsPayload = (await listProviderModels(profile.id)) as { models: ListedModel[] };
      actions.setProviderDialog({
        kind: 'compact-settings-model',
        query: '',
        selectedIndex: 0,
        profile,
        models: modelsPayload.models,
        currentModel: state.currentModel,
      });
      return;
    }

    if (!key.ctrl && !key.meta && input) {
      actions.setProviderDialog({ ...state, query: `${state.query}${input}`, selectedIndex: 0 });
    }
    return;
  }

  if (state.kind === 'compact-settings-model') {
    const items = filterModels(state.models, state.query);

    if (key.upArrow || key.downArrow) {
      actions.setProviderDialog({
        ...state,
        selectedIndex: key.upArrow
          ? state.selectedIndex <= 0
            ? Math.max(0, items.length - 1)
            : state.selectedIndex - 1
          : state.selectedIndex >= items.length - 1
            ? 0
            : state.selectedIndex + 1,
      });
      return;
    }

    if (key.backspace || key.delete) {
      actions.setProviderDialog({ ...state, query: state.query.slice(0, -1), selectedIndex: 0 });
      return;
    }

    if (key.return) {
      const model = items[state.selectedIndex] ?? items[0];
      if (!model) return;
      setCompactSettings(state.profile.id, model.id);
      actions.setProviderDialog(null);
      actions.appendEntries([
        {
          id: createEntryId(),
          kind: 'event',
          tone: 'success',
          text: `system> compact settings saved: ${state.profile.label} / ${model.id}`,
        },
      ]);
      return;
    }

    if (!key.ctrl && !key.meta && input) {
      actions.setProviderDialog({ ...state, query: `${state.query}${input}`, selectedIndex: 0 });
    }
    return;
  }

  if (state.kind === 'review-settings-provider') {
    const allItems = [
      { id: '__default__', label: 'Default (same as agent)', profileId: null as string | null },
      ...filterProviderProfiles(state.profiles, state.query).map((p) => ({
        id: p.id,
        label: p.label,
        profileId: p.id,
      })),
    ];

    if (key.upArrow || key.downArrow) {
      actions.setProviderDialog({
        ...state,
        selectedIndex: key.upArrow
          ? state.selectedIndex <= 0
            ? Math.max(0, allItems.length - 1)
            : state.selectedIndex - 1
          : state.selectedIndex >= allItems.length - 1
            ? 0
            : state.selectedIndex + 1,
      });
      return;
    }

    if (key.backspace || key.delete) {
      actions.setProviderDialog({ ...state, query: state.query.slice(0, -1), selectedIndex: 0 });
      return;
    }

    if (key.return) {
      const selected = allItems[state.selectedIndex] ?? allItems[0];
      if (!selected) return;

      if (!selected.profileId) {
        setReviewSettings(null, null);
        actions.setProviderDialog(null);
        actions.appendEntries([
          {
            id: createEntryId(),
            kind: 'event',
            tone: 'success',
            text: 'system> review provider reset to default',
          },
        ]);
        return;
      }

      const profile = state.profiles.find((p) => p.id === selected.profileId);
      if (!profile) return;

      const modelsPayload = (await listProviderModels(profile.id)) as { models: ListedModel[] };
      actions.setProviderDialog({
        kind: 'review-settings-model',
        query: '',
        selectedIndex: 0,
        profile,
        models: modelsPayload.models,
        currentModel: state.currentModel,
      });
      return;
    }

    if (!key.ctrl && !key.meta && input) {
      actions.setProviderDialog({ ...state, query: `${state.query}${input}`, selectedIndex: 0 });
    }
    return;
  }

  if (state.kind === 'review-settings-model') {
    const items = filterModels(state.models, state.query);

    if (key.upArrow || key.downArrow) {
      actions.setProviderDialog({
        ...state,
        selectedIndex: key.upArrow
          ? state.selectedIndex <= 0
            ? Math.max(0, items.length - 1)
            : state.selectedIndex - 1
          : state.selectedIndex >= items.length - 1
            ? 0
            : state.selectedIndex + 1,
      });
      return;
    }

    if (key.backspace || key.delete) {
      actions.setProviderDialog({ ...state, query: state.query.slice(0, -1), selectedIndex: 0 });
      return;
    }

    if (key.return) {
      const model = items[state.selectedIndex] ?? items[0];
      if (!model) return;
      setReviewSettings(state.profile.id, model.id);
      actions.setProviderDialog(null);
      actions.appendEntries([
        {
          id: createEntryId(),
          kind: 'event',
          tone: 'success',
          text: `system> review settings saved: ${state.profile.label} / ${model.id}`,
        },
      ]);
      return;
    }

    if (!key.ctrl && !key.meta && input) {
      actions.setProviderDialog({ ...state, query: `${state.query}${input}`, selectedIndex: 0 });
    }
    return;
  }

  if (state.kind === 'think-mode') {
    const opts = getThinkOptions(state.thinkProfile);
    const isCustomSelected =
      state.selectedIndex === opts.length - 1 && opts.at(-1)?.id === 'custom';

    if (key.upArrow || key.downArrow) {
      actions.setProviderDialog({
        ...state,
        selectedIndex: key.upArrow
          ? state.selectedIndex <= 0
            ? opts.length - 1
            : state.selectedIndex - 1
          : state.selectedIndex >= opts.length - 1
            ? 0
            : state.selectedIndex + 1,
      });
      return;
    }

    if (key.return) {
      const selected = opts[state.selectedIndex];
      if (!selected) return;

      // Magistral informational entry — just close
      if (selected.id === 'always-on') {
        actions.setProviderDialog(null);
        return;
      }

      if (selected.id === 'custom') {
        const n = Number.parseInt(state.customInput, 10);
        if (!Number.isFinite(n) || n <= 0) return;
        actions.setThinkBudget?.(n);
        actions.setProviderDialog(null);
        actions.appendEntries([
          {
            id: createEntryId(),
            kind: 'event',
            tone: 'success',
            text: `system> thinking enabled — budget: ${n.toLocaleString()} tokens (Anthropic)`,
          },
        ]);
        return;
      }

      if (selected.id === 'off') {
        actions.setThinkBudget?.(null);
        actions.setProviderDialog(null);
        actions.appendEntries([
          {
            id: createEntryId(),
            kind: 'event',
            tone: 'info',
            text: 'system> extended thinking disabled',
          },
        ]);
        return;
      }

      actions.setThinkBudget?.(selected.id as 'low' | 'medium' | 'high' | 'max');
      actions.setProviderDialog(null);
      const confirmNote =
        state.thinkProfile === 'openai-o'
          ? `reasoning_effort: ${selected.id}`
          : state.thinkProfile === 'mistral-adjustable'
            ? `reasoning_effort: ${selected.id}`
            : 'Anthropic budget_tokens mapped';
      actions.appendEntries([
        {
          id: createEntryId(),
          kind: 'event',
          tone: 'success',
          text: `system> thinking effort: ${selected.id}  (${confirmNote})`,
        },
      ]);
      return;
    }

    if (isCustomSelected) {
      if (key.backspace) {
        if (state.customCursor <= 0) return;
        actions.setProviderDialog({
          ...state,
          customInput: `${state.customInput.slice(0, state.customCursor - 1)}${state.customInput.slice(state.customCursor)}`,
          customCursor: state.customCursor - 1,
        });
        return;
      }
      if (key.delete) {
        if (state.customCursor >= state.customInput.length) return;
        actions.setProviderDialog({
          ...state,
          customInput: `${state.customInput.slice(0, state.customCursor)}${state.customInput.slice(state.customCursor + 1)}`,
        });
        return;
      }
      if (key.leftArrow) {
        actions.setProviderDialog({ ...state, customCursor: Math.max(0, state.customCursor - 1) });
        return;
      }
      if (key.rightArrow) {
        actions.setProviderDialog({
          ...state,
          customCursor: Math.min(state.customInput.length, state.customCursor + 1),
        });
        return;
      }
      if (!key.ctrl && !key.meta && input && /^\d$/.test(input)) {
        actions.setProviderDialog({
          ...state,
          customInput: `${state.customInput.slice(0, state.customCursor)}${input}${state.customInput.slice(state.customCursor)}`,
          customCursor: state.customCursor + 1,
        });
      }
    }
    return;
  }

  if (state.kind === 'reset-memories-confirm') {
    const confirmed = key.return || input === 'y' || input === 'Y';
    const cancelled = input === 'n' || input === 'N';
    if (cancelled) {
      actions.setProviderDialog(null);
      actions.appendEntries([
        {
          id: createEntryId(),
          kind: 'event',
          tone: 'info',
          text: 'system> memory reset cancelled.',
        },
      ]);
      return;
    }
    if (confirmed) {
      if (state.step === 1) {
        actions.setProviderDialog({ ...state, step: 2 });
        return;
      }
      // step 2 — execute
      actions.setProviderDialog(null);
      void (async () => {
        try {
          const result = (await resetMemories({
            projectPath: state.projectPath,
            ...(state.threadId ? { threadId: state.threadId } : {}),
          })) as { clearedVectors: number; clearedProjectMemory: boolean };
          actions.appendEntries([
            {
              id: createEntryId(),
              kind: 'event',
              tone: 'success',
              text: `system> local memory wiped — ${result.clearedVectors} vectors removed, MEMORY.md cleared.`,
            },
          ]);
        } catch (cause) {
          actions.appendEntries([
            {
              id: createEntryId(),
              kind: 'event',
              tone: 'danger',
              text: `system> memory reset failed: ${cause instanceof Error ? cause.message : String(cause)}`,
            },
          ]);
        }
      })();
      return;
    }
    return;
  }

  if (state.kind !== 'provider-api-key' && state.kind !== 'provider-base-url') {
    return;
  }

  const nextTextState = updateProviderTextInput(state, input, key);

  if (nextTextState !== state) {
    actions.setProviderDialog(nextTextState);
    return;
  }

  if (!key.return) {
    return;
  }

  if (state.kind === 'provider-api-key') {
    if (state.provider.value === 'openai_compatible' && !state.provider.defaultUrl) {
      actions.setProviderDialog({
        kind: 'provider-base-url',
        provider: state.provider,
        apiKey: state.value,
        value: '',
        cursor: 0,
        clipboardPreview: state.clipboardPreview,
      });
      return;
    }

    await createAndActivateProvider(state.provider, state.value, undefined, actions);
    return;
  }

  await createAndActivateProvider(state.provider, state.apiKey, state.value, actions);
}

function applyTextInput<T extends { value: string; cursor: number }>(
  state: T,
  input: string,
  key: Parameters<Parameters<typeof useInput>[0]>[1],
): T {
  if (key.leftArrow) return { ...state, cursor: Math.max(0, state.cursor - 1) };
  if (key.rightArrow) return { ...state, cursor: Math.min(state.value.length, state.cursor + 1) };
  if (key.backspace) {
    if (state.cursor <= 0) return state;
    return {
      ...state,
      value: `${state.value.slice(0, state.cursor - 1)}${state.value.slice(state.cursor)}`,
      cursor: Math.max(0, state.cursor - 1),
    };
  }
  if (key.delete) {
    if (state.cursor >= state.value.length) return state;
    return {
      ...state,
      value: `${state.value.slice(0, state.cursor)}${state.value.slice(state.cursor + 1)}`,
    };
  }
  if (!key.ctrl && !key.meta && input) {
    return {
      ...state,
      value: `${state.value.slice(0, state.cursor)}${input}${state.value.slice(state.cursor)}`,
      cursor: state.cursor + input.length,
    };
  }
  return state;
}

function updateProviderTextInput(
  state: Extract<ProviderDialogState, { kind: 'provider-api-key' | 'provider-base-url' }>,
  input: string,
  key: Parameters<Parameters<typeof useInput>[0]>[1],
): Extract<ProviderDialogState, { kind: 'provider-api-key' | 'provider-base-url' }> {
  if ((key.ctrl && input.toLowerCase() === 'y') || key.tab) {
    const clipboardValue = state.clipboardPreview ?? '';

    if (!clipboardValue) {
      return state;
    }

    return {
      ...state,
      value: clipboardValue,
      cursor: clipboardValue.length,
    };
  }

  if (key.leftArrow) {
    return { ...state, cursor: Math.max(0, state.cursor - 1) };
  }

  if (key.rightArrow) {
    return { ...state, cursor: Math.min(state.value.length, state.cursor + 1) };
  }

  if (key.backspace) {
    if (state.cursor <= 0) {
      return state;
    }

    return {
      ...state,
      value: `${state.value.slice(0, state.cursor - 1)}${state.value.slice(state.cursor)}`,
      cursor: Math.max(0, state.cursor - 1),
    };
  }

  if (key.delete) {
    if (state.cursor >= state.value.length) {
      return state;
    }

    return {
      ...state,
      value: `${state.value.slice(0, state.cursor)}${state.value.slice(state.cursor + 1)}`,
    };
  }

  if (!key.ctrl && !key.meta && input) {
    return {
      ...state,
      value: `${state.value.slice(0, state.cursor)}${input}${state.value.slice(state.cursor)}`,
      cursor: state.cursor + input.length,
    };
  }

  return state;
}

async function updateCustomProviderInput(
  state: Extract<ProviderDialogState, { kind: 'provider-custom' }>,
  input: string,
  key: Parameters<Parameters<typeof useInput>[0]>[1],
): Promise<ProviderDialogState> {
  // In confirm step, only Tab goes back to editing; all other input is ignored here
  if (state.activeField === 'confirm') {
    if (key.tab) {
      return { ...state, activeField: 'label', cursor: state.label.length };
    }
    return state;
  }

  if ((key.ctrl && input.toLowerCase() === 'y') || key.tab) {
    if (key.tab) {
      return {
        ...state,
        activeField: nextCustomField(state.activeField),
        cursor: getCustomFieldValue(state, nextCustomField(state.activeField)).length,
      };
    }

    const clipboardValue = state.clipboardPreview ?? (await readClipboardText()) ?? '';

    if (!clipboardValue) {
      return state;
    }

    if (state.activeField === 'baseUrl') {
      const nextValue = inferBaseUrlFromClipboard(clipboardValue) ?? clipboardValue.trim();
      return {
        ...state,
        baseUrl: nextValue,
        cursor: nextValue.length,
        clipboardPreview: clipboardValue,
      };
    }

    if (state.activeField === 'apiKey') {
      const nextValue = inferApiKeyFromClipboard(clipboardValue) ?? clipboardValue.trim();
      return {
        ...state,
        apiKey: nextValue,
        cursor: nextValue.length,
        clipboardPreview: clipboardValue,
      };
    }

    const nextValue = clipboardValue.trim();
    return {
      ...state,
      label: nextValue,
      cursor: nextValue.length,
      clipboardPreview: clipboardValue,
    };
  }

  if (key.leftArrow) {
    return { ...state, cursor: Math.max(0, state.cursor - 1) };
  }

  if (key.rightArrow) {
    return {
      ...state,
      cursor: Math.min(getCustomFieldValue(state, state.activeField).length, state.cursor + 1),
    };
  }

  if (key.backspace) {
    if (state.cursor <= 0) {
      return state;
    }

    const value = getCustomFieldValue(state, state.activeField);
    const nextValue = `${value.slice(0, state.cursor - 1)}${value.slice(state.cursor)}`;
    return setCustomFieldValue(state, state.activeField, nextValue, Math.max(0, state.cursor - 1));
  }

  if (key.delete) {
    const value = getCustomFieldValue(state, state.activeField);

    if (state.cursor >= value.length) {
      return state;
    }

    const nextValue = `${value.slice(0, state.cursor)}${value.slice(state.cursor + 1)}`;
    return setCustomFieldValue(state, state.activeField, nextValue, state.cursor);
  }

  if (!key.ctrl && !key.meta && input) {
    const value = getCustomFieldValue(state, state.activeField);
    const nextValue = `${value.slice(0, state.cursor)}${input}${value.slice(state.cursor)}`;
    return setCustomFieldValue(state, state.activeField, nextValue, state.cursor + input.length);
  }

  return state;
}

async function createAndActivateProvider(
  provider: ProviderTypePayload,
  apiKey: string,
  baseUrl: string | undefined,
  actions: {
    setProviderDialog: (state: ProviderDialogState | null) => void;
    appendEntries: (entries: SessionEntry[]) => void;
    refreshStatus: () => Promise<void>;
  },
): Promise<void> {
  const created = (await createProviderProfile({
    type: provider.value,
    label: provider.label,
    ...(baseUrl ? { baseUrl } : {}),
    ...(apiKey ? { apiKey } : {}),
    makeDefault: true,
  })) as ProviderProfilePayload;
  actions.setProviderDialog(null);
  actions.appendEntries([
    {
      id: createEntryId(),
      kind: 'event',
      tone: created.status === 'connected' ? 'success' : 'info',
      text: `system> provider connected ${created.label}. Use /models to choose a model.`,
    },
  ]);
  await actions.refreshStatus();
}

function filterProviders(providers: ProviderTypePayload[], query: string): ProviderTypePayload[] {
  const normalized = query.trim().toLowerCase();

  if (!normalized) {
    return providers;
  }

  return providers.filter(
    (provider) =>
      provider.value.includes(normalized) ||
      provider.label.toLowerCase().includes(normalized) ||
      provider.aliases.some((alias) => alias.includes(normalized)),
  );
}

function formatThreadDate(iso: string): string {
  try {
    const d = new Date(iso);
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const sameDay =
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate();
    if (sameDay) return `today ${time}`;
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    const isYesterday =
      d.getFullYear() === yesterday.getFullYear() &&
      d.getMonth() === yesterday.getMonth() &&
      d.getDate() === yesterday.getDate();
    if (isYesterday) return `yesterday ${time}`;
    return `${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${time}`;
  } catch {
    return '';
  }
}

function filterThreads(threads: ThreadPayload[], query: string): ThreadPayload[] {
  const normalized = query.trim().toLowerCase();

  if (!normalized) {
    return threads;
  }

  return threads.filter((thread) =>
    [thread.id, thread.title, thread.summaryPreview ?? '', thread.model ?? '']
      .join('\n')
      .toLowerCase()
      .includes(normalized),
  );
}

const WEB_PROVIDER_LABELS: Record<string, string> = {
  ddg: 'DDG',
  jina: 'Jina',
  searxng: 'SearXNG',
  brave: 'Brave',
  tavily: 'Tavily',
};

const PROVIDER_MENU_ITEMS = [
  { id: 'connect', label: 'Connect new provider', hint: 'Add via OAuth or API key' },
  { id: 'use', label: 'Switch active provider', hint: 'Choose from configured profiles' },
  { id: 'models', label: 'Models', hint: 'List models for active provider' },
  { id: 'list', label: 'List providers', hint: 'Show all configured profiles' },
  { id: 'remove', label: 'Remove provider', hint: 'Delete a connected profile' },
] as const;

const THREAD_MENU_ITEMS = [
  { id: 'list', label: 'List project threads', hint: 'Show recent threads in this project' },
  { id: 'resume', label: 'Resume thread', hint: 'Pick a thread to continue' },
  { id: 'fork', label: 'Fork thread', hint: 'Create a copy of a previous thread' },
  { id: 'archive', label: 'Archive current thread', hint: 'Hide current session from list' },
  { id: 'export', label: 'Export current thread', hint: 'Save session log as JSONL' },
  { id: 'detect', label: 'Detect & Import', hint: 'Import external session logs' },
] as const;

function getProviderMethodOptions(provider: ProviderTypePayload) {
  if (provider.value === 'openai-codex') {
    return [
      {
        id: 'oauth',
        label: 'Sign in with ChatGPT (OAuth)',
        summary: 'Opens browser — uses your Plus/Pro subscription. No API key needed.',
      },
    ];
  }

  const skipMethod = {
    id: 'skip',
    label: 'Continue without key',
    summary: provider.keyHint || 'Use the provider without storing an API key.',
  };

  // When no key is required at all — put "Continue without key" first
  if (!provider.needsKey) {
    return [
      skipMethod,
      {
        id: 'paste',
        label: 'Paste from clipboard',
        summary: 'Grab API key directly from the system clipboard.',
      },
      {
        id: 'manual',
        label: 'Enter manually',
        summary: 'Type the credential yourself in the next step.',
      },
    ];
  }

  const methods = [
    {
      id: 'paste',
      label: 'Paste from clipboard',
      summary: 'Grab API key directly from the system clipboard.',
    },
    {
      id: 'manual',
      label: 'Enter manually',
      summary: 'Type the credential yourself in the next step.',
    },
  ];

  if (provider.keyOptional) {
    methods.push(skipMethod);
  }

  return methods;
}

function getProviderNote(provider: ProviderTypePayload): string {
  if (provider.value === 'openai') {
    return 'GPT models for fast, capable general AI tasks.';
  }

  if (provider.value === 'anthropic') {
    return 'Direct access to Claude models, including strong coding models.';
  }

  if (provider.value === 'openrouter') {
    return 'One provider entry for many upstream model families.';
  }

  if (provider.value === 'mistral') {
    return 'Direct access to Mistral-hosted chat models.';
  }

  if (provider.value === 'openai_compatible') {
    return 'Configure a custom OpenAI-compatible endpoint manually.';
  }

  return provider.keyHint || 'Choose how to connect this provider.';
}

function inferApiKeyFromClipboard(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();

  if (!trimmed || /^https?:\/\//i.test(trimmed)) {
    return null;
  }

  return trimmed;
}

function inferBaseUrlFromClipboard(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : null;
}

function openBrowserFromTui(url: string): void {
  if (process.platform === 'win32') {
    spawn(`start "" "${url}"`, [], { detached: true, shell: true, stdio: 'ignore' }).unref();
  } else if (process.platform === 'darwin') {
    spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  }
}

function truncatePreview(value: string, maxLength = 80): string {
  const normalized = value.replace(/\s+/g, ' ').trim();

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3)}...`;
}

function maskSecretPreview(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= 8) return '****';
  return `${normalized.slice(0, 4)}${'*'.repeat(Math.min(10, normalized.length - 8))}${normalized.slice(-4)}`;
}

function buildMemoryDialogRows(
  state: Extract<ProviderDialogState, { kind: 'memory-settings' }>,
): Array<{ id: string; label: string; value: string }> {
  const rows: Array<{ id: string; label: string; value: string }> = [];

  if (state.thread) {
    rows.push({
      id: 'thread-use',
      label: 'Thread retrieval',
      value: state.thread.useMemories ? 'enabled' : 'disabled',
    });
    rows.push({
      id: 'thread-generate',
      label: 'Thread writes',
      value: state.thread.generateMemories ? 'enabled' : 'disabled',
    });
  }

  rows.push({
    id: 'runtime-use',
    label: 'Runtime default retrieval',
    value: state.runtimeSettings.useMemories ? 'enabled' : 'disabled',
  });
  rows.push({
    id: 'runtime-generate',
    label: 'Runtime default writes',
    value: state.runtimeSettings.generateMemories ? 'enabled' : 'disabled',
  });
  rows.push({
    id: 'runtime-draft',
    label: 'Draft persistence',
    value: state.runtimeSettings.draftPersistence ? 'enabled' : 'disabled',
  });

  if (state.thread) {
    rows.push({
      id: 'reset-thread',
      label: 'Reset current thread memories',
      value: 'clear retrieved vectors and summary state',
    });
  }

  rows.push({
    id: 'reset-project',
    label: 'Reset project memories',
    value: 'clear project memory and project-scoped vectors',
  });

  return rows;
}

function nextCustomField(
  field: Extract<ProviderDialogState, { kind: 'provider-custom' }>['activeField'],
): Extract<ProviderDialogState, { kind: 'provider-custom' }>['activeField'] {
  if (field === 'label') return 'baseUrl';
  if (field === 'baseUrl') return 'apiKey';
  if (field === 'apiKey') return 'confirm';
  return 'label';
}

function getCustomFieldValue(
  state: Extract<ProviderDialogState, { kind: 'provider-custom' }>,
  field: Extract<ProviderDialogState, { kind: 'provider-custom' }>['activeField'],
): string {
  if (field === 'label') return state.label;
  if (field === 'baseUrl') return state.baseUrl;
  if (field === 'apiKey') return state.apiKey;
  return '';
}

function setCustomFieldValue(
  state: Extract<ProviderDialogState, { kind: 'provider-custom' }>,
  field: Extract<ProviderDialogState, { kind: 'provider-custom' }>['activeField'],
  value: string,
  cursor: number,
): ProviderDialogState {
  if (field === 'label') return { ...state, label: value, cursor };
  if (field === 'baseUrl') return { ...state, baseUrl: value, cursor };
  if (field === 'apiKey') return { ...state, apiKey: value, cursor };
  return state;
}

function filterProviderProfiles(profiles: ProviderProfilePayload[], query: string) {
  const normalized = query.trim().toLowerCase();

  if (!normalized) {
    return profiles;
  }

  return profiles.filter(
    (profile) =>
      profile.label.toLowerCase().includes(normalized) ||
      profile.type.toLowerCase().includes(normalized) ||
      profile.id.toLowerCase().includes(normalized) ||
      (profile.model ?? '').toLowerCase().includes(normalized),
  );
}

function filterModels(models: ListedModel[], query: string) {
  const normalized = query.trim().toLowerCase();

  if (!normalized) {
    return models;
  }

  return models.filter(
    (model) =>
      model.id.toLowerCase().includes(normalized) || model.name.toLowerCase().includes(normalized),
  );
}

function maskSecret(value: string): string {
  return value.length === 0 ? '' : '*'.repeat(value.length);
}

function CitationEntryView({ entry }: { entry: Extract<SessionEntry, { kind: 'citations' }> }) {
  return (
    <Box
      flexDirection="column"
      marginBottom={1}
      paddingX={1}
      borderStyle="round"
      borderColor={umbraTheme.frameDim}
    >
      <Box marginBottom={1}>
        <Text color={umbraTheme.accentSoft} bold>
          {'memories'}
        </Text>
      </Box>
      {entry.entries.map((source, i) => (
        <Box key={`${source.memoryId}-${i}`} marginBottom={0}>
          <Text color={umbraTheme.frameDim}>{'  * '}</Text>
          <Text color={umbraTheme.muted}>{`[${source.sourceType}] `}</Text>
          <Text color={umbraTheme.text} dimColor>
            {source.excerpt.replace(/\s+/g, ' ')}
          </Text>
          {source.score !== null && (
            <Text color={umbraTheme.muted}>{` ${(source.score * 100).toFixed(0)}%`}</Text>
          )}
        </Box>
      ))}
    </Box>
  );
}

// UMBRA in filled-block style — taken from the user's terminal output
const UMBRA_BLOCK = [
  '██╗░░░██╗███╗░░░███╗██████╗░██████╗░░█████╗░',
  '██║░░░██║████╗░████║██╔══██╗██╔══██╗██╔══██╗',
  '██║░░░██║██╔████╔██║██████╦╝██████╔╝███████║',
  '██║░░░██║██║╚██╔╝██║██╔══██╗██╔══██╗██╔══██║',
  '╚██████╔╝██║░╚═╝░██║██████╦╝██║░░██║██║░░██║',
  '░╚═════╝░╚═╝░░░░░╚═╝╚═════╝░╚═╝░░╚═╝╚═╝░░╚═╝',
];

function UmbraBannerView({ flags }: { flags?: string[] }) {
  return (
    <Box marginBottom={1} flexDirection="column">
      <Text>{''}</Text>
      {UMBRA_BLOCK.map((line) => (
        <Text key={line} color={umbraTheme.accent} bold>
          {line}
        </Text>
      ))}
      <Text>{''}</Text>
      {flags && flags.length > 0 ? (
        <Box flexDirection="column" marginBottom={1}>
          {flags.map((flag) => (
            <Text key={flag} color={umbraTheme.warning} bold>
              {`  ${flag}`}
            </Text>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return remM > 0 ? `${h}h ${remM}m` : `${h}h`;
}

function SessionEntryView({ entry }: { entry: SessionEntry }) {
  if (entry.kind === 'banner') {
    return entry.flags ? <UmbraBannerView flags={entry.flags} /> : <UmbraBannerView />;
  }

  if (entry.kind === 'mode-badge') {
    const label =
      entry.mode === 'exec' ? '[ EXEC MODE — autonomous, no confirmations ]' : '[ DEBUG MODE ]';
    return (
      <Box marginBottom={1}>
        <Text color={umbraTheme.warning} bold>
          {label}
        </Text>
      </Box>
    );
  }

  if (entry.kind === 'citations') {
    return <CitationEntryView entry={entry} />;
  }

  if (entry.kind === 'markdown') {
    return (
      <InkChatBubble bubbleRole="assistant" title={entry.title}>
        <InkMarkdown markdown={entry.markdown} />
      </InkChatBubble>
    );
  }

  if (entry.kind === 'card') {
    return (
      <InkChatBubble bubbleRole="assistant" title={entry.title}>
        <InkKeyValueCard title={entry.title} entries={entry.entries} />
      </InkChatBubble>
    );
  }

  if (entry.kind === 'thinking') {
    return (
      <Box
        marginBottom={2}
        flexDirection="column"
        paddingLeft={2}
        borderLeft
        borderStyle="single"
        borderColor={umbraTheme.frameDim}
      >
        <Text color={umbraTheme.muted} italic>
          {'reasoning:'}
        </Text>
        <Text color={umbraTheme.thinking}>{entry.text}</Text>
      </Box>
    );
  }

  if (entry.kind === 'skill-invoke') {
    const isRunning = entry.status === 'running';
    const isFailed = entry.status === 'failed';
    const glyph = isRunning ? '◆' : isFailed ? '✗' : '✓';
    const barColor = isFailed ? umbraTheme.danger : umbraTheme.skillHighlight;
    const glyphColor = isFailed
      ? umbraTheme.danger
      : isRunning
        ? umbraTheme.skillHighlight
        : umbraTheme.muted;
    const argsText = entry.args
      ? ` ${entry.args.slice(0, 60)}${entry.args.length > 60 ? '…' : ''}`
      : '';
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Box flexDirection="row">
          <Text color={barColor}>{'╭ '}</Text>
          <Text color={glyphColor} bold>
            {glyph}{' '}
          </Text>
          <Text color={umbraTheme.skillHighlight} bold>{`skill: /${entry.skillName}`}</Text>
          {argsText ? <Text color={umbraTheme.muted}>{argsText}</Text> : null}
        </Box>
        <Box flexDirection="row">
          <Text color={barColor}>{'╰ '}</Text>
          <Text color={umbraTheme.muted} dimColor>
            {isRunning ? 'running…' : isFailed ? 'error' : 'done'}
          </Text>
        </Box>
      </Box>
    );
  }

  if (entry.kind === 'tool-call') {
    const isRunning = entry.status === 'running';
    const isFailed = entry.status === 'failed';
    const glyph = isRunning ? '●' : isFailed ? '✗' : '✓';
    const barColor = isFailed
      ? umbraTheme.danger
      : isRunning
        ? umbraTheme.accentSoft
        : umbraTheme.frameDim;
    const glyphColor = isFailed
      ? umbraTheme.danger
      : isRunning
        ? umbraTheme.accent
        : umbraTheme.muted;
    const hasTarget = Boolean(entry.target);
    const hasResult =
      entry.result &&
      entry.result !== 'completed' &&
      entry.result !== 'updated' &&
      entry.result !== entry.target;
    const isFirst = entry.seqFirst !== false;
    const isLast = entry.seqLast !== false;
    const nameChar = isFirst ? '╭' : '│';
    const detailChar = isLast ? '╰' : '│';
    return (
      <Box flexDirection="column" marginBottom={isLast ? 1 : 0}>
        <Box flexDirection="row">
          <Text color={barColor}>{`${nameChar} `}</Text>
          <Text color={glyphColor}>{glyph} </Text>
          <Text color={umbraTheme.accentSoft} bold>
            {entry.action || entry.toolName}
          </Text>
          <Text color={umbraTheme.muted}>{` (${entry.toolName})`}</Text>
        </Box>
        {hasTarget ? (
          <Box flexDirection="row">
            <Text color={barColor}>{`${detailChar} `}</Text>
            <Text color={umbraTheme.muted} dimColor>
              {entry.target}
            </Text>
          </Box>
        ) : null}
        {hasResult ? (
          <Box flexDirection="row">
            <Text color={barColor}>{hasTarget ? '  ' : `${detailChar} `}</Text>
            <Text color={isFailed ? umbraTheme.danger : umbraTheme.muted} dimColor={!isFailed}>
              {entry.result}
            </Text>
          </Box>
        ) : !hasTarget && !isFirst && isLast ? (
          <Box flexDirection="row">
            <Text color={barColor}>{'╰'}</Text>
          </Box>
        ) : null}
      </Box>
    );
  }

  if (entry.kind === 'bubble') {
    return (
      <InkChatBubble
        bubbleRole={entry.bubbleRole}
        title={entry.title ?? null}
        reasoning={entry.reasoning ?? null}
      >
        {entry.bubbleRole === 'assistant' ? (
          <Box flexDirection="column">
            <InkMarkdown markdown={entry.text} />
            {entry.durationMs !== undefined || entry.usage ? (
              <Box marginTop={0} flexDirection="row" flexWrap="wrap">
                {entry.durationMs !== undefined ? (
                  <Text color={umbraTheme.muted} dimColor>
                    {'  '}
                    {formatElapsed(entry.durationMs)}
                  </Text>
                ) : null}
                {entry.usage && entry.usage.mode !== 'off' ? (
                  <BubbleUsageLine usage={entry.usage} />
                ) : null}
              </Box>
            ) : null}
          </Box>
        ) : (
          <Text
            color={
              entry.tone === 'danger'
                ? umbraTheme.danger
                : entry.tone === 'muted'
                  ? umbraTheme.frameDim
                  : umbraTheme.text
            }
          >
            {entry.text}
          </Text>
        )}
      </InkChatBubble>
    );
  }

  if (entry.text.startsWith('tool>')) {
    const inner = stripEventPrefix(entry.text);
    const isRunning = inner.startsWith('⟳');
    const isFailed = entry.tone === 'danger';
    const color = isFailed ? umbraTheme.danger : isRunning ? umbraTheme.frame : umbraTheme.muted;
    return (
      <Box paddingLeft={3} marginBottom={0}>
        <Text color={color} dimColor={!isRunning && !isFailed}>
          {inner}
        </Text>
      </Box>
    );
  }

  // Input token count line injected after "You:" and before assistant response.
  // This is a NEW Static entry (not an update to the user entry) so it renders correctly.
  if (entry.text === 'user-ctx>' && entry.inputUsage && entry.inputUsage.mode !== 'off') {
    return (
      <Box paddingLeft={4}>
        <Text color={umbraTheme.muted}>
          {entry.inputUsage.mode === 'verbose'
            ? `↑ ctx ${entry.inputUsage.inputTokens.toLocaleString()}`
            : `↑ ${entry.inputUsage.inputTokens.toLocaleString()}`}
        </Text>
      </Box>
    );
  }

  if (entry.text.startsWith('user>')) {
    return (
      <InkChatBubble bubbleRole="user" title={null}>
        <Text color={eventColor(entry.tone)}>{stripEventPrefix(entry.text)}</Text>
      </InkChatBubble>
    );
  }

  if (entry.text.startsWith('assistant>')) {
    return (
      <InkChatBubble bubbleRole="assistant" title={null}>
        <Text color={eventColor(entry.tone)}>{stripEventPrefix(entry.text)}</Text>
      </InkChatBubble>
    );
  }

  const logGlyph = entry.tone === 'danger' ? 'x' : entry.tone === 'success' ? '+' : '-';
  return (
    <Box paddingLeft={2} marginBottom={0}>
      <Text color={eventColor(entry.tone)} dimColor={entry.tone === 'info'}>
        {`${logGlyph} ${stripEventPrefix(entry.text)}`}
      </Text>
    </Box>
  );
}

const MemoSessionEntryView = React.memo(SessionEntryView);

async function handlePrompt(
  prompt: string,
  options: {
    runtimeMode: 'agent' | 'plan' | 'full' | 'exec';
    currentThread: ThreadPayload | null;
    currentSessionId: string | null;
    projectPath: string;
    projectReferences: ProjectReferenceItem[];
    fileReferences: string[];
    memorySettings: MemorySettingsPayload | null;
    goalContext?: string | null;
    thinkBudget?: number | 'low' | 'medium' | 'high' | 'max' | null;
    gitEnabled?: boolean;
    onGitToggle?: (enabled: boolean) => void;
    onSkillFound?: (skillName: string, args: string) => void;
    /** Internal: set to true when calling handlePrompt with already-expanded skill content to prevent re-detection */
    _skipSkillDetection?: boolean;
  },
): Promise<
  | {
      kind: 'entries';
      entries: SessionEntry[];
      sessionId?: string | null;
      thread?: ThreadPayload | null;
      replaceEntries?: boolean;
    }
  | {
      kind: 'run';
      run: RunTaskPayload;
    }
> {
  if (prompt === '/help') {
    const allCmds = getAllSlashCommands();
    return {
      kind: 'entries',
      entries: [
        {
          id: createEntryId(),
          kind: 'markdown',
          title: 'Help',
          markdown: allCmds
            .map(
              (command) =>
                `- \`${command.name}${command.argumentHint ? ` ${command.argumentHint}` : ''}\` ${command.summary}${command.isSkill ? ' *(skill)*' : ''}`,
            )
            .join('\n'),
        },
      ],
    };
  }

  if (prompt === '/init') {
    const result = await scaffoldProjectInstructions(options.projectPath, { force: false });
    return {
      kind: 'entries',
      entries: [
        {
          id: createEntryId(),
          kind: 'markdown',
          title: 'Init',
          markdown: `# Init\n${result.summary}`,
        },
      ],
    };
  }

  if (prompt === '/status') {
    const status = (await getStatus()) as Record<string, unknown>;
    return {
      kind: 'entries',
      entries: [
        {
          id: createEntryId(),
          kind: 'card',
          title: 'Umbra Session Status',
          entries: [
            ['Daemon', status.ok === true ? 'online' : 'offline'],
            ['Host', String(status.host ?? 'unknown')],
            ['Port', String(status.port ?? 'unknown')],
            ['Queue depth', String(status.queueDepth ?? '0')],
            [
              'Web search',
              typeof status.webSearch === 'object' && status.webSearch !== null
                ? `${String((status.webSearch as { mode?: unknown }).mode ?? 'off')} / ${String((status.webSearch as { providerId?: unknown }).providerId ?? 'none')}`
                : 'off',
            ],
            ['Thread', String(options.currentThread?.id ?? 'none')],
            ['Session', String(options.currentSessionId ?? 'none')],
            [
              'Memories',
              options.memorySettings
                ? `${options.memorySettings.useMemories ? 'read' : 'skip'} / ${options.memorySettings.generateMemories ? 'write' : 'no-write'}`
                : 'unknown',
            ],
          ],
        },
      ],
    };
  }

  if (
    prompt === '/git' ||
    prompt === '/git on' ||
    prompt === '/git off' ||
    prompt === '/git status'
  ) {
    if (prompt === '/git on') {
      options.onGitToggle?.(true);
      return {
        kind: 'entries',
        entries: [
          {
            id: createEntryId(),
            kind: 'event',
            tone: 'success' as const,
            text: 'system> git tools enabled for this session (git.status, git.diff, git.apply, git.commit, git.push, git.pull)',
          },
        ],
      };
    }
    if (prompt === '/git off') {
      options.onGitToggle?.(false);
      return {
        kind: 'entries',
        entries: [
          {
            id: createEntryId(),
            kind: 'event',
            tone: 'info' as const,
            text: 'system> git tools disabled for this session',
          },
        ],
      };
    }
    const isOn = options.gitEnabled ?? false;
    return {
      kind: 'entries',
      entries: [
        {
          id: createEntryId(),
          kind: 'card',
          title: 'Git Tools',
          entries: [
            ['Status', isOn ? 'enabled' : 'disabled'],
            ['Tools', 'git.status, git.diff, git.apply, git.commit, git.push, git.pull'],
            ['Commands', '/git on · /git off · /git status'],
          ],
        },
      ],
    };
  }

  if (
    prompt.startsWith('/resume ') ||
    prompt.startsWith('/thread resume ') ||
    prompt.startsWith('/sessions resume ')
  ) {
    const threadId = prompt
      .replace(/^\/resume\s+/, '')
      .replace(/^\/thread\s+resume\s+/, '')
      .replace(/^\/sessions\s+resume\s+/, '')
      .trim();

    if (!threadId) {
      return {
        kind: 'entries',
        entries: [
          {
            id: createEntryId(),
            kind: 'event',
            tone: 'danger',
            text: 'system> usage: /resume <threadId>',
          },
        ],
      };
    }

    const thread = (await resumeThread(threadId, options.projectPath)) as ThreadPayload;

    return {
      kind: 'entries',
      sessionId: thread.sessionId,
      thread,
      replaceEntries: true,
      entries: await buildThreadRestoreEntries(thread, 'resume'),
    };
  }

  if (
    prompt === '/threads' ||
    prompt.startsWith('/threads ') ||
    prompt === '/sessions' ||
    prompt.startsWith('/sessions ')
  ) {
    const commandBase = prompt.startsWith('/sessions') ? '/sessions' : '/threads';
    const searchTerm =
      prompt === commandBase
        ? ''
        : prompt
            .slice(commandBase.length)
            .trim()
            .replace(/^detect\b/, '')
            .replace(/^resume\b/, '')
            .trim();

    if (prompt.startsWith('/threads detect') || prompt.startsWith('/sessions detect')) {
      const rawPath = prompt.slice(`${commandBase} detect`.length).trim();
      const payload = (await detectImportableThreads(rawPath ? { paths: [rawPath] } : {})) as {
        candidates: Array<{ filePath: string; fileName: string }>;
      };

      return {
        kind: 'entries',
        entries: payload.candidates.length
          ? payload.candidates.map((candidate) => ({
              id: createEntryId(),
              kind: 'card' as const,
              title: candidate.fileName,
              entries: [['Path', candidate.filePath]],
            }))
          : [
              {
                id: createEntryId(),
                kind: 'event' as const,
                tone: 'info',
                text: 'system> no importable session logs detected',
              },
            ],
      };
    }

    if (prompt.startsWith('/threads import ') || prompt.startsWith('/sessions import ')) {
      const filePath = prompt.slice(`${commandBase} import `.length).trim();

      if (!filePath) {
        return {
          kind: 'entries',
          entries: [
            {
              id: createEntryId(),
              kind: 'event',
              tone: 'danger',
              text: 'system> usage: /sessions import <filePath>',
            },
          ],
        };
      }

      const thread = (await importThread({
        filePath,
        projectPath: options.projectPath,
      })) as ThreadPayload;

      return {
        kind: 'entries',
        sessionId: thread.sessionId,
        thread,
        entries: [
          {
            id: createEntryId(),
            kind: 'card',
            title: 'Thread Imported',
            entries: [
              ['Title', thread.title],
              ['Thread', thread.id],
              ['Session', thread.sessionId],
            ],
          },
        ],
      };
    }

    const payload = (await listThreads({
      projectPath: options.projectPath,
      archived: false,
      ...(searchTerm ? { searchTerm } : {}),
      limit: 20,
    })) as { threads: ThreadPayload[]; nextCursor: string | null };

    return {
      kind: 'entries',
      entries: payload.threads.length
        ? payload.threads.map((thread) => ({
            id: createEntryId(),
            kind: 'card' as const,
            title: thread.title,
            entries: [
              ['Thread', thread.id],
              ['Session', thread.sessionId],
              ['Model', thread.model ?? 'none'],
              ['Events', String(thread.eventCount)],
              ['Updated', thread.updatedAt],
            ],
          }))
        : [
            {
              id: createEntryId(),
              kind: 'event' as const,
              tone: 'info',
              text: 'system> no sessions found for this project',
            },
          ],
    };
  }

  if (prompt.startsWith('/thread resume ')) {
    const threadId = prompt.slice('/thread resume '.length).trim();

    if (!threadId) {
      return {
        kind: 'entries',
        entries: [
          {
            id: createEntryId(),
            kind: 'event',
            tone: 'danger',
            text: 'system> usage: /thread resume <threadId>',
          },
        ],
      };
    }

    const thread = (await resumeThread(threadId, options.projectPath)) as ThreadPayload;

    return {
      kind: 'entries',
      sessionId: thread.sessionId,
      thread,
      entries: [
        {
          id: createEntryId(),
          kind: 'event',
          tone: 'success',
          text: `system> resumed thread ${thread.title}`,
        },
      ],
    };
  }

  if (prompt.startsWith('/thread fork ')) {
    const threadId = prompt.slice('/thread fork '.length).trim();

    if (!threadId) {
      return {
        kind: 'entries',
        entries: [
          {
            id: createEntryId(),
            kind: 'event',
            tone: 'danger',
            text: 'system> usage: /thread fork <threadId>',
          },
        ],
      };
    }

    const thread = (await forkThread(threadId, {
      projectPath: options.projectPath,
    })) as ThreadPayload;

    return {
      kind: 'entries',
      sessionId: thread.sessionId,
      thread,
      entries: [
        {
          id: createEntryId(),
          kind: 'event',
          tone: 'success',
          text: `system> forked thread ${thread.title}`,
        },
      ],
    };
  }

  if (prompt.startsWith('/thread archive') || prompt.startsWith('/thread unarchive')) {
    const shouldArchive = prompt.startsWith('/thread archive');
    const threadId =
      prompt.slice(shouldArchive ? '/thread archive'.length : '/thread unarchive'.length).trim() ||
      options.currentThread?.id;

    if (!threadId) {
      return {
        kind: 'entries',
        entries: [
          {
            id: createEntryId(),
            kind: 'event',
            tone: 'danger',
            text: `system> usage: ${shouldArchive ? '/thread archive <threadId>' : '/thread unarchive <threadId>'}`,
          },
        ],
      };
    }

    const thread = (
      shouldArchive ? await archiveThread(threadId) : await unarchiveThread(threadId)
    ) as ThreadPayload;

    return {
      kind: 'entries',
      sessionId: thread.sessionId,
      thread,
      entries: [
        {
          id: createEntryId(),
          kind: 'event',
          tone: 'success',
          text: `system> thread ${shouldArchive ? 'archived' : 'unarchived'} ${thread.title}`,
        },
      ],
    };
  }

  if (prompt.startsWith('/thread export')) {
    const threadId = prompt.slice('/thread export'.length).trim() || options.currentThread?.id;

    if (!threadId) {
      return {
        kind: 'entries',
        entries: [
          {
            id: createEntryId(),
            kind: 'event',
            tone: 'danger',
            text: 'system> usage: /thread export <threadId>',
          },
        ],
      };
    }

    const payload = (await exportThread(threadId)) as {
      thread: ThreadPayload;
      exportPath: string;
    };

    return {
      kind: 'entries',
      sessionId: payload.thread.sessionId,
      thread: payload.thread,
      entries: [
        {
          id: createEntryId(),
          kind: 'card',
          title: 'Thread Exported',
          entries: [
            ['Thread', payload.thread.id],
            ['Path', payload.exportPath],
          ],
        },
      ],
    };
  }

  if (prompt === '/providers') {
    const payload = (await listProviderProfiles()) as {
      profiles: ProviderProfilePayload[];
      defaultProfileId: string | null;
      activeProfileId: string | null;
    };

    return {
      kind: 'entries',
      entries: payload.profiles.length
        ? payload.profiles.map((profile) => ({
            id: createEntryId(),
            kind: 'card' as const,
            title: profile.label,
            entries: [
              ['ID', profile.id],
              ['Type', profile.type],
              ['Status', profile.status],
              ['Model', profile.model ?? 'none'],
              ['Default', payload.defaultProfileId === profile.id ? 'yes' : 'no'],
              ['Active', payload.activeProfileId === profile.id ? 'yes' : 'no'],
              ['Reason', profile.reason ?? 'ok'],
            ],
          }))
        : [
            {
              id: createEntryId(),
              kind: 'event' as const,
              tone: 'info',
              text: 'system> no provider profiles configured',
            },
          ],
    };
  }

  if (prompt.startsWith('/provider use ')) {
    const parts = prompt.trim().split(/\s+/);
    const profileId = parts[2];
    const model = parts[3];

    if (!profileId) {
      return {
        kind: 'entries',
        entries: [
          {
            id: createEntryId(),
            kind: 'event',
            tone: 'danger',
            text: 'system> usage: /provider use <id> [model]',
          },
        ],
      };
    }

    const updated = (await updateProviderProfile(profileId, {
      makeDefault: true,
      ...(model ? { model } : {}),
    })) as ProviderProfilePayload;

    return {
      kind: 'entries',
      entries: [
        {
          id: createEntryId(),
          kind: 'card',
          title: 'Provider Activated',
          entries: [
            ['ID', updated.id],
            ['Label', updated.label],
            ['Model', updated.model ?? 'none'],
            ['Status', updated.status],
          ],
        },
      ],
    };
  }

  if (
    prompt === '/models' ||
    prompt.startsWith('/models ') ||
    prompt.startsWith('/provider models ')
  ) {
    const profileId = prompt.startsWith('/provider models ')
      ? prompt.trim().split(/\s+/)[2]
      : prompt.trim().split(/\s+/)[1] || (await resolveActiveProviderProfile()).profile?.id;

    if (!profileId) {
      return {
        kind: 'entries',
        entries: [
          {
            id: createEntryId(),
            kind: 'event',
            tone: 'danger',
            text: 'system> no active provider. Use /provider connect <type> <label> first.',
          },
        ],
      };
    }

    const payload = (await listProviderModels(profileId)) as {
      models: ListedModel[];
    };

    return {
      kind: 'entries',
      entries: payload.models.map((model) => ({
        id: createEntryId(),
        kind: 'card' as const,
        title: model.name,
        entries: [
          ['ID', model.id],
          ['Context', model.contextWindow === null ? 'unknown' : String(model.contextWindow)],
          ['Tags', model.tags?.join(', ') || 'none'],
        ],
      })),
    };
  }

  if (prompt.startsWith('/provider connect ') || prompt.startsWith('/provider add ')) {
    const parts = prompt.trim().split(/\s+/);
    const type = parts[2];
    const label = parts[3];
    const baseUrl = parts[4];
    const model = parts[5];

    if (!type || !label) {
      return {
        kind: 'entries',
        entries: [
          {
            id: createEntryId(),
            kind: 'event',
            tone: 'danger',
            text: 'system> usage: /provider connect <type> <label> [baseUrl] [model]',
          },
        ],
      };
    }

    const created = (await createProviderProfile({
      type,
      label,
      ...(baseUrl ? { baseUrl } : {}),
      ...(model ? { model } : {}),
      makeDefault: true,
    })) as ProviderProfilePayload;

    return {
      kind: 'entries',
      entries: [
        {
          id: createEntryId(),
          kind: 'card',
          title: 'Provider Connected',
          entries: [
            ['ID', created.id],
            ['Type', created.type],
            ['Base URL', created.baseUrl],
            ['Model', created.model ?? 'none'],
            ['Status', created.status],
          ],
        },
      ],
    };
  }

  if (prompt.startsWith('/compact')) {
    if (!options.currentSessionId) {
      return {
        kind: 'entries',
        entries: [
          {
            id: createEntryId(),
            kind: 'event',
            tone: 'danger',
            text: 'system> no active session to compact yet',
          },
        ],
      };
    }

    const instructions = prompt.slice('/compact'.length).trim();
    const result = (await compactSession(options.currentSessionId, {
      projectPath: options.projectPath,
      ...(instructions ? { instructions } : {}),
    })) as SessionCompactionResult;

    return {
      kind: 'entries',
      sessionId: result.sessionId,
      entries: [
        {
          id: createEntryId(),
          kind: 'event',
          tone: 'success',
          text: `system> compacted session ${result.sessionId}`,
        },
        {
          id: createEntryId(),
          kind: 'card',
          title: 'Context Compact',
          entries: [
            ['Old tokens', String(result.oldTokens)],
            ['New tokens', String(result.newTokens)],
            ['Compacted events', String(result.compactedEventCount)],
            ['Recent tail', String(result.recentEventCount)],
          ],
        },
        {
          id: createEntryId(),
          kind: 'markdown',
          title: 'Compact Summary',
          markdown: result.summary,
        },
      ],
    };
  }

  if (prompt.startsWith('/review') && prompt !== '/review settings') {
    const arg = prompt.slice('/review'.length).trim();
    const target = arg === 'staged' ? 'staged' : arg || 'uncommitted';
    const targetLabel =
      target === 'uncommitted'
        ? 'current changes'
        : target === 'staged'
          ? 'staged changes'
          : `file: ${target}`;

    let reviewResult: ReviewResult;
    try {
      reviewResult = (await reviewCode({
        projectPath: options.projectPath,
        target,
      })) as ReviewResult;
    } catch (err) {
      return {
        kind: 'entries',
        entries: [
          {
            id: createEntryId(),
            kind: 'event',
            tone: 'danger',
            text: `system> review failed: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
      };
    }

    const findingsLines: string[] = [];
    if (reviewResult.findings.length === 0) {
      findingsLines.push('_No issues found._');
    } else {
      for (const finding of reviewResult.findings) {
        const loc = `${finding.code_location.absolute_file_path}:${finding.code_location.line_range.start}-${finding.code_location.line_range.end}`;
        findingsLines.push(`### ${finding.title}`);
        findingsLines.push(`*${loc}*  confidence: ${(finding.confidence_score * 100).toFixed(0)}%`);
        findingsLines.push('');
        findingsLines.push(finding.body);
        findingsLines.push('');
      }
    }

    const correctnessEmoji = reviewResult.overall_correctness === 'patch is correct' ? '✓' : '✗';

    return {
      kind: 'entries',
      entries: [
        {
          id: createEntryId(),
          kind: 'event',
          tone: 'info',
          text: `system> code review complete — ${targetLabel} — ${reviewResult.findings.length} finding(s)`,
        },
        {
          id: createEntryId(),
          kind: 'markdown',
          title: `Code Review — ${targetLabel}`,
          markdown: [
            `**Verdict:** ${correctnessEmoji} ${reviewResult.overall_correctness}`,
            `**Explanation:** ${reviewResult.overall_explanation}`,
            `**Confidence:** ${(reviewResult.overall_confidence_score * 100).toFixed(0)}%`,
            '',
            reviewResult.findings.length > 0 ? '---' : '',
            ...findingsLines,
          ]
            .filter((l) => l !== '' || findingsLines.length > 0)
            .join('\n'),
        },
      ],
    };
  }

  // --- Skill command dispatch (always read from disk so new skills are picked up without restart) ---
  const trimmedForSkill = prompt.trim();
  const { skills: liveSkills } = loadSkills({ projectPath: options.projectPath });
  // Refresh autocomplete registry so subsequent suggestions reflect current disk state
  registerSkillCommands(liveSkills);

  const dispatchSkillInvocation = async (skill: (typeof liveSkills)[number], rawArgs: string) => {
    options.onSkillFound?.(skill.name, rawArgs);
    try {
      const expanded = await invokeSkill(skill, rawArgs, options.projectPath);
      writeDebugEvent({
        component: 'tui',
        level: 'info',
        message: 'skill invoked',
        data: { name: skill.name, args: rawArgs, disableModel: skill.disableModelInvocation },
      });
      if (skill.disableModelInvocation) {
        const output = await runSkillScript(expanded, options.projectPath);
        return {
          kind: 'entries' as const,
          entries: [
            {
              id: createEntryId(),
              kind: 'markdown' as const,
              title: `/${skill.name}`,
              markdown: output ? `\`\`\`\n${output}\n\`\`\`` : '_no output_',
            },
          ],
        };
      }
      // Pass _skipSkillDetection=true so the expanded template is not re-processed for skill keywords
      return handlePrompt(expanded, { ...options, _skipSkillDetection: true });
    } catch (err) {
      return {
        kind: 'entries' as const,
        entries: [
          {
            id: createEntryId(),
            kind: 'event' as const,
            tone: 'danger' as const,
            text: `system> skill error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
      };
    }
  };

  if (!options._skipSkillDetection) {
    // 1. Start-of-prompt slash: /skill-name [args]
    if (trimmedForSkill.startsWith('/')) {
      for (const skill of liveSkills) {
        const slash = `/${skill.name}`;
        if (trimmedForSkill === slash || trimmedForSkill.startsWith(`${slash} `)) {
          const rawArgs = trimmedForSkill.slice(slash.length).trimStart();
          return dispatchSkillInvocation(skill, rawArgs);
        }
      }
    }

    // 2. Inline slash: "prefix text /skill-name [suffix]" — prefix becomes part of args
    for (const skill of liveSkills) {
      const slash = `/${skill.name}`;
      const inlineIdx = trimmedForSkill.indexOf(` ${slash}`);
      if (inlineIdx !== -1) {
        const prefix = trimmedForSkill.slice(0, inlineIdx).trim();
        const suffix = trimmedForSkill.slice(inlineIdx + 1 + slash.length).trim();
        const rawArgs = [prefix, suffix].filter(Boolean).join(' ');
        return dispatchSkillInvocation(skill, rawArgs);
      }
    }

    // 3. Natural language: "use [the] <skill-name> skill [context]", "run [the] <skill-name> skill"
    const promptLower = trimmedForSkill.toLowerCase();
    for (const skill of liveSkills) {
      const n = skill.name.toLowerCase();
      const nlPatterns = [
        `use the ${n} skill`,
        `use ${n} skill`,
        `run the ${n} skill`,
        `run ${n} skill`,
        // Additional: "skill <name>" and "skill: <name>" forms
        `skill ${n}`,
        `skill: ${n}`,
      ];
      const matchedNL = nlPatterns.find((p) => promptLower.includes(p));
      if (matchedNL) {
        const pIdx = promptLower.indexOf(matchedNL);
        const rawArgs = [
          trimmedForSkill.slice(0, pIdx),
          trimmedForSkill.slice(pIdx + matchedNL.length),
        ]
          .map((s) => s.trim())
          .filter(Boolean)
          .join(' ');
        return dispatchSkillInvocation(skill, rawArgs);
      }
    }

    // 4. Broad multilingual NL: skill name + any "skill" keyword in any language.
    // Catches Russian ("скилл X", "юзай скил X"), transliteration ("skil X"), and mixed input.
    const skillKws = ['skill', 'скилл', 'скил', 'скилы', 'skil'];
    const hasSkillKw = skillKws.some((kw) => promptLower.includes(kw));
    if (hasSkillKw) {
      for (const skill of liveSkills) {
        const n = skill.name.toLowerCase();
        if (!promptLower.includes(n)) continue;

        // Strip skill name and skill keywords to form rawArgs (preserve surrounding context)
        let argsText = trimmedForSkill;
        const nameIdx = argsText.toLowerCase().indexOf(n);
        if (nameIdx !== -1) {
          argsText = `${argsText.slice(0, nameIdx)}${argsText.slice(nameIdx + n.length)}`;
        }
        for (const kw of skillKws) {
          let pos = argsText.toLowerCase().indexOf(kw);
          while (pos !== -1) {
            argsText = `${argsText.slice(0, pos)}${argsText.slice(pos + kw.length)}`;
            pos = argsText.toLowerCase().indexOf(kw);
          }
        }
        const rawArgs = argsText.replace(/\s+/g, ' ').trim() || trimmedForSkill;
        return dispatchSkillInvocation(skill, rawArgs);
      }
    }
  }

  const active = await resolveActiveProviderProfile();

  if (!active.profile) {
    return {
      kind: 'entries',
      entries: [
        {
          id: createEntryId(),
          kind: 'event',
          tone: 'danger',
          text: 'system> no provider connected. Use /provider connect <type> <label> first.',
        },
      ],
    };
  }

  if (!active.profile.model) {
    return {
      kind: 'entries',
      entries: [
        {
          id: createEntryId(),
          kind: 'event',
          tone: 'danger',
          text: `system> provider "${active.profile.label}" has no model. Use /models, then /provider use ${active.profile.id} <model>.`,
        },
      ],
    };
  }

  const enrichedPrompt = await enrichPromptWithReferences({
    prompt,
    projectPath: options.projectPath,
    fileReferences: options.fileReferences,
    catalog: options.projectReferences,
  });

  const daemonMode = options.runtimeMode;

  const createdRun = (await createRun({
    prompt: enrichedPrompt,
    mode: daemonMode,
    projectPath: options.projectPath,
    providerProfileId: active.profile.id,
    model: active.profile.model,
    ...(options.currentThread?.id ? { threadId: options.currentThread.id } : {}),
    ...(options.currentSessionId ? { sessionId: options.currentSessionId } : {}),
    ...(options.memorySettings
      ? {
          useMemories: options.memorySettings.useMemories,
          generateMemories: options.memorySettings.generateMemories,
        }
      : {}),
    ...(options.goalContext ? { goalContext: options.goalContext } : {}),
    ...(options.thinkBudget != null ? { thinkBudget: options.thinkBudget } : {}),
    ...(options.gitEnabled ? { gitEnabled: true } : {}),
  })) as RunTaskPayload;

  return {
    kind: 'run',
    run: createdRun,
  };
}

function tryParsePlanJson(text: string | null | undefined): unknown | null {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text.trim());
    if (parsed && typeof parsed === 'object' && 'steps' in parsed) return parsed;
  } catch {}
  return null;
}

function formatRunEntries(
  run: RunTaskPayload,
  showCitations = false,
  durationMs?: number,
): SessionEntry[] {
  const entries = buildRunTimelineEntries(run);

  // Plan mode: replace the raw JSON assistant bubble with a formatted plan card
  if (run.mode === 'plan') {
    const planJson = run.result?.finalJson ?? tryParsePlanJson(run.result?.finalText ?? null);
    if (planJson) {
      const plan = planJson as {
        summary?: string;
        steps?: Array<{
          id?: string;
          title?: string;
          reason?: string;
          files?: string[];
          checks?: string[];
        }>;
      };
      // Remove any raw assistant bubbles that contain the JSON
      for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i];
        if (e?.kind === 'bubble' && e.bubbleRole === 'assistant') {
          entries.splice(i, 1);
          break;
        }
      }
      entries.push({
        id: `plan-summary:${run.id}`,
        kind: 'bubble',
        bubbleRole: 'assistant',
        title: 'Plan',
        text: [
          plan.summary ? `**${plan.summary}**\n` : '',
          ...(plan.steps ?? []).map(
            (step, idx) =>
              `**${idx + 1}. ${step.title ?? ''}**\n${step.reason ? `> ${step.reason}\n` : ''}${
                step.files?.length ? `Files: \`${step.files.join('`, `')}\`\n` : ''
              }${step.checks?.length ? `Checks: ${step.checks.join(', ')}\n` : ''}`,
          ),
        ]
          .filter(Boolean)
          .join('\n'),
        tone: 'default',
      });
    }
  }

  if (showCitations && run.result?.memoryCitation && run.result.memoryCitation.entries.length > 0) {
    entries.push({
      id: `citations:${run.id}`,
      kind: 'citations',
      threadId: run.result.memoryCitation.threadId,
      projectMemoryUsed: run.result.memoryCitation.projectMemoryUsed,
      sessionSummaryUsed: run.result.memoryCitation.sessionSummaryUsed,
      entries: run.result.memoryCitation.entries.map((entry) => ({
        memoryId: entry.memoryId,
        sourceType: entry.sourceType,
        score: entry.score,
        excerpt: entry.excerpt,
      })),
    });
  }

  if (run.result?.commit) {
    entries.push({
      id: createEntryId(),
      kind: 'card',
      title: 'Auto Commit',
      entries: [
        ['Commit', run.result.commit.commitHash],
        ['Message', run.result.commit.message],
      ],
    });
  }

  if (entries.length === 0) {
    entries.push({
      id: `run-fallback:${run.id}`,
      kind: 'event',
      tone: 'info',
      text: run.result?.finalText
        ? `assistant> ${run.result.finalText}`
        : 'system> (empty response)',
    });
  }

  if (run.status !== 'completed' && run.status !== 'running' && run.status !== 'queued') {
    const hasErrorEvent = run.events.some((e) => e.type === 'error');
    if (!(run.status === 'failed' && hasErrorEvent)) {
      entries.push({
        id: `run-status:${run.id}:${run.status}`,
        kind: 'event',
        tone: run.status === 'failed' || run.status === 'timed_out' ? 'danger' : 'info',
        text: `system> run ${run.status}${run.lastError ? `: ${run.lastError}` : ''}`,
      });
    }

    const isRateLimit =
      run.lastError?.includes('429') ||
      run.lastError?.toLowerCase().includes('rate limit') ||
      run.lastError?.toLowerCase().includes('usage limit');
    if (isRateLimit) {
      entries.push({
        id: `run-hint:${run.id}`,
        kind: 'event',
        tone: 'info',
        text: 'system> tip: use /models to switch to another model, or wait for quota to reset',
      });
    }
  }

  // Attach durationMs to the last assistant bubble so it shows an elapsed timer
  if (durationMs !== undefined && run.status === 'completed') {
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e?.kind === 'bubble' && e.bubbleRole === 'assistant') {
        (e as Extract<SessionEntry, { kind: 'bubble' }>).durationMs = durationMs;
        break;
      }
    }
  }

  return entries;
}

function writeRunDebugMetadata(run: RunTaskPayload): void {
  if (!run.result?.memoryCitation) {
    return;
  }

  writeDebugEvent({
    component: 'tui',
    level: 'info',
    message: 'run memory provenance',
    data: {
      runId: run.id,
      threadId: run.result.memoryCitation.threadId,
      projectMemoryUsed: run.result.memoryCitation.projectMemoryUsed,
      sessionSummaryUsed: run.result.memoryCitation.sessionSummaryUsed,
      retrievedCount: run.result.memoryCitation.entries.length,
      sources: run.result.memoryCitation.entries.map((entry) => ({
        memoryId: entry.memoryId,
        sourceType: entry.sourceType,
        score: entry.score,
        excerpt: entry.excerpt,
      })),
    },
  });
}

function LiveRunView({ run }: { run: RunTaskPayload }) {
  const allEntries = buildRunTimelineEntries(run);
  // Cap live events to keep the Ink render area small and prevent cursor-jump teleports.
  const LIVE_VISIBLE = 3;
  const visible = allEntries.slice(-LIVE_VISIBLE);
  const hiddenCount = allEntries.length - visible.length;

  return (
    <Box flexDirection="column">
      {hiddenCount > 0 ? (
        <Box paddingLeft={2}>
          <Text color={umbraTheme.muted} dimColor>{`··· ${hiddenCount} events`}</Text>
        </Box>
      ) : null}
      {visible.map((entry) => (
        <SessionEntryView key={`live:${entry.id}`} entry={entry} />
      ))}
    </Box>
  );
}

async function buildThreadRestoreEntries(
  thread: ThreadPayload,
  action: 'resume' | 'fork',
): Promise<SessionEntry[]> {
  const header: SessionEntry = {
    id: createEntryId(),
    kind: 'event',
    tone: 'success',
    text: `system> ${action === 'resume' ? 'resumed' : 'forked'} thread ${thread.title}`,
  };

  try {
    const events = normalizeSessionLogEvents(await readSessionEvents(thread.sessionId));
    const transcript = buildSessionTranscriptEntries(events);

    if (transcript.length === 0) {
      return [
        header,
        {
          id: createEntryId(),
          kind: 'event',
          tone: 'info',
          text: 'system> selected session has no transcript events yet.',
        },
      ];
    }

    return [header, ...transcript];
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return [
      header,
      {
        id: createEntryId(),
        kind: 'event',
        tone: 'danger',
        text: `system> failed to restore session transcript: ${message}`,
      },
    ];
  }
}

function annotateToolSequences(entries: SessionEntry[]): SessionEntry[] {
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry?.kind !== 'tool-call') continue;
    const prev = entries[i - 1];
    const next = entries[i + 1];
    entry.seqFirst = prev?.kind !== 'tool-call';
    entry.seqLast = next?.kind !== 'tool-call';
  }
  return entries;
}

export function buildSessionTranscriptEntries(events: SessionLogEvent[]): SessionEntry[] {
  const entries: SessionEntry[] = [];

  for (const event of events) {
    const payload = event.payload;

    if (event.type === 'user_message') {
      const text = typeof payload.text === 'string' ? payload.text : '';
      if (!text) continue;
      entries.push({
        id: event.id,
        kind: 'bubble',
        bubbleRole: 'user',
        title: null,
        text,
        tone: 'default',
      });
      continue;
    }

    if (event.type === 'assistant_message') {
      const text = typeof payload.text === 'string' ? payload.text : '';
      if (!text) continue;
      entries.push({
        id: event.id,
        kind: 'bubble',
        bubbleRole: 'assistant',
        title: null,
        text,
        reasoning: typeof payload.reasoningContent === 'string' ? payload.reasoningContent : null,
        tone: 'default',
      });
      continue;
    }

    if (event.type === 'tool_call_started') {
      const toolName = String(payload.toolName ?? 'unknown');
      const action = describeToolAction(toolName, payload.arguments);
      const target = describeToolTarget(toolName, payload.arguments);
      entries.push({
        id: event.id,
        kind: 'tool-call',
        toolName,
        action,
        status: 'running',
        target,
        result: '',
      });
      continue;
    }

    if (event.type === 'tool_call_finished' || event.type === 'tool_call_failed') {
      const toolName = String(payload.toolName ?? 'unknown');
      const resultPayload = isRecord(payload.result) ? payload.result : {};
      const summary = summarizeToolResult(resultPayload);
      const isFailed = event.type === 'tool_call_failed';
      for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i];
        if (e?.kind === 'tool-call' && e.toolName === toolName && e.status === 'running') {
          e.status = isFailed ? 'failed' : 'done';
          e.result = summary;
          break;
        }
      }
      continue;
    }

    if (event.type === 'command_started' || event.type === 'command_finished') {
      const command = String(payload.command ?? 'unknown');
      const exitCode = typeof payload.exitCode === 'number' ? payload.exitCode : null;
      const cmdLabel = command.length > 52 ? `${command.slice(0, 51)}…` : command;
      const isFailed = exitCode !== null && exitCode !== 0;
      const glyph = event.type === 'command_started' ? '⟳' : isFailed ? '✗' : '✓';
      const suffix = exitCode !== null ? ` · exit ${exitCode}` : '';
      entries.push({
        id: event.id,
        kind: 'event',
        tone: isFailed ? 'danger' : 'info',
        text: `tool> ${glyph} ${cmdLabel}${suffix}`,
      });
      continue;
    }

    if (event.type === 'patch_applied') {
      entries.push({
        id: event.id,
        kind: 'event',
        tone: 'info',
        text: `system> ${formatEventTime(event.timestamp)} patch applied`,
      });
      continue;
    }

    if (event.type === 'session_compacted') {
      entries.push({
        id: event.id,
        kind: 'event',
        tone: 'info',
        text: `system> ${formatEventTime(event.timestamp)} session compacted`,
      });
      continue;
    }

    if (event.type === 'memory_written') {
      entries.push({
        id: event.id,
        kind: 'event',
        tone: 'info',
        text: `system> ${formatEventTime(event.timestamp)} memory written`,
      });
    }
  }

  return annotateToolSequences(entries);
}

function normalizeSessionLogEvents(value: unknown): SessionLogEvent[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((event) => {
    if (!isRecord(event) || !isRecord(event.payload)) return [];
    return [
      {
        id: typeof event.id === 'string' ? event.id : createEntryId(),
        timestamp:
          typeof event.timestamp === 'string' ? event.timestamp : new Date(0).toISOString(),
        type: typeof event.type === 'string' ? event.type : 'unknown',
        payload: event.payload,
      },
    ];
  });
}

export function buildRunTimelineEntries(run: RunTaskPayload): SessionEntry[] {
  const entries: SessionEntry[] = [];

  for (const event of run.events) {
    if (event.type === 'reasoning_delta') {
      const delta = typeof event.payload.delta === 'string' ? event.payload.delta : '';

      if (delta) {
        const lastEntry = entries.at(-1);
        if (lastEntry?.kind === 'thinking') {
          lastEntry.text += delta;
        } else {
          entries.push({
            id: event.id,
            kind: 'thinking',
            title: 'Thinking',
            text: delta,
          });
        }
      }
      continue;
    }

    if (event.type === 'assistant_delta') {
      const delta = typeof event.payload.delta === 'string' ? event.payload.delta : '';

      if (delta) {
        appendBubbleText(entries, {
          id: event.id,
          kind: 'bubble',
          bubbleRole: 'assistant',
          title: null,
          text: delta,
          tone: 'default',
        });
      }
      continue;
    }

    if (event.type === 'assistant_message') {
      const text = typeof event.payload.text === 'string' ? event.payload.text : '';

      if (!text) {
        continue;
      }

      // Find the last assistant bubble regardless of position — tool events between
      // the final delta and the consolidated message would otherwise cause duplication.
      let lastAssistantBubble: Extract<SessionEntry, { kind: 'bubble' }> | undefined;
      for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i];
        if (e?.kind === 'bubble' && e.bubbleRole === 'assistant') {
          lastAssistantBubble = e;
          break;
        }
      }

      if (lastAssistantBubble) {
        lastAssistantBubble.text = text;
      } else {
        entries.push({
          id: event.id,
          kind: 'bubble',
          bubbleRole: 'assistant',
          title: null,
          text,
          tone: 'default',
        });
      }
      continue;
    }

    if (event.type === 'tool_call') {
      const toolName = String(event.payload.name ?? 'unknown');
      const action = describeToolAction(toolName, event.payload.arguments);
      const target = describeToolTarget(toolName, event.payload.arguments);
      entries.push({
        id: event.id,
        kind: 'tool-call',
        toolName,
        action,
        status: 'running',
        target,
        result: '',
      });
      continue;
    }

    if (event.type === 'tool_result') {
      const toolName = String(event.payload.name ?? 'unknown');
      const isFailed = String(event.payload.status ?? '') !== 'completed';
      const summary = summarizeToolResult(event.payload);
      for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i];
        if (e?.kind === 'tool-call' && e.toolName === toolName && e.status === 'running') {
          e.status = isFailed ? 'failed' : 'done';
          e.result = summary;
          break;
        }
      }
      continue;
    }

    if (event.type === 'command') {
      const cmdPhase = String(event.payload.phase ?? 'update');
      const cmdName = String(event.payload.command ?? '');
      const exitCode = typeof event.payload.exitCode === 'number' ? event.payload.exitCode : null;
      const tone = exitCode !== null && exitCode !== 0 ? 'danger' : 'info';

      // Deduplicate: when the 'end' phase arrives, update the matching 'start' entry
      // so the same command doesn't appear twice in the output.
      if (cmdPhase === 'end' || cmdPhase === 'complete') {
        let updated = false;
        for (let i = entries.length - 1; i >= 0; i--) {
          const e = entries[i];
          if (e?.kind === 'event' && e.text.includes(`command start ${cmdName}`)) {
            e.tone = tone;
            e.text = `system> ${formatEventTime(event.timestamp)} command ${cmdName}${exitCode !== null ? ` exit ${exitCode}` : ''}`;
            updated = true;
            break;
          }
        }
        if (updated) continue;
      }

      entries.push({
        id: event.id,
        kind: 'event',
        tone,
        text: `system> ${formatEventTime(event.timestamp)} command ${cmdPhase} ${cmdName}${exitCode !== null ? ` exit ${exitCode}` : ''}`,
      });
      continue;
    }

    if (event.type === 'error') {
      entries.push({
        id: event.id,
        kind: 'event',
        tone: 'danger',
        text: `system> ${formatEventTime(event.timestamp)} ${String(event.payload.error ?? 'run failed')}`,
      });
    }
  }

  return annotateToolSequences(entries);
}

function describeStatusEvent(payload: Record<string, unknown>): string {
  const phase = typeof payload.phase === 'string' ? payload.phase : null;

  if (phase === 'thinking') {
    return `thinking with model ${String(payload.model ?? 'unknown')}`;
  }

  if (phase === 'harness_retry') {
    return `retrying after ${String(payload.command ?? 'check')} exit ${String(payload.exitCode ?? 'unknown')}`;
  }

  if ('status' in payload) {
    return `run ${String(payload.status)}`;
  }

  if ('contract' in payload) {
    const contract = payload.contract as { mode?: string; toolPreset?: string | null } | undefined;
    return `mode ${contract?.mode ?? 'unknown'} / preset ${contract?.toolPreset ?? 'none'}`;
  }

  return JSON.stringify(payload);
}

function appendBubbleText(
  entries: SessionEntry[],
  bubble: Extract<SessionEntry, { kind: 'bubble' }>,
) {
  const lastEntry = entries.at(-1);

  if (
    lastEntry?.kind === 'bubble' &&
    lastEntry.bubbleRole === bubble.bubbleRole &&
    (lastEntry.tone ?? 'default') === (bubble.tone ?? 'default') &&
    !lastEntry.title &&
    !bubble.title
  ) {
    lastEntry.text += bubble.text;
    return;
  }

  entries.push(bubble);
}

function collectLineStarts(value: string): number[] {
  const starts = [0];

  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '\n') {
      starts.push(index + 1);
    }
  }

  return starts;
}

function clampCursor(value: string, cursorPosition: number): number {
  return Math.max(0, Math.min(cursorPosition, value.length));
}

function findLineIndex(lineStarts: number[], cursorPosition: number): number {
  for (let index = lineStarts.length - 1; index >= 0; index -= 1) {
    if (cursorPosition >= (lineStarts[index] ?? 0)) {
      return index;
    }
  }

  return 0;
}

function describeToolAction(name: string, argumentsValue: unknown): string {
  void argumentsValue;

  if (name === 'fs.read') {
    return 'Reading 1 file';
  }

  if (name === 'fs.write') {
    return 'Writing 1 file';
  }

  if (name === 'fs.edit') {
    return 'Editing file';
  }

  if (name === 'fs.list') {
    return 'Listing directory';
  }

  if (name === 'search.rg') {
    return 'Searching repository';
  }

  if (name === 'web.search') {
    return 'Searching web';
  }

  if (name === 'web.fetch') {
    return 'Reading web page';
  }

  if (name === 'shell.exec') {
    return 'Running command';
  }

  if (name.startsWith('git.')) {
    return `Running ${name}`;
  }

  return name;
}

function describeToolTarget(name: string, argumentsValue: unknown): string {
  const args = isRecord(argumentsValue) ? argumentsValue : {};
  const trunc = (s: string, n = 52) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

  if (name === 'shell.exec' && typeof args.command === 'string') {
    return trunc(args.command);
  }

  if (name === 'web.search' && typeof args.query === 'string') {
    return trunc(args.query);
  }

  if (name === 'web.fetch' && typeof args.url === 'string') {
    return trunc(args.url);
  }

  if (name === 'search.rg' && typeof args.pattern === 'string') {
    return trunc(String(args.pattern));
  }

  if (name === 'fs.edit' && typeof args.patch === 'string') {
    return summarizePatchTargets(args.patch);
  }

  if ('path' in args && typeof args.path === 'string') {
    return trunc(args.path);
  }

  return '';
}

function summarizeToolResult(payload: Record<string, unknown>): string {
  if (typeof payload.error === 'string' && payload.error) {
    return payload.error;
  }

  const output = isRecord(payload.output) ? payload.output : {};

  if (Array.isArray(output.changedFiles)) {
    return output.changedFiles
      .map((entry) =>
        isRecord(entry)
          ? `${String(entry.path ?? entry.targetPath ?? entry.operation ?? 'change')}`
          : 'change',
      )
      .join(', ');
  }

  if (typeof output.resolvedPath === 'string') {
    return output.resolvedPath;
  }

  if (typeof output.command === 'string') {
    return `${output.command} -> ${String(output.exitCode ?? '')}`.trim();
  }

  return payload.status === 'completed' ? 'completed' : 'updated';
}

function summarizePatchTargets(patch: string): string {
  const matches = [...patch.matchAll(/^\+\+\+\s+b\/(.+)$/gm)].map((match) => match[1]);
  return matches.length > 0 ? matches.join(', ') : 'patch';
}

function formatEventTime(timestamp: string): string {
  const date = new Date(timestamp);
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
}

async function resolveActiveProviderProfile(): Promise<{
  profile: ProviderProfilePayload | null;
  profiles: ProviderProfilePayload[];
}> {
  const payload = (await listProviderProfiles()) as {
    profiles: ProviderProfilePayload[];
    activeProfileId: string | null;
    defaultProfileId: string | null;
    fallbackProfileId: string | null;
  };
  const preferredId =
    payload.activeProfileId ?? payload.defaultProfileId ?? payload.fallbackProfileId;
  const profile =
    payload.profiles.find((entry) => entry.id === preferredId && entry.status !== 'unavailable') ??
    null;

  return {
    profile,
    profiles: payload.profiles,
  };
}

async function resolveCurrentThread(projectPath: string): Promise<ThreadPayload | null> {
  const payload = (await listThreads({
    projectPath,
    archived: false,
    limit: 1,
  })) as { threads: ThreadPayload[] };
  return payload.threads[0] ?? null;
}

function createEntryId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function eventColor(tone: 'info' | 'success' | 'danger'): string {
  if (tone === 'success') {
    return umbraTheme.success;
  }

  if (tone === 'danger') {
    return umbraTheme.danger;
  }

  return umbraTheme.muted;
}

function truncateCwd(cwd: string): string {
  return cwd.length > 36 ? `...${cwd.slice(-33)}` : cwd;
}

function stripEventPrefix(text: string): string {
  return text.replace(/^[a-z]+>\s*/i, '');
}

function permissionModeOptions(currentMode: 'agent' | 'full') {
  return [
    {
      id: 'default',
      mode: 'agent' as const,
      label: 'Default',
      summary:
        'Can read, edit, and run commands in workspace; destructive actions require approval.',
    },
    {
      id: 'full',
      mode: 'full' as const,
      label: 'Full Access',
      summary: 'Can read/write and execute without asking for approval.',
    },
  ].map((option) => ({
    ...option,
    isCurrent: option.mode === currentMode,
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function reportDialogFailure(
  cause: unknown,
  setError: (value: string | null) => void,
  appendEntries: (entries: SessionEntry[]) => void,
  debugMessage: string,
): void {
  const message = cause instanceof Error ? cause.message : String(cause);
  setError(message);
  appendEntries([
    {
      id: createEntryId(),
      kind: 'event',
      tone: 'danger',
      text: `error> ${message}`,
    },
  ]);
  writeDebugEvent({
    component: 'tui',
    level: 'error',
    message: debugMessage,
    data: {
      error: message,
    },
  });
}
