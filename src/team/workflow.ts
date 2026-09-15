/** Opt-in Claude-led workflow. Every integration and finding disposition is an explicit lead action. */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, statSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, posix, win32 } from 'node:path';
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
import { createClaudeWorkflowResultDecoder, prepareWorkflowBinding, workflowWorkerArguments, workflowReviewerArguments, workflowReviewProvenance,
  type PreparedWorkflowBinding, type WorkflowRuntime } from './workflow-adapters.js';
import { buildWorkflowPrompt, workflowContextFingerprint, workflowPromptFingerprint, workflowSessionFingerprint } from './workflow-prompt.js';
import { boundedText, safeWorkflowId, parseWorkflowPlan, parseWorkflowTask, matchesScope,
  parseWorkflowHandoff, parseWorkflowFindings, parseWorkflowBinding, parseWorkflowState, validateWorkflowStateTransition,
  type WorkflowState as LegacyWorkflowState, type VersionedWorkflowState as WorkflowState, type WorkflowStateV2,
  parseWorkflowSubstitution, assertWorkflowResumeBinding, type WorkflowRole, type WorkflowRoleBinding, type WorkflowOptions, type WorkflowTaskState,
  type WorkflowFinding, type WorkflowInvocation, type WorkflowReviewAttempt, type WorkflowReviewAttemptV2 } from './workflow-contracts.js';

export type { WorkflowState, WorkflowOptions, WorkflowPlan, WorkflowTask, WorkflowHandoff, WorkflowFinding } from './workflow-contracts.js';

