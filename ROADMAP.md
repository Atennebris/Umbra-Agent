# Umbra — Project Roadmap

---

## Phase 0: Foundation ✅

> Daemon runs stably in the background, CLI responds instantly to commands without delays.

- [X] Project initialization (TypeScript, Biome, Vitest, pnpm)
- [X] Daemon (PM2) with hidden local HTTP server (`127.0.0.1:8080`)
- [X] CLI client communicating with daemon via `POST` requests
- [X] Lazy-loading architecture — heavy modules load only on demand

---

## Phase 1: CLI, TUI & Diagnostics ✅

> Professional UX from the first launch: a ready-made project rules template in one command, and a built-in health monitor keeping the system in check.

- [X] Core CLI commands: `umbra start`, `umbra stop`, `umbra status`, `umbra task add`
- [X] `umbra init` — generates `AGENTS.md` template and base `check.sh` in the current directory
- [X] Terminal UI with Umbra's original dark/shadow theme
- [X] Markdown rendering with syntax highlighting and model response streaming
- [X] `/clear` command — clears transcript and starts a new session
- [X] Drag-and-drop file path parsing and local image to Base64 conversion (Vision support)
- [X] `umbra doctor` — checks filesystem access, ports, SQLite, and daemon state
- [X] `umbra debug` — live monitor for daemon/CLI/TUI/provider events with log output

---

## Phase 2: Memory Layer & Vector Database ✅

> Isolated long-term agent experience storage. No service files polluting the user's project directories.

- [X] Service filesystem auto-init (`~/.umbra/` layout, project-scoped isolation)
- [X] Global SQLite database with vector search (`sqlite-vec`)
- [X] Local text embeddings via Transformers.js (auto-downloaded `all-MiniLM-L6-v2`, ~90MB)
- [X] Typed JSONL session events with stable schema (`id`, `sessionId`, `projectPath`, `timestamp`, `type`, `payload`)
- [X] `AGENTS.md` rules parsing and `MEMORY.md` read/write per project
- [X] Full thread lifecycle: `thread_start`, `thread_list`, `thread_resume`, `thread_fork`, `thread_archive`, `thread_unarchive`
- [X] TUI session picker with `/sessions`, `/resume`, `/sessions fork` slash commands
- [X] `/clear` bound to a new thread — previous thread preserved in history
- [X] Explicit memory controls: `use_memories` / `generate_memories` flags per runtime/project/thread
- [X] Memory provenance and citations — source metadata visible in responses and debug trace
- [X] Safe memory reset without deleting session logs
- [X] Session compaction pipeline and import/export support

---

## Phase 3: Context Engine ✅

> Eliminates hallucinations on large projects and drastically reduces token usage.

- [X] Tree-sitter AST integration (TypeScript, JavaScript, Python, Go, GML, and more)
- [X] Repo Map generator — project file structure and symbol relationships
- [X] Code compression — sends only function/class signatures, not full file bodies
- [X] Auto token counting for outgoing prompts
- [X] `/compact` command — forces summarization of accumulated context
- [X] Universal text fallback for unknown file types — bounded context packet with top symbols, snippets, and token estimate

### Language Coverage

| Language | Extensions | Parser |
|----------|------------|--------|
| JavaScript | `.js`, `.jsx`, `.cjs`, `.mjs` | full AST |
| TypeScript | `.ts` | full AST |
| TSX | `.tsx` | full AST |
| Python | `.py` | full AST |
| Go | `.go` | full AST |
| GML (GameMaker) | `.gml` | full AST |
| Shell / Bash | `.sh`, `.bash`, `.zsh` | full AST |
| Rust | `.rs` | full AST |
| Java | `.java` | full AST |
| C# | `.cs` | full AST |
| PHP | `.php` | full AST |
| Ruby | `.rb` | full AST |
| CSS | `.css` | full AST |
| PowerShell | `.ps1`, `.psm1` | full AST |
| INI / Config | `.ini`, `.cfg` | full AST |
| JSON | `.json` | partial |
| YAML | `.yml`, `.yaml` | partial |
| Markdown | `.md`, `.mdx` | partial |
| SQL | `.sql` | partial |
| HTML | `.html`, `.htm` | partial |

### Extended Language Coverage

> Ongoing expansion of the Context Engine. Goal: full AST or structured parser where viable; honest `partial` where not. This list grows without rewriting the core roadmap.

| Language | Extensions | Parser |
|----------|------------|--------|
| C | `.c`, `.h` | full AST |
| C++ | `.cpp`, `.cc`, `.cxx`, `.hpp`, `.hh`, `.hxx` | full AST |
| GML 2.3+ OOP (GameMaker) | `.gml` | full AST (constructors, macros, enums, globalvar) |
| C# (strong) | `.cs` | full AST (class, interface, record, property, constructor, destructor, event) |
| Kotlin | `.kt`, `.kts` | partial |
| Swift | `.swift` | partial |
| Dart / Flutter | `.dart` | partial |
| Scala | `.scala`, `.sc` | partial |
| Lua | `.lua` | partial |
| Perl | `.pl`, `.pm` | partial |
| R | `.r`, `.R` | partial |
| Elixir | `.ex`, `.exs` | partial |
| Erlang | `.erl`, `.hrl` | partial |
| Haskell | `.hs`, `.lhs` | partial |
| Clojure | `.clj`, `.cljs`, `.cljc` | partial |
| Vue | `.vue` | partial (SFC) |
| Svelte | `.svelte` | partial (SFC) |
| Astro | `.astro` | partial (SFC) |
| XML | `.xml` | partial |
| TOML | `.toml` | partial |
| Dockerfile | `Dockerfile`, `.dockerfile` | partial |
| Makefile | `Makefile`, `.mk` | partial |
| Terraform / HCL | `.tf`, `.tfvars`, `.hcl` | partial |
| GraphQL | `.graphql`, `.gql` | partial |
| Protocol Buffers | `.proto` | partial |
| CMake | `CMakeLists.txt`, `.cmake` | partial |
| Gradle | `.gradle`, `.gradle.kts` | partial |
| Env files | `.env`, `.env.*` | partial (values redacted) |
| Prisma | `.prisma` | partial |
| Solidity | `.sol` | partial |
| Zig | `.zig` | partial |
| GDScript (Godot) | `.gd` | partial |
| MATLAB / Octave | `.m` | partial |
| WebAssembly Text | `.wat`, `.wast` | partial |
| Assembly x86/ARM | `.asm`, `.s`, `.S`, `.nasm` | partial |
| Nix | `.nix` | partial |
| GitHub Actions YAML | `.yml` / `.yaml` with `on:` + `jobs:` | partial (domain-aware) |
| Log files | `.log` | partial (ERROR/WARN heuristic) |
| Jupyter Notebook | `.ipynb` | partial |
| PDF | `.pdf` | partial (text extraction) |
| DOCX | `.docx` | partial (text extraction) |
| Lockfiles | `yarn.lock`, `Cargo.lock`, `Gemfile.lock`, `composer.lock` | partial (version extraction) |

