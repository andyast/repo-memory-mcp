import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openStore } from './db.js';
import { installHooks } from './hooks.js';
import { storeMemory } from './memory.js';

export const AGENT_INSTRUCTIONS = `## Repo Memory

This repo uses repo-memory-mcp for durable, source-backed engineering memory.

### Task start

At the start of any non-trivial task, call \`load_project_context\` with the current task and repo cwd. Before making architecture, auth, deployment, config, test, or debugging changes, search repo memory.

If retrieved memory is \`stale\` or \`needs-revalidation\`, re-check referenced files before relying on it.

### During work

Store artifacts for important command output, errors, logs, diffs, or transcripts when they would help support or review a future memory. Prefer artifacts for large/raw evidence; keep memories as concise claims.

For multi-step coding tasks, use \`checkpoint_task\` to record work-in-progress state after meaningful completed steps and before risky or long-running operations. Checkpoints are for crash/context-window recovery: include completed steps, current step, next steps, blockers, files changed, tests run, and anything to avoid redoing. Use \`active_checkpoints\` or \`load_project_context\` to resume interrupted work.

Memories are durable truths and lessons. Checkpoints are temporary task state; mark them completed or abandoned when they are no longer useful.

### Task end

At the end of a non-trivial task, propose 1-3 memories only when durable lessons emerged. Default to proposed memories by calling \`propose_memory\` (or \`store_memory\` with \`status: "proposed"\`), not active memories. Only create active memories when the user explicitly says to remember/store something as accepted fact.

Good proposed memory categories:

- Decision: why a library, API, schema, or deployment path was chosen.
- Gotcha: surprising behavior that could waste future debugging time.
- Command: a reusable command or workflow that worked for this repo.
- Root cause: the underlying cause of a bug or incident.
- Architecture/config constraint: a repo-specific rule future changes must respect.
- Failed approach: something plausible that was tried and should not be repeated.

Do not store secrets, credentials, tokens, personal data, unrelated preferences, or trivial churn such as temporary edits, obvious implementation details, or one-off command noise.
`;

export function initRepoMemory(input: { cwd?: string; installGitHooks?: boolean; seed?: boolean; overwrite?: boolean; updateGitignore?: boolean }) {
  const { repo } = openStore(input.cwd);
  const dir = join(repo.projectRoot, '.repo-memory');
  mkdirSync(dir, { recursive: true });

  const configPath = join(dir, 'config.json');
  const instructionsPath = join(dir, 'AGENT_INSTRUCTIONS.md');
  const config = {
    name: 'repo-memory-mcp',
    version: 1,
    projectRoot: repo.projectRoot,
    projectKey: repo.projectKey,
    repoRemote: repo.repoRemote,
    branch: repo.branch,
    headSha: repo.headSha,
    recommendedEnv: {
      REPO_MEMORY_ALLOWED_ROOT: repo.projectRoot
    },
    createdAt: new Date().toISOString()
  };

  if (input.overwrite || !existsSync(configPath)) {
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  }
  if (input.overwrite || !existsSync(instructionsPath)) {
    writeFileSync(instructionsPath, AGENT_INSTRUCTIONS);
  }

  const seeded: string[] = [];
  if (input.seed ?? true) {
    const seedMemories = [
      {
        type: 'bootstrap',
        title: 'Repo memory bootstrap',
        claim: 'This repo uses repo-memory-mcp for local-first, source-backed engineering memory across MCP clients.',
        rationale: 'Agents should load project context at task start and propose durable memories at task end.',
        tags: ['repo-memory', 'bootstrap', 'instructions'],
        confidence: 1
      },
      {
        type: 'workflow',
        title: 'Discover repo validation commands',
        claim: "Before relying on a validation command, inspect this repo's package scripts, README, or documented build/test workflow; do not assume commands from another repo apply here.",
        rationale: 'Repo-memory seed guidance should help agents find project-local validation without polluting new repos with repo-memory-mcp-specific commands.',
        tags: ['validation', 'commands', 'repo-local'],
        confidence: 0.9
      },
      {
        type: 'decision',
        title: 'Memories are source-backed claims',
        claim: 'Repo memories should be concise claims linked to files, symbols, artifacts, or evidence quotes rather than large raw logs.',
        rationale: 'Artifacts preserve bulky evidence while memories stay useful in compact context packs.',
        tags: ['memory-design', 'evidence'],
        confidence: 0.9
      },
      {
        type: 'workflow',
        title: 'End-of-task proposal loop',
        claim: 'Agents should propose 0-3 durable memories at task end only when decisions, gotchas, root causes, commands, or failed approaches emerged.',
        rationale: 'Proposals capture lessons while fresh without making unreviewed claims active project truth.',
        tags: ['proposed', 'workflow', 'agent-loop'],
        confidence: 0.9
      },
      {
        type: 'workflow',
        title: 'Dashboard review queue',
        claim: 'Use proposed and rejected statuses as a human review queue: verify good proposals, reject noisy ones, and keep active memory high-signal.',
        rationale: 'Reviewable lifecycle states reduce spam while preserving an audit trail.',
        tags: ['dashboard', 'review', 'proposed'],
        confidence: 0.85
      }
    ];
    for (const seed of seedMemories) seeded.push(storeMemory({ cwd: repo.projectRoot, ...seed }).id);
  }

  let gitignoreUpdated = false;
  const gitignorePath = join(repo.projectRoot, '.gitignore');
  if (input.updateGitignore) {
    const current = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf8') : '';
    if (!current.split(/\r?\n/).includes('.repo-memory/')) {
      appendFileSync(gitignorePath, `${current.endsWith('\n') || !current ? '' : '\n'}.repo-memory/\n`);
      gitignoreUpdated = true;
    }
  }

  const hooks = input.installGitHooks ? installHooks({ cwd: repo.projectRoot }) : null;

  return {
    projectRoot: repo.projectRoot,
    configPath,
    instructionsPath,
    seededMemoryIds: seeded,
    hooks: hooks?.hooks ?? [],
    gitignorePath,
    gitignoreUpdated,
    instructions: AGENT_INSTRUCTIONS
  };
}
