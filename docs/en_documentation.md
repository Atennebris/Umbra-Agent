# Umbra Agent

Every LLM has a hard limit on how much it can see at once — and every token costs money. The bigger your project, the longer your session, the faster you hit that wall. Most AI coding tools either crash into it or blindly stuff the model with everything and burn through your budget in minutes.

Umbra is built around a different approach: **aggressive, layered context management that keeps the model effective within a fixed budget**, no matter how large the project or how long the session runs.

---

## How Umbra manages context

Every request passes through a stack of automatic mechanisms before a single token is sent to the model:

**Repo map** — instead of dumping raw files, Umbra builds a symbol-level AST outline of the entire project (functions, classes, types, imports) across 40+ languages. A 500-file codebase becomes a compact markdown index of ~5–20 KB. Cached for 15 seconds — no re-parsing on rapid consecutive tasks.

**Retrieval packets** — when the agent searches code with `search.rg` or `search.files`, results are compressed into a ranked, token-bounded packet before they reach the model. Raw ripgrep output of 15 KB becomes a 1–2 KB packet. Triggered automatically when the tool output exceeds 1,500 tokens.

**5-level compression** — tool outputs (shell stdout, diffs, logs) are intelligently truncated with head + tail preservation. Critical lines — `Error:`, `TypeError:`, stack traces, exit codes — are always rescued even from truncated sections. Levels range from `lite` (500 max lines) to `ultra` (20 max lines).

**Split-turn** — if the agent makes many tool calls in one turn and the message window approaches the limit, earlier tool pairs are compressed into a summary in-place while the last 3 pairs stay raw. The model never loses recent context.

**Sliding window** — the message history is trimmed from the oldest end when the payload budget (80,000 tokens) is approached. The system message and current turn are always preserved.

**Session compaction** — long sessions are summarized on demand (`/compact`) or automatically. A 50+ event session becomes one structured summary (goals, progress, files touched, failures) plus the last 6 raw events. Savings: 70–90% on accumulated session history.

**Vector memory** — past sessions are stored as embeddings. On each task, only the top 5 semantically similar past memories are injected, bounded to ~2,500 tokens.

**Mode-based budgets** — the context budget and compression level adapt to the task:

| Mode | Context budget | Compression |
|---|---|---|
| `agent` / `plan` | 32,000 tokens | standard |
| `exec` (harness loop) | 32,000 tokens | aggressive |
| `full` | 128,000 tokens | off |

The result: Umbra can work on large codebases, run multi-hour sessions, and iterate through dozens of tool calls — all within the token window your provider gives you, without you managing any of it manually.

---

## What it does

Umbra Agent works as an always-on orchestrator. Give it a task, and it handles the full loop: understanding your codebase, talking to the model, applying changes, running tests, reading errors, and retrying until the job is done.

Key capabilities:

- **Autonomous Harness Loop** — runs your check script, reads failures, sends them back to the model, and iterates until the check passes. No babysitting.
- **Provider-agnostic** — works with OpenAI, Anthropic, Mistral, Ollama (free, local), LM Studio (free, local), OpenCode Zen (free cloud), and any OpenAI-compatible endpoint. Switch anytime.
- **Daemon architecture** — runs in the background via PM2. Queue tasks and manage sessions efficiently.
- **Persistent memory** — one global SQLite database across all your projects. No leftover `.sqlite` files scattered around. Past solutions are indexed and recalled.
- **Local-first** — your code and context stay on your machine. Nothing is sent to third-party services beyond the LLM provider you choose.

---

## Requirements

- **Node.js v22+**
- **pnpm** (preferred) or **npm**

---

## Installation

**curl:**
```bash
curl -fsSL https://umbra.expert/install.sh | sh
```

**PowerShell (iwr):**
```powershell
iwr https://umbra.expert/install.ps1 | iex
```

**npm / pnpm:**
```bash
npm install -g umbra-agent
# or
pnpm add -g umbra-agent
```

> Install scripts (`install.sh` / `install.ps1`) are coming soon — they will handle Node.js, pnpm, and native dependencies automatically.

> Python package — coming soon.

---

## Quick start

```bash
umbra
```

That's it. Running `umbra` starts the background daemon automatically, opens the TUI, and stops the daemon cleanly when you exit. The agent is ready to work immediately.

> **Background mode** — if you want the daemon to keep running without the TUI open (e.g. for headless task queuing), manage it directly:
> ```bash
> umbra daemon start    # start the daemon in the background
> umbra daemon stop     # stop it
> umbra daemon status   # check health and queue depth
> ```

---

## Context Engine & AST Compression

Before every task, Umbra assembles a structured context window and sends it to the model. The engine has a fixed token budget (default **32,000 tokens**, estimated at 4 chars/token) and fills it with ranked sections.

### Context assembly pipeline

```
buildTaskContext()
  ├─ buildRepoMap()           # AST scan of the project tree → markdown outline
  ├─ buildSessionWindow()     # compact old events, keep last 6
  ├─ vector search            # top-N semantically similar past memories
  ├─ loadHierarchicalInstructions()   # rules files walked from global → local
  └─ summarizeTokenSections() # budget report per section
```

### Repo map & AST parsing

The repo map is a compact markdown outline of every significant file in the project. It lists imports and symbols (functions, classes, types, etc.) per file.

Three parsers run in priority order:

| Parser | Languages |
|---|---|
| **`web-tree-sitter`** (full AST) | JavaScript, TypeScript, TSX, Python, Go, Bash, Rust, Java, CSS, Ruby, C#, PHP, PowerShell, C++ |
| **`@bscotch/gml-parser`** (CST) | GameMaker Language (`.gml`) |
| **Regex fallback** | 40+ additional formats: JSON, YAML/GitHub Actions, Markdown, SQL, HTML, TOML, GraphQL, Protobuf, Terraform/HCL, Prisma, Solidity, Zig, Dart, Kotlin, Swift, Lua, Scala, Elixir, Erlang, Haskell, Perl, R, Clojure, Vue, Svelte, Astro, XML, Gradle, GDScript, MATLAB, Nix, Jupyter, WAT/Wasm, Assembly, Dockerfile, Makefile, CMake, `.env`, lockfiles |

### Supported languages

**Full AST** (via `web-tree-sitter` WASM grammars):

- **JavaScript** (`.js`, `.jsx`, `.cjs`, `.mjs`) — `tree-sitter-javascript.wasm`
- **TypeScript** (`.ts`) — `tree-sitter-typescript.wasm`
- **TSX** (`.tsx`) — `tree-sitter-tsx.wasm`
- **Python** (`.py`) — `tree-sitter-python.wasm`
- **Go** (`.go`) — `tree-sitter-go.wasm`
- **Shell / Bash** (`.sh`, `.bash`, `.zsh`) — `tree-sitter-bash.wasm`
- **Rust** (`.rs`) — `tree-sitter-rust.wasm`
- **Java** (`.java`) — `tree-sitter-java.wasm`
- **C / C++** (`.c`, `.h`, `.cpp`, `.cc`, `.cxx`, `.hpp`) — `tree-sitter-cpp.wasm`
- **C#** (`.cs`) — `tree-sitter-c-sharp.wasm` — class, interface, struct, record, delegate, enum, namespace, method, constructor, destructor, property, field, event, operator
- **PHP** (`.php`) — `tree-sitter-php.wasm`
- **Ruby** (`.rb`) — `tree-sitter-ruby.wasm`
- **CSS** (`.css`) — `tree-sitter-css.wasm`
- **PowerShell** (`.ps1`, `.psm1`) — `tree-sitter-powershell.wasm`
- **INI / Config** (`.ini`, `.cfg`) — `tree-sitter-ini.wasm`

**Full AST** (via dedicated parsers):

- **GML / GameMaker 2.3+** (`.gml`) — `@bscotch/gml-parser` CST; symbols: function, constructor, macro, enum, globalvar

**Partial structured parsers** (regex / DOM):