- [X] New languages are added only when needed by the Umbra stack
- [X] Each new language is either brought to full support or explicitly marked `partial` / `unsupported`
- [X] Coverage matrix and tests updated with every new language addition

---

## Phase 4: Provider Layer (Zero Hardcoding) ✅

> Always up-to-date model support without hardcoding — extensible provider configuration for any API-compatible service.

- [X] Dynamic model registry with live capabilities fetch (tool/vision/context flags — no hardcoded values)
- [X] OpenAI client with structured output support (Zod)
- [X] Anthropic client
- [X] Local network client (Ollama, LM Studio)
- [X] `ProviderTypeSpec` registry — `value`, `label`, `default_url`, `needs_key`, `cloud`, `aliases`
- [X] Provider profiles with full CRUD: list, create, update, delete, test, capabilities
- [X] Multiple saved connections per provider type with per-profile model selection and global fallback
- [X] Enable/disable provider profiles without deletion — explicit `connected` / `available` / `unavailable` status
- [X] Graceful degradation for broken profiles — auto-fallback to valid connection on startup
- [X] Optional/module-gated providers — module absent means provider unavailable, no crash
- [X] CLI/TUI surface for managing provider profiles and switching active model

---

## Phase 5: Tools Layer ✅

> Safety and efficiency — tools are isolated, and the router rejects any malformed or dangerous arguments before execution.

- [X] Zod schemas for strict JSON validation of all AI tool calls
- [X] Tool Runner — central call router
- [X] `ToolSpec` registry with risk class, read-only flag, concurrency-safe flag, and permission policy
- [X] Tool presets: `chat-readonly`, `agent-default`, `exec-full`
- [X] Machine-readable result schema on every tool (not free text)
- [X] `fs.list`, `fs.read`, `fs.write`, `fs.edit` (Unified Diff patch application)
- [X] `shell.exec` — terminal command execution
- [X] `search.rg` — ripgrep wrapper for local repository text search with grouped output (file buckets, snippets, match counts, truncation metadata)
- [X] `search.files` — ignore-aware file listing with Node.js fallback, hidden/dist/node_modules policy
- [X] Fuzzy file search over project paths
- [X] External binary health/status layer — availability check, version, path source, missing reasons, custom path override
- [X] `git.status`, `git.diff`, `git.apply`, `git.commit`
- [X] Central permission hook before every tool call
- [X] Destructive vs non-destructive tool separation at contract level

---

## Phase 6: Orchestration & Autonomous Loop ✅

> The agent becomes truly autonomous — give it a task and it runs tests, catches bugs, and rewrites code on its own until done.

- [X] **Planning Mode** — AI reads AST and produces a JSON plan without executing any tools or editing code
- [X] **Agent Mode** — interactive working mode with tools resolved by policy and task intent
- [X] Each mode has its own execution contract: allowed tools, confirmation rules, edit/shell/git permissions, stop-guards
- [X] No mode inherits the full tool surface without filtering — no mode bleed
- [X] **`--exec` autonomous mode** — patch loop via `fs.edit` with auto-run of project-local `check.sh` / `check.ps1`
- [X] If `check.sh` / `check.ps1` is missing → stop with explicit reason (exec mode requires a check script)
- [X] On `Exit Code 1` → capture `stderr`, build new prompt with the error, auto-retry
- [X] On `Exit Code 0` → task complete: auto-commit and write to project `MEMORY.md`
- [X] `--exec` has a separate policy profile — edits/run/check/fix allowed automatically within sandbox and permission rules
- [X] Time-boxing — interrupt a hung task by timer (e.g. `--time 30m`)
- [X] Task lifecycle: create, status, output, stop, restart for background and long-running tasks

---

## Phase 7: Security, MCP & Plugin System ✅

- [X] Interactive CLI permission prompts — Allow / Deny / Always Allow before dangerous actions
- [X] Permission subsystem: rules, decision logging, mode-aware behavior (`PermissionManager`)
- [X] MCP client for connecting external tools (stdio transport, JSON-RPC)
- [X] MCP discovery: tool/resource listing, resource reading, auth flow
- [X] Dynamic plugin loading from `plugins/` directory
- [X] Plugin lifecycle: discovery, install, load, reload, version/update policy

---

## Phase 8: Gateway, Routing, Token Savings & Product Maturity ✅

> Reduce session costs and interruptions, unify model access, and deliver a predictable UX on par with mature coding CLIs.

**Local Gateway & Routing**
- [X] Single outgoing LLM call point inside the daemon — shared adapter with retries, limits, and logging
- [X] Format translation layer: internal Umbra contract ↔ provider payload
- [X] Named routing chains: ordered list of profile + model with tiered fallback (e.g. subscription → cheap models → local)
- [X] Auto-switch on 429s, network drops, and empty responses — reason written to log
- [X] Deduplication of parallel identical requests

