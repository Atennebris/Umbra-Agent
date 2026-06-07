# Security Policy

## Reporting a Vulnerability

Do **not** open a public GitHub issue for security vulnerabilities.

Send a report to: **umbra@umbra.expert**

Include:
- Description of the vulnerability
- Steps to reproduce
- Affected version (`umbra --version`)
- Potential impact

## Supported Versions

Only the latest release receives security updates.

| Version | Supported |
|---------|-----------|
| Latest  | ✅ |
| Older   | ❌ |

## Scope

**In scope:**
- Daemon process and IPC layer
- Provider credential handling
- Tool execution (shell, file system, web)
- Session memory and SQLite storage
- npm package and release artifacts

**Out of scope:**
- Vulnerabilities in upstream dependencies (report to them directly)
- Attacks requiring physical access to the machine
- Issues in AI provider APIs themselves

## Security architecture

- Provider API keys are stored in `~/.umbra/` — never in the project directory or logs
- Daemon binds to `127.0.0.1` only — not exposed to the network
- Tool calls are validated against strict Zod schemas before execution
- No telemetry, no analytics, no external data collection

## Known limitations

Umbra Agent executes shell commands and file operations with your user permissions. The security of tool execution depends on the prompts and tasks you give the agent. Review autonomous task results before applying them to production systems.
