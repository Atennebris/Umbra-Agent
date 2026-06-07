/**
 * Umbra permission subsystem.
 *
 * Rules → mode-aware evaluation → interactive CLI prompt (Yes / No / Always) → decision log.
 * Borrowed from Codex security-loop and Claude Code permission hook patterns, adapted for Umbra.
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { writeDebugEvent } from '../debug/runtime-debug.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PermissionOutcome = 'allow' | 'deny' | 'allow_always';

export type PermissionMode =
  | 'chat-readonly' // no destructive ops
  | 'agent-default' // interactive prompt for destructive ops
  | 'exec-full'; // auto-allow within sandbox

export type PermissionRule = {
  id: string;
  tool: string; // glob or exact tool name, e.g. "shell.exec" or "*"
  outcome: PermissionOutcome;
  createdAt: string;
  expiresAt: string | null; // ISO or null = permanent
};

export type PermissionDecision = {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  outcome: PermissionOutcome;
  mode: PermissionMode;
  ruleId: string | null;
  timestamp: string;
};

export type PermissionRequest = {
  tool: string;
  args: Record<string, unknown>;
  mode: PermissionMode;
  /** Summary shown to user in interactive prompt */
  summary?: string;
  /**
   * When provided and the user chooses "allow_always", the rule is saved to
   * <projectPath>/umbra.permissions.json (project-scoped) instead of the
   * global ~/.umbra/permissions.json.
   */
  projectPath?: string;
};

export type PermissionResult = {
  outcome: PermissionOutcome;
  ruleId: string | null;
  interactive: boolean;
};

// ---------------------------------------------------------------------------
// Workspace Trust
// ---------------------------------------------------------------------------

export type WorkspaceTrust = {
  trustedPaths: string[];
};

export class WorkspaceTrustManager {
  #trustedPaths: Set<string> = new Set();
  #configPath: string;

  constructor(umbraHome: string) {
    this.#configPath = path.join(umbraHome, 'trusted-paths.json');
    this.load();
  }

  isTrusted(targetPath: string): boolean {
    const normalizedTarget = path.normalize(targetPath).toLowerCase();
    for (const trusted of this.#trustedPaths) {
      const normalizedTrusted = path.normalize(trusted).toLowerCase();
      if (
        normalizedTarget === normalizedTrusted ||
        normalizedTarget.startsWith(normalizedTrusted + path.sep)
      ) {
        return true;
      }
    }
    return false;
  }

  addTrustedPath(targetPath: string): void {
    this.#trustedPaths.add(path.normalize(targetPath));
    this.save();
  }

  removeTrustedPath(targetPath: string): void {
    this.#trustedPaths.delete(path.normalize(targetPath));
    this.save();
  }