const now = () => new Date().toISOString();
const savedSnapshots = new WeakMap<WorkflowState, unknown>();
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
function workerResultJson(path: string, canonicalParent: string, environment?: NodeJS.ProcessEnv): unknown {
  const parent = dirname(path);
  if (lstatSync(parent).isSymbolicLink() || realpathSync(parent) !== canonicalParent) throw new Error('workflow_artifact_parent_changed');
  const info = lstatSync(path);
  if (info.isSymbolicLink()) throw new Error('workflow_result_symlink_rejected');
  if (!info.isFile() || info.nlink !== 1) throw new Error('workflow_result_not_regular_file');
  validateResolvedPath(path, canonicalParent);
  try {
    if (info.size > 64 * 1024) throw new Error('workflow_artifact_invalid_or_oversized');
    const parsed: unknown = JSON.parse(redactWorkflowText(readFileSync(path, 'utf8'), false, environment));
    atomicWriteJson(path, parsed);
    return parsed;
  } catch {
    // Result metadata is a bounded protocol, not a transcript archive. Invalid raw metadata must not retain secrets.
    atomicWriteJson(path, { error: 'workflow_invalid_result' });
    throw new Error('workflow_invalid_result');
  }
}
async function runWorkflowProvider(input: Parameters<typeof runWorkflowProcess>[0], resultFile: string, claudeStructuredResult = false) {
  // Capture before launch: an unsuccessful provider can still write or redirect its result path.
  const canonicalParent = realpathSync(dirname(resultFile));
  let result: Awaited<ReturnType<typeof runWorkflowProcess>> | undefined;
  let output: unknown;
  let outputError: unknown;
  const decoder = claudeStructuredResult ? createClaudeWorkflowResultDecoder() : undefined;
  try {
    result = await runWorkflowProcess({ ...input, ...(decoder ? { onStdout: decoder.write } : {}) });
    if (decoder) {
      try {
        const decoded = decoder.finish();
        if (realpathSync(dirname(resultFile)) !== canonicalParent || lstatSync(dirname(resultFile)).isSymbolicLink()) throw new Error('workflow_artifact_parent_changed');
        writeFileSync(resultFile, redactWorkflowText(JSON.stringify(decoded), false, input.redactionEnvironment ?? input.environment), { flag: 'wx', mode: 0o600 });
      } catch (error) { outputError = error; }
    }
  }
  finally {
    try { output = workerResultJson(resultFile, canonicalParent, input.redactionEnvironment ?? input.environment); }
    catch (error) { outputError ??= error; }
  }
  // Return parse failures so callers can retain process artifacts and preserve the original failure precedence.
  return { ...result, output, outputError };
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
  if (state.schemaVersion === 2) {
    const previous = savedSnapshots.get(state);
    if (previous) validateWorkflowStateTransition(previous, state);
    else parseWorkflowState(state);
  }
  atomicWriteJson(statePath(state.cwd, state.plan.name), state);
  if (state.schemaVersion === 2) savedSnapshots.set(state, JSON.parse(JSON.stringify(state)));
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
  let state = boundedJson(statePath(cwd, name), 16 * 1024 * 1024) as WorkflowState;
  if (state?.schemaVersion === 2) state = parseWorkflowState(state);
  if (!state || !((state.schemaVersion === 1 && state.profile === 'claude-glm-codex') || (state.schemaVersion === 2 && state.profile === 'role-substitution')) || state.plan?.name !== name
    || realpathSync(state.cwd) !== realpathSync(cwd)) throw new Error('workflow_invalid_state');
  if (!Array.isArray(state.tasks) || !Array.isArray(state.reviews)) throw new Error('workflow_invalid_state');
  if (state.options.mode !== undefined && !['v1', 'balanced'].includes(state.options.mode)) throw new Error('workflow_invalid_mode');
  parseWorkflowPlan(state.plan, new Set(state.tasks.filter(entry => entry.status === 'rejected').map(entry => entry.task.id)));
  return state;
}
async function mutate(cwd: string, name: string, action: (state: WorkflowState) => Promise<void>): Promise<WorkflowState> {
  assertLeadCaller();
  const path = statePath(cwd, name);
  return withFileLock(`${path}.lock`, async () => {
    const state = readWorkflow(cwd, name);
    if (state.schemaVersion === 2) savedSnapshots.set(state, JSON.parse(JSON.stringify(state)));
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
export async function initWorkflow(cwd: string, rawPlan: unknown, options: WorkflowOptions = {}): Promise<LegacyWorkflowState> {
  const state = await initializeWorkflow(cwd, rawPlan, options);
  if (state.schemaVersion !== 1) throw new Error('workflow_invalid_state');
  return state;
}
export async function initWorkflowV2(cwd: string, rawPlan: unknown, bindings: Record<WorkflowRole, unknown>, options: WorkflowOptions = {}): Promise<WorkflowStateV2> {
  if (options.mode !== undefined && options.mode !== 'balanced') throw new Error('workflow_balanced_mode_required');
  const selected = Object.freeze({ lead: parseWorkflowBinding(bindings.lead), implementer: parseWorkflowBinding(bindings.implementer), reviewer: parseWorkflowBinding(bindings.reviewer) });
  for (const role of ['lead', 'implementer', 'reviewer'] as const) if (selected[role].role !== role) throw new Error('workflow_binding_role_mismatch');
  const state = await initializeWorkflow(cwd, rawPlan, { ...options, mode: 'balanced' }, selected);
  if (state.schemaVersion !== 2) throw new Error('workflow_invalid_state');
  return state;
}
async function initializeWorkflow(cwd: string, rawPlan: unknown, options: WorkflowOptions, bindings?: Readonly<Record<WorkflowRole, WorkflowRoleBinding>>): Promise<WorkflowState> {
  assertLeadCaller();
  if (redactWorkflowText(JSON.stringify({ rawPlan, options })) !== JSON.stringify({ rawPlan, options })) throw new Error('workflow_sensitive_input_rejected');
  cwd = realpathSync(cwd);
  const plan = parseWorkflowPlan(rawPlan);
  if (options.mode !== undefined && !['v1', 'balanced'].includes(options.mode)) throw new Error('workflow_invalid_mode');
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
  if (!bindings && (executor.provider !== 'glm' || reviewer.provider !== 'codex')) throw new Error('workflow_role_routing_requires_glm_executor_and_codex_reviewer');
  const config = getGlmConfig(routing);
  const maxWorkers = count(options.maxWorkers, config.maxWorkers, ABSOLUTE_MAX_WORKERS);
  const resolvedOptions: WorkflowState['options'] = {
    ...(options.mode === undefined ? {} : { mode: options.mode }),
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
  const legacy: LegacyWorkflowState = {
    schemaVersion: 1, profile: 'claude-glm-codex', plan, cwd, integrationHead: plan.baseCommit, options: resolvedOptions, stage: 'implementation',
    tasks: plan.tasks.map((task, index) => ({ task, canonicalId: String(index + 1), status: 'pending', attempts: 0,
      worker: `task-${task.id}`, updatedAt: now() })), reviewPasses: 0, reviews: [], createdAt: now(), updatedAt: now(),
  };
  const state: WorkflowState = bindings ? { ...legacy, schemaVersion: 2, profile: 'role-substitution', bindings, substitutions: [],
    tasks: plan.tasks.map((task, index) => ({ task, canonicalId: String(index + 1), status: 'pending', attempts: 0,
      worker: `task-${task.id}`, updatedAt: now() })), reviewAttempts: [] } : legacy;
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
function prepareBinding(state: WorkflowStateV2, binding: WorkflowRoleBinding, runtime?: WorkflowRuntime): PreparedWorkflowBinding {
  try { return prepareWorkflowBinding(binding, runtime); }
  catch (error) {
    const message = error instanceof Error && /^workflow_[a-z_]+$/.test(error.message) ? error.message : 'workflow_preflight_failed';
    const path = join(artifactsRoot(state), `preflight-${randomUUID()}.json`);
    writeFileSync(path, JSON.stringify({ kind: 'preflight', bindingId: binding.id, provider: binding.providerRoute, error: message, at: now(), reserved: false }), { flag: 'wx', mode: 0o600 });
    throw new Error(message);
  }
}
export async function substituteWorkflowBinding(cwd: string, name: string, input: {
  role: WorkflowRole; binding: unknown; expectedHead: string; reason: string; authorityRef: string; taskId?: string;
}): Promise<WorkflowState> {
  return mutate(cwd, name, async state => {
    if (state.schemaVersion !== 2) throw new Error('workflow_role_substitution_profile_required');
    if (assertLeader(state) !== input.expectedHead) throw new Error('workflow_substitution_head_mismatch');
    if (state.tasks.some(entry => entry.status === 'running')) throw new Error('workflow_interrupted_worker_requires_inspection');
    const binding = parseWorkflowBinding(input.binding);
    const task = input.taskId === undefined ? undefined : getTask(state, input.taskId);
    if (task && !['pending', 'failed'].includes(task.status)) throw new Error('workflow_substitution_task_not_pending');
    const record = parseWorkflowSubstitution({ sequence: state.substitutions.length + 1, role: input.role,
      from: state.bindings[input.role], to: binding, reason: redactWorkflowText(boundedText(input.reason, 1000)),
      authorityRef: redactWorkflowText(boundedText(input.authorityRef, 1000)), head: state.integrationHead, at: now(),
      ...(task ? { taskId: task.task.id, afterAttempt: task.attempts } : {}),
      ...(input.role === 'reviewer' ? { afterReviewPass: state.reviewPasses } : {}) });
    state.substitutions = Object.freeze([...state.substitutions, record]);
    state.bindings = Object.freeze({ ...state.bindings, [input.role]: binding });
  });
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
function sessionFingerprint(state: WorkflowState, entry: WorkflowTaskState, command: string, worktree: string): string {
  const executable = realpathSync(command);
  const info = statSync(executable);
  const environment = Object.entries(process.env).filter(([key]) => /^(?:ANTHROPIC_|CLAUDE_|CLAUDE_CONFIG_DIR$|OMC_GLM_|OMC_EXTERNAL_MODELS_DEFAULT_GLM_MODEL$)/.test(key)
    && !['CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID'].includes(key)).sort(([a], [b]) => a.localeCompare(b));
  // Keep secrets out of state; bind their launch configuration together in one opaque digest.
  const launchIdentity = { executable, size: info.size, modified: info.mtimeMs, environment,
    ...(/\.(?:c?js|mjs|sh)$/i.test(executable) && info.size <= 1024 * 1024 ? { script: workflowPromptFingerprint(readFileSync(executable, 'utf8')) } : {}) };
  return workflowPromptFingerprint(JSON.stringify({ launch: launchIdentity,
    context: workflowSessionFingerprint(state, entry, executable, worktree) }));
}
async function executeTask(state: WorkflowState, entry: WorkflowTaskState, command: string, resumeReason?: string, prepared?: PreparedWorkflowBinding): Promise<void> {
  const root = artifactsRoot(state);
  const balanced = state.options.mode === 'balanced';
  const resuming = resumeReason !== undefined;
  if (entry.attempts === 0 && entry.task.dependencies.length) {
    entry.task.baseCommit = state.integrationHead;
  }
  while (entry.attempts < state.options.maxAttempts) {
    const started = Date.now();
    entry.attempts++; entry.status = 'running'; entry.claimToken = randomUUID(); entry.updatedAt = now();
    const invocation: WorkflowInvocation | undefined = balanced ? { attempt: entry.attempts, mode: resuming ? 'resume' : 'fresh',
      ...(prepared ? { invocationId: randomUUID(), binding: prepared.binding, model: prepared.binding.model }
        : state.options.glmModel ? { model: state.options.glmModel } : {}), startedAt: now(), outcome: 'failed',
      error: 'workflow_invocation_incomplete', ...(resumeReason === undefined ? {} : { reason: resumeReason }), artifacts: [],
      telemetry: { provider: prepared?.binding.providerRoute ?? 'glm', durationMs: 0, status: 'unknown', scope: 'unknown' } } : undefined;
    if (invocation) (entry.invocations ??= []).push(invocation);
    save(state);
    try {
      const worktree = ensureWorkerWorktree(state.plan.name, entry.worker, state.cwd, { mode: 'named', baseRef: entry.task.baseCommit });
      if (!worktree) throw new Error('workflow_worktree_required');
      entry.worktree = worktree.path; entry.branch = worktree.branch;
      assertWorker(state, entry);
      if (git(entry.worktree, ['rev-parse', 'HEAD']) !== entry.task.baseCommit) throw new Error('workflow_worker_base_mismatch');
      const prefix = join(root, `${entry.worker}-${entry.attempts}`);
      const resultFile = `${prefix}.result.json`;
      if (existsSync(resultFile)) throw new Error('workflow_result_already_exists');
      const prompt = buildWorkflowPrompt(state, entry, resultFile);
      const sessionEnabled = balanced && (!prepared || prepared.binding.capabilities.includes('session-resume'));
      if (sessionEnabled) {
        const worktree = realpathSync(entry.worktree);
        const fingerprint = prepared ? workflowPromptFingerprint(JSON.stringify({ binding: prepared.binding, worktree, branch: entry.branch,
          context: workflowSessionFingerprint(state, entry, command, worktree) })) : sessionFingerprint(state, entry, command, worktree);
        if (resuming && (!entry.session?.confirmed || entry.session.fingerprint !== fingerprint)) throw new Error('workflow_session_identity_changed');
        entry.session = { id: resuming ? entry.session!.id : randomUUID(), confirmed: false, fingerprint,
          worktree, branch: entry.branch!, ...(prepared ? { binding: prepared.binding } : {}) };
        invocation!.promptFingerprint = workflowPromptFingerprint(prompt);
        invocation!.contextFingerprint = workflowContextFingerprint(state);
        save(state);
      }
      const result = await runWorkflowProvider({ command, args: prepared ? workflowWorkerArguments(prepared,
        sessionEnabled ? { id: entry.session!.id, resume: resuming } : undefined) : [...buildLaunchArgs('glm', {
        teamName: state.plan.name, workerName: entry.worker, cwd: entry.worktree, model: state.options.glmModel,
      }), '-p', ...(balanced ? [resuming ? '--resume' : '--session-id', entry.session!.id, '--output-format', 'stream-json', '--verbose'] : [])],
      cwd: entry.worktree, stdin: prompt, ...(balanced ? { collectUsage: true } : {}),
      timeoutMs: state.options.timeoutMs, artifactPrefix: prefix, provider: prepared?.binding.providerRoute ?? 'glm', worker: entry.worker,
      ...(prepared ? { environment: prepared.environment, redactionEnvironment: prepared.redactionEnvironment } : {}) }, resultFile);
      if (invocation) {
        invocation.telemetry = result.telemetry ?? { provider: prepared?.binding.providerRoute ?? 'glm', durationMs: Date.now() - started, status: 'unknown', scope: 'unknown' };
        invocation.artifacts = result.artifacts;
      }
      entry.handoff = { taskId: entry.task.id, outcome: 'failed', changedFiles: [], tests: [], interfaceChanges: [], assumptions: [], risks: [], summary: result.error ?? 'Worker result pending validation', artifacts: result.artifacts };
      if (sessionEnabled) {
        if (result.telemetry?.sessionId && result.telemetry.sessionId !== entry.session!.id
          || result.telemetry?.diagnostics?.some(diagnostic => ['session_identity_conflict', 'session_identity_invalid'].includes(diagnostic))) {
          throw new Error('workflow_session_identity_mismatch');
        }
        entry.session!.confirmed = result.telemetry?.sessionId === entry.session!.id;
      }
      if (!result.passed) throw new Error(`workflow_${result.error}`);
      if (result.outputError) throw result.outputError;
      validateResolvedPath(resultFile, root);
      const handoff = parseWorkflowHandoff(result.output, entry.task.id);
      // Provider result is untrusted text: never persist credentials returned in a handoff.
      const safeHandoff = parseWorkflowHandoff(JSON.parse(redactWorkflowText(JSON.stringify(handoff))), entry.task.id);
      atomicWriteJson(resultFile, safeHandoff);
      entry.handoff = { ...safeHandoff, artifacts: [...result.artifacts, createArtifactDescriptorFromPath(resultFile, {
        kind: 'workflow-result', producer: { system: 'omc', component: 'team-workflow', worker: entry.worker }, retention: 'until-completion',
      })] };
      if (invocation) invocation.artifacts = entry.handoff.artifacts.slice(0, 3);
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
      if (state.schemaVersion === 2) break;
      if (resuming || entry.error === 'workflow_session_identity_mismatch') break;
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
    } finally {
      if (invocation && state.schemaVersion === 1) {
        invocation.outcome = entry.status === 'completed' ? 'completed' : 'failed';
        if (entry.error) invocation.error = entry.error; else delete invocation.error;
        if (!invocation.telemetry.durationMs) invocation.telemetry.durationMs = Date.now() - started;
      }
      delete entry.claimToken; delete entry.backoffUntil; entry.updatedAt = now(); save(state);
    }
  }
}
function protectedWorkflowRefs(cwd: string, name: string): string {
  return git(cwd, ['for-each-ref', '--format=%(refname) %(objectname)']).split('\n')
    .filter(ref => !ref.startsWith(`refs/heads/omc-team/${name}/`)).join('\n');
}
function failProtectedRefs(entries: WorkflowTaskState[], balanced: boolean, onlyIncomplete = false): void {
  for (const entry of entries) if (balanced || entry.status === 'completed') {
    entry.status = 'failed'; entry.error = 'workflow_worker_modified_protected_refs';
    if (entry.session) entry.session.confirmed = false;
    const invocation = entry.invocations?.at(-1);
    if (invocation && (!onlyIncomplete || invocation.error === 'workflow_invocation_incomplete')) { invocation.outcome = 'failed'; invocation.error = entry.error; }
  }
}
function settleVersionedInvocations(state: WorkflowState, entries: WorkflowTaskState[]): void {
  if (state.schemaVersion !== 2) return;
  for (const entry of entries) {
    const invocation = entry.invocations?.at(-1);
    if (invocation?.error !== 'workflow_invocation_incomplete') continue;
    invocation.outcome = entry.status === 'completed' ? 'completed' : 'failed';
    if (entry.error) invocation.error = entry.error; else delete invocation.error;
  }
}
export async function runWorkflow(cwd: string, name: string, runtime?: WorkflowRuntime): Promise<WorkflowState> {
  return mutate(cwd, name, async state => {
    assertLeader(state);
    const refsBefore = protectedWorkflowRefs(cwd, name);
    // A killed owner is never silently re-spawned: retained running work requires inspection.
    if (state.tasks.some(entry => entry.status === 'running')) throw new Error('workflow_interrupted_worker_requires_inspection');
    const candidates = state.tasks.filter(entry => ['pending', 'failed'].includes(entry.status) && entry.attempts < state.options.maxAttempts
      && !['workflow_timeout', 'workflow_interrupted', 'workflow_worker_modified_protected_refs', 'workflow_session_identity_mismatch'].includes(entry.error ?? '')
      && !(state.options.mode === 'balanced' && entry.invocations?.at(-1)?.mode === 'resume' && entry.invocations.at(-1)?.outcome === 'failed')
      && entry.task.dependencies.every(id => getTask(state, id).status === 'accepted'));
    if (!candidates.length) {
      if (state.schemaVersion === 2 && state.tasks.some(entry => entry.status === 'failed' && entry.attempts >= state.options.maxAttempts)) throw new Error('workflow_attempt_limit_reached');
      return;
    }
    let command = '';
    if (state.schemaVersion === 1) {
      try { command = resolveGlmExecutable(state.options.glmCommand); } catch { throw new Error('workflow_glm_unavailable_fallback_disabled'); }
    }
    let cursor = 0;
    const pools = await Promise.allSettled(Array.from({ length: Math.min(state.options.workers, candidates.length) }, async () => {
      while (cursor < candidates.length && !state.tasks.some(entry => entry.error === 'workflow_interrupted')) {
        const entry = candidates[cursor++]!;
        const prepared = state.schemaVersion === 2 ? prepareBinding(state, state.bindings.implementer, runtime) : undefined;
        await executeTask(state, entry, prepared?.command ?? command, undefined, prepared);
      }
    }));
    if (state.schemaVersion === 1 && pools.some(pool => pool.status === 'rejected')) throw new Error('workflow_worker_persistence_failed');
    try {
      if (protectedWorkflowRefs(cwd, name) !== refsBefore) {
        failProtectedRefs(candidates, state.options.mode === 'balanced', state.schemaVersion === 2);
        throw new Error('workflow_worker_modified_protected_refs');
      }
      const rejected = pools.find(pool => pool.status === 'rejected');
      if (rejected?.status === 'rejected') {
        if (state.schemaVersion === 2) throw rejected.reason;
        throw new Error('workflow_worker_persistence_failed');
      }
    } finally {
      settleVersionedInvocations(state, candidates);
    }
    state.stage = state.tasks.some(entry => entry.status === 'completed') ? 'integration' : 'implementation';
  });
}
/** Explicit continuation of a verified conversation in the same pristine task worktree. */
export async function resumeWorkflowTask(cwd: string, name: string, taskId: string, expectedHead: string, reason: string, runtime?: WorkflowRuntime): Promise<WorkflowState> {
  return mutate(cwd, name, async state => {
    if (state.options.mode !== 'balanced') throw new Error('workflow_balanced_mode_required');
    if (assertLeader(state) !== expectedHead) throw new Error('workflow_resume_head_mismatch');
    if (state.tasks.some(entry => entry.status === 'running')) throw new Error('workflow_interrupted_worker_requires_inspection');
    const safeReason = redactWorkflowText(boundedText(reason, 1000));
    const entry = getTask(state, taskId);
    if (entry.status !== 'failed') throw new Error('workflow_resume_failed_task_required');
    if (entry.attempts >= state.options.maxAttempts) throw new Error('workflow_attempt_limit_reached');
    if (state.schemaVersion === 1 && !state.options.glmModel) throw new Error('workflow_resume_model_required');
    if (!entry.task.dependencies.every(id => getTask(state, id).status === 'accepted')) throw new Error('workflow_dependency_not_integrated');
    if (['workflow_worker_modified_protected_refs', 'workflow_session_identity_mismatch'].includes(entry.error ?? '')) throw new Error('workflow_session_not_resumable');
    const session = entry.session;
    if (!session?.confirmed || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(session.id)) throw new Error('workflow_session_not_confirmed');
    const worktree = realpathSync(assertWorker(state, entry));
    if (session.worktree !== worktree || session.branch !== entry.branch) throw new Error('workflow_session_identity_changed');
    if (git(worktree, ['rev-parse', 'HEAD']) !== entry.task.baseCommit) throw new Error('workflow_worker_base_mismatch');
    const prepared = state.schemaVersion === 2 ? prepareBinding(state, state.bindings.implementer, runtime) : undefined;
    let command: string;
    if (prepared) {
      if (!('binding' in session)) throw new Error('workflow_session_not_confirmed');
      assertWorkflowResumeBinding(session.binding, prepared.binding);
      command = prepared.command;
    } else {
      try { command = resolveGlmExecutable(state.options.glmCommand); } catch { throw new Error('workflow_glm_unavailable_fallback_disabled'); }
    }
    const fingerprint = prepared ? workflowPromptFingerprint(JSON.stringify({ binding: prepared.binding, worktree, branch: entry.branch,
      context: workflowSessionFingerprint(state, entry, command, worktree) })) : sessionFingerprint(state, entry, command, worktree);
    if (session.fingerprint !== fingerprint) throw new Error('workflow_session_identity_changed');
    const refs = protectedWorkflowRefs(cwd, name);
    let executionFailure: { error: unknown } | undefined;
    try { await executeTask(state, entry, command, safeReason, prepared); }
    catch (error) { executionFailure = { error }; }
    try {
      if (protectedWorkflowRefs(cwd, name) !== refs) {
        failProtectedRefs([entry], true, state.schemaVersion === 2);
        throw new Error('workflow_worker_modified_protected_refs');
      }
    } finally { settleVersionedInvocations(state, [entry]); }
    if (executionFailure) throw executionFailure.error;
    state.stage = getTask(state, taskId).status === 'completed' ? 'integration' : 'implementation';
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
/** Review locations are metadata; retain raw artifacts and validate the relative copy with the normal scope guard. */
export function parseWorkflowReviewFindings(value: unknown, pass: number, cwd: string): WorkflowFinding[] {
  const paths = /^[a-z]:[\\/]/i.test(cwd) ? win32 : posix;
  const inside = (root: string, candidate: string): boolean => {
    const relative = paths.relative(root, candidate);
    return !paths.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${paths.sep}`);
  };
  const relativeFile = (file: string): string => {
    // POSIX backslashes name literal characters, not separators; converting them could change the referent.
    if (paths === posix && file.includes('\\')) return file;
    const slash = file.replaceAll('\\', '/');
    const absolute = paths === win32 ? /^[a-z]:\//i.test(slash) : slash.startsWith('/');
    // Do not erase traversal, empty segments or ambiguous UNC/device roots during normalization.
    if (!absolute || slash.startsWith('//') || (paths === win32 ? slash.slice(3) : slash.slice(1))
      .split('/').some(part => !part || part === '.' || part === '..')) return file;
    if (!inside(cwd, file) || !paths.relative(cwd, file)) return file;
    try {
      const canonicalRoot = realpathSync(cwd);
      let ancestor = file;
      for (;;) {
        try {
          if (!inside(canonicalRoot, realpathSync(ancestor))) return file;
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return file;
          // A dangling link must not be mistaken for an ordinary missing/deleted file.
          try { if (lstatSync(ancestor).isSymbolicLink()) return file; }
          catch (missing) { if ((missing as NodeJS.ErrnoException).code !== 'ENOENT') return file; }
          const parent = paths.dirname(ancestor);
          if (parent === ancestor) return file;
          ancestor = parent;
        }
      }
    } catch { return file; }
    return paths.relative(cwd, file).replaceAll('\\', '/');
  };
  if (!value || typeof value !== 'object' || !('findings' in value) || !Array.isArray(value.findings)) {
    return parseWorkflowFindings(value, pass);
  }
  return parseWorkflowFindings({ ...value, findings: value.findings.map(finding =>
    finding && typeof finding === 'object' && typeof finding.file === 'string'
      ? { ...finding, file: relativeFile(finding.file) } : finding) }, pass);
}
function reviewContext(state: WorkflowStateV2): { projectInstructions: Array<{ path: string; content: string }>; sourceInventory: string; changes: string } {
  const affected = [...git(state.cwd, ['diff', '--name-only', '-z', state.plan.baseCommit, state.integrationHead]).split('\0').filter(Boolean),
    ...state.tasks.flatMap(entry => [...entry.task.writeScope, ...entry.task.readScope])];
  const paths = new Set(['AGENTS.md', 'CLAUDE.md']);
  for (const path of affected) {
    let scope = path;
    while (scope !== '.') {
      paths.add(posix.join(scope, 'AGENTS.md')); paths.add(posix.join(scope, 'CLAUDE.md'));
      scope = posix.dirname(scope);
    }
  }
  const projectInstructions = [...paths].filter(path => existsSync(join(state.cwd, path))).sort().map(path => {
    const file = join(state.cwd, path); validateResolvedPath(file, state.cwd);
    if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink() || statSync(file).size > 64 * 1024) throw new Error('workflow_review_context_invalid');
    return { path, content: readFileSync(file, 'utf8') };
  });
  const context = { projectInstructions, sourceInventory: git(state.cwd, ['ls-files']),
    changes: git(state.cwd, ['diff', '--no-ext-diff', '--no-textconv', '--patch', '--binary', state.plan.baseCommit, state.integrationHead]) };
  if (Buffer.byteLength(JSON.stringify(context)) > 256 * 1024) throw new Error('workflow_review_context_too_large');
  return context;
}
export async function reviewWorkflow(cwd: string, name: string, runtime?: WorkflowRuntime): Promise<WorkflowState> {
  return mutate(cwd, name, async state => {
    const head = verificationGate(state);
    const refs = git(cwd, ['for-each-ref', '--format=%(refname) %(objectname)']);
    if (state.reviewPasses >= state.options.maxReviewPasses) throw new Error('workflow_review_limit_reached');
    if (state.reviews.some(review => review.findings.some(finding => !finding.disposition || finding.disposition === 'fix' && !finding.fixedBy))) throw new Error('workflow_findings_require_adjudication_or_fix');
    const prepared = state.schemaVersion === 2 ? prepareBinding(state, state.bindings.reviewer, runtime) : undefined;
    const context = state.schemaVersion === 2 ? reviewContext(state) : undefined;
    const provenance = prepared && runtime ? workflowReviewProvenance(prepared, head, runtime) : undefined;
    const command = prepared?.command ?? (state.options.codexCommand === 'codex' ? resolveValidatedBinaryPath('codex') : resolveGlmExecutable(state.options.codexCommand));
    const balanced = state.options.mode === 'balanced';
    const started = Date.now();
    state.reviewPasses++; state.stage = 'review';
    const reservation: WorkflowReviewAttempt = { pass: state.reviewPasses, head,
      ...(prepared ? { model: prepared.binding.model } : state.options.codexModel ? { model: state.options.codexModel } : {}), startedAt: now(), outcome: 'failed',
      error: 'workflow_invocation_incomplete', artifacts: [], telemetry: { provider: prepared?.binding.providerRoute ?? 'codex', durationMs: 0, status: 'unknown', scope: 'unknown' } };
    let attempt: WorkflowReviewAttempt | undefined;
    if (state.schemaVersion === 2 && prepared && provenance) {
      const bound: WorkflowReviewAttemptV2 = { ...reservation, invocationId: randomUUID(), binding: prepared.binding, provenance };
      (state.reviewAttempts ??= []).push(bound); attempt = bound;
    } else if (state.schemaVersion === 1 && balanced) { (state.reviewAttempts ??= []).push(reservation); attempt = reservation; }
    save(state);
    try {
      const root = artifactsRoot(state); const prefix = join(root, `review-${state.reviewPasses}`);
      const resultFile = `${prefix}.result.json`; const schemaFile = `${prefix}.schema.json`;
      atomicWriteJson(schemaFile, { type: 'object', additionalProperties: false, required: ['findings'], properties: {
        findings: { type: 'array', maxItems: 50, items: { type: 'object', additionalProperties: false, required: ['severity', 'message', 'file', 'line'], properties: {
          severity: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] }, message: { type: 'string', maxLength: 2000 },
          file: { type: ['string', 'null'], minLength: 1, maxLength: 400,
            // Provider regex subsets reject lookarounds; scopePath enforces traversal and reserved scopes locally.
            pattern: '^[^\\\\/:*?\\[\\]{}\\r\\n]+(/[^\\\\/:*?\\[\\]{}\\r\\n]+)*$' },
          line: { type: ['integer', 'null'] },
        } } },
      } });
      const request = JSON.stringify({ kind: 'review', baseCommit: state.plan.baseCommit, head, objective: state.plan.objective,
        tasks: state.tasks.filter(entry => entry.status === 'accepted').map(entry => ({ id: entry.task.id, contracts: entry.task.contracts, acceptanceCriteria: entry.task.acceptanceCriteria })),
        ...(context ? { ...context, sharedContext: state.plan.sharedContext ?? '' } : {}),
        instructions: state.schemaVersion === 2
          ? 'Inspect the integrated code against baseCommit and complete acceptance criteria in this fresh read-only context. Self-review is permitted; do not claim independence from model or provider identity. Do not modify files, commits or refs or use command tools. Do not inspect worker transcripts. Return JSON findings with P0/P1/P2/P3 severities; finding.file must be a repository-relative POSIX path or null, for example src/example.ts. Do not return absolute paths or traversal segments.'
          : 'Independently inspect the integrated code against baseCommit and acceptance criteria. Read only: do not modify files, commits or refs. Do not inspect worker transcripts. Return the required JSON findings with P0/P1/P2/P3 severities. Each finding.file must be a repository-relative POSIX path or null, for example src/example.ts; do not return absolute paths or traversal segments.' });
      if (prepared && Buffer.byteLength(request) > 384 * 1024) throw new Error('workflow_review_context_too_large');
      const result = await runWorkflowProvider({ command, args: prepared ? workflowReviewerArguments(prepared, schemaFile, resultFile, boundedJson(schemaFile))
        : ['exec', '--sandbox', 'read-only', '--ephemeral', ...(balanced ? ['--json'] : []),
        ...(state.options.codexModel ? ['--model', state.options.codexModel] : []), '--output-schema', schemaFile, '--output-last-message', resultFile, '-'],
        cwd, stdin: request, ...(prepared ? { environment: prepared.environment, redactionEnvironment: prepared.redactionEnvironment } : {}),
        timeoutMs: state.options.timeoutMs, artifactPrefix: prefix, provider: prepared?.binding.providerRoute ?? 'codex', ...(balanced ? { collectUsage: true } : {}) }, resultFile, prepared?.binding.providerRoute === 'claude');
      if (attempt) {
        attempt.telemetry = result.telemetry ?? { provider: prepared?.binding.providerRoute ?? 'codex', durationMs: Date.now() - started, status: 'unknown', scope: 'unknown' };
        attempt.artifacts = result.artifacts;
      }
      try {
        if (assertLeader(state) !== head || git(cwd, ['for-each-ref', '--format=%(refname) %(objectname)']) !== refs) throw new Error('changed');
      } catch { throw new Error('workflow_reviewer_modified_repository'); }
      if (!result.passed) throw new Error('workflow_review_process_failed');
      if (result.outputError) throw result.outputError;
      validateResolvedPath(resultFile, root);
      const raw = result.output;
      const findings = parseWorkflowReviewFindings(JSON.parse(redactWorkflowText(JSON.stringify(raw))), state.reviewPasses, cwd);
      state.reviews.push({ pass: state.reviewPasses, head, findings, artifacts: [...result.artifacts, createArtifactDescriptorFromPath(resultFile, {
        kind: 'workflow-review', producer: { system: 'omc', component: 'team-workflow' }, retention: 'until-completion',
      })] });
      state.stage = 'adjudication';
      if (attempt) { attempt.outcome = 'completed'; delete attempt.error; attempt.artifacts = state.reviews.at(-1)!.artifacts; }
    } catch (error) {
      if (attempt) {
        const message = error instanceof Error ? error.message : '';
        attempt.error = /^workflow_[a-z_]+$/.test(message) ? message : 'workflow_review_failed';
      }
      throw error;
    } finally {
      if (attempt && !attempt.telemetry.durationMs) attempt.telemetry.durationMs = Date.now() - started;
    }
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
    parseWorkflowPlan({ ...state.plan, tasks: [...state.plan.tasks, task] }, new Set(state.tasks.filter(entry => entry.status === 'rejected').map(entry => entry.task.id)));
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
  const versioned = state.schemaVersion === 2 ? state : undefined;
  const result = { name, profile: state.profile, mode: state.options.mode ?? 'v1', stage: state.stage, workers: state.options.workers, maxWorkers: state.options.maxWorkers,
    ...(versioned ? { schemaVersion: 2, bindings: versioned.bindings,
      substitutionCount: versioned.substitutions.length, omittedSubstitutions: Math.max(0, versioned.substitutions.length - 3),
      substitutions: versioned.substitutions.slice(-3).map(record => ({ sequence: record.sequence, role: record.role, from: record.from.id, to: record.to.id,
        reason: record.reason.slice(0, 200), authorityRef: record.authorityRef.slice(0, 200), head: record.head, at: record.at, taskId: record.taskId })),
      reviewRelations: (versioned.reviewAttempts ?? []).slice(-3).map(attempt => ({ pass: attempt.pass, provider: attempt.binding.providerRoute,
        bindingId: attempt.binding.id, outcome: attempt.outcome, relation: attempt.provenance.relation, context: attempt.provenance.context })) } : {}),
    activeWorkers: state.tasks.filter(entry => entry.status === 'running').length, integrationBranch: state.plan.integrationBranch,
    failedTasks: state.tasks.filter(entry => entry.status === 'failed').length,
    verification: state.verification ? { head: state.verification.head, passed: state.verification.passed } : null,
    reviewPasses: state.reviewPasses, maxReviewPasses: state.options.maxReviewPasses,
    findings: (state.reviews.at(-1)?.findings ?? []).map(finding => ({ ...finding, message: finding.message.slice(0, 300), reason: finding.reason?.slice(0, 200) })),
    omittedTasks: 0, omittedFindings: 0, stateFile: statePath(cwd, name),
    tasks: state.tasks.map(entry => {
      const actual = versioned?.tasks.find(task => task.task.id === entry.task.id)?.invocations?.at(-1)?.binding;
      return { id: entry.task.id, worker: entry.worker, provider: versioned ? actual?.providerRoute ?? null : 'glm', model: versioned ? actual?.model ?? null : state.options.glmModel,
      ...(versioned ? { bindingId: actual?.id ?? null, selectedBinding: { id: versioned.bindings.implementer.id,
        provider: versioned.bindings.implementer.providerRoute, model: versioned.bindings.implementer.model } } : {}),
      status: entry.status, attempts: entry.attempts, backoffUntil: entry.backoffUntil, worktree: entry.worktree, branch: entry.branch, updatedAt: entry.updatedAt,
      ...(entry.session ? { session: { confirmed: entry.session.confirmed,
        resumeCandidate: entry.status === 'failed' && entry.session.confirmed && (versioned
          ? 'binding' in entry.session && JSON.stringify(entry.session.binding) === JSON.stringify(versioned.bindings.implementer)
          : Boolean(state.options.glmModel))
          && entry.attempts < state.options.maxAttempts && !['workflow_worker_modified_protected_refs', 'workflow_session_identity_mismatch'].includes(entry.error ?? ''),
        requiresExplicitResumeAndWorktreeChecks: true } } : {}),
      error: entry.error?.slice(0, 200), ...(entry.handoff ? { handoff: { taskId: entry.handoff.taskId, outcome: entry.handoff.outcome,
        commitSha: entry.handoff.commitSha, summary: entry.handoff.summary.slice(0, 200),
        changedFiles: entry.handoff.changedFiles.slice(0, 10), testsPassed: entry.handoff.tests.every(test => test.passed),
        tests: entry.handoff.tests.slice(0, 5).map(test => ({ command: test.command.slice(0, 160), args: test.args.slice(0, 5).map(arg => arg.slice(0, 160)), passed: test.passed })),
        interfaceChanges: entry.handoff.interfaceChanges.slice(0, 3).map(text => text.slice(0, 160)),
        assumptions: entry.handoff.assumptions.slice(0, 3).map(text => text.slice(0, 160)),
        risks: entry.handoff.risks.slice(0, 3).map(text => text.slice(0, 160)), preview: true,
        artifacts: entry.handoff.artifacts.filter(artifact => artifact.kind === 'workflow-result' || entry.status === 'failed').slice(0, 3)
          .map(artifact => ({ path: artifact.path, kind: artifact.kind })) } } : {}) }; }) };
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
