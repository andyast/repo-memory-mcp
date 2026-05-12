#!/usr/bin/env node
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { openStore, projectId } from './db.js';
import { searchMemories, storeMemory } from './memory.js';

const count = Number(process.env.REPO_MEMORY_STRESS_COUNT ?? 40);
const root = mkdtempSync(join(tmpdir(), 'repo-memory-stress-'));
const storeDir = join(root, '.repo-memory');

try {
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'stress@example.invalid'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Repo Memory Stress'], { cwd: root });
  writeFileSync(join(root, 'README.md'), '# stress repo\n');
  execFileSync('git', ['add', 'README.md'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: root, stdio: 'ignore' });
  mkdirSync(storeDir, { recursive: true });

  process.env.REPO_MEMORY_STORE_PATH = storeDir;
  const tasks = Array.from({ length: count }, (_, i) => Promise.resolve().then(() => {
    const store = openStore(root);
    try {
      return storeMemory({
        cwd: root,
        title: `stress memory ${i}`,
        claim: `parallel durable stress-token-${i} write should persist`,
        tags: ['stress', `batch-${i % 5}`]
      }, store);
    } finally {
      store.db.close();
    }
  }));

  const results = await Promise.all(tasks);
  const ids = new Set(results.map((r) => r.id));
  if (ids.size !== count) throw new Error(`Expected ${count} unique memories, got ${ids.size}`);

  const store = openStore(root);
  try {
    const pid = projectId(store.db, store.repo.projectKey);
    const rows = store.db.prepare(`SELECT COUNT(*) AS count FROM memories WHERE project_id = ? AND tags_json LIKE '%stress%'`).get(pid) as { count: number };
    const auditRows = store.db.prepare(`SELECT COUNT(*) AS count FROM audit_log WHERE project_id = ? AND operation = 'create'`).get(pid) as { count: number };
    const found = searchMemories({ cwd: root, query: 'stress-token-7', limit: 5 }, store);
    if (rows.count !== count) throw new Error(`Expected ${count} stress memories, got ${rows.count}`);
    if (auditRows.count !== count) throw new Error(`Expected ${count} audit entries, got ${auditRows.count}`);
    if (!found.some((m) => m.claim.includes('stress-token-7'))) throw new Error('Search failed to find stress-token-7');
    console.log(JSON.stringify({ ok: true, count, uniqueIds: ids.size, auditEntries: auditRows.count, searchHit: found[0]?.id }, null, 2));
  } finally {
    store.db.close();
  }
} finally {
  if (!process.env.REPO_MEMORY_KEEP_STRESS_REPO) rmSync(root, { recursive: true, force: true });
}
