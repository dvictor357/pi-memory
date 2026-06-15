# pi-memory

Persistent project & user memory for [pi](https://pi.dev). Auto-detects your tech stack, learns your conventions, and injects context into the system prompt so every new session already knows what project you're in and how you like to work.

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

### User (global, learned over time)
- **Commit style** — conventional, imperative (auto-detected from git log)
- **Indent** — tabs, spaces-2, spaces-4 (auto-detected from .editorconfig or source files)
- **Shell** — from `$SHELL`
- **Communication style** — concise, verbose…
- **Conventions** — "prefers TypeScript over JS", "always use try/catch"…

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
| `/memory clear` | Reset conventions for this project |
| `/memory project convention=uses default export factory` | Add a project convention |
| `/memory user indent=tabs` | Set a user preference |

### Agent tools

The pi agent can also call these during conversation:

| Tool | Does |
|------|------|
| `memory_status` | Show what pi knows about project + user |
| `memory_project` | View / add / remove project conventions or set tech fields |
| `memory_user` | View / set user preferences and conventions |

## System prompt injection

Every session, pi-memory appends a concise block to the system prompt:

```
## Profile

**Project:** vision-pi (TypeScript • npm • ESM)
Structure: Flat
Conventions: extensions use default export factory functions, pi.registerTool pattern

**You:**
conventional commits • tabs • concise communication
Conventions: prefers TypeScript over JS
```

## Storage

```
~/.pi/agent/memory/
├── user.json                    # Your global preferences
└── projects/
    └── <cwd-hash>.json          # Per-project profiles
```

All files are readable JSON — you can edit them by hand too.

## Requirements

- **pi** `>=0.79`

## License

MIT
