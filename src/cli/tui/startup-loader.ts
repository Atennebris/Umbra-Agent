const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const TICK_MS = 80;

const ESC = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  brightCyan: '\x1b[96m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  gray: '\x1b[90m',
  clearLine: '\x1b[2K\r',
  hide: '\x1b[?25l',
  show: '\x1b[?25h',
  up: (n: number) => (n > 0 ? `\x1b[${n}A` : ''),
};

type StepStatus = 'pending' | 'active' | 'done' | 'error';

export interface StepDef {
  id: string;
  name: string;
  runningText: string;
  doneText: string;
  errorText?: string;
}

interface Step extends StepDef {
  status: StepStatus;
  t0: number | null;
  t1: number | null;
}

export class StartupLoader {
  private readonly steps: Step[];
  private frame = 0;
  private iv: ReturnType<typeof setInterval> | null = null;
  private drawn = 0;
  private initial = true;

  constructor(defs: StepDef[]) {
    this.steps = defs.map((d) => ({ ...d, status: 'pending', t0: null, t1: null }));
  }

  start(): void {
    process.stdout.write(ESC.hide);
    this.flush();
    this.iv = setInterval(() => {
      this.frame++;
      this.flush();
    }, TICK_MS);
    this.iv.unref();
  }

  begin(id: string): void {
    const s = this.find(id);
    if (!s) return;
    s.status = 'active';
    s.t0 = Date.now();
    this.flush();
  }

  complete(id: string, ok = true): void {
    const s = this.find(id);
    if (!s) return;
    s.status = ok ? 'done' : 'error';
    s.t1 = Date.now();
    this.flush();
  }

  dismiss(): void {
    if (this.iv) {
      clearInterval(this.iv);
      this.iv = null;
    }
    this.clear();
    process.stdout.write(ESC.show);
  }

  private find(id: string): Step | undefined {
    return this.steps.find((s) => s.id === id);
  }

  private clear(): void {
    if (this.drawn === 0) return;
    process.stdout.write(ESC.up(this.drawn));
    for (let i = 0; i < this.drawn; i++) {
      process.stdout.write(`${ESC.clearLine}\n`);
    }
    process.stdout.write(ESC.up(this.drawn));
    this.drawn = 0;
  }

  private flush(): void {
    const lines = this.buildLines();
    if (!this.initial) process.stdout.write(ESC.up(this.drawn));
    for (const ln of lines) process.stdout.write(`${ESC.clearLine}${ln}\n`);
    this.drawn = lines.length;
    this.initial = false;
  }

  private buildLines(): string[] {
    const out: string[] = [];
    out.push('');
    out.push(
      `  ${ESC.brightCyan}◈${ESC.reset}  ${ESC.bold}UMBRA${ESC.reset}  ${ESC.gray}shadow console${ESC.reset}`,
    );
    out.push('');
    for (const s of this.steps) out.push(this.row(s));
    out.push('');
    return out;
  }

  private row(s: Step): string {
    const name = s.name.padEnd(13);

    switch (s.status) {
      case 'pending':
        return `  ${ESC.gray}·  ${name}${ESC.dim}waiting${ESC.reset}`;
      case 'active': {
        const sp = FRAMES[this.frame % FRAMES.length];
        return `  ${ESC.cyan}${sp}${ESC.reset}  ${name}${s.runningText}`;
      }
      case 'done': {
        const t = fmtElapsed(s);
        return `  ${ESC.green}✔${ESC.reset}  ${name}${ESC.dim}${s.doneText}${ESC.reset}${t}`;
      }
      default: {
        const t = fmtElapsed(s);
        return `  ${ESC.red}✖${ESC.reset}  ${name}${ESC.red}${s.errorText ?? 'failed'}${ESC.reset}${t}`;
      }
    }
  }
}

function fmtElapsed(s: Step): string {
  if (!s.t0 || !s.t1) return '';
  return `  ${ESC.gray}${((s.t1 - s.t0) / 1000).toFixed(1)}s${ESC.reset}`;
}
