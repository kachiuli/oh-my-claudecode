/** Opt-in Claude-led workflow. Every integration and finding disposition is an explicit lead action. */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, lstatSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { withFileLock } from '../lib/file-lock.js';
import { loadConfig } from '../config/loader.js';
import { createArtifactDescriptorFromPath } from '../shared/artifact-descriptor.js';
import { TeamPaths, absPath, teamStateRoot } from './state-paths.js';
import { atomicWriteJson, ensureDirWithMode, validateResolvedPath } from './fs-utils.js';
import { ensureWorkerWorktree, getBranchName, getWorktreePath, removeWorkerWorktree } from './git-worktree.js';
import { applyGlmProfile, getGlmConfig, resolveGlmExecutable } from './glm-config.js';
import { ABSOLUTE_MAX_WORKERS } from './types.js';
import { resolveRoleAssignment } from './stage-router.js';
import { buildLaunchArgs, resolveValidatedBinaryPath } from './model-contract.js';
import { runWorkflowProcess, redactWorkflowText } from './workflow-process.js';
import { boundedText, safeWorkflowId, parseWorkflowPlan, parseWorkflowTask, matchesScope,
  parseWorkflowHandoff, parseWorkflowFindings, type WorkflowState, type WorkflowOptions, type WorkflowTaskState,
  type WorkflowFinding } from './workflow-contracts.js';

export type { WorkflowState, WorkflowOptions, WorkflowPlan, WorkflowTask, WorkflowHandoff, WorkflowFinding } from './workflow-contracts.js';

