import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getRepoIdentity, type RepoIdentity } from './repo.js';

export type Store = {
  db: Database.Database;
  repo: RepoIdentity;
};

const DEFAULT_BUSY_TIMEOUT_MS = 5000;

export function openStore(cwd?: string, knownRepo?: RepoIdentity): Store {
  const repo = knownRepo ?? getRepoIdentity(cwd);
  const dir = process.env.REPO_MEMORY_STORE_PATH ?? join(repo.projectRoot, '.repo-memory');
  mkdirSync(dir, { recursive: true });
  const db = new Database(join(dir, 'store.db'), { timeout: busyTimeoutMs() });
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma(`busy_timeout = ${busyTimeoutMs()}`);
  migrate(db);
  withSqliteBusyRetry(() => upsertProject(db, repo));
  return { db, repo };
}

export function withSqliteBusyRetry<T>(fn: () => T, attempts = 4): T {
  let delayMs = 25;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return fn();
    } catch (error) {
      lastError = error;
      if (!isSqliteBusy(error) || attempt === attempts - 1) throw error;
      sleep(delayMs);
      delayMs *= 2;
    }
  }
  throw lastError;
}

export function busyTimeoutMs(): number {
  const raw = Number(process.env.REPO_MEMORY_SQLITE_BUSY_TIMEOUT_MS);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : DEFAULT_BUSY_TIMEOUT_MS;
}

function isSqliteBusy(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'SQLITE_BUSY';
}

function sleep(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function migrate(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_key TEXT NOT NULL UNIQUE,
      project_root TEXT NOT NULL,
      repo_remote TEXT,
      current_branch TEXT,
      current_head_sha TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      source TEXT,
      commit_sha TEXT,
      branch TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      event_id TEXT REFERENCES events(id) ON DELETE SET NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      preview TEXT NOT NULL,
      body TEXT NOT NULL,
      commit_sha TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      claim TEXT NOT NULL,
      rationale TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      confidence REAL NOT NULL DEFAULT 0.8,
      observed_commit TEXT,
      last_verified_commit TEXT,
      files_json TEXT NOT NULL DEFAULT '[]',
      symbols_json TEXT NOT NULL DEFAULT '[]',
      tags_json TEXT NOT NULL DEFAULT '[]',
      source_event_id TEXT REFERENCES events(id) ON DELETE SET NULL,
      source_artifact_id TEXT REFERENCES artifacts(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS memory_evidence (
      memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
      relation TEXT NOT NULL DEFAULT 'supports',
      quote TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(memory_id, artifact_id, relation)
    );

    CREATE TABLE IF NOT EXISTS memory_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      to_memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      relation TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(from_memory_id, to_memory_id, relation)
    );

    CREATE TABLE IF NOT EXISTS revalidation_runs (
      id TEXT PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      from_sha TEXT,
      to_sha TEXT,
      changed_files_json TEXT NOT NULL DEFAULT '[]',
      affected_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      operation TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      reason TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS artifacts_fts USING fts5(
      title, preview, body,
      content='artifacts', content_rowid='rowid'
    );

    CREATE TRIGGER IF NOT EXISTS artifacts_ai AFTER INSERT ON artifacts BEGIN
      INSERT INTO artifacts_fts(rowid, title, preview, body)
      VALUES (new.rowid, new.title, new.preview, new.body);
    END;

    CREATE TRIGGER IF NOT EXISTS artifacts_ad AFTER DELETE ON artifacts BEGIN
      INSERT INTO artifacts_fts(artifacts_fts, rowid, title, preview, body)
      VALUES('delete', old.rowid, old.title, old.preview, old.body);
    END;

    CREATE TRIGGER IF NOT EXISTS artifacts_au AFTER UPDATE ON artifacts BEGIN
      INSERT INTO artifacts_fts(artifacts_fts, rowid, title, preview, body)
      VALUES('delete', old.rowid, old.title, old.preview, old.body);
      INSERT INTO artifacts_fts(rowid, title, preview, body)
      VALUES (new.rowid, new.title, new.preview, new.body);
    END;

    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      title, claim, rationale, tags,
      content='memories', content_rowid='rowid'
    );

    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, title, claim, rationale, tags)
      VALUES (new.rowid, new.title, new.claim, COALESCE(new.rationale, ''), new.tags_json);
    END;

    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, title, claim, rationale, tags)
      VALUES('delete', old.rowid, old.title, old.claim, COALESCE(old.rationale, ''), old.tags_json);
    END;

    CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, title, claim, rationale, tags)
      VALUES('delete', old.rowid, old.title, old.claim, COALESCE(old.rationale, ''), old.tags_json);
      INSERT INTO memories_fts(rowid, title, claim, rationale, tags)
      VALUES (new.rowid, new.title, new.claim, COALESCE(new.rationale, ''), new.tags_json);
    END;
  `);
}

function upsertProject(db: Database.Database, repo: RepoIdentity) {
  db.prepare(`
    INSERT INTO projects(project_key, project_root, repo_remote, current_branch, current_head_sha)
    VALUES (@projectKey, @projectRoot, @repoRemote, @branch, @headSha)
    ON CONFLICT(project_key) DO UPDATE SET
      project_root=excluded.project_root,
      repo_remote=excluded.repo_remote,
      current_branch=excluded.current_branch,
      current_head_sha=excluded.current_head_sha,
      updated_at=CURRENT_TIMESTAMP
  `).run(repo);
}

export function projectId(db: Database.Database, projectKey: string): number {
  const row = db.prepare('SELECT id FROM projects WHERE project_key = ?').get(projectKey) as { id: number } | undefined;
  if (!row) throw new Error(`Project not found: ${projectKey}`);
  return row.id;
}

export function audit(db: Database.Database, projectId: number, operation: string, targetType: string, targetId: string, reason: string | null, metadata: unknown) {
  db.prepare(`INSERT INTO audit_log(id, project_id, operation, target_type, target_id, reason, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    newId('audit'), projectId, operation, targetType, targetId, reason, JSON.stringify(metadata ?? {})
  );
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
}
