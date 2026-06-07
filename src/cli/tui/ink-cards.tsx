import { Box, Text } from 'ink';
// biome-ignore lint/style/useImportType: React is needed for JSX runtime
import React from 'react';
import type { DoctorReport } from '../doctor.js';
import type { ProjectReferenceItem } from './project-reference-index.js';
import type { SlashCommandHelp } from './session-view.js';
import { umbraTheme } from './theme.js';

const ROLE_LABEL = {
  user: 'You',
  assistant: 'Umbra',
  system: 'sys',
} as const;

export function InkSplash() {
  return null;
}

export function InkKeyValueCard(props: { title: string; entries: Array<[string, string]> }) {
  return (
    <Box flexDirection="column">
      {props.entries.map(([key, value]) => (
        <Box key={key}>
          <Text color={umbraTheme.accentSoft}>{`  ${key}`.padEnd(16, ' ')}</Text>
          <Text color={umbraTheme.text}>{value}</Text>
        </Box>
      ))}
    </Box>
  );
}

export function InkChatBubble(props: {
  bubbleRole: 'user' | 'assistant' | 'system';
  title?: string | null;
  reasoning?: string | null;
  children: React.ReactNode;
}) {
  const label = props.title ?? ROLE_LABEL[props.bubbleRole];

  const labelColor =
    props.bubbleRole === 'user'
      ? umbraTheme.warning
      : props.bubbleRole === 'assistant'
        ? umbraTheme.accent
        : umbraTheme.muted;

  return (
    <Box marginBottom={1} flexDirection="column">
      <Text color={labelColor} bold>
        {label}
      </Text>
      <Box flexDirection="column" paddingLeft={2}>
        {props.reasoning ? (
          <Box marginBottom={1} flexDirection="column">
            <Text color={umbraTheme.muted} italic>
              {'reasoning'}
            </Text>
            <Text italic color={umbraTheme.muted} dimColor>
              {props.reasoning}
            </Text>
          </Box>
        ) : null}
        {props.children}
      </Box>
    </Box>
  );
}

export type LastRequestUsageDisplay = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  costEstimate?: number;
  contextPercent?: number;
  source?: 'actual' | 'estimated' | 'mixed';
};

export function InkStatusLine(props: {
  daemon: string;
  cwd: string;
  mode: string;
  provider: string;
  model: string;
  web: string;
  showPath?: boolean;
  goal?: string | null;
  thinkBudget?: number | 'low' | 'medium' | 'high' | 'max' | null;
  lastRequest?: LastRequestUsageDisplay | null;
}) {
  const isOnline = props.daemon === 'online';
  const daemonColor = isOnline ? umbraTheme.success : umbraTheme.danger;
  const daemonGlyph = isOnline ? '*' : '!';
  const webColor = props.web === 'off' ? umbraTheme.muted : umbraTheme.code;
  const model = truncateValue(props.model, 22);
  const provider = truncateValue(props.provider, 18);
  const SEP = ' | ';
  const DOT = <Text color={umbraTheme.frameDim}>{' · '}</Text>;

  const req = props.lastRequest;

  return (
    <Box flexDirection="column">
      <Box marginTop={1} flexDirection="row" flexWrap="nowrap">
        <Text color={daemonColor}>{`${daemonGlyph} `}</Text>
        <Text color={daemonColor}>{props.daemon}</Text>
        <Text color={umbraTheme.frameDim}>{SEP}</Text>
        <Text color={umbraTheme.muted}>{props.mode}</Text>
        {props.thinkBudget != null ? (
          <>
            <Text color={umbraTheme.frameDim}>{' · '}</Text>
            <Text color={umbraTheme.warning}>
              {`think:${typeof props.thinkBudget === 'string' ? props.thinkBudget : `${props.thinkBudget.toLocaleString()}t`}`}
            </Text>
          </>
        ) : null}
        <Text color={umbraTheme.frameDim}>{SEP}</Text>
        <Text color={umbraTheme.accent}>{model}</Text>
        <Text color={umbraTheme.frameDim}>{' - '}</Text>
        <Text color={umbraTheme.accentSoft}>{provider}</Text>
        <Text color={umbraTheme.frameDim}>{SEP}</Text>
        <Text color={webColor}>{`web:${props.web}`}</Text>
        {props.showPath ? (
          <>
            <Text color={umbraTheme.frameDim}>{SEP}</Text>
            <Box flexGrow={1}>
              <Text color={umbraTheme.muted} dimColor wrap="truncate-end">
                {props.cwd}
              </Text>
            </Box>
          </>
        ) : null}
      </Box>
      {props.goal ? (
        <Box flexDirection="row" paddingLeft={2}>
          <Text color={umbraTheme.frameDim}>{'goal: '}</Text>
          <Text color={umbraTheme.warning} wrap="truncate-end">
            {props.goal}
          </Text>
        </Box>
      ) : null}
      {req ? (
        <Box flexDirection="row" paddingLeft={2}>
          <Text color={umbraTheme.muted}>{'last: '}</Text>
          <Text color={umbraTheme.warning}>{'↑'}</Text>
          <Text color={umbraTheme.muted}>{req.inputTokens.toLocaleString()}</Text>
          {DOT}
          <Text color={umbraTheme.accent}>{'↓'}</Text>
          <Text color={umbraTheme.muted}>{req.outputTokens.toLocaleString()}</Text>
          {(req.reasoningTokens ?? 0) > 0 ? (
            <>
              {DOT}
              <Text color={umbraTheme.muted}>{`~${(req.reasoningTokens ?? 0).toLocaleString()}`}</Text>
            </>
          ) : null}
          {(req.cacheReadTokens ?? 0) > 0 ? (
            <>
              {DOT}
              <Text color={umbraTheme.code}>{`cache:${(req.cacheReadTokens ?? 0).toLocaleString()}`}</Text>
            </>
          ) : null}
          {req.contextPercent != null ? (
            <>
              {DOT}
              <Text color={req.contextPercent > 80 ? umbraTheme.warning : umbraTheme.muted}>
                {`${req.contextPercent.toFixed(1)}%ctx`}
              </Text>
            </>
          ) : null}
          {req.costEstimate != null ? (
            <>
              {DOT}
              <Text color={umbraTheme.accentSoft}>{`$${req.costEstimate.toFixed(4)}`}</Text>
            </>
          ) : null}
          {req.source === 'estimated' ? (
            <>
              {DOT}
              <Text color={umbraTheme.muted} dimColor>{'~est'}</Text>
            </>
          ) : null}
        </Box>
      ) : null}
    </Box>
  );
}

