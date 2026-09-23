import { createHash } from 'node:crypto';
import type { VersionedWorkflowState, WorkflowTaskState } from './workflow-contracts.js';
import { workflowPublicationContract } from './workflow-publication.js';

type WorkflowState = Pick<VersionedWorkflowState, 'plan' | 'options' | 'tasks' | 'profile'>;

const INSTRUCTIONS = 'Implement only your writeScope and follow all contracts and acceptanceCriteria. Run the declared tests. If a declared check fails or work exceeds writeScope, publish exactly one outcome: failed handoff with the commit, changed files, test results and evidence available; create it before helperResult so publication can validate it. Exit normally only after the failed handoff is published. Do not merge, push, modify other branches or spawn nested workers. Do not alter workflow state, budgets or previous artifacts. The sole state-directory exception is exclusive creation of the dispatch publication.designatedResult.path. Make exactly one coherent commit on baseCommit and leave your worktree clean. The handoff JSON contains taskId, outcome (completed|failed), commitSha, changedFiles, tests ({command,args,passed}), interfaceChanges, assumptions, risks, summary. Keep summary <=1000 characters and lists <=30 items. Follow publication.finalization exactly; stdout/stderr and helper-local JSON are evidence, never the controller handoff. Do not emit credentials.';
const BALANCED_INSTRUCTIONS = `${INSTRUCTIONS} The complete current task contract and current filesystem take precedence over prior session history and shared summaries. Dependency handoffs are previews: inspect their referenced result artifacts and current source whenever details are needed. Preserve the specified model capability, required context, tests and acceptance criteria; do not trade correctness for token savings.`;

export function workflowPromptFingerprint(prompt: string): string {
  return createHash('sha256').update(prompt).digest('hex');
}

function balancedPayload(state: WorkflowState, entry: WorkflowTaskState) {
  // A handoff is navigational context. The complete task contract below remains authoritative.
  const acceptedDependencies = entry.task.dependencies.map(id => state.tasks.find(task => task.task.id === id))
    .filter(dependency => dependency?.status === 'accepted' && dependency.handoff)
    .map(dependency => {
      const handoff = dependency!.handoff!;
      return { taskId: dependency!.task.id, commitSha: handoff.commitSha, summary: handoff.summary,
        interfaceChanges: handoff.interfaceChanges.slice(0, 3).map(text => text.slice(0, 200)),
        risks: handoff.risks.slice(0, 3).map(text => text.slice(0, 200)), preview: true,
        artifacts: handoff.artifacts.filter(artifact => artifact.kind === 'workflow-result').slice(0, 1)
          .map(artifact => ({ path: artifact.path, kind: artifact.kind, contentHash: artifact.contentHash })) };
    });
  return { kind: 'implementation', instructions: BALANCED_INSTRUCTIONS, sharedContext: state.plan.sharedContext ?? '',
    task: entry.task, acceptedDependencies };
}

export function buildWorkflowPrompt(state: WorkflowState, entry: WorkflowTaskState, resultFile: string): string {
  const publication = workflowPublicationContract(entry.task.id, resultFile);
  const prompt = JSON.stringify(state.options.mode === 'balanced'
    ? { ...balancedPayload(state, entry), resultFile, publication }
    : { kind: 'implementation', task: entry.task, instructions: INSTRUCTIONS, resultFile, publication });
  // Reject oversized context instead of silently removing task scope or acceptance evidence.
  if (Buffer.byteLength(prompt) > 384 * 1024) throw new Error('workflow_prompt_too_large');
  return prompt;
}

export function workflowContextFingerprint(state: WorkflowState): string {
  return workflowPromptFingerprint(JSON.stringify({ instructions: BALANCED_INSTRUCTIONS, sharedContext: state.plan.sharedContext ?? '' }));
}

export function workflowSessionFingerprint(state: WorkflowState, entry: WorkflowTaskState, command: string, worktree: string): string {
  return workflowPromptFingerprint(JSON.stringify({ profile: state.profile, mode: state.options.mode,
    command, configuredCommand: state.options.glmCommand, model: state.options.glmModel ?? null,
    worktree, branch: entry.branch, payload: balancedPayload(state, entry) }));
}
