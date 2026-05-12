# MCP and CLI reference

Practical command and tool reference for repo-memory-mcp.

## Contents

- [CLI reference](#cli-reference)
- [MCP tools](#mcp-tools)
- [MCP configuration](#mcp-configuration)
- [Cross-client test plan](#cross-client-test-plan)

## CLI reference

If installed or linked, use `repo-memory`. From a local clone without linking, use `node dist/cli.js`. See [Installation](installation.md).

```bash
repo-memory identity
repo-memory init [--install-hooks] [--no-seed] [--overwrite] [--update-gitignore]
repo-memory remember --title "Auth uses jose" --claim "Auth middleware uses jose" --files src/auth.ts --symbols authMiddleware --tags auth,decision
repo-memory search --query "auth jose"
repo-memory list [--limit n] [--statuses active,stale] [--types decision] [--tags auth]
repo-memory get --id mem_x
repo-memory delete --id mem_x [--reason "why"]
repo-memory context --task "add rate limiting to auth middleware" [--json]
repo-memory status
```

Artifacts:

```bash
repo-memory artifact-store --title "test output" --file test.log --type log
repo-memory artifact-get --id artifact_x --offset 0 --limit 4000
```

Command capture:

```bash
repo-memory run -- npm test
repo-memory run -- npm run build
repo-memory run --no-remember -- npm run lint
```

Git-aware staleness review:

```bash
repo-memory revalidate --from OLD_SHA --to NEW_SHA  # scans changed files and flags memories; it does not prove truth
repo-memory revalidate --from HEAD~1 --to HEAD     # refs are resolved to full SHAs in output
repo-memory review                                 # list needs-revalidation/stale memories with suggested commands
repo-memory install-hooks
```

Lifecycle controls (audited, use `manage` for combined surface):

```bash
repo-memory manage --action verify --id mem_x
repo-memory manage --action mark --id mem_x --status historical
repo-memory manage --action delete --id mem_x --reason obsolete
repo-memory manage --action link --from mem_a --to mem_b --relation supports
repo-memory manage --action supersede --old mem_a --new mem_b
```


## MCP tools

**Primary tools (small, agent-friendly surface):**

- `load_project_context` — start here for non-trivial tasks; returns readable brief by default and reminds agents to propose durable memories at task end
- `recent_activity` — compact recent events/artifacts/memories to review before deciding whether to propose memories
- `checkpoint_task` — lightweight work-in-progress checkpoint for long/multi-step tasks, crashes, or context-window overflow recovery
- `active_checkpoints` — list active checkpoint memories so agents can resume interrupted work
- `finish_task` — end-of-task summary tool; stores a task summary artifact and can create 0-3 proposed memories in one call
- `propose_memory` — propose end-of-task durable lessons for human review (wraps `store_memory` with `status: "proposed"`)
- `store_memory` — store decisions, gotchas, facts, commands (deduped by title+claim); keep compatible clients working and use `status: "proposed"` when unsure
- `search_project_memory` — search by keyword, FTS/BM25
- `get_memory` — get one memory by ID with full provenance
- `list_memories` — list with `statuses`, `types`, `tags` filters and pagination
- `manage_memory` — verify, mark, delete, link, or supersede (actions audited, deletes require reason)
- `memory_status` — show status counts and stale items needing attention
- `revalidate_memories` — scan git-diff staleness after code changes and flag memories for review
- `review_memories` — list needs-revalidation/stale memories with suggested verification/stale/supersede commands
- `store_artifact` / `get_artifact` — large output storage with paging
- `run_command_capture` — run commands and capture results into memory
- `repo_identity` — detect current project

**Compatibility wrappers (still work, prefer primary tools above):**

`remember_project_note`, `store_decision`, `verify_memory`, `update_memory_status`, `link_memories`, `supersede_memory`, `delete_memory`


## MCP configuration

Use the same repo `cwd` / project path across clients so they share the same memory store. If repo-memory is installed or linked globally, prefer the binary form:

```json
{
  "mcpServers": {
    "repo-memory": {
      "command": "repo-memory-mcp",
      "env": {
        "REPO_MEMORY_ALLOWED_ROOT": "/absolute/path/to/repos"
      }
    }
  }
}
```

For local clone development, point directly at the built server:

```json
{
  "mcpServers": {
    "repo-memory": {
      "command": "node",
      "args": ["/absolute/path/to/repo-memory-mcp/dist/server.js"],
      "env": {
        "REPO_MEMORY_ALLOWED_ROOT": "/absolute/path/to/repos"
      }
    }
  }
}
```

### Per-client setup

**Cursor:** Add to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "repo-memory": {
      "command": "repo-memory-mcp",
      "env": {
        "REPO_MEMORY_ALLOWED_ROOT": "/path/to/test-repo"
      }
    }
  }
}
```

**VS Code / GitHub Copilot:** Edit `.vscode/mcp.json` in the repo:

```json
{
  "servers": {
    "repo-memory": {
      "type": "stdio",
      "command": "repo-memory-mcp",
      "env": {
        "REPO_MEMORY_ALLOWED_ROOT": "/path/to/test-repo"
      }
    }
  }
}
```

**Claude Code:** Add to `.claude/mcp.json`. Copy `AGENT_INSTRUCTIONS.md` into `CLAUDE.md`.

**Gemini CLI:**

```bash
gemini mcp add repo-memory repo-memory-mcp --scope user
```

**Codex CLI:**

```bash
codex mcp add repo-memory -- repo-memory-mcp
```

### Agent instructions

After `repo-memory init`, copy `.repo-memory/AGENT_INSTRUCTIONS.md` into your client's instruction file:

- Cursor: `.cursor/rules/repo-memory.md`
- VS Code: `.vscode/instructions/repo-memory.md`
- Claude Code: `CLAUDE.md`
- Codex CLI: `.codex/rules.md`

Suggested Cursor / Claude Code rule snippet:

```md
This repo uses repo-memory-mcp.

- At task start, call `load_project_context` with the repo cwd and current task.
- During work, use `store_artifact` for important command output, errors, logs, or diffs that should support future review.
- For multi-step tasks, call `checkpoint_task` after meaningful progress or before risky/long operations so another agent can resume after a crash or context-window overflow. Use `active_checkpoints` or `load_project_context` to resume.
- At task end, call `propose_memory` for 1-3 durable lessons only when they emerged: decisions, root causes, gotchas, reusable commands, architecture/config constraints, or failed approaches.
- Default to proposed memories. Use active `store_memory` only when the user explicitly says to remember/store accepted fact.
- Never store secrets, credentials, tokens, personal data, or trivial churn.
```

The intended loop is low-friction: checkpoints preserve temporary work-in-progress state during long tasks, while the agent proposes durable memories when the task is fresh for later human review with the CLI or dashboard.

