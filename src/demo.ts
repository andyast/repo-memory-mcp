import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { initRepoMemory } from './init.js';
import { loadProjectContext } from './context.js';
import { revalidateMemories, searchMemories, storeMemory } from './memory.js';
import { runAndCapture } from './run.js';

const root = join(process.cwd(), 'demo-repo');
rmSync(root, { recursive: true, force: true });
mkdirSync(join(root, 'src'), { recursive: true });

function git(args: string[]) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

writeFileSync(join(root, 'src', 'auth.ts'), 'export const authLibrary = "jose";\nexport function validateJwt() { return authLibrary; }\n');
git(['init']);
git(['config', 'user.email', 'demo@example.com']);
git(['config', 'user.name', 'Repo Memory Demo']);
git(['add', '.']);
git(['commit', '-m', 'initial auth']);
const oldSha = git(['rev-parse', 'HEAD']);

const init = initRepoMemory({ cwd: root, seed: true, updateGitignore: true });
const memory = storeMemory({
  cwd: root,
  type: 'decision',
  title: 'Auth uses jose',
  claim: 'JWT validation uses jose in src/auth.ts for standards support and edge compatibility.',
  rationale: 'Chose jose over jsonwebtoken for better standards support.',
  files: ['src/auth.ts'],
  symbols: ['authLibrary', 'validateJwt'],
  tags: ['auth', 'jwt', 'decision']
});
const run = runAndCapture({ cwd: root, command: ['node', '-e', 'console.log("auth tests passed")'] });
const before = loadProjectContext({ cwd: root, task: 'modify JWT auth validation', format: 'brief' });

writeFileSync(join(root, 'src', 'auth.ts'), 'export const authLibrary = "jsonwebtoken";\nexport function validateJwt() { return authLibrary; }\n');
git(['add', '.']);
git(['commit', '-m', 'switch auth library']);
const newSha = git(['rev-parse', 'HEAD']);
const reval = revalidateMemories({ cwd: root, fromSha: oldSha, toSha: newSha });
const after = loadProjectContext({ cwd: root, task: 'modify JWT auth validation', format: 'brief' });
const search = searchMemories({ cwd: root, query: 'JWT auth jose', limit: 5 });

console.log(JSON.stringify({
  demoRepo: root,
  initConfig: init.configPath,
  memoryId: memory.id,
  runArtifactId: run.artifactId,
  runMemoryId: run.memoryId,
  searchHits: search.length,
  revalidation: reval,
  before,
  after
}, null, 2));
