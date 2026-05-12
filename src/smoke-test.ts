import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { getArtifact, searchEvidence, storeArtifact } from './artifacts.js';
import { activeCheckpoints, checkpointTask } from './checkpoints.js';
import { loadProjectContext } from './context.js';
import { installHooks } from './hooks.js';
import { initRepoMemory } from './init.js';
import { deleteMemory, getMemory, getMemoryWithEvidence, linkMemoryEvidence, listMemories, manageMemory, revalidateMemories, reviewMemories, searchMemories, storeMemory, supersedeMemory, updateMemoryStatus, verifyMemory, memoryStatus } from './memory.js';
import { runAndCapture } from './run.js';
import { busyTimeoutMs } from './db.js';
import { cachedStoreCount, clearStoreCache, openCachedStore } from './store-cache.js';

const root = join(process.cwd(), 'test-fixtures', 'fake-repo');
rmSync(root, { recursive: true, force: true });
mkdirSync(join(root, 'src'), { recursive: true });

function git(args: string[]) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

writeFileSync(join(root, 'src', 'auth.ts'), 'export const authLibrary = "jose";\n');
git(['init']);
git(['config', 'user.email', 'test@example.com']);
git(['config', 'user.name', 'Test User']);
git(['add', '.']);
git(['commit', '-m', 'initial auth']);
const oldSha = git(['rev-parse', 'HEAD']);

const init = initRepoMemory({ cwd: root, seed: true, updateGitignore: true });
if (!init.seededMemoryIds.length) throw new Error('Expected init seed memory');

clearStoreCache();
const cachedA = openCachedStore(root);
const cachedB = openCachedStore(join(root, 'src'));
if (cachedA !== cachedB || cachedStoreCount() !== 1) throw new Error('Expected MCP store cache to reuse the same repo store');
if ((cachedA.db.pragma('busy_timeout', { simple: true }) as number) !== busyTimeoutMs()) throw new Error('Expected cached store busy_timeout pragma');
const directDb = new Database(join(root, '.repo-memory', 'store.db'), { timeout: 1 });
directDb.pragma('busy_timeout = 1234');
if ((directDb.pragma('busy_timeout', { simple: true }) as number) !== 1234) throw new Error('Expected SQLite busy_timeout smoke check');
directDb.close();
clearStoreCache();

const stored = storeMemory({
  cwd: root,
  type: 'decision',
  title: 'Auth uses jose',
  claim: 'Auth middleware uses jose for JWT validation.',
  rationale: 'jose was selected for standards support and edge compatibility.',
  files: ['src/auth.ts'],
  symbols: ['authLibrary'],
  tags: ['auth', 'decision']
});

const results = searchMemories({ cwd: root, query: 'jose JWT', limit: 5 });
if (results.length < 1) throw new Error('Expected search result');
const relaxedResults = searchMemories({ cwd: root, query: 'auth JWT decisions', limit: 5 });
if (!relaxedResults.some((mem) => mem.id === stored.id)) throw new Error('Expected relaxed search to find auth decision memory');

writeFileSync(join(root, 'src', 'auth.ts'), 'export const authLibrary = "jsonwebtoken";\n');
git(['add', '.']);
git(['commit', '-m', 'switch auth library']);
const newSha = git(['rev-parse', 'HEAD']);

const artifact = storeArtifact({ cwd: root, type: 'log', title: 'Long test output', body: 'start\n' + 'x'.repeat(5000) + '\nend' });
const artifactPage = getArtifact({ cwd: root, id: artifact.id, offset: 0, limit: 100 });
if (!artifactPage?.hasMore) throw new Error('Expected artifact paging');

