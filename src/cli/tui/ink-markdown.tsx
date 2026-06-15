import { Box, Text } from 'ink';
import { marked } from 'marked';
import type { Tokens } from 'marked';
import React from 'react';
import terminalLink from 'terminal-link';
import { highlightCode } from '../../utils/syntax-highlight.js';
import { mixHexColor, umbraTheme } from './theme.js';

type InkMarkdownProps = {
  markdown: string;
};

type InlineInherited = {
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
  underline?: boolean;
  color?: string;
};

const LIST_BULLET = '-';
const HR_CHAR = '-';

function spreadInline(inh: InlineInherited): {
  bold?: true;
  italic?: true;
  strikethrough?: true;
  underline?: true;
} {
  return {
    ...(inh.bold ? { bold: true as const } : {}),
    ...(inh.italic ? { italic: true as const } : {}),
    ...(inh.strikethrough ? { strikethrough: true as const } : {}),
    ...(inh.underline ? { underline: true as const } : {}),
  };
}

export function InkMarkdown({ markdown }: InkMarkdownProps) {
  const tokens = marked.lexer(markdown, { gfm: true });

  return (
    <Box flexDirection="column">
      {tokens.map((token, index) => (
        <React.Fragment
          key={`block:${index}:${token.type}:${'raw' in token ? String(token.raw).slice(0, 24) : ''}`}
        >
          {renderToken(token, `b${index}`, index)}
        </React.Fragment>
      ))}
    </Box>
  );
}

function renderToken(token: Tokens.Generic, keyPath: string, index = 0) {
  switch (token.type) {
    case 'heading': {
      if (token.depth === 1) {
        return (
          <Box marginBottom={1} marginTop={index > 0 ? 1 : 0} flexDirection="column">
            <Text bold color={umbraTheme.accent}>
              {token.text.toUpperCase()}
            </Text>
            <Text color={umbraTheme.frameDim}>
              {'─'.repeat(Math.min(token.text.length + 4, 52))}
            </Text>
          </Box>
        );
      }
      if (token.depth === 2) {
        return (
          <Box marginBottom={1} marginTop={index > 0 ? 1 : 0}>
            <Text color={umbraTheme.frame}>{'-- '}</Text>
            <Text bold color={umbraTheme.accent}>
              {token.text}
            </Text>
          </Box>
        );
      }
      return (
        <Box marginBottom={1} marginTop={index > 0 ? 1 : 0}>
          <Text color={umbraTheme.muted}>{'- '}</Text>
          <Text bold color={umbraTheme.accentSoft}>
            {token.text}
          </Text>
        </Box>
      );
    }
    case 'paragraph':
      return (
        <Box marginBottom={1}>
          <Text>{renderInline(token.tokens ?? [], `${keyPath}/p`)}</Text>
        </Box>
      );
    case 'list':
      return (
        <Box flexDirection="column" marginBottom={1}>
          {token.items.map((item: Tokens.ListItem, itemIndex: number) => (
            <Box key={`${keyPath}/li:${itemIndex}:${createTokenKey(item)}`} flexDirection="column">
              <Text>
                <Text color={umbraTheme.accentSoft}>
                  {token.ordered ? `${itemIndex + 1}. ` : `${LIST_BULLET} `}
                </Text>
                {renderInline(item.tokens ?? [], `${keyPath}/li${itemIndex}`)}
              </Text>
              {item.tokens?.some((nestedToken) => nestedToken.type === 'list') && (
                <Box paddingLeft={2} flexDirection="column">
                  {item.tokens
                    .filter((nestedToken) => nestedToken.type === 'list')
                    .map((nestedToken, nestedIndex) => (
                      <React.Fragment
                        key={`${keyPath}/nested:${itemIndex}:${createTokenKey(nestedToken as Tokens.ListItem)}`}
                      >
                        {renderToken(
                          nestedToken as Tokens.Generic,
                          `${keyPath}/n:${itemIndex}:${nestedIndex}`,
                          itemIndex,
                        )}
                      </React.Fragment>
                    ))}
                </Box>
              )}
            </Box>
          ))}
        </Box>
      );
    case 'space':
      return null;
    case 'code': {
      const hlResult = highlightCode(token.text, token.lang ?? '');
      const diffAddBg = mixHexColor(umbraTheme.success, umbraTheme.assistantBackground, 0.25);
      const diffDelBg = mixHexColor(umbraTheme.danger, umbraTheme.assistantBackground, 0.25);
      return (
        <Box
          flexDirection="column"
          borderStyle="single"
          borderColor={umbraTheme.frameDim}
          paddingX={1}
          marginBottom={1}
          backgroundColor={umbraTheme.assistantBackground}
        >
          {token.lang ? (
            <Box marginBottom={0}>
              <Text color={umbraTheme.frame} bold>
                {hlResult.language || token.lang.toLowerCase()}
              </Text>
            </Box>
          ) : null}
          {hlResult.fallback ? (
            <Text color={umbraTheme.code}>{token.text}</Text>
          ) : (
            <Box flexDirection="column">
              {hlResult.lines.map((lineTokens, lineIdx) => {
                const lineBg = lineTokens.some((tok) => tok.type === 'diff-add')
                  ? diffAddBg
                  : lineTokens.some((tok) => tok.type === 'diff-del')
                    ? diffDelBg
                    : undefined;
                return (
                  // biome-ignore lint/suspicious/noArrayIndexKey: stable line order in code block
                  <Box key={`${keyPath}:hl:${lineIdx}`} width="100%" backgroundColor={lineBg}>
                    <Text>
                      {lineTokens.map((tok, tokIdx) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: stable token order within line
                        <Text key={tokIdx} color={tok.color}>
                          {tok.text}
                        </Text>
                      ))}
                    </Text>
                  </Box>
                );
              })}
            </Box>
          )}
        </Box>
      );
    }
    case 'blockquote':
      return (
        <Box flexDirection="row" marginBottom={1} marginTop={1}>
          <Text color={umbraTheme.accentSoft}>{'│ '}</Text>
          <Text italic color={umbraTheme.accent}>
            {renderInline(token.tokens ?? [], `${keyPath}/quote`, {
              italic: true,
              color: umbraTheme.accent,
            })}
          </Text>
        </Box>
      );
    case 'hr':
      return (
        <Box marginBottom={1} marginTop={1}>
          <Text color={umbraTheme.frameDim}>{HR_CHAR.repeat(48)}</Text>
        </Box>
      );
    case 'table':
      return renderTable(token as Tokens.Table);
    default:
      return null;
  }
}

