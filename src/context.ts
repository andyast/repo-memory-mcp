import { openStore, projectId, type Store } from './db.js';
import { searchMemories } from './memory.js';

function parseArray(value: string | null): string[] { try { return value ? JSON.parse(value) : []; } catch { return []; } }

export function loadProjectContext(input: { cwd?: string; task: string; limit?: number; format?: 'json' | 'brief' }, store?: Store) {
  const { db, repo } = store ?? openStore(input.cwd);
  const pid = projectId(db, repo.projectKey);
  const limit = Math.min(Math.max(input.limit ?? 8, 1), 25);

  let taskMatches = searchMemories({ cwd: repo.projectRoot, query: input.task, limit }, store);
  if (!taskMatches.length) {
    const fallbackTerms = input.task.split(/\s+/).filter((term) => term.length > 2);
    for (const term of fallbackTerms) {
      taskMatches = searchMemories({ cwd: repo.projectRoot, query: term, limit }, store);
      if (taskMatches.length) break;
    }
  }
  const activeCheckpoints = db.prepare(`
    SELECT * FROM memories
    WHERE project_id = ? AND type = 'checkpoint' AND status IN ('active', 'probably-active')
    ORDER BY updated_at DESC
    LIMIT 5
  `).all(pid).map(formatMemory).filter((m: any) => !m.tags.includes('completed') && !m.tags.includes('abandoned'));
  const decisions = listByTypes(db, pid, ['decision'], 5);
  const gotchas = listByTagsOrTypes(db, pid, ['gotcha', 'warning'], ['gotcha'], 5);
  const testCommands = listByTagsOrTypes(db, pid, ['test', 'command'], ['test-command'], 5);
  const needsAttention = db.prepare(`
    SELECT * FROM memories
    WHERE project_id = ? AND status IN ('needs-revalidation', 'stale')
    ORDER BY updated_at DESC
    LIMIT 10
  `).all(pid).map(formatMemory);

  const pack = {
    project: repo,
    task: input.task,
    guidance: [
      'Use this as a starting context pack, not absolute truth.',
      'For code-related memories, re-check referenced files before editing.',
      'Treat needs-revalidation/stale memories as warnings, not facts.'
    ],
    activeCheckpoints: dedupeMemories(activeCheckpoints),
    taskMatches: dedupeMemories(taskMatches),
    decisions: dedupeMemories(decisions, new Set(taskMatches.map((m: any) => m.id))),
    gotchas: dedupeMemories(gotchas),
    testCommands: dedupeMemories(testCommands),
    needsAttention: dedupeMemories(needsAttention),
    suggestedNextActions: suggest(needsAttention.length)
  };

  return input.format === 'brief' ? formatBrief(pack) : pack;
}

function dedupeMemories(memories: any[], seen = new Set<string>()) {
  const out: any[] = [];
  for (const memory of memories) {
    if (seen.has(memory.id)) continue;
    seen.add(memory.id);
    out.push(memory);
  }
  return out;
}

function formatBrief(pack: any): string {
  const identity = [
    `Project: ${pack.project.projectRoot}`,
    pack.project.repoRemote ? `Remote: ${pack.project.repoRemote}` : '',
    `Branch: ${pack.project.branch ?? 'none'} @ ${pack.project.headSha ?? 'no git HEAD'}`,
    `Task: ${pack.task}`
  ].filter(Boolean).join('\n');

  const warnings = pack.needsAttention.length
    ? renderSection('Warnings to verify before relying on them', pack.needsAttention)
    : 'Warnings: none currently flagged.';

  return [
    identity,
    renderSection('Active checkpoints / resume state', pack.activeCheckpoints),
    renderSection('Relevant memories', pack.taskMatches) || 'Relevant memories: none found yet.',
    renderSection('Recent decisions', pack.decisions) || 'Recent decisions: none stored yet.',
    renderSection('Gotchas / warnings from memory', pack.gotchas),
    renderSection('Useful test commands / command results', pack.testCommands),
    warnings,
    `Suggested next action:\n- ${pack.suggestedNextActions[0]}`,
    pack.suggestedNextActions.length > 1 ? `Then:\n${pack.suggestedNextActions.slice(1).map((a: string) => `- ${a}`).join('\n')}` : '',
    'Task-end reminder: if durable lessons emerged, call propose_memory (or finish_task with 0-3 proposedMemories) before the final response.'
  ].filter(Boolean).join('\n\n');
}

function renderSection(title: string, memories: any[]) {
  if (!memories.length) return '';
  return `${title}:\n${memories.map((m) => `- [${m.status}] ${m.title}: ${m.claim}${m.files?.length ? ` (${m.files.join(', ')})` : ''}`).join('\n')}`;
}

function suggest(needsAttentionCount: number): string[] {
  const actions = ['Search exact code symbols/files before changing implementation.'];
  if (needsAttentionCount) actions.push('Run memory_status or revalidate_memories before relying on stale memories.');
  actions.push('For multi-step work, call checkpoint_task after meaningful progress or before risky/long operations.');
  actions.push('After finishing, store durable decisions, gotchas, or test commands with source file anchors.');
  return actions;
}

function listByTypes(db: any, pid: number, types: string[], limit: number) {
  const placeholders = types.map(() => '?').join(',');
  return db.prepare(`SELECT * FROM memories WHERE project_id = ? AND type IN (${placeholders}) ORDER BY updated_at DESC LIMIT ?`)
    .all(pid, ...types, limit).map(formatMemory);
}

function listByTagsOrTypes(db: any, pid: number, tags: string[], types: string[], limit: number) {
  const clauses = [
    ...tags.map(() => 'tags_json LIKE ?'),
    ...types.map(() => 'type = ?')
  ].join(' OR ');
  const values = [...tags.map((tag) => `%${tag}%`), ...types];
  return db.prepare(`SELECT * FROM memories WHERE project_id = ? AND (${clauses}) ORDER BY updated_at DESC LIMIT ?`)
    .all(pid, ...values, limit).map(formatMemory);
}

function formatMemory(row: any) {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    claim: row.claim,
    rationale: row.rationale,
    status: row.status,
    confidence: row.confidence,
    observedCommit: row.observed_commit,
    lastVerifiedCommit: row.last_verified_commit,
    files: parseArray(row.files_json),
    symbols: parseArray(row.symbols_json),
    tags: parseArray(row.tags_json),
    sourceEventId: row.source_event_id,
    sourceArtifactId: row.source_artifact_id,
    updatedAt: row.updated_at
  };
}
