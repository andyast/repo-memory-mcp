import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { changedFiles, resolveGitRef } from './repo.js';
import { audit, newId, openStore, projectId, withSqliteBusyRetry, type Store } from './db.js';

function j(value: unknown): string { return JSON.stringify(value ?? null); }
function parseArray(value: string | null): string[] { try { return value ? JSON.parse(value) : []; } catch { return []; } }
function safeJson(value: string | null): unknown { try { return value ? JSON.parse(value) : null; } catch { return null; } }

export type StoreMemoryInput = {
  cwd?: string;
  type?: string;
  title: string;
  claim: string;
  rationale?: string;
  files?: string[];
  symbols?: string[];
  tags?: string[];
  confidence?: number;
  artifactId?: string;
  evidenceQuote?: string;
  evidenceRelation?: string;
  status?: string;
};

export type MemoryActionInput =
  | ({ action: 'verify'; id: string; confidence?: number; cwd?: string })
  | ({ action: 'mark'; id: string; status: string; confidence?: number; cwd?: string })
  | ({ action: 'delete'; id: string; reason?: string; cwd?: string })
  | ({ action: 'link'; fromId: string; toId: string; relation: string; cwd?: string })
  | ({ action: 'supersede'; oldId: string; newId: string; cwd?: string });

export function storeMemory(input: StoreMemoryInput, store?: Store) {
  const { db, repo } = store ?? openStore(input.cwd);
  const pid = projectId(db, repo.projectKey);

  const duplicate = db.prepare(`
    SELECT * FROM memories
    WHERE project_id = ?
      AND claim = ?
      AND status != 'superseded'
    ORDER BY
      CASE WHEN title = ? THEN 0 ELSE 1 END,
      updated_at DESC
    LIMIT 1
  `).get(pid, input.claim, input.title) as any | undefined;
  if (duplicate) {
    return { id: duplicate.id, eventId: duplicate.source_event_id, project: repo.projectKey, headSha: repo.headSha, duplicate: true };
  }

  const eventId = newId('event');
  const memoryId = newId('mem');

  const tx = db.transaction(() => {
    db.prepare(`INSERT INTO events(id, project_id, type, title, body, source, commit_sha, branch, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(eventId, pid, input.type ?? 'note', input.title, input.claim, 'manual', repo.headSha, repo.branch, j({ cwd: repo.cwd }));

    db.prepare(`INSERT INTO memories(id, project_id, type, title, claim, rationale, status, confidence, observed_commit, last_verified_commit, files_json, symbols_json, tags_json, source_event_id, source_artifact_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(memoryId, pid, input.type ?? 'note', input.title, input.claim, input.rationale ?? null, input.status ?? 'active', input.confidence ?? 0.8, repo.headSha, input.status === 'proposed' ? null : repo.headSha, j(input.files ?? []), j(input.symbols ?? []), j(input.tags ?? []), eventId, input.artifactId ?? null);

    audit(db, pid, 'create', 'memory', memoryId, null, {
      type: input.type ?? 'note',
      status: input.status ?? 'active',
      title: input.title,
      claim: input.claim,
      files: input.files ?? [],
      symbols: input.symbols ?? [],
      tags: input.tags ?? [],
      confidence: input.confidence ?? 0.8,
      eventId,
      artifactId: input.artifactId ?? null,
      headSha: repo.headSha
    });

    if (input.artifactId) {
      assertArtifactInProject(db, pid, input.artifactId);
      const relation = input.evidenceRelation ?? 'supports';
      db.prepare(`INSERT OR IGNORE INTO memory_evidence(memory_id, artifact_id, relation, quote) VALUES (?, ?, ?, ?)`)
        .run(memoryId, input.artifactId, relation, input.evidenceQuote ?? null);
      audit(db, pid, 'link_evidence', 'memory', memoryId, null, {
        memoryTitle: input.title,
        artifactId: input.artifactId,
        relation,
        quote: input.evidenceQuote ?? null
      });
    }
  });
  withSqliteBusyRetry(() => tx());
  return { id: memoryId, eventId, project: repo.projectKey, headSha: repo.headSha, duplicate: false };
}

export function searchMemories(input: { cwd?: string; query: string; limit?: number; statuses?: string[] }, store?: Store) {
  const { db, repo } = store ?? openStore(input.cwd);
  const pid = projectId(db, repo.projectKey);
  const limit = Math.min(Math.max(input.limit ?? 10, 1), 50);
  const statuses = input.statuses?.length ? input.statuses : null;

  let rows: any[] = [];
  try {
    rows = searchMemoriesFts(db, pid, input.query, limit);
  } catch {
    rows = [];
  }

  if (!rows.length) {
    const relaxedQuery = relaxedFtsQuery(input.query);
    if (relaxedQuery && relaxedQuery !== input.query) {
      try {
        rows = searchMemoriesFts(db, pid, relaxedQuery, limit);
      } catch {
        rows = [];
      }
    }
  }

  if (!rows.length) rows = searchMemoriesLike(db, pid, input.query, limit);

  if (statuses) rows = rows.filter((r) => statuses.includes(r.status));
  return rows.map(formatMemory);
}

function searchMemoriesFts(db: any, projectId: number, query: string, limit: number): any[] {
  return db.prepare(`
    SELECT m.*, bm25(memories_fts) AS rank
    FROM memories_fts f
    JOIN memories m ON m.rowid = f.rowid
    WHERE memories_fts MATCH ? AND m.project_id = ?
    ORDER BY rank ASC
    LIMIT ?
  `).all(query, projectId, limit) as any[];
}

function relaxedFtsQuery(query: string): string | null {
  const tokens = normalizedSearchTokens(query);
  return tokens.length ? tokens.join(' OR ') : null;
}

function normalizedSearchTokens(query: string): string[] {
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const raw of query.toLowerCase().match(/[a-z0-9_]+/g) ?? []) {
    for (const token of raw.length > 3 && raw.endsWith('s') ? [raw, raw.slice(0, -1)] : [raw]) {
      if (!seen.has(token)) {
        seen.add(token);
        tokens.push(token);
      }
    }
  }
  return tokens;
}

function searchMemoriesLike(db: any, projectId: number, query: string, limit: number): any[] {
  const tokens = normalizedSearchTokens(query);
  if (!tokens.length) return [];
  const fields = ['m.title', 'm.claim', "COALESCE(m.rationale, '')", 'm.tags_json'];
  const clauses = tokens.map(() => `(${fields.map((field) => `${field} LIKE ?`).join(' OR ')})`);
  const values = tokens.flatMap((token) => fields.map(() => `%${token}%`));
  return db.prepare(`
    SELECT m.*, 0 AS rank
    FROM memories m
    WHERE m.project_id = ? AND (${clauses.join(' OR ')})
    ORDER BY m.updated_at DESC
    LIMIT ?
  `).all(projectId, ...values, limit) as any[];
}

export function getMemory(input: { cwd?: string; id: string }, store?: Store) {
  return getMemoryWithEvidence(input);
}

export function getMemoryWithEvidence(input: { cwd?: string; id: string }, store?: Store) {
  const { db, repo } = store ?? openStore(input.cwd);
  const pid = projectId(db, repo.projectKey);
  const row = db.prepare('SELECT * FROM memories WHERE id = ? AND project_id = ?').get(input.id, pid) as any | undefined;
  if (!row) return null;
  return { ...formatMemory(row), evidence: evidenceForMemory(db, input.id) };
}

export function linkMemoryEvidence(input: { cwd?: string; memoryId: string; artifactId: string; relation?: string; quote?: string }, store?: Store) {
  const { db, repo } = store ?? openStore(input.cwd);
  const pid = projectId(db, repo.projectKey);
  const memory = db.prepare('SELECT id FROM memories WHERE id = ? AND project_id = ?').get(input.memoryId, pid) as any | undefined;
  if (!memory) throw new Error(`Memory not found: ${input.memoryId}`);
  assertArtifactInProject(db, pid, input.artifactId);
  db.prepare(`INSERT OR REPLACE INTO memory_evidence(memory_id, artifact_id, relation, quote) VALUES (?, ?, ?, ?)`)
    .run(input.memoryId, input.artifactId, input.relation ?? 'supports', input.quote ?? null);
  audit(db, pid, 'link_evidence', 'memory', input.memoryId, null, { artifactId: input.artifactId, relation: input.relation ?? 'supports', quote: input.quote ?? null });
  return getMemoryWithEvidence({ cwd: repo.projectRoot, id: input.memoryId });
}

export function listMemories(input: { cwd?: string; limit?: number; offset?: number; statuses?: string[]; types?: string[]; tags?: string[] }, store?: Store) {
  const { db, repo } = store ?? openStore(input.cwd);
  const pid = projectId(db, repo.projectKey);
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 500);
  const offset = Math.max(input.offset ?? 0, 0);
  const clauses = ['project_id = ?'];
  const values: any[] = [pid];
  if (input.statuses?.length) {
    clauses.push(`status IN (${input.statuses.map(() => '?').join(',')})`);
    values.push(...input.statuses);
  }
  if (input.types?.length) {
    clauses.push(`type IN (${input.types.map(() => '?').join(',')})`);
    values.push(...input.types);
  }
  if (input.tags?.length) {
    clauses.push(`(${input.tags.map(() => 'tags_json LIKE ?').join(' OR ')})`);
    values.push(...input.tags.map((tag) => `%${tag}%`));
  }
  const rows = db.prepare(`SELECT * FROM memories WHERE ${clauses.join(' AND ')} ORDER BY updated_at DESC LIMIT ? OFFSET ?`)
    .all(...values, limit, offset) as any[];
  return rows.map(formatMemory);
}

