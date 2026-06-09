# Changelog

All notable changes to this project will be documented in this file.

## [0.1.1] - 2026-06-10

### Fixed

- README images now use absolute URLs for correct display on npmjs.com

## [0.1.0] - 2026-06-07

### Core Architecture

- Daemon-first architecture via PM2 — hidden local HTTP server on `127.0.0.1:8080`, CLI as thin HTTP client
- Lazy-loading runtime modules — heavy branches load only on demand per command

### CLI & TUI

- Core commands: `umbra start`, `umbra stop`, `umbra status`, `umbra task add`
- `umbra init` — scaffolds `AGENTS.md` template and `check.sh` / `check.ps1` in project directory
- Terminal UI built with Ink — original Umbra dark/shadow theme
- Markdown rendering with syntax highlighting and streaming model responses
- `/clear` — resets transcript and starts a new thread/session on the backend
- Drag-and-drop file path parsing and local image to Base64 conversion (Vision support)
- `umbra doctor` — health check for filesystem, ports, SQLite, daemon, and web providers
- `umbra debug` — live monitor for daemon/CLI/TUI/provider events; writes `~/.umbra/debug/events.jsonl`
- `umbra permission` — view rules, reset "always allow", switch permission modes
- `umbra trust list` / `umbra trust remove <path>` — manage trusted workspace paths
- `umbra usage` — token and cost report from usage log

### Memory & Sessions

- Service filesystem auto-init: `~/.umbra/`, `~/.umbra/sessions/`, `~/.umbra/projects/`
- Global SQLite database with vector search via `sqlite-vec`
- Local text embeddings via Transformers.js (`all-MiniLM-L6-v2`, ~90 MB, auto-downloaded)
- Typed JSONL session events with stable schema: `id`, `sessionId`, `projectPath`, `timestamp`, `type`, `payload`
- `AGENTS.md` rules parsing and `MEMORY.md` read/write per project
- Full thread lifecycle: `thread_start`, `thread_list`, `thread_resume`, `thread_fork`, `thread_archive`, `thread_unarchive`
- TUI session picker with `/sessions`, `/resume`, `/sessions fork`
- `/clear` bound to new thread — previous thread preserved in history
- Explicit memory controls: `use_memories` / `generate_memories` flags per runtime/project/thread
- Memory provenance and citations — source metadata visible in responses and debug trace
- Safe memory reset without deleting session logs
- Session compaction pipeline with iterative accumulative summary (`Previous Summary + New Messages = Updated Summary`)
- Session import/export support

### Context Engine

- Tree-sitter AST integration — full AST for 15+ languages via WASM grammars
- GML/GameMaker 2.3+ full AST via `@bscotch/gml-parser` (function, constructor, macro, enum, globalvar)
- Repo Map generator — compact symbol-level outline of the entire project
- Code compression — sends only function/class signatures, not full file bodies
- Auto token counting for outgoing prompts
- `/compact` — forces summarization of accumulated context
- `/compact settings` — configure dedicated provider/model for compaction
- Universal text fallback for unknown file types — bounded context packet with top symbols and token estimate
- Split-turn compression — mid-turn context overflow handled by compressing the prefix, keeping the last 3 raw tool pairs
- Retrieval-first context packets — search results compressed to ranked file groups with `file:line` references preserved; token caps per mode

#### Language coverage — full AST

JavaScript, TypeScript, TSX, Python, Go, Shell/Bash, Rust, Java, C/C++, C# (class/interface/record/property/constructor/event), PHP, Ruby, CSS, PowerShell, INI/Config, GML/GameMaker 2.3+

#### Language coverage — structured parsers

JSON, YAML, GitHub Actions YAML, Markdown, SQL, HTML, TOML, GraphQL, Protocol Buffers, Terraform/HCL, Prisma, Solidity, Zig, Dart, Kotlin, Swift, Lua, Scala, Elixir, Erlang, Haskell, Perl, R, Clojure, Vue, Svelte, Astro, XML, Gradle, GDScript, MATLAB/Octave, Nix, WebAssembly Text, Assembly x86/ARM, Dockerfile, Makefile, CMake, `.env` (values redacted), log files, Jupyter Notebook, PDF, DOCX, yarn.lock, Cargo.lock, Gemfile.lock, composer.lock

### Provider Layer