  listTrustedPaths(): string[] {
    return Array.from(this.#trustedPaths);
  }

  load(): void {
    try {
      if (fs.existsSync(this.#configPath)) {
        const content = fs.readFileSync(this.#configPath, 'utf8');
        const parsed = JSON.parse(content) as WorkspaceTrust;
        if (parsed && Array.isArray(parsed.trustedPaths)) {
          this.#trustedPaths = new Set(parsed.trustedPaths);
        }
      }
    } catch (err) {
      writeDebugEvent({
        component: 'permissions',
        level: 'warn',
        message: 'failed to load trusted paths',
        data: { error: String(err) },
      });
    }
  }

  save(): void {
    try {
      const dir = path.dirname(this.#configPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const data: WorkspaceTrust = { trustedPaths: Array.from(this.#trustedPaths) };
      fs.writeFileSync(this.#configPath, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
      writeDebugEvent({
        component: 'permissions',
        level: 'error',
        message: 'failed to save trusted paths',
        data: { error: String(err) },
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Destructive tool detection
// ---------------------------------------------------------------------------

const ALWAYS_DESTRUCTIVE: ReadonlySet<string> = new Set([
  'shell.exec',
  'fs.write',
  'fs.edit',
  'fs.cd',
  'git.status',
  'git.diff',
  'git.apply',
  'git.commit',
  'git.push',
  'git.pull',
  'web.search',
]);

export function isDestructiveTool(tool: string): boolean {
  return ALWAYS_DESTRUCTIVE.has(tool);
}

// ---------------------------------------------------------------------------
// PermissionManager
// ---------------------------------------------------------------------------

export class PermissionManager {
  #rules: PermissionRule[] = [];
  #log: PermissionDecision[] = [];
  #logPath: string | null = null;
  #configPath: string | null = null;
  #projectConfigPath: string | null = null;
  #trustManager: WorkspaceTrustManager;

  constructor(options: {
    logPath?: string;
    configPath?: string;
    projectPath?: string;
    trustManager: WorkspaceTrustManager;
  }) {
    this.#logPath = options.logPath ?? null;
    this.#configPath = options.configPath ?? null;
    this.#projectConfigPath = options.projectPath
      ? path.join(options.projectPath, 'umbra.permissions.json')
      : null;
    this.#trustManager = options.trustManager;
    this.loadRules();
  }

  get trustManager(): WorkspaceTrustManager {
    return this.#trustManager;
  }

  /** Add a permanent allow-always rule for a tool (e.g. after user chooses "Always"). */
  addRule(
    tool: string,
    outcome: PermissionOutcome,
    expiresAt: string | null = null,
  ): PermissionRule {
    const rule: PermissionRule = {
      id: randomUUID(),
      tool,
      outcome,
      createdAt: new Date().toISOString(),
      expiresAt,
    };
    this.#rules.push(rule);
    this.saveRules();
    writeDebugEvent({
      component: 'permissions',
      level: 'info',
      message: 'rule added',
      data: { tool, outcome, ruleId: rule.id },
    });
    return rule;
  }

  /**
   * Add a rule to a specific project's `umbra.permissions.json` file.
   * The rule is also kept in memory for the lifetime of this daemon instance.
   */
  addProjectRule(
    projectPath: string,
    tool: string,
    outcome: PermissionOutcome,
    expiresAt: string | null = null,
  ): PermissionRule {
    const rule: PermissionRule = {
      id: randomUUID(),
      tool,
      outcome,
      createdAt: new Date().toISOString(),
      expiresAt,
    };
    this.#rules.push(rule);

    const projectConfigPath = path.join(projectPath, 'umbra.permissions.json');
    try {
      let existingRules: PermissionRule[] = [];
      if (fs.existsSync(projectConfigPath)) {
        const content = fs.readFileSync(projectConfigPath, 'utf8');
        const parsed = JSON.parse(content);
        if (parsed && Array.isArray(parsed.rules)) existingRules = parsed.rules;
      }
      existingRules.push(rule);
      fs.writeFileSync(
        projectConfigPath,
        JSON.stringify({ rules: existingRules }, null, 2),
        'utf8',
      );
    } catch (err) {
      writeDebugEvent({
        component: 'permissions',
        level: 'error',
        message: `failed to save project rule to ${projectConfigPath}`,
        data: { error: String(err) },
      });
    }

    writeDebugEvent({
      component: 'permissions',
      level: 'info',
      message: 'project rule added',
      data: { tool, outcome, ruleId: rule.id, projectPath },
    });
    return rule;
  }

  /** Remove a rule by id. */
  removeRule(ruleId: string): boolean {
    const before = this.#rules.length;
    this.#rules = this.#rules.filter((r) => r.id !== ruleId);
    const changed = this.#rules.length < before;
    if (changed) this.saveRules();
    return changed;
  }

  loadRules(): void {
    const loadedRules: PermissionRule[] = [];
    for (const p of [this.#configPath, this.#projectConfigPath]) {
      if (!p) continue;
      try {
        if (fs.existsSync(p)) {
          const content = fs.readFileSync(p, 'utf8');
          const parsed = JSON.parse(content);
          if (parsed && Array.isArray(parsed.rules)) {
            loadedRules.push(...parsed.rules);
          }
        }
      } catch (err) {
        writeDebugEvent({
          component: 'permissions',
          level: 'warn',
          message: `failed to load rules from ${p}`,
          data: { error: String(err) },
        });
      }
    }
    if (loadedRules.length > 0) {
      this.#rules = loadedRules;
    }
  }

  saveRules(): void {
    if (!this.#configPath) return; // Currently we only save global rules programmatically
    try {
      const dir = path.dirname(this.#configPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.#configPath, JSON.stringify({ rules: this.#rules }, null, 2), 'utf8');
    } catch (err) {
      writeDebugEvent({
        component: 'permissions',
        level: 'error',
        message: `failed to save rules to ${this.#configPath}`,
        data: { error: String(err) },
      });
    }
  }

  listRules(): PermissionRule[] {
    return [...this.#rules];
  }

  listLog(limit = 100): PermissionDecision[] {
    return this.#log.slice(-limit);
  }

  /**
   * Evaluate a permission request.
   *
   * exec-full mode → always allow (sandbox).
   * chat-readonly mode → always deny destructive tools.
   * agent-default mode → check rules, then interactive prompt.
   *
   * Returns a PermissionResult. Caller must respect `outcome === 'deny'`.
   */
  async evaluate(
    request: PermissionRequest,
    promptFn?: (request: PermissionRequest) => Promise<PermissionOutcome>,
  ): Promise<PermissionResult> {
    const { tool, args, mode } = request;

    // Check workspace trust for fs.cd or other path-sensitive tools
    if (tool === 'fs.cd' && typeof args.path === 'string') {
      const targetPath = path.resolve(request.projectPath ?? '.', args.path);
      if (!this.#trustManager.isTrusted(targetPath)) {
        // Force interactive prompt for untrusted paths
        const fn = promptFn ?? defaultInteractivePrompt;
        const outcome = await fn({
          ...request,
          summary: `Switch to untrusted directory: ${targetPath}`,
        });

        const ruleId: string | null = null;
        if (outcome === 'allow_always') {
          this.#trustManager.addTrustedPath(targetPath);
        }

        const finalOutcome: PermissionOutcome = outcome === 'allow_always' ? 'allow' : outcome;
        return this.#record({ tool, args, outcome: finalOutcome, mode, ruleId, interactive: true });
      }
    }

    // exec-full: auto-allow everything
    if (mode === 'exec-full') {
      return this.#record({ tool, args, outcome: 'allow', mode, ruleId: null, interactive: false });
    }

    // chat-readonly: deny destructive tools
    if (mode === 'chat-readonly' && isDestructiveTool(tool)) {
      return this.#record({ tool, args, outcome: 'deny', mode, ruleId: null, interactive: false });
    }

    // Check rules (most recently added wins)
    for (const rule of [...this.#rules].reverse()) {
      if (!matchesRule(tool, rule)) continue;
      if (rule.expiresAt && new Date(rule.expiresAt) < new Date()) continue;

      const outcome = rule.outcome === 'allow_always' ? 'allow' : rule.outcome;
      return this.#record({ tool, args, outcome, mode, ruleId: rule.id, interactive: false });
    }

    // Non-destructive tool in agent mode → allow without prompt
    if (!isDestructiveTool(tool)) {
      return this.#record({ tool, args, outcome: 'allow', mode, ruleId: null, interactive: false });
    }

    // Interactive prompt
    const fn = promptFn ?? defaultInteractivePrompt;
    const outcome = await fn(request);

    let ruleId: string | null = null;
    if (outcome === 'allow_always') {
      if (request.projectPath) {
        const rule = this.addProjectRule(request.projectPath, tool, 'allow_always');
        ruleId = rule.id;
      } else {
        const rule = this.addRule(tool, 'allow_always');
        ruleId = rule.id;
      }
    }

    const finalOutcome: PermissionOutcome = outcome === 'allow_always' ? 'allow' : outcome;
    return this.#record({ tool, args, outcome: finalOutcome, mode, ruleId, interactive: true });
  }

  #record(input: {
    tool: string;
    args: Record<string, unknown>;
    outcome: PermissionOutcome;
    mode: PermissionMode;
    ruleId: string | null;
    interactive: boolean;
  }): PermissionResult {
    const decision: PermissionDecision = {
      id: randomUUID(),
      tool: input.tool,
      args: input.args,
      outcome: input.outcome,
      mode: input.mode,
      ruleId: input.ruleId,
      timestamp: new Date().toISOString(),
    };
    this.#log.push(decision);

    if (this.#logPath) {
      try {
        fs.appendFileSync(this.#logPath, `${JSON.stringify(decision)}\n`, 'utf8');
      } catch {
        // best-effort log write
      }
    }

    writeDebugEvent({
      component: 'permissions',
      level: decision.outcome === 'deny' ? 'warn' : 'info',
      message: 'permission evaluated',
      data: {
        tool: decision.tool,
        outcome: decision.outcome,
        mode: decision.mode,
        interactive: input.interactive,
      },
    });

    return {
      outcome: input.outcome,
      ruleId: input.ruleId,
      interactive: input.interactive,
    };
  }
}

// ---------------------------------------------------------------------------
// Default interactive CLI prompt (readline-based)
// ---------------------------------------------------------------------------

export async function defaultInteractivePrompt(
  request: PermissionRequest,
): Promise<PermissionOutcome> {
  // In non-interactive environments (e.g. tests, piped stdin) → deny by default
  if (!process.stdin.isTTY) {
    return 'deny';
  }

  const summary = request.summary ?? formatToolSummary(request.tool, request.args);
  process.stderr.write(
    `\n[umbra] Permission required\n  tool:    ${request.tool}\n  action:  ${summary}\n`,
  );
  process.stderr.write('  Allow? [y]es / [n]o / [a]lways: ');

  return new Promise<PermissionOutcome>((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });

    rl.once('line', (line) => {
      rl.close();
      const answer = line.trim().toLowerCase();

      if (answer === 'y' || answer === 'yes') {
        resolve('allow');
      } else if (answer === 'a' || answer === 'always') {
        resolve('allow_always');
      } else {
        resolve('deny');
      }
    });

    rl.once('close', () => {
      resolve('deny');
    });
  });
}

// ---------------------------------------------------------------------------
// Singleton for use throughout the daemon
// ---------------------------------------------------------------------------

let _manager: PermissionManager | null = null;

export function getPermissionManager(): PermissionManager {
  if (!_manager) {
    const home =
      process.env.UMBRA_HOME ??
      path.join(process.env.HOME ?? process.env.USERPROFILE ?? '', '.umbra');
    const trustManager = new WorkspaceTrustManager(home);
    _manager = new PermissionManager({
      logPath: buildPermissionsLogPath(home),
      configPath: path.join(home, 'permissions.json'),
      trustManager,
    });
  }
  return _manager;
}

export function setPermissionManagerForTests(manager: PermissionManager): void {
  _manager = manager;
}

export function resetPermissionManagerForTests(): void {
  _manager = null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function matchesRule(tool: string, rule: PermissionRule): boolean {
  if (rule.tool === '*') return true;
  if (rule.tool === tool) return true;

  // Glob-like: "shell.*" matches "shell.exec"
  if (rule.tool.endsWith('.*')) {
    const prefix = rule.tool.slice(0, -2);
    return tool.startsWith(`${prefix}.`);
  }

  return false;
}

function formatToolSummary(tool: string, args: Record<string, unknown>): string {
  if (tool === 'shell.exec') {
    const cmd = typeof args.command === 'string' ? args.command : JSON.stringify(args);
    return cmd.length > 120 ? `${cmd.slice(0, 120)}…` : cmd;
  }

  if (tool === 'fs.write' || tool === 'fs.edit') {
    return typeof args.path === 'string' ? `file: ${args.path}` : JSON.stringify(args);
  }

  if (tool === 'git.status') {
    return 'git status';
  }

  if (tool === 'git.diff') {
    return args.cached === true ? 'git diff --cached' : 'git diff';
  }

  if (tool === 'git.commit') {
    return typeof args.message === 'string' ? `commit: ${args.message}` : 'git commit';
  }

  if (tool === 'git.push') {
    const remote = typeof args.remote === 'string' ? args.remote : 'origin';
    const branch = typeof args.branch === 'string' ? args.branch : 'current branch';
    return `git push ${branch} → ${remote}`;
  }

  if (tool === 'git.pull') {
    const remote = typeof args.remote === 'string' ? args.remote : 'origin';
    return `git pull from ${remote}`;
  }

  if (tool === 'web.search') {
    return 'external web search';
  }

  return JSON.stringify(args).slice(0, 120);
}

export function resolvePermissionMode(toolPreset: string | null | undefined): PermissionMode {
  switch (toolPreset) {
    case 'chat-readonly':
      return 'chat-readonly';
    case 'exec-full':
      return 'exec-full';
    default:
      return 'agent-default';
  }
}

export function buildPermissionsLogPath(umbraHome: string): string {
  return path.join(umbraHome, 'debug', 'permissions.jsonl');
}
