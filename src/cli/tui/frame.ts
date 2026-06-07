import type { DoctorReport } from '../doctor.js';

const ansi = {
  reset: '\u001B[0m',
  dim: '\u001B[2m',
  bold: '\u001B[1m',
  cyan: '\u001B[36m',
  brightCyan: '\u001B[96m',
  blue: '\u001B[34m',
  green: '\u001B[32m',
  yellow: '\u001B[33m',
  red: '\u001B[31m',
  gray: '\u001B[90m',
};

export function renderUmbraSplash(): string {
  return [
    `${ansi.brightCyan}+----------------------------------------------------------------+${ansi.reset}`,
    `${ansi.brightCyan}|${ansi.reset} ${ansi.bold}UMBRA${ansi.reset} ${ansi.gray}shadow console${ansi.reset}                                      ${ansi.brightCyan}|${ansi.reset}`,
    `${ansi.brightCyan}|${ansi.reset} ${ansi.dim}Type /status, /init, or a task prompt. Paste file paths to attach.${ansi.reset} ${ansi.brightCyan}|${ansi.reset}`,
    `${ansi.brightCyan}+----------------------------------------------------------------+${ansi.reset}`,
  ].join('\n');
}

export function renderKeyValueCard(title: string, entries: Array<[string, string]>): string {
  const lines = entries.map(([key, value]) => {
    const paddedKey = `${key}:`.padEnd(13, ' ');
    return `${ansi.brightCyan}|${ansi.reset} ${ansi.cyan}${paddedKey}${ansi.reset} ${value}`;
  });

  return [
    `${ansi.brightCyan}+-- ${ansi.bold}${title}${ansi.reset} ${ansi.brightCyan}${'-'.repeat(Math.max(2, 54 - title.length))}+${ansi.reset}`,
    ...lines,
    `${ansi.brightCyan}+${'-'.repeat(58)}+${ansi.reset}`,
  ].join('\n');
}

export function renderDoctorReport(report: DoctorReport): string {
  const lines = report.items.map((item) => {
    return `${ansi.brightCyan}|${ansi.reset} ${formatStatus(item.status)} ${item.name} ${ansi.gray}- ${item.detail}${ansi.reset}`;
  });

  const fixes =
    report.appliedFixes.length === 0
      ? `${ansi.brightCyan}|${ansi.reset} ${ansi.dim}No automatic fixes were applied.${ansi.reset}`
      : report.appliedFixes.map(
          (fix) => `${ansi.brightCyan}|${ansi.reset} ${ansi.cyan}fix${ansi.reset} ${fix}`,
        );

  return [
    `${ansi.brightCyan}+-- ${ansi.bold}Umbra Doctor${ansi.reset} ${ansi.brightCyan}${'-'.repeat(45)}+${ansi.reset}`,
    ...lines,
    `${ansi.brightCyan}+${'-'.repeat(58)}+${ansi.reset}`,
    ...(Array.isArray(fixes) ? fixes : [fixes]),
    `${ansi.brightCyan}+${'-'.repeat(58)}+${ansi.reset}`,
  ].join('\n');
}

function formatStatus(status: DoctorReport['items'][number]['status']): string {
  if (status === 'pass') {
    return `${ansi.green}PASS${ansi.reset}`;
  }

  if (status === 'fixed') {
    return `${ansi.blue}FIXD${ansi.reset}`;
  }

  if (status === 'warn') {
    return `${ansi.yellow}WARN${ansi.reset}`;
  }

  return `${ansi.red}FAIL${ansi.reset}`;
}
