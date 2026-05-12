#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { getRepoIdentity } from './repo.js';
import { openCachedStore } from './store-cache.js';
import { getArtifact, searchEvidence, storeArtifact } from './artifacts.js';
import { activeCheckpoints, checkpointTask } from './checkpoints.js';
import { loadProjectContext } from './context.js';
import { installHooks } from './hooks.js';
import { initRepoMemory } from './init.js';
import { deleteMemory, getMemory, getMemoryWithEvidence, linkMemories, linkMemoryEvidence, listMemories, manageMemory, memoryStatus, revalidateMemories, reviewMemories, searchMemories, storeMemory, supersedeMemory, updateMemoryStatus, verifyMemory } from './memory.js';
import { runAndCapture } from './run.js';

const server = new McpServer({ name: 'repo-memory-mcp', version: '0.1.0' });

function getProjectId(db: any, projectKey: string): number {
  return (db.prepare('SELECT id FROM projects WHERE project_key = ?').get(projectKey) as { id: number }).id;
}

function safeJsonArray(value: string | null): string[] {
  try { return value ? JSON.parse(value) : []; } catch { return []; }
}

server.tool('repo_identity', 'Detect current repo/project identity from cwd.', {
  cwd: z.string().optional()
}, async ({ cwd }) => ({ content: [{ type: 'text', text: JSON.stringify(openCachedStore(cwd).repo, null, 2) }] }));

server.tool('init_repo_memory', 'Initialize repo-memory-mcp in this repo: create config, agent instructions, and optional bootstrap memory/hooks.', {
  cwd: z.string().optional(),
  installGitHooks: z.boolean().optional(),
  seed: z.boolean().optional(),
  overwrite: z.boolean().optional(),
  updateGitignore: z.boolean().optional()
}, async (args) => ({ content: [{ type: 'text', text: JSON.stringify(initRepoMemory(args), null, 2) }] }));

const storeMemorySchema = {
  cwd: z.string().optional(),
  type: z.string().optional(),
  title: z.string(),
  claim: z.string(),
  rationale: z.string().optional(),
  files: z.array(z.string()).optional(),
  symbols: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  confidence: z.number().min(0).max(1).optional(),
  artifactId: z.string().optional(),
  evidenceQuote: z.string().optional(),
  evidenceRelation: z.string().optional(),
  status: z.enum(['active', 'proposed']).optional()
};

server.tool('store_memory', 'Store a repo-scoped source-backed memory. Use for durable decisions, gotchas, commands, failures, or facts. Defaults to active unless status=proposed is supplied.', storeMemorySchema, async (args) => ({ content: [{ type: 'text', text: JSON.stringify(storeMemory(args, openCachedStore(args.cwd)), null, 2) }] }));

server.tool('propose_memory', 'Propose a repo memory for later human review. Use this at the end of non-trivial tasks when durable lessons emerged: decisions made, root causes found, gotchas, reusable commands, architecture/config constraints, failed approaches, or important evidence-backed facts. Prefer 1-3 high-signal proposals; do not store secrets, credentials, personal data, or trivial churn.', storeMemorySchema, async (args) => ({ content: [{ type: 'text', text: JSON.stringify(storeMemory({ ...args, status: 'proposed' }, openCachedStore(args.cwd)), null, 2) }] }));

server.tool('remember_project_note', '[compatibility] Prefer store_memory. Store a repo-scoped source-backed memory note.', {
  cwd: z.string().optional(),
  title: z.string(),
  claim: z.string(),
  rationale: z.string().optional(),
  files: z.array(z.string()).optional(),
  symbols: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  confidence: z.number().min(0).max(1).optional()
}, async (args) => ({ content: [{ type: 'text', text: JSON.stringify(storeMemory({ ...args, type: 'note' }, openCachedStore(args.cwd)), null, 2) }] }));

server.tool('store_decision', '[compatibility] Prefer store_memory with type=decision. Store a repo-scoped engineering decision.', {
  cwd: z.string().optional(),
  title: z.string(),
  claim: z.string(),
  rationale: z.string().optional(),
  files: z.array(z.string()).optional(),
  symbols: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  confidence: z.number().min(0).max(1).optional()
}, async (args) => ({ content: [{ type: 'text', text: JSON.stringify(storeMemory({ ...args, type: 'decision' }, openCachedStore(args.cwd)), null, 2) }] }));