**Token Compression**
- [X] Pre-LLM compression layer with configurable intensity: `off` / `lite` / `standard` / `aggressive`
- [X] Terminal/tool output compression: `shell.exec`, `search.rg`, `git diff`, harness `stderr`
- [X] Prose condensation and inter-turn deduplication (aligned with `/compact` and session compaction)
- [X] Stacked pipeline: machine-block compression first, then light text condensation
- [X] Mode-linked compression: `plan` minimal, `agent` balanced, `exec` aggressive on tool output
- [X] Search result compression into ranked file groups with representative snippets
- [X] Raw and compressed samples available in `umbra --debug` channel

**Usage Tracking & Cost**
- [X] Structured usage log in `~/.umbra/`: provider, model, token estimates, compression flag, chain route, errors
- [X] Per-request normalized token counter: `input`, `output`, `reasoning`, `cache.read`, `cache.write`, `costUsd`
- [X] Provider response normalization: OpenAI-compatible and Anthropic formats
- [X] Cost estimate and "saved via compression/fallback" displayed in TUI
- [X] Usage comparison panel: cost per session, model, and provider

**Global CLI & Working Directory**
- [X] Single `umbra` call from PATH (`pnpm link --global` / future installer), verified in `doctor`
- [X] Explicit `cwd` behavior: auto-detect Git root or `--project-root` flag; consistent with `doctor` and TUI

**Permissions & Access Policies**
- [X] `umbra permission` command: view rules, reset "always allow", switch modes (strict / on-demand / yolo)
- [X] Current permission mode visible in TUI and `doctor`
- [X] Tool presets (`chat-readonly`, `agent-default`, `exec-full`) aligned with displayed policy names

**Model Catalog**
- [X] Deduplicated and normalized model list — one entry per logical model, grouped endpoint variants
- [X] Unified capability card: context window, vision, tools, reasoning — sourced from registry API, not hardcoded
- [X] Fix model selection UX bugs (flicker, duplicate rows on list refresh)

**TUI & Agent Modes**
- [X] `/clear` — resets visible transcript and starts a new thread/session on the backend
- [X] Mode contract: `agent` (default), `plan`, `--exec` autonomous
- [X] Plan mode: structured JSON plan output, no tool execution
- [X] Metrics panel: token counts, response time, context fill %, cost estimate, compression indicator
- [X] Visual separation of reasoning blocks vs regular text; toggle for reasoning visualization
- [X] Double Esc to interrupt an active stream without exiting CLI
- [X] Fix duplicate messages: `assistant_message` updates the last bubble instead of appending a new one
- [X] Cursor style setting (blinking/static) saved in `~/.umbra/runtime-preferences.json`
- [X] `@`-file references with fuzzy scoring and match highlights in input
- [X] Human-readable tool call rows: action label + detail line for every tool type
- [X] Full provider connection flow via step-by-step screen

**Markdown Rendering**
- [X] Full Markdown element set: headings, bold/italic/strikethrough, inline code, fenced code blocks with syntax highlighting, lists, blockquotes, horizontal rules, links (OSC 8 where supported)
- [X] GFM tables with width-aware truncation and graceful degradation on narrow terminals
- [X] Streaming without flicker; unclosed fenced blocks show a "still typing" visual state
- [X] Mixed content: Markdown paragraphs alongside code blocks without breaking the parser
- [X] Unified markdown pipeline — single source of truth from raw text to Ink render tree
- [X] Shared syntax highlight engine with language aliases and guardrails (512 KB / 10,000 lines)

**Agent Behavior & Background Tasks**
- [X] Built-in platform constraints: no silent "improvement" steps outside explicit requests
- [X] Bootstrap profile: one-time context collection about user and project stack
- [X] Notification channel for cron/daemon tasks: JSONL log at `~/.umbra/notifications.jsonl`
- [X] `/full` flag — explicitly increases context limits and disables compression

---

## Phase 9: Web Search (`web.search` + `web.fetch`) ✅

> External internet search is isolated from local `search.rg` (Phase 5). The agent gets controlled access to SERP backends only when explicitly enabled via `/web`.

- [X] `/web` command — interactive menu for enabling/disabling web access, switching modes (`cached` / `live`), selecting provider, and viewing status
- [X] `web.search` — returns ranked URLs and snippets; only exposed to the model when web mode is active
- [X] `web.fetch` — reads a URL and returns clean Markdown (Jina Reader + raw HTML fallback); 404s and bad URLs return a structured failed-result instead of crashing the tool loop
- [X] Model can chain `web.search` → `web.fetch` for live data retrieval
- [X] Default provider: **DuckDuckGo** — zero configuration, works out of the box
- [X] Auto-migration: providers requiring an API key with no key set → auto-switch to `ddg`
- [X] Provider secrets stored in `~/.umbra/` and env only
- [X] Permissions: `web.search` gated by `agent` / `exec` policy
- [X] `umbra doctor` — web provider status section

### Supported Providers

| Provider | API Key | Default |
|----------|---------|---------|
| DuckDuckGo (`ddg`) | not required | **yes** |
| SearXNG (`searxng`) | not required | no |
| Jina Search (`jina`) | required | no |
| Brave Search (`brave`) | required | no |
| Tavily (`tavily`) | required | no |

---

## Phase 10: TUI Theming ✅

> Full user control over the TUI color scheme. The selected theme is saved in `~/.umbra/runtime-preferences.json` and restored automatically on every launch.

- [X] **40 built-in themes:** `umbra` (default), `aura`, `ayu`, `carbonfox`, `catppuccin`, `catppuccin-frappe`, `catppuccin-macchiato`, `cobalt2`, `cursor`, `dracula`, `everforest`, `flexoki`, `github`, `gruvbox`, `kanagawa`, `lucent-orng`, `material`, `matrix`, `mercury`, `monokai`, `nightowl`, `nord`, `one-dark`, `opencode`, `orng`, `osaka-jade`, `palenight`, `rosepine`, `solarized`, `synthwave84`, `tokyonight`, `vercel`, `vesper`, `zenburn`, `vscode-default`, `classic`, `dark-pro`, `pastel`, `hacker`, `retro`
- [X] `/theme` command — interactive dialog with live search, arrow navigation, virtual window of 12 themes, `Enter` to apply, `Esc` to cancel
- [X] Selected theme persisted in `runtime-preferences.json` and restored on each TUI launch
- [X] Dynamic apply — new colors take effect immediately without restarting

