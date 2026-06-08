# Umbra Agent

<div align="center">

<a href="https://umbra.expert">
  <img src="https://img.shields.io/badge/-umbra.expert-7c5cbf?style=for-the-badge&logo=data:image/svg%2Bxml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHRleHQgeT0iMjAiIGZvbnQtc2l6ZT0iMjAiIGZpbGw9IndoaXRlIiBmb250LXdlaWdodD0iYm9sZCI+VTwvdGV4dD48L3N2Zz4=" alt="Website" />
</a>
&nbsp;
<a href="https://discord.gg/dW6uFFJ6WF">
  <img src="https://img.shields.io/badge/Discord-Join%20the%20Community-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord" />
</a>

</div>

---

Every LLM has a hard limit on how much it can see at once — and every token costs money. The bigger your project, the longer your session, the faster you hit that wall.

Umbra solves this. It runs as a background daemon, connects to any LLM provider, and autonomously handles coding tasks — while keeping context usage under control through layered automatic compression, smart caching, and session compaction. Work on large codebases across long sessions without burning through your budget.

---

## Key features

- **Autonomous Harness Loop** — runs your check script, reads failures, sends them to the model, iterates until it passes. No babysitting.
- **Token-aware context engine** — repo map, retrieval packets, split-turn compression, session compaction. Stays within budget automatically.
- **Provider-agnostic** — OpenAI, Anthropic, Mistral, Ollama, LM Studio, OpenCode Zen (free), and any OpenAI-compatible endpoint.
- **Persistent memory** — one SQLite database across all projects. Past solutions indexed and recalled via vector search.
- **40+ language parsers** — AST-based project outline for JavaScript, TypeScript, Python, Go, Rust, and many more.
- **Local-first** — your code stays on your machine. Nothing sent to third parties beyond the provider you choose.

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

---

## Quick start

```bash
umbra
```

Starts the daemon, opens the TUI, and stops cleanly when you exit. The agent is ready immediately.

---

## Documentation

Full reference — commands, configuration, architecture, providers, and more:

**[docs/en_documentation.md](docs/en_documentation.md)**

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

---

## License

MIT — see [LICENSE](LICENSE).