const sourceArtifact = storeArtifact({ cwd: root, type: 'transcript', title: 'Auth design discussion', body: 'We decided jose is the JWT library because it works well at the edge.' });
const sourcedMemory = storeMemory({
  cwd: root,
  type: 'decision',
  title: 'Source-backed auth decision',
  claim: 'The team chose jose because it works well at the edge.',
  tags: ['auth', 'evidence'],
  artifactId: sourceArtifact.id,
  evidenceQuote: 'We decided jose is the JWT library because it works well at the edge.'
});
const sourced = getMemoryWithEvidence({ cwd: root, id: sourcedMemory.id });
if (!sourced?.evidence?.length) throw new Error('Expected source-backed memory evidence');
const evidenceHits = searchEvidence({ cwd: root, query: 'jose edge', limit: 5 });
if (!evidenceHits.some((hit) => hit.id === sourceArtifact.id)) throw new Error('Expected searchable evidence hit');
const linked = linkMemoryEvidence({ cwd: root, memoryId: stored.id, artifactId: sourceArtifact.id, quote: 'We decided jose is the JWT library because it works well at the edge.' });
if (!linked?.evidence?.length) throw new Error('Expected linked memory evidence');

const hooks = installHooks({ cwd: root, command: 'repo-memory' });
if (hooks.hooks.length !== 3) throw new Error('Expected three hooks installed');

const run = runAndCapture({ cwd: root, command: ['node', '-e', 'console.log("tests passed")'] });
if (run.exitCode !== 0 || !run.artifactId || !run.memoryId) throw new Error('Expected captured command success');

const checkpoint = checkpointTask({ cwd: root, task: 'change auth JWT library', completedSteps: ['Created fixture repo'], currentStep: 'Run context checks', nextSteps: ['Revalidate stale memories'], filesChanged: ['src/auth.ts'], testsRun: ['node -e console.log'] });
const checkpoints = activeCheckpoints({ cwd: root, limit: 5 });
if (!checkpoints.memories.some((mem) => mem.id === checkpoint.id)) throw new Error('Expected active checkpoint');
const contextBrief = loadProjectContext({ cwd: root, task: 'change auth JWT library', limit: 5, format: 'brief' });
if (typeof contextBrief !== 'string' || !contextBrief.includes('Relevant memories') || !contextBrief.includes('Active checkpoints')) throw new Error('Expected readable context brief with checkpoints');
const contextPackBeforeReval = loadProjectContext({ cwd: root, task: 'change auth JWT library', limit: 5, format: 'json' });
if (typeof contextPackBeforeReval === 'string' || contextPackBeforeReval.taskMatches.length < 1 || contextPackBeforeReval.activeCheckpoints.length < 1) throw new Error('Expected context pack task match and checkpoint');
const completedCheckpoint = checkpointTask({ cwd: root, task: 'change auth JWT library', status: 'completed', completedSteps: ['Created fixture repo', 'Run context checks'], filesChanged: ['src/auth.ts'], testsRun: ['node -e console.log'] });
const checkpointsAfterComplete = activeCheckpoints({ cwd: root, limit: 5 });
if (checkpointsAfterComplete.memories.some((mem) => mem.id === checkpoint.id)) throw new Error('Expected completed checkpoint to close prior active checkpoint');
const closedCheckpoint = getMemory({ cwd: root, id: checkpoint.id });
const completedCheckpointMemory = getMemory({ cwd: root, id: completedCheckpoint.id });
if (closedCheckpoint?.status !== 'superseded') throw new Error(`Expected old checkpoint to be superseded, got ${closedCheckpoint?.status}`);
if (completedCheckpointMemory?.status !== 'historical') throw new Error(`Expected completed checkpoint to be historical, got ${completedCheckpointMemory?.status}`);

const reval = revalidateMemories({ cwd: root, fromSha: 'HEAD~1', toSha: 'HEAD' });
if (reval.affectedCount !== 1) throw new Error(`Expected 1 affected memory, got ${reval.affectedCount}`);
if (reval.scanType !== 'git-diff-staleness') throw new Error('Expected revalidation scan type');
if (reval.fromSha !== oldSha || reval.toSha !== newSha) throw new Error('Expected resolved git refs in revalidation output');
if (reval.flaggedForReview.length !== 1) throw new Error('Expected flagged memory review item');
if (!reval.nextActions.some((action) => action.includes('repo-memory verify'))) throw new Error('Expected review next actions');
const status = memoryStatus({ cwd: root });
if (!status.counts['needs-revalidation']) throw new Error('Expected needs-revalidation status');