export function deleteMemory(input: { cwd?: string; id: string; reason?: string }, store?: Store) {
  const { db, repo } = store ?? openStore(input.cwd);
  const pid = projectId(db, repo.projectKey);
  const row = db.prepare('SELECT * FROM memories WHERE id = ? AND project_id = ?').get(input.id, pid) as any | undefined;
  if (!row) throw new Error(`Memory not found: ${input.id}`);
  const tx = db.transaction(() => {
    audit(db, pid, 'delete', 'memory', input.id, input.reason ?? 'No reason provided', { title: row.title, type: row.type, status: row.status });
    db.prepare('DELETE FROM memories WHERE id = ? AND project_id = ?').run(input.id, pid);
  });
  withSqliteBusyRetry(() => tx());
  return { deleted: true, id: input.id, reason: input.reason ?? null };
}

export function manageMemory(input: MemoryActionInput, store?: Store) {
  switch (input.action) {
    case 'verify': return verifyMemory(input);
    case 'mark': return updateMemoryStatus(input);
    case 'delete': return deleteMemory(input);
    case 'link': return linkMemories(input);
    case 'supersede': return supersedeMemory(input);
  }
}

export function updateMemoryStatus(input: { cwd?: string; id: string; status: string; confidence?: number }, store?: Store) {
  assertStatus(input.status);
  const { db, repo } = store ?? openStore(input.cwd);
  const pid = projectId(db, repo.projectKey);
  const before = db.prepare('SELECT status, confidence FROM memories WHERE id = ? AND project_id = ?').get(input.id, pid) as any | undefined;
  const result = db.prepare(`UPDATE memories SET status = ?, confidence = COALESCE(?, confidence), updated_at = CURRENT_TIMESTAMP WHERE id = ? AND project_id = ?`)
    .run(input.status, input.confidence ?? null, input.id, pid);
  if (!result.changes) throw new Error(`Memory not found: ${input.id}`);
  audit(db, pid, 'update_status', 'memory', input.id, null, { before, after: { status: input.status, confidence: input.confidence ?? before?.confidence } });
  return getMemory({ cwd: repo.projectRoot, id: input.id });
}

