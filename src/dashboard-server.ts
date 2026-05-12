import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore, projectId } from './db.js';
import { deleteMemory, getMemoryWithEvidence, updateMemoryStatus, verifyMemory } from './memory.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function serveStatic(path: string, contentType: string) {
  try {
    return readFileSync(join(__dirname, '..', 'dashboard', path), 'utf8');
  } catch {
    return null;
  }
}

function getMimeType(path: string): string {
  if (path.endsWith('.html')) return 'text/html';
  if (path.endsWith('.css')) return 'text/css';
  if (path.endsWith('.js')) return 'application/javascript';
  if (path.endsWith('.json')) return 'application/json';
  if (path.endsWith('.svg')) return 'image/svg+xml';
  return 'text/plain';
}

function readJsonBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body.trim()) return resolve({});
      try { resolve(JSON.parse(body)); } catch { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function writeJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function startDashboardServer(options: { port?: number; cwd?: string; storePath?: string }) {
  const port = options.port ?? 3456;
  const { db, repo } = openStore(options.cwd);
  const pid = projectId(db, repo.projectKey);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${port}`);
    const pathname = url.pathname;

    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    // API routes
    if (pathname === '/api/stats') {
      const statusCounts = db.prepare(`SELECT status, COUNT(*) as count FROM memories WHERE project_id = ? GROUP BY status`).all(pid);
      const typeCounts = db.prepare(`SELECT type, COUNT(*) as count FROM memories WHERE project_id = ? GROUP BY type ORDER BY count DESC, type ASC`).all(pid);
      const total = db.prepare(`SELECT COUNT(*) as count FROM memories WHERE project_id = ?`).get(pid) as { count: number };
      const artifactTotal = db.prepare(`SELECT COUNT(*) as count FROM artifacts WHERE project_id = ?`).get(pid) as { count: number };
      const memoryRows = db.prepare(`SELECT id, title, status, type, tags_json, updated_at FROM memories WHERE project_id = ? ORDER BY updated_at DESC`).all(pid) as any[];
      const tagMap = new Map<string, number>();
      for (const row of memoryRows) {
        for (const tag of JSON.parse(row.tags_json || '[]')) tagMap.set(tag, (tagMap.get(tag) || 0) + 1);
      }
      const topTags = Array.from(tagMap.entries())
        .map(([tag, count]) => ({ tag, count }))
        .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
        .slice(0, 12);
      const attentionOrder = new Map([['proposed', 0], ['needs-revalidation', 1], ['stale', 2], ['probably-active', 3]]);
      const reviewRows = memoryRows
        .filter((r) => attentionOrder.has(r.status))
        .sort((a, b) => (attentionOrder.get(a.status) ?? 99) - (attentionOrder.get(b.status) ?? 99) || String(b.updated_at).localeCompare(String(a.updated_at)));
      const recentAuditRows = db.prepare(`SELECT operation, target_type, created_at FROM audit_log WHERE project_id = ? ORDER BY created_at DESC LIMIT 20`).all(pid) as any[];
      const auditMap = new Map<string, number>();
      for (const row of recentAuditRows) auditMap.set(row.operation, (auditMap.get(row.operation) || 0) + 1);
      const lastRevalidation = db.prepare(`SELECT * FROM revalidation_runs WHERE project_id = ? ORDER BY created_at DESC LIMIT 1`).get(pid) as any | undefined;

      writeJson(res, 200, {
        project: repo,
        total: total.count,
        byStatus: Object.fromEntries(statusCounts.map((r: any) => [r.status, r.count])),
        byType: typeCounts.map((r: any) => ({ type: r.type, count: r.count })),
        topTags,
        artifactCount: artifactTotal.count,
        recentAudit: {
          totalRecent: recentAuditRows.length,
          byOperation: Array.from(auditMap.entries()).map(([operation, count]) => ({ operation, count })),
          latest: recentAuditRows.slice(0, 5).map((r) => ({ operation: r.operation, targetType: r.target_type, createdAt: r.created_at }))
        },
        lastRevalidation: lastRevalidation ? {
          id: lastRevalidation.id,
          fromSha: lastRevalidation.from_sha,
          toSha: lastRevalidation.to_sha,
          changedFiles: JSON.parse(lastRevalidation.changed_files_json || '[]'),
          affectedCount: lastRevalidation.affected_count,
          createdAt: lastRevalidation.created_at
        } : null,
        needsReview: {
          count: reviewRows.length,
          items: reviewRows.slice(0, 8).map((r) => ({ id: r.id, title: r.title, status: r.status, type: r.type, updatedAt: r.updated_at }))
        }
      });
      return;
    }

    if (pathname === '/api/memories') {
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 200);
      const offset = parseInt(url.searchParams.get('offset') || '0');
      const status = url.searchParams.get('status');
      const type = url.searchParams.get('type');
      const query = url.searchParams.get('q');

      let sql = `SELECT * FROM memories WHERE project_id = ?`;
      const params: any[] = [pid];

      if (status) {
        sql += ` AND status = ?`;
        params.push(status);
      }
      if (type) {
        sql += ` AND type = ?`;
        params.push(type);
      }

      sql += ` ORDER BY updated_at DESC LIMIT ? OFFSET ?`;
      params.push(limit, offset);

      const rows = db.prepare(sql).all(...params);

      // If search query provided, filter by FTS
      let memories = rows.map((r: any) => ({
        id: r.id,
        type: r.type,
        title: r.title,
        claim: r.claim,
        status: r.status,
        confidence: r.confidence,
        files: JSON.parse(r.files_json || '[]'),
        symbols: JSON.parse(r.symbols_json || '[]'),
        tags: JSON.parse(r.tags_json || '[]'),
        observedCommit: r.observed_commit,
        lastVerifiedCommit: r.last_verified_commit,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        sourceArtifactId: r.source_artifact_id,
        evidenceCount: (db.prepare(`SELECT COUNT(*) as count FROM memory_evidence WHERE memory_id = ?`).get(r.id) as { count: number }).count
      }));

      if (query) {
        const q = query.toLowerCase();
        memories = memories.filter((m: any) =>
          m.title.toLowerCase().includes(q) ||
          m.claim.toLowerCase().includes(q) ||
          m.tags.some((t: string) => t.toLowerCase().includes(q))
        );
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ memories, limit, offset }));
      return;
    }

    if (pathname === '/api/audit') {
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 200);
      const rows = db.prepare(`SELECT * FROM audit_log WHERE project_id = ? ORDER BY created_at DESC LIMIT ?`).all(pid, limit);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ audit: rows.map((r: any) => ({
        id: r.id,
        operation: r.operation,
        targetType: r.target_type,
        targetId: r.target_id,
        reason: r.reason,
        metadata: JSON.parse(r.metadata_json || '{}'),
        createdAt: r.created_at
      })) }));
      return;
    }

    if (pathname.startsWith('/api/memory/')) {
      const parts = pathname.split('/').filter(Boolean);
      const id = decodeURIComponent(parts[2] || '');
      const action = parts[3];

      if (req.method === 'POST' && action === 'verify') {
        try {
          const body = await readJsonBody(req);
          const memory = verifyMemory({ cwd: repo.projectRoot, id, confidence: body.confidence === undefined ? undefined : Number(body.confidence) });
          writeJson(res, 200, { memory });
        } catch (error: any) {
          writeJson(res, 400, { error: error.message || 'Unable to verify memory' });
        }
        return;
      }

      if (req.method === 'POST' && action === 'status') {
        try {
          const body = await readJsonBody(req);
          if (!['active', 'stale', 'historical', 'rejected'].includes(body.status)) throw new Error('Status must be active, stale, historical, or rejected');
          const memory = updateMemoryStatus({ cwd: repo.projectRoot, id, status: body.status, confidence: body.confidence === undefined ? undefined : Number(body.confidence) });
          writeJson(res, 200, { memory });
        } catch (error: any) {
          writeJson(res, 400, { error: error.message || 'Unable to update memory status' });
        }
        return;
      }

      if (req.method === 'POST' && action === 'delete') {
        try {
          const body = await readJsonBody(req);
          const result = deleteMemory({ cwd: repo.projectRoot, id, reason: body.reason || 'Deleted from dashboard' });
          writeJson(res, 200, result);
        } catch (error: any) {
          writeJson(res, 400, { error: error.message || 'Unable to delete memory' });
        }
        return;
      }

      if (req.method !== 'GET' || action) {
        writeJson(res, 405, { error: 'Method not allowed' });
        return;
      }

      const memory = getMemoryWithEvidence({ cwd: repo.projectRoot, id });
      if (!memory) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Not found' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(memory));
      return;
    }

    // Static files
    let filePath = pathname === '/' ? 'index.html' : pathname.slice(1);
    const content = serveStatic(filePath, getMimeType(filePath));

    if (content) {
      res.writeHead(200, { 'Content-Type': getMimeType(filePath) });
      res.end(content);
    } else {
      // Try index.html for SPA routing
      const index = serveStatic('index.html', 'text/html');
      if (index) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(index);
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    }
  });

  server.listen(port, () => {
    console.log(`Dashboard running at http://localhost:${port}`);
    console.log(`Project: ${repo.projectRoot}`);
  });

  return server;
}