function wrapCellText(text: string, maxWidth: number): string[] {
  if (text.length <= maxWidth) return [text];
  const words = text.split(' ');
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (word.length > maxWidth) {
      if (current) {
        lines.push(current);
        current = '';
      }
      for (let i = 0; i < word.length; i += maxWidth) lines.push(word.slice(i, i + maxWidth));
    } else if (current && `${current} ${word}`.length > maxWidth) {
      lines.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [text];
}

function renderTable(token: Tokens.Table) {
  const columns = token.header.map((headerCell, columnIndex) => {
    let maxWidth = headerCell.text.length;

    for (const row of token.rows) {
      const cell = row[columnIndex];
      if (cell) {
        maxWidth = Math.max(maxWidth, cell.text.length);
      }
    }

    return {
      cell: headerCell,
      key: createTableColumnKey(headerCell),
      width: Math.min(maxWidth, 42),
    };
  });

  return (
    <Box
      flexDirection="column"
      marginBottom={1}
      borderStyle="single"
      borderColor={umbraTheme.frame}
      paddingX={1}
    >
      <Box marginBottom={0}>
        {columns.map((column) => (
          <Box key={`${column.key}:header`} width={column.width + 2} flexDirection="column">
            {wrapCellText(column.cell.text, column.width).map((line, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: stable header lines
              <Text key={i} bold color={umbraTheme.accent}>
                {line.padEnd(column.width)}
              </Text>
            ))}
          </Box>
        ))}
      </Box>
      <Box marginBottom={0}>
        {columns.map((column) => (
          <Box key={`${column.key}:separator`} width={column.width + 2}>
            <Text color={umbraTheme.frameDim}>{'─'.repeat(column.width)}</Text>
          </Box>
        ))}
      </Box>
      {token.rows.map((row) => {
        const rowKey = createTableRowKey(row);

        return (
          <Box key={rowKey} marginBottom={0}>
            {columns.map((column, columnIndex) => {
              const cell = row[columnIndex];
              const text = cell?.text ?? '';
              const lines = wrapCellText(text, column.width);

              return (
                <Box
                  key={`${rowKey}:${column.key}`}
                  width={column.width + 2}
                  flexDirection="column"
                >
                  {lines.map((line, lineIdx) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: stable wrapped lines
                    <Text key={lineIdx} color={umbraTheme.text}>
                      {line.padEnd(column.width)}
                    </Text>
                  ))}
                </Box>
              );
            })}
          </Box>
        );
      })}
    </Box>
  );
}

