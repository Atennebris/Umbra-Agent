import { type Tokens, marked } from 'marked';
import { describe, expect, it } from 'vitest';

describe('Markdown parsing for §8.13 parity', () => {
  const gfmOptions = { gfm: true };

  it('parses GFM tables correctly', () => {
    const markdown = '| Header 1 | Header 2 |\n|----------|----------|\n| Cell 1 | Cell 2 |';
    const tokens = marked.lexer(markdown, gfmOptions);
    const tableToken = tokens.find((t) => t.type === 'table');

    expect(tableToken).toBeDefined();
    if (tableToken?.type === 'table') {
      expect(tableToken.header[0]?.text).toBe('Header 1');
      expect(tableToken.rows[0]?.[0]?.text).toBe('Cell 1');
    }
  });

  it('handles unclosed fenced code blocks for streaming (partial input)', () => {
    const full = '```typescript\nconst x = 1;\n```';
    const partial = '```typescript\nconst x = 1;';

    const tokensFull = marked.lexer(full);
    const tokensPartial = marked.lexer(partial);

    const codeFull = tokensFull.find((t) => t.type === 'code');
    const codePartial = tokensPartial.find((t) => t.type === 'code');

    expect(codeFull?.type).toBe('code');
    expect(codePartial?.type).toBe('code');

    if (codeFull?.type === 'code' && codePartial?.type === 'code') {
      expect(codeFull.lang).toBe('typescript');
      expect(codePartial.lang).toBe('typescript');
      expect(codePartial.text).toBe('const x = 1;');
    }
  });

  it('verifies streaming consistency: chunks vs full', () => {
    const text = '# Title\n\nSome text with **bold**.\n\n```js\nconsole.log(1);\n```';
    const fullTokens = marked.lexer(text);

    // Simulate streaming by taking prefixes
    const chunks = [
      '# Tit',
      '# Title\n\nSome tex',
      '# Title\n\nSome text with **bold**.\n\n',
      '# Title\n\nSome text with **bold**.\n\n```js\ncon',
      text,
    ];

    const streamedTokens = chunks.map((c) => marked.lexer(c));

    // Last chunk should match full text tokens structure
    const lastStreamed = streamedTokens[streamedTokens.length - 1];
    expect(lastStreamed?.length).toBe(fullTokens.length);
    expect(lastStreamed?.[0]?.type).toBe('heading');
    expect(lastStreamed?.[lastStreamed.length - 1]?.type).toBe('code');
  });

  it('handles negative cases (empty, whitespace, broken syntax)', () => {
    // marked.lexer('') returns a TokensList which has a 'links' property
    const emptyResult = marked.lexer('');
    expect(emptyResult).toHaveLength(0);

    expect(marked.lexer('   ')).toHaveLength(1); // Usually a space/text token

    // Heading without space: #Title should NOT be a heading in standard markdown
    const noSpaceHeading = '#Title';
    const tokensHeading = marked.lexer(noSpaceHeading);
    expect(tokensHeading[0]?.type).toBe('paragraph');

    // Extremely broken table (missing separator line entirely)
    const brokenTable = '| Header | \n | Cell |';
    const tokensTable = marked.lexer(brokenTable, gfmOptions);
    expect(tokensTable.some((t) => t.type === 'table')).toBe(false);
  });

  it('parses nested lists correctly', () => {
    const markdown = '- Item 1\n  - Subitem 1.1\n- Item 2';
    const tokens = marked.lexer(markdown);
    const listToken = tokens.find((t) => t.type === 'list');

    expect(listToken).toBeDefined();
    if (listToken?.type === 'list') {
      const firstItem = listToken.items[0];
      expect(firstItem?.tokens?.some((t) => t.type === 'list')).toBe(true);
    }
  });

  it('parses mixed content with JSON blocks', () => {
    const markdown = 'Here is the plan:\n\n```json\n{"step": 1}\n```\n\nAnd some text.';
    const tokens = marked.lexer(markdown);
    expect(tokens.map((t) => t.type)).toContain('code');
    const jsonToken = tokens.find((t): t is Tokens.Code => t.type === 'code' && t.lang === 'json');
    expect(jsonToken).toBeDefined();
  });
});
