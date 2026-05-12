#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_REPO="${1:-$ROOT}"
ALLOWED_ROOT="${REPO_MEMORY_ALLOWED_ROOT:-$(cd "$TARGET_REPO/.." && pwd)}"
MCP_DIR="$TARGET_REPO/.cursor"
MCP_CONFIG="$MCP_DIR/mcp.json"
PROMPT_FILE="${PROMPT_FILE:-$ROOT/.mcp-test/cursor-dogfood-prompt.md}"
RUN_MODE="${CURSOR_RUN:-print}" # print | interactive | setup-only
CURSOR_MODEL="${CURSOR_MODEL:-auto}"
MODEL_FLAG=()
if [[ -n "$CURSOR_MODEL" ]]; then
  MODEL_FLAG=(--model "$CURSOR_MODEL")
fi
FORCE_FLAG=()
if [[ "${CURSOR_FORCE:-1}" != "0" ]]; then
  FORCE_FLAG=(--force)
fi
mkdir -p "$MCP_DIR" "$(dirname "$PROMPT_FILE")"

cat > "$MCP_CONFIG" <<JSON
{
  "mcpServers": {
    "repo-memory": {
      "command": "node",
      "args": ["$ROOT/dist/server.js"],
      "env": {
        "REPO_MEMORY_ALLOWED_ROOT": "$ALLOWED_ROOT"
      }
    }
  }
}
JSON

if [[ ! -f "$PROMPT_FILE" || "${DOGFOOD_OVERWRITE_PROMPT:-1}" == "1" ]]; then
cat > "$PROMPT_FILE" <<'PROMPT'
Use repo-memory for this task.

Dogfood test:
1. Call load_project_context for this repo and task.
2. Review the current repo-memory code/docs briefly.
3. Identify one small, safe improvement or documentation gap.
4. If you make a change, run the relevant validation command.
5. If retrieved memories are confirmed, duplicated, stale, or superseded, use repo-memory lifecycle tools such as manage_memory, verify_memory, or supersede_memory.
6. For multi-step work, call checkpoint_task after meaningful progress or before risky/long operations.
7. Before final response, call finish_task with a concise summary, tests run, files changed, and 0-3 proposed memories only if durable lessons emerged.

Do not commit or push. Do not store secrets or personal data.
PROMPT
fi

CURSOR_CANDIDATES=(
  "${CURSOR_BIN:-}"
  "agent"
  "cursor-agent"
  "cursor"
  "/Applications/Cursor.app/Contents/Resources/app/bin/agent"
  "/Applications/Cursor.app/Contents/Resources/app/bin/cursor-agent"
  "/Applications/Cursor.app/Contents/Resources/app/bin/cursor"
  "$HOME/Applications/Cursor.app/Contents/Resources/app/bin/agent"
  "$HOME/Applications/Cursor.app/Contents/Resources/app/bin/cursor-agent"
  "$HOME/Applications/Cursor.app/Contents/Resources/app/bin/cursor"
)
FOUND_CURSOR=""
for candidate in "${CURSOR_CANDIDATES[@]}"; do
  [[ -z "$candidate" ]] && continue
  if command -v "$candidate" >/dev/null 2>&1; then
    FOUND_CURSOR="$(command -v "$candidate")"
    break
  elif [[ -x "$candidate" ]]; then
    FOUND_CURSOR="$candidate"
    break
  fi
done

cat <<INFO
Cursor dogfood setup
====================
Repo-memory root: $ROOT
Target repo:       $TARGET_REPO
Allowed root:      $ALLOWED_ROOT
Project MCP config:$MCP_CONFIG
Prompt file:       $PROMPT_FILE
Run mode:          $RUN_MODE
Cursor model:      $CURSOR_MODEL

The script wrote a project MCP config to:
  $MCP_CONFIG

INFO

if [[ ! -f "$ROOT/dist/server.js" ]]; then
  echo "dist/server.js not found. Run: npm install && npm run build" >&2
  exit 1
fi

if [[ -z "$FOUND_CURSOR" ]]; then
  echo "Cursor agent CLI not found. Install with: curl https://cursor.com/install -fsS | bash"
  echo "Then rerun this script."
  exit 0
fi

echo "Detected Cursor agent CLI: $FOUND_CURSOR"
cd "$TARGET_REPO"

case "$RUN_MODE" in
  setup-only)
    echo "Setup complete. Try: cd '$TARGET_REPO' && '$FOUND_CURSOR' mcp list"
    ;;
  interactive)
    echo "Starting interactive Cursor agent. Approve workspace/MCP prompts if asked."
    echo "Prompt to paste if needed:"
    cat "$PROMPT_FILE"
    "$FOUND_CURSOR" --approve-mcps
    ;;
  print)
    echo "Running Cursor headless dogfood test..."
    "$FOUND_CURSOR" -p --approve-mcps "${MODEL_FLAG[@]}" "${FORCE_FLAG[@]}" < "$PROMPT_FILE"
    ;;
  *)
    echo "Unknown CURSOR_RUN=$RUN_MODE. Use print, interactive, or setup-only." >&2
    exit 1
    ;;
esac