function renderInline(
  tokens: Tokens.Generic[],
  keyPath: string,
  inherited: InlineInherited = {},
): React.ReactElement[] {
  return tokens.map((token, index) => {
    const slotKey = `${keyPath}:${index}`;

    switch (token.type) {
      case 'text':
        // If this text token has nested tokens (inline formatting), recurse into them
        if (token.tokens && (token.tokens as Tokens.Generic[]).length > 0) {
          return (
            <Text
              key={slotKey}
              {...spreadInline(inherited)}
              color={inherited.color ?? umbraTheme.text}
            >
              {renderInline(token.tokens as Tokens.Generic[], `${slotKey}/text`, inherited)}
            </Text>
          );
        }
        return (
          <Text
            key={slotKey}
            {...spreadInline(inherited)}
            color={inherited.color ?? umbraTheme.text}
          >
            {token.text}
          </Text>
        );
      case 'paragraph':
        // Paragraph tokens can appear inside loose list items — render their children
        return (
          <Text
            key={slotKey}
            {...spreadInline(inherited)}
            color={inherited.color ?? umbraTheme.text}
          >
            {renderInline(
              (token.tokens as Tokens.Generic[] | undefined) ?? [],
              `${slotKey}/para`,
              inherited,
            )}
          </Text>
        );
      case 'codespan':
        return (
          <Text
            key={slotKey}
            {...spreadInline(inherited)}
            color={umbraTheme.code}
            backgroundColor={umbraTheme.assistantBackground}
          >
            {` ${token.text} `}
          </Text>
        );
      case 'strong':
        return (
          <Text key={slotKey} bold color={inherited.color ?? umbraTheme.accent}>
            {renderInline(token.tokens ?? [], `${slotKey}/strong`, {
              ...inherited,
              bold: true,
              color: inherited.color ?? umbraTheme.accent,
            })}
          </Text>
        );
      case 'em':
        return (
          <Text key={slotKey} italic color={inherited.color ?? umbraTheme.warning}>
            {renderInline(token.tokens ?? [], `${slotKey}/em`, {
              ...inherited,
              italic: true,
              color: inherited.color ?? umbraTheme.warning,
            })}
          </Text>
        );
      case 'del':
        return (
          <Text key={slotKey} strikethrough color={inherited.color ?? umbraTheme.muted}>
            {renderInline(token.tokens ?? [], `${slotKey}/del`, {
              ...inherited,
              strikethrough: true,
              color: inherited.color ?? umbraTheme.muted,
            })}
          </Text>
        );
      case 'link': {
        const text = token.text;
        const href = token.href;
        const linked = terminalLink(text, href, { fallback: (label, url) => `${label} (${url})` });
        return (
          <Text
            key={slotKey}
            {...spreadInline(inherited)}
            color={inherited.color ?? umbraTheme.accentSoft}
            underline
          >
            {linked}
          </Text>
        );
      }
      case 'br':
        return (
          <Text
            key={slotKey}
            {...spreadInline(inherited)}
            color={inherited.color ?? umbraTheme.text}
          >
            {' '}
          </Text>
        );
      default:
        return (
          <Text
            key={slotKey}
            {...spreadInline(inherited)}
            color={inherited.color ?? umbraTheme.muted}
          >
            {'raw' in token ? String(token.raw) : ''}
          </Text>
        );
    }
  });
}

function createTokenKey(token: Tokens.Generic | Tokens.ListItem) {
  const raw = 'raw' in token ? String(token.raw) : '';
  return `${token.type}:${raw.slice(0, 20)}:${'text' in token ? String(token.text).slice(0, 20) : ''}`;
}

function createTableColumnKey(cell: Tokens.TableCell) {
  return `column:${cell.text}`;
}

function createTableRowKey(row: Tokens.TableCell[]) {
  return `row:${row.map((cell) => cell.text).join('|')}`;
}