- **JSON** (`.json`) — `JSON.parse`; top-level keys as symbols
- **YAML** (`.yml`, `.yaml`) — `js-yaml`; top-level keys as symbols
- **GitHub Actions / CI YAML** — domain-aware layer on top of YAML; symbols: workflow name, triggers, jobs; `uses:` → imports
- **Markdown** (`.md`, `.mdx`) — heading extractor H1–H4
- **SQL** (`.sql`) — `CREATE TABLE/VIEW/FUNCTION/PROCEDURE/INDEX/TRIGGER`
- **HTML** (`.html`, `.htm`) — ids, landmarks, role attributes, script/style blocks
- **TOML** (`.toml`) — sections `[table]`, top-level keys
- **GraphQL** (`.graphql`, `.gql`) — type, interface, enum, union, input, scalar, query, mutation, subscription, fragment, directive
- **Protocol Buffers** (`.proto`) — message, service, enum, rpc, oneof; imports
- **Terraform / HCL** (`.tf`, `.tfvars`, `.hcl`) — resource, data, module, variable, output, provider, locals
- **Prisma** (`.prisma`) — model, enum, type, datasource, generator
- **Solidity** (`.sol`) — contract, interface, library, function, event, struct, enum, modifier, error; imports
- **Zig** (`.zig`) — fn, const struct/enum/union, var
- **Dart / Flutter** (`.dart`) — class, mixin, extension, enum, functions; imports
- **Kotlin** (`.kt`, `.kts`) — class, interface, object, fun, typealias, enum
- **Swift** (`.swift`) — class, struct, protocol, enum, extension, func, actor, typealias
- **Lua** (`.lua`) — functions, module tables, local requires
- **Scala** (`.scala`, `.sc`) — class, object, trait, def, val, given; imports
- **Elixir** (`.ex`, `.exs`) — defmodule, def, defp, defmacro, defprotocol, defimpl
- **Erlang** (`.erl`, `.hrl`) — module, functions; `-export` lists
- **Haskell** (`.hs`, `.lhs`) — module, data, newtype, type, class, instance, functions; imports
- **Perl** (`.pl`, `.pm`) — package, sub; `use` imports
- **R** (`.r`, `.R`) — functions, R6/RefClass classes; `library`/`require` imports
- **Clojure** (`.clj`, `.cljs`, `.cljc`) — ns, defn, def, defmacro, defprotocol, defrecord, defmulti
- **Vue** (`.vue`) — single-file component; component name + script-block exports
- **Svelte** (`.svelte`) — single-file component; component name + script-block exports
- **Astro** (`.astro`) — single-file component; component name + frontmatter symbols
- **XML** (`.xml`) — element tags, id attributes, name/key attributes
- **Gradle** (`.gradle`, `.gradle.kts`) — plugins, tasks, variables, dependencies
- **GDScript** (`.gd`) — Godot Engine; class_name, func, signal, enum, const, var, @export/@onready; `extends` → import
- **MATLAB / Octave** (`.m`) — classdef, function (all signatures), section markers `%%`, properties/methods/events/enumeration; `import`/`addpath` → imports
- **Nix** (`.nix`) — top-level attrs (col-0 bindings), `mkDerivation`/`mkShell`; `import <nixpkgs>` → imports
- **WebAssembly Text** (`.wat`, `.wast`) — `$func` names, `$global`, `$type`, memory, table, data/elem segments; `(import ...)` / `(export ...)`
- **Assembly** (`.asm`, `.s`, `.S`, `.nasm`) — NASM/GAS/ARM; global labels, section markers, macros, constants, `.type @function`; `extern` → imports
- **Dockerfile** (`Dockerfile`, `.dockerfile`) — FROM stages, EXPOSE ports, ARG, ENV, ENTRYPOINT, CMD
- **Makefile** (`Makefile`, `GNUmakefile`, `.mk`) — targets, uppercase variables; `include` imports
- **CMake** (`CMakeLists.txt`, `.cmake`) — add_executable, add_library, function, macro, project, option, set
- **Env files** (`.env`, `.env.*`) — keys as symbols, values redacted as `***REDACTED***`
- **Log files** (`.log`) — ERROR/FATAL/WARN lines as symbols
- **Jupyter** (`.ipynb`) — kernel name, markdown headings H1–H4, def/class from code cells; `import`/`from` → imports
- **PDF** (`.pdf`) — `pdf-parse` text extractor; heading heuristic from extracted text
- **DOCX** (`.docx`) — `fflate` unzip + `word/document.xml` parser; `<w:pStyle Heading>` detection
- **yarn.lock** — package name + resolved version
- **Cargo.lock** — crate name + version
- **Gemfile.lock** — gem name + version (SPECS section)
- **composer.lock** — PHP package name + version (JSON)

The repo map is **cached in-process for 15 seconds** — rapid consecutive tasks within the same daemon process reuse the cached scan.

### Session compaction

Long sessions are compressed automatically. When `buildSessionWindow()` finds a past `session_compacted` event, it:

1. Uses the stored summary as the session history
2. Keeps only events that occurred **after** the last compaction (up to 6)

On explicit compaction (`compactSessionEvents()`), the engine distills older events into a structured summary (goals, progress, files touched, failures, preserved tail) and emits a `session_compacted` event. Iterative compaction builds a rolling `# Session Update` on top of the previous summary rather than starting over.

### Instruction file hierarchy

Agent rules are loaded from instruction files discovered by walking the directory tree. Priority order (highest last = wins):

```
~/.umbra/UMBRA.md   (global)
~/.umbra/AGENTS.md  (global fallback)
  ↓ ancestor dirs (root → project parent)
  ↓ project dir   UMBRA.md > AGENTS.md > CLAUDE.md > CODEX.md > GEMINI.md > QWEN.md > SYSTEM.md
```

Local rules override global ones because they appear last in the merged string.

### Token budget

Each section is measured independently:

| Section | Content |
|---|---|
| `task` | The user's task description |
| `agents` | Merged instruction files |
| `memory` | Long-term memory text |
| `repo_map` | AST-generated project outline |
| `similar_memories` | Vector-retrieved past context |
| `session_summary` | Compacted session history |
| `recent_events` | Last N raw session events |

The budget report (`withinBudget`, `remainingTokens`) is returned with every context build so the caller can decide whether to trim sections.

---

## Provider Layer

The provider layer is the boundary between Umbra and any LLM API. It is built in three tiers: a **registry** of known provider types, a **profiles store** of your configured connections, and a **gateway** that routes requests and handles failure.

### Provider types

Built-in types (always available):

| Type | Label | Default URL | Key required |
|---|---|---|---|
| `openai` | OpenAI | `https://api.openai.com/v1` | Yes |
| `anthropic` | Anthropic | `https://api.anthropic.com/v1` | Yes |
| `openrouter` | OpenRouter | `https://openrouter.ai/api/v1` | Yes |
| `mistral` | Mistral | `https://api.mistral.ai/v1` | Yes |
| `ollama` | Ollama | `http://127.0.0.1:11434/v1` | No |
| `lmstudio` | LM Studio | `http://127.0.0.1:1234/v1` | No |
| `openai-codex` | ChatGPT Plus/Pro | `https://chatgpt.com/backend-api` | Optional (OAuth) |
| `openai_compatible` | Custom endpoint | *(set per profile)* | Optional |
| `opencode-zen` | OpenCode Zen | `https://opencode.ai/zen/v1` | Optional |

> **Default for new users.** On first launch, if no provider profile is configured, Umbra offers to connect OpenCode Zen automatically. It provides a set of free models with no API key required — enough to try the agent right away. You can switch to any other provider at any time via `umbra providers connect`.


### Profile store

Profiles are persisted in `~/.umbra/providers.json`. Each profile stores:
- `type` — one of the provider type values above
- `label` — human-readable name
- `baseUrl` — the API base URL (overridable per profile)
- `apiKey` — stored locally, never transmitted to Umbra
- `model` — optional default model for this profile
- `extraHeaders` — arbitrary HTTP headers injected on every request
- `options` — provider-specific options map

One profile is marked as `defaultProfileId`. The active profile for each task is resolved at runtime.

### Provider gateway

`DefaultProviderGateway` is the single routing point for all LLM calls. It supports two routing modes:

**By profile (`profileId`)** — calls a single configured profile directly.

**By chain (`chainId`)** — iterates through an ordered list of profile entries; uses the first successful response. This enables automatic fallback across providers without any changes to the task code.

### Request pipeline

```
GatewayRequest
  └─ #prepareRequest()        # optional compression (off / standard / aggressive)
       ├─ compressToolOutput() # for tool result messages
       └─ condenseProse()      # for user/assistant messages
  └─ #withRetries()           # up to 2 attempts
       └─ catalog.completeProfile() / completeProfileStream()
  └─ #logResponse()           # usage accounting + debug events
```

### Retry logic

The gateway retries automatically on transient failures:

- HTTP 429 (rate limited)
- HTTP 5xx (server error)
- `AbortError` (network timeout)
- `fetch failed` (connection refused / DNS)

Non-retryable errors (4xx other than 429, schema validation, unknown profile) are thrown immediately. The backoff between retries is 1 second × attempt number.

### Request schema

Requests are typed and validated with Zod. Key fields:

| Field | Type | Notes |
|---|---|---|
| `model` | `string` | Optional; profile default is used if omitted |
| `messages` | `ProviderChatMessage[]` | Roles: `system`, `user`, `assistant`, `tool` |
| `tools` | `ProviderToolDefinition[]` | Function-calling tools |
| `toolChoice` | `auto \| required \| none` | |
| `responseFormat` | `text \| json_object \| json_schema` | Structured output |
| `thinkBudget` | `number \| low \| medium \| high \| max` | Extended reasoning token budget |
| `compressionLevel` | `off \| standard \| aggressive` | Pre-request message compression |

### Model capabilities registry

`ModelsRegistry` resolves model capabilities (context window, tool support, pricing, vision, reasoning, structured output) by fetching from `models.dev/api.json` with a 5-minute in-memory cache. If the model is not found there, it falls back to the HuggingFace model API, then to heuristic rules based on model name patterns.

Cost estimates (USD) are computed from actual token usage and the per-million pricing in the registry, and written to the usage log alongside each response.

---

## Tools

Every tool the agent can call is defined in the built-in registry (`src/tools/runner.ts`). All inputs and outputs are validated with Zod schemas before and after execution. Tools have a risk class (`read_only` / `write` / `execute`) that the permission system uses to decide whether approval is needed.

### Built-in tool catalogue

**Filesystem**

| Tool | Risk | Description |
|---|---|---|
| `fs.list` | read | List files/directories; supports recursive walk, hidden files, up to 5 000 entries |
| `fs.read` | read | Read a file as UTF-8 with byte-level `offset`/`limit` slicing (max 512 KB per call) |
| `fs.write` | write | Write a full file payload; auto-creates parent directories |
| `fs.edit` | write | Apply **Unified Diff** patches to one or more files in one call |
| `fs.cd` | execute | Change the agent's working directory for the current run |

**Search**

| Tool | Risk | Description |
|---|---|---|
| `search.rg` | read | Full-text regex search via `ripgrep` (JSON output, grouped by file with snippets and context lines); falls back to Node walker when `rg` is not available |
| `search.files` | read | List project files respecting `.gitignore` and standard ignore dirs (`node_modules`, `dist`, `.git`, `__pycache__`, etc.); uses `rg --files` or Node walker |
| `search.fuzzy` | read | Fuzzy-score file paths; returns ranked results with match indices |

**Shell**

