# Changelog

All notable changes to this project will be documented in this file.

## [0.2.0] - 2026-06-15

### Added

- `Ctrl+O` toggles live tool-call diff/code previews between `expanded` (shown immediately as `fs.write`/`fs.edit` happen, while the run is still streaming) and `compact` (hidden until the run finishes). Defaults to `expanded` and persists across sessions. The current mode is shown next to the busy spinner (`Ctrl+O: diffs expanded`)
- Agent loop turn cap re-added as a generous safety net (`MAX_AGENT_TURNS = 40`): if the model never stops requesting tools, the run now ends with a clear "turn safety limit" message instead of looping forever

### Changed

- **`fs.edit` rewritten from unified-diff patches to exact string replacement** (`oldString` / `newString` / `replaceAll`), matching how Claude Code's and opencode's edit tools work. No more `@@ -a,b +c,d @@` hunk headers or line numbers — the model copies `oldString` verbatim from a recent `fs.read`/`search.rg` result, and the edit fails with a clear, actionable error if `oldString` isn't found or matches multiple locations (unless `replaceAll: true`). This eliminates the repeated "Invalid unified diff hunk header" / "Patch context mismatch" failure loops that were causing oversized reasoning blocks and runaway re-read/retry cycles
- The agent system prompt's `fs.edit` guidance was rewritten to match: no more "don't compute line numbers" caveats — there are no line numbers at all
- Live run view no longer hides events behind a `··· N events` counter or a 3-entry sliding window — every tool call, message and status update appears in place, in chronological order, as it happens

### Removed

- `src/tools/unified-diff.ts` — the unified-diff patch parser/applier, no longer used by `fs.edit`

## [0.1.12] - 2026-06-15

### Added

