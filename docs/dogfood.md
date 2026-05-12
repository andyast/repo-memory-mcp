# Dogfood and evaluation

Scripts and checklists for testing whether agents naturally use repo-memory across clients and long tasks.

## Contents

- [Dogfood automation](#dogfood-automation)
- [What the dogfood suite tests](#what-the-dogfood-suite-tests)
- [Full alternating suite](#full-alternating-suite)
- [Checkpoint recovery dogfood](#checkpoint-recovery-dogfood)
- [Single-agent runs](#single-agent-runs)

## Dogfood automation

These scripts test whether agents naturally use repo-memory without the engineer manually writing memories.

### What the dogfood suite tests

The advanced fixture creates a tiny TypeScript app with auth, config, storage, and tests. The goal is not to test the app itself. The goal is to test cross-agent memory behavior over multiple turns:

1. **Claude turn 1:** load context, improve auth/config validation, run checks, finish the task, and propose memories only if useful.
2. **Cursor turn 2:** load Claude's prior context, make a storage/session improvement without contradicting earlier decisions, run checks, and finish the task.
3. **Claude turn 3:** use Cursor's accumulated context, improve tests around learned behavior, and use lifecycle tools if a memory is stale or duplicated.
4. **Cursor turn 4:** review accumulated memories, make a small cleanup reflecting learned project conventions, validate, and finish the task.

After each turn, the suite captures:

- agent stdout/stderr
- git status
- repo-memory status
- proposed memories
- all memories

This lets us evaluate the real product question: can multiple agents build shared repo context over time without the engineer becoming the note-taker?

What to look for in a healthy run:

- Turn 1 proposes a small number of useful memories, not generic summaries.
- Turn 2 uses prior context and makes the requested code behavior change, not just docs cleanup.
- Turn 3 can verify/promote a proposed memory after checking code.
- Turn 4 uses accumulated context without adding noise.
- Proposed counts stay small, duplicates are avoided, and lifecycle actions are audited.
- Checkpoints appear only when there is meaningful multi-step state to preserve.

### Full alternating suite

```bash
scripts/run-memory-dogfood-suite.sh /path/to/memory-test
```

This resets the fixture, runs Claude → Cursor → Claude → Cursor, captures stdout/stderr and memory inspections after each turn, and writes a final summary under `.dogfood-runs/<timestamp>/summary.md`. The suite passes turn-specific prompt files into the Claude/Cursor runners, so each turn can test a different behavior instead of using one generic prompt. The dogfood scripts allow lifecycle MCP tools (`manage_memory`, `verify_memory`, `supersede_memory`) and checkpoint tools (`checkpoint_task`, `active_checkpoints`) so agents can promote, reject, supersede, or resume task state during the run when appropriate.

To force a clean fixture repo:

```bash
WIPE_ALL=1 scripts/run-memory-dogfood-suite.sh /path/to/memory-test
```

### Checkpoint recovery dogfood

Use this when you want to test whether an agent uses `checkpoint_task` during a longer multi-step coding task. Unlike the alternating Claude/Cursor suite, this runs one long Claude task with an explicit 13-step plan and then inspects checkpoint memories.

```bash
scripts/run-checkpoint-dogfood.sh /path/to/memory-checkpoint-test
```

The generated long-task prompt asks the agent to:

1. call `load_project_context`,
2. inspect storage/auth/test files,
3. create an initial checkpoint after inspection,
4. implement refresh-token session lifecycle behavior (`revokedAt`, `revoke`, `isRevoked`, `activeCount`, revoked-session `find` behavior),
5. add tests,
6. run `npm run check`,
7. checkpoint any meaningful failure before fixing it,
8. create a completed checkpoint at the end, and
9. call `finish_task` with optional proposed memories.

The script writes all artifacts under `.dogfood-runs/checkpoint-<timestamp>/`:

- `checkpoint-task.md` — agent stdout/stderr and final response
- `inspect-final.md` — git status, repo-memory status, checkpoint memories, active checkpoints, proposed memories, all memories
- `summary.md` — combined run summary

A healthy run should create a small number of useful checkpoints, usually one after initial inspection and one completed checkpoint at the end. It should not create checkpoint spam for every tiny edit. If validation fails mid-task, one extra failure checkpoint with the error summary is useful.

Evaluation checklist:

- Did the agent create an initial checkpoint with completed inspection and next implementation step?
- Did it create a completed checkpoint with files changed and tests run?
- Are completed checkpoints historical rather than active resume work?
- Did `active_checkpoints` / `load_project_context` remain useful instead of noisy?
- Did `finish_task` still capture durable memories separately from checkpoint state?

### Single-agent runs

Claude Code:

```bash
npm run build
scripts/dogfood-claude.sh /path/to/repo
```

The script creates a temporary MCP config pointing at `dist/server.js`, asks Claude to load repo context, perform one small safe review/improvement, run validation if it changes code, and call `finish_task` before the final response.

Cursor Agent CLI:

```bash
scripts/dogfood-cursor.sh /path/to/repo
```

The script writes a project MCP config to `/path/to/repo/.cursor/mcp.json` and runs Cursor Agent in headless mode with `-p --approve-mcps --force`. If you only want setup, run:

```bash
CURSOR_RUN=setup-only scripts/dogfood-cursor.sh /path/to/repo
```

If your Cursor agent binary has a non-standard path, set `CURSOR_BIN=/path/to/agent`. The script defaults to `CURSOR_MODEL=auto` because Cursor Free plans may reject named models. Override with `CURSOR_MODEL=<model>` if needed. Install Cursor CLI with `curl https://cursor.com/install -fsS | bash`.

