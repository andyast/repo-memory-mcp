import { listMemories, storeMemory, supersedeMemory } from './memory.js';
import type { Store } from './db.js';

export type CheckpointStatus = 'in-progress' | 'blocked' | 'completed' | 'abandoned';

export type CheckpointTaskInput = {
  cwd?: string;
  task: string;
  status?: CheckpointStatus;
  completedSteps?: string[];
  currentStep?: string;
  nextSteps?: string[];
  blockers?: string[];
  filesChanged?: string[];
  testsRun?: string[];
  avoidRedoing?: string[];
  artifactId?: string;
  evidenceQuote?: string;
  tags?: string[];
};

function lines(label: string, items?: string[]) {
  return items?.length ? `${label}: ${items.join('; ')}` : '';
}

export function buildCheckpointMemory(input: CheckpointTaskInput) {
  const status = input.status ?? 'in-progress';
  const active = status !== 'completed' && status !== 'abandoned';
  const current = input.currentStep ? ` Current step: ${input.currentStep}.` : '';
  const next = input.nextSteps?.length ? ` Next: ${input.nextSteps.join('; ')}.` : '';
  const claim = `Checkpoint for task "${input.task}" is ${status}.${current}${next}`.trim();
  const rationale = [
    lines('Completed', input.completedSteps),
    input.currentStep ? `Current: ${input.currentStep}` : '',
    lines('Next', input.nextSteps),
    lines('Blockers', input.blockers),
    lines('Avoid redoing', input.avoidRedoing),
    lines('Tests run', input.testsRun)
  ].filter(Boolean).join('\n');
  const tags = Array.from(new Set(['checkpoint', 'task-state', status, ...(input.tags ?? [])]));
  return {
    cwd: input.cwd,
    type: 'checkpoint',
    title: `Checkpoint: ${input.task}`,
    claim,
    rationale: rationale || undefined,
    status: active ? 'active' : 'historical',
    confidence: 0.9,
    files: input.filesChanged,
    tags,
    artifactId: input.artifactId,
    evidenceQuote: input.evidenceQuote,
    evidenceRelation: input.evidenceQuote ? 'supports' : input.artifactId ? 'checkpoint-evidence' : undefined
  };
}

export function checkpointTask(input: CheckpointTaskInput, store?: Store) {
  const checkpoint = storeMemory(buildCheckpointMemory(input), store);
  const status = input.status ?? 'in-progress';
  if (!checkpoint.duplicate && (status === 'completed' || status === 'abandoned')) {
    closePriorActiveCheckpoints(input, checkpoint.id, store);
  }
  return checkpoint;
}

function closePriorActiveCheckpoints(input: CheckpointTaskInput, finalCheckpointId: string, store?: Store) {
  const title = `Checkpoint: ${input.task}`;
  const priorCheckpoints = listMemories({
    cwd: input.cwd,
    limit: 500,
    types: ['checkpoint'],
    statuses: ['active', 'probably-active']
  }, store).filter((memory) =>
    memory.id !== finalCheckpointId &&
    memory.title === title &&
    !memory.tags.includes('completed') &&
    !memory.tags.includes('abandoned')
  );

  for (const prior of priorCheckpoints) {
    supersedeMemory({ cwd: input.cwd, oldId: prior.id, newId: finalCheckpointId }, store);
  }
}

export function activeCheckpoints(input: { cwd?: string; limit?: number }, store?: Store) {
  const memories = listMemories({ cwd: input.cwd, limit: input.limit ?? 10, types: ['checkpoint'], statuses: ['active', 'probably-active'] }, store)
    .filter((memory) => !memory.tags.includes('completed') && !memory.tags.includes('abandoned'));
  return { count: memories.length, memories };
}
