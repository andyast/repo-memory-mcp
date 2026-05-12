# Design notes

Core product shape, feature details, and current project status.

## Contents

- [Core design principles](#core-design-principles)
- [Features](#features)
- [What this is not yet](#what-this-is-not-yet)
- [Roadmap](#roadmap)
- [MVP progress snapshot](#mvp-progress-snapshot)

## Core design principles

### Remember, but verify before relying

Memories are claims tied to evidence, not permanent truth.

A memory can say:

> Auth middleware used `jose` at commit `abc123` in `src/auth.ts`.

But if the repo has moved since then, the system should warn the agent to re-check the file before acting.

### Source-backed beats vibes-backed

The system stores:

- commit SHA
- branch
- files
- symbols
- source event IDs
- artifact IDs
- status/confidence

The goal is not "the AI vaguely remembers." The goal is "the AI can retrieve a claim and inspect where it came from."

### How this differs from git history

Git tells you what changed. Repo memory tells you what was learned.

Git is excellent for diffs, authorship, timestamps, and release archaeology. It is less useful for the working context around a change:

- dead ends and failed approaches
- debugging notes that never became code
- why one library or architecture was chosen over another
- commands/tests that matter for a subsystem
- agent conversations and investigation trails
- assumptions that may become stale after related files change
- proposed memories that need human confirmation before becoming active

A commit might say:

```text
Fix JWT validation
```

A repo memory can say:

```text
Auth uses jose because the edge runtime needs WebCrypto-compatible JWT verification.
We tried jsonwebtoken, but it failed in the edge runtime.
Relevant files: src/auth.ts, src/middleware.ts.
Verified at commit abc123. Revalidate if auth middleware changes.
```

Repo memory does not replace git. It uses git as evidence: commit SHAs, changed files, and revalidation signals. The point is to give agents task-shaped engineering context without making them dig through raw commit history every time.

### Exact search first, semantic later

For source code, exact terms matter:

- class names
- method names
- paths
- error messages
- ticket IDs
- commands

FTS/BM25 is the first retrieval layer. Local embeddings may be added later, but only after exact/source-backed recall works well.


## Features

### Repo identity detection

Project scope is inferred from:

1. current working directory
2. git root
3. git remote URL, if available
4. canonical path fallback

### Project-local storage

By default, each repo gets its own SQLite DB:

```text
.repo-memory/store.db
```

This makes early testing simple and keeps memory scoped to the project.

### Hard allowed-root guard

For safe testing, restrict the server to one directory tree:

```bash
REPO_MEMORY_ALLOWED_ROOT=/Users/andy/dev/test-repo repo-memory-mcp
```

When set, any `cwd` outside that allowed root is rejected.

This is recommended for corporate-machine testing and early dogfooding.

### Git-aware staleness

Code-related memories can store:

- observed commit
- last verified commit
- referenced files
- referenced symbols

After code changes, memories can be marked:

- `active`
- `probably-active`
- `needs-revalidation`
- `stale`
- `superseded`
- `historical`

### Artifact storage

Large outputs are stored as artifacts with stable IDs:

- logs
- command output
- diffs
- transcripts
- test output

The agent gets a preview and can page through the full artifact by ID.

### Command capture

Run commands through repo memory:

```bash
repo-memory run -- npm test
```

This captures:

- command
- exit code
- duration
- stdout/stderr
- commit SHA
- output artifact ID
- searchable result memory

### Context packs

Load a task-specific context briefing. The default format is a readable text briefing designed for agent consumption:

```bash
repo-memory context --task "fix auth tests"
```

Returns a clean text briefing with:

- repo identity (branch, HEAD)
- task-relevant memories
- recent decisions
- gotchas
- test commands / captured results
- stale warnings
- suggested next actions

Use `--json` for machine-readable format. The `load_project_context` MCP tool returns the brief format by default.

### Audit trail

Status changes, deletions, and links are logged to the `audit_log` table. Lifecycle mutations require a reason for accountability. No silent mutations.

### Memory deduplication

Duplicates are detected on `store_memory` by matching `title` and `claim` against existing memories. The duplicate is returned instead of creating a new row.


## What this is not yet

Not yet implemented:

- local embeddings
- LLM-assisted memory extraction
- packaged npm release
- packaged Docker image
- multi-user/team sharing
- fine-grained auth
- AST-aware symbol tracking

## Roadmap

Likely next steps:

1. Test the packaged install path across Cursor, Claude Code, VS Code, Gemini CLI, and Codex CLI.
2. Add optional local embeddings.
3. Add better file/symbol validation.
4. Add import/export.
5. Explore team/shared memory as V2.


## MVP progress snapshot

Done in the current basic MVP slice:

- Source-backed memories with artifact IDs, evidence quotes, and `get_memory_with_evidence`.
- Audit trail for create, evidence link, lifecycle updates, revalidation, and delete.
- Relaxed search fallback after exact FTS so singular/plural/simple-token misses are less brittle.
- Dashboard with stats, audit log, review actions, and evidence shown in the memory modal.
- Proposed memory workflow: write with `status: "proposed"` from MCP or `repo-memory remember --propose`, then accept with verify/active or reject/delete from CLI/MCP/dashboard.
- Concurrent write stress path via `npm run stress`.

Next, still deliberately not production polish:

- Publish or distribute the packaged npm tarball once dogfooding stabilizes.
- More robust dashboard filtering for proposed/rejected memories.
- Stronger file/symbol validation beyond simple changed-file checks.
- Import/export and optional embeddings after exact/source-backed recall proves useful.