server.tool('search_project_memory', 'Search current repo memory. Exact/BM25 first. Re-check code memories if status is not active.', {
  cwd: z.string().optional(),
  query: z.string(),
  limit: z.number().int().min(1).max(50).optional(),
  statuses: z.array(z.string()).optional()
}, async (args) => ({ content: [{ type: 'text', text: JSON.stringify(searchMemories(args, openCachedStore(args.cwd)), null, 2) }] }));

server.tool('get_memory', 'Get one memory by id with provenance metadata and linked evidence.', {
  cwd: z.string().optional(),
  id: z.string()
}, async (args) => ({ content: [{ type: 'text', text: JSON.stringify(getMemory(args, openCachedStore(args.cwd)), null, 2) }] }));

server.tool('get_memory_with_evidence', 'Get one memory by id with linked source artifacts, quotes, and provenance.', {
  cwd: z.string().optional(),
  id: z.string()
}, async (args) => ({ content: [{ type: 'text', text: JSON.stringify(getMemoryWithEvidence(args, openCachedStore(args.cwd)), null, 2) }] }));

server.tool('list_memories', 'List project memories with optional filters.', {
  cwd: z.string().optional(),
  limit: z.number().int().min(1).max(500).optional(),
  offset: z.number().int().min(0).optional(),
  statuses: z.array(z.string()).optional(),
  types: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional()
}, async (args) => ({ content: [{ type: 'text', text: JSON.stringify(listMemories(args, openCachedStore(args.cwd)), null, 2) }] }));

server.tool('checkpoint_task', 'Store lightweight crash/context recovery state for a multi-step coding task. Call after meaningful steps or before risky/long operations.', {
  cwd: z.string().optional(),
  task: z.string(),
  status: z.enum(['in-progress', 'blocked', 'completed', 'abandoned']).optional(),
  completedSteps: z.array(z.string()).optional(),
  currentStep: z.string().optional(),
  nextSteps: z.array(z.string()).optional(),
  blockers: z.array(z.string()).optional(),
  filesChanged: z.array(z.string()).optional(),
  testsRun: z.array(z.string()).optional(),
  avoidRedoing: z.array(z.string()).optional(),
  artifactId: z.string().optional(),
  evidenceQuote: z.string().optional(),
  tags: z.array(z.string()).optional()
}, async (args) => ({ content: [{ type: 'text', text: JSON.stringify(checkpointTask(args, openCachedStore(args.cwd)), null, 2) }] }));

server.tool('active_checkpoints', 'List active checkpoint memories for this repo so agents can resume interrupted multi-step tasks.', {
  cwd: z.string().optional(),
  limit: z.number().int().min(1).max(50).optional()
}, async (args) => ({ content: [{ type: 'text', text: JSON.stringify(activeCheckpoints(args, openCachedStore(args.cwd)), null, 2) }] }));

server.tool('delete_memory', '[compatibility] Prefer manage_memory action=delete. Delete one memory with audit trail.', {
  cwd: z.string().optional(),
  id: z.string(),
  reason: z.string().optional()
}, async (args) => ({ content: [{ type: 'text', text: JSON.stringify(deleteMemory(args, openCachedStore(args.cwd)), null, 2) }] }));

server.tool('memory_status', 'Show memory counts and stale/needs-revalidation memories for current repo.', {
  cwd: z.string().optional()
}, async (args) => ({ content: [{ type: 'text', text: JSON.stringify(memoryStatus(args, openCachedStore(args.cwd)), null, 2) }] }));

server.tool('revalidate_memories', 'Scan git diff staleness between two refs and flag affected memories for human review; this does not prove truth.', {
  cwd: z.string().optional(),
  fromSha: z.string(),
  toSha: z.string().optional()
}, async (args) => ({ content: [{ type: 'text', text: JSON.stringify(revalidateMemories(args, openCachedStore(args.cwd)), null, 2) }] }));

server.tool('review_memories', 'List stale and needs-revalidation memories with suggested review commands.', {
  cwd: z.string().optional(),
  limit: z.number().int().min(1).max(500).optional()
}, async (args) => ({ content: [{ type: 'text', text: JSON.stringify(reviewMemories(args, openCachedStore(args.cwd)), null, 2) }] }));

