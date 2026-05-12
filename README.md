# repo-memory-mcp

Local-first, repo-scoped memory for engineering agents.

`repo-memory-mcp` is an early MCP prototype for sharing source-backed engineering memory across AI coding clients like Cursor, VS Code, Claude Code, Gemini CLI, Codex CLI, and other MCP-capable tools.

> Engineering memory should follow the repo across AI clients, not be trapped inside one application.

This is not a generic personal-memory bot. It is a project memory layer for software work: decisions, gotchas, commands, artifacts, task checkpoints, and stale warnings tied back to repo evidence.

## Contents

- [Why this exists](#why-this-exists)
- [Quick start](#quick-start)
- [Core workflow](#core-workflow)
- [Docs](#docs)
- [Development](#development)
- [Dashboard](#dashboard)
- [Safety notes](#safety-notes)
- [Current status](#current-status)

## Why this exists

AI coding tools are useful, but each one tends to start from a blank slate. Repo docs get stale, prior debugging context disappears, and decisions are scattered across chats, commits, and terminal output.

Repo memory is designed to answer questions like:

- What did we do last time in this repo?
- What did we decide about this subsystem?
- What test command worked?
- What failure did we already investigate?
- Which memories might be stale after a `git pull`?
- What should the agent know before touching this code?

## Quick start

Clone, install, build, and test:

```bash
git clone https://github.com/pinchworth-ops/repo-memory-mcp.git
cd repo-memory-mcp
npm install
npm run build
npm test
npm run demo
```

Run the MCP server directly:

```bash
node /absolute/path/to/repo-memory-mcp/dist/server.js
```

Run the CLI directly:

```bash
node /absolute/path/to/repo-memory-mcp/dist/cli.js --help
```

Optional local link for nicer CLI usage:

```bash
npm link
repo-memory --help
```
See [Installation](docs/installation.md) for tarball/npm install and MCP client config.


Initialize a test repo:

```bash
cd /path/to/test-repo
repo-memory init --update-gitignore
repo-memory context --task "understand this repo"
```

Recommended MCP server config shape:

```json
{
  "mcpServers": {
    "repo-memory": {
      "command": "node",
      "args": ["/absolute/path/to/repo-memory-mcp/dist/server.js"],
      "env": {
        "REPO_MEMORY_ALLOWED_ROOT": "/absolute/path/to/test-repo"
      }
    }
  }
}
```

See [MCP and CLI reference](docs/mcp-tools.md) for per-client setup.

## Core workflow

Typical agent loop:

```text
load_project_context
→ search_project_memory / get_memory if needed
→ store_artifact for important raw evidence
→ checkpoint_task after meaningful progress on multi-step work
→ run tests / validation
→ finish_task with summary and optional proposedMemories
```

The important distinction:

1. **Context at task start** — load relevant memories, active checkpoints, commands, gotchas, and stale warnings.
2. **Checkpoints during work** — preserve temporary work-in-progress state for long tasks, crashes, or context-window overflow.
3. **Memories at task end** — propose durable lessons only when they will help future agents.

Read the full workflow in [Agent workflow](docs/agent-workflow.md).

## Docs

| Doc | What it covers |
| --- | --- |
| [Installation](docs/installation.md) | Local clone, npm/tarball install, MCP config, smoke test |
| [Design notes](docs/design.md) | Design principles, features, roadmap, MVP snapshot |
| [MCP and CLI reference](docs/mcp-tools.md) | CLI commands, MCP tools, client configuration, cross-client test plan |
| [Agent workflow](docs/agent-workflow.md) | Context loading, checkpoints, `finish_task`, proposed memories, statuses |
| [Setup and troubleshooting](docs/troubleshooting.md) | Repo initialization, hooks, env vars, path mismatch, SQLite busy |
| [Dogfood and evaluation](docs/dogfood.md) | Alternating Claude/Cursor suite, checkpoint recovery dogfood, checklists |

## Development

```bash
npm install
npm run build
npm test
npm run demo
```

Additional checks:

```bash
npm run stress
scripts/run-memory-dogfood-suite.sh /path/to/memory-test
scripts/run-checkpoint-dogfood.sh /path/to/memory-checkpoint-test
```

The smoke test creates a fake git repo and verifies storage/search, artifact paging, command capture, context packs, git revalidation, listing/deletion, audit trail, deduplication, and lifecycle operations.

## Dashboard

Start the local dashboard to review memories, audit history, and useful project stats:

```bash
repo-memory dashboard
```

The dashboard includes a **Needs attention** review queue for proposed, needs-revalidation, and stale memories. It supports the same audited review actions as the CLI: accept/verify, reject, mark stale/historical, or delete.

## Safety notes

- Do not point early versions at sensitive work repos until tested on disposable repos.
- Use `REPO_MEMORY_ALLOWED_ROOT` during early dogfooding.
- Do not store secrets, credentials, tokens, personal data, or trivial churn.
- Treat memories as claims with provenance, not absolute truth.
- Re-check code before acting on stale or probably-active memories.

## Current status

Prototype. Useful enough to test, not production-ready.

Current implementation is intentionally boring:

- TypeScript / Node
- SQLite via `better-sqlite3`
- SQLite FTS5 search
- local files only
- no cloud calls
- no embeddings yet
- no LLM dependency

The deterministic storage/retrieval/staleness layer comes first. LLM-assisted extraction or summarization can come later.

## License

MIT. See [LICENSE](LICENSE).