const contextPackAfterReval = loadProjectContext({ cwd: root, task: 'change auth JWT library', limit: 5, format: 'json' });
if (typeof contextPackAfterReval === 'string' || contextPackAfterReval.needsAttention.length < 1) throw new Error('Expected context pack stale warning');
const review = reviewMemories({ cwd: root });
if (review.count < 1 || !review.memories.some((mem) => mem.id === stored.id)) throw new Error('Expected review memories result');
if (!review.suggestedCommands.verifyIfStillTrue.includes('repo-memory verify')) throw new Error('Expected review suggested command');
const cliReview = JSON.parse(execFileSync('npx', ['tsx', join(process.cwd(), 'src', 'cli.ts'), 'review', '--cwd', root], { encoding: 'utf8' }));
if (!cliReview.count) throw new Error('Expected CLI review output');
const noChangeReval = revalidateMemories({ cwd: root, fromSha: 'HEAD', toSha: 'HEAD' });
if (!noChangeReval.notes?.some((note) => note.includes('HEAD~1'))) throw new Error('Expected helpful same-ref note');

const verified = verifyMemory({ cwd: root, id: stored.id });
if (verified?.status !== 'active') throw new Error('Expected verified memory active');

const historical = updateMemoryStatus({ cwd: root, id: run.memoryId!, status: 'historical', confidence: 0.7 });
if (historical?.status !== 'historical') throw new Error('Expected historical memory');

const listed = listMemories({ cwd: root, limit: 10 });
if (listed.length < 2) throw new Error('Expected list memories result');

const temp = storeMemory({ cwd: root, type: 'note', title: 'Temporary note', claim: 'This should be deleted.', tags: ['temp'] });
const deleted = manageMemory({ cwd: root, action: 'delete', id: temp.id, reason: 'smoke test cleanup' });
if (!(deleted as any).deleted) throw new Error('Expected manage delete to work');

const replacement = storeMemory({
  cwd: root,
  type: 'decision',
  title: 'Auth uses jsonwebtoken',
  claim: 'Auth now uses jsonwebtoken after the switch.',
  files: ['src/auth.ts'],
  symbols: ['authLibrary'],
  tags: ['auth', 'decision']
});
const superseded = supersedeMemory({ cwd: root, oldId: stored.id, newId: replacement.id });
if (getMemory({ cwd: root, id: stored.id })?.status !== 'superseded') throw new Error('Expected superseded old memory');

