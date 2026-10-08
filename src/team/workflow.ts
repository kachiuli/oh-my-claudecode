/** Opt-in Claude-led workflow. Every integration and finding disposition is an explicit lead action. */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, statSync, lstatSync, mkdtempSync, readdirSync, realpathSync, rmSync, unlinkSync } from 'node:fs';
import { basename, dirname, join, resolve, posix, win32 } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { withFileLock } from '../lib/file-lock.js';
import { expandPathForCompare } from '../lib/worktree-paths.js';
import { loadConfig } from '../config/loader.js';
import { createArtifactDescriptorFromPath, writeTextArtifact, type ArtifactDescriptor } from '../shared/artifact-descriptor.js';
import { withOrchestratorOperation, type ActiveOrchestratorSnapshot, type OrchestratorHost } from '../orchestration/selection.js';
import { TeamPaths, absPath, teamStateRoot } from './state-paths.js';
import { atomicWriteJson, ensureDirWithMode, validateResolvedPath } from './fs-utils.js';
import { ensureWorkerWorktree, getBranchName, getWorktreePath, removeWorkerWorktree } from './git-worktree.js';
import { applyGlmProfile, getGlmConfig, getMimoConfig, resolveGlmExecutable, resolveMimoExecutable } from './glm-config.js';
import { ABSOLUTE_MAX_WORKERS } from './types.js';
import { resolveRoleAssignment } from './stage-router.js';
import { buildLaunchArgs, resolveValidatedCliInvocation, validateCliCommandRef } from './model-contract.js';
import { runWorkflowProcess, redactWorkflowText, type WorkflowProcessResult } from './workflow-process.js';
import { createClaudeWorkflowResultDecoder, prepareWorkflowBinding, workflowWorkerArguments, workflowReviewerArguments,
  workflowReviewerProjectionArguments, workflowReviewProvenance,
  type PreparedWorkflowBinding, type WorkflowReviewReaderInvocation, type WorkflowRuntime } from './workflow-adapters.js';
import { buildWorkflowPrompt, workflowContextFingerprint, workflowPromptFingerprint, workflowSessionFingerprint } from './workflow-prompt.js';
import { issueWorkflowPublication, publishNativeClaudeResult, readWorkflowJsonArtifact, readWorkflowResultArtifact } from './workflow-publication.js';
import { WorkflowRefAudit } from './workflow-ref-audit.js';
import { classifyOrphanedAttempt } from './workflow-orphan.js';
import { hasRecoverableProtectedRefAudit, inspectWorkflowTaskState, workflowRefsDigest,
  type WorkflowTaskInspection } from './workflow-recovery-inspection-core.js';
import { appendWorkflowTaskRecovery, parseWorkflowTaskRecovery, parseWorkflowTaskRecoveryIntent,
  type WorkflowTaskRecoveryIntent } from './workflow-task-recovery.js';
import { cachedCurrentProcessStartIdentity } from '../orchestration/operation-lock.js';
import { boundedText, safeWorkflowId, parseWorkflowPlan, parseWorkflowTask, matchesScope,
  parseWorkflowHandoff, parseWorkflowFindings, parseWorkflowBinding, parseWorkflowState, parseWorkflowProviderPolicy,
  validateWorkflowStateTransition, parseWorkflowLeadIntegrationIntent, parseWorkflowLeadIntegration,
  parseWorkflowDispatchSupplementIntent, parseWorkflowDispatchSupplement,
  parseWorkflowReviewBudgetExtensionIntent, parseWorkflowReviewBudgetExtension, workflowReviewCeiling, workflowReviewBudgetUsed,
  parseWorkflowReviewCompatibilityAdoptionIntent, parseWorkflowReviewCompatibilityAdoption,
  workflowReviewTransportPolicy, WORKFLOW_REVIEW_READ_LIMIT_BYTES,
  type WorkflowState as LegacyWorkflowState, type VersionedWorkflowState as WorkflowState, type WorkflowStateV2,
  parseWorkflowSubstitution, parseWorkflowBindingRefreshIntent, assertWorkflowResumeBinding,
  type WorkflowRole, type WorkflowRoleBinding, type WorkflowBindingRefreshIntent, type WorkflowOptions, type WorkflowTaskState,
  type WorkflowFinding, type WorkflowHandoff, type WorkflowInvocation, type WorkflowReviewAttempt, type WorkflowReviewAttemptV2,
  type WorkflowProcessResultSnapshot,
  type WorkflowLeadIntegrationIntent, type WorkflowDispatchSupplementIntent, type WorkflowReviewBudgetExtensionIntent,
  type WorkflowReviewCompatibilityAdoption, type WorkflowReviewCompatibilityAdoptionIntent,
  type WorkflowReviewCompatibilityBinding, type WorkflowReviewBuildIdentity,
  type WorkflowReviewSourceManifestDescriptor,
  type WorkflowWorktreeSetupDetail } from './workflow-contracts.js';
import { buildWorkflowReviewSourceBundle, verifyWorkflowReviewSourceBundle, assertWorkflowReviewSourceHead,
  publishWorkflowReviewBundle, resolveWorkflowReviewSourceFile, readWorkflowReviewSourceMember, spoolWorkflowReviewGit,
  validateWorkflowReviewCoverageLedger, streamWorkflowReviewLines, WorkflowReviewOwnedFile,
  readWorkflowReviewGitText, writeWorkflowReviewArtifact, createWorkflowReviewArtifactDescriptor,
  hashWorkflowReviewArtifact, iterateWorkflowReviewAuthorizedPaths, verifyWorkflowReviewSourceManifestDescriptor,
  verifyWorkflowReviewAuthorizedMembership, iterateWorkflowReviewNulRecords,
  type WorkflowReviewMaterialInput, type WorkflowReviewSourceBundle } from './workflow-review-source.js';
import { workflowReviewReaderBuildIdentity, workflowReviewSourceReaderConfig, workflowReviewCodexReaderOverrides,
  workflowReviewSourceServerPath, projectWorkflowReviewCodexCatalog,
  readWorkflowReviewReaderQualification, verifyWorkflowReviewReaderQualification,
  verifyWorkflowReviewQualificationEvidence, workflowReviewEffectiveInvocation, workflowReviewReaderDependencies,
  workflowReviewProjectedReader, WORKFLOW_REVIEW_EPHEMERAL_PLACEHOLDERS,
  WORKFLOW_REVIEW_READER_TOOL_MANIFEST, WORKFLOW_REVIEW_READER_TOOL_READ, WORKFLOW_REVIEW_READER_TOOLS,
  requireWorkflowSyntheticReviewClientFactory, planWorkflowSyntheticReview, prepareWorkflowSyntheticReview,
  workflowSyntheticBridgeEnvironment, workflowSyntheticReaderPath,
  requireWorkflowNativeReviewClientFactory, workflowNativeReviewQualification, workflowNativeReviewProjection,
  workflowNativeReviewServerNames, workflowNativeReviewCatalogSource, verifyWorkflowNativeReviewPrepared,
  prepareWorkflowNativeReview, WORKFLOW_REVIEW_NATIVE_NAMESPACE,
  WorkflowNativeReviewSession, type WorkflowNativeReviewClientFactory,
  type WorkflowSyntheticReviewSession, type WorkflowSyntheticReviewPlan, type WorkflowSyntheticReviewLaunch,
  type WorkflowReviewReaderQualification, type WorkflowReviewEffectiveInvocation,
  type WorkflowReviewCodexCatalogProjection,
  WORKFLOW_REVIEW_SOURCE_SERVER_NAME } from './workflow-review-source-server.js';

export type { WorkflowState, WorkflowOptions, WorkflowPlan, WorkflowTask, WorkflowHandoff, WorkflowFinding } from './workflow-contracts.js';

const now = () => new Date().toISOString();
const legacyProvider = (state: WorkflowState): 'glm' | 'mimo' => state.schemaVersion === 1 && state.profile === 'claude-mimo-codex' ? 'mimo' : 'glm';
const resolveLegacyExecutable = (state: WorkflowState): string => legacyProvider(state) === 'mimo'
  ? resolveMimoExecutable(state.options.glmCommand) : resolveGlmExecutable(state.options.glmCommand);