| Tool | Risk | Description |
|---|---|---|
| `shell.exec` | execute | Run a command through the host shell (`bash -lc` on Unix, `powershell.exe -Command` on Windows); timeout up to 120 s; stdout/stderr captured; `timedOut` flag |

**Git** *(exposed only when `gitEnabled: true` is set on the run)*

| Tool | Risk | Description |
|---|---|---|
| `git.status` | execute | `git status --porcelain=v1 --branch` — branch, upstream, ahead/behind, per-file index/worktree status |
| `git.diff` | execute | `git diff` patch + numstat; supports `--cached` and configurable context lines |
| `git.apply` | write | Apply a patch via `git apply`; supports `--check` (dry-run) and `--cached` |
| `git.commit` | write | `git commit -m <message>`; optionally `-a` to stage all tracked changes |
| `git.push` | execute | Push branch to remote; uses `--force-with-lease` instead of `--force` |
| `git.pull` | execute | Pull from remote; optional `--rebase` |

**Web**

| Tool | Risk | Description |
|---|---|---|
| `web.search` | execute | Search the web and return ranked URLs with snippets; requires web mode `cached` or `live`; provider-agnostic (DuckDuckGo, Jina, SearXNG, Brave, Tavily) |
| `web.fetch` | read | Fetch a URL as clean markdown via Jina Reader (primary) or raw HTML fallback; `maxChars` up to 100 000 |

### Permission presets

Three presets gate what tools the agent may call without asking:

| Preset | Writes | Execute/Shell/Git |
|---|---|---|
| `chat-readonly` | No | No |
| `agent-default` | Gated by approval | Gated by approval |
| `exec-full` | Yes | Yes |

The permission manager evaluates each non-read-only call against the preset and any stored permission rules. The result is one of `allow`, `ask` (show an approval dialog in the TUI), or `deny`.

### External tools

`rg` and `git` are resolved at runtime from: custom path in `settings.json` → `PATH` → bundled fallback. Status for each external tool is visible in `umbra doctor`.

### Custom tools

Add custom tool paths in `~/.umbra/settings.json` under `tools.customPaths`:

```json
{
  "tools": {
    "customPaths": {
      "rg": "/usr/local/bin/rg",
      "git": "/opt/homebrew/bin/git"
    }
  }
}
```

---

## Orchestration & Autonomous Loop

The `AgentRuntime` class (`src/core/agent-runtime.ts`) is the autonomous execution engine. It wraps every run in a structured lifecycle, sends context to the model, processes tool calls in a loop, and persists all events to the session store.

### Run modes

Each task is dispatched in one of four modes, selected by the caller:

| Mode | Description | Tool preset | Time box |
|---|---|---|---|
| `plan` | One-shot structured plan generation; no tool calls, no edits | none | none |
| `agent` | Interactive turn loop; write/execute tools gated by approval | `agent-default` | none |
| `full` | Interactive loop with full tool access; no approval gates | `exec-full` | none |
| `exec` | Autonomous edit-run-fix harness; runs checks, iterates on failures | `exec-full` | 30 min |

### Agent loop

For `agent` and `full` modes:

```
for turn in 1..MAX_AGENT_TURNS (12):
  1. Send messages[] + tools[] to provider (streaming or batch)
  2. Append assistant_message event
  3. If stop_reason == "end_turn" → done
  4. For each tool_call in response:
       a. Evaluate permission (preset + rules)
       b. Execute tool (validate input → run → validate output)
       c. Append tool_call and tool_result events
       d. Add result to messages as role=tool
  5. Loop
```

### Exec harness loop

For `exec` mode — the autonomous fix loop:

```
for attempt in 1..MAX_EXEC_HARNESS_ATTEMPTS (6):
  1. Run the agent loop (up to 12 turns)
  2. If a check command is present in the result:
       a. Execute the check command via shell.exec
       b. If exit code == 0 → success, stop
       c. Append failure as user message: "Check failed: <stderr>"
       d. Continue to next attempt
  3. If no check command → stop after first agent loop pass
```

The check command is resolved from the project directory: `check.sh` is used on Unix, `check.ps1` on Windows. If neither file exists, the harness skips the check loop and runs a single agent pass. This closes the **write → run → read error → fix** cycle without human intervention.

### System prompt composition

Each run assembles a system prompt from:

1. **Bootstrap context** — OS, Node version, current date, project path, git branch
2. **Mode instruction** — mode-specific rules (plan / agent / exec)
3. **Hierarchical instructions** — merged from `UMBRA.md` / `AGENTS.md` / `CLAUDE.md` etc.
4. **Skills** — loaded from `~/.umbra/skills/` and project-local `skills/`
5. **Memory** — long-term memory text (if `useMemories: true`)
6. **Similar memories** — vector-retrieved past context
7. **Repo map** — AST-generated project outline
8. **Session summary** — compacted history of the current session

### Events

Every agent action is recorded as a typed event and stored in SQLite:

| Event type | When |
|---|---|
| `user_message` | Task prompt received |
| `assistant_delta` | Streaming text chunk |
| `assistant_message` | Full assistant turn |
| `reasoning_delta` | Extended reasoning token chunk |
| `tool_call` | Tool invoked by the model |
| `tool_result` | Tool execution completed |
| `permission_requested` | Approval dialog shown |
| `command` | Check command emitted by model |
| `status` | Run status change |
| `error` | Unhandled error in the loop |

Events are the source of truth for session replay, compaction, and memory generation.

### Extended thinking

Pass `thinkBudget` in the run request to enable extended reasoning:

- Anthropic models: translates to `budget_tokens` (number) or a named tier
- OpenAI o-series: translates to `reasoning_effort` (`low` / `medium` / `high`)
- `null` disables thinking entirely

---

## BYOK — Bring Your Own Key

Umbra never proxies your requests. Every call goes directly from your machine to the provider you choose. Your API key is stored locally in `~/.umbra/providers.json` and is never transmitted to any Umbra service.

### Supported providers

| Provider | Key required | Notes |
|---|---|---|
| OpenAI | Yes | `gpt-4o`, `o3`, etc. |
| Anthropic | Yes | `claude-opus-4`, `claude-sonnet-4`, etc. |
| Mistral | Yes | `mistral-large`, `codestral`, etc. |
| Ollama | No | Local; set `baseUrl` to `http://localhost:11434` |
| LM Studio | No | Local; set `baseUrl` to `http://localhost:1234` |
| OpenCode Zen | No | Free cloud models; **default on first launch** |
| Any OpenAI-compatible | Optional | Point `baseUrl` at any proxy or self-hosted endpoint |

### Connecting a provider

```bash
umbra providers connect
```

This opens an interactive form. Fill in the provider type, your API key, and (optionally) a custom base URL and model. The profile is saved immediately and set as the default.

To manage profiles after the fact:

```bash
umbra providers list           # see all configured profiles
umbra providers use <id>       # change the active profile
umbra providers remove <id>    # remove a profile
```

### Supplying keys via environment variables

Some web-search providers also read keys from the environment at startup, so you can inject them without touching any file:

```
BRAVE_SEARCH_API_KEY=...
TAVILY_API_KEY=...
JINA_API_KEY=...
```

### Switching providers at any time

Umbra resolves the active provider at the start of each task. Change the default profile and the very next task uses the new one — no restart required.

---

## Daemon Initialization & Architecture

Umbra runs a persistent background process (the **daemon**) that owns the task queue, holds the SQLite connection, and exposes an HTTP gateway on `127.0.0.1:8080` (configurable in `config.json`). The CLI is a thin client that talks to this gateway.

### Startup flow

```
umbra start
  └─ ensureDaemonWithPm2()          # registers & starts the PM2 process
       └─ src/core/daemon-entry.ts  # daemon entry point
            └─ startDaemonRuntime()
                 └─ startDaemon()
                      ├─ loadConfig()          # reads config.json
                      ├─ getMemoryManager()    # opens SQLite, loads sqlite-vec
                      └─ HttpGateway.start()   # binds the HTTP port
```

### PM2 process management

The daemon is registered with PM2 under the name `umbra-daemon`. PM2 restarts it automatically if it crashes and persists it across reboots.

```bash
umbra daemon start    # start the daemon in the background
umbra daemon stop     # stop the daemon
umbra daemon status   # show health and queue depth
umbra daemon status --json  # machine-readable output

# short aliases also work
umbra start
umbra stop
umbra status
```

> `umbra daemon status` returns `fetch failed` when the daemon is not running — this is expected, not a bug.

You can also use PM2 commands directly:

```bash
pnpm daemon:start    # start via ecosystem.config.cjs
pnpm daemon:stop
pnpm daemon:delete   # remove from PM2 entirely
```

### Runtime layout

All runtime state lives in `~/.umbra/` by default. Set the `UMBRA_HOME` environment variable to redirect everything to a different path (useful for testing or multi-instance setups).

```
~/.umbra/
├── main.sqlite          # single database for all projects
├── settings.json        # runtime settings
├── providers.json       # provider profiles & API keys
├── sessions/            # session transcripts
├── projects/            # per-project metadata
├── cache/
│   └── transformers/    # cached embedding model weights
├── drafts/
├── exports/
└── debug/
    ├── events.jsonl     # structured debug events
    └── latest.log
```

### Native ABI note

`better-sqlite3` is a native addon. It must be compiled for the exact Node.js ABI used by the PM2 process. If the daemon crashes on startup with a `NODE_MODULE_VERSION` error, run:

```bash
pnpm rebuild:natives:match-daemon
pnpm daemon:delete
umbra start
```

---

## Project Diagnostics

`umbra doctor` runs a full health check and prints a structured report of what is working, what needs attention, and what is broken.

```bash
umbra doctor           # print the report
umbra doctor --fix     # apply auto-fixable issues (e.g. create missing directories)
umbra doctor --json    # machine-readable JSON output
```