server.tool('store_artifact', 'Store a large artifact such as logs, command output, diffs, or transcripts. Returns preview and stable ID.', {
  cwd: z.string().optional(),
  type: z.string().optional(),
  title: z.string(),
  body: z.string(),
  eventId: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
}, async (args) => ({ content: [{ type: 'text', text: JSON.stringify(storeArtifact(args, openCachedStore(args.cwd)), null, 2) }] }));

server.tool('get_artifact', 'Retrieve an artifact by ID with offset/limit paging.', {
  cwd: z.string().optional(),
  id: z.string(),
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(20000).optional()
}, async (args) => ({ content: [{ type: 'text', text: JSON.stringify(getArtifact(args, openCachedStore(args.cwd)), null, 2) }] }));

server.tool('search_evidence', 'Search raw source artifacts/evidence. Use before trusting or creating claims.', {
  cwd: z.string().optional(),
  query: z.string(),
  limit: z.number().int().min(1).max(50).optional()
}, async (args) => ({ content: [{ type: 'text', text: JSON.stringify(searchEvidence(args, openCachedStore(args.cwd)), null, 2) }] }));

server.tool('link_memory_evidence', 'Attach a source artifact and optional quote to an existing memory claim.', {
  cwd: z.string().optional(),
  memoryId: z.string(),
  artifactId: z.string(),
  relation: z.string().optional(),
  quote: z.string().optional()
}, async (args) => ({ content: [{ type: 'text', text: JSON.stringify(linkMemoryEvidence(args, openCachedStore(args.cwd)), null, 2) }] }));

server.tool('install_git_hooks', 'Install best-effort git hooks to revalidate memory after checkout/merge/rewrite.', {
  cwd: z.string().optional(),
  command: z.string().optional()
}, async (args) => ({ content: [{ type: 'text', text: JSON.stringify(installHooks(args), null, 2) }] }));

server.tool('load_project_context', 'Start here for non-trivial tasks. Returns a task-specific readable repo context briefing with relevant memories, decisions, commands, and stale warnings.', {
  cwd: z.string().optional(),
  task: z.string(),
  limit: z.number().int().min(1).max(25).optional(),
  format: z.enum(['brief', 'json']).optional()
}, async (args) => {
  const result = loadProjectContext({ ...args, format: args.format ?? 'brief' });
  return { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }] };
});

server.tool('recent_activity', 'Show compact recent repo-memory events, artifacts, and memories. Use near task end to decide whether any durable proposed memories are worth creating.', {
  cwd: z.string().optional(),
  limit: z.number().int().min(1).max(25).optional()
}, async (args) => {
  const { db, repo } = openCachedStore(args.cwd);
  const pid = getProjectId(db, repo.projectKey);
  const limit = args.limit ?? 8;
  const events = db.prepare(`SELECT id, type, title, source, commit_sha, created_at FROM events WHERE project_id = ? ORDER BY created_at DESC LIMIT ?`).all(pid, limit);
  const artifacts = db.prepare(`SELECT id, type, title, preview, commit_sha, created_at FROM artifacts WHERE project_id = ? ORDER BY created_at DESC LIMIT ?`).all(pid, limit);
  const memories = db.prepare(`SELECT id, type, title, claim, status, files_json, tags_json, updated_at FROM memories WHERE project_id = ? ORDER BY updated_at DESC LIMIT ?`).all(pid, limit).map((m: any) => ({ ...m, files: safeJsonArray(m.files_json), tags: safeJsonArray(m.tags_json), files_json: undefined, tags_json: undefined }));
  return { content: [{ type: 'text', text: JSON.stringify({ project: repo.projectKey, limit, events, artifacts, memories }, null, 2) }] };
});

