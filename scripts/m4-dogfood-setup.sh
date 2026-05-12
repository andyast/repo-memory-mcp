#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_REPO="${1:-$ROOT}"
ALLOWED_ROOT="${REPO_MEMORY_ALLOWED_ROOT:-$(cd "$TARGET_REPO/.." && pwd)}"
MCP_DIR="$ROOT/.mcp-test"
MCP_CONFIG="$MCP_DIR/repo-memory-mcp.json"
CURSOR_CONFIG="$MCP_DIR/cursor-mcp.json"
CLAUDE_PROMPT="$MCP_DIR/dogfood-prompt.md"

mkdir -p "$MCP_DIR"

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
cp "$MCP_CONFIG" "$CURSOR_CONFIG"

cat > "$CLAUDE_PROMPT" <<'PROMPT'
Use repo-memory for this task.

Dogfood test:
1. Call load_project_context for this repo and task.
2. Review the current repo-memory code/docs briefly.
3. Identify one small, safe improvement or documentation gap.
4. If you make a change, run the relevant validation command.
5. Before final response, call finish_task with a concise summary, tests run, files changed, and 0-3 proposed memories only if durable lessons emerged.

Do not commit or push. Do not store secrets or personal data.
PROMPT

printf '\nrepo-memory M4 dogfood setup\n'
printf '==========================\n'
printf 'Repo-memory root: %s\n' "$ROOT"
printf 'Target repo:       %s\n' "$TARGET_REPO"
printf 'Allowed root:      %s\n' "$ALLOWED_ROOT"
printf 'MCP config:        %s\n' "$MCP_CONFIG"
printf 'Prompt file:       %s\n' "$CLAUDE_PROMPT"
printf '\n'

if command -v node >/dev/null 2>&1; then
  printf 'node:   %s (%s)\n' "$(command -v node)" "$(node --version)"
else
  printf 'node:   NOT FOUND\n'
fi

if command -v npm >/dev/null 2>&1; then
  printf 'npm:    %s (%s)\n' "$(command -v npm)" "$(npm --version)"
else
  printf 'npm:    NOT FOUND\n'
fi

if command -v claude >/dev/null 2>&1; then
  printf 'claude: %s\n' "$(command -v claude)"
else
  printf 'claude: NOT FOUND\n'
fi

CURSOR_CANDIDATES=(
  "cursor"
  "/Applications/Cursor.app/Contents/Resources/app/bin/cursor"
  "/Applications/Cursor.app/Contents/MacOS/Cursor"
  "$HOME/Applications/Cursor.app/Contents/Resources/app/bin/cursor"
  "$HOME/Applications/Cursor.app/Contents/MacOS/Cursor"
)
FOUND_CURSOR=""
for candidate in "${CURSOR_CANDIDATES[@]}"; do
  if command -v "$candidate" >/dev/null 2>&1; then
    FOUND_CURSOR="$(command -v "$candidate")"
    break
  elif [[ -x "$candidate" ]]; then
    FOUND_CURSOR="$candidate"
    break
  fi
done

if [[ -n "$FOUND_CURSOR" ]]; then
  printf 'cursor: %s\n' "$FOUND_CURSOR"
else
  printf 'cursor: NOT FOUND as CLI. Cursor app may still work with MCP config manually.\n'
fi

printf '\nNext steps:\n'
printf '1. npm install && npm run build\n'
printf '2. scripts/dogfood-claude.sh "%s"\n' "$TARGET_REPO"
printf '3. scripts/dogfood-cursor.sh "%s"\n' "$TARGET_REPO"
printf '\nFor Cursor app MCP config, copy this JSON into Cursor MCP settings if needed:\n%s\n' "$CURSOR_CONFIG"
