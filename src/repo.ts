import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

export type RepoIdentity = {
  cwd: string;
  projectRoot: string;
  repoRemote: string | null;
  branch: string | null;
  headSha: string | null;
  projectKey: string;
};

export function getRepoIdentity(inputCwd?: string): RepoIdentity {
  const cwd = realpathSync(resolve(inputCwd ?? process.cwd()));
  const gitRoot = git(cwd, ['rev-parse', '--show-toplevel']);
  const projectRoot = realpathSync(gitRoot ? resolve(gitRoot) : cwd);
  assertAllowedRoot(projectRoot);
  const repoRemote = git(projectRoot, ['config', '--get', 'remote.origin.url']);
  const branch = git(projectRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const headSha = git(projectRoot, ['rev-parse', 'HEAD']);
  const projectKey = repoRemote ?? projectRoot;

  return { cwd, projectRoot, repoRemote, branch, headSha, projectKey };
}

function assertAllowedRoot(projectRoot: string) {
  const allowed = process.env.REPO_MEMORY_ALLOWED_ROOT;
  if (!allowed) return;
  const allowedRoot = realpathSync(resolve(allowed));
  const ok = projectRoot === allowedRoot || projectRoot.startsWith(`${allowedRoot}/`);
  if (!ok) {
    throw new Error(`Repo memory access denied: ${projectRoot} is outside REPO_MEMORY_ALLOWED_ROOT=${allowedRoot}`);
  }
}

export function resolveGitRef(cwd: string, ref: string): string | null {
  return git(cwd, ['rev-parse', ref]);
}

export function changedFiles(cwd: string, fromSha: string, toSha: string): string[] {
  const out = git(cwd, ['diff', '--name-only', `${fromSha}..${toSha}`]);
  return out ? out.split('\n').map((s) => s.trim()).filter(Boolean) : [];
}
