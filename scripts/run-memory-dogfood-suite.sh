#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_REPO="${1:-$HOME/projects/memory-test}"
RUN_ID="${RUN_ID:-$(date +%Y%m%d-%H%M%S)}"
OUT_DIR="${OUT_DIR:-$ROOT/.dogfood-runs/$RUN_ID}"
CLI="node $ROOT/dist/cli.js"
mkdir -p "$OUT_DIR"

log() {
  printf '\n[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" | tee -a "$OUT_DIR/suite.log"
}

run_and_capture() {
  local name="$1"
  shift
  log "START $name"
  set +e
  "$@" >"$OUT_DIR/$name.out" 2>"$OUT_DIR/$name.err"
  local code=$?
  set -e
  {
    echo "exit_code=$code"
    echo "--- stdout ---"
    cat "$OUT_DIR/$name.out"
    echo "--- stderr ---"
    cat "$OUT_DIR/$name.err"
  } >> "$OUT_DIR/suite.log"
  log "END $name exit=$code"
  return $code
}

inspect_state() {
  local label="$1"
  log "INSPECT $label"
  {
    echo "# Inspection: $label"
    echo
    echo "## git status"
    git -C "$TARGET_REPO" status --short || true
    echo
    echo "## repo-memory status"
    $CLI status --cwd "$TARGET_REPO" || true
    echo
    echo "## proposed memories"
    $CLI list --cwd "$TARGET_REPO" --statuses proposed --limit 50 || true
    echo
    echo "## all memories"
    $CLI list --cwd "$TARGET_REPO" --limit 100 || true
  } > "$OUT_DIR/inspect-$label.md" 2>&1
}

if [[ ! -f "$ROOT/dist/server.js" ]]; then
  log "dist/server.js missing, running npm install/build"
  (cd "$ROOT" && npm install && npm run build) | tee -a "$OUT_DIR/suite.log"
fi

log "Dogfood suite output: $OUT_DIR"
log "Target repo: $TARGET_REPO"

run_and_capture reset "$ROOT/scripts/reset-memory-test.sh" "$TARGET_REPO"
inspect_state after-reset

run_turn() {
  local name="$1"
  local runner="$2"
  local prompt="$3"
  DOGFOOD_OVERWRITE_PROMPT=0 PROMPT_FILE="$TARGET_REPO/prompts/$prompt" "$ROOT/scripts/$runner" "$TARGET_REPO" \
    >"$OUT_DIR/$name.out" 2>"$OUT_DIR/$name.err"
}

for spec in \
  "turn-1-claude dogfood-claude.sh turn-1-claude.md" \
  "turn-2-cursor dogfood-cursor.sh turn-2-cursor.md" \
  "turn-3-claude dogfood-claude.sh turn-3-claude.md" \
  "turn-4-cursor dogfood-cursor.sh turn-4-cursor.md"; do
  set -- $spec
  name="$1"; runner="$2"; prompt="$3"
  log "START $name via $runner"
  set +e
  DOGFOOD_OVERWRITE_PROMPT=0 PROMPT_FILE="$TARGET_REPO/prompts/$prompt" "$ROOT/scripts/$runner" "$TARGET_REPO" \
    >"$OUT_DIR/$name.out" 2>"$OUT_DIR/$name.err"
  code=$?
  set -e
  {
    echo "# $name"
    echo "exit_code=$code"
    echo "prompt=$prompt"
    echo
    echo "## stdout"
    cat "$OUT_DIR/$name.out"
    echo
    echo "## stderr"
    cat "$OUT_DIR/$name.err"
  } > "$OUT_DIR/$name.md"
  cat "$OUT_DIR/$name.md" >> "$OUT_DIR/suite.log"
  log "END $name exit=$code"
  inspect_state "after-$name"
  if [[ "$code" != "0" && "${CONTINUE_ON_ERROR:-0}" != "1" ]]; then
    log "Stopping after $name failure. Set CONTINUE_ON_ERROR=1 to continue."
    break
  fi
done

log "Writing final summary"
{
  echo "# Repo-memory dogfood suite $RUN_ID"
  echo
  echo "Target repo: $TARGET_REPO"
  echo "Output dir: $OUT_DIR"
  echo
  echo "## Turn outputs"
  for f in "$OUT_DIR"/turn-*.md; do
    [[ -f "$f" ]] || continue
    echo "- $(basename "$f")"
  done
  echo
  echo "## Final inspection"
  cat "$OUT_DIR/inspect-after-turn-4-cursor.md" 2>/dev/null || cat "$OUT_DIR"/inspect-after-*.md | tail -300
} > "$OUT_DIR/summary.md"

log "Done. Read: $OUT_DIR/summary.md"
echo "$OUT_DIR/summary.md"