---

## Phase 11: Workspace Trust & Context Switching ✅

> The agent can legally switch between projects with user approval — preserving chat history while updating contextual knowledge (rules, memory).

- [X] `fs.cd` tool — switches active `projectPath` within the current session
- [X] On switch: auto-reloads `AGENTS.md`, updates Repo Map, connects the target folder's `MEMORY.md`
- [X] TUI status bar updates CWD instantly after a successful switch
- [X] Trusted paths registry (`~/.umbra/trusted-paths.json`) for persistent path permissions
- [X] Current CWD auto-added to trusted paths on `umbra init`
- [X] Trust prompt on `fs.cd` to an untrusted path — Allow / Deny / Allow Always via permission system
- [X] "Allow Always" persistently saves the path to `trusted-paths.json`
- [X] `umbra trust list` and `umbra trust remove <path>` CLI commands

---

## Phase 12: Isolation, Parallelism & Sandboxes

> Safe parallel operation of multiple agents on one project without filesystem conflicts, and isolation of potentially destructive commands.

- [ ] Git Worktrees manager — routes each agent session to a temporary isolated worktree instead of the user's main working directory
- [ ] Safe merge/apply of agent results back to the main branch on task completion
- [ ] Sandbox environment (Docker or lightweight alternative) for `shell.exec` and long builds without risk to the host OS
- [ ] Controlled sandbox access to the target project directory
- [ ] Terminal multiplexer support (`tmux` / `Zellij`) for persistent TUI sessions during long background runs

---

## Phase 13: Task Management & Sub-agent Orchestration (The Hive Mind)

> Umbra becomes a full agent factory — the main planner delegates tasks to specialized sub-agents.

- [ ] Built-in system sub-agents: `web-researcher` (search & docs), `code-linter` (quality analysis), `test-runner` (autonomous test execution)
- [ ] Hard tool scoping per system sub-agent for safety
- [ ] `/agent on/off` — global toggle for the sub-agent system
- [ ] `/agent enable/disable <name>` — individual control for system and custom agents
- [ ] Visual indicator of active sub-agents in TUI
- [ ] Sub-agent selection based on manifest `whenToUse` description
- [ ] IPC for passing sub-agent results back into the main thread context
- [ ] Read `TASKS.md` / `STATUS.md` from target project root when present; auto-update task statuses on completion (especially in `--exec` mode)
- [ ] Daemon cron/heartbeat for background context collection and stale session cleanup
- [ ] `umbra agent create` — scaffold a new custom agent
- [ ] Two storage levels: global (`~/.umbra/agents/`) and project-scoped (`.umbra/agents/`)
- [ ] Custom agent manifest: role description, system instructions, tool selection

---

## Phase 14: Non-blocking Task Queue & Steering

> Radical UX improvement — the user can not only queue tasks but also steer the agent mid-execution without stopping the daemon.

- [ ] Input field unlocked in TUI during active task execution
- [ ] **Steering Message (Enter)** — delivered immediately after the current tool call finishes, interrupting a long reasoning chain to redirect the agent
- [ ] **Follow-up Message (Alt+Enter)** — queued, delivered only after the current global task fully completes
- [ ] FIFO message queue — messages accumulate without blocking
- [ ] Visual queue indicator in TUI ("In queue: 2 tasks", "Steering active"); next task auto-starts on completion
- [ ] Rich `DaemonStatus` JSON with real-time metrics: `window_size_max`, `budget_limit`, `used_total`, `percent_filled`, task queue state, MCP server states
- [ ] TUI reads pre-calculated metrics from `DaemonStatus` for instant status bar rendering

---

## Phase 15: Deep Context & Ultra-Efficient Token Management ✅

> Extreme token savings through smart history management and full control over the context window.

- [X] `/goal <text>` — sets the active session goal (thread-scoped), displayed persistently in TUI status bar
- [X] Mission Mode: when `/goal` is active (especially in `--exec`), goal is injected into the system prompt
- [X] Completed goal auto-written to project `MEMORY.md` after `--exec` finishes
- [X] Iterative compaction — "accumulative summary" algorithm: `Previous Summary + New Messages = Updated Summary` instead of full re-summarization
- [X] Structured summary sections: Goals, Progress (done/files/failures), Next Steps, preserved tail
- [X] `/compact settings` — dialog to configure a dedicated provider/model for compaction (separate from the main agent profile)
- [X] Compaction provider/model saved in `runtime-preferences.json`; resets to Default without manual file editing
- [X] TUI history read from SQLite only — visually infinite for the user, never disappears from screen
- [X] LLM payload uses Sliding Window with `currentTurnTokenBudget`
- [X] Hard stop when token budget is exhausted — no silent truncation, explicit warning shown to user
- [X] Auto-compression applies only to old logs inside the JSON payload, never affects TUI display
- [X] `/think <N> | off` — controls reasoning budget tokens (Anthropic); shown as `think:Nt` in status bar
- [X] Dynamic thinking menu: adapts to model type (`effort_levels` / `budget` / `toggle`)

**In-Turn Split-Logic**
- [X] Split-Turn mechanism: when context overflows mid-task (between tool calls), split into Prefix (compressed to "current execution context" mini-summary) and Suffix (raw — last tool calls and their results)
- [X] Agent continues without losing connection to what happened seconds ago

**Retrieval-first Context Packets**
- [X] Typed context packet: query, files considered, snippets, symbols/fallback lines, token estimate, truncation policy, provenance
- [X] Hard packet size cap per mode (`plan` / `agent` / `exec`); fails loudly when no useful context can be selected
- [X] Retrieval orchestrator: compose repo-map symbols + `search.rg` matches + fuzzy file hits into ranked packets
- [X] Priority: AST summaries for supported languages → structured partial parsers → universal text fallback
- [X] Raw large tool output excluded from model history; stored in debug/session logs, compressed packet injected instead
- [X] Debug surface shows file/snippet selection reasoning without leaking into normal transcript