const now = () => new Date().toISOString();
function git(cwd: string, args: string[]): string {
  try { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe', timeout: 30_000, windowsHide: true }).trim(); }
  catch { throw new Error('workflow_git_operation_failed'); }
}
function statePath(cwd: string, name: string): string {
  const root = teamStateRoot(cwd, safeWorkflowId(name));
  validateResolvedPath(root, teamStateRoot(cwd, ''));
  return join(root, 'workflow.json');
}
function boundedJson(path: string, max = 64 * 1024): unknown {
  if (lstatSync(path).isSymbolicLink() || statSync(path).size > max) throw new Error('workflow_artifact_invalid_or_oversized');
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { throw new Error('workflow_invalid_json'); }
}
function workerResultJson(path: string): unknown {
  if (lstatSync(path).isSymbolicLink()) throw new Error('workflow_result_symlink_rejected');
  try {
    if (statSync(path).size > 64 * 1024) throw new Error('workflow_artifact_invalid_or_oversized');
    const parsed: unknown = JSON.parse(redactWorkflowText(readFileSync(path, 'utf8')));
    atomicWriteJson(path, parsed);
    return parsed;
  } catch {
    // Result metadata is a bounded protocol, not a transcript archive. Invalid raw metadata must not retain secrets.
    atomicWriteJson(path, { error: 'workflow_invalid_result' });
    throw new Error('workflow_invalid_result');
  }
}
function clean(cwd: string): boolean {
  return git(cwd, ['status', '--porcelain', '--untracked-files=all']).split('\n')
    .every(line => !line || /^\?\? \.omc\//.test(line));
}
function assertLeader(state: WorkflowState): string {
  if (git(state.cwd, ['branch', '--show-current']) !== state.plan.integrationBranch) throw new Error('workflow_integration_branch_mismatch');
  if (!clean(state.cwd)) throw new Error('workflow_integration_worktree_dirty');
  const head = git(state.cwd, ['rev-parse', 'HEAD']);
  if (head !== state.integrationHead) throw new Error('workflow_integration_head_changed');
  return head;
}
function assertLeadCaller(): void {
  if (process.env.OMC_TEAM_WORKER || process.env.OMC_TEAM_WORKER_NAME || process.env.OMC_TEAM_WORKTREE_PATH) throw new Error('workflow_lead_authority_required');
}
function assertMutable(state: WorkflowState): void {
  if (state.stage === 'complete') throw new Error('workflow_already_complete');
}
function save(state: WorkflowState): void {
  state.updatedAt = now();
  atomicWriteJson(statePath(state.cwd, state.plan.name), state);
  // Canonical task projections retain numeric IDs and claim identities; workflow.json owns integration decisions.
  for (const entry of state.tasks) {
    atomicWriteJson(absPath(state.cwd, TeamPaths.taskFile(state.plan.name, entry.canonicalId)), {
      id: entry.canonicalId, subject: entry.task.objective, description: entry.task.objective,
      status: entry.status === 'accepted' ? 'completed' : entry.status === 'rejected' ? 'failed' : entry.status === 'running' ? 'in_progress' : entry.status,
      owner: entry.worker, created_at: state.createdAt, version: entry.attempts + 1,
      ...(entry.claimToken ? { claim: { owner: entry.worker, token: entry.claimToken, leased_until: new Date(Date.now() + state.options.timeoutMs).toISOString() } } : {}),
      metadata: { workflow: state.plan.name, task_id: entry.task.id, write_scope: entry.task.writeScope,
        integration: entry.status, handoff: entry.handoff },
    });
  }
}
export function readWorkflow(cwd: string, name: string): WorkflowState {
  const state = boundedJson(statePath(cwd, name), 16 * 1024 * 1024) as WorkflowState;
  if (!state || state.schemaVersion !== 1 || state.profile !== 'claude-glm-codex' || state.plan?.name !== name
    || realpathSync(state.cwd) !== realpathSync(cwd)) throw new Error('workflow_invalid_state');
  parseWorkflowPlan(state.plan);
  if (!Array.isArray(state.tasks) || !Array.isArray(state.reviews)) throw new Error('workflow_invalid_state');
  return state;
}
async function mutate(cwd: string, name: string, action: (state: WorkflowState) => Promise<void>): Promise<WorkflowState> {
  assertLeadCaller();
  const path = statePath(cwd, name);
  return withFileLock(`${path}.lock`, async () => {
    const state = readWorkflow(cwd, name);
    assertMutable(state);
    try { await action(state); } finally { save(state); }
    return state;
  }, { timeoutMs: 0 });
}
function count(value: number | undefined, fallback: number, max: number, min = 1): number {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < min || result > max) throw new Error('workflow_invalid_limit');
  return result;
}
export async function initWorkflow(cwd: string, rawPlan: unknown, options: WorkflowOptions = {}): Promise<WorkflowState> {
  assertLeadCaller();
  if (redactWorkflowText(JSON.stringify({ rawPlan, options })) !== JSON.stringify({ rawPlan, options })) throw new Error('workflow_sensitive_input_rejected');
  cwd = realpathSync(cwd);
  const plan = parseWorkflowPlan(rawPlan);
  const path = statePath(cwd, plan.name);
  if (existsSync(teamStateRoot(cwd, plan.name))) throw new Error('workflow_name_already_exists');
  if (!clean(cwd)) throw new Error('workflow_leader_worktree_dirty');
  if (/^(?:main|master)$/i.test(plan.integrationBranch) || plan.integrationBranch.startsWith('-')) throw new Error('workflow_integration_branch_required');
  git(cwd, ['check-ref-format', '--branch', plan.integrationBranch]);
  if (git(cwd, ['rev-parse', `${plan.baseCommit}^{commit}`]) !== plan.baseCommit) throw new Error('workflow_invalid_base');
  for (const task of plan.tasks) if (task.baseCommit !== plan.baseCommit) throw new Error('workflow_task_base_mismatch');
  const loaded = loadConfig();
  const routing = applyGlmProfile({ ...loaded, team: { ...loaded.team, profile: 'claude-glm-codex' } });
  const executor = resolveRoleAssignment('executor', routing);
  const reviewer = resolveRoleAssignment('code-reviewer', routing);
  if (executor.provider !== 'glm' || reviewer.provider !== 'codex') throw new Error('workflow_role_routing_requires_glm_executor_and_codex_reviewer');
  const config = getGlmConfig(routing);
  const maxWorkers = count(options.maxWorkers, config.maxWorkers, ABSOLUTE_MAX_WORKERS);
  const resolvedOptions: WorkflowState['options'] = {
    workers: count(options.workers, Math.min(config.defaultWorkers, maxWorkers), maxWorkers), maxWorkers,
    maxAttempts: count(options.maxAttempts, 2, 5), maxReviewPasses: count(options.maxReviewPasses, 2, 10),
    timeoutMs: count(options.timeoutMs, 600_000, 3_600_000, 100), backoffMs: count(options.backoffMs, 1000, 30_000, 0),
    glmCommand: options.glmCommand ?? config.command, codexCommand: options.codexCommand ?? 'codex',
    ...(options.glmModel ?? (executor.model || config.model) ? { glmModel: options.glmModel ?? (executor.model || config.model) } : {}),
    ...(options.codexModel ?? reviewer.model ? { codexModel: options.codexModel ?? reviewer.model } : {}),
  };
  if (redactWorkflowText(JSON.stringify(resolvedOptions)) !== JSON.stringify(resolvedOptions)) throw new Error('workflow_sensitive_input_rejected');
  // Resolve lazily at dispatch: init/status remain usable when a provider has not been installed yet.
  boundedText(resolvedOptions.glmCommand, 1000); boundedText(resolvedOptions.codexCommand, 1000);
  if (resolvedOptions.glmModel !== undefined) boundedText(resolvedOptions.glmModel, 160);
  if (resolvedOptions.codexModel !== undefined) boundedText(resolvedOptions.codexModel, 160);
  if (git(cwd, ['branch', '--show-current']) !== plan.integrationBranch) {
    git(cwd, ['switch', '-c', plan.integrationBranch, plan.baseCommit]);
  } else if (git(cwd, ['rev-parse', 'HEAD']) !== plan.baseCommit) throw new Error('workflow_initial_head_mismatch');
  const state: WorkflowState = {
    schemaVersion: 1, profile: 'claude-glm-codex', plan, cwd, integrationHead: plan.baseCommit, options: resolvedOptions, stage: 'implementation',
    tasks: plan.tasks.map((task, index) => ({ task, canonicalId: String(index + 1), status: 'pending', attempts: 0,
      worker: `task-${task.id}`, updatedAt: now() })), reviewPasses: 0, reviews: [], createdAt: now(), updatedAt: now(),
  };
  ensureDirWithMode(teamStateRoot(cwd, plan.name));
  await withFileLock(`${path}.lock`, async () => save(state));
  return state;
}
function getTask(state: WorkflowState, id: string): WorkflowTaskState {
  const task = state.tasks.find(entry => entry.task.id === id);
  if (!task) throw new Error('workflow_task_not_found');
  return task;
}
function artifactsRoot(state: WorkflowState): string {
  const root = join(teamStateRoot(state.cwd, state.plan.name), 'artifacts');
  validateResolvedPath(root, teamStateRoot(state.cwd, state.plan.name));
  ensureDirWithMode(root);
  return root;
}
function assertWorker(state: WorkflowState, entry: WorkflowTaskState): string {
  const expected = getWorktreePath(state.cwd, state.plan.name, entry.worker);
  if (!entry.worktree || resolve(entry.worktree) !== resolve(expected) || entry.branch !== getBranchName(state.plan.name, entry.worker)) throw new Error('workflow_worker_mapping_mismatch');
  validateResolvedPath(expected, join(teamStateRoot(state.cwd, ''), '..', '..', 'team'));
  if (git(expected, ['branch', '--show-current']) !== entry.branch) throw new Error('workflow_worker_branch_mismatch');
  if (realpathSync(git(expected, ['rev-parse', '--show-toplevel'])) !== realpathSync(expected)) throw new Error('workflow_worker_mapping_mismatch');
  const registered = git(state.cwd, ['worktree', 'list', '--porcelain']);
  if (!registered.replaceAll('\\', '/').split('\n').some(line => line === `worktree ${expected.replaceAll('\\', '/')}`)) throw new Error('workflow_worker_unregistered');
  if (!clean(expected)) throw new Error('workflow_worker_worktree_dirty');
  return expected;
}
function validateCommit(state: WorkflowState, entry: WorkflowTaskState): string[] {
  const cwd = assertWorker(state, entry);
  const sha = entry.handoff?.commitSha;
  if (!sha || git(cwd, ['rev-parse', 'HEAD']) !== sha) throw new Error('workflow_worker_commit_mismatch');
  const parents = git(cwd, ['rev-list', '--parents', '-n', '1', sha]).split(' ');
  if (parents.length !== 2 || parents[1] !== entry.task.baseCommit) throw new Error('workflow_worker_single_commit_required');
  const files = git(cwd, ['diff', '--name-only', '--no-renames', '-z', entry.task.baseCommit, sha]).split('\0').filter(Boolean);
  if (!files.length || files.length > 100) throw new Error('workflow_invalid_changed_files');
  for (const file of files) if (!matchesScope(file, entry.task.writeScope) || matchesScope(file, entry.task.prohibitedScope)) throw new Error('workflow_out_of_scope_changes');
  if (JSON.stringify([...files].sort()) !== JSON.stringify([...(entry.handoff?.changedFiles ?? [])].sort())) throw new Error('workflow_changed_files_mismatch');
  return files;
}
async function executeTask(state: WorkflowState, entry: WorkflowTaskState, command: string): Promise<void> {
  const root = artifactsRoot(state);
  if (entry.attempts === 0 && entry.task.dependencies.length) {
    entry.task.baseCommit = state.integrationHead;
  }
  while (entry.attempts < state.options.maxAttempts) {
    entry.attempts++; entry.status = 'running'; entry.claimToken = randomUUID(); entry.updatedAt = now(); save(state);
    try {
      const worktree = ensureWorkerWorktree(state.plan.name, entry.worker, state.cwd, { mode: 'named', baseRef: entry.task.baseCommit });
      if (!worktree) throw new Error('workflow_worktree_required');
      entry.worktree = worktree.path; entry.branch = worktree.branch;
      assertWorker(state, entry);
      if (git(entry.worktree, ['rev-parse', 'HEAD']) !== entry.task.baseCommit) throw new Error('workflow_worker_base_mismatch');
      const prefix = join(root, `${entry.worker}-${entry.attempts}`);
      const resultFile = `${prefix}.result.json`;
      if (existsSync(resultFile)) throw new Error('workflow_result_already_exists');
      const instructions = 'Implement only your writeScope and follow all contracts and acceptanceCriteria. Run the declared tests. Do not merge, push, modify other branches, spawn nested workers or write leader state. Make exactly one coherent commit on baseCommit and leave your worktree clean. Write resultFile JSON with taskId, outcome (completed|failed), commitSha, changedFiles, tests ({command,args,passed}), interfaceChanges, assumptions, risks, summary. Keep summary <=1000 characters and lists <=30 items. stdout/stderr are artifacts, never the handoff. Do not emit credentials.';
      const result = await runWorkflowProcess({ command, args: [...buildLaunchArgs('glm', {
        teamName: state.plan.name, workerName: entry.worker, cwd: entry.worktree, model: state.options.glmModel,
      }), '-p'], cwd: entry.worktree, stdin: JSON.stringify({ kind: 'implementation', task: entry.task, instructions, resultFile }),
      timeoutMs: state.options.timeoutMs, artifactPrefix: prefix, provider: 'glm', worker: entry.worker });
      entry.handoff = { taskId: entry.task.id, outcome: 'failed', changedFiles: [], tests: [], interfaceChanges: [], assumptions: [], risks: [], summary: result.error ?? 'Worker result pending validation', artifacts: result.artifacts };
      if (!result.passed) throw new Error(`workflow_${result.error}`);
      validateResolvedPath(resultFile, root);
      const handoff = parseWorkflowHandoff(workerResultJson(resultFile), entry.task.id);
      // Provider result is untrusted text: never persist credentials returned in a handoff.
      const safeHandoff = parseWorkflowHandoff(JSON.parse(redactWorkflowText(JSON.stringify(handoff))), entry.task.id);
      atomicWriteJson(resultFile, safeHandoff);
      entry.handoff = { ...safeHandoff, artifacts: [...result.artifacts, createArtifactDescriptorFromPath(resultFile, {
        kind: 'workflow-result', producer: { system: 'omc', component: 'team-workflow', worker: entry.worker }, retention: 'until-completion',
      })] };
      if (handoff.outcome !== 'completed' || handoff.tests.some(test => !test.passed)) throw new Error('workflow_worker_reported_failure');
      for (const test of entry.task.tests) if (!handoff.tests.some(result => result.passed && result.command === test.command && JSON.stringify(result.args) === JSON.stringify(test.args))) throw new Error('workflow_worker_test_evidence_missing');
      validateCommit(state, entry);
      for (const [index, test] of entry.task.tests.entries()) {
        const check = await runWorkflowProcess({ ...test, cwd: entry.worktree, timeoutMs: state.options.timeoutMs,
          artifactPrefix: `${prefix}.test-${index}`, worker: entry.worker });
        entry.handoff.artifacts.push(...check.artifacts);
        if (!check.passed) throw new Error('workflow_worker_test_failed');
      }
      validateCommit(state, entry);
      entry.status = 'completed'; delete entry.error; break;
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      entry.error = /^workflow_[a-z_]+$/.test(message) ? message : 'workflow_worker_failed';
      entry.status = 'failed';
      if (entry.error === 'workflow_timeout' || entry.error === 'workflow_interrupted') break;
      // Any work or moved HEAD is retained for the lead; retry only pristine attempts.
      if (entry.worktree) {
        try { if (!clean(entry.worktree) || git(entry.worktree, ['rev-parse', 'HEAD']) !== entry.task.baseCommit) break; }
        catch { break; }
      }
      if (entry.attempts < state.options.maxAttempts) {
        const delay = Math.min(30_000, state.options.backoffMs * entry.attempts);
        entry.backoffUntil = new Date(Date.now() + delay).toISOString(); save(state);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    } finally { delete entry.claimToken; delete entry.backoffUntil; entry.updatedAt = now(); save(state); }
  }
}
export async function runWorkflow(cwd: string, name: string): Promise<WorkflowState> {
  return mutate(cwd, name, async state => {
    assertLeader(state);
    const protectedRefs = () => git(cwd, ['for-each-ref', '--format=%(refname) %(objectname)']).split('\n')
      .filter(ref => !ref.startsWith(`refs/heads/omc-team/${name}/`)).join('\n');
    const refsBefore = protectedRefs();
    // A killed owner is never silently re-spawned: retained running work requires inspection.
    if (state.tasks.some(entry => entry.status === 'running')) throw new Error('workflow_interrupted_worker_requires_inspection');
    const candidates = state.tasks.filter(entry => ['pending', 'failed'].includes(entry.status) && entry.attempts < state.options.maxAttempts
      && !['workflow_timeout', 'workflow_interrupted', 'workflow_worker_modified_protected_refs'].includes(entry.error ?? '')
      && entry.task.dependencies.every(id => getTask(state, id).status === 'accepted'));
    if (!candidates.length) return;
    let command: string;
    try { command = resolveGlmExecutable(state.options.glmCommand); } catch { throw new Error('workflow_glm_unavailable_fallback_disabled'); }
    let cursor = 0;
    const pools = await Promise.allSettled(Array.from({ length: Math.min(state.options.workers, candidates.length) }, async () => {
      while (cursor < candidates.length && !state.tasks.some(entry => entry.error === 'workflow_interrupted')) {
        const entry = candidates[cursor++]!; await executeTask(state, entry, command);
      }
    }));
    if (pools.some(pool => pool.status === 'rejected')) throw new Error('workflow_worker_persistence_failed');
    if (protectedRefs() !== refsBefore) {
      for (const entry of candidates) if (entry.status === 'completed') { entry.status = 'failed'; entry.error = 'workflow_worker_modified_protected_refs'; }
      throw new Error('workflow_worker_modified_protected_refs');
    }
    state.stage = state.tasks.some(entry => entry.status === 'completed') ? 'integration' : 'implementation';
  });
}
export async function acceptWorkflowTask(cwd: string, name: string, taskId: string): Promise<WorkflowState> {
  return mutate(cwd, name, async state => {
    assertLeader(state);
    const entry = getTask(state, taskId);
    if (entry.status !== 'completed') throw new Error('workflow_task_not_awaiting_acceptance');
    if (!entry.task.dependencies.every(id => getTask(state, id).status === 'accepted')) throw new Error('workflow_dependency_not_integrated');
    validateCommit(state, entry);
    // Conflict state is deliberately preserved. No reset, force checkout or automatic conflict resolution.
    git(cwd, ['cherry-pick', entry.handoff!.commitSha!]);
    state.integrationHead = git(cwd, ['rev-parse', 'HEAD']);
    entry.status = 'accepted'; entry.updatedAt = now();
    delete state.verification; state.stage = 'integration';
    for (const id of entry.findingIds ?? []) {
      const finding = state.reviews.flatMap(review => review.findings).find(finding => finding.id === id);
      if (finding) finding.fixedBy = entry.task.id;
    }
  });
}
export async function rejectWorkflowTask(cwd: string, name: string, taskId: string, reason: string): Promise<WorkflowState> {
  return mutate(cwd, name, async state => {
    const entry = getTask(state, taskId);
    if (!['pending', 'completed', 'failed'].includes(entry.status)) throw new Error('workflow_task_cannot_be_rejected');
    entry.status = 'rejected'; entry.error = redactWorkflowText(boundedText(reason, 1000)); entry.updatedAt = now();
  });
}
function integrated(state: WorkflowState): void {
  if (state.tasks.some(entry => !['accepted', 'rejected'].includes(entry.status)) || !state.tasks.some(entry => entry.status === 'accepted')) throw new Error('workflow_integration_incomplete');
}
export async function verifyWorkflow(cwd: string, name: string): Promise<WorkflowState> {
  return mutate(cwd, name, async state => {
    integrated(state); const head = assertLeader(state); state.stage = 'verification';
    const checks: NonNullable<WorkflowState['verification']>['checks'] = [];
    for (const [index, command] of state.plan.verification.entries()) {
      const result = await runWorkflowProcess({ ...command, cwd, timeoutMs: state.options.timeoutMs,
        artifactPrefix: join(artifactsRoot(state), `verify-${state.reviewPasses}-${index}-${randomUUID()}`) });
      checks.push({ command, passed: result.passed, artifacts: result.artifacts });
      if (!result.passed) break;
    }
    state.verification = { head, passed: checks.length === state.plan.verification.length && checks.every(check => check.passed), checks };
    if (assertLeader(state) !== head) state.verification.passed = false;
  });
}
function verificationGate(state: WorkflowState): string {
  integrated(state); const head = assertLeader(state);
  if (!state.verification?.passed || state.verification.head !== head) throw new Error('workflow_current_verification_required');
  return head;
}
export async function reviewWorkflow(cwd: string, name: string): Promise<WorkflowState> {
  return mutate(cwd, name, async state => {
    const head = verificationGate(state);
    const refs = git(cwd, ['for-each-ref', '--format=%(refname) %(objectname)']);
    if (state.reviewPasses >= state.options.maxReviewPasses) throw new Error('workflow_review_limit_reached');
    if (state.reviews.some(review => review.findings.some(finding => !finding.disposition || finding.disposition === 'fix' && !finding.fixedBy))) throw new Error('workflow_findings_require_adjudication_or_fix');
    const command = state.options.codexCommand === 'codex' ? resolveValidatedBinaryPath('codex') : resolveGlmExecutable(state.options.codexCommand);
    state.reviewPasses++; state.stage = 'review'; save(state);
    const root = artifactsRoot(state); const prefix = join(root, `review-${state.reviewPasses}`);
    const resultFile = `${prefix}.result.json`; const schemaFile = `${prefix}.schema.json`;
    atomicWriteJson(schemaFile, { type: 'object', additionalProperties: false, required: ['findings'], properties: {
      findings: { type: 'array', maxItems: 50, items: { type: 'object', additionalProperties: false, required: ['severity', 'message', 'file', 'line'], properties: {
        severity: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] }, message: { type: 'string', maxLength: 2000 },
        file: { type: ['string', 'null'] }, line: { type: ['integer', 'null'] },
      } } },
    } });
    const result = await runWorkflowProcess({ command, args: ['exec', '--sandbox', 'read-only', '--ephemeral',
      ...(state.options.codexModel ? ['--model', state.options.codexModel] : []), '--output-schema', schemaFile, '--output-last-message', resultFile, '-'],
      cwd, stdin: JSON.stringify({ kind: 'review', baseCommit: state.plan.baseCommit, head, objective: state.plan.objective,
        tasks: state.tasks.filter(entry => entry.status === 'accepted').map(entry => ({ id: entry.task.id, contracts: entry.task.contracts, acceptanceCriteria: entry.task.acceptanceCriteria })),
        instructions: 'Independently inspect the integrated code against baseCommit and acceptance criteria. Read only: do not modify files, commits or refs. Do not inspect worker transcripts. Return the required JSON findings with P0/P1/P2/P3 severities.' }),
      timeoutMs: state.options.timeoutMs, artifactPrefix: prefix, provider: 'codex' });
    try {
      if (assertLeader(state) !== head || git(cwd, ['for-each-ref', '--format=%(refname) %(objectname)']) !== refs) throw new Error('changed');
    } catch { throw new Error('workflow_reviewer_modified_repository'); }
    if (!result.passed) throw new Error('workflow_review_process_failed');
    validateResolvedPath(resultFile, root);
    const raw = workerResultJson(resultFile);
    const findings = parseWorkflowFindings(JSON.parse(redactWorkflowText(JSON.stringify(raw))), state.reviewPasses);
    atomicWriteJson(resultFile, { findings });
    state.reviews.push({ pass: state.reviewPasses, head, findings, artifacts: [...result.artifacts, createArtifactDescriptorFromPath(resultFile, {
      kind: 'workflow-review', producer: { system: 'omc', component: 'team-workflow' }, retention: 'until-completion',
    })] });
    state.stage = 'adjudication';
  });
}
export async function adjudicateWorkflow(cwd: string, name: string, decisions: Array<{ findingId: string; disposition: 'fix' | 'dismiss'; reason: string }>): Promise<WorkflowState> {
  return mutate(cwd, name, async state => {
    const review = state.reviews.at(-1);
    if (!review || !Array.isArray(decisions) || decisions.length > 50) throw new Error('workflow_review_required');
    const seen = new Set<string>();
    const updates: Array<{ finding: WorkflowFinding; disposition: 'fix' | 'dismiss'; reason: string }> = [];
    for (const decision of decisions) {
      const finding = review.findings.find(finding => finding.id === decision.findingId);
      if (!finding || finding.disposition || seen.has(finding.id) || !['fix', 'dismiss'].includes(decision.disposition)) throw new Error('workflow_invalid_disposition');
      seen.add(finding.id);
      updates.push({ finding, disposition: decision.disposition, reason: redactWorkflowText(boundedText(decision.reason, 1000)) });
    }
    for (const update of updates) { update.finding.disposition = update.disposition; update.finding.reason = update.reason; }
    state.stage = updates.some(update => update.disposition === 'fix') ? 'remediation' : 'adjudication';
  });
}
export async function addWorkflowFix(cwd: string, name: string, rawTask: unknown, findingIds: string[]): Promise<WorkflowState> {
  return mutate(cwd, name, async state => {
    const head = assertLeader(state); const task = parseWorkflowTask(rawTask);
    if (redactWorkflowText(JSON.stringify(task)) !== JSON.stringify(task)) throw new Error('workflow_sensitive_input_rejected');
    if (state.tasks.some(entry => entry.task.id === task.id) || task.baseCommit !== head || !Array.isArray(findingIds) || !findingIds.length) throw new Error('workflow_invalid_fix');
    const findings = state.reviews.flatMap(review => review.findings);
    if (new Set(findingIds).size !== findingIds.length || findingIds.some(id => !findings.some(finding => finding.id === id && finding.disposition === 'fix' && !finding.fixedBy))
      || state.tasks.some(entry => entry.status !== 'rejected' && entry.findingIds?.some(id => findingIds.includes(id)))) throw new Error('workflow_fix_finding_not_actionable');
    // Fixes follow all integrated ownership so intentional overlap is serialized.
    task.dependencies = [...new Set([...task.dependencies, ...state.tasks.filter(entry => entry.status === 'accepted').map(entry => entry.task.id)])];
    parseWorkflowPlan({ ...state.plan, tasks: [...state.plan.tasks, task] });
    state.plan.tasks.push(task);
    state.tasks.push({ task, canonicalId: String(state.tasks.length + 1), status: 'pending', attempts: 0, worker: `task-${task.id}`, updatedAt: now(), findingIds });
    delete state.verification; state.stage = 'remediation';
  });
}
export async function finishWorkflow(cwd: string, name: string): Promise<WorkflowState> {
  return mutate(cwd, name, async state => {
    verificationGate(state);
    if (!state.reviews.length) throw new Error('workflow_review_required');
    const findings = state.reviews.flatMap(review => review.findings);
    if (findings.some(finding => !finding.disposition || finding.disposition === 'fix' && !finding.fixedBy)) throw new Error('workflow_unresolved_findings');
    state.stage = 'complete';
  });
}
export function workflowStatus(cwd: string, name: string): Record<string, unknown> {
  const state = readWorkflow(cwd, name);
  const result = { name, profile: state.profile, stage: state.stage, workers: state.options.workers, maxWorkers: state.options.maxWorkers,
    activeWorkers: state.tasks.filter(entry => entry.status === 'running').length, integrationBranch: state.plan.integrationBranch,
    failedTasks: state.tasks.filter(entry => entry.status === 'failed').length,
    verification: state.verification ? { head: state.verification.head, passed: state.verification.passed } : null,
    reviewPasses: state.reviewPasses, maxReviewPasses: state.options.maxReviewPasses,
    findings: (state.reviews.at(-1)?.findings ?? []).map(finding => ({ ...finding, message: finding.message.slice(0, 300), reason: finding.reason?.slice(0, 200) })),
    omittedTasks: 0, omittedFindings: 0, stateFile: statePath(cwd, name),
    tasks: state.tasks.map(entry => ({ id: entry.task.id, worker: entry.worker, provider: 'glm', model: state.options.glmModel,
      status: entry.status, attempts: entry.attempts, backoffUntil: entry.backoffUntil, worktree: entry.worktree, branch: entry.branch, updatedAt: entry.updatedAt,
      error: entry.error?.slice(0, 200), ...(entry.handoff ? { handoff: { taskId: entry.handoff.taskId, outcome: entry.handoff.outcome,
        commitSha: entry.handoff.commitSha, summary: entry.handoff.summary.slice(0, 200),
        changedFiles: entry.handoff.changedFiles.slice(0, 10), testsPassed: entry.handoff.tests.every(test => test.passed),
        tests: entry.handoff.tests.slice(0, 5).map(test => ({ command: test.command.slice(0, 160), args: test.args.slice(0, 5).map(arg => arg.slice(0, 160)), passed: test.passed })),
        interfaceChanges: entry.handoff.interfaceChanges.slice(0, 3).map(text => text.slice(0, 160)),
        assumptions: entry.handoff.assumptions.slice(0, 3).map(text => text.slice(0, 160)),
        risks: entry.handoff.risks.slice(0, 3).map(text => text.slice(0, 160)), preview: true,
        artifacts: entry.handoff.artifacts.filter(artifact => artifact.kind === 'workflow-result' || entry.status === 'failed').slice(0, 3)
          .map(artifact => ({ path: artifact.path, kind: artifact.kind })) } } : {}) })) };
  while (Buffer.byteLength(JSON.stringify(result)) > 16 * 1024 && result.tasks.length) {
    result.tasks.pop(); result.omittedTasks++;
  }
  while (Buffer.byteLength(JSON.stringify(result)) > 16 * 1024 && result.findings.length) {
    result.findings.pop(); result.omittedFindings++;
  }
  return result;
}

