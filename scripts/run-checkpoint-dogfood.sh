#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_REPO="${1:-$HOME/projects/memory-checkpoint-test}"
RUN_ID="${RUN_ID:-$(date +%Y%m%d-%H%M%S)}"
OUT_DIR="${OUT_DIR:-$ROOT/.dogfood-runs/checkpoint-$RUN_ID}"
mkdir -p "$OUT_DIR"

log() { printf '\n[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" | tee -a "$OUT_DIR/checkpoint-suite.log"; }

log "Checkpoint dogfood output: $OUT_DIR"
log "Target repo: $TARGET_REPO"

log "Reset fixture"
WIPE_ALL=1 "$ROOT/scripts/reset-memory-test.sh" "$TARGET_REPO" >"$OUT_DIR/reset.out" 2>"$OUT_DIR/reset.err"

PROMPT_FILE="$TARGET_REPO/prompts/checkpoint-long-task.md"
cat > "$PROMPT_FILE" <<'PROMPT'
Use repo-memory for this task.

This is a long multi-step coding task intended to test crash/context-window recovery behavior. Use repo-memory checkpoints when they would help a future agent resume if you crash or run out of context.

Task: Add a small refresh-token session lifecycle feature to this repo.

Plan to follow, in order:
1. Call load_project_context with this repo cwd and this task.
2. Inspect src/storage.ts, src/index.ts, package.json, and existing tests.
3. Call checkpoint_task after inspection with what you learned and the next implementation step.
4. Add a SessionRecord metadata field, `revokedAt?: Date`, without breaking existing callers.
5. Add `revoke(refreshToken)` if missing, returning true only when an active session was revoked.
6. Add `isRevoked(refreshToken)` returning true for revoked known sessions and false for unknown tokens.
7. Add `activeCount()` returning only non-revoked sessions.
8. Make `find(refreshToken)` return null for revoked sessions.
9. Add or update tests for save/find, revoke idempotency, activeCount, isRevoked, whitespace trimming, and unknown tokens.
10. Run npm run check. If it fails, store useful error output as an artifact and checkpoint the failure before fixing it.
11. Fix failures and rerun npm run check until green.
12. Call checkpoint_task with status completed summarizing completed steps, files changed, tests run, and anything a future agent should avoid redoing.
13. Call finish_task with summary, files changed, tests run, and 0-3 proposed memories only if durable lessons emerged.

Important expectations:
- This is not a docs-only task.
- Use checkpoint_task at least after inspection and again at completion. Use more checkpoints only if they add real resume value.
- Do not commit or push.
- Do not store secrets or personal data.
PROMPT

log "Run Claude long checkpoint task"
set +e
PROMPT_FILE="$PROMPT_FILE" DOGFOOD_OVERWRITE_PROMPT=0 "$ROOT/scripts/dogfood-claude.sh" "$TARGET_REPO" >"$OUT_DIR/checkpoint-task.out" 2>"$OUT_DIR/checkpoint-task.err"
CODE=$?
set -e
{
  echo "# checkpoint-long-task"
  echo "exit_code=$CODE"
  echo "prompt=$(basename "$PROMPT_FILE")"
  echo
  echo "## stdout"
  cat "$OUT_DIR/checkpoint-task.out"
  echo
  echo "## stderr"
  cat "$OUT_DIR/checkpoint-task.err"
} > "$OUT_DIR/checkpoint-task.md"
cat "$OUT_DIR/checkpoint-task.md" >> "$OUT_DIR/checkpoint-suite.log"
log "Task exit=$CODE"

CLI="node $ROOT/dist/cli.js"
log "Inspect final state"
{
  echo "# Checkpoint dogfood inspection"
  echo
  echo "## git status"
  git -C "$TARGET_REPO" status --short || true
  echo
  echo "## repo-memory status"
  $CLI status --cwd "$TARGET_REPO" || true
  echo
  echo "## checkpoint memories"
  $CLI list --cwd "$TARGET_REPO" --types checkpoint --limit 50 || true
  echo
  echo "## active checkpoints"
  $CLI list --cwd "$TARGET_REPO" --types checkpoint --statuses active,probably-active --limit 50 || true
  echo
  echo "## proposed memories"
  $CLI list --cwd "$TARGET_REPO" --statuses proposed --limit 50 || true
  echo
  echo "## all memories"
  $CLI list --cwd "$TARGET_REPO" --limit 100 || true
} > "$OUT_DIR/inspect-final.md" 2>&1

{
  echo "# Checkpoint dogfood suite $RUN_ID"
  echo
  echo "Target repo: $TARGET_REPO"
  echo "Output dir: $OUT_DIR"
  echo
  cat "$OUT_DIR/checkpoint-task.md"
  echo
  cat "$OUT_DIR/inspect-final.md"
} > "$OUT_DIR/summary.md"

log "Done. Read: $OUT_DIR/summary.md"
echo "$OUT_DIR/summary.md"
exit "$CODE"