**Request Usage Meter**
- [X] `RequestUsage` payload per completed model step: `provider`, `model`, `input`, `output`, `reasoning`, `cacheRead`, `cacheWrite`, `total`, `contextPercent`, `costUsd`, `source: actual|estimated`
- [X] OpenAI-compatible and Anthropic response normalization (including reasoning and cache fields)
- [X] Local tokenizer fallback for other providers, result marked `estimated`
- [X] TUI status: last request `in/out/reasoning/cache`, `% context`, `$`, provider/model
- [X] Usage panel: session totals, average per request, cost by model/provider, most expensive request
- [X] CLI usage/stats report command
- [X] Same-task comparison across models: tokens, reasoning/cache, cost, latency, compression applied

**Built-in Code Review (`/review`)**
- [X] `/review` — reviews staged+unstaged changes (`git diff HEAD`); `/review staged` — staged only; `/review <file>` — specific file
- [X] Reviewer receives: git diff, repo-map of affected files, optional `AGENTS.md` project rules
- [X] Structured output in TUI: **Security**, **Logic**, **Style**, **Tests** sections with file:line references
- [X] Review request goes to a dedicated review profile, does not touch main agent conversation history
- [X] `/review settings` — configure provider/model for reviews (same dialog pattern as `/compact settings`), saved in `runtime-preferences.json`

---

## Phase 16: Extensibility & Ecosystem (MCP, Skills, Commands)

> A plugin ecosystem of custom commands and managed MCP server connections — seamlessly extending the agent's toolset.

**MCP Core Orchestration**
- [ ] `.mcp.json` config parser with local `cwd` and global `~/.umbra/` scopes
- [ ] Env vars and custom auth headers support for MCP servers
- [ ] SSE and HTTP transports in addition to existing stdio
- [ ] Auto-start, monitoring, and reconnect of MCP servers inside the PM2 daemon
- [ ] CLI: `umbra mcp add`, `umbra mcp list`, `umbra mcp enable/disable`, `umbra mcp remove`

**Skills System & Multi-agent Context**
- [X] Recursive search for instruction files from current directory up to disk root
- [X] Supported formats: `UMBRA.md` (priority), `AGENTS.md`, `CLAUDE.md`, `CODEX.md`, `GEMINI.md`, `QWEN.md`, `SYSTEM.md`
- [X] Context merging: parent-directory rules merged with local; local rules take priority on conflict
- [X] Global scope: `~/.umbra/UMBRA.md` and `~/.umbra/AGENTS.md` mixed into all projects
- [X] `SKILL.md` parser with YAML frontmatter (`name`, `description`, `disable-model-invocation`, `argument-hint`)
- [X] Skills resolved from global (`~/.umbra/skills/`) and project-local (`.umbra/skills/`) directories
- [X] Dynamic context injection via shell commands in skills (`` !`git status` `` syntax)
- [X] Skills passed to LLM via XML injection in system prompt

**Custom Slash Commands & TUI Integration**
- [X] Dynamic slash command registration from loaded `SKILL.md` files
- [X] Autocomplete for custom commands in TUI input
- [X] Argument mapping: `$ARGUMENTS`, `$0`, `$1`
- [X] Visual execution indicator and results shown in transcript
- [X] `/skill-create` — interactive TUI wizard: name → description → creates `.umbra/skills/<name>/SKILL.md`
- [X] Validation: lowercase-kebab-case, duplicate check (no silent overwrite); ESC cancels without creating a file

**Security & Guardrails**
- [ ] Permission confirmation before MCP server or Skill executes a potentially dangerous operation
- [ ] Detailed audit log of all MCP-provided tool calls
- [ ] Execution isolation: custom commands cannot break daemon state or escape allowed directories

---

## Phase 17: Smart Model Capabilities UX

> The user clearly understands what the selected model can do right now — the interface never "promises" features the model doesn't support.

- [X] HuggingFace API and models.dev integration for capability enrichment (tool/vision/context/reasoning flags)
- [ ] Extended reasoning metadata: detailed object with type (`effort_levels` / `budget` / `toggle`) and available options (e.g. `["low", "medium", "high"]`) — used by TUI to render the correct `/think` interface
- [ ] Capability info line under the TUI input field: active model name + detected capabilities in yellow parentheses, e.g. `Claude 3.7 Sonnet (tools, vision, thinking: 8k)` or `o3-mini (tools, reasoning: high)`
- [ ] Context fill indicator (circular or progress bar): physical model max, configured soft limit, current token usage
- [ ] Visual warning when approaching the auto-summarization threshold; `/compact` always available manually

---

## Phase 18: Rich TUI & Visual Session Tree

> Convenient tools for reviewing code changes and navigating alternative session branches directly in the terminal.

- [ ] Client-side diffing engine — calculates the difference between the current file state and the agent's proposed change
- [ ] `<DiffView />` Ink component for rendering Unified Diff (red/green highlights)
- [ ] `/tree` command — visual tree of all session branches based on `parentId` in JSONL events
- [ ] Interactive node selection: jump to any past point and fork a new branch from there
- [ ] Differential rendering — only changed Ink components re-render, keeping high token stream smooth
- [ ] Preview mode for tools: show diff + user confirmation before applying
- [ ] Quick undo via TUI

---

## Phase 19: Universal Plugin Ecosystem (Plugin System & Lifecycle Hooks)

> Developers can extend Umbra CLI without modifying the daemon's core source code.

- [ ] CLI plugin manager: `umbra plugin install <git-url/npm/local-path>`, `umbra plugin list`, `umbra plugin update`, `umbra plugin remove`
- [ ] Plugin manifest parser (`plugin.json` or `plugin.yaml`) with explicit permission flags required
- [ ] Plugins can bundle MCP server scripts/configs for auto-start
- [ ] Bundled `SKILL.md` files and custom slash commands auto-registered on plugin install
- [ ] `onPrompt` / `chat.params` hook — dynamically modify model parameters before a request
- [ ] `tool.execute.before` hook — intercept system tool calls for validation
- [ ] `session.compacting` hook — override the default context compression algorithm
- [ ] `tool.execute.after` hook — post-process tool results before returning to the LLM
- [ ] `ProviderHook` — teach Umbra to work with entirely new AI models
- [ ] `AuthHook` — implement custom OAuth flows