const savedSnapshots = new WeakMap<WorkflowState, unknown>();
const pendingTaskProjections = new WeakSet<WorkflowState>();
const MAX_WORKFLOW_STATE_BYTES = 16 * 1024 * 1024;
function gitRaw(cwd: string, args: string[]): string {
  try { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe', timeout: 30_000, windowsHide: true }); }
  catch { throw new Error('workflow_git_operation_failed'); }
}
function git(cwd: string, args: string[]): string { return gitRaw(cwd, args).trim(); }
/**
 * Whether `ancestor` is a real commit reachable from `head` (or is `head` itself). The final-PR base
 * is deliberately a distinct commit from the plan's narrower task base, so it is proven against the
 * repository rather than compared to a saved plan value; a shallow or rewritten history is refused.
 */
function isWorkflowReviewAncestor(cwd: string, ancestor: string, head: string): boolean {
  try { git(cwd, ['rev-parse', '--verify', `${ancestor}^{commit}`]); }
  catch { return false; }
  try { git(cwd, ['merge-base', '--is-ancestor', ancestor, head]); return true; }
  catch { return false; }
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
type WorkflowResultTransport =
  | { kind: 'worker-designated-result'; taskId: string }
  | { kind: 'provider-designated-json' }
  | { kind: 'claude-native-structured' };
async function runWorkflowProvider(input: Omit<Parameters<typeof runWorkflowProcess>[0], 'stdin'> & { stdin?: string },
  resultFile: string, transport: WorkflowResultTransport, stdin?: string, observe?: (chunk: Buffer) => void,
  onCompletion?: (result: WorkflowProcessResult) => void) {
  // Capture before launch: an unsuccessful provider can still write or redirect its result path.
  const canonicalParent = realpathSync(dirname(resultFile));
  let result: Awaited<ReturnType<typeof runWorkflowProcess>> | undefined;
  let output: unknown;
  let outputError: unknown;
  let outputArtifactPath = resultFile;
  const decoder = transport.kind === 'claude-native-structured' ? createClaudeWorkflowResultDecoder() : undefined;
  // The caller's own stdout hook and the Claude result decoder are *composed*, never substituted: the
  // protected process wrapper turns a throwing stdout callback into a recorded protocol failure and an
  // owned cleanup, so keeping the caller's hook in the chain preserves its own observation of the wire
  // while the decoder still sees every byte. The first failure of either is the one that is re-thrown,
  // so a decode error is never overwritten by a later callback error and vice versa; both are attempted
  // whatever order they fail in, so a run cannot be reported as merely undecodable when its own
  // callback refused the wire first.
  const callerStdout = observe ?? input.onStdout;
  // Whether a hook *failed* is tracked separately from the value it threw. A hook that throws `0`,
  // `false`, `''`, `null` or `undefined` did refuse the wire, and a truthiness test would read it as
  // a hook that returned normally; a nullish first failure would likewise be replaced by the
  // decoder's later one. The first captured value is therefore retained by its own presence, and the
  // second hook still runs so neither observation is skipped.
  const stdoutFailure = { present: false, value: undefined as unknown };
  const onStdout = (chunk: Buffer) => {
    let failed = false; let failure: unknown;
    try { callerStdout?.(chunk); } catch (error) { failed = true; failure = error; }
    try { decoder?.write(chunk); } catch (error) { if (!failed) { failed = true; failure = error; } }
    if (!failed) return;
    // Retained outside the protected wrapper, whose own catch only records a generic protocol
    // failure and discards the value: without this the specific cause of a refused wire would be
    // unrecoverable, and a callback that threw a falsy value would leave no trace at all.
    if (!stdoutFailure.present) { stdoutFailure.present = true; stdoutFailure.value = failure; }
    throw failure;
  };
  try {
    result = await runWorkflowProcess({ ...input, ...(input.onInput ? {} : { stdin: input.stdin ?? stdin ?? '' }), ...(input.timeoutMs === null ? { superviseProcessTree: true } : {}),
      onStdout });
    onCompletion?.(result);
    if (decoder) {
      try {
        const decoded = decoder.finish();
        publishNativeClaudeResult(resultFile, decoded, input.redactionEnvironment ?? input.environment);
      } catch (error) { outputError = error; }
    }
  }
  finally {
    try {
      const artifact = transport.kind === 'worker-designated-result'
        ? readWorkflowResultArtifact(resultFile, canonicalParent, transport.taskId, input.redactionEnvironment ?? input.environment)
        : readWorkflowJsonArtifact(resultFile, canonicalParent, input.redactionEnvironment ?? input.environment);
      output = artifact.value;
      outputArtifactPath = artifact.artifactPath;
    }
    catch (error) { outputError ??= error; }
  }
  // Return parse failures so callers can retain process artifacts and preserve the original failure precedence.
  // The first refused stdout hook is carried out beside them: the protected wrapper reports its own
  // generic protocol failure and drops the thrown value, so this is the only place the specific cause
  // of a refused wire survives, and a falsy throw leaves evidence instead of vanishing.
  return { ...result, output, outputError, outputArtifactPath,
    ...(stdoutFailure.present ? { stdoutCallbackError: boundedWorkflowStdoutCallbackError(stdoutFailure.value) } : {}) };
}
/** A bounded, output-free name for the first failed stdout hook of one provider run. */
function boundedWorkflowStdoutCallbackError(value: unknown): string {
  const message = value instanceof Error ? value.message : typeof value === 'string' ? value : '';
  return /^workflow_[a-z_]{1,180}$/.test(message) ? message : `workflow_stdout_callback_failed:${typeof value}`;
}
function workflowProcessResultSnapshot(result: WorkflowProcessResult & { stdoutCallbackError?: string; integrityDiagnostic?: string }): WorkflowProcessResultSnapshot {
  const settlement = result.settlement === undefined ? undefined : Object.freeze({
    parentExitCode: result.settlement.parentExitCode,
    parentExitSignal: result.settlement.parentExitSignal,
    outputComplete: result.settlement.outputComplete,
    termination: result.settlement.termination,
    directChild: result.settlement.directChild,
    descendants: result.settlement.descendants,
  });
  return Object.freeze({ passed: result.passed, ...(result.error === undefined ? {} : { error: result.error }),
    ...(result.integrityDiagnostic || result.stdoutCallbackError ? { integrityDiagnostic: result.integrityDiagnostic ?? result.stdoutCallbackError } : {}),
    parentExitedSuccessfully: result.parentExitedSuccessfully, stdoutTruncated: result.stdoutTruncated,
    ...(settlement === undefined ? {} : { settlement }) });
}
function recordWorkflowProcessResult(attempt: WorkflowInvocation | WorkflowReviewAttempt, result: WorkflowProcessResult): void {
  Object.defineProperty(attempt, 'processResult', { value: workflowProcessResultSnapshot(result),
    enumerable: true, writable: false, configurable: false });
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
  const previous = savedSnapshots.get(state);
  if (previous) validateWorkflowStateTransition(previous, state);
  else parseWorkflowState(state);
  if (Buffer.byteLength(`${JSON.stringify(state, null, 2)}\n`) > MAX_WORKFLOW_STATE_BYTES) throw new Error('workflow_state_too_large');
  atomicWriteJson(statePath(state.cwd, state.plan.name), state);
  savedSnapshots.set(state, JSON.parse(JSON.stringify(state)));
  pendingTaskProjections.add(state);
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
  pendingTaskProjections.delete(state);
}
export function readWorkflow(cwd: string, name: string): WorkflowState {
  let state = boundedJson(statePath(cwd, name), 16 * 1024 * 1024) as WorkflowState;
  if (state?.schemaVersion === 1 || state?.schemaVersion === 2) state = parseWorkflowState(state);
  if (!state || !((state.schemaVersion === 1 && (state.profile === 'claude-glm-codex' || state.profile === 'claude-mimo-codex')) || (state.schemaVersion === 2 && state.profile === 'role-substitution')) || state.plan?.name !== name
    || realpathSync(state.cwd) !== realpathSync(cwd)) throw new Error('workflow_invalid_state');
  if (!Array.isArray(state.tasks) || !Array.isArray(state.reviews)) throw new Error('workflow_invalid_state');
  if (state.options.mode !== undefined && !['v1', 'balanced'].includes(state.options.mode)) throw new Error('workflow_invalid_mode');
  // A malformed saved policy is refused here, before any lock, provider launch or work.
  parseWorkflowProviderPolicy(state.options.providerPolicy);
  parseWorkflowPlan(state.plan, new Set(state.tasks.filter(entry => entry.status === 'rejected').map(entry => entry.task.id)));
  return state;
}
/** Inspect retained task evidence without changing workflow state, refs, or worktrees. */
export function inspectWorkflowTask(cwd: string, name: string, taskId: string): WorkflowTaskInspection {
  return inspectWorkflowTaskState(readWorkflow(cwd, name), safeWorkflowId(taskId));
}
async function mutate(cwd: string, name: string,
  action: (state: WorkflowState, active: ActiveOrchestratorSnapshot) => Promise<void | false>,
  options: { allowComplete?: boolean } = {}): Promise<WorkflowState> {
  assertLeadCaller();
  const path = statePath(cwd, name);
  return withOrchestratorOperation(cwd, active => withFileLock(`${path}.lock`, async () => {
      const state = readWorkflow(cwd, name);
      savedSnapshots.set(state, JSON.parse(JSON.stringify(state)));
      if (!options.allowComplete) assertMutable(state);
      let saveRequired = true;
      let failure: { error: unknown } | undefined;
      try { saveRequired = await action(state, active) !== false; }
      catch (error) { failure = { error }; }
      finally {
        if (saveRequired && (!failure || pendingTaskProjections.has(state) || !isDeepStrictEqual(savedSnapshots.get(state), state))) {
          try { save(state); }
          catch (error) {
            failure = { error: failure ? new AggregateError([failure.error, error], 'workflow_worker_persistence_failed', { cause: failure.error }) : error };
          }
        }
      }
      if (failure) throw failure.error;
      return state;
    }, { timeoutMs: 0 }));
}
function count(value: number | undefined, fallback: number, max: number, min = 1): number {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < min || result > max) throw new Error('workflow_invalid_limit');
  return result;
}
/**
 * Worker failures that are terminal rather than a retry prompt. workflow_output_incomplete joins the
 * explicit timeout/interruption stops: a wall-less provider that ended without a complete stream must
 * never be silently re-dispatched, and its original attempt and artifacts stay inspectable.
 */
const NON_RETRYABLE_WORKER_ERRORS = ['workflow_timeout', 'workflow_interrupted', 'workflow_invocation_interrupted', 'workflow_output_incomplete',
  'workflow_worker_persistence_failed',
  'workflow_designated_result_missing', 'workflow_worker_modified_protected_refs', 'workflow_protected_refs_changed',
  'workflow_protected_ref_audit_failed', 'workflow_session_identity_mismatch'] as const;
function nonRetryableWorkerError(error: string | undefined): boolean {
  return NON_RETRYABLE_WORKER_ERRORS.some(entry => entry === error);
}
function hasTrailingIncompleteInvocation(entry: WorkflowTaskState): boolean {
  return entry.invocations?.at(-1)?.error === 'workflow_invocation_incomplete';
}
function assertNoIncompleteTaskInvocations(state: WorkflowState): void {
  if (state.tasks.some(hasTrailingIncompleteInvocation)) throw new Error('workflow_interrupted_worker_requires_inspection');
}
function assertNoIncompleteReviewInvocations(state: WorkflowState): void {
  if (state.reviewAttempts?.some(attempt => attempt.error === 'workflow_invocation_incomplete')) {
    throw new Error('workflow_interrupted_review_requires_inspection');
  }
}
/** A validated publication can settle missing terminal framing after a clean exit, but never incomplete process settlement. */
function designatedResultOverridesProcessFailure(result: WorkflowProcessResult, handoff: WorkflowHandoff): boolean {
  if (!result.stdoutTruncated || !result.parentExitedSuccessfully || handoff.outcome !== 'completed'
    || handoff.tests.some(test => !test.passed) || result.telemetry?.terminal === 'failure') return false;
  return result.error === 'process_failed' && result.telemetry?.terminal === undefined
    && result.telemetry?.diagnostics?.includes('missing_terminal_event') === true;
}
/**
 * A controller that died mid-attempt leaves its task running forever. The attempt is settled only when the shared
 * orphan rule proves its provider (or, before any spawn, its controller) dead; anything else requires inspection.
 */
function settleOrphanedAttempt(state: WorkflowState, entry: WorkflowTaskState): void {
  if (classifyOrphanedAttempt(entry) !== 'orphaned') throw new Error('workflow_interrupted_worker_requires_inspection');
  const invocation = entry.invocations!.at(-1)!;
  const error = invocation.error === 'workflow_worker_persistence_failed' ? invocation.error : 'workflow_invocation_interrupted';
  invocation.outcome = 'failed'; invocation.error = error;
  entry.status = 'failed'; entry.error = error; delete entry.claimToken; entry.updatedAt = now();
  revokeOrphanedPublication(state, entry);
}
/** The dead controller never revoked the attempt's one-shot publication capability; remove it so nothing can publish for a settled attempt. */
function revokeOrphanedPublication(state: WorkflowState, entry: WorkflowTaskState): void {
  const root = artifactsRoot(state);
  for (const name of readdirSync(root)) {
    if (!/^\.publication-[0-9a-f-]{36}\.json$/.test(name)) continue;
    const path = join(root, name);
    try {
      const record = JSON.parse(readFileSync(path, 'utf8')) as { taskId?: unknown; worker?: unknown; attempt?: unknown };
      if (record.taskId === entry.task.id && record.worker === entry.worker && record.attempt === entry.attempts) unlinkSync(path);
    } catch { /* an unreadable record is left for inspection */ }
  }
}
export async function initWorkflow(cwd: string, rawPlan: unknown, options: WorkflowOptions = {}, profile?: LegacyWorkflowState['profile']): Promise<LegacyWorkflowState> {
  const state = await initializeWorkflow(cwd, rawPlan, options, undefined, profile);
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
async function initializeWorkflow(cwd: string, rawPlan: unknown, options: WorkflowOptions, bindings?: Readonly<Record<WorkflowRole, WorkflowRoleBinding>>, profile?: LegacyWorkflowState['profile']): Promise<WorkflowState> {
  assertLeadCaller();
  return withOrchestratorOperation(cwd, async () => {
    if (redactWorkflowText(JSON.stringify({ rawPlan, options })) !== JSON.stringify({ rawPlan, options })) throw new Error('workflow_sensitive_input_rejected');
    cwd = realpathSync(cwd);
    const plan = parseWorkflowPlan(rawPlan);
  if (options.mode !== undefined && !['v1', 'balanced'].includes(options.mode)) throw new Error('workflow_invalid_mode');
  // Refuse every unsupported present policy before any state directory, branch or provider exists.
  const parsedProviderPolicy = parseWorkflowProviderPolicy(options.providerPolicy);
  // All newly initialized workflows use the descriptive spelling. Historical states retain the old alias byte-for-byte.
  const providerPolicy = parsedProviderPolicy === undefined ? undefined : 'unbounded-provider-timeout' as const;
  const path = statePath(cwd, plan.name);
  if (existsSync(teamStateRoot(cwd, plan.name))) throw new Error('workflow_name_already_exists');
  if (!clean(cwd)) throw new Error('workflow_leader_worktree_dirty');
  if (/^(?:main|master)$/i.test(plan.integrationBranch) || plan.integrationBranch.startsWith('-')) throw new Error('workflow_integration_branch_required');
  git(cwd, ['check-ref-format', '--branch', plan.integrationBranch]);
  if (git(cwd, ['rev-parse', `${plan.baseCommit}^{commit}`]) !== plan.baseCommit) throw new Error('workflow_invalid_base');
  for (const task of plan.tasks) if (task.baseCommit !== plan.baseCommit) throw new Error('workflow_task_base_mismatch');
  for (const task of plan.tasks) if (task.dependencies.length && task.tests.some(test =>
    test.args.some(arg => arg.toLowerCase().includes(plan.baseCommit)))) throw new Error('workflow_dependent_test_uses_plan_base');
  // Select the requested worker profile before expanding it; a global GLM preset
  // must not turn into an explicit role override when this run chooses MiMo.
  const loaded = loadConfig(cwd, { applyTeamProfile: false });
  const selectedProfile = profile ?? (!bindings ? loaded.team?.profile : undefined) ?? 'claude-glm-codex';
  const provider = selectedProfile === 'claude-mimo-codex' ? 'mimo' : 'glm';
  const routing = applyGlmProfile({ ...loaded, team: { ...loaded.team, profile: selectedProfile } });
  const executor = resolveRoleAssignment('executor', routing);
  const reviewer = resolveRoleAssignment('code-reviewer', routing);
  if (!bindings && (executor.provider !== provider || reviewer.provider !== 'codex')) throw new Error(`workflow_role_routing_requires_${provider}_executor_and_codex_reviewer`);
  const config = provider === 'mimo' ? getMimoConfig(routing) : getGlmConfig(routing);
  const maxWorkers = count(options.maxWorkers, config.maxWorkers, ABSOLUTE_MAX_WORKERS);
  const codexCommand = options.codexCommand ?? process.env.OMC_CODEX_COMMAND ?? 'codex';
  validateCliCommandRef(codexCommand);
  const resolvedOptions: WorkflowState['options'] = {
    ...(options.mode === undefined ? {} : { mode: options.mode }),
    workers: count(options.workers, Math.min(config.defaultWorkers, maxWorkers), maxWorkers), maxWorkers,
    maxAttempts: count(options.maxAttempts, 2, 5), maxReviewPasses: count(options.maxReviewPasses, 2, 10),
    timeoutMs: count(options.timeoutMs, 600_000, 3_600_000, 100), backoffMs: count(options.backoffMs, 1000, 30_000, 0),
    glmCommand: options.glmCommand ?? config.command, codexCommand,
    ...(options.glmModel ?? (executor.model || config.model) ? { glmModel: options.glmModel ?? (executor.model || config.model) } : {}),
    ...(options.codexModel ?? reviewer.model ? { codexModel: options.codexModel ?? reviewer.model } : {}),
    ...(providerPolicy === undefined ? {} : { providerPolicy }),
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
    schemaVersion: 1, profile: selectedProfile, plan, cwd, integrationHead: plan.baseCommit, options: resolvedOptions, stage: 'implementation',
    tasks: plan.tasks.map((task, index) => ({ task, canonicalId: String(index + 1), status: 'pending', attempts: 0,
      worker: `task-${task.id}`, updatedAt: now() })), reviewPasses: 0, reviewBudgetBasis: 'completed-reviews',
    reviews: [], createdAt: now(), updatedAt: now(),
  };
  const state: WorkflowState = bindings ? { ...legacy, schemaVersion: 2, profile: 'role-substitution', bindings, substitutions: [],
    tasks: plan.tasks.map((task, index) => ({ task, canonicalId: String(index + 1), status: 'pending', attempts: 0,
      worker: `task-${task.id}`, updatedAt: now() })), reviewAttempts: [] } : legacy;
  ensureDirWithMode(teamStateRoot(cwd, plan.name));
  await withFileLock(`${path}.lock`, async () => save(state));
    return state;
  });
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
/**
 * The unbounded-provider-timeout policy removes only the implementer/reviewer elapsed bound; null is the sole unbounded
 * value. Worker-declared checks, integrated verification and every other local command stay finite,
 * and the policy is never inferred from a provider name, model, environment or timeout value.
 */
function providerTimeoutMs(state: WorkflowState): number | null {
  return state.options.providerPolicy === 'supervised' || state.options.providerPolicy === 'unbounded-provider-timeout'
    ? null : state.options.timeoutMs;
}
function sameReceiptIdentity(left: WorkflowRoleBinding, right: WorkflowRoleBinding): boolean {
  return left.role === right.role && left.providerRoute === right.providerRoute && left.cliFamily === right.cliFamily
    && left.authProfileRef === right.authProfileRef && left.authFingerprint === right.authFingerprint
    && JSON.stringify(left.executableIdentity) === JSON.stringify(right.executableIdentity)
    && JSON.stringify(left.capabilities) === JSON.stringify(right.capabilities)
    && left.capabilityEvidenceSha256 === right.capabilityEvidenceSha256;
}
/** Resolve a refresh-derived ID through its unique, digest-pinned substitution ancestry. */
function runtimeWithReceiptFallback(state: WorkflowStateV2, binding: WorkflowRoleBinding,
  runtime?: WorkflowRuntime): WorkflowRuntime | undefined {
  if (!runtime) return undefined;
  return { ...runtime, resolveBinding(selected) {
    try { return runtime.resolveBinding(selected); } catch {
      let current = binding;
      const seen = new Set([current.id]);
      for (;;) {
        const prior = [...state.substitutions].reverse().find(record => record.to.id === current.id
          && sameReceiptIdentity(record.from, current));
        if (!prior || seen.has(prior.from.id)) throw new Error('workflow_auth_profile_unavailable');
        seen.add(prior.from.id);
        current = prior.from;
        try { return runtime.resolveBinding(current); } catch { /* Follow only the saved, digest-pinned ancestry. */ }
      }
    }
  } };
}
function prepareBinding(state: WorkflowStateV2, binding: WorkflowRoleBinding, runtime?: WorkflowRuntime): PreparedWorkflowBinding {
  try { return prepareWorkflowBinding(binding, runtimeWithReceiptFallback(state, binding, runtime)); }
  catch (error) {
    const message = error instanceof Error && /^workflow_[a-z_]+$/.test(error.message) ? error.message : 'workflow_preflight_failed';
    const path = join(artifactsRoot(state), `preflight-${randomUUID()}.json`);
    writeFileSync(path, JSON.stringify({ kind: 'preflight', bindingId: binding.id, provider: binding.providerRoute, error: message, at: now(), reserved: false }), { flag: 'wx', mode: 0o600 });
    throw new Error(message);
  }
}
type WorkflowSubstitutionInput = {
  role: WorkflowRole; binding: unknown; expectedHead: string; reason: string; authorityRef: string; taskId?: string;
};
function appendWorkflowSubstitution(state: WorkflowStateV2, input: WorkflowSubstitutionInput,
  binding: WorkflowRoleBinding): void {
  if (assertLeader(state) !== input.expectedHead) throw new Error('workflow_substitution_head_mismatch');
  if (state.tasks.some(entry => entry.status === 'running')) throw new Error('workflow_interrupted_worker_requires_inspection');
  const task = input.taskId === undefined ? undefined : getTask(state, input.taskId);
  if (task && !['pending', 'failed'].includes(task.status)) throw new Error('workflow_substitution_task_not_pending');
  const record = parseWorkflowSubstitution({ sequence: state.substitutions.length + 1, role: input.role,
      from: state.bindings[input.role], to: binding, reason: redactWorkflowText(boundedText(input.reason, 1000)),
      authorityRef: redactWorkflowText(boundedText(input.authorityRef, 1000)), head: state.integrationHead, at: now(),
      ...(task ? { taskId: task.task.id, afterAttempt: task.attempts } : {}),
      ...(input.role === 'reviewer' ? { afterReviewPass: state.reviewPasses } : {}) });
  state.substitutions = Object.freeze([...state.substitutions, record]);
  state.bindings = Object.freeze({ ...state.bindings, [input.role]: binding });
}
export async function substituteWorkflowBinding(cwd: string, name: string, input: WorkflowSubstitutionInput): Promise<WorkflowState> {
  return mutate(cwd, name, async state => {
    if (state.schemaVersion !== 2) throw new Error('workflow_role_substitution_profile_required');
    appendWorkflowSubstitution(state, input, parseWorkflowBinding(input.binding));
  });
}
function deriveRefreshedBinding(state: WorkflowStateV2, input: WorkflowBindingRefreshIntent): {
  source: WorkflowRoleBinding; candidate: WorkflowRoleBinding;
} {
  const source = state.bindings[input.role];
  if (source.id !== input.sourceBindingId) throw new Error('workflow_binding_refresh_source_mismatch');
  if (input.newBindingId === source.id) throw new Error('workflow_binding_refresh_new_id_required');
  const knownIds = new Set<WorkflowRoleBinding>([]);
  for (const binding of Object.values(state.bindings)) knownIds.add(binding);
  for (const record of state.substitutions) { knownIds.add(record.from); knownIds.add(record.to); }
  for (const task of state.tasks) {
    for (const invocation of task.invocations ?? []) knownIds.add(invocation.binding);
    if (task.session?.binding) knownIds.add(task.session.binding);
  }
  for (const attempt of state.reviewAttempts ?? []) knownIds.add(attempt.binding);
  if ([...knownIds].some(binding => binding.id === input.newBindingId)) throw new Error('workflow_binding_id_already_used');
  const effort = input.effort === undefined ? source.effort : input.effort === null ? undefined : input.effort;
  const candidate = parseWorkflowBinding({ ...source, id: input.newBindingId, model: input.model,
    ...(effort === undefined ? { effort: undefined } : { effort }) });
  return { source, candidate };
}
function prepareRefreshedBinding(state: WorkflowStateV2, source: WorkflowRoleBinding, candidate: WorkflowRoleBinding,
  runtime?: WorkflowRuntime): PreparedWorkflowBinding {
  if (!runtime) throw new Error('workflow_runtime_required');
  const sourceRuntime = runtimeWithReceiptFallback(state, source, runtime)!;
  const preparedSource = prepareWorkflowBinding(source, sourceRuntime);
  // The new ID resolves through exactly the already authenticated source receipt. The candidate keeps
  // its digest, route, executable, auth identity and capabilities, and normal preparation revalidates all of them.
  const derivedRuntime: WorkflowRuntime = { ...sourceRuntime, resolveBinding(binding) {
    return binding.id === candidate.id ? sourceRuntime.resolveBinding(source) : sourceRuntime.resolveBinding(binding);
  } };
  try {
    const prepared = prepareWorkflowBinding(candidate, derivedRuntime);
    if (preparedSource.validation !== prepared.validation) throw new Error('changed');
    return prepared;
  } catch { throw new Error('workflow_authenticated_receipt_refresh_required'); }
}
function sanitizedBinding(binding: WorkflowRoleBinding): Record<string, unknown> {
  return { id: binding.id, role: binding.role, provider: binding.providerRoute, model: binding.model,
    effort: binding.effort ?? null, cliFamily: binding.cliFamily, credentialProfileRef: binding.authProfileRef };
}
/** Read-only validation of a receipt-covered model/effort change; it never calls a provider or changes state. */
export function probeWorkflowBinding(cwd: string, name: string, rawIntent: unknown,
  runtime?: WorkflowRuntime): Record<string, unknown> {
  assertLeadCaller();
  const input = parseWorkflowBindingRefreshIntent(rawIntent);
  const state = readWorkflow(cwd, name);
  if (state.schemaVersion !== 2) throw new Error('workflow_role_substitution_profile_required');
  if (state.stage === 'complete') throw new Error('workflow_already_complete');
  if (assertLeader(state) !== input.expectedHead) throw new Error('workflow_substitution_head_mismatch');
  if (state.tasks.some(entry => entry.status === 'running')) throw new Error('workflow_interrupted_worker_requires_inspection');
  if (input.taskId !== undefined) {
    const task = getTask(state, input.taskId);
    if (!['pending', 'failed'].includes(task.status)) throw new Error('workflow_substitution_task_not_pending');
  }
  const { source, candidate } = deriveRefreshedBinding(state, input);
  const prepared = prepareRefreshedBinding(state, source, candidate, runtime);
  return { ready: true, validation: prepared.validation, expectedHead: state.integrationHead,
    sourceBindingId: source.id, candidate: sanitizedBinding(candidate), providerCalled: false };
}
/** Validate and append a future-only binding selection while holding the workflow mutation lock. */
export async function refreshWorkflowBinding(cwd: string, name: string, rawIntent: unknown,
  runtime?: WorkflowRuntime): Promise<WorkflowState> {
  const input = parseWorkflowBindingRefreshIntent(rawIntent);
  return mutate(cwd, name, async state => {
    if (state.schemaVersion !== 2) throw new Error('workflow_role_substitution_profile_required');
    const { source, candidate } = deriveRefreshedBinding(state, input);
    prepareRefreshedBinding(state, source, candidate, runtime);
    appendWorkflowSubstitution(state, { role: input.role, binding: candidate, expectedHead: input.expectedHead,
      reason: input.reason, authorityRef: input.authorityRef, ...(input.taskId ? { taskId: input.taskId } : {}) }, candidate);
  });
}
function assertWorker(state: WorkflowState, entry: WorkflowTaskState): string {
  const expected = getWorktreePath(state.cwd, state.plan.name, entry.worker);
  if (!entry.worktree || resolve(entry.worktree) !== resolve(expected) || entry.branch !== getBranchName(state.plan.name, entry.worker)) throw new Error('workflow_worker_mapping_mismatch');
  validateResolvedPath(expected, join(teamStateRoot(state.cwd, ''), '..', '..', 'team'));
  if (git(expected, ['branch', '--show-current']) !== entry.branch) throw new Error('workflow_worker_branch_mismatch');
  // Native resolution expands Windows short names; different directories still compare exactly.
  const canonicalExpected = expandPathForCompare(expected);
  if (!canonicalExpected || expandPathForCompare(git(expected, ['rev-parse', '--show-toplevel'])) !== canonicalExpected) throw new Error('workflow_worker_mapping_mismatch');
  const registered = git(state.cwd, ['worktree', 'list', '--porcelain']);
  if (!registered.split('\n').some(line => line.startsWith('worktree ') && expandPathForCompare(line.slice('worktree '.length)) === canonicalExpected)) throw new Error('workflow_worker_unregistered');
  if (!clean(expected)) throw new Error('workflow_worker_worktree_dirty');
  return expected;
}
function validateCommit(state: WorkflowState, entry: WorkflowTaskState): string[] {
  const cwd = assertWorker(state, entry);
  const sha = entry.handoff?.commitSha;
  if (!sha || git(cwd, ['rev-parse', 'HEAD']) !== sha) throw new Error('workflow_worker_commit_mismatch');
  const parents = git(cwd, ['rev-list', '--parents', '-n', '1', sha]).split(' ');
  if (parents.length !== 2 || parents[1] !== entry.task.baseCommit) throw new Error('workflow_worker_single_commit_required');
  const files = gitRaw(cwd, ['diff', '--name-only', '--no-renames', '-z', entry.task.baseCommit, sha]).split('\0').filter(Boolean);
  if (!files.length || files.length > 100) throw new Error('workflow_invalid_changed_files');
  for (const file of files) if (!matchesScope(file, entry.task.writeScope) || matchesScope(file, entry.task.prohibitedScope)) throw new Error('workflow_out_of_scope_changes');
  if (JSON.stringify([...files].sort()) !== JSON.stringify([...(entry.handoff?.changedFiles ?? [])].sort())) throw new Error('workflow_changed_files_mismatch');
  return files;
}
function sessionFingerprint(state: WorkflowState, entry: WorkflowTaskState, command: string, worktree: string): string {
  const executable = realpathSync(command);
  const info = statSync(executable);
  const environment = Object.entries(process.env).filter(([key]) => /^(?:ANTHROPIC_|CLAUDE_|CLAUDE_CONFIG_DIR$|OMC_(?:GLM|MIMO)_|OMC_EXTERNAL_MODELS_DEFAULT_(?:GLM|MIMO)_MODEL$)/.test(key)
    && !['CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID'].includes(key)).sort(([a], [b]) => a.localeCompare(b));
  // Keep secrets out of state; bind their launch configuration together in one opaque digest.
  const launchIdentity = { executable, size: info.size, modified: info.mtimeMs, environment,
    ...(/\.(?:c?js|mjs|sh)$/i.test(executable) && info.size <= 1024 * 1024 ? { script: workflowPromptFingerprint(readFileSync(executable, 'utf8')) } : {}) };
  return workflowPromptFingerprint(JSON.stringify({ launch: launchIdentity,
    context: workflowSessionFingerprint(state, entry, executable, worktree) }));
}
const WORKTREE_SETUP_DETAILS = new Set<WorkflowWorktreeSetupDetail>([
  'worktree_branch_mismatch', 'worktree_branch_in_use', 'worktree_path_mismatch', 'worktree_mismatch',
]);
function worktreeSetupDetail(error: unknown): WorkflowWorktreeSetupDetail | undefined {
  const code = error && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' && WORKTREE_SETUP_DETAILS.has(code as WorkflowWorktreeSetupDetail)
    ? code as WorkflowWorktreeSetupDetail : undefined;
}
function worktreeSetupStderr(error: unknown, detail: WorkflowWorktreeSetupDetail | undefined,
  state: WorkflowState, entry: WorkflowTaskState,
  privateEnvironment: NodeJS.ProcessEnv): string {
  const stderr = error && typeof error === 'object' && 'stderr' in error
    ? (error as { stderr?: unknown }).stderr : undefined;
  const raw = Buffer.isBuffer(stderr) ? stderr.toString('utf8') : typeof stderr === 'string' ? stderr : '';
  let diagnostic = redactWorkflowText(raw, false, privateEnvironment);
  for (const path of [state.cwd, getWorktreePath(state.cwd, state.plan.name, entry.worker)]) {
    diagnostic = diagnostic.split(path).join('[PATH]').split(path.replaceAll('\\', '/')).join('[PATH]');
  }
  diagnostic = diagnostic.trim().slice(-4096);
  return `${diagnostic || detail || 'git_stderr_unavailable'}\n`;
}
function recordWorktreeSetupFailure(state: WorkflowState, entry: WorkflowTaskState, startedAt: string,
  mode: 'fresh' | 'resume', error: unknown, privateEnvironment: NodeJS.ProcessEnv): void {
  const sequence = (entry.setupAttempts?.length ?? 0) + 1;
  const detail = worktreeSetupDetail(error);
  const artifact = writeTextArtifact({ path: join(artifactsRoot(state), `worktree-setup-${entry.worker}-${sequence}-${randomUUID()}.stderr.txt`),
    content: worktreeSetupStderr(error, detail, state, entry, privateEnvironment), exclusive: true, kind: 'workflow-worktree-setup',
    producer: { system: 'omc', component: 'team-workflow', worker: entry.worker }, retention: 'until-completion' });
  const savedArtifact = JSON.parse(JSON.stringify(artifact)) as ArtifactDescriptor;
  entry.setupAttempts = [...(entry.setupAttempts ?? []),
    { sequence, startedAt, mode, outcome: 'failed', error: 'workflow_worktree_setup_failed',
      ...(detail === undefined ? {} : { detail }), artifact: savedArtifact }];
  entry.status = 'failed'; entry.error = 'workflow_worktree_setup_failed'; delete entry.claimToken; delete entry.backoffUntil;
  entry.updatedAt = now();
}
type ReservedInvocationSettlement = {
  entry: WorkflowTaskState;
  invocation: WorkflowInvocation;
  outcome: 'completed' | 'failed';
  error?: string;
};
async function executeTask(state: WorkflowState, entry: WorkflowTaskState, command: string, resumeReason: string | undefined,
  prepared: PreparedWorkflowBinding | undefined, refAudit: WorkflowRefAudit,
  orchestrationHost: OrchestratorHost, settlements: ReservedInvocationSettlement[]): Promise<void> {
  const root = artifactsRoot(state);
  const balanced = state.options.mode === 'balanced';
  const resuming = resumeReason !== undefined;
  const setupMode = resuming ? 'resume' : 'fresh';
  let persistenceFailure: { error: unknown } | undefined;
  if (entry.attempts === 0 && !entry.setupAttempts?.length && entry.task.dependencies.length) {
    entry.task.baseCommit = state.dispatchSupplements?.find(supplement => supplement.taskId === entry.task.id)?.expectedInputHead
      ?? state.integrationHead;
  }
  while (entry.attempts < state.options.maxAttempts) {
    const setupStartedAt = now();
    try {
      const worktree = ensureWorkerWorktree(state.plan.name, entry.worker, state.cwd, { mode: 'named', baseRef: entry.task.baseCommit });
      if (!worktree) throw new Error('workflow_worktree_required');
      entry.worktree = worktree.path; entry.branch = worktree.branch;
      assertWorker(state, entry);
      if (git(entry.worktree, ['rev-parse', 'HEAD']) !== entry.task.baseCommit) throw new Error('workflow_worker_base_mismatch');
    } catch (error) {
      recordWorktreeSetupFailure(state, entry, setupStartedAt, setupMode, error, prepared?.redactionEnvironment ?? process.env);
      save(state);
      return;
    }
    entry.setupAttempts = [...(entry.setupAttempts ?? []),
      { sequence: (entry.setupAttempts?.length ?? 0) + 1, startedAt: setupStartedAt, mode: setupMode, outcome: 'completed' }];
    entry.status = 'pending'; delete entry.error; entry.updatedAt = now(); save(state);
    const started = Date.now();
    entry.attempts++; entry.status = 'running'; entry.claimToken = randomUUID(); entry.updatedAt = now();
    const invocation: WorkflowInvocation = { orchestrationHost, attempt: entry.attempts, mode: resuming ? 'resume' : 'fresh',
      ...(prepared ? { invocationId: randomUUID(), binding: prepared.binding, model: prepared.binding.model }
        : state.options.glmModel ? { model: state.options.glmModel } : {}), startedAt: now(), outcome: 'failed',
      controller: { pid: process.pid, processStartedAt: cachedCurrentProcessStartIdentity() },
      error: 'workflow_invocation_incomplete', ...(resumeReason === undefined ? {} : { reason: resumeReason }), artifacts: [],
      telemetry: { provider: prepared?.binding.providerRoute ?? legacyProvider(state), durationMs: 0, status: 'unknown', scope: 'unknown' } };
    (entry.invocations ??= []).push(invocation);
    const settlement: ReservedInvocationSettlement = { entry, invocation, outcome: 'failed', error: 'workflow_worker_persistence_failed' };
    settlements.push(settlement);
    let reservationSaved = false;
    let reservationFailure: { error: unknown } | undefined;
    try {
      save(state); reservationSaved = true;
      const prefix = join(root, `${entry.worker}-${entry.attempts}`);
      const resultFile = `${prefix}.result.json`;
      if (existsSync(resultFile)) throw new Error('workflow_result_already_exists');
      const prompt = buildWorkflowPrompt(state, entry, resultFile);
      const publication = issueWorkflowPublication({
        workflowRoot: state.cwd,
        workflowName: state.plan.name,
        taskId: entry.task.id,
        worker: entry.worker,
        attempt: entry.attempts,
        worktree: entry.worktree,
        resultFile,
      });
      const sessionEnabled = balanced && (!prepared || prepared.binding.capabilities.includes('session-resume'));
      if (balanced) {
        invocation.promptFingerprint = workflowPromptFingerprint(prompt);
        invocation.contextFingerprint = workflowContextFingerprint(state, entry);
      }
      if (sessionEnabled) {
        const worktree = realpathSync(entry.worktree);
        const fingerprint = prepared ? workflowPromptFingerprint(JSON.stringify({ binding: prepared.binding, worktree, branch: entry.branch,
          context: workflowSessionFingerprint(state, entry, command, worktree) })) : sessionFingerprint(state, entry, command, worktree);
        if (resuming && (!entry.session?.confirmed || entry.session.fingerprint !== fingerprint)) throw new Error('workflow_session_identity_changed');
        entry.session = { id: resuming ? entry.session!.id : randomUUID(), confirmed: false, fingerprint,
          worktree, branch: entry.branch!, ...(prepared ? { binding: prepared.binding } : {}) };
      }
      if (balanced) save(state);
      let result: Awaited<ReturnType<typeof runWorkflowProvider>>;
      refAudit?.providerStarted(entry.worker);
      try {
        result = await runWorkflowProvider({ command, args: prepared ? workflowWorkerArguments(prepared,
          sessionEnabled ? { id: entry.session!.id, resume: resuming } : undefined) : [...buildLaunchArgs(legacyProvider(state), {
          teamName: state.plan.name, workerName: entry.worker, cwd: entry.worktree, model: state.options.glmModel,
        }), '-p', ...(balanced ? [resuming ? '--resume' : '--session-id', entry.session!.id, '--output-format', 'stream-json', '--verbose'] : [])],
        cwd: entry.worktree, stdin: prompt, ...(balanced ? { collectUsage: true } : {}),
        onSpawn: identity => { invocation.process = identity; save(state); },
        timeoutMs: providerTimeoutMs(state), artifactPrefix: prefix, provider: prepared?.binding.providerRoute ?? legacyProvider(state), worker: entry.worker,
        publicationEnvironment: publication.environment,
        ...(prepared ? { environment: prepared.environment, redactionEnvironment: prepared.redactionEnvironment } : {}) }, resultFile,
        { kind: 'worker-designated-result', taskId: entry.task.id });
        recordWorkflowProcessResult(invocation, result);
        invocation.telemetry = result.telemetry ?? { provider: prepared?.binding.providerRoute ?? legacyProvider(state), durationMs: Date.now() - started, status: 'unknown', scope: 'unknown' };
        invocation.artifacts = result.artifacts;
        // Preserve the observed process outcome before cleanup or any untrusted result validation.
        save(state);
      } finally {
        try { publication.revoke(); }
        finally { refAudit?.providerCompleted(entry.worker); }
      }
      entry.handoff = { taskId: entry.task.id, outcome: 'failed', changedFiles: [], tests: [], interfaceChanges: [], assumptions: [], risks: [], summary: result.error ?? 'Worker result pending validation', artifacts: result.artifacts };
      if (sessionEnabled) {
        if (result.telemetry?.sessionId && result.telemetry.sessionId !== entry.session!.id
          || result.telemetry?.diagnostics?.some(diagnostic => ['session_identity_conflict', 'session_identity_invalid'].includes(diagnostic))) {
          throw new Error('workflow_session_identity_mismatch');
        }
        entry.session!.confirmed = result.telemetry?.sessionId === entry.session!.id;
      }
      let handoff: WorkflowHandoff | undefined;
      let handoffError = result.outputError;
      if (!handoffError) {
        try {
          validateResolvedPath(result.outputArtifactPath, root);
          handoff = parseWorkflowHandoff(result.output, entry.task.id);
        } catch (error) { handoffError = error; }
      }
      if (!result.passed && !(handoff && designatedResultOverridesProcessFailure(result, handoff))) {
        throw new Error(`workflow_${result.error}`);
      }
      if (handoffError) throw handoffError;
      if (!handoff) throw new Error('workflow_invalid_result');
      // Provider result is untrusted text: never persist credentials returned in a handoff.
      const safeHandoff = parseWorkflowHandoff(JSON.parse(redactWorkflowText(JSON.stringify(handoff))), entry.task.id);
      entry.handoff = { ...safeHandoff, artifacts: [...result.artifacts, createArtifactDescriptorFromPath(result.outputArtifactPath, {
        kind: 'workflow-result', producer: { system: 'omc', component: 'team-workflow', worker: entry.worker }, retention: 'until-completion',
      })] };
      invocation.artifacts = entry.handoff.artifacts.slice(0, 3);
      if (handoff.outcome !== 'completed' || handoff.tests.some(test => !test.passed)) throw new Error('workflow_worker_reported_failure');
      for (const test of entry.task.tests) if (!handoff.tests.some(result => result.passed && result.command === test.command && JSON.stringify(result.args) === JSON.stringify(test.args))) throw new Error('workflow_worker_test_evidence_missing');
      validateCommit(state, entry);
      try {
        for (const [index, test] of entry.task.tests.entries()) {
          const check = await runWorkflowProcess({ ...test, cwd: entry.worktree, timeoutMs: state.options.timeoutMs,
            artifactPrefix: `${prefix}.test-${index}`, worker: entry.worker });
          entry.handoff.artifacts.push(...check.artifacts);
          if (!check.passed) throw new Error('workflow_worker_test_failed');
        }
      } finally { refAudit?.controllerReplayCompleted(); }
      validateCommit(state, entry);
      entry.status = 'completed'; delete entry.error; break;
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      entry.error = !reservationSaved ? 'workflow_worker_persistence_failed'
        : /^workflow_[a-z_]+$/.test(message) ? message : 'workflow_worker_failed';
      entry.status = 'failed';
      if (!reservationSaved) {
        invocation.outcome = 'failed'; invocation.error = entry.error;
        reservationFailure = { error }; persistenceFailure = reservationFailure; break;
      }
      if (state.schemaVersion === 2) break;
      if (resuming) break;
      // A wall-less provider can end without a complete stream; that is terminal, not a retry prompt.
      if (nonRetryableWorkerError(entry.error)) break;
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
      if (state.schemaVersion === 1) {
        if (!invocation.telemetry.durationMs) invocation.telemetry.durationMs = Date.now() - started;
      }
      settlement.outcome = entry.status === 'completed' ? 'completed' : 'failed';
      settlement.error = entry.error;
      delete entry.claimToken; delete entry.backoffUntil; entry.updatedAt = now();
      try { save(state); }
      catch (error) {
        persistenceFailure = { error: reservationFailure
          ? new AggregateError([reservationFailure.error, error], 'workflow_worker_persistence_failed', { cause: reservationFailure.error }) : error };
      }
    }
    if (persistenceFailure) break;
  }
  if (persistenceFailure) throw persistenceFailure.error;
}
function attachRefAudit(entries: WorkflowTaskState[], artifact: ArtifactDescriptor | undefined): void {
  if (!artifact) return;
  for (const entry of entries) {
    if (entry.handoff && !entry.handoff.artifacts.some(item => item.path === artifact.path)) entry.handoff.artifacts.push(artifact);
    const invocation = entry.invocations?.at(-1);
    if (invocation?.error === 'workflow_invocation_incomplete' && !invocation.artifacts.some(item => item.path === artifact.path)) invocation.artifacts.push(artifact);
  }
}
function failProtectedRefs(entries: WorkflowTaskState[], balanced: boolean, onlyIncomplete = false,
  error = 'workflow_protected_refs_changed'): void {
  for (const entry of entries) if (balanced || entry.status === 'completed') {
    entry.status = 'failed'; entry.error = error;
    if (entry.session) entry.session.confirmed = false;
    const invocation = entry.invocations?.at(-1);
    if (invocation && (!onlyIncomplete || invocation.error === 'workflow_invocation_incomplete')) { invocation.outcome = 'failed'; invocation.error = entry.error; }
  }
}
function settleInvocations(settlements: ReservedInvocationSettlement[]): void {
  for (const settlement of settlements) {
    const invocation = settlement.invocation;
    if (invocation.error !== 'workflow_invocation_incomplete') continue;
    invocation.outcome = settlement.outcome;
    if (settlement.error) invocation.error = settlement.error; else delete invocation.error;
  }
}
export async function runWorkflow(cwd: string, name: string, runtime?: WorkflowRuntime): Promise<WorkflowState> {
  return mutate(cwd, name, async (state, active) => {
    assertLeader(state);
    const refAudit = new WorkflowRefAudit(cwd, name);
    // A killed owner is never silently re-spawned: retained running work requires inspection.
    if (state.tasks.some(entry => entry.status === 'running')) throw new Error('workflow_interrupted_worker_requires_inspection');
    assertNoIncompleteTaskInvocations(state);
    const candidates = state.tasks.filter(entry => ['pending', 'failed'].includes(entry.status) && entry.attempts < state.options.maxAttempts
      && !nonRetryableWorkerError(entry.error)
      && !(state.options.mode === 'balanced' && entry.invocations?.at(-1)?.mode === 'resume' && entry.invocations.at(-1)?.outcome === 'failed')
      && !(entry.setupAttempts?.at(-1)?.mode === 'resume' && entry.setupAttempts.at(-1)?.outcome === 'failed')
      && entry.task.dependencies.every(id => getTask(state, id).status === 'accepted'));
    if (!candidates.length) {
      if (state.schemaVersion === 2 && state.tasks.some(entry => entry.status === 'failed' && entry.attempts >= state.options.maxAttempts)) throw new Error('workflow_attempt_limit_reached');
      return;
    }
    let command = '';
    if (state.schemaVersion === 1) {
      try { command = resolveLegacyExecutable(state); } catch { throw new Error(`workflow_${legacyProvider(state)}_unavailable_fallback_disabled`); }
    }
    let cursor = 0;
    const settlements: ReservedInvocationSettlement[] = [];
    const pools = await Promise.allSettled(Array.from({ length: Math.min(state.options.workers, candidates.length) }, async () => {
      while (cursor < candidates.length && !state.tasks.some(entry => entry.error === 'workflow_interrupted')) {
        const entry = candidates[cursor++]!;
        const prepared = state.schemaVersion === 2 ? prepareBinding(state, state.bindings.implementer, runtime) : undefined;
        await executeTask(state, entry, prepared?.command ?? command, undefined, prepared, refAudit, active.host, settlements);
      }
    }));
    // A pool can stop during preflight before later candidates reserve an invocation. Ref failures apply only to this
    // batch's durable reservations; untouched pending tasks retain their original state for a later inspected run.
    const reservedEntries = [...new Set(settlements.map(settlement => settlement.entry))];
    try {
      const failedPool = pools.find(pool => pool.status === 'rejected');
      if (state.schemaVersion === 1 && failedPool?.status === 'rejected') throw new Error('workflow_worker_persistence_failed', { cause: failedPool.reason });
      let audit;
      try {
        audit = refAudit.finalize(() => join(artifactsRoot(state), `ref-audit-${randomUUID()}.json`),
          reservedEntries.map(entry => ({ worker: entry.worker, commitSha: entry.handoff?.commitSha })));
      } catch {
        failProtectedRefs(reservedEntries, state.options.mode === 'balanced', state.schemaVersion === 2, 'workflow_protected_ref_audit_failed');
        throw new Error('workflow_protected_ref_audit_failed');
      }
      attachRefAudit(reservedEntries, audit.artifact);
      if (audit.outcome === 'protected-refs-changed') {
        failProtectedRefs(reservedEntries, state.options.mode === 'balanced', state.schemaVersion === 2);
        throw new Error('workflow_protected_refs_changed');
      }
      const rejected = pools.find(pool => pool.status === 'rejected');
      if (rejected?.status === 'rejected') {
        if (state.schemaVersion === 2) throw rejected.reason;
        throw new Error('workflow_worker_persistence_failed');
      }
    } finally {
      settleInvocations(settlements);
    }
    state.stage = state.tasks.some(entry => entry.status === 'completed') ? 'integration' : 'implementation';
  });
}
/** Explicit continuation of a verified conversation in the same pristine task worktree. */
export async function resumeWorkflowTask(cwd: string, name: string, taskId: string, expectedHead: string, reason: string, runtime?: WorkflowRuntime): Promise<WorkflowState> {
  return mutate(cwd, name, async (state, active) => {
    if (state.options.mode !== 'balanced') throw new Error('workflow_balanced_mode_required');
    if (assertLeader(state) !== expectedHead) throw new Error('workflow_resume_head_mismatch');
    if (state.tasks.some(entry => entry.status === 'running')) throw new Error('workflow_interrupted_worker_requires_inspection');
    assertNoIncompleteTaskInvocations(state);
    const safeReason = redactWorkflowText(boundedText(reason, 1000));
    const entry = getTask(state, taskId);
    if (entry.status !== 'failed') throw new Error('workflow_resume_failed_task_required');
    if (entry.attempts >= state.options.maxAttempts) throw new Error('workflow_attempt_limit_reached');
    if (state.schemaVersion === 1 && !state.options.glmModel) throw new Error('workflow_resume_model_required');
    if (!entry.task.dependencies.every(id => getTask(state, id).status === 'accepted')) throw new Error('workflow_dependency_not_integrated');
    if (['workflow_worker_modified_protected_refs', 'workflow_protected_refs_changed', 'workflow_protected_ref_audit_failed',
      'workflow_session_identity_mismatch'].includes(entry.error ?? '')) throw new Error('workflow_session_not_resumable');
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
      try { command = resolveLegacyExecutable(state); } catch { throw new Error(`workflow_${legacyProvider(state)}_unavailable_fallback_disabled`); }
    }
    const fingerprint = prepared ? workflowPromptFingerprint(JSON.stringify({ binding: prepared.binding, worktree, branch: entry.branch,
      context: workflowSessionFingerprint(state, entry, command, worktree) })) : sessionFingerprint(state, entry, command, worktree);
    if (session.fingerprint !== fingerprint) throw new Error('workflow_session_identity_changed');
    const refAudit = new WorkflowRefAudit(cwd, name);
    const settlements: ReservedInvocationSettlement[] = [];
    let executionFailure: { error: unknown } | undefined;
    try { await executeTask(state, entry, command, safeReason, prepared, refAudit, active.host, settlements); }
    catch (error) { executionFailure = { error }; }
    try {
      let audit;
      try {
        audit = refAudit.finalize(() => join(artifactsRoot(state), `ref-audit-${randomUUID()}.json`),
          [{ worker: entry.worker, commitSha: entry.handoff?.commitSha }]);
      } catch {
        failProtectedRefs([entry], true, state.schemaVersion === 2, 'workflow_protected_ref_audit_failed');
        throw new Error('workflow_protected_ref_audit_failed');
      }
      attachRefAudit([entry], audit.artifact);
      if (audit.outcome === 'protected-refs-changed') {
        failProtectedRefs([entry], true, state.schemaVersion === 2);
        throw new Error('workflow_protected_refs_changed');
      }
    } finally { settleInvocations(settlements); }
    if (executionFailure) throw executionFailure.error;
    state.stage = getTask(state, taskId).status === 'completed' ? 'integration' : 'implementation';
  });
}
export async function acceptWorkflowTask(cwd: string, name: string, taskId: string): Promise<WorkflowState> {
  return mutate(cwd, name, async state => {
    assertLeader(state);
    assertNoIncompleteTaskInvocations(state);
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
/** Attach one lead-authorized clarification to a still-unstarted dependent task. */
export async function supplementWorkflowTask(cwd: string, name: string, rawIntent: unknown): Promise<WorkflowState> {
  const input: WorkflowDispatchSupplementIntent = parseWorkflowDispatchSupplementIntent(rawIntent);
  if (redactWorkflowText(JSON.stringify(input)) !== JSON.stringify(input)) throw new Error('workflow_sensitive_input_rejected');
  return mutate(cwd, name, async (state, active) => {
    if (state.options.mode !== 'balanced') throw new Error('workflow_balanced_mode_required');
    const head = assertLeader(state);
    if (head !== input.expectedInputHead) throw new Error('workflow_dispatch_supplement_head_mismatch');
    if (state.tasks.some(entry => entry.status === 'running')) throw new Error('workflow_interrupted_worker_requires_inspection');
    assertNoIncompleteTaskInvocations(state);
    if ((state.dispatchSupplements?.length ?? 0) >= 32) throw new Error('workflow_dispatch_supplement_limit_reached');
    if (state.dispatchSupplements?.some(entry => entry.taskId === input.taskId)) {
      throw new Error('workflow_dispatch_supplement_already_exists');
    }
    const entry = getTask(state, input.taskId);
    if (entry.status !== 'pending' || entry.attempts !== 0 || !entry.task.dependencies.length
      || entry.invocations !== undefined || entry.setupAttempts !== undefined || entry.session !== undefined
      || entry.handoff !== undefined || entry.claimToken !== undefined || entry.worktree !== undefined || entry.branch !== undefined
      || entry.backoffUntil !== undefined || entry.findingIds !== undefined || entry.error !== undefined) {
      throw new Error('workflow_dispatch_supplement_unstarted_task_required');
    }
    if (!entry.task.dependencies.every(id => getTask(state, id).status === 'accepted')) {
      throw new Error('workflow_dependency_not_integrated');
    }
    if (input.actor.id !== 'unknown' && (state.schemaVersion !== 2
      || input.actor.id !== state.bindings.lead.id || input.actor.model !== state.bindings.lead.model)) {
      throw new Error('workflow_dispatch_supplement_actor_mismatch');
    }
    const receipt = parseWorkflowDispatchSupplement({ ...input,
      sequence: (state.dispatchSupplements?.length ?? 0) + 1, orchestrationHost: active.host, at: now() });
    state.dispatchSupplements = [...(state.dispatchSupplements ?? []), receipt];
  });
}
/** Append one attributed review-budget extension without changing consumed review history or dispatching work. */
export async function extendWorkflowReviewBudget(cwd: string, name: string, rawIntent: unknown): Promise<WorkflowState> {
  const input: WorkflowReviewBudgetExtensionIntent = parseWorkflowReviewBudgetExtensionIntent(rawIntent);
  if (redactWorkflowText(JSON.stringify(input)) !== JSON.stringify(input)) throw new Error('workflow_sensitive_input_rejected');
  return mutate(cwd, name, async (state, active) => {
    const existing = state.reviewBudgetExtensions?.find(entry => entry.requestId === input.requestId);
    if (existing) {
      const replay = existing.head === input.expectedHead && existing.oldCeiling === input.expectedCeiling
        && existing.newCeiling === input.expectedCeiling + input.increment
        && existing.actor.id === input.actor.id && existing.actor.model === input.actor.model
        && existing.authorityRef === input.authorityRef && existing.reason === input.reason;
      if (replay) return false;
      throw new Error('workflow_review_budget_extension_request_conflict');
    }
    assertMutable(state);
    if (input.actor.id !== 'unknown' && state.schemaVersion === 2
      && (input.actor.id !== state.bindings.lead.id || input.actor.model !== state.bindings.lead.model)) {
      throw new Error('workflow_review_budget_extension_actor_mismatch');
    }
    const head = assertLeader(state);
    if (head !== input.expectedHead) throw new Error('workflow_review_budget_extension_head_mismatch');
    if (state.tasks.some(entry => entry.status === 'running')) throw new Error('workflow_controller_not_idle');
    assertNoIncompleteTaskInvocations(state);
    assertNoIncompleteReviewInvocations(state);
    const oldCeiling = workflowReviewCeiling(state);
    if (input.expectedCeiling !== oldCeiling) throw new Error('workflow_review_budget_extension_stale');
    if (workflowReviewBudgetUsed(state) !== oldCeiling) throw new Error('workflow_review_budget_not_exhausted');
    const receipt = parseWorkflowReviewBudgetExtension({ sequence: (state.reviewBudgetExtensions?.length ?? 0) + 1,
      requestId: input.requestId, oldCeiling, newCeiling: oldCeiling + input.increment, head,
      orchestrationHost: active.host, actor: input.actor, authorityRef: input.authorityRef, reason: input.reason, at: now() });
    state.reviewBudgetExtensions = [...(state.reviewBudgetExtensions ?? []), receipt];
  }, { allowComplete: true });
}
/** The immutable receipt path for one attributed compatibility adoption. */
function reviewCompatibilityReceiptPath(state: WorkflowState, sequence: number): string {
  return join(artifactsRoot(state), `review-compatibility-adoption-${sequence}.json`);
}
/**
 * Record one explicit administrative review-compatibility adoption. This is a supported lead
 * operation under the ordinary operation/lease gate: it consumes no review, changes no saved
 * plan/option/binding/pin/counter, and appends exactly one immutable attributed receipt.
 */
export async function adoptWorkflowReviewCompatibility(cwd: string, name: string, rawIntent: unknown): Promise<WorkflowState> {
  const input: WorkflowReviewCompatibilityAdoptionIntent = parseWorkflowReviewCompatibilityAdoptionIntent(rawIntent);
  if (redactWorkflowText(JSON.stringify(input)) !== JSON.stringify(input)) throw new Error('workflow_sensitive_input_rejected');
  return mutate(cwd, name, async (state, active) => {
    const existing = state.reviewCompatibilityAdoptions?.find(entry => entry.requestId === input.requestId);
    if (existing) {
      const replay = existing.source.baseCommit === input.source.baseCommit && existing.source.head === input.source.head
        && isDeepStrictEqual(existing.source.descriptor, input.source.descriptor) && isDeepStrictEqual(existing.controller, input.controller)
        && isDeepStrictEqual(existing.reader, input.reader) && isDeepStrictEqual(existing.transport, input.transport)
        && existing.reviewerBindingId === input.reviewerBindingId
        && existing.reviewerAuthFingerprint === input.reviewerAuthFingerprint
        && existing.actor.id === input.actor.id && existing.actor.model === input.actor.model
        && existing.authorityRef === input.authorityRef && existing.reason === input.reason;
      if (replay) return false;
      throw new Error('workflow_review_compatibility_request_conflict');
    }
    assertMutable(state);
    if (state.schemaVersion !== 2) throw new Error('workflow_role_substitution_profile_required');
    if (input.actor.id !== 'unknown'
      && (input.actor.id !== state.bindings.lead.id || input.actor.model !== state.bindings.lead.model)) {
      throw new Error('workflow_review_compatibility_actor_mismatch');
    }
    const head = assertLeader(state);
    // The adopted source is the final-PR pair: its head is the reviewed integration head, and its
    // base is the final PR's own base — deliberately allowed to differ from the plan's narrower task
    // base, but only if it is a real commit the reviewed head actually descends from. Either guard
    // refuses a swapped, narrowed or invented pair before anything is recorded.
    if (head !== input.source.head) throw new Error('workflow_review_compatibility_head_mismatch');
    if (input.source.baseCommit === input.source.head
      || !isWorkflowReviewAncestor(state.cwd, input.source.baseCommit, input.source.head)) {
      throw new Error('workflow_review_compatibility_base_mismatch');
    }
    if (state.tasks.some(entry => entry.status === 'running')) throw new Error('workflow_controller_not_idle');
    assertNoIncompleteTaskInvocations(state);
    assertNoIncompleteReviewInvocations(state);
    // The adopted reader is supplied to the selected reviewer only; the adoption names its identity.
    if (input.reviewerBindingId !== state.bindings.reviewer.id) throw new Error('workflow_review_compatibility_actor_mismatch');
    if (input.reviewerAuthFingerprint !== state.bindings.reviewer.authFingerprint) throw new Error('workflow_review_compatibility_reviewer_identity_changed');
    // The adoption binds the versioned per-response/per-buffer transport policy only; any total
    // context/request/source ceiling was already refused while parsing the intent.
    if (!isDeepStrictEqual(input.transport, workflowReviewTransportPolicy())) throw new Error('workflow_review_compatibility_transport_unsupported');
    if (!sameReviewBuildIdentity(input.controller, workflowReviewControllerBuildIdentity())) throw new Error('workflow_review_compatibility_controller_mismatch');
    if (!sameReviewBuildIdentity(input.reader, workflowReviewReaderBuildIdentity())) throw new Error('workflow_review_compatibility_reader_mismatch');
    // The intent names an immutable disk manifest, not a prospective file list. The descriptor is
    // verified against the manifest's bytes, record count and content digest on disk right now, and
    // every member is proven to be a tracked file of the reviewed checkout, so a manifest rewritten,
    // truncated, added to or omitted from — and a member that is untracked, private to the worktree
    // or an alias — refuses here rather than being recorded as the authorized source.
    const descriptor = input.source.descriptor;
    if (!descriptor) throw new Error('workflow_review_compatibility_source_required');
    verifyWorkflowReviewSourceManifestDescriptor(descriptor);
    verifyWorkflowReviewAuthorizedMembership({ cwd: state.cwd, descriptor });
    const receipt = parseWorkflowReviewCompatibilityAdoption({ sequence: (state.reviewCompatibilityAdoptions?.length ?? 0) + 1,
      requestId: input.requestId, source: { ...input.source }, controller: input.controller, reader: input.reader,
      transport: input.transport, reviewerBindingId: input.reviewerBindingId, reviewerAuthFingerprint: input.reviewerAuthFingerprint,
      actor: input.actor, authorityRef: input.authorityRef, reason: input.reason, orchestrationHost: active.host, at: now() });
    writeTextArtifact({ path: reviewCompatibilityReceiptPath(state, receipt.sequence), content: `${JSON.stringify(receipt, null, 2)}\n`,
      exclusive: true, kind: 'workflow-review-compatibility-adoption',
      producer: { system: 'omc', component: 'team-workflow' }, retention: 'until-completion' });
    state.reviewCompatibilityAdoptions = [...(state.reviewCompatibilityAdoptions ?? []), receipt];
  }, { allowComplete: true });
}
/** The sole .omc source exception must stay a tracked regular file, separate from runtime storage. */
function assertLeadRoutingPolicy(cwd: string, head: string): void {
  try {
    // Native canonicalization expands Windows short names and drive/component casing.
    const repositoryRoot = expandPathForCompare(cwd);
    if (!repositoryRoot || expandPathForCompare(git(cwd, ['rev-parse', '--show-toplevel'])) !== repositoryRoot) throw new Error('invalid');
    const entry = /^(100(?:644|755)) blob ([a-f0-9]{40}(?:[a-f0-9]{24})?)\t\.omc\/routing\.md\0$/
      .exec(gitRaw(cwd, ['ls-tree', '-z', head, '--', '.omc/routing.md']));
    if (!entry) throw new Error('invalid');
    const root = join(repositoryRoot, '.omc');
    if (!lstatSync(root).isDirectory()) throw new Error('invalid');
    const policy = lstatSync(join(root, 'routing.md'));
    if (!policy.isFile() || policy.nlink !== 1) throw new Error('invalid');
    // Do not adopt a spelling that collides with the policy or runtime root on another platform.
    if (readdirSync(cwd).some(name => name !== '.omc' && /^\.omc[. ]*$/i.test(name))
      || readdirSync(root).some(name => name !== 'routing.md' && /^routing\.md[. ]*$/i.test(name))) throw new Error('invalid');
    // Status alone can hide edits via index flags or a stale stat cache; hash using Git's clean filters.
    if (gitRaw(cwd, ['ls-files', '--stage', '-z', '--', '.omc/routing.md']) !== `${entry[1]} ${entry[2]} 0\t.omc/routing.md\0`
      || gitRaw(cwd, ['ls-files', '-v', '-z', '--', '.omc/routing.md']) !== 'H .omc/routing.md\0'
      || git(cwd, ['hash-object', '--path=.omc/routing.md', '--', '.omc/routing.md']) !== entry[2]) throw new Error('invalid');
  } catch { throw new Error('workflow_lead_integration_routing_policy_invalid'); }
}
/** Adopt one explicit lead-authored direct child of the saved integration head. */
export async function integrateWorkflowLeadCommit(cwd: string, name: string, rawIntent: unknown): Promise<WorkflowState> {
  const input: WorkflowLeadIntegrationIntent = parseWorkflowLeadIntegrationIntent(rawIntent);
  if (redactWorkflowText(JSON.stringify(input)) !== JSON.stringify(input)) throw new Error('workflow_sensitive_input_rejected');
  return mutate(cwd, name, async (state, active) => {
    integrated(state);
    assertNoIncompleteReviewInvocations(state);
    if (state.reviews.some(review => review.findings.some(finding => !finding.disposition
      || finding.disposition === 'fix' && !finding.fixedBy))) throw new Error('workflow_findings_require_adjudication_or_fix');
    if (git(cwd, ['branch', '--show-current']) !== state.plan.integrationBranch) throw new Error('workflow_integration_branch_mismatch');
    if (!clean(cwd)) throw new Error('workflow_integration_worktree_dirty');
    if (input.expectedParent !== state.integrationHead) throw new Error('workflow_lead_integration_parent_mismatch');
    const head = git(cwd, ['rev-parse', 'HEAD']);
    const branchHead = git(cwd, ['rev-parse', `refs/heads/${state.plan.integrationBranch}`]);
    if (head !== input.expectedHead || branchHead !== input.expectedHead) throw new Error('workflow_lead_integration_head_mismatch');
    const parents = git(cwd, ['rev-list', '--parents', '-n', '1', input.expectedHead]).split(' ');
    if (parents.length !== 2 || parents[1] !== input.expectedParent
      || git(cwd, ['rev-list', '--count', `${input.expectedParent}..${input.expectedHead}`]) !== '1') {
      throw new Error('workflow_lead_integration_single_commit_required');
    }
    const changedFiles = gitRaw(cwd, ['diff', '--name-only', '--no-renames', '-z', input.expectedParent, input.expectedHead])
      .split('\0').filter(Boolean);
    if (!changedFiles.length || changedFiles.length > 100
      || JSON.stringify([...changedFiles].sort()) !== JSON.stringify([...input.paths].sort())) {
      throw new Error('workflow_lead_integration_changed_files_mismatch');
    }
    if (state.schemaVersion === 2 && input.actor.id !== 'unknown'
      && (input.actor.id !== state.bindings.lead.id || input.actor.model !== state.bindings.lead.model)) {
      throw new Error('workflow_lead_integration_actor_mismatch');
    }
    const includesRoutingPolicy = changedFiles.includes('.omc/routing.md');
    if (includesRoutingPolicy) assertLeadRoutingPolicy(cwd, input.expectedHead);
    const refs = git(cwd, ['for-each-ref', '--format=%(refname) %(objectname)']);
    const checks = [];
    for (const [index, command] of input.checks.entries()) {
      const result = await runWorkflowProcess({ ...command, cwd, timeoutMs: state.options.timeoutMs,
        artifactPrefix: join(artifactsRoot(state), `lead-integration-${(state.leadIntegrations?.length ?? 0) + 1}-${index}-${randomUUID()}`) });
      try {
        if (git(cwd, ['for-each-ref', '--format=%(refname) %(objectname)']) !== refs
          || git(cwd, ['branch', '--show-current']) !== state.plan.integrationBranch
          || git(cwd, ['rev-parse', 'HEAD']) !== input.expectedHead || !clean(cwd)) throw new Error('changed');
        if (includesRoutingPolicy) assertLeadRoutingPolicy(cwd, input.expectedHead);
      } catch { throw new Error('workflow_lead_integration_repository_changed'); }
      if (!result.passed) throw new Error('workflow_lead_integration_check_failed');
      checks.push({ command, passed: true as const, artifacts: result.artifacts });
    }
    const record = parseWorkflowLeadIntegration({ sequence: (state.leadIntegrations?.length ?? 0) + 1,
      parent: input.expectedParent, head: input.expectedHead, changedFiles, orchestrationHost: active.host,
      actor: input.actor, authorityRef: input.authorityRef, reason: input.reason, checks, at: now() });
    state.leadIntegrations = [...(state.leadIntegrations ?? []), record];
    state.integrationHead = input.expectedHead;
    delete state.verification;
    state.stage = 'integration';
  });
}
/** Revalidate one retained completed handoff under current repository evidence. */
export async function recoverWorkflowTask(cwd: string, name: string, taskId: string, rawIntent: unknown): Promise<WorkflowState> {
  const input: WorkflowTaskRecoveryIntent = parseWorkflowTaskRecoveryIntent(rawIntent);
  if (redactWorkflowText(JSON.stringify(input)) !== JSON.stringify(input)) throw new Error('workflow_sensitive_input_rejected');
  taskId = safeWorkflowId(taskId);
  return mutate(cwd, name, async (state, active) => {
    const existing = state.taskRecoveries?.find(entry => entry.requestId === input.requestId);
    if (existing) {
      const replay = existing.taskId === taskId && existing.head === input.expectedHead
        && existing.refsDigestBefore === input.expectedRefsDigest && existing.refsDigestAfter === input.expectedRefsDigest
        && existing.taskCommit === input.expectedTaskCommit
        && existing.actor.id === input.actor.id && existing.actor.model === input.actor.model
        && existing.authorityRef === input.authorityRef && existing.reason === input.reason;
      if (replay) return false;
      throw new Error('workflow_task_recovery_request_conflict');
    }
    assertMutable(state);
    if (input.actor.id !== 'unknown' && state.schemaVersion === 2
      && (input.actor.id !== state.bindings.lead.id || input.actor.model !== state.bindings.lead.model)) {
      throw new Error('workflow_task_recovery_actor_mismatch');
    }
    if (state.tasks.some(entry => entry.status === 'running')) throw new Error('workflow_controller_not_idle');
    assertNoIncompleteTaskInvocations(state);
    assertNoIncompleteReviewInvocations(state);
    const head = assertLeader(state);
    if (head !== input.expectedHead) throw new Error('workflow_task_recovery_head_mismatch');
    const inspected = inspectWorkflowTaskState(state, taskId);
    const inspectionErrors: Record<WorkflowTaskInspection['classification'], string> = {
      'recoverable-completed-handoff': '',
      'dirty-partial': 'workflow_task_recovery_worktree_dirty',
      failed: 'workflow_task_recovery_evidence_mismatch',
      missing: 'workflow_task_recovery_evidence_missing',
      active: 'workflow_interrupted_worker_requires_inspection',
      unverifiable: 'workflow_task_recovery_unverifiable',
    };
    if (inspected.classification !== 'recoverable-completed-handoff') {
      throw new Error(inspectionErrors[inspected.classification]);
    }
    const entry = getTask(state, taskId);
    if (entry.status !== 'failed') throw new Error('workflow_task_recovery_task_not_failed');
    const oldError = entry.error;
    if (!oldError) throw new Error('workflow_task_recovery_evidence_mismatch');
    if (inspected.expectedRefsDigest !== input.expectedRefsDigest) throw new Error('workflow_task_recovery_refs_mismatch');
    if (inspected.savedHead !== input.expectedTaskCommit || inspected.observedHead !== input.expectedTaskCommit) {
      throw new Error('workflow_task_recovery_commit_mismatch');
    }
    const protectedRefAuditContentHash = oldError === 'workflow_protected_refs_changed'
      ? (() => {
          if (!hasRecoverableProtectedRefAudit(state, entry)) throw new Error('workflow_task_recovery_evidence_mismatch');
          return entry.handoff!.artifacts.find(artifact => artifact.kind === 'workflow-protected-ref-audit')!.contentHash;
        })()
      : undefined;
    const checks = [];
    for (const [index, command] of entry.task.tests.entries()) {
      const result = await runWorkflowProcess({ ...command, cwd: entry.worktree!, timeoutMs: state.options.timeoutMs,
        artifactPrefix: join(artifactsRoot(state), `task-recovery-${taskId}-${(state.taskRecoveries?.length ?? 0) + 1}-${index}-${randomUUID()}`) });
      try {
        const current = inspectWorkflowTaskState(state, taskId);
        if (assertLeader(state) !== input.expectedHead || workflowRefsDigest(state.cwd) !== input.expectedRefsDigest
          || current.classification !== 'recoverable-completed-handoff'
          || current.expectedRefsDigest !== input.expectedRefsDigest || current.savedHead !== input.expectedTaskCommit
          || current.observedHead !== input.expectedTaskCommit || !current.clean || !current.registered) throw new Error('changed');
      } catch { throw new Error('workflow_task_recovery_repository_changed'); }
      if (!result.passed) throw new Error('workflow_task_recovery_check_failed');
      checks.push({ command, passed: true as const, artifacts: result.artifacts });
    }
    const refsDigestAfter = workflowRefsDigest(state.cwd);
    if (refsDigestAfter !== input.expectedRefsDigest) throw new Error('workflow_task_recovery_repository_changed');
    const receipt = parseWorkflowTaskRecovery({ sequence: (state.taskRecoveries?.length ?? 0) + 1,
      taskId, requestId: input.requestId, oldError, taskCommit: input.expectedTaskCommit,
      baseCommit: entry.task.baseCommit, head, refsDigestBefore: input.expectedRefsDigest, refsDigestAfter,
      orchestrationHost: active.host, actor: input.actor, authorityRef: input.authorityRef, reason: input.reason,
      checks, ...(protectedRefAuditContentHash === undefined ? {} : { protectedRefAuditContentHash }), at: now() });
    appendWorkflowTaskRecovery(state, receipt);
    state.stage = 'integration';
  }, { allowComplete: true });
}
export async function rejectWorkflowTask(cwd: string, name: string, taskId: string, reason: string): Promise<WorkflowState> {
  return mutate(cwd, name, async state => {
    const entry = getTask(state, taskId);
    const safeReason = redactWorkflowText(boundedText(reason, 1000));
    // Explicit rejection is the inspected settlement for an attempt orphaned by a dead controller.
    if (entry.status === 'running' || hasTrailingIncompleteInvocation(entry)) settleOrphanedAttempt(state, entry);
    if (!['pending', 'completed', 'failed'].includes(entry.status)) throw new Error('workflow_task_cannot_be_rejected');
    entry.status = 'rejected'; entry.error = safeReason; entry.updatedAt = now();
  });
}
function integrated(state: WorkflowState): void {
  assertNoIncompleteTaskInvocations(state);
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
/**
 * The changed-path list of the final-PR pair, then every task-scoped path, emitted one exact path at
 * a time. The Git listing is spooled to a private file as NUL-delimited literal UTF-8 bytes and walked
 * one record at a time — no default `maxBuffer`, no trim and no unquoting — so a tracked path holding
 * spaces, quotes, backslashes or non-ASCII bytes is delivered exactly as Git recorded it and a change
 * of any size is read without ever being buffered whole.
 */
function* reviewAffectedPaths(state: WorkflowStateV2, baseCommit: string): Generator<string> {
  const scratch = mkdtempSync(join(tmpdir(), 'omc-review-affected-'));
  try {
    const listing = join(scratch, 'changed');
    spoolWorkflowReviewGit({ cwd: state.cwd, args: ['diff', '--name-only', '-z', baseCommit, state.integrationHead], path: listing });
    for (const path of iterateWorkflowReviewNulRecords(listing)) yield path;
  } finally { rmSync(scratch, { recursive: true, force: true }); }
  // Task scopes are already-held workflow state rather than an unbounded repository listing.
  for (const entry of state.tasks) {
    for (const path of entry.task.writeScope) yield path;
    for (const path of entry.task.readScope) yield path;
  }
}
/**
 * Every instruction path candidate of one affected path: the path itself and every ancestor
 * directory, deepest first — the emitted set is a superset of the governed instruction files, and
 * only the ones that exist are ever yielded.
 */
function* reviewInstructionCandidates(state: WorkflowStateV2, baseCommit: string): Generator<string> {
  yield 'AGENTS.md'; yield 'CLAUDE.md';
  let previousScope: string | undefined;
  for (const path of reviewAffectedPaths(state, baseCommit)) {
    if (!path) continue;
    const member = lstatSync(join(state.cwd, path), { throwIfNoEntry: false });
    let scope = member?.isFile() ? posix.dirname(path) : path;
    if (scope === previousScope) continue;
    previousScope = scope;
    while (scope !== '.' && scope !== '/' && scope !== '') {
      yield posix.join(scope, 'AGENTS.md');
      yield posix.join(scope, 'CLAUDE.md');
      const parent = posix.dirname(scope);
      if (parent === scope) break;
      scope = parent;
    }
  }
}
/**
 * The governed instruction set of the current integration: the root policy files plus every
 * ancestor policy of an affected or task-scoped path. Paths only — no content is read here, so the
 * compatibility freeze can stream each instruction straight to its bundle entry.
 *
 * Candidates are de-duplicated through a private on-disk key index, one exclusive-create key file per
 * distinct path, and emitted lazily, so a change touching any number of paths retains no path array
 * and no instruction set: uniqueness is proven on disk rather than in heap. The index is removed on
 * every exit path, including an abandoned walk.
 */
function* reviewInstructionPaths(state: WorkflowStateV2, baseCommit: string = state.plan.baseCommit): Generator<string> {
  const keys = mkdtempSync(join(tmpdir(), 'omc-review-instruction-keys-'));
  let failed = false;
  try {
    for (const path of reviewInstructionCandidates(state, baseCommit)) {
      // The key file holds the exact path that claimed the digest, not an empty marker: a second
      // candidate that hashes to the same key is compared against it, so two distinct governed
      // instructions can never be collapsed into one by a key collision. Only a byte-for-byte match
      // is the duplicate this index exists to suppress; anything else is refused.
      const key = join(keys, createHash('sha256').update(path, 'utf8').digest('hex'));
      try { writeFileSync(key, path, { flag: 'wx' }); }
      catch (error) {
        // Only an existing key means this path was already emitted. Any other failure is a real IO
        // failure, and reporting it as a duplicate would silently drop a governed instruction.
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        let claimed: string;
        try { claimed = readFileSync(key, 'utf8'); }
        catch { throw new Error('workflow_review_context_invalid'); }
        if (claimed !== path) throw new Error('workflow_review_context_invalid');
        continue;
      }
      const file = join(state.cwd, path);
      if (lstatSync(file, { throwIfNoEntry: false })) yield path;
    }
  } catch (error) { failed = true; throw error; }
  finally {
    if (failed) { try { rmSync(keys, { recursive: true, force: true }); } catch { /* preserve the first failure */ } }
    else rmSync(keys, { recursive: true, force: true });
  }
}
function reviewContext(state: WorkflowStateV2): { projectInstructions: Array<{ path: string; content: string }>; sourceInventory: string; changes: string } {
  // The legacy whole-request route still materializes its instruction array; the prospective
  // compatibility route walks the same discovery lazily and freezes each file straight to its entry.
  const projectInstructions = [...reviewInstructionPaths(state)].map(path => {
    const file = join(state.cwd, path); validateResolvedPath(file, state.cwd);
    // No per-instruction size ceiling: a complete governed instruction is delivered at its exact
    // bytes, and the read is a streaming read through the review-local source helper.
    if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) throw new Error('workflow_review_context_invalid');
    return { path, content: readWorkflowReviewSourceMember(state.cwd, path).bytes.toString('utf8') };
  });
  // Git inventory and the binary-safe patch are captured through the streaming spool path, so no
  // default `maxBuffer` and no trim can truncate an inventory or a diff larger than one buffer.
  const context = { projectInstructions, sourceInventory: readWorkflowReviewGitText(state.cwd, ['ls-files']),
    changes: readWorkflowReviewGitText(state.cwd, ['diff', '--no-ext-diff', '--no-textconv', '--patch', '--binary', state.plan.baseCommit, state.integrationHead]) };
  // There is deliberately no aggregate context ceiling: the complete material is delivered as-is.
  return context;
}
type WorkflowReviewContext = ReturnType<typeof reviewContext>;
/** The ordinary v2 review rules: the fixed, bounded instruction text of every v2 request. */
const WORKFLOW_REVIEW_V2_INSTRUCTIONS = 'Inspect the integrated code against baseCommit and complete acceptance criteria in this fresh read-only context. Self-review is permitted; do not claim independence from model or provider identity. Do not modify files, commits or refs or use command tools. Do not inspect worker transcripts. Return JSON findings with P0/P1/P2/P3 severities; finding.file must be a repository-relative POSIX path or null, for example src/example.ts. Do not return absolute paths or traversal segments.';
/**
 * The ordinary serialized review request: complete material, no aggregate ceiling. The compatibility
 * route never reaches this composer, so every unbounded field below stays off the compact request.
 */
function composeWorkflowReviewRequest(state: WorkflowState, context: WorkflowReviewContext | undefined, head: string): string {
  return JSON.stringify({ kind: 'review', baseCommit: state.plan.baseCommit, head, objective: state.plan.objective,
    tasks: state.tasks.filter(entry => entry.status === 'accepted').map(entry => ({ id: entry.task.id, contracts: entry.task.contracts, acceptanceCriteria: entry.task.acceptanceCriteria })),
    ...(context ? { ...context, sharedContext: state.plan.sharedContext ?? '' } : {}),
    instructions: state.schemaVersion === 2
      ? WORKFLOW_REVIEW_V2_INSTRUCTIONS
      : 'Independently inspect the integrated code against baseCommit and acceptance criteria. Read only: do not modify files, commits or refs. Do not inspect worker transcripts. Return the required JSON findings with P0/P1/P2/P3 severities. Each finding.file must be a repository-relative POSIX path or null, for example src/example.ts; do not return absolute paths or traversal segments.' });
}
/**
 * The compact compatibility request. It carries only fixed, bounded fields — the exact final-PR
 * pair, the constant rules and the fixed-shape reader descriptor — and names the objective, task
 * contracts, acceptance criteria, shared context, instructions, inventory, binary diff and every
 * authorized file only through the frozen bundle the reviewer pages. Nothing here grows with the
 * size of the change: every unbounded material was artifactized before the attempt was reserved, so
 * no total, and no file list, can appear in this request.
 */
function composeWorkflowReviewCompatibilityRequest(baseCommit: string, head: string,
  descriptor: Record<string, unknown>): string {
  return JSON.stringify({ kind: 'review', baseCommit, head,
    reviewSource: descriptor, instructions: WORKFLOW_REVIEW_V2_INSTRUCTIONS });
}
/** Digest of the running controller module, bound into an administrative adoption receipt. */
export function workflowReviewControllerBuildIdentity(): WorkflowReviewBuildIdentity {
  return { id: 'team-workflow', sha256: createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex') };
}
function sameReviewBuildIdentity(left: WorkflowReviewBuildIdentity, right: WorkflowReviewBuildIdentity): boolean {
  return left.id === right.id && left.sha256 === right.sha256;
}
/**
 * The complete effective invocation this review is about to run, computed prospectively and before
 * any attempt is reserved. It names everything that actually governs the reader the reviewer will
 * reach — the controller build, the reader build and the modules it imported, the reviewer CLI
 * path/digest/version, the provider route, the exact model and effort, the authenticated profile and
 * its fingerprint, the host and projected catalog digests, and the canonical reader/tool projection
 * fingerprint over the reader-only tool inventory. A host qualification that does not match every
 * one of these fields qualifies some other invocation, not this one.
 */
/**
 * The prospective effective invocation of one reviewer binding over its own reader projection.
 *
 * The fingerprint is taken over the *real* prospective reviewer argv — the provider flags, the model,
 * the effort, the sandbox and tool surface, the reader projection this invocation will carry and every
 * argument position — rather than over the reader overrides alone, and over the real reader module
 * path, the real catalog content identity and every binding control. Only the four paths this
 * controller invents inside one attempt (the frozen bundle directory, the per-attempt receipt ledger,
 * the projected-catalog staging file and the two reviewer result artifacts the argv names) are
 * normalized, because no host could predict them and their content identity is carried separately.
 * The reader identity and its imported dependency digests, the CLI path/digest/version, the route, the
 * exact model and effort, the authenticated profile and fingerprint and the input and projected
 * catalog digests all keep their real value, so a qualification for another invocation cannot match.
 */
export function workflowReviewProspectiveInvocation(binding: WorkflowRoleBinding, route: 'codex' | 'claude',
  catalog: WorkflowReviewCodexCatalogProjection | undefined, nativeFactory?: WorkflowNativeReviewClientFactory): WorkflowReviewEffectiveInvocation {
  const executable = binding.executableIdentity;
  if (!executable) throw new Error('workflow_runtime_required');
  const serverPath = workflowReviewSourceServerPath();
  const projected = workflowReviewProjectedReader({ route, serverPath, catalog: catalog !== undefined });
  const invocation = workflowReviewEffectiveInvocation({
    controller: workflowReviewControllerBuildIdentity(),
    reader: { ...workflowReviewReaderBuildIdentity(), dependencies: workflowReviewReaderDependencies() },
    cli: { path: executable.path, sha256: executable.sha256, version: executable.version },
    route, model: binding.model, effort: binding.effort ?? '',
    auth: { profile: binding.authProfileRef, fingerprint: binding.authFingerprint },
    catalog: { input: catalog ? catalog.input : null,
      projected: catalog ? { bytes: catalog.bytes, sha256: catalog.sha256 } : null },
    serverPath, carriesCatalog: catalog !== undefined,
    reviewerArguments: workflowReviewerProjectionArguments(binding, projected, { schemaFile: WORKFLOW_REVIEW_EPHEMERAL_PLACEHOLDERS.schema,
      resultFile: WORKFLOW_REVIEW_EPHEMERAL_PLACEHOLDERS.result, schema: reviewReviewerResultSchema(true) }) });
  return nativeFactory ? Object.freeze({ ...invocation, projection: workflowNativeReviewProjection({ binding,
    schema: reviewReviewerResultSchema(true), mcpServers: workflowNativeReviewServerNames(nativeFactory) }) }) : invocation;
}
export interface WorkflowReviewCompatibilitySelection {
  /** The attributed adoption receipt this review runs under. */
  readonly requestId: string;
  /**
   * The immutable disk manifest descriptor of the authorized source, restating the one the adoption
   * recorded. It is compared exactly, field by field, against the recorded descriptor before an
   * attempt is reserved: a selection that names another manifest, another revision or another byte
   * or record count is not the authority that was attributed and refuses here.
   */
  readonly descriptor: WorkflowReviewSourceManifestDescriptor;
}
export interface WorkflowReviewOptions {
  /** Explicit per-review compatibility selection; omission keeps the ordinary review path unchanged. */
  readonly compatibility?: WorkflowReviewCompatibilitySelection;
}
interface PreparedReviewCompatibility {
  readonly adoption: WorkflowReviewCompatibilityAdoption;
  readonly binding: WorkflowReviewCompatibilityBinding;
  readonly bundle: WorkflowReviewSourceBundle;
  /** The reader-intended ledger: what this controller's own reader served. Diagnostic evidence only. */
  readonly receiptsPath: string;
  /** The resolved, matching reader qualification this invocation is authorized by. */
  readonly qualification: WorkflowReviewReaderQualification;
  /** The same reader, projected for whichever provider route the reviewer binding selected. */
  readonly reader: WorkflowReviewReaderInvocation;
  readonly reviewerId: string;
  readonly descriptor: Record<string, unknown>;
}
/** The reviewer result schema additionally admits the compact coverage attestation. */
function reviewCoverageSchema(): Record<string, unknown> {
  return { type: 'object', additionalProperties: false, required: ['bundleSha256', 'reviewerId', 'complete', 'entries', 'ranges'],
    properties: { bundleSha256: { type: 'string', pattern: '^[a-f0-9]{64}$' }, reviewerId: { type: 'string', minLength: 1, maxLength: 200 },
      complete: { type: 'boolean' }, entries: { type: 'integer', minimum: 0 }, ranges: { type: 'integer', minimum: 0 } } };
}
/**
 * The reviewer result schema. It is one controller-fixed document, so the prospective invocation the
 * reader qualification is computed over carries exactly the schema this attempt writes to disk and
 * names in its argv: a compatibility review may only be accepted together with an attributed complete
 * delivery, so its schema additionally requires the compact coverage attestation.
 */
export function reviewReviewerResultSchema(compatibility: boolean): Record<string, unknown> {
  return { type: 'object', additionalProperties: false, required: compatibility ? ['findings', 'coverage'] : ['findings'], properties: {
    findings: { type: 'array', maxItems: 50, items: { type: 'object', additionalProperties: false, required: ['severity', 'message', 'file', 'line'], properties: {
      severity: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] }, message: { type: 'string', maxLength: 2000 },
      file: { type: ['string', 'null'], minLength: 1, maxLength: 400,
        // Provider regex subsets reject lookarounds; scopePath enforces traversal and reserved scopes locally.
        pattern: '^[^\\\\/:*?\\r\\n]+(/[^\\\\/:*?\\r\\n]+)*$' },
      line: { type: ['integer', 'null'] },
    } } },
    ...(compatibility ? { coverage: reviewCoverageSchema() } : {}),
  } };
}
/** Fixed slice size for a controller-composed text material: no material is ever written as one buffer. */
const WORKFLOW_REVIEW_MATERIAL_SLICE_BYTES = 32 * 1024;
const HIGH_SURROGATE = /[\uD800-\uDBFF]/;
const LOW_SURROGATE = /[\uDC00-\uDFFF]/;
/**
 * Re-emit one text value as ordered fixed-size slices, so it is never held as a single buffer. A slice
 * boundary that would fall between the two halves of a surrogate pair is moved one unit earlier and
 * the pair stays whole in the slice it starts in; the next slice resumes at that boundary rather than
 * at the fixed offset, so no code unit is dropped, duplicated or replaced by round-tripping a lone
 * surrogate through UTF-8.
 */
export function* reviewMaterialSlices(value: string): Generator<string> {
  let offset = 0;
  while (offset < value.length) {
    let end = Math.min(offset + WORKFLOW_REVIEW_MATERIAL_SLICE_BYTES, value.length);
    if (end < value.length && HIGH_SURROGATE.test(value[end - 1]!) && LOW_SURROGATE.test(value[end]!)) end -= 1;
    yield value.slice(offset, end);
    offset = end;
  }
}
/**
 * Emit the accepted task contracts and their complete acceptance criteria as one bounded fragment at
 * a time. The task set is never collected into a single serialized value, so the material's cost is
 * proportional to one fragment however many accepted tasks the workflow carries.
 */
function* reviewContractFragments(tasks: readonly WorkflowTaskState[]): Generator<string> {
  yield '[';
  let first = true;
  for (const entry of tasks) {
    if (entry.status !== 'accepted') continue;
    yield `${first ? '' : ','}{"id":${JSON.stringify(entry.task.id)},"contracts":${JSON.stringify(entry.task.contracts)}`
      + `,"acceptanceCriteria":${JSON.stringify(entry.task.acceptanceCriteria)}}`;
    first = false;
  }
  yield ']';
}
/**
 * Freeze the complete authorized material of one compatibility adoption onto disk.
 *
 * Every unbounded input is artifactized here, before any attempt is reserved: each governed
 * instruction and each authorized source file is streamed straight from the reviewed checkout, the
 * inventory and the binary-safe patch are spooled from Git with no `maxBuffer` and no trim, and the
 * objective and shared context are written as ordered fixed-size slices while the accepted task
 * contracts are emitted one bounded fragment at a time — nothing is assembled into one buffer, so a
 * change far larger than memory is frozen losslessly. The authorized path set arrives as a lazy
 * iterator over the adopted disk manifest, so it is consumed one bounded record at a time and is
 * never collected either. A failure anywhere removes the partial directory and leaves no bundle.
 */
function freezeWorkflowReviewCompatibilityBundle(state: WorkflowStateV2, adoption: WorkflowReviewCompatibilityAdoption,
  descriptor: WorkflowReviewSourceManifestDescriptor): WorkflowReviewSourceBundle {
  // A unique, not-yet-existing staging directory: the bundle refuses to write over anything.
  const staging = join(tmpdir(), `omc-review-source-${randomUUID()}`);
  const scratch = mkdtempSync(join(tmpdir(), 'omc-review-spool-'));
  let failed = false;
  try {
    const inventory = join(scratch, 'inventory');
    spoolWorkflowReviewGit({ cwd: state.cwd, args: ['ls-files'], path: inventory });
    const changes = join(scratch, 'changes');
    spoolWorkflowReviewGit({ cwd: state.cwd, args: ['diff', '--no-ext-diff', '--no-textconv', '--patch', '--binary',
      adoption.source.baseCommit, adoption.source.head], path: changes });
    // The reviewer must review exactly the adopted final-PR pair, so the frozen diff, the frozen
    // instruction set and the frozen inventory are all captured over that pair — never over the
    // plan's narrower task delta. A moved integration head was already refused before this point.
    if (adoption.source.head !== state.integrationHead) {
      throw new Error('workflow_review_compatibility_source_mismatch');
    }
    // A lazy material stream: the builder pulls one bounded material at a time, so the complete
    // authorized set is frozen without ever being collected into an array of materials.
    function* materials(): Generator<WorkflowReviewMaterialInput> {
      for (const path of reviewInstructionPaths(state, adoption.source.baseCommit)) {
        yield { kind: 'instruction', path, file: resolveWorkflowReviewSourceFile(state.cwd, path) };
      }
      // Each authorized member is resolved and streamed from the reviewed checkout as it is pulled
      // from the adopted manifest iterator; the checkout containment guard runs per member.
      for (const path of iterateWorkflowReviewAuthorizedPaths(descriptor)) {
        yield { kind: 'source', path, file: resolveWorkflowReviewSourceFile(state.cwd, path) };
      }
      yield { kind: 'inventory', path: 'inventory', file: inventory };
      yield { kind: 'diff', path: 'diff', file: changes };
      yield { kind: 'objective', path: 'objective', chunks: reviewMaterialSlices(state.plan.objective) };
      yield { kind: 'shared-context', path: 'shared-context', chunks: reviewMaterialSlices(state.plan.sharedContext ?? '') };
      // The accepted task contracts and their complete acceptance criteria travel as one canonical
      // material, emitted one bounded fragment at a time, so the compact request never has to carry
      // a task list and no task collection is ever serialized whole.
      yield { kind: 'contracts', path: 'contracts', chunks: reviewContractFragments(state.tasks) };
    }
    return buildWorkflowReviewSourceBundle({ repository: state.cwd, baseCommit: adoption.source.baseCommit,
      head: adoption.source.head, directory: staging, materials: materials() });
  } catch (error) { failed = true; throw error; }
  finally {
    if (failed) { try { rmSync(scratch, { recursive: true, force: true }); } catch { /* preserve the first failure */ } }
    else rmSync(scratch, { recursive: true, force: true });
  }
}
/**
 * Revalidate one recorded adoption and freeze the complete authorized source for it, all before
 * an attempt is reserved. The bundle is controller-owned, immutably named by its own digest and
 * bound to the exact repository/base/head; the reviewer receives only bounded read access to it.
 * No source, request or bundle aggregate ceiling applies: the freeze is lossless and the only
 * bounds are the reader's per-response buffer policy and the per-stream buffer. Both provider
 * routes are supported: the reader is projected into the invocation the selected binding can
 * actually receive, with no reader and no tool on any other path.
 */
/** The reader authority one compatibility selection must hold before a review may reserve a pass. */
interface AuthorizedReviewCompatibility {
  readonly adoption: WorkflowReviewCompatibilityAdoption;
  readonly descriptor: WorkflowReviewSourceManifestDescriptor;
  readonly reader: WorkflowReviewBuildIdentity;
  readonly catalog: WorkflowReviewCodexCatalogProjection | undefined;
  readonly qualification: WorkflowReviewReaderQualification;
}
/** Require the runtime-selected, privately branded factory before projection, freeze or reservation.
 * Saved labels and qualification files are consistency guards; only the private factory/session
 * capabilities authorize observation. Saved native records never confer this capability. */
function requireWorkflowReviewObservation(runtime: WorkflowRuntime): NonNullable<WorkflowRuntime['readerObservation']> {
  const absent = 'workflow_review_reader_observation_required';
  const observation = runtime.readerObservation;
  if (!observation || (observation.mode !== 'native' && observation.mode !== 'synthetic')) throw new Error(absent);
  if (!Array.isArray(observation.tools)) throw new Error(absent);
  if (observation.identity !== undefined) throw new Error(absent);
  if (observation.mode === 'native') requireWorkflowNativeReviewClientFactory(runtime.nativeReviewClientFactory);
  else requireWorkflowSyntheticReviewClientFactory(runtime.syntheticReviewClientFactory);
  // A reader-only inventory is required: an observer that reached anything beyond the two reader
  // tools, or that reached fewer, did not observe this reader's delivery at all.
  if (observation.tools.length !== WORKFLOW_REVIEW_READER_TOOLS.length
    || WORKFLOW_REVIEW_READER_TOOLS.some(tool => !observation.tools.includes(tool))) {
    throw new Error('workflow_review_reader_observation_incomplete');
  }
  return observation;
}
/**
 * Resolve the authority a compatibility selection must hold — the attributed adoption, the restated
 * source descriptor and the qualified effective invocation — and refuse before anything is frozen,
 * published or reserved. The adoption, the live head, the reviewer binding, the transport policy, the
 * controller and reader builds, the source manifest on disk, the qualified reader and the runner's
 * own declared client-observation capability are all proven here, so a selection that is not
 * authorized to read at all — including a native selection whose runner implements no trusted observer,
 * whose attribution does not resolve to the record it names, and a reader whose `delivered: true`
 * nobody observed — is refused as an authority failure before any workflow-state gate is consulted,
 * before any attempt, pass or provider start, and before any artifact is written.
 */
function authorizeReviewCompatibility(state: WorkflowState, binding: WorkflowRoleBinding,
  selection: WorkflowReviewCompatibilitySelection, runtime: WorkflowRuntime,
  qualification: WorkflowReviewReaderQualification): AuthorizedReviewCompatibility {
  if (state.schemaVersion !== 2) throw new Error('workflow_role_substitution_profile_required');
  const adoption = (state.reviewCompatibilityAdoptions ?? []).find(entry => entry.requestId === selection.requestId);
  if (!adoption) throw new Error('workflow_review_compatibility_not_adopted');
  if (adoption.source.head !== state.integrationHead) throw new Error('workflow_review_compatibility_stale_head');
  if (adoption.reviewerBindingId !== binding.id
    || adoption.reviewerAuthFingerprint !== binding.authFingerprint) throw new Error('workflow_review_compatibility_reviewer_changed');
  // The adopted transport must be exactly the current versioned per-response/per-buffer policy.
  if (!isDeepStrictEqual(adoption.transport, workflowReviewTransportPolicy())) throw new Error('workflow_review_compatibility_transport_unsupported');
  if (!sameReviewBuildIdentity(adoption.controller, workflowReviewControllerBuildIdentity())) throw new Error('workflow_review_compatibility_controller_mismatch');
  const reader = workflowReviewReaderBuildIdentity();
  if (!sameReviewBuildIdentity(adoption.reader, reader)) throw new Error('workflow_review_compatibility_reader_mismatch');
  const route = binding.providerRoute === 'codex' ? 'codex' : 'claude';
  // The authorized source is the immutable disk manifest the adoption recorded. A legacy array-form
  // adoption carries no descriptor and can never be selected: there is no manifest to freeze, so the
  // review refuses rather than reconstructing a prospective file list from saved state.
  const descriptor = adoption.source.descriptor;
  if (!descriptor) throw new Error('workflow_review_compatibility_source_required');
  // The selection may only restate the exact descriptor the adoption recorded: another manifest,
  // another revision, another byte or record count or another content digest would freeze and review
  // a different file set than the one that was attributed, so it refuses before anything is reserved.
  if (!isDeepStrictEqual(selection.descriptor, descriptor)) {
    throw new Error('workflow_review_compatibility_source_mismatch');
  }
  // The recorded descriptor is re-verified against the manifest on disk right now, and every member
  // is proven to be a tracked file of the reviewed checkout: a manifest rewritten, truncated, added
  // to or omitted from since it was adopted — and a member that is untracked, private to the worktree
  // or an alias — is refused here rather than being frozen as the authorized source.
  verifyWorkflowReviewSourceManifestDescriptor(descriptor);
  verifyWorkflowReviewAuthorizedMembership({ cwd: state.cwd, descriptor });
  // The observation capability is proven *here*, before the catalog below is projected and before
  // anything else in this attempt exists: a runner without a usable observer is refused as an
  // authority failure, not after an artifact has already been written on its behalf.
  const observation = requireWorkflowReviewObservation(runtime);
  // The reader the adoption bound must itself be qualified for the effective invocation this review
  // is about to run — not merely for the reader build. A missing, changed, mismatched or incomplete
  // qualification, and a synthetic one outside a declared synthetic runner, refuses here, before any
  // pass, attempt or provider start. The identity is computed prospectively below and compared field
  // by field against the host's hash-bound receipt.
  // A Codex invocation cannot be given a global catalog: the host's own complete catalog is projected
  // onto this one invocation with only the selected model's tool mode made direct. A host catalog
  // that is missing, malformed or does not carry the selected model refuses right here — like the
  // qualification itself, strictly before any pass, attempt, receipt or frozen bundle exists — rather
  // than letting an unprojected model reach a code-mode surface where the reader could be deferred or
  // nested out of the reviewer's reach.
  // The qualification record is read, hashed and parsed exactly once, here — an unsupported `native`
  // record refuses from it before the catalog projection below can write a single byte on its behalf.
  // A run that pairs a synthetic observation declaration with a native record is therefore refused
  // ahead of every artifact effect rather than after the catalog already exists. The same captured
  // record is compared against the projected invocation below, so the record is never read twice and
  // cannot be swapped between the refusal and the comparison.
  const catalog = route === 'codex'
    ? projectWorkflowReviewCodexCatalog({ source: observation.mode === 'native'
        ? workflowNativeReviewCatalogSource(runtime.nativeReviewClientFactory!) : runtime.readerQualification?.catalogPath,
        path: join(teamStateRoot(state.cwd, state.plan.name), 'artifacts', `review-codex-catalog-${adoption.sequence}-${state.reviewPasses + 1}.json`),
        model: binding.model, preview: true, native: observation.mode === 'native' })
    : undefined;
  if (observation.mode === 'native') workflowNativeReviewQualification(runtime.nativeReviewClientFactory!,
    workflowReviewProspectiveInvocation(binding, route, catalog, runtime.nativeReviewClientFactory));
  else verifyWorkflowReviewReaderQualification(qualification, workflowReviewProspectiveInvocation(binding, route, catalog),
      runtime.allowSyntheticCapabilities === true);
  // A declaration must agree with the certified runtime route. A native JSON file cannot reach this
  // point; native mode uses only the successful live bootstrap's privately retained qualification.
  if (qualification.validation !== observation.mode) throw new Error('workflow_review_reader_observation_required');
  return Object.freeze({ adoption, descriptor, reader, catalog, qualification });
}
/**
 * Freeze the authorized source and project the reader for the invocation about to run. The bundle is
 * controller-owned, immutably named by its own digest and bound to the exact repository/base/head;
 * the reviewer receives only bounded read access to it.
 */
function prepareReviewCompatibility(state: WorkflowState, authorized: AuthorizedReviewCompatibility,
  reviewerId: string, plan: WorkflowSyntheticReviewPlan, readerInvocation: WorkflowReviewReaderInvocation): PreparedReviewCompatibility {
  // The authority above can only exist for an artifactized v2 workflow, so this restates the
  // precondition of the freeze rather than introducing a second refusal path.
  if (state.schemaVersion !== 2) throw new Error('workflow_role_substitution_profile_required');
  const { adoption, descriptor, catalog, qualification, reader } = authorized;
  if (catalog) {
    const actual = projectWorkflowReviewCodexCatalog({ source: catalog.input.path, path: catalog.path, model: catalog.model,
      native: qualification.validation === 'native' });
    if (!isDeepStrictEqual(actual, catalog)) throw new Error('workflow_review_prepared_launch_changed');
  }
  const staged = freezeWorkflowReviewCompatibilityBundle(state, adoption, descriptor);
  // Bind the freeze to the adopted pair before publication or reservation. The historical record is
  // only a consistency guard. Actual delivery is established later by the branded session's captured
  // requests, original response bytes and independently reconstructed client/model-facing proof.
  try {
    assertWorkflowReviewSourceHead(staged, { repository: state.cwd, baseCommit: adoption.source.baseCommit, head: adoption.source.head });
    if (qualification.validation !== 'native') verifyWorkflowReviewQualificationEvidence(qualification, staged);
  } catch (error) {
    try { rmSync(staged.directory, { recursive: true, force: true }); } catch { /* Preserve the original refusal. */ }
    throw error;
  }
  const bundlePath = plan.bundlePath;
  let bundle: WorkflowReviewSourceBundle;
  try { bundle = publishWorkflowReviewBundle(staged, bundlePath); }
  catch (error) { try { rmSync(staged.directory, { recursive: true, force: true }); } catch { /* Preserve the original refusal. */ } throw error; }
  verifyWorkflowReviewSourceBundle(bundle);
  // One controller-owned receipt log per attempt: stale deliveries can never satisfy this review. It
  // records what this controller's own reader intended to serve and is retained as separate diagnostic
  // evidence; admission rests on the live session's original frames and independently replayed proof.
  const receiptsPath = plan.receiptsPath;
  writeFileSync(receiptsPath, '', { flag: 'wx', mode: 0o600 });
  return Object.freeze({ adoption, bundle, receiptsPath, reviewerId, qualification,
    binding: Object.freeze({ adoptionSequence: adoption.sequence, bundleSha256: bundle.digest,
      controllerSha256: adoption.controller.sha256, readerSha256: reader.sha256 }),
    reader: readerInvocation,
    // The descriptor names the reader, its two tools, the frozen digest and the per-response bound,
    // and carries no size of the source at all: the reviewer learns the true totals from the manifest
    // it actually pages, so nothing here could act as, or be mistaken for, an aggregate ceiling.
    descriptor: Object.freeze({ server: qualification.validation === 'native' ? WORKFLOW_REVIEW_NATIVE_NAMESPACE : WORKFLOW_REVIEW_SOURCE_SERVER_NAME,
      tools: [WORKFLOW_REVIEW_READER_TOOL_MANIFEST, WORKFLOW_REVIEW_READER_TOOL_READ],
      adoptionSequence: adoption.sequence, manifestDigest: bundle.digest, entries: bundle.entryCount,
      responseBytes: WORKFLOW_REVIEW_READ_LIMIT_BYTES, reviewerId,
      instructions: 'The complete frozen logical source for this review is served only through the read-only reader above by bundle id and continuation cursor. Finish paging the manifest first, then read every entry in its exact manifest order, following each result cursor until it is null before starting the next entry. Already completed ranges may be revisited. Every page is bounded but the whole object is delivered. It carries the authorized files, the governed instructions, the inventory, the binary-safe patch, the objective, the shared context and the accepted task contracts with their acceptance criteria. Preserve the current manifest or entry cursor, completed entry IDs, positive-byte page count and concrete findings across compaction, then resume unread material. Return the required JSON findings plus a coverage attestation {bundleSha256, reviewerId, complete, entries, ranges} for exactly this manifestDigest only after reading every empty terminal page too. '
        + (qualification.validation === 'native'
          ? 'Follow the latest trusted progress.next kind/id/cursor; omit the cursor argument when progress.next.cursor is null to start that object. Preserve progress across compaction. Only finish when progress.next is null, and copy the final progress.ranges exactly into coverage.ranges. Successful positive-byte revisits increment this counter; empty pages and refusals do not.'
          : 'Count ranges as actual returned pages whose bytes is greater than zero, including successful revisits.') }) });
}
/**
 * Resolve everything one compatibility selection must hold before its review may reserve a pass: the
 * prospective reviewer binding, the provenance that binding signs, and the reader authority. It runs
 * ahead of the workflow-state gates in `reviewWorkflow`, so an unauthorized invocation is refused on
 * its own terms rather than as workflow state that needs adjudication.
 *
 * Reader mode eligibility is refused before the binding's capability receipt is validated. The
 * binding is prepared once, then its effective invocation is compared with the qualification,
 * strictly before any pass, attempt or provider start.
 */
function authorizeWorkflowReviewCompatibility(state: WorkflowState, selection: WorkflowReviewCompatibilitySelection,
  head: string, runtime?: WorkflowRuntime): { prepared: PreparedWorkflowBinding;
    provenance: ReturnType<typeof workflowReviewProvenance>; authorized: AuthorizedReviewCompatibility } {
  if (state.schemaVersion !== 2 || !runtime) throw new Error('workflow_role_substitution_profile_required');
  const observation = requireWorkflowReviewObservation(runtime);
  const qualification = observation.mode === 'native'
    ? workflowNativeReviewQualification(runtime.nativeReviewClientFactory!) : readWorkflowReviewReaderQualification(runtime.readerQualification);
  if (observation.mode === 'synthetic' && (qualification.validation !== 'synthetic' || runtime.allowSyntheticCapabilities !== true)) {
    throw new Error('workflow_review_reader_qualification_required');
  }
  const prepared = prepareBinding(state, state.bindings.reviewer, runtime);
  if (observation.mode === 'native') verifyWorkflowNativeReviewPrepared(runtime.nativeReviewClientFactory!, prepared, state.cwd, reviewReviewerResultSchema(true));
  const authorized = authorizeReviewCompatibility(state, prepared.binding, selection, runtime, qualification);
  const provenance = workflowReviewProvenance(prepared, head, runtime);
  return { prepared, provenance, authorized };
}
export async function reviewWorkflow(cwd: string, name: string, runtime?: WorkflowRuntime, options?: WorkflowReviewOptions): Promise<WorkflowState> {
  return mutate(cwd, name, async (state, active) => {
    const head = verificationGate(state);
    assertNoIncompleteReviewInvocations(state);
    const refs = git(cwd, ['for-each-ref', '--format=%(refname) %(objectname)']);
    // A compatibility selection's reader authority is resolved before the workflow-state gates below.
    // An invocation that is not authorized to read at all — an unadopted, stale, rebuilt, unqualified,
    // synthetic-for-native or unreachable reader — is refused as an authority failure before any pass,
    // attempt or provider start, rather than being reported as a workflow that merely needs
    // adjudication. The ordinary review path resolves its binding below and keeps its own ordering.
    const authority = options?.compatibility
      ? authorizeWorkflowReviewCompatibility(state, options.compatibility, head, runtime) : undefined;
    if (workflowReviewBudgetUsed(state) >= workflowReviewCeiling(state)) throw new Error('workflow_review_limit_reached');
    if (state.reviews.some(review => review.findings.some(finding => !finding.disposition || finding.disposition === 'fix' && !finding.fixedBy))) throw new Error('workflow_findings_require_adjudication_or_fix');
    const prepared = authority ? authority.prepared
      : state.schemaVersion === 2 ? prepareBinding(state, state.bindings.reviewer, runtime) : undefined;
    const provenance = authority ? authority.provenance
      : prepared && runtime ? workflowReviewProvenance(prepared, head, runtime) : undefined;
    if (options?.compatibility && (!prepared || !provenance)) throw new Error('workflow_role_substitution_profile_required');
    // Compose the complete serialization, the source freeze and the binding readiness before any
    // attempt is reserved: a refusal here changes no pass, attempt, counter or provider start. A
    // compatibility review freezes its material onto disk instead of building the in-memory context,
    // so the ordinary request's unbounded fields never enter the compact request.
    // The guard directly above already refused a compatibility selection with no runtime, so the
    // additional test below only narrows the type; it can never silently downgrade the review.
    const root = join(teamStateRoot(state.cwd, state.plan.name), 'artifacts');
    const prefix = join(root, `review-${state.reviewPasses + 1}`);
    const resultFile = `${prefix}.result.json`; const schemaFile = `${prefix}.schema.json`;
    const schema = reviewReviewerResultSchema(authority !== undefined);
    const invocationId = randomUUID();
    let compatibility: PreparedReviewCompatibility | undefined;
    let session: WorkflowSyntheticReviewSession | WorkflowNativeReviewSession | undefined;
    let nativePlan: WorkflowSyntheticReviewPlan | undefined;
    if (authority && runtime?.readerObservation?.mode === 'synthetic' && runtime.syntheticReviewClientFactory) {
      const plan = planWorkflowSyntheticReview({ invocationId, reviewerId: authority.provenance.reviewerId,
        directory: join(root, `review-delivery-${invocationId}`), bundlePath: join(root, `review-source-bundle-${invocationId}`),
        receiptsPath: join(root, `review-source-receipts-${invocationId}.jsonl`) });
      const readerInput = { serverPath: workflowSyntheticReaderPath(runtime.syntheticReviewClientFactory),
        bundlePath: plan.bundlePath, receiptsPath: plan.receiptsPath,
        ...(authority.authorized.catalog ? { catalogPath: authority.authorized.catalog.path } : {}) };
      const reader = Object.freeze({ mcpConfig: workflowReviewSourceReaderConfig(readerInput),
        codex: Object.freeze(workflowReviewCodexReaderOverrides(readerInput)) });
      const timeoutMs = providerTimeoutMs(state);
      const launch: WorkflowSyntheticReviewLaunch = { command: authority.prepared.command,
        args: workflowReviewerArguments(authority.prepared, schemaFile, resultFile, schema, reader), cwd,
        environment: { ...authority.prepared.environment, ...workflowSyntheticBridgeEnvironment(runtime.syntheticReviewClientFactory, plan) },
        redactionEnvironment: authority.prepared.redactionEnvironment, timeoutMs, artifactPrefix: prefix,
        provider: authority.prepared.binding.providerRoute as 'codex' | 'claude',
        ...(timeoutMs === null ? { superviseProcessTree: true } : {}), ...(state.options.mode === 'balanced' ? { collectUsage: true } : {}) };
      const files = ['workflow', 'workflow-adapters', 'workflow-contracts', 'workflow-review-source', 'workflow-review-source-server',
        'workflow-process', 'workflow-process-supervisor'].map(name => {
          const emitted = fileURLToPath(new URL(`./${name}.js`, import.meta.url));
          const path = realpathSync(existsSync(emitted) ? emitted : emitted.replace(/\.js$/, '.ts'));
          return { path, sha256: hashWorkflowReviewArtifact(path).sha256 };
        });
      const catalog = authority.authorized.catalog;
      session = prepareWorkflowSyntheticReview({ factory: runtime.syntheticReviewClientFactory, plan,
        prepared: authority.prepared, launch, bundle: () => compatibility!.bundle, files, schema, catalogPath: catalog?.path,
        artifacts: [{ path: schemaFile, sha256: createHash('sha256').update(JSON.stringify(schema, null, 2) + '\n').digest('hex') },
          ...(catalog ? [{ path: catalog.path, sha256: catalog.sha256 }] : [])] });
      compatibility = prepareReviewCompatibility(state, authority.authorized, authority.provenance.reviewerId, plan, reader);
    }
    if (authority && runtime?.readerObservation?.mode === 'native' && runtime.nativeReviewClientFactory) {
      nativePlan = planWorkflowSyntheticReview({ invocationId, reviewerId: authority.provenance.reviewerId,
        directory: join(root, `review-delivery-${invocationId}`), bundlePath: join(root, `review-source-bundle-${invocationId}`),
        receiptsPath: join(root, `review-source-receipts-${invocationId}.jsonl`) });
      compatibility = prepareReviewCompatibility(state, authority.authorized, authority.provenance.reviewerId, nativePlan,
        Object.freeze({ mcpConfig: '{"mcpServers":{}}', codex: Object.freeze([]) }));
    }
    const context = state.schemaVersion === 2 && !compatibility ? reviewContext(state) : undefined;
    // There is no aggregate request ceiling: the ordinary request carries the complete material,
    // while the compatibility request is compact by construction and names the frozen bundle only.
    const request = compatibility
      ? composeWorkflowReviewCompatibilityRequest(compatibility.adoption.source.baseCommit, head, compatibility.descriptor)
      : composeWorkflowReviewRequest(state, context, head);
    if (nativePlan && authority && runtime?.nativeReviewClientFactory && compatibility) {
      const files = ['workflow', 'workflow-adapters', 'workflow-contracts', 'workflow-review-source', 'workflow-review-source-server',
        'workflow-native-compaction', 'workflow-native-model-events', 'workflow-native-review-observer', 'workflow-native-body-observer',
        'workflow-process', 'workflow-process-supervisor'].map(name => {
          const emitted = fileURLToPath(new URL(`./${name}.js`, import.meta.url));
          const path = realpathSync(existsSync(emitted) ? emitted : emitted.replace(/\.js$/, '.ts'));
          return { path, sha256: hashWorkflowReviewArtifact(path).sha256 };
        });
      const catalog = authority.authorized.catalog!;
      session = prepareWorkflowNativeReview({ factory: runtime.nativeReviewClientFactory, plan: nativePlan,
        prepared: authority.prepared, bundle: () => compatibility!.bundle, request, catalog, schema,
        artifactPrefix: prefix, timeoutMs: providerTimeoutMs(state), files,
        artifacts: [{ path: schemaFile, sha256: createHash('sha256').update(JSON.stringify(schema, null, 2) + '\n').digest('hex') },
          { path: catalog.path, sha256: catalog.sha256 }] });
    }
    const balanced = state.options.mode === 'balanced';
    const started = Date.now();
    state.reviewPasses++; state.stage = 'review';
    const reservation: WorkflowReviewAttempt = { orchestrationHost: active.host, pass: state.reviewPasses, head,
      ...(prepared ? { model: prepared.binding.model } : state.options.codexModel ? { model: state.options.codexModel } : {}), startedAt: now(), outcome: 'failed',
      error: 'workflow_invocation_incomplete', artifacts: [], telemetry: { provider: prepared?.binding.providerRoute ?? 'codex', durationMs: 0, status: 'unknown', scope: 'unknown' } };
    let attempt: WorkflowReviewAttempt | undefined;
    if (state.schemaVersion === 2 && prepared && provenance) {
      const bound: WorkflowReviewAttemptV2 = { ...reservation, invocationId, binding: prepared.binding, provenance,
        ...(compatibility ? { compatibility: compatibility.binding } : {}) };
      (state.reviewAttempts ??= []).push(bound); attempt = bound;
    } else if (state.schemaVersion === 1) { (state.reviewAttempts ??= []).push(reservation); attempt = reservation; }
    save(state);
    let reviewFailed = false; let deliveryProofActive = false;
    try {
      artifactsRoot(state);
      atomicWriteJson(schemaFile, schema);
      const legacyArgs = ['exec', '--sandbox', 'read-only', '--ephemeral', ...(balanced ? ['--json'] : []),
        ...(state.options.codexModel ? ['--model', state.options.codexModel] : []), '--output-schema', schemaFile, '--output-last-message', resultFile, '-'];
      const invocation = session ? session.launch : prepared
        ? { command: prepared.command, args: workflowReviewerArguments(prepared, schemaFile, resultFile, boundedJson(schemaFile),
          compatibility?.reader) }
        : resolveValidatedCliInvocation('codex', legacyArgs, state.options.codexCommand);
      const input = session ? session.launch : { command: invocation.command, args: invocation.args,
        ...('windowsVerbatimArguments' in invocation && invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
        cwd, ...(prepared ? { environment: prepared.environment,
          redactionEnvironment: prepared.redactionEnvironment } : {}),
        timeoutMs: providerTimeoutMs(state), artifactPrefix: prefix, provider: prepared?.binding.providerRoute ?? 'codex', ...(balanced ? { collectUsage: true } : {}) };
      let result: Awaited<ReturnType<typeof runWorkflowProvider>>;
      try {
        if (session) await session.start();
        result = await runWorkflowProvider(session instanceof WorkflowNativeReviewSession
          ? { ...input, onInput: session.onInput, abortSignal: session.abortSignal, collectUsage: false } : input, resultFile,
          prepared?.binding.providerRoute === 'claude' ? { kind: 'claude-native-structured' } : { kind: 'provider-designated-json' },
          session instanceof WorkflowNativeReviewSession ? undefined : request,
          session instanceof WorkflowNativeReviewSession ? session.onStdout : session?.assertHealthy,
          session instanceof WorkflowNativeReviewSession ? value => session.acceptProcessCompletion(value) : undefined);
      } finally { if (session) await session.settle(); }
      if (session?.integrityDiagnostic) Object.assign(result, { integrityDiagnostic: session.integrityDiagnostic });
      if (attempt) {
        recordWorkflowProcessResult(attempt, result);
        attempt.telemetry = result.telemetry ?? { provider: prepared?.binding.providerRoute ?? 'codex', durationMs: Date.now() - started, status: 'unknown', scope: 'unknown' };
        attempt.artifacts = result.artifacts;
        // Preserve process settlement before repository, output and findings validation can fail.
        save(state);
      }
      try {
        if (assertLeader(state) !== head || git(cwd, ['for-each-ref', '--format=%(refname) %(objectname)']) !== refs) throw new Error('changed');
      } catch { throw new Error('workflow_reviewer_modified_repository'); }
      if (!result.passed) throw new Error('workflow_review_process_failed');
      if (session?.integrityDiagnostic) throw new Error('workflow_review_process_failed');
      if (result.outputError) throw result.outputError;
      validateResolvedPath(result.outputArtifactPath, root);
      const raw = result.output;
      const decoded = JSON.parse(redactWorkflowText(JSON.stringify(raw)));
      // Complete, untruncated source delivery is a precondition for accepting any finding here.
      // Coverage is admitted from the bytes a client actually received and decoded — never from what
      // this controller's reader intended to serve — and is proven by streaming each append-only
      // on-disk ledger, so no total receipt collection is ever held: only one bounded line and one
      // cursor per expected entry at a time.
      const coverage = compatibility ? await (async () => {
        const receiptPath = reviewCompatibilityReceiptPath(state, compatibility.adoption.sequence);
        if (!existsSync(receiptPath)) throw new Error('workflow_review_compatibility_receipt_missing');
        const attestation = decoded && typeof decoded === 'object' && !Array.isArray(decoded)
          ? (decoded as Record<string, unknown>).coverage : undefined;
        if (!session) throw new Error('workflow_review_reader_observation_required');
        deliveryProofActive = true;
        const observed = await session.prove(session.completion(), attestation);
        // The reader-intended ledger is retained as separate diagnostic evidence and reconstructed
        // independently: a delivery whose recorded bytes were altered to stay self-consistent can pass
        // on its own, so the two descriptions of the same delivery must agree byte for byte.
        const file = new WorkflowReviewOwnedFile(dirname(compatibility.receiptsPath), basename(compatibility.receiptsPath));
        let ledger: ReturnType<WorkflowReviewOwnedFile['seal']>; let failed = false;
        try {
          const intended = await validateWorkflowReviewCoverageLedger(compatibility.bundle, {
            ledger: streamWorkflowReviewLines(file), attestation, reviewerId: compatibility.reviewerId });
          if (observed.ranges !== intended.ranges || observed.reconstructionSha256 !== intended.reconstructionSha256) {
            throw new Error('workflow_review_compatibility_observation_mismatch');
          }
          ledger = file.seal();
        } catch (error) { failed = true; throw error; }
        finally { if (failed) { try { file.close(); } catch { /* preserve the integrity failure */ } } else file.close(); }
        deliveryProofActive = false;
        // The coverage record references both append-only ledgers by name and digest instead of
        // inlining every receipt, so the saved artifact stays a constant-size attestation.
        const coveragePath = join(root, `review-coverage-${state.reviewPasses}.json`);
        writeWorkflowReviewArtifact({ path: coveragePath, chunks: [`${JSON.stringify({ bundleSha256: compatibility.bundle.digest,
          reviewerId: compatibility.reviewerId, entries: compatibility.bundle.entryCount, ranges: observed.ranges,
          reconstructionSha256: observed.reconstructionSha256,
          delivery: { directory: basename(session.plan.directory), ...observed },
          ledger: { name: basename(compatibility.receiptsPath), bytes: ledger.bytes, sha256: ledger.sha256 }, attestation }, null, 2)}\n`] });
        return createWorkflowReviewArtifactDescriptor({ path: coveragePath, kind: 'workflow-review-coverage',
          producer: { system: 'omc', component: 'team-workflow' }, retention: 'until-completion' });
      })() : undefined;
      const findings = parseWorkflowReviewFindings(decoded, state.reviewPasses, cwd);
      state.reviews.push({ pass: state.reviewPasses, head, findings, artifacts: [...result.artifacts,
        ...(coverage ? [coverage, createArtifactDescriptorFromPath(reviewCompatibilityReceiptPath(state, compatibility!.adoption.sequence), {
          kind: 'workflow-review-compatibility-adoption', producer: { system: 'omc', component: 'team-workflow' }, retention: 'until-completion' })] : []),
        createArtifactDescriptorFromPath(result.outputArtifactPath, {
          kind: 'workflow-review', producer: { system: 'omc', component: 'team-workflow' }, retention: 'until-completion',
        })] });
      state.stage = 'adjudication';
      if (attempt) { attempt.outcome = 'completed'; delete attempt.error; attempt.artifacts = state.reviews.at(-1)!.artifacts; }
    } catch (error) {
      reviewFailed = true;
      if (attempt) {
        const message = error instanceof Error ? error.message : '';
        attempt.error = /^workflow_[a-z_]+$/.test(message) ? message : 'workflow_review_failed';
        if (session && attempt.processResult && (deliveryProofActive || message === 'workflow_review_process_failed')) {
          const integrityDiagnostic = session.integrityDiagnostic ?? attempt.processResult.integrityDiagnostic
            ?? boundedWorkflowStdoutCallbackError(error);
          const path = `${prefix}.integrity.json`;
          attempt.error = 'workflow_review_process_failed';
          try {
            writeWorkflowReviewArtifact({ path, chunks: [JSON.stringify({ invocationId, integrityDiagnostic,
              acceptance: 'process_failed', processResult: attempt.processResult }) + '\n'] });
            attempt.artifacts.push(createWorkflowReviewArtifactDescriptor({ path, kind: 'workflow-review-integrity',
              producer: { system: 'omc', component: 'team-workflow' }, retention: 'until-completion' }));
          } catch { /* The saved actual process result and original delivery failure stand. */ }
        }
      }
      throw error;
    } finally {
      if (attempt && !attempt.telemetry.durationMs) attempt.telemetry.durationMs = Date.now() - started;
      if (reviewFailed) { try { session?.dispose(); } catch { /* preserve the first failure */ } }
      else session?.dispose();
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
    const review = state.reviews.at(-1);
    if (!review) throw new Error('workflow_review_required');
    if (review.head !== state.integrationHead) throw new Error('workflow_current_review_required');
    const findings = state.reviews.flatMap(review => review.findings);
    if (findings.some(finding => !finding.disposition || finding.disposition === 'fix' && !finding.fixedBy)) throw new Error('workflow_unresolved_findings');
    state.stage = 'complete';
  });
}
function effectiveProviderPolicy(state: WorkflowState): 'finite-provider-timeout' | 'unbounded-provider-timeout' {
  return state.options.providerPolicy === undefined ? 'finite-provider-timeout' : 'unbounded-provider-timeout';
}
/** Bounded public view of the saved route selection. Private evidence and executable identity stay omitted. */
export function workflowRouting(cwd: string, name: string): Record<string, unknown> {
  const state = readWorkflow(cwd, name);
  const policy = { providerPolicy: state.options.providerPolicy ?? null,
    effectiveProviderPolicy: effectiveProviderPolicy(state) };
  if (state.schemaVersion === 1) {
    const source = { kind: 'legacy-snapshot' };
    return { name, schemaVersion: 1, profile: state.profile, ...policy, roles: [
      { role: 'lead', provider: null, model: null, effort: null, cliFamily: 'external', credentialProfileRef: null,
        selectionSource: source },
      { role: 'implementer', provider: legacyProvider(state), model: state.options.glmModel ?? null, effort: null,
        cliFamily: 'claude-code', credentialProfileRef: null, selectionSource: source },
      { role: 'reviewer', provider: 'codex', model: state.options.codexModel ?? null, effort: null,
        cliFamily: 'codex-exec', credentialProfileRef: null, selectionSource: source },
    ] };
  }
  return { name, schemaVersion: 2, profile: state.profile, ...policy,
    roles: (['lead', 'implementer', 'reviewer'] as const).map(role => {
      const binding = state.bindings[role];
      const substitution = [...state.substitutions].reverse().find(record => record.role === role);
      return { ...sanitizedBinding(binding), selectionSource: substitution
        ? { kind: 'substitution', sequence: substitution.sequence } : { kind: 'initial-binding' } };
    }) };
}
export function workflowStatus(cwd: string, name: string): Record<string, unknown> {
  const state = readWorkflow(cwd, name);
  const versioned = state.schemaVersion === 2 ? state : undefined;
  const result = { name, profile: state.profile, mode: state.options.mode ?? 'v1', stage: state.stage, workers: state.options.workers, maxWorkers: state.options.maxWorkers,
    // Report the saved selection only; no private runtime, environment or process detail is exposed.
    providerPolicy: state.options.providerPolicy ?? 'legacy',
    effectiveProviderPolicy: effectiveProviderPolicy(state),
    ...(versioned ? { schemaVersion: 2, bindings: versioned.bindings,
      substitutionCount: versioned.substitutions.length, omittedSubstitutions: Math.max(0, versioned.substitutions.length - 3),
      substitutions: versioned.substitutions.slice(-3).map(record => ({ sequence: record.sequence, role: record.role, from: record.from.id, to: record.to.id,
        reason: record.reason.slice(0, 200), authorityRef: record.authorityRef.slice(0, 200), head: record.head, at: record.at, taskId: record.taskId })),
      reviewRelations: (versioned.reviewAttempts ?? []).slice(-3).map(attempt => ({ pass: attempt.pass, provider: attempt.binding.providerRoute,
        bindingId: attempt.binding.id, outcome: attempt.outcome, relation: attempt.provenance.relation, context: attempt.provenance.context })) } : {}),
    activeWorkers: state.tasks.filter(entry => entry.status === 'running').length, integrationBranch: state.plan.integrationBranch,
    failedTasks: state.tasks.filter(entry => entry.status === 'failed').length,
    leadIntegrationCount: state.leadIntegrations?.length ?? 0,
    omittedLeadIntegrations: Math.max(0, (state.leadIntegrations?.length ?? 0) - 3),
    leadIntegrations: (state.leadIntegrations ?? []).slice(-3).map(entry => ({ sequence: entry.sequence, parent: entry.parent, head: entry.head,
      changedFileCount: entry.changedFiles.length, changedFiles: entry.changedFiles.slice(0, 3).map(path => path.slice(0, 200)),
      orchestrationHost: entry.orchestrationHost, actor: entry.actor, authorityRef: entry.authorityRef.slice(0, 200),
      reason: entry.reason.slice(0, 200), at: entry.at })),
    dispatchSupplementCount: state.dispatchSupplements?.length ?? 0,
    omittedDispatchSupplements: Math.max(0, (state.dispatchSupplements?.length ?? 0) - 3),
    dispatchSupplements: (state.dispatchSupplements ?? []).slice(-3).map(entry => ({ sequence: entry.sequence,
      taskId: entry.taskId, expectedInputHead: entry.expectedInputHead, orchestrationHost: entry.orchestrationHost,
      actor: entry.actor, authorityRef: entry.authorityRef.slice(0, 200), reason: entry.reason.slice(0, 200),
      contentSha256: entry.contentSha256, at: entry.at })),
    reviewBudgetExtensionCount: state.reviewBudgetExtensions?.length ?? 0,
    omittedReviewBudgetExtensions: Math.max(0, (state.reviewBudgetExtensions?.length ?? 0) - 3),
    reviewBudgetExtensions: (state.reviewBudgetExtensions ?? []).slice(-3).map(entry => ({ sequence: entry.sequence,
      requestId: entry.requestId, oldCeiling: entry.oldCeiling, newCeiling: entry.newCeiling, head: entry.head,
      orchestrationHost: entry.orchestrationHost, actor: entry.actor, authorityRef: entry.authorityRef.slice(0, 200),
      reason: entry.reason.slice(0, 200), at: entry.at })),
    // Administrative review compatibility is reported as bounded history; the saved decisions are untouched.
    reviewCompatibilityAdoptionCount: state.reviewCompatibilityAdoptions?.length ?? 0,
    omittedReviewCompatibilityAdoptions: Math.max(0, (state.reviewCompatibilityAdoptions?.length ?? 0) - 3),
    reviewCompatibilityAdoptions: (state.reviewCompatibilityAdoptions ?? []).slice(-3).map(entry => ({ sequence: entry.sequence,
      requestId: entry.requestId, head: entry.source.head, sourceDigest: entry.source.digest, reviewerBindingId: entry.reviewerBindingId,
      reviewerAuthFingerprint: entry.reviewerAuthFingerprint, controllerSha256: entry.controller.sha256,
      readerSha256: entry.reader.sha256, transport: entry.transport, orchestrationHost: entry.orchestrationHost,
      actor: entry.actor, authorityRef: entry.authorityRef.slice(0, 200), reason: entry.reason.slice(0, 200), at: entry.at })),
    taskRecoveryCount: state.taskRecoveries?.length ?? 0,
    omittedTaskRecoveries: Math.max(0, (state.taskRecoveries?.length ?? 0) - 3),
    taskRecoveries: (state.taskRecoveries ?? []).slice(-3).map(entry => ({ sequence: entry.sequence,
      taskId: entry.taskId, requestId: entry.requestId, oldError: entry.oldError, taskCommit: entry.taskCommit,
      baseCommit: entry.baseCommit, head: entry.head, refsDigestBefore: entry.refsDigestBefore,
      refsDigestAfter: entry.refsDigestAfter, orchestrationHost: entry.orchestrationHost, actor: entry.actor,
      authorityRef: entry.authorityRef.slice(0, 200), reason: entry.reason.slice(0, 200),
      checkCount: entry.checks.length, protectedRefAuditContentHash: entry.protectedRefAuditContentHash, at: entry.at })),
    verification: state.verification ? { head: state.verification.head, passed: state.verification.passed } : null,
    reviewPasses: state.reviewPasses, completedReviews: state.reviews.length,
    reviewBudgetBasis: state.reviewBudgetBasis ?? 'attempts', reviewBudgetUsed: workflowReviewBudgetUsed(state),
    initialMaxReviewPasses: state.options.maxReviewPasses,
    maxReviewPasses: workflowReviewCeiling(state),
    findings: (state.reviews.at(-1)?.findings ?? []).map(finding => ({ ...finding, message: finding.message.slice(0, 300), reason: finding.reason?.slice(0, 200) })),
    omittedTasks: 0, omittedFindings: 0, stateFile: statePath(cwd, name),
    tasks: state.tasks.map(entry => {
      const actual = versioned?.tasks.find(task => task.task.id === entry.task.id)?.invocations?.at(-1)?.binding;
      const blockedDependencies = entry.status === 'pending'
        ? entry.task.dependencies.map(id => getTask(state, id)).filter(dependency => dependency.status !== 'accepted')
        : [];
      const blockedReason = blockedDependencies.some(dependency => ['failed', 'rejected'].includes(dependency.status))
        ? 'dependency_unavailable'
        : blockedDependencies.some(dependency => ['pending', 'running'].includes(dependency.status))
          ? 'awaiting_dependency_completion'
          : blockedDependencies.length ? 'awaiting_dependency_acceptance' : undefined;
      return { id: entry.task.id, worker: entry.worker, provider: versioned ? actual?.providerRoute ?? null : legacyProvider(state), model: versioned ? actual?.model ?? null : state.options.glmModel,
      ...(versioned ? { bindingId: actual?.id ?? null, selectedBinding: { id: versioned.bindings.implementer.id,
        provider: versioned.bindings.implementer.providerRoute, model: versioned.bindings.implementer.model } } : {}),
      status: entry.status, attempts: entry.attempts, setupAttempts: entry.setupAttempts?.length ?? 0,
      ...(entry.setupAttempts?.at(-1) ? { setup: { sequence: entry.setupAttempts.at(-1)!.sequence,
        mode: entry.setupAttempts.at(-1)!.mode, outcome: entry.setupAttempts.at(-1)!.outcome, error: entry.setupAttempts.at(-1)!.error,
        detail: entry.setupAttempts.at(-1)!.detail, artifactPath: entry.setupAttempts.at(-1)!.artifact?.path } } : {}),
      backoffUntil: entry.backoffUntil, worktree: entry.worktree, branch: entry.branch, updatedAt: entry.updatedAt,
      ...(blockedReason ? { readiness: 'blocked', blockedBy: blockedDependencies.map(dependency => dependency.task.id), blockedReason } : {}),
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
  while (Buffer.byteLength(JSON.stringify(result)) > 16 * 1024 && result.leadIntegrations.length) {
    result.leadIntegrations.shift(); result.omittedLeadIntegrations++;
  }
  while (Buffer.byteLength(JSON.stringify(result)) > 16 * 1024 && result.dispatchSupplements.length) {
    result.dispatchSupplements.shift(); result.omittedDispatchSupplements++;
  }
  while (Buffer.byteLength(JSON.stringify(result)) > 16 * 1024 && result.reviewBudgetExtensions.length) {
    result.reviewBudgetExtensions.shift(); result.omittedReviewBudgetExtensions++;
  }
  while (Buffer.byteLength(JSON.stringify(result)) > 16 * 1024 && result.taskRecoveries.length) {
    result.taskRecoveries.shift(); result.omittedTaskRecoveries++;
  }
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
  return withOrchestratorOperation(cwd, () => withFileLock(`${statePath(cwd, name)}.lock`, async () => {
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
    }, { timeoutMs: 0 }));
}