function truncateValue(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  if (maxLength <= 1) return value.slice(0, maxLength);
  return `${value.slice(0, maxLength - 1)}...`;
}

export function InkCommandSuggestions(props: { commands: SlashCommandHelp[] }) {
  if (props.commands.length === 0) {
    return null;
  }

  return (
    <Box flexDirection="column">
      {props.commands.map((command, index) => (
        <Box key={command.name}>
          <Text color={index === 0 ? umbraTheme.accent : umbraTheme.muted}>
            {index === 0 ? '> ' : '  '}
          </Text>
          <Box width={22}>
            <Text color={index === 0 ? umbraTheme.accent : umbraTheme.code}>{command.name}</Text>
          </Box>
          <Text color={index === 0 ? umbraTheme.text : umbraTheme.muted}>{command.summary}</Text>
        </Box>
      ))}
    </Box>
  );
}

export function InkMetricsPanel(props: {
  mode: 'compact' | 'verbose';
  stats: {
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
    reasoningTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    requests: number;
    totalCost: number;
  } | null;
}) {
  if (!props.stats) return null;
  const { inputTokens, outputTokens, totalCost, requests } = props.stats;
  const costStr = `$${totalCost.toFixed(4)}`;
  const SEP = <Text color={umbraTheme.frameDim}>{' · '}</Text>;

  if (props.mode === 'verbose') {
    return (
      <Box marginTop={0} flexDirection="row">
        <Text color={umbraTheme.muted}>{'  '}</Text>
        <Text color={umbraTheme.warning}>{'↑'}</Text>
        <Text color={umbraTheme.muted}>{` in ${inputTokens.toLocaleString()}`}</Text>
        {SEP}
        <Text color={umbraTheme.accent}>{'↓'}</Text>
        <Text color={umbraTheme.muted}>{` out ${outputTokens.toLocaleString()}`}</Text>
        {SEP}
        <Text color={umbraTheme.accentSoft}>{costStr}</Text>
        {SEP}
        <Text color={umbraTheme.muted}>{`×${requests}`}</Text>
      </Box>
    );
  }

  return (
    <Box marginTop={0} flexDirection="row">
      <Text color={umbraTheme.muted}>{'  '}</Text>
      <Text color={umbraTheme.warning}>{'↑'}</Text>
      <Text color={umbraTheme.muted}>{` ${inputTokens.toLocaleString()}`}</Text>
      {SEP}
      <Text color={umbraTheme.accent}>{'↓'}</Text>
      <Text color={umbraTheme.muted}>{` ${outputTokens.toLocaleString()}`}</Text>
      {SEP}
      <Text color={umbraTheme.accentSoft}>{costStr}</Text>
      {SEP}
      <Text color={umbraTheme.muted}>{`×${requests}`}</Text>
    </Box>
  );
}