---

## Phase 20: Security Boundaries & Environment Hygiene (.env, .gitignore)

> The agent respects the project's ignore rules and never leaks sensitive data into the chat context.

- [ ] `isPathIgnored` utility using `git check-ignore` — integrated into all read/search tools and repo-map generator
- [ ] Default sensitive file blocklist: `.env`, `.git/config`, `~/.ssh/*`, `~/.bash_history`
- [ ] Smart Skip: sensitive file content replaced with `[SENSITIVE_CONTENT_HIDDEN]` instead of being read
- [ ] Auto-detection and masking of API keys and tokens in `shell.exec` output (Redaction Layer)
- [ ] Dangerous bash pattern detection to block obfuscation and injection attempts

---

## Phase 21: Large File Support (Leviathan Engine)

> Make Umbra the most efficient agent for working with files of 10,000+ lines using laser-precise tools for radical token savings.

- [ ] `fs.read` upgrade: `startLine` / `endLine` parameters — agent reads only the needed fragment, saving up to 95% of context budget
- [ ] AST Folding / Skeleton View: first contact with a giant file returns only the skeleton (classes and method signatures without bodies)
- [ ] `fs.expand` tool: agent selectively expands specific function bodies on demand
- [ ] `fs.search_internal` tool: semantic search within a single file — finds logic by meaning across 10,000+ lines
- [ ] `fs.patch_targeted` tool: replace specific line ranges (`range: [start, end]`) — faster and more reliable than Unified Diff for massive files

---

## Phase 22: Self-Evolution & Skill Synthesis

> The agent grows smarter with every completed task — successful strategies are crystallized into reusable skills, and failures are tracked to avoid repeating mistakes.

**Automatic Skill Extraction**
- [ ] On `/goal` success: agent analyzes the tool call chain and synthesizes a reusable `SKILL.md` in `.umbra/skills/<name>/`
- [ ] `/learn` command — interactive or automatic skill creation from the cleaned-up success log
- [ ] Paths, filenames, and arguments templated with placeholders: `{{projectPath}}`, `{{targetFile}}`, `{{branchName}}`
- [ ] Skill versioning: each edit creates `.umbra/skills/<name>/versions/v<N>.md`; `umbra skill rollback <name>` for rollback
- [ ] Skill dependencies: `requires:` field in YAML frontmatter; orchestrator builds and executes dependency graph
- [ ] Optional `smoke.sh` test harness per skill — run before registering in the global registry
- [ ] SQLite `skill_runs` table: duration, token cost, success rate — agent prefers high-scoring skills

**Self-Healing & Reflection**
- [ ] Plan-Act-Observe-Reflect loop: explicit Reflect step triggered on ≥ 2 identical `tool_call_failed` in one run
- [ ] On repeated failure: agent pauses, analyzes tool documentation, and revises its strategy
- [ ] Failure Pattern DB (`failure_patterns` table): tool, error type, frequency, last occurrence, recommended fix
- [ ] Auto-upsert on each `tool_call_failed`; marked "resolved" on subsequent success of the same operation

**Global Skill Registry**
- [ ] Global registry in `~/.umbra/skills/` — skill promoted only after passing `smoke.sh` in ≥ 2 different projects
- [ ] Skill scoring: `(success_rate × 0.6) + (token_efficiency × 0.3) + (recency × 0.1)`; top skills appear first in TUI `/` autocomplete
- [ ] `umbra skill list`, `umbra skill show <name>`, `umbra skill remove <name>`

---

## Phase 23: Proactivity & Global Scheduler

> A shift from "reactive chat" (waiting for commands) to "proactive agent" (knows what to do on its own in the morning, evening, or when CI fails).

**Daemon Heartbeat**
- [ ] Periodic daemon wake-up every 15–60 minutes via `croner` (no user interaction required)
- [ ] `HEARTBEAT.md` parser: declarative YAML blocks with `schedule` (cron expression), `task`, `allowed_tools`, `notify_on: always|failure|never`
- [ ] Tasks whose schedule matches the current time are queued automatically

**Event-Driven Triggers**
- [ ] Git Hook: `~/.umbra/hooks/post-receive` registers a daemon event on every `git push` in trusted projects — auto-runs tests or linter
- [ ] File System Watcher (`umbra watch <glob>`): triggers a task from `HEARTBEAT.md` `on_file_change:` section on file change
- [ ] CI Failure Hook: webhook receiver (`POST /daemon/ci-event`) — auto-starts a diagnostic run on `status: failed`

**Unattended Safety**
- [ ] `allowed_tools:` required in every `HEARTBEAT.md` task; default: `[fs.read, search.rg, shell.exec(readonly), git.status, web.fetch]`
- [ ] Destructive tools (`fs.write`, `git.commit`) require explicit `allow_destructive: true` in the task
- [ ] Emergency Kill Switch: `umbra heartbeat stop` or touch `~/.umbra/HEARTBEAT_PAUSED` — cancels all active unattended tasks immediately

**Autonomous Monitoring & Digest**
- [ ] Watcher mode: monitors logs and git changes, notifies only on critical events via notification log
- [ ] Daily outcome digest of unattended work → `~/.umbra/heartbeat-digest/<YYYY-MM-DD>.md`; view via `umbra heartbeat digest [--date]`

**Global Task Calendar**
- [ ] SQLite `scheduled_tasks` table: `id`, `cron_expr`, `project_path`, `task`, `allowed_tools`, `last_run`, `next_run`, `status`
- [ ] `umbra schedule add "<cron>" "<task>"`, `umbra schedule list`, `umbra schedule delete <id>`, `umbra schedule run <id>`

---

## Phase 24: Semantic Web Intelligence (Semantic Browsing)

> Traditional scraping breaks constantly. Using the Accessibility Tree lets the agent "see" a site as a structured element tree, not a tag soup. Covers interactive SPAs where `web.fetch` isn't enough.