- Dynamic model registry with live capabilities fetch via `models.dev` + HuggingFace (tool/vision/context/reasoning flags — no hardcoding)
- OpenAI client with structured output (Zod), Anthropic client, local network client (Ollama, LM Studio)
- `ProviderTypeSpec` registry with `value`, `label`, `default_url`, `needs_key`, `cloud`, `aliases`
- Provider profiles with full CRUD: list, create, update, delete, test, capabilities
- Per-profile model selection and global fallback
- Enable/disable profiles without deletion — explicit `connected` / `available` / `unavailable` status
- Graceful degradation for broken profiles — auto-fallback to valid connection on startup
- Optional/module-gated providers — module absent means provider unavailable, no crash
- CLI/TUI provider management and active model switching

### Tools

- Zod schemas for strict JSON validation of all AI tool calls
- Tool Runner — central call router with risk classification (`read_only` / `write` / `execute`)
- Tool presets: `chat-readonly`, `agent-default`, `exec-full`
- Machine-readable result schema on every tool
- `fs.list`, `fs.read`, `fs.write`, `fs.edit` (Unified Diff patch application)
- `shell.exec` — terminal command execution with stdout/stderr capture
- `search.rg` — ripgrep wrapper with grouped output (file buckets, snippets, match counts, truncation metadata)
- `search.files` — ignore-aware file listing with Node.js fallback
- `search.fuzzy` — fuzzy file path scoring
- External binary health layer — availability check, version, path source, custom path override
- `git.status`, `git.diff`, `git.apply`, `git.commit`, `git.push`, `git.pull`
- `fs.cd` — switches active `projectPath` with auto-reload of AGENTS.md, Repo Map, and MEMORY.md
- Central permission hook before every tool call
- Destructive vs non-destructive tool separation at contract level

### Orchestration & Autonomous Loop

- **Planning Mode** — AI reads AST and produces a JSON plan without executing any tools
- **Agent Mode** — interactive working mode with tools resolved by policy and task intent
- **`--exec` autonomous mode** — patch loop via `fs.edit` with auto-run of `check.sh` / `check.ps1`
- Per-mode execution contracts: allowed tools, confirmation rules, edit/shell/git permissions, stop-guards; no mode bleed
- On `Exit Code 1` → capture `stderr`, build new prompt with error, auto-retry (up to 6 attempts)
- On `Exit Code 0` → task complete: auto-commit and write to project `MEMORY.md`
- `--exec` has a separate policy profile — edits/run/check/fix allowed automatically within sandbox
- Time-boxing — interrupt a hung task by timer (`--time` flag)
- Task lifecycle: create, status, output, stop, restart for background tasks

### Security, MCP & Plugins

- Interactive CLI permission prompts — Allow / Deny / Always Allow before dangerous actions
- Permission subsystem with rules, decision logging, and mode-aware behavior (`PermissionManager`)
- MCP client for external tools (stdio transport, JSON-RPC) with tool/resource discovery and auth flow
- Dynamic plugin loading from `plugins/` directory with lifecycle management

### Gateway, Routing & Token Economy

- Single outgoing LLM call point in daemon — shared adapter with retries, limits, and logging
- Format translation layer: internal Umbra contract ↔ provider payload
- Named routing chains with tiered fallback — auto-switch on 429s, network drops, empty responses
- Parallel request deduplication
- Pre-LLM compression layer with configurable intensity: `off` / `lite` / `standard` / `aggressive`
- Terminal/tool output compression: `shell.exec`, `search.rg`, `git diff`, harness `stderr`
- Stacked pipeline: machine-block compression first, then prose condensation
- Mode-linked compression: `plan` minimal, `agent` balanced, `exec` aggressive on tool output
- Structured usage log in `~/.umbra/usage.jsonl`
- Per-request normalized token counter: `input`, `output`, `reasoning`, `cacheRead`, `cacheWrite`, `costUsd`, `source: actual|estimated`
- OpenAI-compatible and Anthropic response normalization (including reasoning and cache fields)
- Cost estimate and savings displayed in TUI; usage comparison by session/model/provider
- `umbra permission` — strict / on-demand / yolo modes, visible in TUI and `doctor`
- Tool presets aligned with displayed policy names
- Deduplicated and normalized model list — unified capability card from registry API
- Plan mode structured JSON output
- Metrics panel in TUI: token counts, response time, context fill %, cost, compression indicator
- Visual separation of reasoning blocks vs regular text; toggle for reasoning visualization
- Double Esc to interrupt an active stream without exiting CLI
- `@`-file references with fuzzy scoring and match highlights in input
- Human-readable tool call rows with action label and detail line for every tool type
- Full provider connection flow via step-by-step screen
- Full Markdown element set with streaming (no flicker), GFM tables, syntax highlighting
- Shared syntax highlight engine with language aliases and guardrails (512 KB / 10,000 lines)
- Built-in platform constraints — no silent "improvement" steps outside explicit requests
- Bootstrap profile — one-time context collection about user and project stack
- Notification channel for daemon tasks: `~/.umbra/notifications.jsonl`
- `/full` flag — increases context limits and disables compression

