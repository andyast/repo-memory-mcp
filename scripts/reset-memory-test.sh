#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_REPO="${1:-$HOME/projects/memory-test}"
WIPE_ALL="${WIPE_ALL:-0}"

if [[ "$WIPE_ALL" == "1" ]]; then
  rm -rf "$TARGET_REPO"
fi
mkdir -p "$TARGET_REPO/src" "$TARGET_REPO/tests" "$TARGET_REPO/prompts"
cd "$TARGET_REPO"

rm -rf .repo-memory

cat > package.json <<'JSON'
{
  "name": "memory-test",
  "version": "1.0.0",
  "type": "module",
  "private": true,
  "scripts": {
    "build": "tsc --noEmit",
    "test": "vitest run",
    "check": "npm run build && npm test"
  },
  "dependencies": {
    "jose": "^5.10.0",
    "zod": "^3.25.76"
  },
  "devDependencies": {
    "@types/node": "^22.10.2",
    "typescript": "^5.9.3",
    "vitest": "^2.1.9"
  }
}
JSON

cat > tsconfig.json <<'JSON'
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["node", "vitest/globals"]
  },
  "include": ["src", "tests"]
}
JSON

cat > src/config.ts <<'EOF_TS'
export type AppConfig = {
  issuer: string;
  audience: string;
  tokenSecret: string;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    issuer: env.AUTH_ISSUER ?? 'memory-test',
    audience: env.AUTH_AUDIENCE ?? 'memory-test-users',
    tokenSecret: env.AUTH_TOKEN_SECRET ?? 'dev-secret-minimum-32-characters'
  };
}
EOF_TS

cat > src/auth.ts <<'EOF_TS'
import { SignJWT, jwtVerify } from 'jose';
import type { AppConfig } from './config.js';

const encoder = new TextEncoder();

export type AuthUser = {
  id: string;
  role: 'admin' | 'user';
};

function key(secret: string) {
  return encoder.encode(secret);
}

export async function createToken(user: AuthUser, config: AppConfig): Promise<string> {
  return new SignJWT({ role: user.role })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.id)
    .setIssuer(config.issuer)
    .setAudience(config.audience)
    .setIssuedAt()
    .setExpirationTime('15m')
    .sign(key(config.tokenSecret));
}

export async function verifyToken(token: string, config: AppConfig): Promise<AuthUser> {
  const result = await jwtVerify(token, key(config.tokenSecret), {
    issuer: config.issuer,
    audience: config.audience
  });
  const sub = result.payload.sub;
  const role = result.payload.role;
  if (!sub || (role !== 'admin' && role !== 'user')) {
    throw new Error('Invalid token claims');
  }
  return { id: sub, role };
}
EOF_TS

cat > src/storage.ts <<'EOF_TS'
export type SessionRecord = {
  userId: string;
  refreshToken: string;
  createdAt: Date;
};

export class InMemorySessionStore {
  private sessions = new Map<string, SessionRecord>();

  save(record: SessionRecord) {
    this.sessions.set(record.refreshToken, record);
  }

  find(refreshToken: string): SessionRecord | null {
    return this.sessions.get(refreshToken) ?? null;
  }
}
EOF_TS

cat > src/index.ts <<'EOF_TS'
export * from './auth.js';
export * from './config.js';
export * from './storage.js';
EOF_TS

cat > tests/auth.test.ts <<'EOF_TS'
import { describe, expect, it } from 'vitest';
import { createToken, verifyToken } from '../src/auth.js';
import { loadConfig } from '../src/config.js';

describe('auth tokens', () => {
  it('round-trips a signed token', async () => {
    const config = loadConfig({
      AUTH_ISSUER: 'test-issuer',
      AUTH_AUDIENCE: 'test-audience',
      AUTH_TOKEN_SECRET: 'test-secret-minimum-32-characters'
    });
    const token = await createToken({ id: 'user-1', role: 'admin' }, config);
    await expect(verifyToken(token, config)).resolves.toEqual({ id: 'user-1', role: 'admin' });
  });
});
EOF_TS

cat > README.md <<'EOF_MD'
# memory-test

Tiny TypeScript app used to dogfood repo-memory-mcp across multiple coding agents.

The point is not the app. The point is whether agents can share project memory across turns without the engineer manually restating decisions.

## Validation

```bash
npm run check
```

## Dogfood sequence

Run alternating Claude and Cursor turns from `../repo-memory-mcp` scripts. After each turn, inspect proposed memories and git diff.
EOF_MD

cat > CLAUDE.md <<'EOF_MD'
# Claude instructions for memory-test

This repo is a dogfood fixture for repo-memory-mcp.

- At task start, call `load_project_context` with this repo root as `cwd`.
- Before non-trivial code changes, search repo memory for relevant decisions, gotchas, and commands.
- After application code changes, run `npm run check`.
- At task end, call `finish_task` with summary, files changed, tests run, and 0-3 proposed memories only if durable lessons emerged.
- Do not store secrets, credentials, personal data, or trivial churn.
EOF_MD

