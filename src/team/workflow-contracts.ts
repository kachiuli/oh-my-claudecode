import type { ArtifactDescriptor } from '../shared/artifact-descriptor.js';
import type { WorkflowTelemetry } from './workflow-usage.js';
import { isDeepStrictEqual } from 'node:util';
import type { OrchestratorHost } from '../orchestration/selection.js';

export type WorkflowRole = 'lead' | 'implementer' | 'reviewer';
export type WorkflowProviderRoute = 'claude' | 'glm' | 'codex';
/** The single optional supervised policy; omission keeps the legacy finite provider timeout. */
export type WorkflowProviderPolicy = 'supervised';
export type WorkflowCapability = 'external-lead' | 'structured-handoff' | 'structured-findings' | 'read-only' | 'session-resume' | 'review-permission-transition';
/** A declaration and evidence reference, not proof that a CLI has these capabilities. */
export interface WorkflowRoleBinding {
  readonly id: string;
  readonly role: WorkflowRole;
  readonly providerRoute: WorkflowProviderRoute;
  readonly cliFamily: 'external' | 'claude-code' | 'codex-exec';
  readonly model: string;
  readonly effort?: string;
  readonly authProfileRef: string;
  readonly authFingerprint: string;
  /** version is a normalized version token, not the complete CLI --version label. */
  readonly executableIdentity?: Readonly<{ path: string; sha256: string; version: string }>;
  readonly capabilities: readonly WorkflowCapability[];
  readonly capabilityEvidenceSha256: string;
}