> All browser features are behind `UMBRA_BROWSER_ENABLED=1` and an optional peer dependency. Without Playwright installed, graceful degradation to `web.fetch`.

- [ ] Playwright integration (optional peer) for Accessibility Tree capture
- [ ] Compact text representation passed to the model: buttons, inputs, headings, links with `aria-label`/`id` — not raw HTML
- [ ] Snapshot token budget cap (default 4 000 tokens) with automatic compression
- [ ] Browser tools: `browser.open`, `browser.click`, `browser.type`, `browser.snapshot`, `browser.back`, `browser.screenshot`
- [ ] Multi-step action chains with TUI confirmation per step or fully automated in `--exec` mode
- [ ] Browser session persistence in `~/.umbra/browser/sessions/<session_id>/` (cookies, localStorage)
- [ ] Auto-detect forms from Accessibility Tree; agent fills by intent ("fill the login form"), not raw selectors
- [ ] `umbra browser record` — records an interactive session and exports it as a `SKILL.md`
- [ ] `browser.screenshot()` → Vision model for canvas, PDF viewers, and captcha detection
- [ ] Auto-switch to Vision when Accessibility Tree is incomplete (`aria_hidden: true` or no interactive elements)
- [ ] Throttle/captcha detection (429, CAPTCHA in tree) → graceful stop with user notification instead of crash
- [ ] Human-like jitter between actions in unattended mode

---

## Phase 25: Cognitive Dashboard & Meta-Intelligence

> The user sees the agent's "inner workings" — how it thinks, where it spends resources, and how well it understands the current project. The agent also auto-selects the optimal model based on task classification.

**Intelligence Dashboard (TUI)**
- [ ] `/mastermind` panel: project mastery level (% files read/modified of total repo), active skills with metrics (calls/week, avg success rate, avg cost)
- [ ] Project Health Score 0–100: repo map coverage, `MEMORY.md` freshness, skill success rates, avg request cost — displayed in TUI status bar next to provider
- [ ] Knowledge Staleness Detector: `MEMORY.md` facts older than threshold (default 30 days) in volatile domains (package versions, APIs, CI) are auto-tagged `[STALE]` and flagged for update

**Cost-Aware Model Router**
- [ ] Task classification before each run: `complexity: low|medium|high` × `domain: search|code_gen|analysis|creative|system_admin`
- [ ] Configurable routing matrix in `~/.umbra/routing-policy.json` — no hardcoded model names
- [ ] Budget Guard: if estimated run cost exceeds `maxCostUsd`, ask user confirmation before proceeding
- [ ] Routing decision shown in TUI: `→ model-name (low complexity, search)`

**Project Knowledge Graph**
- [ ] SQLite `concept_graph` table: `entity_a`, `relation`, `entity_b`, `confidence`, `source_file`, `last_seen`
- [ ] Relation types: `depends_on`, `implements`, `calls`, `configures`, `uses_env_var`
- [ ] Auto-populated on each `fs.read` / AST analysis from imports, requires, and Zod schemas
- [ ] `graph.query(entity)` tool: returns all neighbors — "what depends on this function", "which files use this env var"
- [ ] `/graph <entity>` TUI command: ASCII graph of nearest connections (depth=2) rendered in terminal

---

## Phase 26: Multi-platform & Remote Presence

> Umbra CLI is available wherever the user prefers. External tools (VS Code, browser) can talk to the daemon through a documented API.

> Security invariant: daemon still listens only on `127.0.0.1`. External access goes through an encrypted tunnel/auth-proxy, never an open port.

**REST API for External Tools**
- [ ] Documented daemon API: `GET /daemon/status`, `POST /daemon/run`, `GET /daemon/sessions`, `GET /daemon/sessions/:id/events`
- [ ] OpenAPI / JSON Schema spec in `docs/daemon-api.json` (generated from Zod contracts)
- [ ] WebSocket channel `/daemon/ws` — live `RunEvent` stream subscription without polling

**Messenger Bridges**
- [ ] Telegram Bridge: bot webhook → `POST /daemon/run` → reply to chat
- [ ] Discord Bridge: slash commands via Discord Bot API
- [ ] Secure auth: only whitelisted `chat_id` / user IDs from `~/.umbra/bridges.json` can control the daemon
- [ ] Supported commands: `/status`, `/run <task>`, `/digest`, `/stop`

**Remote Web UI**
- [ ] Static SPA (Vite + React) for monitoring: active tasks, logs, provider status, usage stats
- [ ] `umbra webui` → opens browser at `http://127.0.0.1:<auto-port>`
- [ ] WebSocket connection to daemon, auth via one-time token
- [ ] Read-only by default; write mode (running tasks) requires TUI confirmation

**Knowledge Sync**
- [ ] `umbra sync export` — AES-256-GCM encrypted archive of `MEMORY.md`, verified skills, `routing-policy.json`
- [ ] `umbra sync import <file>` — unpack and merge (skills: append; memory: merge by key; policy: user chooses override / keep / merge)
- [ ] Sync key stored in `~/.umbra/sync.key`, generated on first use

---

## Phase 27: Prompt Engineering as Code (Prompt Registry & Optimization)

> Prompts are executable code. They should be versioned, tested, and optimized like any other code — not hardcoded in source files.

- [ ] Prompts stored in `.umbra/prompts/<name>.md` with YAML frontmatter: `name`, `version`, `description`, `variables`, `test_cases`
- [ ] `{{variable}}` templating with typed variables (string, number, list) and optional defaults
- [ ] Runtime resolution: project `.umbra/prompts/` + global `~/.umbra/prompts/` merged with built-ins (local takes priority)
- [ ] `umbra prompt list`, `umbra prompt show <name>`, `umbra prompt edit <name>`
- [ ] Auto-snapshot on change: `.umbra/prompts/<name>/versions/v<N>.md`
- [ ] `umbra prompt rollback <name>` and `umbra prompt diff <name> v1 v2`
- [ ] `test_cases:` in frontmatter: `input_variables`, `expected_contains`, `expected_not_contains`; `umbra prompt test <name>` — CI-compatible exit codes
- [ ] `umbra prompt optimize <name> --examples <n>` — analyzes last N uses and proposes an improved version as `v<N+1>.md` for user review (never auto-applied)

