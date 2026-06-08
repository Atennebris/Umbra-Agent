# Contributing to Umbra Agent

Umbra Agent is an AI-powered agent for general-purpose assistance with a focus on coding. We welcome contributions from participants.

This document helps you decide whether and how to contribute in a way that's likely to get merged — so neither of us wastes time.

## How this project is run

- Umbra Agent has one active maintainer ([@Atennebris](https://github.com/Atennebris)).
- Review bandwidth is limited.
- Not every contribution will be accepted, even if technically correct. Alignment with project direction matters as much as code quality.

Read [ROADMAP.md](ROADMAP.md) before opening anything non-trivial.

## Quick start

```bash
pnpm install
pnpm dev
```

Requirements: Node.js v22+, pnpm.

## Where to discuss

Use **GitHub Issues** for concrete bugs and feature requests.

For design discussion, "should I work on X?", or quick questions — open an issue first or email umbra@umbra.expert.

## What makes a good contribution

These get merged fast:

- **Bug fixes** with clear reproduction steps
- **Docs / typos / small UX fixes** — open a PR directly, no issue needed
- **Pre-discussed features** — alignment in an issue first
- **Small, focused changes** — easy to review, low risk

## Keep changes focused

Only change what's needed to accomplish your stated goal.

If you're fixing a bug in one file, don't also reformat other files, clean up unrelated code, or combine multiple fixes in one PR. Even when "improvements", they make review harder.

**One PR = one logical change.** Multi-concern PRs will be asked to split.

## Discuss first — required for larger changes

For anything beyond a small fix, discussion is required before opening a PR. This includes:

- New features or commands
- New AI providers
- Changes to default behavior or UX
- Refactors or architectural changes
- Anything touching many files

PRs with significant unsolicited changes will be closed without detailed review.

## Quality bar

All PRs are reviewed against:

- `pnpm lint` clean
- `pnpm build` clean
- `pnpm test` passing
- No regressions in: daemon startup, provider routing, session memory, tool execution
- Platform parity preserved (Windows / macOS / Linux still work)

## Branches

Branch off `main`. Use these prefixes:

| Prefix | Use for |
|--------|---------|
| `feat/` | New feature |
| `fix/` | Bug fix |
| `docs/` | Docs-only changes |
| `refactor/` | Code cleanup, no behavior change |
| `perf/` | Performance work |
| `security/` | Security fix or hardening |

Examples: `feat/mcp-support`, `fix/session-resume`, `docs/provider-setup`.

Do not open PRs from your fork's `main` branch.

## Commits & PRs

Follow [Conventional Commits](https://www.conventionalcommits.org):

```
feat(providers): add Gemini support
fix(daemon): prevent crash on missing config
docs(readme): update installation steps
security(memory): sanitize session path input
```

Types: `feat`, `fix`, `docs`, `refactor`, `perf`, `test`, `chore`, `security`.

**Fill out the PR template.** Include what changed, why, and how you tested it.

## What gets bounced back

- Mixed-concern PRs
- Large unsolicited changes without prior discussion
- New dependencies without justification
- AI-generated code that wasn't reviewed by the author

## Code style

- Follow existing patterns. Read 2–3 adjacent files before writing new ones.
- No emojis in code or commit messages.

## Security issues

Do not file security vulnerabilities as public issues. See [SECURITY.md](SECURITY.md).

## License

By contributing you agree your work is licensed under [MIT](LICENSE).