### Checks performed

| Check | What it verifies |
|---|---|
| Workspace filesystem | Current directory is readable and writable |
| Umbra memory root | `~/.umbra` exists and is accessible |
| better-sqlite3 native | The native addon loads under the current Node binary |
| Daemon port | `127.0.0.1:8080` is available (or the daemon already holds it) |
| PM2 process | `umbra-daemon` is registered and its PM2 status |
| Daemon health | The HTTP gateway responds with `{ ok: true }` |
| SQLite readiness | Database opens, sqlite-vec loads, embeddings model status |
| Web search provider | Configured provider has the required API key |

Each item reports one of four statuses: `pass`, `warn`, `fail`, or `fixed` (applied by `--fix`). The overall exit code is non-zero if any item is `fail`.

---

## Memory Layer & Vector Store

Umbra maintains a single SQLite database shared across all your projects. There are no per-project `.sqlite` files.

### Database

- **Path:** `~/.umbra/main.sqlite` (or `$UMBRA_HOME/main.sqlite`)
- **Mode:** WAL (`PRAGMA journal_mode = WAL`) for concurrent reads
- **Vector extension:** [`sqlite-vec`](https://github.com/asg017/sqlite-vec) loaded at connection time

### Schema

**`metadata` table** — general-purpose key-value store, scoped by `project_path` and `namespace`. Used for settings, cached values, and any structured data that doesn't need semantic search.

**`vectors` table + per-project virtual tables** — each project gets its own `vec_project_{key}` virtual table backed by `sqlite-vec`. Rows in `vectors` hold the content, source reference, session ID, and the model that produced the embedding. The virtual table holds the raw float vectors for KNN search.

### Embeddings

Embeddings are generated locally via [`@huggingface/transformers`](https://huggingface.co/docs/transformers.js) using the `onnx-community/all-MiniLM-L6-v2-ONNX` model (384 dimensions). The model weights are downloaded automatically on first use and cached in `~/.umbra/cache/transformers/`. No data leaves your machine for embedding.

To check embedding status:

```bash
umbra doctor    # shows "SQLite readiness" with model name, cache path, and ready=true/false
```

### Disabling auto-download

Set `embeddings.autoDownloadEnabled` to `false` in `~/.umbra/settings.json` if you want to pre-provision model weights manually or run in an air-gapped environment.

---

## Gateway, Routing & Token Economy

### Local Gateway & API Normalization

`src/providers/provider-client.ts` implements a dedicated client class per provider wire format, all normalising to the same `ProviderCompleteResponse`. No external SDK is used — every API call is a raw `fetch`.

| Client class | Wire format | Key differences |
|---|---|---|
| `OpenAICompatibleProviderClient` | `POST /chat/completions` (OpenAI Chat) | Base for Mistral, Ollama, OpenRouter, LM Studio, custom |
| `OpenAIProviderClient` | `POST /responses` (OpenAI Responses API) | Different message serialisation; no streaming (falls back to chat) |
| `AnthropicProviderClient` | `POST /messages` (`anthropic-version: 2023-06-01`) | `x-api-key` header; `tool_use` blocks; `cache_creation_input_tokens` |
| `OllamaProviderClient` | `/api/tags` for listing; delegates completions | Normalises Ollama model list format |
| `OpencodeZenProviderClient` | OpenAI-compatible + session/project headers | Free tier; tool-name sanitiser (`.` → `_`); lazy-loaded optional module |

**SSE streaming** is implemented in `OpenAICompatibleProviderClient.completeStream()`. The parser handles two SSE wire formats simultaneously:
- **OpenAI-compatible** — `choices[].delta` chunks + final `usage` with `include_usage: true`
- **Anthropic-format** — `content_block_start / content_block_delta / message_delta` event types (emitted by some proxy-routed models)

The parser detects the format per-event via `isAnthropicStreamFormat()` and merges usage blocks from both sources, preferring Anthropic values when present.

**Thinking / reasoning normalisation** per provider:

| Provider | Mechanism | Param sent |
|---|---|---|
| Anthropic | `thinking: { type: "enabled", budget_tokens: N }` | Named tiers → fixed budgets (low=4k, medium=10k, high=16k, max=32k) |
| OpenAI o-series | `reasoning_effort: low\|medium\|high` | Detected by `^o\d` model pattern + blocklist |
| Mistral Magistral | Built-in (no param) | Nothing sent; response parsed from `thinking` array chunks |
| Mistral small/medium | Optional `reasoning_effort` | Sent only when `thinkBudget` is explicitly set |

### Smart Routing & Provider Chains

`DefaultProviderGateway` supports two routing modes in every call:

**Profile routing** (`profileId`) — direct call to one configured profile.

**Chain routing** (`chainId`) — iterates an ordered list of `{ profileId, model? }` entries. The first successful response is returned; all others are tried silently on failure. Each entry can independently override the model, so a single chain can span multiple providers and model tiers.

Chains are stored in `~/.umbra/providers.json` alongside profiles and are managed via the same CRUD API as profiles.

**Retry policy** (applies to both modes): up to 2 attempts on `429`, HTTP 5xx, `AbortError`, or `fetch failed`. Backoff: 1 s × attempt index.

### Prompt & Tool Output Compression

`src/utils/compression.ts` provides a five-level compression system applied to message history before each provider call.

**Levels:**

| Level | Machine output (max lines) | Search results | Prose |
|---|---|---|---|
| `off` | unlimited | unlimited | unchanged |
| `lite` | 500 | 30 files / 10 snippets | unchanged |
| `standard` | 200 | 20 files / 5 snippets | unchanged |
| `aggressive` | 50 | 10 files / 3 snippets, no context | filler words stripped |
| `ultra` | 20 | 5 files / 1 snippet, no context | filler words stripped |

**`condenseMachineOutput`** — head + tail preservation with automatic critical-line extraction from truncated sections. Lines matching `Error:`, `SyntaxError:`, `TypeError:`, `exit code [1-9]`, stack frames are always rescued even when the surrounding section is dropped.

**`compressToolOutput`** — unified entry point: if the tool result is JSON with `fileBuckets`, applies `compressSearchResults` (sorts by match count, caps files and snippets, optionally strips context lines). All other tool outputs go through `condenseMachineOutput`.

**`condenseProse`** — strips common English filler words (`actually`, `basically`, `literally`, `very`, `just`, etc.) in `aggressive`/`ultra` modes. Applied to `user`/`assistant` messages in history.

**Level selection per run mode:**

| Mode | Compression level |
|---|---|
| `full` | always `off` (128 k context budget) |
| `exec` | always `aggressive` (maximise harness iterations) |
| `agent` / `plan` | from `settings.json → compression.level` (default: `standard`) |

### Usage Accounting, Cost & Route Health

Every provider call appends one line to `~/.umbra/usage.jsonl` via `UsageLogger`. The file is an append-only JSONL — one JSON object per line — and survives daemon restarts.

**`UsageRecord` fields:**

| Field | Description |
|---|---|
| `requestId` | Random per-request ID matching debug events |
| `profileId` / `chainId` | Which profile or chain was used |
| `sessionId` / `threadId` | Conversation identifiers |
| `model` / `route` | Model ID and `profileId/model` composite |
| `inputTokens` / `outputTokens` / `totalTokens` | From provider usage block |
| `reasoningTokens` | Thinking tokens (Anthropic / OpenAI o-series) |
| `cacheReadTokens` / `cacheWriteTokens` | Anthropic prompt cache hit/write |
| `costEstimate` | USD, computed from `ModelsRegistry` pricing |
| `contextLimit` / `contextPercent` | Context window size and fill % |
| `source` | `actual` (from provider) / `estimated` (local) / `mixed` |
| `status` | `success` or `failed` |

**Aggregation methods** on `UsageLogger`:
- `getStats()` — totals across all records
- `getStatsByModel()` — per-model breakdown with `avgCostPerRequest`
- `getStatsByProvider()` — per-profile breakdown
- `getStatsBySession()` — per-session breakdown
- `generateReport()` — formatted text report sorted by total cost

### Global CLI Launch & Working Directory Contract

`bin/umbra.js` is the global entry-point shim. It selects the execution strategy at runtime without recompilation:

```
1. src/cli/main.ts exists?
   → node --import tsx/esm src/cli/main.ts   (dev mode, no build needed)
2. dist/cli/main.js exists?
   → node dist/cli/main.js                   (installed package)
3. Neither → exit 1 with instructions
```

**CLI flags handled by the shim** (stripped before passing to cac):

| Flag | Effect |
|---|---|
| `--debug` | Sets `UMBRA_DEBUG_SIDECAR=1`; opens a sidecar debug console on Windows |
| `--project <path>` | Sets `UMBRA_PROJECT_PATH` env var; overrides CWD for all project-path resolution |

Signals `SIGINT`, `SIGTERM`, `SIGHUP` are forwarded to the child process so Ctrl-C works correctly even when the shim is the process group leader.

On Windows, `.cmd` scripts are spawned via `cmd.exe /d /s /c` to avoid Node.js DEP0190 and handle shim quoting correctly (`src/cli/process-runner.ts`).

### Permissions & Access Policies

`src/core/permissions.ts` implements a three-tier access control system.

**Evaluation order** (most permissive first):

```
1. exec-full mode  →  allow all (sandbox assumption)
2. chat-readonly mode + destructive tool  →  deny
3. Stored rules (most recently added wins)  →  allow / deny / allow_always
4. Non-destructive tool  →  allow without prompt
5. Interactive prompt  →  y / n / a (allow_always)
```

**Destructive tools** (always require evaluation outside `exec-full`):
`shell.exec`, `fs.write`, `fs.edit`, `fs.cd`, `git.status`, `git.diff`, `git.apply`, `git.commit`, `git.push`, `git.pull`, `web.search`

**Rule storage:**
- Global rules: `~/.umbra/permissions.json` — applied to all projects
- Project rules: `<project>/umbra.permissions.json` — applied when `projectPath` matches

**Rule matching** supports exact tool name (`shell.exec`), namespace wildcard (`shell.*`), or global wildcard (`*`). Rules have an optional `expiresAt` ISO timestamp.

**`WorkspaceTrustManager`** tracks trusted directories in `~/.umbra/trusted-paths.json`. `fs.cd` to a path not under any trusted ancestor always triggers an interactive prompt regardless of mode. Choosing "always" registers the path as trusted.

**Interactive prompt** (TTY only) shows the tool name and a human-readable action summary, then reads `y` / `n` / `a`. In non-TTY environments (piped stdin, CI, tests), the answer is automatically `deny`.

All decisions are appended to `~/.umbra/debug/permissions.jsonl` for audit.

### Model Catalogue & UI Normalization

`ModelsRegistry` resolves capabilities for any model ID at runtime:

1. **`models.dev/api.json`** — authoritative dataset; flattened to `provider/model` tuples; cached for 5 minutes in-process
2. **HuggingFace model API** — fallback for models not in models.dev
3. **Heuristics** — name-pattern rules (`-vision`, `-instruct`, `-r1`, `o\d`, context window from common model families)

**Capabilities resolved:** `contextWindow`, `supportsTools`, `supportsVision`, `supportsReasoning`, `supportsStructuredOutput`, `supportsAttachments`, `supportsTemperature`, `longContext` (>100 k), `interleaved` (`reasoning_content` vs `reasoning_details`), `inputModalities`, `outputModalities`, `pricingPerMillion` (input, output, cacheRead, cacheWrite).

**Mistral model dedup** in `listModels()` is multi-pass:
1. Filter non-chat and archived models
2. Exact-ID dedupe
3. Family grouping via iterative suffix stripping (`-latest`, `-2604`, `-3.5`, `-3-5`, `-v2`, `-3`) — handles compound suffixes like `mistral-medium-3-5-2604` in two passes
4. Prefer `-latest` alias over specific version within same family
5. Score and sort by tier (Magistral → Large → Medium → Small → Devstral → Codestral → Ministral → Pixtral → Voxtral → Open → penalty for vibe-cli / labs- / deprecated)

### TUI / Agent & Plan Modes

The TUI is built with **Ink** (React for terminal). Key surfaces:

- **Thread list** — paginated, searchable, archivable; forking creates a new thread from the current session state
- **Session view** — streaming assistant output with `reasoning_delta` and `assistant_delta` events shown separately; tool call / result panels; permission approval dialog
- **Provider selector** — profile list with status badges (`connected` / `available` / `unavailable`); inline connect/test/delete
- **Memory panel** — per-project memory text; toggle `useMemories` / `generateMemories`

**Simple-chat detection** in `resolveRunModeContract()`: prompts of ≤8 words matching a hardcoded greeting set (`hi`, `hello`, `thanks`, `привет`, `спасибо`, etc.) get `toolPreset: null` and no compression. This avoids sending tool schemas and compression overhead for conversational turns.

**Mode selection** at the CLI / API level:
- `umbra` (no args) → opens TUI in `agent` mode
- `umbra exec "<task>"` → headless `exec` mode (harness loop, 30-min timeout)
- `umbra task add "<task>"` → queues a background `agent` run
- HTTP API `POST /run` with `mode: "plan"` → structured JSON plan output

### Markdown Visual Processing

`src/cli/tui/markdown.ts` renders markdown to ANSI escape sequences for terminal display. The renderer is line-by-line — no AST parsing — trading full CommonMark compliance for zero dependencies and instant output.

**Block-level transforms** (applied first):

| Input | Output |
|---|---|
| `# Heading` | Bold + cyan text |
| `## Heading` | Bold + yellow text |
| `---` / `===` | Dim `────────────────────────────────────────` |
| `- item` | Cyan `-` bullet |
| `1. item` | Yellow numbered item |
| `> quote` | Dim `\| quote` |

**Inline transforms** (applied after block transforms):

| Syntax | Output |
|---|---|
| `` `code` `` | Yellow text |
| `**bold**` | Bold text |
| `*italic*` | Dim text |
| `[text](url)` | Cyan `text` + dim `(url)` |

All transforms reset ANSI state (`[0m`) at the end of each match so adjacent styles don't bleed across tokens.

---

## Agent Behavioral Invariants

These are hard rules baked into the system prompt of every agent run. They exist to prevent the agent from taking actions the user didn't ask for, lying about what it did, or making decisions that belong to the user.

### Never pretend — `AGENT_NEVER_PRETEND`

> **CRITICAL RULE:** The agent must NEVER claim to have completed an action (created a file, deleted, executed a command, etc.) without having actually called the corresponding tool in that response.

In practice this means:

- If no tool call was made, the agent must not write "Done", "Created", "Executed", or any phrase implying success.
- If a tool call was **denied** by the permission system or returned an **error**, the agent must tell the user the action was NOT completed and explain why — never fabricate a success message.
- When uncertain whether it can perform an action, the agent calls the tool and lets the result speak for itself.

This invariant closes the gap between the model's language ("I created the file") and reality (no `fs.write` call happened). It is not a guideline — it is injected as a `CRITICAL RULE` into every system prompt regardless of mode.

### Do only what was asked — `AGENT_DO_ONLY_ASKED`

> **CRITICAL RULE:** Perform ONLY the exact action the user requested. Do NOT create, modify, rename, or delete anything extra.

Concrete enforcement:

| Trigger | Forbidden extras |
|---|---|
| "Create folder X" | `.gitkeep`, `README.md`, `.gitignore`, index files, any unlisted file |
| "Edit file Y" | Reformatting unrelated code, adding comments, adding unnecessary imports |
| "Add function Z" | Refactoring surrounding code, renaming variables, fixing unrelated style |

If the agent is uncertain whether something counts as "extra" — it does not do it and asks first.

### Retrieval-first — don't read before searching

Before reading a large file or listing a broad directory, the agent must use `search.rg` or `search.files` to narrow scope first. Reading a file whose symbol location is already known wastes tokens and slows the loop. The rule:

- `search.rg` — for symbol or text search inside the project
- `search.files` — for file discovery by name or glob
- Full file read — only when search alone is insufficient

### Language neutrality

The user's message language never determines which sources, services, or domains to use. The agent always prefers globally best-quality and most authoritative sources regardless of query language. Redirecting to localized service variants (`.ru`, `.cn`, regional mirrors) based on the user's language is explicitly forbidden.

### Permission gates are by design

All destructive tool calls (`shell.exec`, `fs.write`, `fs.edit`, `git.commit`, `git.push`, etc.) require explicit approval in `agent-default` mode. The agent does not attempt to bypass the permission dialog or retry a denied call. If a git task is requested but git tools are not enabled, the agent informs the user to run `/git on` first — it does not silently fall back to `shell.exec git ...` without disclosure.

### Simple chat — no tool calls for greetings

Prompts of ≤ 8 words that match known greeting patterns (`hi`, `hello`, `thanks`, `привет`, `спасибо`, etc.) receive `toolPreset: null`. No tools are attached to the model request, no repo map is built, no compression is applied. The agent replies directly. This is enforced at the mode-contract level, not via a prompt instruction — the tool list is literally empty in the request.

---

## Web Search (`web.search` + `web.fetch`)

Use `/web` in the TUI to open the web search settings menu (mode toggle + provider picker), or edit `webSearch.mode` directly in `~/.umbra/settings.json`.

### Modes

| Mode | Behaviour |
|---|---|
| `off` | `web.search` throws immediately — the tool is not even presented to the model |
| `cached` | Searches use provider's default cache behaviour (cheaper, may return stale results) |
| `live` | Forces fresh results — `X-No-Cache: true` for Jina, `search_depth: advanced` for Tavily, no difference for others |

### Providers

| Provider | ID | Key required | Type | Notes |
|---|---|---|---|---|
| DuckDuckGo | `ddg` | No | SERP | Default; HTML scraping via POST to `html.duckduckgo.com/html/`; no API, no quota |
| Jina Search | `jina` | No (optional) | Neural | Free without key (plain-text format); JSON responses and higher limits with `JINA_API_KEY` |
| SearXNG | `searxng` | No | SERP | Self-hosted; set `SEARXNG_BASE_URL` to your instance; optional `SEARXNG_API_KEY` |
| Brave Search | `brave` | Yes | SERP | `BRAVE_SEARCH_API_KEY`; returns `extra_snippets` field |
| Tavily | `tavily` | Yes | Neural | `TAVILY_API_KEY`; `search_depth: advanced` in `live` mode |

Auto-fallback: when activating web search without specifying a provider, Umbra picks the first provider that is either key-free or already has a key configured.

### Auth resolution

For each provider, the key and base URL are resolved in priority order:

```
1. Environment variable (BRAVE_SEARCH_API_KEY, JINA_API_KEY, etc.)
2. ~/.umbra/settings.json → webSearch.providers.<id>.apiKey
3. Default (key-free providers only)
```

The resolved `authSource` is reported in `umbra doctor` output: `env` / `runtime` / `default` / `missing`.

### Switching providers

```bash
# In the TUI — open the /web menu and select a provider with arrow keys

# Or edit ~/.umbra/settings.json
{
  "webSearch": {
    "mode": "live",
    "providerId": "brave",
    "providers": {
      "brave": { "apiKey": "BSA..." }
    }
  }
}
```

### Domain filtering

`web.search` accepts an optional `domains` array. Each entry is appended as a `site:` filter to the query before it is sent to the provider:

```
query: "sqlite WAL mode"
domains: ["sqlite.org", "fly.io"]
→ sent as: "sqlite WAL mode site:sqlite.org site:fly.io"
```

### `web.search` — what it returns and what it doesn't

`web.search` returns a ranked list of `{ rank, title, url, snippet, displayUrl }`. Snippets are **short static previews** extracted from the provider's index — they do NOT contain live data (current time, prices, live scores, real-time weather).

For any question requiring live or current data, the agent is instructed to follow up with `web.fetch` on one of the returned URLs to read the actual page content.

### `web.fetch` — full page as markdown

`web.fetch` fetches a URL and returns clean text with a `maxChars` cap (default 20 000, max 100 000).

**Two fetch modes:**

| Mode | How it works |
|---|---|
| `reader` (default) | Proxies through Jina Reader (`r.jina.ai`); returns structured markdown with title; no key needed (optional `JINA_API_KEY` for higher limits) |
| `raw` | Direct `fetch` to the URL; strips `<script>`, `<style>`, comments, HTML tags; decodes HTML entities |

`reader` mode fails gracefully: if Jina Reader returns an error or a non-OK status, `web.fetch` automatically retries in `raw` mode. If even the raw fetch fails (non-2xx), the tool returns a descriptive error string instead of throwing — the model can read the error and try a different URL.

### Settings reference

```json
// ~/.umbra/settings.json
{
  "webSearch": {
    "mode": "off",
    "providerId": "ddg",
    "providers": {
      "ddg":     { "apiKey": null, "baseUrl": null },
      "jina":    { "apiKey": null, "baseUrl": null },
      "searxng": { "apiKey": null, "baseUrl": "http://localhost:8080" },
      "brave":   { "apiKey": null, "baseUrl": null },
      "tavily":  { "apiKey": null, "baseUrl": null }
    }
  }
}
```

`baseUrl` overrides the provider's default endpoint — useful for SearXNG instances or corporate proxies.

---

## Skills System & Multi-Agent Context

Skills are reusable instruction templates that extend the agent without touching source code. They live as `SKILL.md` files and are invoked in the TUI with a `/skill-name [args]` slash command.

### Directory layout

```
~/.umbra/skills/              ← global skills (available in every project)
  deploy/
    SKILL.md
  summarise/
    SKILL.md

<project>/.umbra/skills/      ← project-local skills (override global on name collision)
  test-watch/
    SKILL.md
```

Each skill lives in its own named subdirectory. The subdirectory name becomes the skill name if the frontmatter omits `name:`. Project-local skills take precedence over global ones with the same name.

### `SKILL.md` format

```markdown
---
name: deploy
description: Deploy the project to the staging environment
argument-hint: <environment>
disable-model-invocation: false
---

Deploy $1 environment.

Current git status:
!`git status --short`

Run the deploy script and confirm the service is healthy.
```

**Frontmatter fields:**

| Field | Required | Description |
|---|---|---|
| `name` | No (falls back to dir name) | Lowercase a–z, 0–9, hyphens; max 64 chars; no leading/trailing/consecutive hyphens |
| `description` | Yes | One-line summary; shown in TUI autocomplete and injected into the system prompt |
| `argument-hint` | No | Placeholder shown in autocomplete, e.g. `<branch-name>` |
| `disable-model-invocation` | No | `true` → skill is user-invocable only; not listed in the LLM system prompt |

### Argument substitution

| Pattern | Expands to |
|---|---|
| `$1`, `$2`, `$3` | First, second, third space-separated word |
| `$ARGUMENTS` or `$@` | All arguments joined as a single string |
| `${@:2}` | All args from position 2 onward |
| `${@:2:3}` | Args 2 through 4 (bash-style slice) |

**Choosing between `$1` and `$ARGUMENTS`:** use `$1`/`$2` only when the skill has clearly distinct positional flags (e.g. branch name + environment). For natural-language input ("find the bug in the auth module"), always use `$ARGUMENTS` — splitting a sentence into `$1 $2` produces garbage.

### Shell injection

Commands embedded in the skill body are executed at invocation time, before the content is sent to the model. The output replaces the injection marker.

**Inline:** `` !`command` `` — single-line output

**Block:**
````
```!
git log --oneline -10
```
````

Both forms run with the agent's current `cwd` (10-second timeout). Errors produce `[shell error: ...]` inline instead of aborting.

### How invocation works

```
User types:  /deploy staging

1. Parse args: ["staging"]
2. substituteArgs(content, ["staging"])   → $1 → "staging"
3. expandShellInjections(content, cwd)    → !`git status` → actual output
4. Prepend: "The user ran: /deploy staging\nExecute the following skill instructions now:\n\n..."
5. Send as the user message to the agent loop
```

### System prompt integration

At the start of each run, `formatSkillsForPrompt()` injects an `<available_skills>` XML block into the system prompt listing every skill where `disable-model-invocation` is not `true`. This lets the model know which skills exist and suggest them autonomously when relevant:

```xml
<available_skills>
  <skill>
    <name>deploy</name>
    <description>Deploy the project to the staging environment</description>
    <location>/home/user/.umbra/skills/deploy/SKILL.md</location>
  </skill>
</available_skills>
```

Skills with `disable-model-invocation: true` are excluded from this block — they are user-only shortcuts and the model cannot suggest them.

### TUI autocomplete

Typing `/` in the TUI input field opens the skill picker. The `argument-hint` value is shown as a placeholder after the skill name. Skills are listed alphabetically with their description. The picker is fuzzy-searchable.

---

## Custom Commands & TUI Integration

The TUI exposes slash commands handled client-side before the message reaches the daemon. Most commands open an **interactive menu** navigated with arrow keys and confirmed with Enter — only a few take a direct inline argument.

### Session & thread management

| Command | Interaction |
|---|---|
| `/clear` | Start a new thread immediately |
| `/new` | Start a new conversation context |
| `/resume` | ↕ Pick a previous thread to resume |
| `/thread` | ↕ Thread menu — resume / fork / archive / export / import |
| `/compact [instructions]` | Summarise older history; optional free-text instructions inline |
| `/compact settings` | ↕ Pick provider and model used for compaction |
| `/goal [text\|clear]` | Set a session goal shown in the status bar and injected into the system prompt; `/goal clear` removes it |
| `/status` | Ping the daemon and print queue health |
| `/help` | Show the TUI command cheatsheet |

### Runtime mode

| Command | Interaction |
|---|---|
| `/agent` | Switch to agent mode (approval gates on destructive tools) |
| `/full` | Switch to full mode — all tools auto-allowed, no dialogs, 128 k context |
| `/plan` | Switch to plan mode — structured JSON output, no execution |

Mode changes take effect on the next message send.

### Git tools

| Command | Interaction |
|---|---|
| `/git` | ↕ Menu — enable / disable / show status |
| `/git on` | Enable git tools for this session |
| `/git off` | Disable git tools |

### Web search

| Command | Interaction |
|---|---|
| `/web` | ↕ Menu — toggle mode (off / cached / live) and switch provider |

### Memory

| Command | Interaction |
|---|---|
| `/mem` | ↕ Memory menu — citations panel toggle, memory settings |
| `/memories` | ↕ Memory settings menu |
| `/mem on` | Show memory citations panel after each response |
| `/mem off` | Hide memory citations panel |
| `/reset memories` | ↕ Confirmation dialog — wipe local memories and project summary |

### Providers & models

| Command | Interaction |
|---|---|
| `/providers` | ↕ Provider menu — connect, add, use, list models, test, remove |
| `/provider connect` | Multi-step dialog — type → key → base URL |
| `/provider use` | ↕ Pick a configured profile to set as default |
| `/provider models` | ↕ List and select a model for the active provider |
| `/models` | Alias for `/provider models` |

### Code review

| Command | Interaction |
|---|---|
| `/review` | Review uncommitted changes (staged + unstaged) |
| `/review staged` | Review staged changes only |
| `/review <file>` | Review a single file |
| `/review settings` | ↕ Pick provider and model used for reviews |

### Extended thinking

| Command | Interaction |
|---|---|
| `/think` | ↕ Set reasoning token budget or disable (Anthropic models only) |
| `/think <tokens\|off>` | Set directly inline: e.g. `/think 10000` or `/think off` |

### Appearance & preferences

| Command | Interaction |
|---|---|
| `/theme` | ↕ Theme picker with search — 40+ built-in themes |
| `/usage` | ↕ Toggle per-request token stats: off / compact / full |
| `/path` | ↕ Toggle project path display in the status bar |

### Skills

| Command | Interaction |
|---|---|
| `/skill-create` | Multi-step dialog — enter name → enter description → agent generates `SKILL.md` |
| `/<skill-name> [args]` | Invoke any skill defined in `SKILL.md` files |

### Project setup

| Command | Interaction |
|---|---|
| `/init` | Scaffold `AGENTS.md` and local check scripts |
| `/permissions` | ↕ Permission mode picker — Default / Full Access |

---

### Headless CLI commands (outside TUI)

```bash
umbra daemon start                  # start the daemon in the background
umbra daemon stop                   # stop the daemon
umbra daemon status                 # show health and queue depth
umbra daemon status --json          # machine-readable output
umbra task add "<task>"             # queue a background agent run
umbra exec "<task>"                 # headless exec-mode harness run + exit
umbra exec "<task>" --time 5m       # exec with explicit time limit
umbra doctor                        # full health check
umbra doctor --fix                  # health check with auto-repair
umbra doctor --json                 # machine-readable output
umbra trust list                    # list trusted workspace paths
umbra trust remove <path>           # remove a trusted path
umbra context [dir]                 # print repo map to stdout
umbra debug [--interval <ms>]       # tail live debug events (JSONL)
umbra usage                         # print usage report from usage.jsonl
umbra init [dir] [--force]          # scaffold instruction file
umbra providers list [--json]       # list configured provider profiles
umbra providers add <type> <label>  # create a provider profile
umbra providers connect [type]      # OAuth / interactive provider setup
umbra providers use <id>            # set default provider profile
umbra providers models [id]         # list models for a provider
umbra providers test <id>           # test a provider connection
umbra providers catalog [--json]    # browse the model catalog
umbra providers remove <id>         # delete a provider profile
umbra permission [mode]             # manage permission mode interactively
```

### Launch flags

These flags modify the behaviour of `umbra` (the default TUI launcher). They can also be passed to `umbra tui`.

| Flag | Effect |
|---|---|
| `--exec` | Autonomous mode — routes to the exec harness loop without confirmation prompts |
| `--debug` | Open the debug event monitor instead of the TUI |
| `--doctor` | Run environment diagnostics and exit (same as `umbra doctor`) |
| `--prompt <text>` | Send a single prompt non-interactively and exit |
| `--project <path>` | Use this directory as the project root instead of the current shell `cwd` |
| `--mode agent` | Agent mode — approval gates on destructive tools (default) |
| `--mode full` | Full mode — all tools auto-allowed, 128 k context, no compression |
| `--mode plan` | Plan mode — structured JSON output only, no tool execution |
| `--update` | Check for updates and install if available, then exit |
| `--web off` | Disable web search on launch |
| `--web on` / `--web cached` | Enable web search (cached results) |
| `--web live` | Enable web search with forced fresh results |

```bash
umbra                               # open TUI (agent mode)
umbra --mode full                   # open TUI in full mode
umbra --mode plan                   # open TUI in plan mode
umbra --web live                    # open TUI with live web search enabled
umbra --project /path/to/dir        # set project path
umbra --prompt "summarise auth.ts"  # send one prompt and exit
umbra --exec                        # autonomous exec harness (no confirmations)
umbra --debug                       # open debug event monitor
umbra --doctor                      # run diagnostics and exit
umbra --update                      # check for updates and install if available
```

**Environment variable alternative for web mode:**
```bash
UMBRA_WEB_SEARCH_MODE=live umbra    # same as --web live
```

### Non-interactive mode

When stdout is not a TTY (piped, CI, IDE extension), `umbra` skips the Ink TUI and prints usage instructions to stdout instead. Use `umbra exec "task"` or `umbra task add "task"` in non-interactive contexts.

---

## Creating Skills — `/skill-create`

### `/skill-create` — AI-assisted generation

```
/skill-create <name> [intent...]
```

Sends the skill creation request to the agent, which uses `buildSkillCreatePrompt()` to generate a fully implemented `SKILL.md` based on the described intent.

**What the agent does (in order, without extra steps):**

1. Create directory `<project>/.umbra/skills/<name>/` (including parents)
2. Write `SKILL.md` with a description derived from intent and a practical body using `$ARGUMENTS` / `$1` substitution as appropriate
3. Reply with the created file path and a one-line summary

**Substitution guidance baked into the prompt:**
- `$ARGUMENTS` = the entire text typed after the skill name (used for natural-language input)
- `$1`, `$2`, `$3` = individual space-separated words (used for positional flags like branch + environment)
- When in doubt → use `$ARGUMENTS`, not `$1`

**Example:**

```
/skill-create git-summary Summarise recent git activity in a readable format
```

The agent writes something like:

```markdown
---
name: git-summary
description: Summarise recent git activity in a readable format
argument-hint: <days>
---

Show a human-readable summary of git activity for the last $ARGUMENTS days (default: 7).

!`git log --oneline --since="$ARGUMENTS days ago" 2>/dev/null | head -30`

Describe what changed, group by author if multiple contributors, highlight any notable patterns or hot files.
```

### Skill lookup precedence

When both global and project-local skills have the same name:

```
project-local wins → ~/.umbra/skills/deploy/  is shadowed by
                      <project>/.umbra/skills/deploy/
```

This allows project-specific overrides of global skills without modifying the global copy.

### Inspecting loaded skills

```bash
umbra debug   # debug JSONL stream includes "skills loaded" events with counts
              # and "skills dir scan" entries showing what was found
```

---

## TUI Theming

The TUI ships with **40+ built-in themes**, all defined in `src/cli/tui/theme.ts`. The active theme is a live singleton (`umbraTheme`) that every Ink component reads — switching themes takes effect immediately without restart.

### Theme object shape (`UmbraTheme`)

| Token | Used for |
|---|---|
| `frame` | Panel borders, window chrome |
| `frameDim` | Dim/inactive panel chrome |
| `accent` | Primary highlights, active selections |
| `accentSoft` | Secondary highlights |
| `skillHighlight` | Skill invocation markers |
| `text` | Main body text |
| `muted` | Secondary/metadata text |
| `success` | Positive outcomes, check marks |
| `warning` | Non-fatal alerts |
| `danger` | Errors, denied permissions |
| `code` | Inline code, tool names |
| `thinking` | Extended reasoning / thinking output |
| `userBackground` | User message bubble background |
| `assistantBackground` | Assistant message bubble background |
| `systemBackground` | Outermost terminal background |

### Built-in themes

`umbra` (default), `aura`, `ayu`, `carbonfox`, `catppuccin`, `catppuccin-frappe`, `catppuccin-macchiato`, `cobalt2`, `cursor`, `dracula`, `everforest`, `flexoki`, `github`, `gruvbox`, `kanagawa`, `lucent-orng`, `material`, `matrix`, `mercury`, `monokai`, `nightowl`, `nord`, `one-dark`, `opencode`, `orng`, `osaka-jade`, `palenight`, `rosepine`, `solarized`, `synthwave84`, `tokyonight`, `vercel`, `vesper`, `zenburn`, `vscode-default`, `classic`, `dark-pro`, `pastel`, `hacker`, `retro`, `snow`, `midnight`

### Switching themes

```bash
/theme dracula         # switch in the TUI
/theme                 # open picker
```

The selected theme is persisted to `~/.umbra/runtime-preferences.json` under the `theme` key and restored on next launch. Fallback is always `umbra` if the stored name is not found.

### Adding a custom theme

Add an entry to the `THEMES` record in `src/cli/tui/theme.ts` with all 15 required tokens and rebuild. Custom themes follow the same lifecycle as built-ins.

---

## Workspace Trust & Context Switching

### Workspace trust

`WorkspaceTrustManager` tracks which local directories the user has explicitly trusted. The trust list is persisted at `~/.umbra/trusted-paths.json`.

**Why it exists:** `fs.cd` changes the agent's working directory — and therefore the scope of every subsequent tool call. Switching into an untrusted directory without acknowledgement could silently expand the attack surface of a running agent. The trust gate ensures the user always sees and approves the target path before the agent can act inside it.

**Evaluation:** when the agent calls `fs.cd`, the permission system checks whether the resolved target path falls under a trusted ancestor:

```
trusted: /home/user/projects
  → /home/user/projects/myapp      ✓  (prefix match)
  → /home/user/projects/myapp/src  ✓  (deeper child)
  → /home/user/other               ✗  → interactive prompt
```

The check is case-insensitive and uses `path.normalize` to handle different path separators.

**User response options** at the interactive prompt:
- `y` — allow this switch once
- `n` — deny
- `a` (always) — trust the path permanently, add to `trusted-paths.json`

Trust entries survive daemon restarts. Removing trust requires editing `~/.umbra/trusted-paths.json` directly.

### Context switching (`fs.cd`)

When the agent switches context via `fs.cd`:

1. The agent's `cwd` for all subsequent tool calls updates to the new path
2. The project path changes — the next turn will load a different repo map, different instruction files (`UMBRA.md`/`AGENTS.md`/etc.), and different permission rules (`umbra.permissions.json`)
3. Conversation history and memory from the old context persist in the session

This makes `fs.cd` a first-class navigation primitive: the agent can move between sub-projects within a monorepo without starting a new thread, while the user retains visibility and control over every directory switch.

### Bootstrap context

On each run, `gatherBootstrapContext()` injects a lightweight system context block into the system prompt:

```
# Platform Bootstrap Context
- OS: linux 6.1.0
- Shell: /bin/bash
- Node: v22.11.0
- Project: /home/user/myapp
- Git: yes
- Package Manager: pnpm
```

The OS username is intentionally **omitted** — it is the machine account name, not the user's real name, and using it would produce awkward "Hello, DESKTOP-XYZ7K!" greetings. The project path, git presence, and package manager are the operationally relevant facts.

---

## Deep Context & Ultra-Economy Settings

### Context budget by mode

| Mode | Token budget | Compression | Notes |
|---|---|---|---|
| `plan` | 32 000 | `standard` | One-shot, structured JSON output |
| `agent` | 32 000 | `standard` (configurable) | Interactive; approval gates |
| `full` | 128 000 | `off` | Full context — no compression |
| `exec` | 32 000 | `aggressive` | Harness loop; maximise iterations |

`full` mode uses a 4× larger budget and disables all compression, trading token cost for maximum fidelity. It is the right choice for complex multi-file tasks where losing context mid-turn would require backtracking.

### Configuring compression level

The default compression level for `agent`/`plan` modes is read from `~/.umbra/settings.json`:

```json
{
  "compression": {
    "level": "standard"
  }
}
```

Valid values: `off` / `lite` / `standard` / `aggressive` / `ultra`. The exec harness always uses `aggressive` regardless of this setting.

### Default runtime mode

Set via launch flag `--mode` when starting Umbra, or switch mid-session using `/agent`, `/full`, or `/plan` in the TUI. The active mode is shown in the session status bar. Persisted across launches via `--mode` flag or `runtime-preferences.json → defaultMode`.

---

## In-Turn Split-Logic (Split-Turn Compression)

`applySplitTurn()` (`src/context/split-turn.ts`) handles a specific failure mode: a single agent turn accumulates many tool calls (read → search → edit → run → read again ...) and the growing message window overflows the context budget **before the turn is finished**.

### When it triggers

The function activates only when all three conditions are true:

1. `estimateJsonTokens(messages) > maxTokens` — the window is over budget
2. There is at least one tool-call/result pair in the **current** turn (after the last user message)
3. The number of pairs in the current turn exceeds `SPLIT_TURN_TAIL_SIZE` (default: **3**)

### What it does

```
Before:
  [system] [history...] [user: "task"] [asst+tools₁] [results₁] ... [asst+toolsₙ] [resultsₙ]

After:
  [system] [history trimmed if still over budget...]
  [user: "task"]
  [user: "[Turn prefix compressed — N earlier tool call(s)]
          ## In-Turn Prefix
          - fs.read(path=src/foo.ts)  → completed
          - search.rg(pattern=foo)    → completed
          ..."]
  [asst+toolsₙ₋₂] [resultsₙ₋₂]   ← tail: last 3 pairs kept raw
  [asst+toolsₙ₋₁] [resultsₙ₋₁]
  [asst+toolsₙ]   [resultsₙ]
```

The **prefix** (all but the last 3 pairs) is replaced by a compact summary listing tool name + key arg + status. The **tail** (last 3 pairs) is kept verbatim — these are the most recent actions and are likely still needed for the next model step.

If the window is still over budget after the split, old conversation history (before the current user message) is dropped from the front, one message at a time, until the budget is met.

### What is preserved

- All `file:line` references from the prefix are described in the summary (tool name + first two args truncated to 40 chars + status)
- The 3 most recent tool pairs are untouched — full JSON, including error output
- The user's original task message is always kept

### Non-activation cases

- Messages fit in budget → returned unchanged
- No active tool exchange detected → returned unchanged
- Pairs ≤ tail size → returned unchanged (nothing to compress)

---

## Retrieval-first Context Packets

`src/context/retrieval-packet.ts` provides **ContextPacket** — a token-bounded, structured summary of large tool results. It sits between the tool executor and the message history: when a search result would balloon the context, the packet replaces the raw JSON before it reaches the model.

### When compression is applied

`maybeCompressSearchResult()` intercepts every completed `search.rg` and `search.files` result. Compression triggers when:

```
estimateTextTokens(JSON.stringify(toolResult.output)) > 1 500
```

Results under 1 500 tokens (~6 000 chars) are passed through as-is.

### Packet token caps per mode

| Mode | Max packet tokens |
|---|---|
| `plan` | 1 000 |
| `agent` | 2 000 |
| `full` | 2 000 |
| `exec` | 3 000 |

### `search.rg` packet

Files are **sorted by match count descending** — the most relevant file appears first. For each file, only the **top snippet** (first match, max 200 chars) is kept. Binary files are detected via a 512-byte scan for non-printable control characters and marked `[binary file — skipped]`. Language is detected from extension (TypeScript, Python, Rust, Go, etc.) and annotated inline.

Output format:

```
[Context packet: search.rg]
Query: MyClass
Files considered: 42 | 87 match(es) across 42 file(s); ranked by match count
src/core/my-class.ts:14:0: (typescript) export class MyClass implements ...
src/tests/my-class.test.ts:3:0: (typescript) import { MyClass } from ...
... [truncated — 1847 tokens used of budget]
```

### `search.files` packet

No ranking — files are listed in scan order up to the token cap. Language tag added per extension.

### Exact references preserved

Every `file:line:column` reference in the packet is kept verbatim. The model can use these directly in subsequent `fs.read` or `search.rg` calls without re-searching. This is the "retrieval-first" contract: search to find the location, then read only what you need.

---

## Request Usage Meter

Usage tracking happens at two levels: **persistent log** (`usage.jsonl`) and **in-session display**.

### Display modes

Configured via `/usage` in the TUI (opens an interactive menu) and persisted in `runtime-preferences.json → usageDetailMode`:

| Mode | What is shown after each response |
|---|---|
| `off` (default) | Nothing |
| `compact` | One line: `↑1234 ↓567 ~$0.0012` (input / output tokens / cost) |
| `verbose` | Full block: model, route, context%, reasoning tokens, cache hit/write, cost |

Migrated from old boolean `showUsageDetail: true` → `compact` automatically on first load.

### What `compact` mode shows

```
↑ 4 218  ↓ 312  cache ✓  ~$0.0031  [claude-sonnet-4/anthropic]
```

- `↑` — input tokens
- `↓` — output tokens
- `cache ✓` — cache hit detected (`cacheReadTokens > 0`)
- `~$0.00xx` — cost estimate from ModelsRegistry pricing × actual tokens
- `[model/provider]` — route identifier

### What `verbose` mode adds

- Context window fill percentage (`contextPercent`)
- Reasoning tokens (for extended thinking models)
- Cache write tokens (Anthropic prompt cache creation cost)
- `source: actual | estimated` — whether figures came from provider or local estimator

### Persistent log

All records are written to `~/.umbra/usage.jsonl` regardless of display mode. The log accumulates indefinitely and can be queried via `UsageLogger.generateReport()`, which prints a text table sorted by total cost per model and per provider.

---

## Built-in Code Review (`/review`)

`POST /review` on the daemon HTTP gateway runs a structured diff analysis using the currently configured LLM and returns a typed `ReviewResult`.

### How it works

```
1. getGitDiffForReview(projectPath, target)
   → executes git diff synchronously (30s timeout, 2 MB buffer)

2. If diff is empty → return { findings: [], overall_correctness: "patch is correct" }

3. Build system prompt (buildReviewSystemPrompt)
   → instructs the model to act as a code reviewer
   → outputs ONLY a JSON object matching the review schema

4. gateway.complete({ profileId, model?, messages, responseFormat: json_schema })
   → uses structured output (json_schema) for reliable schema adherence

5. Parse and return ReviewResult
```

### Diff target options

| `target` value | What is diffed |
|---|---|
| `uncommitted` (default) | `git diff --cached` + `git diff` (staged + unstaged) |
| `staged` | `git diff --cached` only |
| `<file path>` | `git diff HEAD -- <file>` for a single file |

### Review output schema (`ReviewResult`)

```typescript
type ReviewFinding = {
  title: string;              // ≤80 chars, imperative, prefixed [P0]–[P3]
  body: string;               // Markdown, one paragraph max
  confidence_score: number;   // 0.0–1.0
  priority?: 0 | 1 | 2 | 3 | null;
  code_location: {
    absolute_file_path: string;
    line_range: { start: number; end: number };
  };
};

type ReviewResult = {
  findings: ReviewFinding[];
  overall_correctness: 'patch is correct' | 'patch is incorrect';
  overall_explanation: string;  // 1-3 sentences
  overall_confidence_score: number;
};
```

### Priority levels

| Priority | Label | Meaning |
|---|---|---|
| P0 | Drop everything | Blocking bug or security issue — do not merge |
| P1 | Urgent | Significant correctness or performance problem |
| P2 | Normal | Should be addressed before release |
| P3 | Nice-to-have | Style, naming, minor improvement |

### Reviewer configuration

The review uses a separate provider/model setting from the agent, allowing a different (e.g. stronger) model for code review:

```bash
/review settings           # interactive picker in TUI
```

Stored in `runtime-preferences.json` as `reviewProvider` and `reviewModel`. Falls back to the active provider profile if not set.

### Review guidelines baked into the system prompt

- Flag only issues **introduced in the diff**, not pre-existing ones
- Finding body: one paragraph max, concise
- No findings for nitpicks below P3 that don't affect correctness or maintainability
- If no real issues: return empty `findings` array
- `overall_correctness: "patch is incorrect"` only when there are blocking bugs

---

## Backlog

The following features are planned or partially implemented. Items marked with a file path are already scaffolded in the codebase.

**Provider layer**
- Native Anthropic streaming (currently falls back to batch; `completeStream` delegates to `complete`)
- Azure OpenAI endpoint support (variant of `openai_compatible` with tenant auth)
- Google Gemini native API client (non-OpenAI-compatible format)
- Provider health metrics endpoint — surface per-route latency and error rates from `usage.jsonl`

**Context engine**
- Auto-compaction trigger — compact session automatically when `contextPercent` exceeds threshold
- Differential repo map — re-scan only changed files instead of full directory walk on every rebuild

**Memory**
- Project file index (`src/memory/project-files.ts` — scaffolded)
- Notification log (`src/memory/notification-log.ts` — scaffolded)
- Memory export / import — portable `.jsonl` format for sharing context between machines

**Orchestration**
- MCP client integration (`src/core/mcp-client.ts` — scaffolded); expose MCP tools alongside built-ins
- Plugin loader (`src/core/plugin-loader.ts` — scaffolded); load custom tool modules at startup
- Task scheduling — cron-style recurring background runs
- Sub-agent spawning — `exec` mode tasks that launch nested `agent` runs with scoped context

**Tooling**
- `fs.patch` — fine-grained line-range patch tool (complement to `fs.edit` unified diff)
- `browser.screenshot` — headless Chromium integration for UI verification tasks
- Notebook execution (`shell.exec` currently handles `jupyter nbconvert`; native cell-by-cell runner planned)

**CLI & TUI**
- `umbra review` — headless CLI review command (TUI `/review` already works; this tracks a non-interactive variant for CI pipelines)
- Status bar — persistent bottom line showing active model, token usage, queue depth
- Multi-pane layout — side-by-side repo map + session view for large terminals

**Ops & distribution**
- Windows Service / launchd integration — start daemon without PM2
- Signed binary releases via GitHub Actions
- Telemetry opt-in — anonymous usage stats for improving defaults (all data local-first by design)

---

## Contributing

We welcome contributions from participants. Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

---

## License

MIT — see [LICENSE](LICENSE).
