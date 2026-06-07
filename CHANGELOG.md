# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

## [0.1.1] - 2026-06-08

### Fixed

- **OpenCode Zen provider** — cleaned up stream usage type assertions; token counts (`inputTokens`, `outputTokens`, `totalTokens`) are now extracted without redundant casts
- **CI pipeline** — resolved all automated test failures across Node 22 and Node 24:
  - Biome formatter: wrapped long `outputTokens` ternary to satisfy line-length rule
  - `@huggingface/transformers` (onnxruntime-node) no longer crashes the process on import — the native binding is now loaded lazily inside `TransformersTextEmbedder`, so test suites that don't call `embedText()` are unaffected
  - Shell tool tests now use platform-aware commands (`pwd` / `echo` on Linux, `Get-Location` / `Write-Output` on Windows) to match the shell the runtime selects per platform
  - Exec harness check script: `check.ps1` is now invoked with `pwsh` on Linux/macOS and `powershell` on Windows, matching the PowerShell Core binary available on GitHub-hosted runners
  - Agent runtime exec-harness test timeout raised to 20 s to account for `pwsh` cold-start latency on Linux
  - Test fixture files `.env` and `daemon.log` were excluded by `.gitignore` patterns and therefore absent on CI; added targeted negation rules so the files are tracked by git
  - Default web search mode aligned between source and tests (`live` by default, reflected in test expectations)

## [0.1.0] - 2026-06-07

### Added

- Initial public release
- Daemon-first architecture powered by PM2
- TUI interface built with Ink and React
- Provider support: OpenAI, Anthropic, Mistral, Ollama, LM Studio, OpenCode Zen, and any OpenAI-compatible endpoint
- Autonomous Harness Loop — iterates on failing checks without user input
- Persistent session memory with SQLite
- Global memory across projects with vector search
- Web search tool (DuckDuckGo, Brave, Tavily, Jina, SearXNG)
- File system tools: read, edit, write, list
- Shell execution tool
- Git integration and Worktrees support for parallel agents
- AST-based repo map and context compression via Tree-sitter (JavaScript, TypeScript, Python, Go, Rust, Java, C#, C++, PHP, Ruby, CSS, PowerShell, and more)
- Structured parsers for JSON, YAML, Markdown, SQL, TOML, GraphQL, Protobuf, Terraform, Prisma, Solidity, Dockerfile, Makefile, and 30+ additional formats
- Document extraction: PDF and DOCX
- Cross-platform: Windows, macOS, Linux
