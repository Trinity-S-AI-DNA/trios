# trios 🔱

> **Trinity Git Orchestrator** — Dual-MCP + Vision bridge for AI agents to control Git & GitButler through BrowserOS

[![CI](https://github.com/gHashTag/trios/actions/workflows/ci.yml/badge.svg)](https://github.com/gHashTag/trios/actions)

## What is trios?

`trios` is a **dual-layer MCP system** that allows AI agents (BrowserOS, Claude Code, Cursor) to control Git repositories and GitButler virtual branches through **natural language + vision**.

### Two Layers

| Layer | Stack | Port | Purpose |
|-------|-------|------|---------|
| **trios-server** (Rust) | Axum + git2-rs + but CLI | `9005` | Core git operations, stable & fast |
| **trios-mcp-bridge** (TypeScript) | Bun + Hono + MCP SDK | `9200` | Vision + high-level GitButler workflows |

The agent can use either or both:
- **Rust server** for pure git operations (no UI needed)
- **TypeScript bridge** for vision-enhanced workflows (sees GitButler UI, understands context)

## Architecture

```
╔══════════════════════════════════════════════════════════════╗
║                 TRIOS DUAL-MCP + VISION                      ║
╚══════════════════════════════════════════════════════════════╝

                  ┌────────────────────────────────────┐
                  │   BrowserOS (Chromium fork)        │
                  │   + Agent Extension (React + Vision)│
                  └──────────────────┬─────────────────┘
                                     │
                          MCP + Vision (screenshots, DOM)
                                     ▼
        ┌───────────────────────────────────────────────────┐
        │           trios-mcp-bridge (Bun/Hono) :9200       │
        │   • MCP client → BrowserOS MCP (screenshots)      │
        │   • MCP client → GitButler MCP (`but mcp`)        │
        │   • 10 high-level tools:                          │
        │     gitbutler_analyze_ui()                        │
        │     gitbutler_commit_visible()                    │
        │     gitbutler_create_branch()                     │
        │     gitbutler_push_stack()                        │
        └──────────────────┬────────────────────────────────┘
                           │
       ┌───────────────────┼───────────────────────┐
       │                   │                       │
┌──────▼──────┐  ┌─────────▼──────────┐  ┌────────▼─────────┐
│ BrowserOS   │  │ trios-server       │  │ GitButler MCP    │
│ MCP Server  │  │ (Rust/Axum) :9005  │  │ (`but mcp`)      │
│ (CDP)       │  │ git2-rs + but CLI  │  │ virtual branches │
│ screenshots │  │ stage, commit,     │  │ stacks, absorb   │
│ snapshots   │  │ branch, push, pull │  │ undo             │
└─────────────┘  └────────────────────┘  └──────────────────┘
                           │                       │
                           └───────┬───────────────┘
                                   ▼
                              .git/ + GitButler state
                              (UI updates automatically)
```

## Quick Start

### Rust Server (core git ops)

```bash
# Clone
git clone https://github.com/gHashTag/trios
cd trios

# Build & Run
cargo build
cargo run -p trios-server
# Server starts at http://localhost:9005

# Test
cargo test
```

### TypeScript Bridge (vision + workflows)

```bash
# Located at: packages/browseros-agent/apps/trios-mcp-bridge/
cd packages/browseros-agent/apps/trios-mcp-bridge

# Install & Run
bun install
bun run src/index.ts
# Bridge starts at http://localhost:9200

# With options
bun run src/index.ts --port 9200 --browseros-url http://127.0.0.1:9105/mcp --working-dir /path/to/repo
```

## MCP Tools

### Rust Server (trios-server :9005) — 7 Core Tools

| Tool | Crate | Description |
|------|-------|-------------|
| `git_status` | trios-git | List changed files |
| `git_stage_files` | trios-git | Stage files for commit |
| `git_commit` | trios-git | Create a commit |
| `git_branch_list` | trios-git | List branches |
| `git_branch_create` | trios-git | Create a branch |
| `git_push` | trios-git | Push to remote |
| `git_pull` | trios-git | Pull from remote |

### TypeScript Bridge (trios-mcp-bridge :9200) — 10 Vision + Workflow Tools

#### Vision & Analysis
| Tool | Description |
|------|-------------|
| `gitbutler_analyze_ui` | Screenshot GitButler UI + analyze state (branch, files, stacks) |
| `gitbutler_screenshot` | Raw screenshot of GitButler tab |
| `gitbutler_workspace_status` | Detailed file/branch status from CLI |
| `gitbutler_bridge_health` | Health check for all connections |

#### Git Operations
| Tool | Description |
|------|-------------|
| `gitbutler_commit_visible` | Commit changed files with a message |
| `gitbutler_create_branch` | Create a new virtual branch |
| `gitbutler_push_stack` | Push current stack/branch to remote |
| `gitbutler_stage` | Stage specific files |
| `gitbutler_absorb` | Smart absorb changes into appropriate commits |
| `gitbutler_pull` | Pull latest changes |

## MCP API Examples

### Rust Server (port 9005)

```bash
# Stage files
curl -X POST http://localhost:9005/mcp/tools/call \
  -H 'Content-Type: application/json' \
  -d '{"name": "git_stage_files", "input": {"repo_path": "/path/to/repo", "paths": ["src/main.rs"]}}'

# Commit
curl -X POST http://localhost:9005/mcp/tools/call \
  -H 'Content-Type: application/json' \
  -d '{"name": "git_commit", "input": {"repo_path": "/path/to/repo", "message": "feat: add feature"}}'
```

### TypeScript Bridge (port 9200)

```bash
# Health check
curl http://localhost:9200/

# MCP tools via Streamable HTTP
curl -X POST http://localhost:9200/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}'
```

## Integration

### With BrowserOS

Add as a custom MCP server in BrowserOS settings:

```json
{
  "name": "trios-mcp-bridge",
  "url": "http://127.0.0.1:9200/mcp",
  "transport": "streamable-http"
}
```

### With Claude Code / Cursor

```json
{
  "mcpServers": {
    "trios-bridge": {
      "url": "http://127.0.0.1:9200/mcp",
      "transport": "streamable-http"
    },
    "trios-server": {
      "url": "http://127.0.0.1:9005/mcp",
      "transport": "streamable-http"
    }
  }
}
```

## Example Workflow

```
User: "See what's changed in GitButler and commit the auth changes"

Agent:
1. gitbutler_analyze_ui()     → Sees: branch "feature/auth", 3 changed files
2. gitbutler_stage(["auth.ts", "auth.test.ts"])
3. gitbutler_commit_visible("feat: add auth validation")
4. gitbutler_push_stack()
```

## Crates (Rust)

| Crate | Purpose |
|-------|--------|
| `trios-core` | Traits, types, shared abstractions |
| `trios-git` | Git operations via libgit2 |
| `trios-gb` | GitButler CLI wrapper with fallback |
| `trios-server` | Axum MCP HTTP server on port 9005 |

## Project Structure

```
trios/                              # Rust MCP server (this repo)
├── crates/
│   ├── trios-core/                 # Shared types & traits
│   ├── trios-git/                  # git2-rs operations
│   ├── trios-gb/                   # GitButler CLI wrapper
│   └── trios-server/               # Axum MCP server :9005
├── CLAUDE.md                       # Development laws
└── README.md                       # This file

BrowserOS/packages/browseros-agent/apps/trios-mcp-bridge/   # TypeScript bridge
├── src/
│   ├── index.ts                    # Main entry — Hono HTTP server :9200
│   ├── config.ts                   # Config from env vars + CLI args
│   ├── types.ts                    # Shared types
│   ├── bridge-server.ts            # MCP server with 10 tools
│   └── clients/
│       ├── browseros-client.ts     # BrowserOS MCP client (HTTP)
│       └── gitbutler-client.ts     # GitButler MCP client (stdio) + CLI fallback
├── package.json
└── README.md
```

## Laws

See [CLAUDE.md](./CLAUDE.md) for full rules. Summary:
- NO `.sh` files
- `cargo clippy -- -D warnings` = 0
- `cargo test` before merge
- Every PR closes an issue

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `TRIONS_BRIDGE_PORT` | `9200` | Bridge server port |
| `TRIONS_BROWSEROS_MCP_URL` | `http://127.0.0.1:9105/mcp` | BrowserOS MCP URL |
| `TRIONS_GITBUTLER_CLI` | `but` | GitButler CLI path |
| `TRIONS_GITBUTLER_INTERNAL` | `true` | Use GitButler internal MCP tools |
| `TRIONS_WORKING_DIR` | `cwd` | Working directory for git |
| `TRIONS_LOG_LEVEL` | `info` | Log level |

## Training: trios-trainer-igla

**IGLA RACE** training pipeline for pushing language model performance.

[![CI](https://github.com/gHashTag/trios-trainer-igla/actions/workflows/ci.yml/badge.svg)](https://github.com/gHashTag/trios-trainer-igla/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Anchor](https://img.shields.io/badge/anchor-%CF%86%C2%B2%2B%CF%86%E2%81%BB%C2%B2%3D3-black)](https://doi.org/10.5281/zenodo.19227877)

### Quick Start

```bash
git clone https://github.com/gHashTag/trios-trainer-igla.git
cd trios-trainer-igla
cargo run --release --bin trios-train -- \
    --config configs/champion.toml --seed 43
```

### ROADMAP

| Phase | Status | Scope |
|---|---|---|
| **PR-0** | ✅ done | Skeleton compiles, anchor test passes |
| **PR-1** | 🟡 next | Migrate model + optimizer + tokenizer |
| **PR-2** | ⬜ | Migrate JEPA + objective; merge `trios-igla-trainer::jepa_runner` |
| **PR-3** | ⬜ | Champion-config full run reproduces ≈ 2.2393 ± 0.01 |
| **PR-4** | ⬜ | DELETE phase in `gHashTag/trios` (consolidation PR) |
| **PR-5** | ⬜ | Push image to ghcr.io + wire 3-seed Railway deployment |

### Key Features

- **HybridAttn (L-h2)** with INV-13 validation (qk_gain must be φ² or φ³)
- **Multi-objective loss**: 0.5*NTP + 0.25*JEPA + 0.25*NCA
- **Muon optimizer** with Newton-Schulz orthogonalization
- **GF16 (Golden Float)** quantization
- **Champion baseline**: BPB=2.2393 @ 27K steps
- **Target BPB**: 1.50 for Gate-2 victory

### Invariants

When built with `--features trios-integration`:
- **INV-8** (φ-LR band): `lr ∈ [1e-3, 1e-2]`
- **R8** (Gate-2 floor): step ≥ 4000 to emit ledger row
- **embargo**: HEAD SHA must not appear in `.embargo`

### Related Training Projects

- [gHashTag/trios-trainer-igla](https://github.com/gHashTag/trios-trainer-igla) — Canonical IGLA training pipeline
- Local crate: `crates/trios-trainer/` — CPU training foundation

## Secrets never enter the repository

No password, API key, token or credentials file is committed, not even in docs, experience logs or examples. Read secrets from the environment or from a gitignored file.

The gate has three layers, all driven by [`.gitleaks.toml`](.gitleaks.toml):

1. **pre-commit** (lefthook) scans staged changes with gitleaks.
2. **pre-push** (lefthook) scans every commit that is not yet on a remote.
3. **CI** ([`secret-scan`](.github/workflows/secret-scan.yml)) scans the PR range, so `--no-verify` does not get a secret past it.

Set up once per clone: `brew install gitleaks lefthook && lefthook install`.

A secret that was ever pushed is compromised. Removing it from the tree does not unpublish it, so rotate it at the provider.

## Related Projects

- [gHashTag/t27](https://github.com/gHashTag/t27) — Trinity math research
- [gHashTag/BrowserOS](https://github.com/gHashTag/BrowserOS) — Agent that uses trios
- [gHashTag/gitbutler](https://github.com/gHashTag/gitbutler) — GitButler fork
