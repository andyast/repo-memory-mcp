import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { openStore, type Store } from './db.js';
import { getRepoIdentity } from './repo.js';

const stores = new Map<string, Store>();

export function openCachedStore(cwd?: string): Store {
  const repo = getRepoIdentity(cwd);
  const key = repo.projectRoot;
  const cached = stores.get(key);
  if (cached) return cached;
  const store = openStore(repo.projectRoot, repo);
  stores.set(key, store);
  return store;
}

export function clearStoreCache() {
  for (const store of stores.values()) store.db.close();
  stores.clear();
}

export function cachedStoreCount(): number {
  return stores.size;
}

export function canonicalStoreCacheKey(cwd?: string): string {
  return realpathSync(resolve(cwd ?? process.cwd()));
}