/** Explicit completed-workflow cleanup; rejected/failed and changed worktrees remain inspectable. */
export async function cleanupWorkflow(cwd: string, name: string): Promise<{ removed: string[]; preserved: Array<{ taskId: string; reason: string }> }> {
  assertLeadCaller();
  return withFileLock(`${statePath(cwd, name)}.lock`, async () => {
    const state = readWorkflow(cwd, name);
    if (state.stage !== 'complete') throw new Error('workflow_completion_required_for_cleanup');
    assertLeader(state);
    const result: { removed: string[]; preserved: Array<{ taskId: string; reason: string }> } = { removed: [], preserved: [] };
    for (const entry of state.tasks) {
      if (!entry.worktree || !existsSync(entry.worktree)) continue;
      if (entry.status !== 'accepted') { result.preserved.push({ taskId: entry.task.id, reason: 'unaccepted_work_preserved' }); continue; }
      try {
        validateCommit(state, entry);
        removeWorkerWorktree(name, entry.worker, cwd);
        if (existsSync(entry.worktree)) throw new Error('workflow_cleanup_unverified');
        result.removed.push(entry.task.id);
      } catch { result.preserved.push({ taskId: entry.task.id, reason: 'dirty_changed_or_unverified_worktree_preserved' }); }
    }
    atomicWriteJson(join(teamStateRoot(cwd, name), 'workflow-cleanup.json'), result);
    return result;
  }, { timeoutMs: 0 });
}
