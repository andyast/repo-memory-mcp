# Setup and troubleshooting

Environment variables, initialization, hooks, and common failure modes.

## Contents

- [Repo initialization](#repo-initialization)
- [Git hooks](#git-hooks)
- [Environment variables](#environment-variables)
- [Troubleshooting](#troubleshooting)
- [Test flow for contributors](#test-flow-for-contributors)

## Repo initialization

Initialize a repo with:

```bash
repo-memory init [--install-hooks] [--no-seed] [--overwrite] [--update-gitignore]
```

This creates:

```text
.repo-memory/store.db
.repo-memory/config.json
.repo-memory/AGENT_INSTRUCTIONS.md
```

It also seeds a small set of generic starter memories unless `--no-seed` is passed: bootstrap guidance, validation commands, source-backed memory design, proposed-memory workflow, and dashboard review queue.

With `--update-gitignore`, `.repo-memory/` is appended to `.gitignore`.

`AGENT_INSTRUCTIONS.md` contains a short snippet that can be copied into `AGENTS.md`, `CLAUDE.md`, Cursor rules, or another client-specific instruction file.

## Git hooks

`repo-memory install-hooks` writes best-effort hooks for:

- `post-merge`
- `post-checkout`
- `post-rewrite`

These hooks detect HEAD changes and run memory revalidation.

## Environment variables

### `REPO_MEMORY_ALLOWED_ROOT`

Restricts memory access to one directory tree.

```bash
REPO_MEMORY_ALLOWED_ROOT=/Users/andy/dev/test-repo
```

### `REPO_MEMORY_STORE_PATH`

Overrides the default project-local DB path.

```bash
REPO_MEMORY_STORE_PATH=/Users/andy/.repo-memory/test-repo
```

If unset, storage defaults to:

```text
<repo>/.repo-memory/store.db
```


## Troubleshooting

- **Wrong repo or no memories found:** pass `--cwd /absolute/path/to/repo` or launch the MCP client from the repo root.
- **Symlink/path mismatch:** use the real path consistently across clients. If one client opens `/var/...` and another opens `/Users/...`, repo identity may not match.
- **Allowed-root rejection:** set `REPO_MEMORY_ALLOWED_ROOT` to the parent directory that contains the repo you are testing, not to the MCP server directory.
- **Search misses:** try exact symbols/paths/error text first, then shorter terms. The current search is FTS/LIKE, not embeddings.
- **Different clients cannot see each other's memories:** confirm both clients use the same built server path and the same repo root. By default the DB lives at `<repo>/.repo-memory/store.db`; `REPO_MEMORY_STORE_PATH` overrides that.
- **SQLite busy under load:** the store uses WAL and a busy timeout. Increase `REPO_MEMORY_SQLITE_BUSY_TIMEOUT_MS` if your machine is slow, then run `npm run stress`.


## Test flow for contributors

```bash
npm install
npm run build
npm test
npm run stress
```

For Cursor + Claude Code dogfooding, install/link once and point both clients at `repo-memory-mcp` (or the same local `dist/server.js` during development), set the same `REPO_MEMORY_ALLOWED_ROOT`, then store a proposed memory in one client and verify/search it from the other.