export function InkSlashOverlay(props: {
  commands: SlashCommandHelp[];
  selectedIndex: number;
}) {
  if (props.commands.length === 0) {
    return null;
  }

  return (
    <Box
      marginTop={1}
      flexDirection="column"
      paddingX={1}
      borderStyle="single"
      borderColor={umbraTheme.frameDim}
    >
      {props.commands.map((command, index) => {
        const isSelected = index === props.selectedIndex;
        return (
          <Box key={command.name}>
            <Text color={isSelected ? umbraTheme.accent : umbraTheme.muted}>
              {isSelected ? '> ' : '  '}
            </Text>
            <Box width={24}>
              <Text color={isSelected ? umbraTheme.accent : umbraTheme.code} bold={isSelected}>
                {command.name}
              </Text>
            </Box>
            <Text color={isSelected ? umbraTheme.text : umbraTheme.muted}>{command.summary}</Text>
          </Box>
        );
      })}
    </Box>
  );
}

function HighlightedPath({
  path,
  suffix,
  matchIndices,
  baseColor,
  highlightColor,
}: {
  path: string;
  suffix: string;
  matchIndices?: number[] | undefined;
  baseColor: string;
  highlightColor: string;
}): React.ReactElement {
  const fullText = `${path}${suffix}`;
  if (!matchIndices || matchIndices.length === 0) {
    return <Text color={baseColor}>{fullText}</Text>;
  }

  const indexSet = new Set(matchIndices);
  type Segment = { text: string; match: boolean };
  const segments: Segment[] = [];
  let currentText = '';
  let currentMatch: boolean | null = null;

  for (let i = 0; i < path.length; i++) {
    const isMatch = indexSet.has(i);
    if (isMatch !== currentMatch) {
      if (currentText) segments.push({ text: currentText, match: currentMatch ?? false });
      currentText = path[i] ?? '';
      currentMatch = isMatch;
    } else {
      currentText += path[i];
    }
  }
  if (currentText) segments.push({ text: currentText, match: currentMatch ?? false });
  if (suffix) segments.push({ text: suffix, match: false });

  return (
    <>
      {segments.map((seg, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: stable index for static segments
        <Text key={i} color={seg.match ? highlightColor : baseColor} bold={seg.match}>
          {seg.text}
        </Text>
      ))}
    </>
  );
}

export function InkReferenceOverlay(props: {
  items: ProjectReferenceItem[];
  selectedIndex: number;
  statusText?: string;
}) {
  if (props.items.length === 0 && !props.statusText) {
    return null;
  }

  return (
    <Box
      marginTop={1}
      flexDirection="column"
      paddingX={1}
      borderStyle="single"
      borderColor={umbraTheme.frameDim}
    >
      {props.statusText ? (
        <Text color={umbraTheme.muted} dimColor>
          {props.statusText}
        </Text>
      ) : null}
      {props.items.map((item, index) => {
        const isSelected = index === props.selectedIndex;
        const suffix = item.kind === 'directory' ? '/' : '';
        return (
          <Box key={`${item.kind}:${item.path}`}>
            <Text color={isSelected ? umbraTheme.accent : umbraTheme.muted}>
              {isSelected ? '> ' : '  '}
            </Text>
            <Text color={isSelected ? umbraTheme.muted : umbraTheme.frameDim} dimColor>
              {item.kind === 'directory' ? 'dir  ' : 'file '}
            </Text>
            <HighlightedPath
              path={item.path}
              suffix={suffix}
              matchIndices={item.matchIndices}
              baseColor={isSelected ? umbraTheme.accent : umbraTheme.code}
              highlightColor={isSelected ? umbraTheme.accentSoft : umbraTheme.accent}
            />
          </Box>
        );
      })}
    </Box>
  );
}

export function InkDoctorCard({ report }: { report: DoctorReport }) {
  return (
    <Box flexDirection="column" paddingX={1} borderStyle="single" borderColor={umbraTheme.frameDim}>
      <Text bold color={umbraTheme.accent}>
        {'Umbra Doctor'}
      </Text>
      {report.items.map((item) => (
        <Box key={item.name}>
          <Text color={statusColor(item.status)}>
            {`${statusGlyph(item.status)} ${item.status.toUpperCase().padEnd(5, ' ')}`}
          </Text>
          <Text color={umbraTheme.text}>
            {item.name} <Text color={umbraTheme.muted}>{item.detail}</Text>
          </Text>
        </Box>
      ))}
      {report.appliedFixes.length > 0 ? (
        <Box marginTop={1} flexDirection="column">
          <Text color={umbraTheme.accentSoft}>applied fixes</Text>
          {report.appliedFixes.map((fix) => (
            <Text key={fix} color={umbraTheme.text}>
              {'  + '}
              {fix}
            </Text>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}

function statusGlyph(status: DoctorReport['items'][number]['status']): string {
  if (status === 'pass' || status === 'fixed') return '+';
  if (status === 'warn') return '!';
  return 'x';
}

function statusColor(status: DoctorReport['items'][number]['status']) {
  if (status === 'pass' || status === 'fixed') {
    return umbraTheme.success;
  }

  if (status === 'warn') {
    return umbraTheme.warning;
  }

  return umbraTheme.danger;
}