cat > prompts/turn-1-claude.md <<'EOF_PROMPT'
Use repo-memory for this task.

Turn 1, Claude:
- Call load_project_context first.
- Review the auth/config code.
- Add one small improvement that makes token/config validation more robust.
- Run npm run check.
- If retrieved memories are confirmed, duplicated, stale, or superseded, use lifecycle tools such as manage_memory, verify_memory, or supersede_memory.
- Before final response, call finish_task with summary, files changed, tests run, and 0-3 proposed memories if durable lessons emerged.
- Do not commit or push.
EOF_PROMPT

cat > prompts/turn-2-cursor.md <<'EOF_PROMPT'
Use repo-memory for this task.

Turn 2, Cursor:
- Call load_project_context first and use any prior Claude memories.
- This is a code-behavior turn, not a docs-review turn. Do not choose a README/CLAUDE.md-only change unless the code task is impossible.
- Add a small storage/session improvement that should not contradict existing auth/config decisions. Good examples: add delete/revoke behavior, add list/count behavior, or tighten SessionRecord validation.
- Add or update tests for the storage/session behavior.
- Run npm run check.
- If retrieved memories are confirmed, duplicated, stale, or superseded, use lifecycle tools such as manage_memory, verify_memory, or supersede_memory.
- Before final response, call finish_task with summary, files changed, tests run, and 0-3 proposed memories if durable lessons emerged.
- Do not commit or push.
EOF_PROMPT

cat > prompts/turn-3-claude.md <<'EOF_PROMPT'
Use repo-memory for this task.

Turn 3, Claude:
- Call load_project_context first and explicitly consider prior Cursor memories.
- Add or improve tests around the most important repo-specific behavior discovered so far.
- Run npm run check.
- If a prior memory is now stale or duplicated, use lifecycle tools appropriately.
- If retrieved memories are confirmed, duplicated, stale, or superseded, use lifecycle tools such as manage_memory, verify_memory, or supersede_memory.
- Before final response, call finish_task with summary, files changed, tests run, and 0-3 proposed memories if durable lessons emerged.
- Do not commit or push.
EOF_PROMPT

cat > prompts/turn-4-cursor.md <<'EOF_PROMPT'
Use repo-memory for this task.

Turn 4, Cursor:
- Call load_project_context first.
- Review the accumulated memories and code.
- Make one small docs or code cleanup that reflects the learned project conventions.
- Run relevant validation.
- If retrieved memories are confirmed, duplicated, stale, or superseded, use lifecycle tools such as manage_memory, verify_memory, or supersede_memory.
- Before final response, call finish_task with summary, files changed, tests run, and 0-3 proposed memories if durable lessons emerged.
- Do not commit or push.
EOF_PROMPT

if [[ ! -d .git ]]; then
  git init -b main >/dev/null
fi
git config user.name "Repo Memory Dogfood"
git config user.email "repo-memory-dogfood@example.local"
cat > .gitignore <<'EOF_GIT'
node_modules/
dist/
.repo-memory/
EOF_GIT

npm install >/dev/null
npm run check

mkdir -p .cursor
cat > .cursor/mcp.json <<EOF_CURSOR
{
  "mcpServers": {
    "repo-memory": {
      "command": "node",
      "args": ["$ROOT/dist/server.js"],
      "env": {
        "REPO_MEMORY_ALLOWED_ROOT": "$(cd "$TARGET_REPO/.." && pwd)"
      }
    }
  }
}
EOF_CURSOR

node "$ROOT/dist/cli.js" init --cwd "$TARGET_REPO" --update-gitignore

# Keep the fixture baseline committed so each agent turn produces readable diffs.
# .repo-memory is ignored by .gitignore, so git add -A tracks app/docs/config without the DB.
git add -A
if ! git diff --cached --quiet; then
  if git rev-parse --verify HEAD >/dev/null 2>&1; then
    git commit -m "Reset memory dogfood fixture baseline" >/dev/null
  else
    git commit -m "Create memory dogfood test app" >/dev/null
  fi
fi
if ! git rev-parse --verify HEAD >/dev/null 2>&1; then
  echo "Failed to create fixture baseline commit. Debug status:" >&2
  git status --short >&2 || true
  git diff --cached --stat >&2 || true
  exit 1
fi

cat <<INFO
Reset memory-test fixture complete.

Target repo: $TARGET_REPO
Memory DB:   $TARGET_REPO/.repo-memory/store.db

Suggested sequence from repo-memory-mcp root:
  scripts/dogfood-claude.sh "$TARGET_REPO"
  scripts/dogfood-cursor.sh "$TARGET_REPO"

Turn prompts are in:
  $TARGET_REPO/prompts/

Inspect after each turn:
  node "$ROOT/dist/cli.js" list --cwd "$TARGET_REPO" --statuses proposed
  node "$ROOT/dist/cli.js" status --cwd "$TARGET_REPO"
  git -C "$TARGET_REPO" status --short
INFO