export function verifyMemory(input: { cwd?: string; id: string; confidence?: number }, store?: Store) {
  const { db, repo } = store ?? openStore(input.cwd);
  const pid = projectId(db, repo.projectKey);
  const result = db.prepare(`UPDATE memories SET status = 'active', last_verified_commit = ?, confidence = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND project_id = ?`)
    .run(repo.headSha, input.confidence ?? 0.95, input.id, pid);
  if (!result.changes) throw new Error(`Memory not found: ${input.id}`);
  audit(db, pid, 'verify', 'memory', input.id, null, { headSha: repo.headSha, confidence: input.confidence ?? 0.95 });
  return getMemory({ cwd: repo.projectRoot, id: input.id });
}

export function linkMemories(input: { cwd?: string; fromId: string; toId: string; relation: string }, store?: Store) {
  const { db, repo } = store ?? openStore(input.cwd);
  const pid = projectId(db, repo.projectKey);
  const exists = db.prepare(`SELECT COUNT(*) AS count FROM memories WHERE project_id = ? AND id IN (?, ?)`).get(pid, input.fromId, input.toId) as { count: number };
  if (exists.count !== 2) throw new Error('Both memories must exist in the current project');
  db.prepare(`INSERT OR IGNORE INTO memory_links(from_memory_id, to_memory_id, relation) VALUES (?, ?, ?)`)
    .run(input.fromId, input.toId, input.relation);
  audit(db, pid, 'link', 'memory', input.fromId, null, { toId: input.toId, relation: input.relation });
  return { fromId: input.fromId, toId: input.toId, relation: input.relation };
}

