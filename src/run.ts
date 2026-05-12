import { spawnSync } from 'node:child_process';
import { newId, openStore, projectId, withSqliteBusyRetry, type Store } from './db.js';
import { storeArtifact } from './artifacts.js';
import { storeMemory } from './memory.js';

function j(value: unknown): string { return JSON.stringify(value ?? null); }

export function runAndCapture(input: { cwd?: string; command: string[]; title?: string; remember?: boolean }, store?: Store) {
  if (!input.command.length) throw new Error('command is required');
  const { db, repo } = store ?? openStore(input.cwd);
  const pid = projectId(db, repo.projectKey);
  const eventId = newId('event');
  const started = Date.now();
  const result = spawnSync(input.command[0], input.command.slice(1), {
    cwd: repo.cwd,
    encoding: 'utf8',
    shell: false,
    maxBuffer: 20 * 1024 * 1024
  });
  const durationMs = Date.now() - started;
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  const exitCode = typeof result.status === 'number' ? result.status : 1;
  const signal = result.signal ?? null;
  const commandText = shellQuote(input.command);
  const title = input.title ?? `Command run: ${commandText}`;
  const body = [
    `$ ${commandText}`,
    `exit_code=${exitCode}`,
    `duration_ms=${durationMs}`,
    signal ? `signal=${signal}` : '',
    '',
    '--- stdout ---',
    stdout,
    '--- stderr ---',
    stderr
  ].filter(Boolean).join('\n');

  withSqliteBusyRetry(() => db.prepare(`INSERT INTO events(id, project_id, type, title, body, source, commit_sha, branch, metadata_json)
    VALUES (?, ?, 'command', ?, ?, 'cli', ?, ?, ?)`)
    .run(eventId, pid, title, `Ran ${commandText} with exit code ${exitCode}`, repo.headSha, repo.branch, j({ command: input.command, exitCode, signal, durationMs, cwd: repo.cwd })));

  const artifact = storeArtifact({ cwd: repo.cwd, type: 'command-output', title, body, eventId, metadata: { command: input.command, exitCode, signal, durationMs } }, store);

  let memory = null;
  if (input.remember ?? true) {
    const tags = inferTags(input.command, exitCode);
    memory = storeMemory({
      cwd: repo.cwd,
      type: exitCode === 0 ? 'command-result' : 'command-failure',
      title: `${exitCode === 0 ? 'Passed' : 'Failed'} command: ${commandText}`,
      claim: `Command \`${commandText}\` ${exitCode === 0 ? 'passed' : `failed with exit code ${exitCode}`} at ${repo.headSha ?? 'unknown HEAD'}. Full output artifact: ${artifact.id}.`,
      rationale: `Captured automatically by repo-memory run. Duration: ${durationMs}ms.`,
      tags,
      confidence: 1
    }, store);
  }

  return {
    command: input.command,
    commandText,
    exitCode,
    signal,
    durationMs,
    eventId,
    artifactId: artifact.id,
    memoryId: memory?.id ?? null,
    stdoutPreview: stdout.slice(0, 1000),
    stderrPreview: stderr.slice(0, 1000)
  };
}

function inferTags(command: string[], exitCode: number): string[] {
  const text = command.join(' ').toLowerCase();
  const tags = ['command', exitCode === 0 ? 'passed' : 'failed'];
  if (text.includes('test')) tags.push('test', 'test-command');
  if (text.includes('lint')) tags.push('lint');
  if (text.includes('build')) tags.push('build');
  if (text.includes('typecheck') || text.includes('tsc')) tags.push('typecheck');
  return Array.from(new Set(tags));
}

function shellQuote(parts: string[]): string {
  return parts.map((part) => /^[A-Za-z0-9_/:=.,@%+-]+$/.test(part) ? part : JSON.stringify(part)).join(' ');
}