server.tool('finish_task', 'Call before the final response on non-trivial tasks. Summarize work and propose 0-3 durable memories only: decisions, root causes, gotchas, reusable commands, architecture/config constraints, failed approaches. Do not propose secrets, personal data, temporary edits, or trivial churn.', {
  cwd: z.string().optional(),
  summary: z.string(),
  filesChanged: z.array(z.string()).optional(),
  testsRun: z.array(z.string()).optional(),
  outcome: z.string().optional(),
  proposedMemories: z.array(z.object({
    type: z.string().optional(),
    title: z.string(),
    claim: z.string(),
    rationale: z.string().optional(),
    files: z.array(z.string()).optional(),
    symbols: z.array(z.string()).optional(),
    tags: z.array(z.string()).optional(),
    artifactId: z.string().optional(),
    quote: z.string().optional()
  })).max(3).optional()
}, async (args) => {
  const store = openCachedStore(args.cwd);
  const body = [
    `Summary: ${args.summary}`,
    args.outcome ? `Outcome: ${args.outcome}` : '',
    args.filesChanged?.length ? `Files changed:\n${args.filesChanged.map((f) => `- ${f}`).join('\n')}` : '',
    args.testsRun?.length ? `Tests run:\n${args.testsRun.map((t) => `- ${t}`).join('\n')}` : ''
  ].filter(Boolean).join('\n\n');
  const artifact = storeArtifact({ cwd: args.cwd, type: 'task-summary', title: 'Task summary', body, metadata: { filesChanged: args.filesChanged ?? [], testsRun: args.testsRun ?? [], outcome: args.outcome ?? null } }, store);
  const proposals = (args.proposedMemories ?? []).map((proposal) => storeMemory({
    ...proposal,
    cwd: args.cwd,
    status: 'proposed',
    artifactId: proposal.artifactId ?? artifact.id,
    evidenceQuote: proposal.quote,
    evidenceRelation: proposal.quote ? 'supports' : 'task-summary'
  }, store));
  return { content: [{ type: 'text', text: JSON.stringify({ artifactId: artifact.id, proposedCount: proposals.length, proposedMemories: proposals, message: proposals.length ? `Created ${proposals.length} proposed memor${proposals.length === 1 ? 'y' : 'ies'} for review.` : 'No memories proposed. Task summary artifact stored for recent activity/review.' }, null, 2) }] };
});

server.tool('run_command_capture', 'Run a command, store stdout/stderr as an artifact, and create a searchable source-backed memory of the result.', {
  cwd: z.string().optional(),
  command: z.array(z.string()).min(1),
  title: z.string().optional(),
  remember: z.boolean().optional()
}, async (args) => ({ content: [{ type: 'text', text: JSON.stringify(runAndCapture(args, openCachedStore(args.cwd)), null, 2) }] }));

server.tool('manage_memory', 'Manage memory lifecycle: verify, mark, delete, link, or supersede. Prefer this over individual lifecycle tools.', {
  cwd: z.string().optional(),
  action: z.enum(['verify', 'mark', 'delete', 'link', 'supersede']),
  id: z.string().optional(),
  status: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
  reason: z.string().optional(),
  fromId: z.string().optional(),
  toId: z.string().optional(),
  relation: z.string().optional(),
  oldId: z.string().optional(),
  newId: z.string().optional()
}, async (args) => ({ content: [{ type: 'text', text: JSON.stringify(manageMemory(args as any, openCachedStore(args.cwd)), null, 2) }] }));

server.tool('verify_memory', '[compatibility] Prefer manage_memory action=verify. Mark a memory active and verified against current HEAD.', {
  cwd: z.string().optional(),
  id: z.string(),
  confidence: z.number().min(0).max(1).optional()
}, async (args) => ({ content: [{ type: 'text', text: JSON.stringify(verifyMemory(args, openCachedStore(args.cwd)), null, 2) }] }));

server.tool('update_memory_status', 'Update memory lifecycle status.', {
  cwd: z.string().optional(),
  id: z.string(),
  status: z.enum(['active', 'proposed', 'probably-active', 'needs-revalidation', 'stale', 'superseded', 'historical', 'rejected']),
  confidence: z.number().min(0).max(1).optional()
}, async (args) => ({ content: [{ type: 'text', text: JSON.stringify(updateMemoryStatus(args, openCachedStore(args.cwd)), null, 2) }] }));

server.tool('link_memories', 'Create a typed relationship between two memories.', {
  cwd: z.string().optional(),
  fromId: z.string(),
  toId: z.string(),
  relation: z.string()
}, async (args) => ({ content: [{ type: 'text', text: JSON.stringify(linkMemories(args, openCachedStore(args.cwd)), null, 2) }] }));

server.tool('supersede_memory', 'Mark an old memory superseded by a newer memory and link them.', {
  cwd: z.string().optional(),
  oldId: z.string(),
  newId: z.string()
}, async (args) => ({ content: [{ type: 'text', text: JSON.stringify(supersedeMemory(args, openCachedStore(args.cwd)), null, 2) }] }));

const transport = new StdioServerTransport();
await server.connect(transport);