export function supersedeMemory(input: { cwd?: string; oldId: string; newId: string }, store?: Store) {
  const link = linkMemories({ cwd: input.cwd, fromId: input.oldId, toId: input.newId, relation: 'superseded-by' }, store);
  updateMemoryStatus({ cwd: input.cwd, id: input.oldId, status: 'superseded', confidence: 0.4 }, store);
  return { ...link, oldMemory: getMemory({ cwd: input.cwd, id: input.oldId }, store), newMemory: getMemory({ cwd: input.cwd, id: input.newId }, store) };
}

export function memoryStatus(input: { cwd?: string }, store?: Store) {
  const { db, repo } = store ?? openStore(input.cwd);
  const pid = projectId(db, repo.projectKey);
  const rows = db.prepare(`SELECT status, COUNT(*) AS count FROM memories WHERE project_id = ? GROUP BY status`).all(pid) as any[];
  const counts = Object.fromEntries(rows.map((r) => [r.status, r.count]));
  const stale = db.prepare(`SELECT id, title, status, last_verified_commit, files_json FROM memories WHERE project_id = ? AND status IN ('needs-revalidation','stale') ORDER BY updated_at DESC LIMIT 20`).all(pid) as any[];
  return { project: repo, counts, needsAttention: stale.map(formatMemory) };
}