### Web Search

- `web.search` and `web.fetch` tools — external search isolated from local `search.rg`
- `/web` command — interactive menu for on/off, mode (`cached` / `live`), provider, status
- Providers: DuckDuckGo (default, zero-config), SearXNG (self-hosted), Jina Search, Brave Search, Tavily
- Auto-migration: paid providers without API key → auto-switch to DuckDuckGo
- `web.fetch` 404s return structured failed-result instead of crashing the tool loop
- `web.search` gated by `agent` / `exec` permission policy
- Web provider status in `umbra doctor`

### TUI Theming

- 40 built-in themes including original Umbra dark scheme, plus `aura`, `dracula`, `tokyonight`, `catppuccin`, `nord`, `gruvbox`, `monokai`, `vscode-default`, `hacker`, `retro`, and many more
- `/theme` command — interactive picker with live search and virtual window
- Theme persisted in `~/.umbra/runtime-preferences.json`, restored on every launch
- Dynamic apply — new colors take effect immediately

### Workspace Trust & Context Switching

- `fs.cd` — switches active `projectPath`; auto-reloads `AGENTS.md`, Repo Map, `MEMORY.md`
- TUI status bar updates CWD instantly after switch
- Trusted paths registry (`~/.umbra/trusted-paths.json`)
- Trust prompt on `fs.cd` to untrusted path — Allow / Deny / Always Allow
- CWD auto-added to trusted paths on `umbra init`

### Deep Context & Token Management

- `/goal <text>` — sets active session goal; displayed in TUI status bar; injected into system prompt in `--exec`
- Completed goal auto-written to project `MEMORY.md` after `--exec` finishes
- Sliding window with `currentTurnTokenBudget` — hard stop on exhaustion, no silent truncation
- Auto-compression applies only to LLM payload, never to TUI display
- `/think <N> | off` — reasoning budget control (Anthropic); `think:Nt` in status bar
- Dynamic thinking menu adapting to model type (`effort_levels` / `budget` / `toggle`)
- `/review` — structured code review (Security / Logic / Style / Tests) on staged+unstaged changes
- `/review staged`, `/review <file>`, `/review settings` — dedicated review provider/model

### Skills System & Custom Commands

- Hierarchical instruction file search from current directory up to disk root
- Supported formats: `UMBRA.md` (priority), `AGENTS.md`, `CLAUDE.md`, `CODEX.md`, `GEMINI.md`, `QWEN.md`, `SYSTEM.md`
- Context merging: parent rules merged with local; local takes priority on conflict
- Global scope: `~/.umbra/UMBRA.md` and `~/.umbra/AGENTS.md` mixed into all projects
- `SKILL.md` parser with YAML frontmatter (`name`, `description`, `disable-model-invocation`, `argument-hint`)
- Skills from global (`~/.umbra/skills/`) and project-local (`.umbra/skills/`) directories
- Dynamic context injection via shell commands in skills (`` !`git status` `` syntax)
- Dynamic slash command registration from loaded `SKILL.md` files
- Autocomplete, argument mapping (`$ARGUMENTS`, `$0`, `$1`), visual execution indicator
- `/skill-create` — interactive TUI wizard to scaffold `.umbra/skills/<name>/SKILL.md`

### Fixed

- OpenCode Zen provider stream usage type assertions cleaned up
- `@huggingface/transformers` native binding loaded lazily — no crash on import
- Shell tool tests use platform-aware commands for Linux/Windows compatibility
- Exec harness `check.ps1` invoked with `pwsh` on Linux/macOS, `powershell` on Windows
- Test fixture files `.env` and `daemon.log` added to git via `.gitignore` negation rules
- Web search default mode aligned across source and tests