const client = new Client({ name: 'repo-memory-smoke-test', version: '1.0.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: [join(process.cwd(), 'dist', 'server.js')], cwd: root, stderr: 'pipe' });
await client.connect(transport);
const tools = await client.listTools();
for (const toolName of ['propose_memory', 'recent_activity', 'finish_task', 'checkpoint_task', 'active_checkpoints']) {
  if (!tools.tools.some((tool) => tool.name === toolName)) throw new Error(`Expected ${toolName} MCP tool`);
}
const proposedResult = await client.callTool({
  name: 'propose_memory',
  arguments: {
    cwd: root,
    type: 'gotcha',
    title: 'Smoke MCP proposal',
    claim: 'The smoke test verifies propose_memory creates proposed memories through MCP.',
    tags: ['smoke', 'mcp']
  }
});
const proposedContent = proposedResult.content as Array<{ type: string; text?: string }>;
const proposedText = proposedContent.find((part) => part.type === 'text')?.text;
if (!proposedText) throw new Error('Expected propose_memory text result');
const proposed = JSON.parse(proposedText);
const proposedMemory = getMemory({ cwd: root, id: proposed.id });
if (proposedMemory?.status !== 'proposed') throw new Error('Expected propose_memory to force proposed status');
const mcpCheckpointResult = await client.callTool({ name: 'checkpoint_task', arguments: { cwd: root, task: 'Smoke MCP checkpoint', currentStep: 'Verify active_checkpoints', nextSteps: ['Call finish_task'], tags: ['smoke'] } });
const mcpCheckpointText = (mcpCheckpointResult.content as Array<{ type: string; text?: string }>).find((part) => part.type === 'text')?.text;
if (!mcpCheckpointText) throw new Error('Expected checkpoint_task text result');
const mcpCheckpoint = JSON.parse(mcpCheckpointText);
const activeCheckpointResult = await client.callTool({ name: 'active_checkpoints', arguments: { cwd: root, limit: 10 } });
const activeCheckpointText = (activeCheckpointResult.content as Array<{ type: string; text?: string }>).find((part) => part.type === 'text')?.text;
if (!activeCheckpointText || !JSON.parse(activeCheckpointText).memories?.some((mem: any) => mem.id === mcpCheckpoint.id)) throw new Error('Expected active_checkpoints to include MCP checkpoint');
const activityResult = await client.callTool({ name: 'recent_activity', arguments: { cwd: root, limit: 3 } });
const activityText = (activityResult.content as Array<{ type: string; text?: string }>).find((part) => part.type === 'text')?.text;
if (!activityText || !JSON.parse(activityText).memories?.length) throw new Error('Expected recent_activity memories');
const finishResult = await client.callTool({
  name: 'finish_task',
  arguments: {
    cwd: root,
    summary: 'Smoke test exercised finish_task.',
    filesChanged: ['src/smoke-test.ts'],
    testsRun: ['npm test'],
    outcome: 'passed',
    proposedMemories: [{
      type: 'command',
      title: 'Smoke finish task proposal',
      claim: 'The smoke test verifies finish_task can create a proposed memory and task summary artifact through MCP.',
      tags: ['smoke', 'finish-task']
    }]
  }
});
const finishText = (finishResult.content as Array<{ type: string; text?: string }>).find((part) => part.type === 'text')?.text;
if (!finishText) throw new Error('Expected finish_task text result');
const finish = JSON.parse(finishText);
if (finish.proposedCount !== 1) throw new Error('Expected finish_task to create one proposed memory');
const finishMemory = getMemory({ cwd: root, id: finish.proposedMemories[0].id });
if (finishMemory?.status !== 'proposed') throw new Error('Expected finish_task memory to be proposed');
await client.close();

console.log(JSON.stringify({ ok: true, initConfig: init.configPath, initSeeded: init.seededMemoryIds.length, gitignoreUpdated: init.gitignoreUpdated, stored, sourcedMemory: sourcedMemory.id, checkpoint: checkpoint.id, completedCheckpoint: completedCheckpoint.id, mcpCheckpoint: mcpCheckpoint.id, evidenceCount: sourced.evidence.length, linkedEvidenceCount: linked.evidence.length, evidenceHits: evidenceHits.length, verified: verified?.id, historical: historical?.id, listed: listed.length, deleted: (deleted as any).id, replacement: replacement.id, superseded: superseded.relation, proposed: proposed.id, finishProposed: finish.proposedMemories[0].id, runArtifact: run.artifactId, runMemory: run.memoryId, artifact: artifact.id, artifactHasMore: artifactPage.hasMore, hooks: hooks.hooks.length, results: results.length, contextMatches: typeof contextPackBeforeReval === 'string' ? 0 : contextPackBeforeReval.taskMatches.length, contextCheckpoints: typeof contextPackBeforeReval === 'string' ? 0 : contextPackBeforeReval.activeCheckpoints.length, contextWarnings: typeof contextPackAfterReval === 'string' ? 0 : contextPackAfterReval.needsAttention.length, reval, counts: status.counts }, null, 2));
