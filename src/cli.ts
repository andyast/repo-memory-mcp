#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { getRepoIdentity } from './repo.js';
import { getArtifact, storeArtifact } from './artifacts.js';
import { loadProjectContext } from './context.js';
import { deleteMemory, getMemory, linkMemories, listMemories, manageMemory, memoryStatus, revalidateMemories, reviewMemories, searchMemories, storeMemory, supersedeMemory, updateMemoryStatus, verifyMemory } from './memory.js';
import { installHooks } from './hooks.js';
import { initRepoMemory } from './init.js';
import { runAndCapture } from './run.js';
import { startDashboardServer } from './dashboard-server.js';

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}
function has(name: string): boolean { return process.argv.includes(name); }
function print(value: unknown) { console.log(JSON.stringify(value, null, 2)); }
function list(name: string): string[] | undefined { return arg(name)?.split(',').map((s) => s.trim()).filter(Boolean); }

const cmd = process.argv[2] === '--help' || process.argv[2] === '-h' ? 'help' : process.argv[2];
const cwd = arg('--cwd');

try {
  switch (cmd) {
    case 'identity':
      print(getRepoIdentity(cwd));
      break;
    case 'init':
      print(initRepoMemory({ cwd, installGitHooks: has('--install-hooks'), seed: !has('--no-seed'), overwrite: has('--overwrite'), updateGitignore: has('--update-gitignore') }));
      break;
    case 'remember':
    case 'decision':
      print(storeMemory({
        cwd,
        type: cmd === 'decision' ? 'decision' : 'note',
        title: arg('--title') ?? 'Untitled memory',
        claim: arg('--claim') ?? arg('--body') ?? '',
        rationale: arg('--rationale'),
        files: list('--files'),
        symbols: list('--symbols'),
        tags: list('--tags'),
        status: has('--propose') ? 'proposed' : arg('--status')
      }));
      break;
    case 'search':
      print(searchMemories({ cwd, query: arg('--query') ?? process.argv.slice(3).join(' '), limit: Number(arg('--limit') ?? 10) }));
      break;
    case 'get':
      print(getMemory({ cwd, id: required('--id') }));
      break;
    case 'list':
      print(listMemories({ cwd, limit: Number(arg('--limit') ?? 50), offset: Number(arg('--offset') ?? 0), statuses: list('--statuses'), types: list('--types'), tags: list('--tags') }));
      break;
    case 'delete':
      print(deleteMemory({ cwd, id: required('--id'), reason: arg('--reason') }));
      break;
    case 'status':
      print(memoryStatus({ cwd }));
      break;
    case 'revalidate':
      print(revalidateMemories({ cwd, fromSha: required('--from'), toSha: arg('--to') }));
      break;
    case 'review':
      print(reviewMemories({ cwd, limit: Number(arg('--limit') ?? 50) }));
      break;
    case 'artifact-store': {
      const file = arg('--file');
      const body = file ? readFileSync(file, 'utf8') : required('--body');
      print(storeArtifact({ cwd, title: arg('--title') ?? file ?? 'Untitled artifact', type: arg('--type'), body }));
      break;
    }
    case 'artifact-get':
      print(getArtifact({ cwd, id: required('--id'), offset: Number(arg('--offset') ?? 0), limit: Number(arg('--limit') ?? 4000) }));
      break;
    case 'install-hooks':
      print(installHooks({ cwd, command: arg('--command') }));
      break;
    case 'context': {
      const result = loadProjectContext({ cwd, task: arg('--task') ?? arg('--query') ?? process.argv.slice(3).join(' '), limit: Number(arg('--limit') ?? 8), format: has('--json') ? 'json' : 'brief' });
      if (typeof result === 'string') console.log(result); else print(result);
      break;
    }
    case 'run': {
      const sep = process.argv.indexOf('--');
      const command = sep >= 0 ? process.argv.slice(sep + 1) : process.argv.slice(3).filter((part) => part !== '--no-remember');
      print(runAndCapture({ cwd, command, remember: !has('--no-remember') }));
      break;
    }
    case 'dashboard':
      startDashboardServer({ port: arg('--port') ? Number(arg('--port')) : undefined, cwd });
      break;
    case 'verify':
      print(verifyMemory({ cwd, id: required('--id'), confidence: arg('--confidence') ? Number(arg('--confidence')) : undefined }));
      break;
    case 'mark':
      print(updateMemoryStatus({ cwd, id: required('--id'), status: required('--status'), confidence: arg('--confidence') ? Number(arg('--confidence')) : undefined }));
      break;
    case 'link':
      print(linkMemories({ cwd, fromId: required('--from'), toId: required('--to'), relation: required('--relation') }));
      break;
    case 'supersede':
      print(supersedeMemory({ cwd, oldId: required('--old'), newId: required('--new') }));
      break;
    case 'manage':
      print(manageMemory(parseManageArgs(cwd)));
      break;
    case 'help':
    case undefined:
      console.log(`repo-memory-mcp CLI

Commands:
  identity [--cwd path]
  init [--install-hooks] [--no-seed] [--overwrite] [--update-gitignore]
  remember --title t --claim c [--files a,b] [--symbols x,y] [--tags a,b] [--propose]
  decision --title t --claim c [--rationale r] [--files a,b] [--symbols x,y] [--tags a,b] [--propose]
  search --query q [--limit n]
  get --id mem_x
  list [--limit n] [--statuses active,stale] [--types decision] [--tags auth]
  delete --id mem_x [--reason text]
  status
  revalidate --from sha [--to sha]
  review [--limit n]
  artifact-store --title t (--body text | --file path) [--type log]
  artifact-get --id artifact_x [--offset n] [--limit n]
  install-hooks [--command "node /path/dist/cli.js"]
  context --task "describe the work" [--limit n]
  run [--no-remember] -- kubectl get pod
  dashboard [--port n] [--cwd path]
  verify --id mem_x [--confidence 0.95]
  mark --id mem_x --status historical
  link --from mem_a --to mem_b --relation supports
  supersede --old mem_a --new mem_b
  manage --action verify|mark|delete|link|supersede ...
`);
      break;
    default:
      throw new Error(`Unknown command: ${cmd}`);
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

function parseManageArgs(cwd: string | undefined): any {
  const action = required('--action');
  if (action === 'verify') return { action, cwd, id: required('--id'), confidence: arg('--confidence') ? Number(arg('--confidence')) : undefined };
  if (action === 'mark') return { action, cwd, id: required('--id'), status: required('--status'), confidence: arg('--confidence') ? Number(arg('--confidence')) : undefined };
  if (action === 'delete') return { action, cwd, id: required('--id'), reason: arg('--reason') };
  if (action === 'link') return { action, cwd, fromId: required('--from'), toId: required('--to'), relation: required('--relation') };
  if (action === 'supersede') return { action, cwd, oldId: required('--old'), newId: required('--new') };
  throw new Error(`Unknown manage action: ${action}`);
}

function required(name: string): string {
  const value = arg(name);
  if (!value) throw new Error(`Missing required ${name}`);
  return value;
}
