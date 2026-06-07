const ansi = {
  reset: '\u001B[0m',
  bold: '\u001B[1m',
  dim: '\u001B[2m',
  cyan: '\u001B[36m',
  yellow: '\u001B[33m',
};

export function renderMarkdownToAnsi(markdown: string): string {
  return markdown
    .split(/\r?\n/)
    .map((line) => transformInlineMarkdown(transformBlockMarkdown(line)))
    .join('\n');
}

function transformBlockMarkdown(line: string): string {
  if (line.startsWith('# ')) {
    return `${ansi.bold}${ansi.cyan}${line.slice(2)}${ansi.reset}`;
  }

  if (line.startsWith('## ')) {
    return `${ansi.bold}${ansi.yellow}${line.slice(3)}${ansi.reset}`;
  }

  if (line.startsWith('---') || line.startsWith('===')) {
    return `${ansi.dim}${'─'.repeat(40)}${ansi.reset}`;
  }

  if (line.startsWith('- ')) {
    return `${ansi.cyan}-${ansi.reset} ${line.slice(2)}`;
  }

  if (/^\d+\.\s/.test(line)) {
    return `${ansi.yellow}${line.replace(/^(\d+\.)\s/, '$1 ')}${ansi.reset}`;
  }

  if (line.startsWith('> ')) {
    return `${ansi.dim}| ${line.slice(2)}${ansi.reset}`;
  }

  return line;
}

function transformInlineMarkdown(line: string): string {
  return line
    .replace(/`([^`]+)`/g, `${ansi.yellow}$1${ansi.reset}`)
    .replace(/\*\*([^*]+)\*\*/g, `${ansi.bold}$1${ansi.reset}`)
    .replace(/\*([^*]+)\*/g, `${ansi.dim}$1${ansi.reset}`)
    .replace(
      /\[([^\]]+)\]\(([^)]+)\)/g,
      `${ansi.cyan}$1${ansi.reset} (${ansi.dim}$2${ansi.reset})`,
    );
}
