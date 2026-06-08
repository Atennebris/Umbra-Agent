# Changelog

All notable changes to this project will be documented in this file.

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

### Fixed

- OpenCode Zen provider stream usage type assertions cleaned up
- `@huggingface/transformers` native binding now loaded lazily — no crash on import
- Shell tool tests use platform-aware commands for Linux/Windows compatibility
- Exec harness `check.ps1` invoked with `pwsh` on Linux/macOS, `powershell` on Windows
- Test fixture files `.env` and `daemon.log` added to git via `.gitignore` negation rules
- Web search default mode aligned across source and tests
