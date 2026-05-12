#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_REPO="${1:-$ROOT}"
ALLOWED_ROOT="${REPO_MEMORY_ALLOWED_ROOT:-$(cd "$TARGET_REPO/.." && pwd)}"
MCP_CONFIG="${MCP_CONFIG:-$ROOT/.mcp-test/repo-memory-mcp.json}"
PROMPT_FILE="${PROMPT_FILE:-$ROOT/.mcp-test/dogfood-prompt.md}"
PERMISSION_MODE="${CLAUDE_PERMISSION_MODE:-acceptEdits}"
CLAUDE_MODEL_ARGS=()
if [[ -n "${CLAUDE_MODEL:-}" ]]; then
  CLAUDE_MODEL_ARGS+=(--model "$CLAUDE_MODEL")
fi

mkdir -p "$(dirname "$MCP_CONFIG")"
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

if ! command -v claude >/dev/null 2>&1; then
  echo "Claude CLI not found. Install/login to Claude Code first." >&2
  exit 1
fi

if [[ ! -f "$ROOT/dist/server.js" ]]; then
  echo "dist/server.js not found. Run: npm install && npm run build" >&2
  exit 1
fi

cd "$TARGET_REPO"
echo "Running Claude dogfood test in $TARGET_REPO"
echo "Allowed root: $ALLOWED_ROOT"
echo "MCP config: $MCP_CONFIG"

claude -p \
  --mcp-config "$MCP_CONFIG" \
  --permission-mode "$PERMISSION_MODE" \
  ${CLAUDE_MODEL_ARGS+"${CLAUDE_MODEL_ARGS[@]}"} \
  --allowedTools "Read,Edit,Write,Bash(npm:*),Bash(git:*),mcp__repo-memory__load_project_context,mcp__repo-memory__recent_activity,mcp__repo-memory__finish_task,mcp__repo-memory__checkpoint_task,mcp__repo-memory__active_checkpoints,mcp__repo-memory__propose_memory,mcp__repo-memory__store_artifact,mcp__repo-memory__search_project_memory,mcp__repo-memory__get_memory,mcp__repo-memory__list_memories,mcp__repo-memory__memory_status,mcp__repo-memory__manage_memory,mcp__repo-memory__verify_memory,mcp__repo-memory__update_memory_status,mcp__repo-memory__link_memories,mcp__repo-memory__supersede_memory,mcp__repo-memory__get_memory_with_evidence,mcp__repo-memory__link_memory_evidence,mcp__repo-memory__search_evidence" \
  < "$PROMPT_FILE"