- TUI tool-call code/diff previews and ` ```diff ` markdown blocks now render with a highlighted background: the whole preview gets a filled background (previously it was bare colored text with no block background at all), and added/removed diff lines get a full-width green/red tinted highlight band, derived from the active theme's `success`/`danger` colors (Codex-style)
- Debug log now writes the full, untruncated reasoning text for any LLM response whose reasoning exceeds 800 chars to `debug/reasoning/<requestId>.txt`, with the file path recorded as `reasoningFile` in the `incoming llm response` event — previously only an 800-char `reasoningPreview` was ever persisted, no matter how long the actual reasoning was

### Changed

- The `fs.edit` diff preview in tool-call cards no longer shows raw `@@ -a,b +c,d @@` hunk headers — they're parsed and dropped, and each diff line now gets a left-side gutter with its real old/new line numbers instead (Codex-style)
- Strengthened the agent's reasoning-efficiency rules: reasoning must never restate, re-derive, or "draft" code/diffs the user already saw in a tool result (it's never shown to the user, so it was pure wasted tokens), and the model is now told not to call `fs.read` again on a file it has already seen and that hasn't changed since
- `fs.edit`'s tool description and the reasoning-efficiency rules now explicitly say that `@@ -oldStart,oldCount +newStart,newCount @@` line numbers are only a starting hint for the fuzzy content-based anchor search — the model should not spend reasoning computing or verifying exact line numbers, only the context/removed line content needs to be exact

### Fixed

- Resumed-session transcripts (`/sessions` history view) now render the same syntax-highlighted code/diff preview below `fs.write`/`fs.edit` tool-call cards as a live run does — previously only live runs got the preview, and reopening a past session showed the card with no code at all
- Cross-run conversation history no longer keeps multiple full copies of the same file's content: when a file is read more than once (or read and then edited) in the same thread, only the most recent `fs.read` result keeps its full content — earlier copies are replaced with a short "stale, see newer result" placeholder, cutting redundant input tokens on long sessions

## [0.1.11] - 2026-06-15

### Fixed

- The agent loop no longer aborts a run with "Agent loop reached the maximum turn limit." after 12 turns. The hard cap (`MAX_AGENT_TURNS = 12`) was an arbitrary limit that killed legitimate multi-step tasks (e.g. a multi-file edit that needs several read/search/edit round-trips) right as the model was about to finish — the run now continues until the model itself stops requesting tools (or the user cancels it)
- Debug log now records an `agent loop turn started` event for every turn (with the turn number and message count), making it possible to see how many turns a run actually took

## [0.1.10] - 2026-06-15

### Fixed

- `fs.edit` no longer fails patches whose text ends with a trailing newline (the normal case for LLM-generated patches) with a spurious "Patch context mismatch". Previously the trailing `\n` produced a phantom empty hunk line that, after the 0.1.8 lenient-prefix fix, was treated as "this hunk must be followed by a blank line in the file" — a condition almost never true, which made the anchor search fail even when the hunk's real context existed nearby
- `fs.read`'s `offset`/`limit` are now 0-based line numbers instead of raw byte offsets — previously a model requesting `offset: 25, limit: 25` (expecting lines 25-50) got 25 raw bytes starting at byte 25, which on non-ASCII files (e.g. Cyrillic, emoji) sliced through the middle of a multi-byte UTF-8 character and returned garbled text. The output now also reports `totalLines`

## [0.1.9] - 2026-06-15

### Fixed

- TUI input no longer turns into a garbled mess with the cursor jumping around when pasting long or multi-line text. Bracketed paste mode (via Ink's `usePaste`) is now enabled for the main prompt input, so pasted text is inserted as a single buffer update instead of being streamed character-by-character — previously every `\n`/`\r` inside the pasted text was interpreted as an Enter keypress and submitted the buffer as a separate prompt mid-paste
- Scrolling the TUI history (PageUp/PageDown) during an active agent run no longer teleports the view back to the bottom or jitters constantly. The scroll position is now a stable absolute anchor that doesn't shift when new entries are appended mid-run, and the ticking live UI (spinner, elapsed timer, live tool-call preview) is hidden while scrolled so it stops forcing full-screen redraws — previously tool-call cards and code blocks near the top could intermittently vanish during a scroll

## [0.1.8] - 2026-06-14

### Added

- Debug log now records detailed `fs.edit` patch processing: the full raw patch text, the parsed hunks (with any lines missing a valid `' '/'+'/'-'` prefix flagged), and the anchor position resolved for each hunk (declared vs. actual, including fuzzy-match offset) — previously the patch text was truncated to 800 chars and none of this internal state was visible

### Fixed

- `fs.edit` no longer fails the entire patch with "Unsupported unified diff line" when a hunk line is missing its leading `' '/'+'/'-' ` prefix (e.g. a forgotten space before a trailing context line like `</html>` on a large hunk) — such lines are now treated as context with their full text, matching how lenient patch tools behave. Previously-working patches are unaffected; only previously-failing ones now succeed

## [0.1.7] - 2026-06-14

### Fixed

- `search.rg`'s fallback engine (used when the `rg` binary isn't available) now matches `pattern` as a regex, mirroring ripgrep's own behavior — previously it did a literal substring match, so any regex-special-character pattern (e.g. `this\.score\[this\.winner\]\+\+`) silently returned zero matches and pushed the agent into broken `shell.exec` workarounds
- `fs.edit` now searches the entire file for a hunk's context when the `@@` line number is wrong, instead of giving up after ±50 lines — LLM-generated patches can be off by hundreds of lines even when the context itself is copied correctly
- New runs in an existing session/thread now reconstruct prior tool calls and their results (not just text messages) into the conversation sent to the model — previously every new prompt started with zero memory of files already read or commands already run, causing the agent to re-read the same files on every turn. The reconstructed history is capped at ~24k tokens, trimmed oldest-first

## [0.1.6] - 2026-06-14

### Added

- TUI tool-call cards for `fs.write`/`fs.edit` now show a syntax-highlighted code preview (new file content) or unified diff (patch) right below the summary, with a 40-line cap
- Debug log (`~/.umbra/debug/`) now records every tool call's result — status, error, issues, arguments and output (truncated/collapsed to one line) — previously only the permission decision was logged, making tool failures (e.g. `fs.edit` patch mismatches) invisible in the debug log
- Debug log now records reasoning content size and a preview for every LLM response, plus a per-message `reasoningContentLengths` array on each outgoing request, to track exactly how much "thinking" is produced and confirm old reasoning is dropped between turns

### Changed

- Syntax highlighting engine migrated to Shiki (TextMate grammars, same engine as VS Code) — replaces the previous regex tokenizer
- The entire Shiki language bundle (~190 grammars: HTML, Markdown, PHP, XML, Vue, Svelte, Dockerfile, PowerShell, TOML, INI, GraphQL, Dart, Swift, Lua, Makefile, Perl, R, Terraform, Protobuf, Elixir, Haskell, Clojure, Nix, CMake, Zig, Solidity, GDScript, WASM, and many more) is preloaded at startup, replacing the previous 13-language regex tokenizer
- JSX and TSX now use their own dedicated grammars instead of being highlighted as plain JavaScript/TypeScript

### Fixed

- System prompt now tells the agent the tool-call card already shows a syntax-highlighted preview/diff for `fs.write`/`fs.edit` — stops models from re-pasting entire file contents as markdown code blocks in chat replies
- `fs.edit` now tolerates patches with slightly wrong `@@` line numbers — if the declared hunk position doesn't match, it searches up to 50 lines around it for the hunk's context before failing
- The agent run no longer ends silently when the model returns a completely empty response right after a failed tool call — the TUI now shows a message that the task may be incomplete
- Fixed runaway token growth on reasoning models (e.g. `big-pickle`): the model's "thinking" output was being re-sent in full on every subsequent request and accumulating turn after turn, sometimes adding tens of thousands of extra input tokens within a single session. Reasoning content is no longer echoed back to OpenCode Zen chat-style models, and older turns' reasoning is now dropped from history before each new request
- System prompt now tells the agent not to restate or reproduce file contents it already retrieved via tool results in its reasoning, to keep "thinking" short and focused
- `fs.edit` tool description now documents the exact unified-diff format with a worked example, and recommends it over `fs.write` for small changes
- `fs.edit` patch mismatch errors now show the expected line, the actual line found in the file, and surrounding context — so the model can fix and retry the patch instead of giving up

## [0.1.5] - 2026-06-11

### Fixed

- `umbra --version` now reads the version from `package.json` instead of a hardcoded string that was stuck on `0.1.0`

## [0.1.4] - 2026-06-10

### Fixed

- `ecosystem.config.cjs` and `config.json` added to package files — fixes PM2 daemon startup after global install

## [0.1.3] - 2026-06-10

### Fixed

- Removed `src/` from package files — fixes `spawn tsx ENOENT` error on global install

## [0.1.2] - 2026-06-10

### Fixed

- `scripts/` directory added to package files — fixes postinstall error on global install

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
