import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getRepoIdentity } from './repo.js';

const HOOKS = ['post-merge', 'post-checkout', 'post-rewrite'] as const;

export function installHooks(input: { cwd?: string; command?: string }) {
  const repo = getRepoIdentity(input.cwd);
  const hooksDir = join(repo.projectRoot, '.git', 'hooks');
  mkdirSync(hooksDir, { recursive: true });
  const command = input.command ?? `node ${JSON.stringify(resolve(process.argv[1]))}`;
  const written: string[] = [];

  for (const hook of HOOKS) {
    const path = join(hooksDir, hook);
    const script = `#!/bin/sh
# repo-memory-mcp hook (${hook})
# Safe best-effort staleness detection. Does not rewrite memory meaning.
if command -v git >/dev/null 2>&1; then
  CURRENT_SHA=$(git rev-parse HEAD 2>/dev/null)
  STATE_DIR=$(git rev-parse --git-dir 2>/dev/null)/repo-memory
  mkdir -p "$STATE_DIR"
  LAST_FILE="$STATE_DIR/last-head"
  if [ -f "$LAST_FILE" ]; then
    LAST_SHA=$(cat "$LAST_FILE")
    if [ -n "$LAST_SHA" ] && [ -n "$CURRENT_SHA" ] && [ "$LAST_SHA" != "$CURRENT_SHA" ]; then
      ${command} revalidate --from "$LAST_SHA" --to "$CURRENT_SHA" >/dev/null 2>&1 || true
    fi
  fi
  printf "%s" "$CURRENT_SHA" > "$LAST_FILE"
fi
`;
    writeFileSync(path, script);
    chmodSync(path, 0o755);
    written.push(path);
  }

  return { projectRoot: repo.projectRoot, hooks: written };
}
