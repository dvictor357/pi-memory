# pi-memory

Persistent project & user memory for [pi](https://pi.dev). Auto-detects your tech stack, learns your conventions, and injects context into the system prompt so every new session already knows what project you're in and how you like to work.

New in v1.2.0: structured facts with agent/subagent scoping, memory search & lint, prompt budget caps, faster single-scan detection, and expanded fingerprint cache.

## What it remembers

### Project (per-repo, auto-detected)
- **Package manager** — npm, yarn, pnpm, bun, uv, cargo, poetry…
- **Language** — TypeScript, Python, Rust, Go, Ruby…
- **Framework** — Next.js, React, FastAPI, Django, Axum…
- **Design system** — Tailwind, shadcn/ui, MUI, Bootstrap…
- **Build tool** — Vite, tsup, Cargo, Webpack…
- **Test runner** — Vitest, Jest, pytest, cargo test…
- **Linter / Formatter** — ESLint, Biome, Ruff, Prettier…
- **Directory pattern** — App Router, feature-based, MVC, Go standard…
- **Monorepo** detection
- **Conventions** — patterns you tell pi to remember
- **Facts** — structured memory with scoping, priority, and tags

### User (global, learned over time)
- **Commit style** — conventional, imperative (auto-detected from git log)
- **Indent** — tabs, spaces-2, spaces-4 (auto-detected from .editorconfig or source files)
- **Shell** — from `$SHELL`
- **Communication style** — concise, verbose…
- **Conventions** — "prefers TypeScript over JS", "always use try/catch"…
- **Facts** — structured personal memory

## Install

```bash
pi install git:github.com/dvictor357/pi-memory
```

## Usage

### Commands

| Command | Does |
|---------|------|
| `/memory` | Show both project and user profiles |
| `/memory rescan` | Force re-detect project tech stack |
| `/memory clear` | Reset conventions and facts for this project |
| `/memory project convention=uses default export factory` | Add a project convention |
| `/memory project fact=Custom hooks go in src/hooks` | Add a project fact |
| `/memory user indent=tabs` | Set a user preference |
| `/memory user fact=I prefer dark mode` | Add a user fact |
| `/memory compact` | Deduplicate conventions and facts, drop empty entries |

### Agent tools

The pi agent can also call these during conversation:

| Tool | Does |
|------|------|
| `memory_status` | Show what pi knows about project + user |
| `memory_project` | View / add / remove project conventions, facts, or set tech fields. Supports `compact` for dedup. |
| `memory_user` | View / set user preferences, conventions, and facts |
| `memory_search` | Search conventions and facts by keyword, with optional scope and agent filters |
| `memory_lint` | Audit memory for duplicates, empty values, long entries, and oversized capsules |

### Structured facts

Facts are scoped, taggable memory items that go beyond conventions. Each fact has:

| Field | Description |
|-------|-------------|
| `scope` | `user` (global), `project` (per-repo), or `agent` (tied to a sub-agent name) |
| `text` | The fact content |
| `category` | Optional grouping label (e.g. `"security"`, `"deployment"`) |
| `priority` | 0–10, higher = more important in system prompt |
| `tags` | String array for filtering (agent-scoped facts use tags for agent identity) |

**Agent/subagent-scoped memory MVP:** facts with `scope: "agent"` are only shown to the matching sub-agent (matched via `PI_AGENT_NAME` env var against `category` and `tags`). This lets each agent carry its own working memory without polluting the main agent's context.

### Memory search

```typescript
// Agent tool usage
memory_search({ query: "deployment" })           // search all
memory_search({ query: "auth", scope: "project" }) // project only
memory_search({ query: "cache", agent: "scout" })  // agent-scoped
```

### Memory lint

```typescript
memory_lint({})
// → Reports duplicates, empty values, long entries (>200 chars conventions, >500 chars facts),
//   and oversized capsules (>100 KB on disk)
```

### Compact

Deduplicate conventions and facts (case-insensitive), trim whitespace, drop empty entries. Available as:
- `/memory compact` command
- `compact: true` parameter on `memory_project` tool

## System prompt injection

Every session, pi-memory appends a concise block to the system prompt — budgeted to stay lean:

```
## Profile

**Project:** vision-pi (TypeScript • npm • ESM)
Structure: Flat • Tests: Vitest • Lint: ESLint
Conventions: uses pi.registerTool for all tools, extensions use default export factory functions
Facts: [security] API keys stored in .env • tests require Vitest

**You:**
conventional commits • tabs • concise communication
Conventions: prefers TypeScript over JS
Facts: [deployment] always deploy from main branch
```

### Prompt budget caps

To avoid bloating the system prompt, pi-memory enforces:

| Limit | Value |
|-------|-------|
| Max conventions displayed | 5 per profile (project + user), truncated at 72 chars each |
| Max facts displayed | 5 per profile, sorted by priority, truncated at 72 chars each |
| Max "extras" line items | 8 (design system, structure, tests, linter, formatter, etc.) |

Overflow is shown as `+N more` so you know there's more stored than what fits in the prompt.

## Faster detection & expanded fingerprint cache

Auto-detection now uses a **single-scan** approach:

- Extension counts are collected in one `readdir` walk (depth 3, cap 100 per extension) — no repeated scans.
- All project signals (`package.json`, dependencies, config files, pyproject.toml, Cargo.toml) are gathered in one `collectSignals()` call.
- Project rescans check an expanded **fingerprint cache** (80+ key files including lock files, configs, and editor settings). If no key file mtimes changed, the scan is skipped entirely.
- Commit-style detection uses non-blocking `spawn` with a 1-hour cache and an eviction cap of 100 projects.

## Storage

```
~/.pi/agent/memory/
├── user.json                    # Your global preferences, conventions, and facts
└── projects/
    └── <cwd-hash>.json          # Per-project profiles
```

All files are readable JSON — you can edit them by hand too.

## Cross-extension cohesion

pi-memory participates in the [cross-extension cohesion contract](https://github.com/dvictor357/pi-quest/blob/main/docs/cross-extension-cohesion.md) alongside pi-todo and pi-quest.

- **Status bar badge** — `🧠 TypeScript` (or framework name) shown in the footer. Clears when no project is detected.
- **Fingerprint-accelerated detection** — key-file mtimes are cached; rescans skip the full directory walk when nothing changed. `/memory rescan` forces a fresh scan.
- **Session meta** — publishes language, framework, package manager, and convention count to `~/.pi/agent/session-meta.json` so other extensions can read project context without scanning disks.
- **Commit-style detection** uses non-blocking `spawn` with a 1-hour cache — never blocks the event loop.

All cross-extension writes are best-effort and wrapped in try/catch.

## Requirements

- **pi** `>=0.79`

## License

MIT
