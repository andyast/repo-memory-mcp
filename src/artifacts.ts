import { audit, newId, openStore, projectId, withSqliteBusyRetry, type Store } from './db.js';

function j(value: unknown): string { return JSON.stringify(value ?? null); }

export function makePreview(body: string, maxChars = 1200): string {
  if (body.length <= maxChars) return body;
  const half = Math.floor((maxChars - 80) / 2);
  return `${body.slice(0, half)}\n\n... [middle truncated: ${body.length - (half * 2)} chars] ...\n\n${body.slice(-half)}`;
}

export function storeArtifact(input: { cwd?: string; type?: string; title: string; body: string; eventId?: string; metadata?: Record<string, unknown> }, store?: Store) {
  const { db, repo } = store ?? openStore(input.cwd);
  const pid = projectId(db, repo.projectKey);
  const id = newId('artifact');
  const preview = makePreview(input.body);
  const type = input.type ?? 'text';
  const bytes = Buffer.byteLength(input.body);
  withSqliteBusyRetry(() => db.prepare(`INSERT INTO artifacts(id, project_id, event_id, type, title, preview, body, commit_sha, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, pid, input.eventId ?? null, type, input.title, preview, input.body, repo.headSha, j(input.metadata ?? {})));
  audit(db, pid, 'create', 'artifact', id, null, {
    title: input.title,
    type,
    bytes,
    eventId: input.eventId ?? null,
    headSha: repo.headSha,
    preview
  });
  return { id, project: repo.projectKey, title: input.title, type, preview, bytes, headSha: repo.headSha };
}

export function getArtifact(input: { cwd?: string; id: string; offset?: number; limit?: number }, store?: Store) {
  const { db, repo } = store ?? openStore(input.cwd);
  const pid = projectId(db, repo.projectKey);
  const row = db.prepare('SELECT * FROM artifacts WHERE id = ? AND project_id = ?').get(input.id, pid) as any | undefined;
  if (!row) return null;
  return formatArtifactPage(row, input.offset, input.limit);
}

export function searchEvidence(input: { cwd?: string; query: string; limit?: number }, store?: Store) {
  const { db, repo } = store ?? openStore(input.cwd);
  const pid = projectId(db, repo.projectKey);
  const limit = Math.min(Math.max(input.limit ?? 10, 1), 50);
  let rows: any[];

  try {
    rows = db.prepare(`
      SELECT a.*, bm25(artifacts_fts) AS rank
      FROM artifacts_fts f
      JOIN artifacts a ON a.rowid = f.rowid
      WHERE artifacts_fts MATCH ? AND a.project_id = ?
      ORDER BY rank ASC
      LIMIT ?
    `).all(input.query, pid, limit) as any[];
  } catch {
    rows = db.prepare(`
      SELECT a.*, 0 AS rank
      FROM artifacts a
      WHERE a.project_id = ? AND (a.title LIKE ? OR a.preview LIKE ? OR a.body LIKE ?)
      ORDER BY a.created_at DESC
      LIMIT ?
    `).all(pid, `%${input.query}%`, `%${input.query}%`, `%${input.query}%`, limit) as any[];
  }

  return rows.map(formatArtifactSearchHit);
}

function formatArtifactPage(row: any, requestedOffset?: number, requestedLimit?: number) {
  const offset = Math.max(requestedOffset ?? 0, 0);
  const limit = Math.min(Math.max(requestedLimit ?? 4000, 1), 20000);
  const body = String(row.body);
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    preview: row.preview,
    body: body.slice(offset, offset + limit),
    offset,
    limit,
    totalChars: body.length,
    hasMore: offset + limit < body.length,
    commitSha: row.commit_sha,
    metadata: safeJson(row.metadata_json),
    createdAt: row.created_at
  };
}

function formatArtifactSearchHit(row: any) {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    preview: row.preview,
    commitSha: row.commit_sha,
    metadata: safeJson(row.metadata_json),
    createdAt: row.created_at,
    rank: row.rank
  };
}

function safeJson(value: string) {
  try { return JSON.parse(value); } catch { return {}; }
}