export function revalidateMemories(input: { cwd?: string; fromSha?: string; toSha?: string }, store?: Store) {
  const { db, repo } = store ?? openStore(input.cwd);
  const pid = projectId(db, repo.projectKey);
  const requestedTo = input.toSha ?? repo.headSha;
  const requestedFrom = input.fromSha;
  if (!requestedFrom || !requestedTo) throw new Error('fromSha and toSha are required, or run inside a git repo with HEAD.');
  const fromSha = resolveGitRef(repo.projectRoot, requestedFrom) ?? requestedFrom;
  const toSha = resolveGitRef(repo.projectRoot, requestedTo) ?? requestedTo;
  const files = changedFiles(repo.projectRoot, fromSha, toSha)
    .filter((file) => !file.startsWith('.repo-memory/'));
  const memories = db.prepare(`SELECT * FROM memories WHERE project_id = ? AND status != 'superseded'`).all(pid) as any[];
  let affected = 0;
  const flaggedForReview: any[] = [];
  const tx = db.transaction(() => {
    for (const mem of memories) {
      const memFiles = parseArray(mem.files_json);
      if (mem.last_verified_commit === toSha) continue;
      const overlaps = memFiles.some((f) => files.includes(f));
      let status = overlaps ? 'needs-revalidation' : 'probably-active';

      if (overlaps) {
        affected++;
        const symbolStatus = checkAnchors(repo.projectRoot, memFiles, parseArray(mem.symbols_json));
        if (symbolStatus === 'missing') status = 'stale';
        flaggedForReview.push({ ...formatMemory(mem), status, matchedFiles: memFiles.filter((f) => files.includes(f)) });
      }

      const previousStatus = mem.status;
      db.prepare(`UPDATE memories SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(status, mem.id);
      if (previousStatus !== status) {
        audit(db, pid, 'revalidate_status', 'memory', mem.id, null, {
          title: mem.title,
          previousStatus,
          status,
          fromSha,
          toSha,
          changedFiles: files,
          matchedFiles: memFiles.filter((f) => files.includes(f))
        });
      }
    }
    const runId = newId('reval');
    db.prepare(`INSERT INTO revalidation_runs(id, project_id, from_sha, to_sha, changed_files_json, affected_count) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(runId, pid, fromSha, toSha, j(files), affected);
    audit(db, pid, 'revalidate', 'project', repo.projectKey, null, { runId, fromSha, toSha, changedFiles: files, affectedCount: affected, scanType: 'git-diff-staleness' });
  });
  withSqliteBusyRetry(() => tx());
  const nextActions = [
    'Review flagged memories before relying on them; this scan finds changed files, not truth.',
    'If still true: repo-memory verify --id <mem_id>',
    'If false: repo-memory mark --id <mem_id> --status stale',
    'If changed: create a replacement memory, then repo-memory supersede --old <old_id> --new <new_id>'
  ];
  const notes = files.length === 0 && fromSha === toSha
    ? ['No changed files found because --from and --to resolve to the same commit. Try: repo-memory revalidate --from HEAD~1 --to HEAD']
    : undefined;
  return { fromSha, toSha, changedFiles: files, affectedCount: affected, scanType: 'git-diff-staleness', flaggedForReview, nextActions, ...(notes ? { notes } : {}) };
}

export function reviewMemories(input: { cwd?: string; limit?: number }, store?: Store) {
  const { db, repo } = store ?? openStore(input.cwd);
  const pid = projectId(db, repo.projectKey);
  const rows = db.prepare(`
    SELECT * FROM memories
    WHERE project_id = ? AND status IN ('needs-revalidation','stale')
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(pid, input.limit ?? 50) as any[];
  const actions = {
    verifyIfStillTrue: 'repo-memory verify --id <mem_id>',
    markStaleIfFalse: 'repo-memory mark --id <mem_id> --status stale',
    replaceIfChanged: 'repo-memory remember --title "..." --claim "..." --files path && repo-memory supersede --old <old_id> --new <new_id>'
  };
  return { project: repo, count: rows.length, memories: rows.map(formatMemory), suggestedCommands: actions };
}

function assertArtifactInProject(db: any, projectId: number, artifactId: string) {
  const artifact = db.prepare('SELECT id FROM artifacts WHERE id = ? AND project_id = ?').get(artifactId, projectId) as any | undefined;
  if (!artifact) throw new Error(`Artifact not found in current project: ${artifactId}`);
}

function evidenceForMemory(db: any, memoryId: string) {
  const rows = db.prepare(`
    SELECT me.relation, me.quote, me.created_at, a.id, a.type, a.title, a.preview, a.commit_sha, a.metadata_json, a.created_at AS artifact_created_at
    FROM memory_evidence me
    JOIN artifacts a ON a.id = me.artifact_id
    WHERE me.memory_id = ?
    ORDER BY me.created_at ASC
  `).all(memoryId) as any[];

  return rows.map((row) => ({
    artifactId: row.id,
    relation: row.relation,
    quote: row.quote,
    type: row.type,
    title: row.title,
    preview: row.preview,
    commitSha: row.commit_sha,
    metadata: safeJson(row.metadata_json),
    linkedAt: row.created_at,
    artifactCreatedAt: row.artifact_created_at
  }));
}

function assertStatus(status: string) {
  const allowed = new Set(['active', 'proposed', 'probably-active', 'needs-revalidation', 'stale', 'superseded', 'historical', 'rejected']);
  if (!allowed.has(status)) throw new Error(`Invalid status: ${status}`);
}

function checkAnchors(projectRoot: string, files: string[], symbols: string[]): 'ok' | 'missing' {
  for (const file of files) {
    const path = join(projectRoot, file);
    if (!existsSync(path)) return 'missing';
    if (symbols.length) {
      const text = readFileSync(path, 'utf8');
      const foundAny = symbols.some((symbol) => text.includes(symbol));
      if (!foundAny) return 'missing';
    }
  }
  return 'ok';
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    rank: row.rank
  };
}
