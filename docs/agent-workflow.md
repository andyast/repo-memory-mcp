# Agent workflow

How agents should use repo memory during real coding work.

## Contents

- [Agent workflow: context, checkpoints, memories](#agent-workflow-context-checkpoints-memories)
- [Checkpoints vs memories](#checkpoints-vs-memories)
- [Memory statuses](#memory-statuses)
- [Proposed memory workflow](#proposed-memory-workflow)
- [End-of-task loop](#end-of-task-loop)

## Agent workflow: context, checkpoints, memories

Repo-memory is designed around three different kinds of state:

1. **Context at task start** — call `load_project_context` with the repo `cwd` and the current task. It returns relevant memories, active checkpoints, decisions, commands, gotchas, and stale/revalidation warnings.
2. **Checkpoints during work** — call `checkpoint_task` during long or multi-step coding tasks, especially after a meaningful completed step, before risky refactors, before long-running commands, or when the context window is getting large. A checkpoint is a crash-recovery breadcrumb, not permanent project truth.
3. **Memories at task end** — call `finish_task` with a concise summary, changed files, tests run, and 0-3 proposed durable memories only if real lessons emerged. Use `propose_memory` directly when you only need to suggest a memory.

Typical agent loop:

```text
load_project_context
→ search_project_memory / get_memory if needed
→ store_artifact for important raw evidence
→ checkpoint_task after meaningful progress on multi-step work
→ run tests / validation
→ finish_task with summary and optional proposedMemories
```

## Checkpoints vs memories

Memories are durable repo truths, decisions, gotchas, commands, and lessons that should remain useful after the task. Checkpoints are temporary task-state records: completed steps, current step, next steps, blockers, files changed, tests run, and what not to redo. For long coding tasks, call `checkpoint_task` periodically and before risky/long operations; mark the checkpoint `completed` or `abandoned` when it should become historical.

Example checkpoint payload:

```json
{
  "task": "Add refresh token rotation",
  "status": "in-progress",
  "completedSteps": ["Added failing storage tests"],
  "currentStep": "Implement revoke/rotate behavior",
  "nextSteps": ["Run npm run check", "Update README if API changes"],
  "filesChanged": ["src/storage.ts", "tests/storage.test.ts"],
  "testsRun": ["npm run check failed before rotate() existed"],
  "avoidRedoing": ["Do not replace the in-memory store with SQLite in this fixture"]
}
```

Use `active_checkpoints` or `load_project_context` to resume interrupted work. Completed or abandoned checkpoints are stored as `historical` and automatically close prior active/probably-active checkpoints with the same `Checkpoint: <task>` title by superseding them; active/blocked checkpoints remain visible as resume state until the task is completed or abandoned.

## Memory statuses

- `active`: verified against current HEAD
- `probably-active`: repo changed, referenced files did not
- `needs-revalidation`: referenced files changed since last verification
- `stale`: referenced anchors disappeared or current code contradicts the memory
- `superseded`: replaced by a newer memory
- `historical`: useful background, not current implementation truth
- `proposed`: agent-suggested memory waiting for human review
- `rejected`: reviewed proposal that should not be used as project truth


## Proposed memory workflow

Agents can propose a memory without making it active:

```bash
repo-memory remember --title "Maybe auth uses jose" --claim "Need to verify auth middleware uses jose" --files src/auth.ts --tags auth --propose
```

MCP clients should prefer the dedicated `propose_memory` tool:

```json
{ "type": "gotcha", "title": "Auth tests require frozen time", "claim": "JWT auth tests are deterministic only when the test clock is frozen.", "files": ["src/auth.test.ts"], "tags": ["auth", "tests"] }
```

Compatible clients can still call `store_memory` with:

```json
{ "title": "...", "claim": "...", "status": "proposed" }
```

Good proposals are durable, reviewable, and future-facing:

- ✅ Decision: "API route handlers use Zod validation at the boundary because downstream services assume typed inputs."
- ✅ Root cause: "The flaky checkout test was caused by shared SQLite state; resetting `.repo-memory/store.db` fixes it."
- ✅ Command: "Run `npm run stress` after DB concurrency changes to catch busy-timeout regressions."
- ✅ Failed approach: "Do not mock `getRepoIdentity` in integration tests; it hid path normalization bugs."

Bad proposals are noisy or unsafe:

- ❌ "Edited three files today." (trivial churn)
- ❌ "The temporary debug print is on line 42." (soon obsolete)
- ❌ "API token is ..." (secret)
- ❌ "Andy prefers ..." (personal data, not repo engineering memory)

Review proposed memories later:

```bash
repo-memory list --statuses proposed
repo-memory verify --id mem_x                 # accept / mark active
repo-memory mark --id mem_x --status rejected # reject but keep audit/history
repo-memory delete --id mem_x --reason "bad proposal"
```

The dashboard exposes the same V1 flow in the memory modal: accept/verify, mark stale, mark historical, reject, or delete.

### End-of-task loop

For non-trivial tasks, the recommended closeout is:

1. Call `recent_activity` if you need a compact reminder of what changed or was captured.
2. Call `finish_task` with a short summary, changed files, tests run, and 0-3 `proposedMemories`.
3. If no durable lessons emerged, pass no proposals; `finish_task` stores the task summary and returns a no-memories-proposed message.

This keeps the agent burden low while preventing noisy active memories.