export interface WorkflowCommand { command: string; args: string[] }
export interface WorkflowTask {
  id: string;
  objective: string;
  baseCommit: string;
  writeScope: string[];
  readScope: string[];
  prohibitedScope: string[];
  dependencies: string[];
  contracts: string[];
  acceptanceCriteria: string[];
  tests: WorkflowCommand[];
}
export interface WorkflowPlan {
  name: string;
  objective: string;
  baseCommit: string;
  integrationBranch: string;
  tasks: WorkflowTask[];
  verification: WorkflowCommand[];
  sharedContext?: string;
}
export interface WorkflowOptions {
  mode?: 'v1' | 'balanced';
  workers?: number;
  maxWorkers?: number;
  maxAttempts?: number;
  maxReviewPasses?: number;
  timeoutMs?: number;
  backoffMs?: number;
  glmCommand?: string;
  glmModel?: string;
  codexModel?: string;
  codexCommand?: string;
  providerPolicy?: WorkflowProviderPolicy;
}
export interface WorkflowHandoff {
  taskId: string;
  outcome: 'completed' | 'failed';
  commitSha?: string;
  changedFiles: string[];
  tests: Array<{ command: string; args: string[]; passed: boolean }>;
  interfaceChanges: string[];
  assumptions: string[];
  risks: string[];
  summary: string;
  artifacts: ArtifactDescriptor[];
}
export interface WorkflowTaskState {
  task: WorkflowTask;
  canonicalId: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'accepted' | 'rejected';
  attempts: number;
  worker: string;
  worktree?: string;
  branch?: string;
  handoff?: WorkflowHandoff;
  error?: string;
  backoffUntil?: string;
  claimToken?: string;
  updatedAt: string;
  findingIds?: string[];
  session?: { id: string; confirmed: boolean; fingerprint: string; worktree: string; branch: string };
  invocations?: WorkflowInvocation[];
}
export interface WorkflowInvocation {
  /** Snapshot of the lead host; omitted historical records are never backfilled. */
  readonly orchestrationHost?: OrchestratorHost;
  attempt: number;
  mode: 'fresh' | 'resume';
  model?: string;
  promptFingerprint?: string;
  contextFingerprint?: string;
  startedAt: string;
  outcome: 'completed' | 'failed';
  error?: string;
  reason?: string;
  artifacts: ArtifactDescriptor[];
  telemetry: WorkflowTelemetry;
}
export interface WorkflowReviewAttempt {
  readonly orchestrationHost?: OrchestratorHost;
  pass: number;
  head: string;
  model?: string;
  startedAt: string;
  outcome: 'completed' | 'failed';
  error?: string;
  artifacts: ArtifactDescriptor[];
  telemetry: WorkflowTelemetry;
}
export interface WorkflowFinding {
  id: string;
  severity: 'P0' | 'P1' | 'P2' | 'P3';
  message: string;
  file?: string;
  line?: number;
  disposition?: 'fix' | 'dismiss';
  reason?: string;
  fixedBy?: string;
}
export interface WorkflowState {
  schemaVersion: 1;
  profile: 'claude-glm-codex';
  plan: WorkflowPlan;
  cwd: string;
  integrationHead: string;
  /** providerPolicy stays optional: an omitted saved policy stays omitted and legacy-compatible. */
  options: Required<Omit<WorkflowOptions, 'glmModel' | 'codexModel' | 'mode' | 'providerPolicy'>>
    & Pick<WorkflowOptions, 'glmModel' | 'codexModel' | 'mode' | 'providerPolicy'>;
  stage: 'implementation' | 'integration' | 'verification' | 'review' | 'adjudication' | 'remediation' | 'complete';
  tasks: WorkflowTaskState[];
  verification?: { head: string; passed: boolean; checks: Array<{ command: WorkflowCommand; passed: boolean; artifacts: ArtifactDescriptor[] }> };
  reviewPasses: number;
  reviews: Array<{ pass: number; head: string; findings: WorkflowFinding[]; artifacts: ArtifactDescriptor[] }>;
  reviewAttempts?: WorkflowReviewAttempt[];
  createdAt: string;
  updatedAt: string;
}
/** Legacy controller type stays unchanged until the V2 controller is wired explicitly. */
export type WorkflowRouteTelemetry = Omit<WorkflowTelemetry, 'provider'> & { provider: WorkflowProviderRoute };
export interface WorkflowInvocationV2 extends Omit<WorkflowInvocation, 'telemetry'> {
  readonly invocationId: string;
  readonly binding: WorkflowRoleBinding;
  telemetry: WorkflowRouteTelemetry;
}
export interface WorkflowReviewProvenance {
  readonly relation: 'independent' | 'self-review' | 'unknown';
  readonly authorIds: readonly string[];
  readonly reviewerId: string;
  readonly context: 'fresh' | 'same-session' | 'unknown';
}
export interface WorkflowReviewAttemptV2 extends Omit<WorkflowReviewAttempt, 'telemetry'> {
  readonly invocationId: string;
  readonly binding: WorkflowRoleBinding;
  readonly provenance: WorkflowReviewProvenance;
  telemetry: WorkflowRouteTelemetry;
}
export interface WorkflowTaskStateV2 extends Omit<WorkflowTaskState, 'invocations' | 'session'> {
  invocations?: WorkflowInvocationV2[];
  session?: NonNullable<WorkflowTaskState['session']> & { readonly binding: WorkflowRoleBinding };
}
export interface WorkflowStateV2 extends Omit<WorkflowState, 'schemaVersion' | 'profile' | 'tasks' | 'reviewAttempts'> {
  schemaVersion: 2;
  profile: 'role-substitution';
  bindings: Readonly<Record<WorkflowRole, WorkflowRoleBinding>>;
  substitutions: readonly WorkflowSubstitution[];
  tasks: WorkflowTaskStateV2[];
  reviewAttempts?: WorkflowReviewAttemptV2[];
}
export type VersionedWorkflowState = WorkflowState | WorkflowStateV2;
export interface WorkflowSubstitution {
  readonly sequence: number;
  readonly role: WorkflowRole;
  readonly from: WorkflowRoleBinding;
  readonly to: WorkflowRoleBinding;
  readonly reason: string;
  readonly authorityRef: string;
  readonly head: string;
  readonly at: string;
  readonly taskId?: string;
  readonly afterAttempt?: number;
  readonly afterReviewPass?: number;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('workflow_expected_object');
  return value as Record<string, unknown>;
}
function exactObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const raw = object(value);
  if (Object.keys(raw).some(key => !keys.includes(key))) throw new Error('workflow_unknown_field');
  return raw;
}
function digest(value: unknown): string {
  const text = boundedText(value, 64);
  if (!/^[a-f0-9]{64}$/.test(text)) throw new Error('workflow_invalid_digest');
  return text;
}
function literal(value: unknown, limit = 160): string {
  const text = boundedText(value, limit);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/.test(text)) throw new Error('workflow_invalid_literal');
  return text;
}
function modelLiteral(value: unknown): string {
  const text = boundedText(value, 160);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/@+-]*(?:\[[A-Za-z0-9._+-]+\])?$/.test(text)) throw new Error('workflow_invalid_model');
  return text;
}
/** The only present value is 'supervised'; omission stays omitted and is never rewritten or migrated. */
export function parseWorkflowProviderPolicy(value: unknown): WorkflowProviderPolicy | undefined {
  if (value === undefined) return undefined;
  if (value !== 'supervised') throw new Error('workflow_invalid_policy');
  return value;
}
export function parseWorkflowBinding(value: unknown): WorkflowRoleBinding {
  const raw = exactObject(value, ['id', 'role', 'providerRoute', 'cliFamily', 'model', 'effort', 'authProfileRef', 'authFingerprint', 'executableIdentity', 'capabilities', 'capabilityEvidenceSha256']);
  const role = raw.role as WorkflowRole;
  const providerRoute = raw.providerRoute as WorkflowProviderRoute;
  if (!['lead', 'implementer', 'reviewer'].includes(role) || !['claude', 'glm', 'codex'].includes(providerRoute)
    || (role === 'implementer' && providerRoute === 'codex') || (role !== 'implementer' && providerRoute === 'glm')) throw new Error('workflow_unsupported_role_route');
  const cliFamily = role === 'lead' ? 'external' : providerRoute === 'codex' ? 'codex-exec' : 'claude-code';
  if (raw.cliFamily !== cliFamily) throw new Error('workflow_invalid_cli_family');
  const capabilities = texts(raw.capabilities, 6) as WorkflowCapability[];
  const required = role === 'lead' ? ['external-lead'] : role === 'implementer' ? ['structured-handoff'] : ['structured-findings', 'read-only'];
  const allowed = [...required, ...(role === 'lead' ? [] : ['session-resume']), ...(role === 'reviewer' ? ['review-permission-transition'] : [])];
  if (new Set(capabilities).size !== capabilities.length || capabilities.some(item => !allowed.includes(item)) || required.some(item => !capabilities.includes(item as WorkflowCapability))) throw new Error('workflow_invalid_capabilities');
  let executableIdentity: WorkflowRoleBinding['executableIdentity'];
  if (role === 'lead') {
    if (raw.executableIdentity !== undefined) throw new Error('workflow_external_lead_has_no_runner');
  } else {
    const executable = exactObject(raw.executableIdentity, ['path', 'sha256', 'version']);
    const path = boundedText(executable.path, 1000);
    if (/[\r\n]/.test(path)) throw new Error('workflow_invalid_executable');
    executableIdentity = Object.freeze({ path, sha256: digest(executable.sha256), version: literal(executable.version) });
  }
  return Object.freeze({ id: safeWorkflowId(raw.id), role, providerRoute, cliFamily, model: modelLiteral(raw.model),
    ...(raw.effort === undefined ? {} : { effort: literal(raw.effort, 30) }), authProfileRef: safeWorkflowId(raw.authProfileRef),
    authFingerprint: digest(raw.authFingerprint), ...(executableIdentity ? { executableIdentity } : {}),
    capabilities: Object.freeze(capabilities), capabilityEvidenceSha256: digest(raw.capabilityEvidenceSha256) });
}
/** Binding compatibility only; caller must also verify confirmed session/cwd/base/context and budget. */
export function assertWorkflowResumeBinding(saved: unknown, selected: unknown): void {
  const previous = parseWorkflowBinding(saved); const next = parseWorkflowBinding(selected);
  if (!previous.capabilities.includes('session-resume') || !isDeepStrictEqual(previous, next)) throw new Error('workflow_resume_binding_mismatch');
}
function integer(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) throw new Error('workflow_invalid_counter');
  return Number(value);
}
function timestamp(value: unknown): string {
  const text = boundedText(value, 24);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(text) || !Number.isFinite(Date.parse(text)) || new Date(text).toISOString() !== text) throw new Error('workflow_invalid_timestamp');
  return text;
}
function boundAttempt(value: unknown, role: 'implementer' | 'reviewer', ordinal: number): Record<string, unknown> {
  const raw = object(value);
  validateOrchestrationHost(raw.orchestrationHost);
  const binding = parseWorkflowBinding(raw.binding);
  const invocationId = boundedText(raw.invocationId, 36);
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(invocationId)) throw new Error('workflow_invalid_invocation_id');
  if (binding.role !== role || (raw.model !== undefined && raw.model !== binding.model)) throw new Error('workflow_invocation_binding_mismatch');
  if (!['completed', 'failed'].includes(String(raw.outcome)) || !Array.isArray(raw.artifacts)) throw new Error('workflow_invalid_invocation');
  if (object(raw.telemetry).provider !== binding.providerRoute) throw new Error('workflow_telemetry_route_mismatch');
  const field = role === 'implementer' ? 'attempt' : 'pass';
  if (raw[field] !== ordinal) throw new Error('workflow_invocation_sequence_mismatch');
  if (role === 'implementer' && !['fresh', 'resume'].includes(String(raw.mode))) throw new Error('workflow_invalid_invocation_mode');
  const parsed = { ...raw, startedAt: timestamp(raw.startedAt), binding, invocationId };
  // The outcome/telemetry may settle later; the reserved identity may not change.
  Object.defineProperties(parsed, { binding: { writable: false, configurable: false }, invocationId: { writable: false, configurable: false },
    ...(raw.orchestrationHost === undefined ? {} : { orchestrationHost: { writable: false, configurable: false } }) });
  return parsed;
}
function validateOrchestrationHost(value: unknown): void {
  if (value !== undefined && value !== 'claude' && value !== 'codex') throw new Error('workflow_invalid_orchestration_host');
}
function reviewProvenance(value: unknown, binding: WorkflowRoleBinding): WorkflowReviewProvenance {
  const raw = exactObject(value, ['relation', 'authorIds', 'reviewerId', 'context']);
  const authorIds = texts(raw.authorIds, 100).map(value => literal(value, 200));
  const reviewerId = literal(raw.reviewerId, 200);
  if (!['independent', 'self-review', 'unknown'].includes(String(raw.relation)) || !['fresh', 'same-session', 'unknown'].includes(String(raw.context))) throw new Error('workflow_invalid_review_provenance');
  if (raw.relation === 'independent' && (authorIds.includes(reviewerId) || raw.context !== 'fresh')) throw new Error('workflow_false_independent_review');
  if (raw.context === 'same-session' && !binding.capabilities.includes('review-permission-transition')) throw new Error('workflow_review_transition_unsupported');
  return Object.freeze({ relation: raw.relation as WorkflowReviewProvenance['relation'], context: raw.context as WorkflowReviewProvenance['context'],
    authorIds: Object.freeze(authorIds), reviewerId });
}
export function parseWorkflowSubstitution(value: unknown): WorkflowSubstitution {
  const raw = exactObject(value, ['sequence', 'role', 'from', 'to', 'reason', 'authorityRef', 'head', 'at', 'taskId', 'afterAttempt', 'afterReviewPass']);
  const from = parseWorkflowBinding(raw.from); const to = parseWorkflowBinding(raw.to);
  if (from.role !== raw.role || to.role !== raw.role || isDeepStrictEqual(from, to)) throw new Error('workflow_invalid_substitution_binding');
  if (raw.afterAttempt !== undefined && (raw.role !== 'implementer' || raw.taskId === undefined)
    || raw.afterReviewPass !== undefined && raw.role !== 'reviewer'
    || raw.taskId !== undefined && raw.role !== 'implementer') throw new Error('workflow_invalid_substitution_target');
  return Object.freeze({ sequence: integer(raw.sequence, 1, 1000), role: from.role, from, to,
    reason: boundedText(raw.reason, 1000), authorityRef: boundedText(raw.authorityRef, 1000), head: workflowSha(raw.head), at: timestamp(raw.at),
    ...(raw.taskId === undefined ? {} : { taskId: safeWorkflowId(raw.taskId) }),
    ...(raw.afterAttempt === undefined ? {} : { afterAttempt: integer(raw.afterAttempt, 0, 5) }),
    ...(raw.afterReviewPass === undefined ? {} : { afterReviewPass: integer(raw.afterReviewPass, 0, 10) }) });
}
/** Pure contract loading only: caller still checks cwd, head, lock and persisted-file identity. */
export function parseWorkflowState(value: unknown): VersionedWorkflowState {
  const raw = object(value);
  if (!((raw.schemaVersion === 1 && raw.profile === 'claude-glm-codex') || (raw.schemaVersion === 2 && raw.profile === 'role-substitution'))
    || !Array.isArray(raw.tasks) || !Array.isArray(raw.reviews)) throw new Error('workflow_invalid_state');
  const options = object(raw.options);
  if (options.mode !== undefined && !['v1', 'balanced'].includes(String(options.mode))) throw new Error('workflow_invalid_mode');
  // Validate any present policy for both schemas; omission is never rewritten into a saved value.
  parseWorkflowProviderPolicy(options.providerPolicy);
  for (const task of raw.tasks) {
    const invocations = object(task).invocations;
    if (Array.isArray(invocations)) for (const invocation of invocations) validateOrchestrationHost(object(invocation).orchestrationHost);
  }
  if (Array.isArray(raw.reviewAttempts)) for (const attempt of raw.reviewAttempts) validateOrchestrationHost(object(attempt).orchestrationHost);
  const rejected = new Set(raw.tasks.filter(entry => object(entry).status === 'rejected').map(entry => safeWorkflowId(object(object(entry).task).id)));
  const plan = parseWorkflowPlan(raw.plan, rejected);
  // Preserve legacy shape and optional fields exactly; this is not a migration.
  if (raw.schemaVersion === 1) return value as WorkflowState;
  const maxAttempts = integer(options.maxAttempts, 1, 5);
  const maxReviewPasses = integer(options.maxReviewPasses, 1, 10);
  integer(raw.reviewPasses, 0, maxReviewPasses);
  if (raw.tasks.length !== plan.tasks.length) throw new Error('workflow_saved_tasks_mismatch');
  const taskIds = new Set<string>();
  const tasks: Array<Record<string, unknown> & { invocations?: Record<string, unknown>[] }> = raw.tasks.map(value => {
    const task = object(value);
    const contract = parseWorkflowTask(task.task);
    if (!plan.tasks.some(entry => entry.id === contract.id) || taskIds.has(contract.id)) throw new Error('workflow_saved_tasks_mismatch');
    taskIds.add(contract.id);
    if (!['pending', 'running', 'completed', 'failed', 'accepted', 'rejected'].includes(String(task.status))) throw new Error('workflow_invalid_task_status');
    const attempts = integer(task.attempts, 0, maxAttempts);
    const invocations = task.invocations ?? [];
    if (!Array.isArray(invocations) || invocations.length !== attempts) throw new Error('workflow_attempt_history_mismatch');
    let session: Record<string, unknown> | undefined;
    if (task.session !== undefined) {
      const saved = exactObject(task.session, ['id', 'confirmed', 'fingerprint', 'worktree', 'branch', 'binding']);
      const binding = parseWorkflowBinding(saved.binding);
      if (binding.role !== 'implementer' || !binding.capabilities.includes('session-resume') || typeof saved.confirmed !== 'boolean') throw new Error('workflow_invalid_session_binding');
      session = { ...saved, id: literal(saved.id, 100), fingerprint: digest(saved.fingerprint), worktree: boundedText(saved.worktree, 1000), branch: boundedText(saved.branch, 200), binding };
      Object.defineProperty(session, 'binding', { writable: false, configurable: false });
    }
    return { ...task, task: contract, ...(session ? { session } : {}), ...(task.invocations === undefined ? {} : { invocations: invocations.map((entry, index) => boundAttempt(entry, 'implementer', index + 1)) }) };
  });
  const reviewAttempts = raw.reviewAttempts ?? [];
  if (!Array.isArray(reviewAttempts) || reviewAttempts.length !== raw.reviewPasses) throw new Error('workflow_review_history_mismatch');
  const parsedReviews = reviewAttempts.map((value, index) => {
    const entry = boundAttempt(value, 'reviewer', index + 1);
    entry.head = workflowSha(entry.head);
    Object.defineProperty(entry, 'provenance', { value: reviewProvenance(entry.provenance, entry.binding as WorkflowRoleBinding), writable: false, configurable: false, enumerable: true });
    return entry;
  });
  const bindings = exactObject(raw.bindings, ['lead', 'implementer', 'reviewer']);
  const parsedBindings = { lead: parseWorkflowBinding(bindings.lead), implementer: parseWorkflowBinding(bindings.implementer), reviewer: parseWorkflowBinding(bindings.reviewer) };
  for (const role of ['lead', 'implementer', 'reviewer'] as const) if (parsedBindings[role].role !== role) throw new Error('workflow_binding_role_mismatch');
  if (!Array.isArray(raw.substitutions) || raw.substitutions.length > 1000) throw new Error('workflow_invalid_substitutions');
  const substitutions = raw.substitutions.map(parseWorkflowSubstitution);
  const chain = new Map<WorkflowRole, WorkflowRoleBinding>();
  const known = new Map<string, WorkflowRoleBinding>();
  const remember = (binding: WorkflowRoleBinding) => {
    if (known.has(binding.id) && !isDeepStrictEqual(known.get(binding.id), binding)) throw new Error('workflow_binding_identity_collision');
    known.set(binding.id, binding);
  };
  substitutions.forEach((entry, index) => {
    if (entry.sequence !== index + 1 || chain.has(entry.role) && !isDeepStrictEqual(chain.get(entry.role), entry.from)) throw new Error('workflow_substitution_chain_mismatch');
    if (entry.taskId !== undefined) {
      const task = tasks.find(task => object(task.task).id === entry.taskId);
      if (!task || entry.afterAttempt !== undefined && entry.afterAttempt > Number(task.attempts)) throw new Error('workflow_substitution_attempt_mismatch');
    }
    if (entry.afterReviewPass !== undefined && entry.afterReviewPass > Number(raw.reviewPasses)) throw new Error('workflow_substitution_review_mismatch');
    remember(entry.from); remember(entry.to); chain.set(entry.role, entry.to);
  });
  for (const role of ['lead', 'implementer', 'reviewer'] as const) {
    if (chain.has(role) && !isDeepStrictEqual(chain.get(role), parsedBindings[role])) throw new Error('workflow_selected_binding_mismatch');
    remember(parsedBindings[role]);
  }
  const ids = new Set<string>();
  const checkSnapshot = (entry: Record<string, unknown>) => {
    const binding = entry.binding as WorkflowRoleBinding;
    if (!isDeepStrictEqual(known.get(binding.id), binding)) throw new Error('workflow_unknown_binding_snapshot');
    if (ids.has(String(entry.invocationId))) throw new Error('workflow_duplicate_invocation');
    ids.add(String(entry.invocationId));
  };
  for (const task of tasks) {
    for (const invocation of task.invocations ?? []) checkSnapshot(invocation);
    if (task.session !== undefined) {
      const binding = object(task.session).binding as WorkflowRoleBinding;
      if (!isDeepStrictEqual(known.get(binding.id), binding)) throw new Error('workflow_unknown_session_binding');
    }
  }
  for (const review of parsedReviews) checkSnapshot(review);
  return { ...raw, tasks, ...(raw.reviewAttempts === undefined ? {} : { reviewAttempts: parsedReviews }),
    substitutions: Object.freeze(substitutions), bindings: Object.freeze(parsedBindings) } as unknown as WorkflowStateV2;
}
/** Compare saved contracts under the controller's lock; this does not reserve or execute work. */
export function validateWorkflowStateTransition(previous: unknown, next: unknown): void {
  const before = parseWorkflowState(previous); const after = parseWorkflowState(next);
  if (before.schemaVersion !== after.schemaVersion) throw new Error('workflow_implicit_migration_forbidden');
  // Host provenance is immutable for both legacy and role-substitution workflows.
  const preserveHosts = (old: Array<WorkflowInvocation | WorkflowReviewAttempt>, current: Array<WorkflowInvocation | WorkflowReviewAttempt>) => {
    for (const [index, entry] of old.entries()) {
      if (!current[index] || entry.orchestrationHost !== current[index].orchestrationHost) throw new Error('workflow_orchestration_history_rewritten');
    }
  };
  for (const task of before.tasks) {
    const replacement = after.tasks.find(entry => entry.task.id === task.task.id);
    preserveHosts(task.invocations ?? [], replacement?.invocations ?? []);
  }
  preserveHosts(before.reviewAttempts ?? [], after.reviewAttempts ?? []);
  if (before.schemaVersion !== 2 || after.schemaVersion !== 2) return;
  if (before.cwd !== after.cwd || before.plan.name !== after.plan.name || before.plan.baseCommit !== after.plan.baseCommit
    || before.plan.integrationBranch !== after.plan.integrationBranch) throw new Error('workflow_state_identity_changed');
  if (before.options.maxAttempts !== after.options.maxAttempts || before.options.maxReviewPasses !== after.options.maxReviewPasses
    || after.reviewPasses < before.reviewPasses) throw new Error('workflow_budget_reset_forbidden');
  // The selected policy is part of the initialization contract and cannot change afterwards.
  if (before.options.providerPolicy !== after.options.providerPolicy) throw new Error('workflow_policy_change_forbidden');
  if (after.substitutions.length < before.substitutions.length
    || before.substitutions.some((entry, index) => !isDeepStrictEqual(entry, after.substitutions[index]))) throw new Error('workflow_substitution_history_rewritten');
  const selected = { ...before.bindings };
  for (const entry of after.substitutions.slice(before.substitutions.length)) {
    if (!isDeepStrictEqual(selected[entry.role], entry.from) || entry.head !== before.integrationHead) throw new Error('workflow_substitution_origin_mismatch');
    selected[entry.role] = entry.to;
  }
  if (!isDeepStrictEqual(selected, after.bindings)) throw new Error('workflow_unrecorded_substitution');
  const preserveAttempts = (old: Array<WorkflowInvocationV2 | WorkflowReviewAttemptV2>, current: Array<WorkflowInvocationV2 | WorkflowReviewAttemptV2>) => {
    for (const [index, entry] of old.entries()) {
      const replacement = current[index];
      if (!replacement || entry.invocationId !== replacement.invocationId || !isDeepStrictEqual(entry.binding, replacement.binding)
        || entry.startedAt !== replacement.startedAt || entry.model !== replacement.model) throw new Error('workflow_invocation_identity_rewritten');
      if ('mode' in entry && (!('mode' in replacement) || entry.mode !== replacement.mode)
        || 'head' in entry && (!('head' in replacement) || entry.head !== replacement.head || !isDeepStrictEqual(entry.provenance, replacement.provenance))) throw new Error('workflow_invocation_identity_rewritten');
      if (entry.error !== 'workflow_invocation_incomplete' && !isDeepStrictEqual(entry, replacement)) throw new Error('workflow_invocation_history_rewritten');
    }
  };
  for (const task of before.tasks) {
    const replacement = after.tasks.find(entry => entry.task.id === task.task.id);
    if (!replacement || replacement.attempts < task.attempts) throw new Error('workflow_budget_reset_forbidden');
    preserveAttempts(task.invocations ?? [], replacement.invocations ?? []);
  }
  preserveAttempts(before.reviewAttempts ?? [], after.reviewAttempts ?? []);
}
export function boundedText(value: unknown, limit = 2000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || value.includes('\0')) throw new Error('workflow_invalid_text');
  return value;
}
export function safeWorkflowId(value: unknown): string {
  const text = boundedText(value, 30);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(text)) throw new Error('workflow_invalid_id');
  return text;
}
export function workflowSha(value: unknown): string {
  const text = boundedText(value, 64);
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(text)) throw new Error('workflow_invalid_sha');
  return text;
}
function texts(value: unknown, limit = 100): string[] {
  if (!Array.isArray(value) || value.length > limit) throw new Error('workflow_invalid_list');
  return value.map(item => boundedText(item));
}
export function scopePath(value: unknown): string {
  const text = boundedText(value, 400).replaceAll('\\', '/');
  const path = text.endsWith('/**') ? text.slice(0, -3) : text;
  if (path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..' || part === '.git' || part === '.omc')
    || /[:*?\[\]{}\r\n]/.test(path)) throw new Error('workflow_invalid_scope');
  if (process.platform === 'win32' && path.split('/').some(part => /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error('workflow_invalid_scope');
  return path;
}
export function matchesScope(path: string, scopes: string[]): boolean {
  const normalized = process.platform === 'win32' ? path.toLowerCase() : path;
  return scopes.some(scope => {
    const candidate = process.platform === 'win32' ? scope.toLowerCase() : scope;
    return normalized === candidate || normalized.startsWith(`${candidate}/`);
  });
}
export function parseWorkflowCommand(value: unknown): WorkflowCommand {
  const raw = object(value);
  const command = boundedText(raw.command, 1000);
  if (/[\r\n]/.test(command)) throw new Error('workflow_invalid_command');
  if (!Array.isArray(raw.args) || raw.args.length > 100 || raw.args.some(arg => typeof arg !== 'string' || arg.length > 4000 || arg.includes('\0'))) throw new Error('workflow_invalid_arguments');
  return { command, args: raw.args as string[] };
}
export function parseWorkflowTask(value: unknown): WorkflowTask {
  if (Buffer.byteLength(JSON.stringify(value) ?? '') > 48 * 1024) throw new Error('workflow_task_too_large');
  const raw = object(value);
  const writeScope = texts(raw.writeScope).map(scopePath);
  if (!writeScope.length) throw new Error('workflow_write_scope_required');
  if (!Array.isArray(raw.tests) || raw.tests.length > 30) throw new Error('workflow_invalid_tests');
  return { id: safeWorkflowId(raw.id), objective: boundedText(raw.objective), baseCommit: workflowSha(raw.baseCommit),
    writeScope, readScope: texts(raw.readScope).map(scopePath), prohibitedScope: texts(raw.prohibitedScope).map(scopePath),
    dependencies: texts(raw.dependencies).map(safeWorkflowId), contracts: texts(raw.contracts),
    acceptanceCriteria: texts(raw.acceptanceCriteria), tests: raw.tests.map(parseWorkflowCommand) };
}
export function validateWorkflowTasks(tasks: WorkflowTask[], rejectedTaskIds: ReadonlySet<string> = new Set()): void {
  const byId = new Map(tasks.map(task => [task.id, task]));
  if (byId.size !== tasks.length) throw new Error('workflow_duplicate_task');
  const dependencySets = new Map<string, Set<string>>();
  function dependencies(task: WorkflowTask, visiting = new Set<string>()): Set<string> {
    if (visiting.has(task.id)) throw new Error('workflow_dependency_cycle');
    const cached = dependencySets.get(task.id);
    if (cached) return cached;
    const next = new Set([...visiting, task.id]);
    const all = new Set<string>();
    for (const id of task.dependencies) {
      const dependency = byId.get(id);
      if (!dependency) throw new Error('workflow_missing_dependency');
      all.add(id);
      for (const ancestor of dependencies(dependency, next)) all.add(ancestor);
    }
    dependencySets.set(task.id, all);
    return all;
  }
  const depends = (task: WorkflowTask, target: string) => dependencies(task).has(target);
  for (const task of tasks) {
    depends(task, task.id);
    if (!task.acceptanceCriteria.length) throw new Error('workflow_acceptance_required');
    if (task.writeScope.some(path => task.prohibitedScope.some(p => matchesScope(path, [p]) || matchesScope(p, [path])))) throw new Error('workflow_prohibited_write_scope');
  }
  for (let i = 0; i < tasks.length; i++) for (let j = i + 1; j < tasks.length; j++) {
    const a = tasks[i]!; const b = tasks[j]!;
    // Rejected work remains in the dependency graph and history, but no longer owns its write scope.
    if (rejectedTaskIds.has(a.id) || rejectedTaskIds.has(b.id)) continue;
    const overlap = a.writeScope.some(path => b.writeScope.some(p => matchesScope(path, [p]) || matchesScope(p, [path])));
    if (overlap && !depends(a, b.id) && !depends(b, a.id)) throw new Error('workflow_overlapping_write_scope');
  }
}
export function parseWorkflowPlan(value: unknown, rejectedTaskIds: ReadonlySet<string> = new Set()): WorkflowPlan {
  if (Buffer.byteLength(JSON.stringify(value) ?? '') > 512 * 1024) throw new Error('workflow_plan_too_large');
  const raw = object(value);
  if (!Array.isArray(raw.tasks) || raw.tasks.length < 1 || raw.tasks.length > 100) throw new Error('workflow_invalid_tasks');
  if (!Array.isArray(raw.verification) || !raw.verification.length || raw.verification.length > 30) throw new Error('workflow_verification_required');
  const tasks = raw.tasks.map(parseWorkflowTask);
  const sharedContext = raw.sharedContext === undefined ? undefined : boundedText(raw.sharedContext, 16 * 1024);
  if (sharedContext !== undefined && Buffer.byteLength(sharedContext) > 16 * 1024) throw new Error('workflow_shared_context_too_large');
  validateWorkflowTasks(tasks, rejectedTaskIds);
  return { name: safeWorkflowId(raw.name), objective: boundedText(raw.objective), baseCommit: workflowSha(raw.baseCommit),
    integrationBranch: boundedText(raw.integrationBranch, 200), tasks, verification: raw.verification.map(parseWorkflowCommand),
    ...(sharedContext === undefined ? {} : { sharedContext }) };
}
export function parseWorkflowHandoff(value: unknown, taskId: string): WorkflowHandoff {
  const raw = object(value);
  if (raw.taskId !== taskId || !['completed', 'failed'].includes(String(raw.outcome))) throw new Error('workflow_invalid_handoff_identity');
  if (!Array.isArray(raw.tests) || raw.tests.length > 30) throw new Error('workflow_invalid_handoff_tests');
  const tests = raw.tests.map(value => {
    const test = object(value);
    if (typeof test.passed !== 'boolean') throw new Error('workflow_invalid_test_result');
    return { ...parseWorkflowCommand(test), passed: test.passed };
  });
  return { taskId, outcome: raw.outcome as 'completed' | 'failed', ...(raw.commitSha ? { commitSha: workflowSha(raw.commitSha) } : {}),
    changedFiles: texts(raw.changedFiles).map(scopePath), tests, interfaceChanges: texts(raw.interfaceChanges, 30),
    assumptions: texts(raw.assumptions, 30), risks: texts(raw.risks, 30), summary: boundedText(raw.summary, 1000), artifacts: [] };
}
export function parseWorkflowFindings(value: unknown, pass: number): WorkflowFinding[] {
  const raw = object(value);
  if (!Array.isArray(raw.findings) || raw.findings.length > 50) throw new Error('workflow_invalid_findings');
  return raw.findings.map((entry, index) => {
    const finding = object(entry);
    if (!['P0', 'P1', 'P2', 'P3'].includes(String(finding.severity))) throw new Error('workflow_invalid_severity');
    if (finding.line !== undefined && finding.line !== null && (!Number.isInteger(finding.line) || Number(finding.line) < 1)) throw new Error('workflow_invalid_line');
    return { id: `review-${pass}-${index + 1}`, severity: finding.severity as WorkflowFinding['severity'], message: boundedText(finding.message),
      ...(finding.file ? { file: scopePath(finding.file) } : {}), ...(finding.line ? { line: Number(finding.line) } : {}) };
  });
}