---

## Phase 28: Epistemic Layer (Agent Honesty & Confidence Engine)

> The agent stops speaking with equal confidence about what it knows for certain and what it's guessing. This is the primary mechanism against hallucinations — forcing the agent to explicitly separate knowledge, inference, and unknowns.

- [ ] `ConfidenceReport` before each significant action (destructive tool, file edit, `git.commit`): `{action, confidence: 0.0–1.0, basis, unknowns}`
- [ ] If `confidence < 0.6`: forced verification step (read/search tool call) before proceeding — no blind assumptions
- [ ] Full report in debug channel; TUI shows only brief `⚠ low confidence` before destructive actions
- [ ] System prompt requires epistemic markers: `[VERIFIED from <source>]`, `[INFERRED from context]`, `[NEEDS_VERIFICATION]`, `[STALE — last checked >N days]`
- [ ] TUI renders markers in color: green (verified), yellow (inferred), red (needs verification)
- [ ] SQLite `domain_error_rates` table: tracks success/failure per domain (code_gen, search, config, web)
- [ ] If `failure_rate > 0.4` in a domain: auto-raise `required_confidence` and add an extra verify step for that domain
- [ ] `umbra stats domains` — domain error rates diagnostic table
- [ ] Per-run `uncertainty_budget` (default 3 allowed `NEEDS_VERIFICATION` actions): on budget exceeded, run switches to `plan` mode and asks the user instead of continuing blindly
- [ ] `umbra config set uncertainty_budget <n>` — `0` for paranoid mode, higher values for maximum autonomy

---

## Phase 29: Edge Intelligence (Local-First Inference)

> Not every task needs the cloud. Classification, tool selection, and simple transformations can run on a free local quantized model with zero latency — amplifying Umbra's existing token savings.

> All features behind `UMBRA_LOCAL_INFERENCE=1`. Without a local runtime installed, graceful degradation — all requests go to the cloud as before.

- [ ] `ProviderType: 'local_llama'` in registry: Ollama (`http://localhost:11434`) as zero-config first option
- [ ] Optional llama.cpp subprocess integration for users without Ollama
- [ ] Dynamic local model discovery via Ollama `GET /api/tags`
- [ ] Local models in registry with `cloud: false`, `free: true`, `contextWindow`, `capabilities`
- [ ] Three hybrid inference presets in `routing-policy.json`: `economy` (max local), `balanced` (local for simple tasks, cloud for complex), `quality` (always cloud)
- [ ] `umbra config set inference_profile <economy|balanced|quality>`
- [ ] Local task classification: tiny local model (e.g. Phi-3.5-mini via Ollama) replaces cloud calls for `complexity`/`domain` routing decisions
- [ ] Local embeddings: Ollama `nomic-embed-text` for vectors exceeding 512 tokens
- [ ] `UMBRA_OFFLINE=1` — all requests routed to local models only; graceful error if local unavailable
- [ ] TUI status bar shows `[local: model-name]` for local requests
- [ ] `umbra usage` — separate line: `local inference: N requests, $0.00`

---

## Phase 30: Active Preference Learning & Personalization

> Umbra learns not just what works in general, but what this specific user likes. Silent, non-intrusive preference collection — the agent improves simply from daily use.

- [ ] `Ctrl+U` (thumbs up) / `Ctrl+D` (thumbs down) hotkeys after any agent response
- [ ] Feedback saved to `~/.umbra/preferences.jsonl`: `{sessionId, messageId, rating: +1|-1, model, provider, task_domain, timestamp}`; non-blocking, TUI stays in place
- [ ] `~/.umbra/user-profile.json`: preferred response style, favorite languages, preferred tools, timezone, verbosity level
- [ ] `umbra profile setup` — interactive questionnaire on first launch; `umbra profile edit` at any time
- [ ] User profile injected into system prompt via `{{userProfile}}` variable
- [ ] Weekly analysis of `preferences.jsonl`: if `thumbs_down_rate > 0.3` for a `task_domain + model` combination → alert in notification log on next TUI start: "Quality degradation detected in domain X with model Y. Want to reroute?"
- [ ] Agent infers preferred verbosity from feedback history and auto-adjusts prompt
- [ ] Adaptive vocabulary: high technical level detected → basic concept explanations omitted

---

## Phase 31: Long-Run Reliability & Checkpointing

> True autonomous operation (hours, days) requires protection against failures: reboots, network drops, daemon crashes. An interrupted run should never be lost.

- [ ] Every N tool calls (default 5) or on time-box trigger: serialize `conversationHistory`, `currentGoal`, `progressSummary`, `pendingToolCall` to SQLite `run_checkpoints`
- [ ] Checkpoint format: `{runId, stepNumber, conversationSnapshot, goalState, activeSkills, timestamp}`; history compressed to `progressSummary + tail` before serialization
- [ ] On daemon start: check `run_checkpoints` for interrupted runs older than 30 seconds
- [ ] TUI prompt on discovery: "Unfinished task found: `<goal>`. Resume?"
- [ ] `umbra resume <runId>` — direct CLI resume without TUI; restores history and retries last incomplete tool call
- [ ] % completion estimate from skill metrics and `progressSummary`; ETA shown in TUI status bar (`~12 min remaining`)
- [ ] In `--exec` mode: live progress written to `~/.umbra/runs/<runId>/progress.json` for external monitoring
- [ ] Autonomous action audit log: `~/.umbra/audit/<YYYY-MM-DD>.jsonl` — `{timestamp, runId, action, tool, args_hash, result_summary, user_present: false}`; args hashed, env var values masked
- [ ] `umbra audit show [--date] [--runId]` — review what the agent did while you were away
- [ ] Auto-pause if `failureRate > maxFailureRate` within one run — notification instead of infinite retry loop
- [ ] `umbra run status <runId>` — real-time status of a long-running task

