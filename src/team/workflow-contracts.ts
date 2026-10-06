import type { ArtifactDescriptor } from '../shared/artifact-descriptor.js';
import type { WorkflowIdentityEvidence, WorkflowTelemetry, WorkflowTelemetryEvidence,
  WorkflowTerminalUsageEvidence } from './workflow-usage.js';
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import type { OrchestratorHost } from '../orchestration/selection.js';
import { MAX_WORKFLOW_TASK_RECOVERIES, parseWorkflowTaskRecovery,
  type WorkflowTaskRecovery } from './workflow-task-recovery.js';

export type WorkflowRole = 'lead' | 'implementer' | 'reviewer';
export type WorkflowProviderRoute = 'claude' | 'glm' | 'mimo' | 'codex';
/** New states use the descriptive name; the old value remains valid only for saved-state compatibility. */
export type WorkflowProviderPolicy = 'unbounded-provider-timeout' | 'supervised';
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
  setupAttempts?: WorkflowSetupAttempt[];
}
export interface WorkflowSetupAttempt {
  readonly sequence: number;
  readonly startedAt: string;
  readonly mode?: 'fresh' | 'resume';
  readonly outcome: 'completed' | 'failed';
  readonly error?: 'workflow_worktree_setup_failed';
  readonly detail?: WorkflowWorktreeSetupDetail;
  readonly artifact?: ArtifactDescriptor;
}
export type WorkflowWorktreeSetupDetail = 'worktree_branch_mismatch' | 'worktree_branch_in_use'
  | 'worktree_path_mismatch' | 'worktree_mismatch';
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
  /** Output-free observation captured from the provider process before result validation. */
  readonly processResult?: WorkflowProcessResultSnapshot;
  /** Provider process identity captured at spawn; lets explicit recovery prove an interrupted attempt is dead. */
  process?: WorkflowProviderProcessIdentity;
  /** Controller process identity captured when the attempt was reserved, for crashes before the provider spawned. */
  controller?: WorkflowProviderProcessIdentity;
}
export interface WorkflowProviderProcessIdentity {
  readonly pid: number;
  readonly processStartedAt: string | null;
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
  /** Output-free observation captured from the provider process before result validation. */
  readonly processResult?: WorkflowProcessResultSnapshot;
}
export interface WorkflowProcessResultSnapshot {
  readonly passed: boolean;
  /** A bounded integrity failure retained separately from actual process/close facts. */
  readonly integrityDiagnostic?: string;
  readonly error?: 'launch_failed' | 'timeout' | 'interrupted' | 'process_failed' | 'throttled' | 'protocol_failed' | 'output_incomplete';
  readonly parentExitedSuccessfully: boolean;
  readonly stdoutTruncated: boolean;
  readonly settlement?: WorkflowProcessSettlementSnapshot;
}
export interface WorkflowProcessSettlementSnapshot {
  readonly parentExitCode: number | null;
  readonly parentExitSignal: string | null;
  readonly outputComplete: boolean;
  readonly termination: 'not-requested' | 'attempted' | 'failed';
  readonly directChild: 'not-started' | 'exited' | 'unconfirmed';
  readonly descendants: 'not-started' | 'unverified' | 'cleaned';
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
  profile: 'claude-glm-codex' | 'claude-mimo-codex';
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
  /** Omitted states retain the v1.5 accounting rule where every reserved attempt consumes budget. */
  reviewBudgetBasis?: 'completed-reviews';
  reviews: Array<{ pass: number; head: string; findings: WorkflowFinding[]; artifacts: ArtifactDescriptor[] }>;
  reviewAttempts?: WorkflowReviewAttempt[];
  leadIntegrations?: WorkflowLeadIntegration[];
  dispatchSupplements?: WorkflowDispatchSupplement[];
  reviewBudgetExtensions?: WorkflowReviewBudgetExtension[];
  /** Explicit per-operation review compatibility adoptions; append-only and never a pin change. */
  reviewCompatibilityAdoptions?: WorkflowReviewCompatibilityAdoption[];
  taskRecoveries?: readonly WorkflowTaskRecovery[];
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
  /** Present only when this attempt's source was served through an adopted read-only reader. */
  readonly compatibility?: WorkflowReviewCompatibilityBinding;
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
export interface WorkflowBindingRefreshIntent {
  readonly role: 'implementer' | 'reviewer';
  readonly sourceBindingId: string;
  readonly newBindingId: string;
  readonly model: string;
  /** Omission preserves the selected effort; null removes it. */
  readonly effort?: string | null;
  readonly expectedHead: string;
  readonly reason: string;
  readonly authorityRef: string;
  readonly taskId?: string;
}
export interface WorkflowLeadIntegrationActor {
  readonly id: string;
  readonly model: string;
}
export interface WorkflowLeadIntegrationCheck {
  readonly command: WorkflowCommand;
  readonly passed: true;
  readonly artifacts: readonly ArtifactDescriptor[];
}
export interface WorkflowLeadIntegration {
  readonly sequence: number;
  readonly parent: string;
  readonly head: string;
  readonly changedFiles: readonly string[];
  readonly orchestrationHost: OrchestratorHost;
  readonly actor: WorkflowLeadIntegrationActor;
  readonly authorityRef: string;
  readonly reason: string;
  readonly checks: readonly WorkflowLeadIntegrationCheck[];
  readonly at: string;
}
export interface WorkflowLeadIntegrationIntent {
  readonly expectedParent: string;
  readonly expectedHead: string;
  readonly actor: WorkflowLeadIntegrationActor;
  readonly authorityRef: string;
  readonly reason: string;
  readonly paths: readonly string[];
  readonly checks: readonly WorkflowCommand[];
}
export interface WorkflowDispatchSupplement {
  readonly sequence: number;
  readonly taskId: string;
  readonly expectedInputHead: string;
  readonly orchestrationHost: OrchestratorHost;
  readonly actor: WorkflowLeadIntegrationActor;
  readonly authorityRef: string;
  readonly reason: string;
  readonly content: string;
  readonly contentSha256: string;
  readonly at: string;
}
export type WorkflowDispatchSupplementIntent = Omit<WorkflowDispatchSupplement,
  'sequence' | 'orchestrationHost' | 'at'>;
export interface WorkflowReviewBudgetExtension {
  readonly sequence: number;
  readonly requestId: string;
  readonly oldCeiling: number;
  readonly newCeiling: number;
  readonly head: string;
  readonly orchestrationHost: OrchestratorHost;
  readonly actor: WorkflowLeadIntegrationActor;
  readonly authorityRef: string;
  readonly reason: string;
  readonly at: string;
}
export interface WorkflowReviewBudgetExtensionIntent {
  readonly requestId: string;
  readonly expectedHead: string;
  readonly expectedCeiling: number;
  readonly increment: number;
  readonly actor: WorkflowLeadIntegrationActor;
  readonly authorityRef: string;
  readonly reason: string;
}
/**
 * Version of the lossless review transport descriptor. A descriptor binds only per-response and
 * per-stream buffer policies; it carries no aggregate review, context, request or source ceiling,
 * so no saved adoption can silently re-introduce a total byte/file/page/read limit over the
 * complete delivery. The parser admits exactly this field set, so an older descriptor that tried
 * to carry a total would be refused rather than silently honored.
 */
export const WORKFLOW_REVIEW_TRANSPORT_SCHEMA_VERSION = 2;
/** Bound on one complete encoded reader response, including metadata and encoding overhead. */
export const WORKFLOW_REVIEW_READ_LIMIT_BYTES = 8 * 1024;
/** Bound on one streaming buffer used to spool unbounded source and Git stdout. */
export const WORKFLOW_REVIEW_BUFFER_LIMIT_BYTES = 64 * 1024;
export interface WorkflowReviewBuildIdentity {
  readonly id: string;
  readonly sha256: string;
}
/** The per-response/per-buffer policy of one lossless review transport descriptor. */
export interface WorkflowReviewTransportPolicy {
  readonly schemaVersion: number;
  readonly responseBytes: number;
  readonly bufferBytes: number;
}
/** The current versioned transport policy; every per-request bound is a buffer, never a total. */
export function workflowReviewTransportPolicy(): WorkflowReviewTransportPolicy {
  return Object.freeze({ schemaVersion: WORKFLOW_REVIEW_TRANSPORT_SCHEMA_VERSION,
    responseBytes: WORKFLOW_REVIEW_READ_LIMIT_BYTES, bufferBytes: WORKFLOW_REVIEW_BUFFER_LIMIT_BYTES });
}
export const WORKFLOW_REVIEW_SOURCE_MANIFEST_SCHEMA_VERSION = 1;
/**
 * The immutable disk descriptor of one authorized source manifest. It names the manifest file, its
 * exact byte count and record count and its content digest, and nothing else: the authorized path
 * set itself is never carried in state, so a recorded adoption can neither grow with the size of
 * the change nor restate a prospective file list that might differ from the frozen manifest.
 */
export interface WorkflowReviewSourceManifestDescriptor {
  readonly schemaVersion: number;
  readonly path: string;
  readonly bytes: number;
  readonly records: number;
  readonly sha256: string;
}
/**
 * The authorized source of one final PR. It is bound to the exact final-PR base and head —
 * deliberately separate from the workflow's own narrower task base/delta — and commits to the
 * immutable disk manifest through its descriptor. The digest commits to the pair and the
 * descriptor together, so a selection that names another revision or another manifest, or that
 * restates a descriptor whose manifest has been rewritten on disk, can never match the recorded
 * authority. A pre-descriptor array-form record is still parsed, with its original digest
 * derivation, so an old saved state loads read-only; a descriptor is required to select one.
 */
export interface WorkflowReviewAuthorizedSource {
  readonly baseCommit: string;
  readonly head: string;
  readonly descriptor?: WorkflowReviewSourceManifestDescriptor;
  /** Legacy read-only array form; present only on a record saved before the disk descriptor. */
  readonly paths?: readonly string[];
  readonly digest: string;
}
/**
 * One explicit administrative adoption of review-transport compatibility. It is
 * a bounded per-operation grant, not a repin: it records the exact authorized
 * source manifest, the controller and reader builds, the versioned transport
 * policy and the unchanged authenticated reviewer identity under which a
 * subsequent review may use the read-only source reader.
 */
export interface WorkflowReviewCompatibilityAdoption {
  readonly sequence: number;
  readonly requestId: string;
  readonly source: WorkflowReviewAuthorizedSource;
  readonly controller: WorkflowReviewBuildIdentity;
  readonly reader: WorkflowReviewBuildIdentity;
  readonly transport: WorkflowReviewTransportPolicy;
  readonly reviewerBindingId: string;
  readonly reviewerAuthFingerprint: string;
  readonly orchestrationHost: OrchestratorHost;
  readonly actor: WorkflowLeadIntegrationActor;
  readonly authorityRef: string;
  readonly reason: string;
  readonly at: string;
}
export type WorkflowReviewCompatibilityAdoptionIntent = Omit<WorkflowReviewCompatibilityAdoption,
  'sequence' | 'orchestrationHost' | 'at' | 'source'> & { readonly source: Omit<WorkflowReviewAuthorizedSource, 'digest'> };
/** Evidence bound to one review attempt whose source was served through the reader. */
export interface WorkflowReviewCompatibilityBinding {
  readonly adoptionSequence: number;
  readonly bundleSha256: string;
  readonly controllerSha256: string;
  readonly readerSha256: string;
}
const MAX_LEAD_INTEGRATIONS = 32;
const MAX_LEAD_INTEGRATION_BYTES = 128 * 1024;
const MAX_DISPATCH_SUPPLEMENTS = 32;
const MAX_DISPATCH_SUPPLEMENT_BYTES = 8 * 1024;
const MAX_DISPATCH_SUPPLEMENT_RECORD_BYTES = 16 * 1024;
const MAX_INITIAL_REVIEW_PASSES = 10;
const MAX_REVIEW_BUDGET_INCREMENT = 10;

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
/** Saved states retain either accepted spelling byte-for-byte; omission stays omitted. */
export function parseWorkflowProviderPolicy(value: unknown): WorkflowProviderPolicy | undefined {
  if (value === undefined) return undefined;
  if (value !== 'unbounded-provider-timeout' && value !== 'supervised') throw new Error('workflow_invalid_policy');
  return value;
}
export function parseWorkflowBinding(value: unknown): WorkflowRoleBinding {
  const raw = exactObject(value, ['id', 'role', 'providerRoute', 'cliFamily', 'model', 'effort', 'authProfileRef', 'authFingerprint', 'executableIdentity', 'capabilities', 'capabilityEvidenceSha256']);
  const role = raw.role as WorkflowRole;
  const providerRoute = raw.providerRoute as WorkflowProviderRoute;
  if (!['lead', 'implementer', 'reviewer'].includes(role) || !['claude', 'glm', 'mimo', 'codex'].includes(providerRoute)
    || (role === 'implementer' && providerRoute === 'codex') || (role !== 'implementer' && (providerRoute === 'glm' || providerRoute === 'mimo'))) throw new Error('workflow_unsupported_role_route');
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
function telemetryObject(value: unknown, keys: readonly string[], error: string): Record<string, unknown> {
  try {
    const raw = object(value);
    if (Object.keys(raw).some(key => !keys.includes(key))) throw new Error(error);
    return raw;
  } catch { throw new Error(error); }
}
function telemetryInteger(value: unknown, minimum: number, error: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) throw new Error(error);
  return Number(value);
}
function telemetryText(value: unknown, limit: number, error: string): string {
  try { return boundedText(value, limit); } catch { throw new Error(error); }
}
function telemetryModel(value: unknown, error: string): string {
  try { return modelLiteral(value); } catch { throw new Error(error); }
}
function parseWorkflowIdentityEvidence(value: unknown, kind: 'session' | 'model'): WorkflowIdentityEvidence {
  const error = 'workflow_invalid_telemetry_evidence';
  const raw = telemetryObject(value,
    ['value', 'initEvents', 'assistantEvents', 'terminalEvents', 'threadEvents', 'terminalUsageBuckets'], error);
  const allowed = kind === 'session'
    ? ['initEvents', 'assistantEvents', 'terminalEvents', 'threadEvents'] as const
    : ['initEvents', 'assistantEvents', 'terminalUsageBuckets'] as const;
  const forbidden = kind === 'session' ? ['terminalUsageBuckets'] : ['terminalEvents', 'threadEvents'];
  if (forbidden.some(key => raw[key] !== undefined)) throw new Error(error);
  const parsed: WorkflowIdentityEvidence = { value: kind === 'session'
    ? (() => { const id = telemetryText(raw.value, 36, error); if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) throw new Error(error); return id; })()
    : telemetryModel(raw.value, error) };
  let observations = 0;
  for (const key of allowed) if (raw[key] !== undefined) {
    const count = telemetryInteger(raw[key], 1, error); observations += count; parsed[key] = count;
  }
  if (!observations) throw new Error(error);
  return Object.freeze(parsed);
}
function parseWorkflowTerminalUsageEvidence(value: unknown): WorkflowTerminalUsageEvidence {
  const error = 'workflow_invalid_telemetry_evidence';
  const raw = telemetryObject(value,
    ['model', 'inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens', 'observations'], error);
  const parsed: WorkflowTerminalUsageEvidence = { model: telemetryModel(raw.model, error),
    observations: telemetryInteger(raw.observations, 1, error) };
  let counters = 0;
  for (const key of ['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens'] as const) {
    if (raw[key] !== undefined) { parsed[key] = telemetryInteger(raw[key], 0, error); counters++; }
  }
  if (!counters) throw new Error(error);
  return Object.freeze(parsed);
}
function parseWorkflowTelemetryEvidence(value: unknown, telemetry: WorkflowTelemetry): WorkflowTelemetryEvidence {
  const error = 'workflow_invalid_telemetry_evidence';
  const raw = telemetryObject(value, ['version', 'diagnosticLogComplete', 'eventStreamComplete', 'identityEvidenceComplete',
    'identityConsistent', 'accountingEvidenceComplete', 'terminalEventCount', 'sessions', 'models', 'terminalUsageBuckets'], error);
  if (raw.version !== 1 || ['diagnosticLogComplete', 'eventStreamComplete', 'identityEvidenceComplete',
    'identityConsistent', 'accountingEvidenceComplete'].some(key => typeof raw[key] !== 'boolean')
    || !Array.isArray(raw.sessions) || raw.sessions.length > 8 || !Array.isArray(raw.models) || raw.models.length > 8
    || !Array.isArray(raw.terminalUsageBuckets) || raw.terminalUsageBuckets.length > 8) throw new Error(error);
  const sessions = raw.sessions.map(entry => parseWorkflowIdentityEvidence(entry, 'session'));
  const models = raw.models.map(entry => parseWorkflowIdentityEvidence(entry, 'model'));
  const terminalUsageBuckets = raw.terminalUsageBuckets.map(parseWorkflowTerminalUsageEvidence);
  const bucketSignature = (entry: WorkflowTerminalUsageEvidence) => JSON.stringify([entry.model, entry.inputTokens ?? null,
    entry.outputTokens ?? null, entry.cacheReadInputTokens ?? null, entry.cacheCreationInputTokens ?? null]);
  if (new Set(sessions.map(entry => entry.value.toLowerCase())).size !== sessions.length
    || new Set(models.map(entry => entry.value)).size !== models.length
    || new Set(terminalUsageBuckets.map(bucketSignature)).size !== terminalUsageBuckets.length) throw new Error(error);
  if (telemetry.provider === 'codex'
    ? models.length > 0 || terminalUsageBuckets.length > 0
      || sessions.some(entry => entry.initEvents !== undefined || entry.assistantEvents !== undefined || entry.terminalEvents !== undefined)
    : sessions.some(entry => entry.threadEvents !== undefined)) {
    throw new Error('workflow_telemetry_evidence_mismatch');
  }
  const evidence: WorkflowTelemetryEvidence = Object.freeze({ version: 1,
    diagnosticLogComplete: raw.diagnosticLogComplete as boolean, eventStreamComplete: raw.eventStreamComplete as boolean,
    identityEvidenceComplete: raw.identityEvidenceComplete as boolean, identityConsistent: raw.identityConsistent as boolean,
    accountingEvidenceComplete: raw.accountingEvidenceComplete as boolean,
    terminalEventCount: telemetryInteger(raw.terminalEventCount, 0, error),
    sessions: Object.freeze(sessions) as WorkflowIdentityEvidence[], models: Object.freeze(models) as WorkflowIdentityEvidence[],
    terminalUsageBuckets: Object.freeze(terminalUsageBuckets) as WorkflowTerminalUsageEvidence[] });
  const requiredCounters = telemetry.provider === 'codex'
    ? [telemetry.inputTokens, telemetry.outputTokens, telemetry.cacheReadTokens]
    : [telemetry.inputTokens, telemetry.outputTokens, telemetry.cacheReadTokens, telemetry.cacheWriteTokens];
  if (telemetry.status === 'measured' && !evidence.accountingEvidenceComplete) {
    throw new Error('workflow_telemetry_evidence_mismatch');
  }
  if (evidence.accountingEvidenceComplete) {
    if (!evidence.eventStreamComplete || evidence.terminalEventCount < 1 || telemetry.terminal !== 'success'
      || requiredCounters.some(count => count === undefined)
      || telemetry.provider === 'codex' && evidence.terminalEventCount !== 1
      || telemetry.provider !== 'codex' && evidence.terminalEventCount > 1
        && (!evidence.identityEvidenceComplete || !evidence.identityConsistent)
      || telemetry.provider === 'codex' && telemetry.scope !== 'turn'
      || telemetry.provider !== 'codex' && telemetry.scope !== 'all-models'
      || telemetry.provider === 'codex' && (telemetry.cacheReadTokens! > telemetry.inputTokens!
        || telemetry.cacheWriteTokens !== undefined && telemetry.cacheWriteTokens > telemetry.inputTokens!)) {
      throw new Error('workflow_telemetry_evidence_mismatch');
    }
    if (telemetry.provider !== 'codex') {
      const completeBuckets = terminalUsageBuckets.length > 0
        && terminalUsageBuckets.every(bucket => bucket.observations === evidence.terminalEventCount
        && bucket.inputTokens !== undefined && bucket.outputTokens !== undefined
        && bucket.cacheReadInputTokens !== undefined && bucket.cacheCreationInputTokens !== undefined);
      const countForModel = (model: string) => terminalUsageBuckets.filter(bucket => bucket.model === model).length;
      const bucketModels = new Set(terminalUsageBuckets.map(bucket => bucket.model));
      const modelCountsMatch = bucketModels.size === terminalUsageBuckets.length
        && models.every(model => model.terminalUsageBuckets === undefined
          ? countForModel(model.value) === 0
          : model.terminalUsageBuckets === evidence.terminalEventCount && countForModel(model.value) === 1)
        && terminalUsageBuckets.every(bucket => models.some(model => model.value === bucket.model
          && model.terminalUsageBuckets === evidence.terminalEventCount));
      const sum = (values: number[]): number | undefined => {
        const result = values.reduce((total, value) => total + value, 0);
        return Number.isSafeInteger(result) ? result : undefined;
      };
      const fresh = sum(terminalUsageBuckets.map(bucket => bucket.inputTokens!));
      const output = sum(terminalUsageBuckets.map(bucket => bucket.outputTokens!));
      const read = sum(terminalUsageBuckets.map(bucket => bucket.cacheReadInputTokens!));
      const write = sum(terminalUsageBuckets.map(bucket => bucket.cacheCreationInputTokens!));
      const input = fresh === undefined || read === undefined || write === undefined ? undefined : sum([fresh, read, write]);
      if (!completeBuckets || !modelCountsMatch || input !== telemetry.inputTokens || output !== telemetry.outputTokens
        || read !== telemetry.cacheReadTokens || write !== telemetry.cacheWriteTokens) {
        throw new Error('workflow_telemetry_evidence_mismatch');
      }
    }
  }
  const primaryModels = models.filter(entry => (entry.initEvents ?? 0) + (entry.assistantEvents ?? 0) > 0);
  const terminalSessionEvents = sessions.reduce((total, session) => total + (session.terminalEvents ?? 0), 0);
  if (evidence.identityEvidenceComplete && (!evidence.eventStreamComplete || evidence.terminalEventCount < 1
    || telemetry.provider === 'codex' && evidence.terminalEventCount !== 1
    || telemetry.provider === 'codex' && !sessions.some(entry => (entry.threadEvents ?? 0) > 0)
    || telemetry.provider !== 'codex' && (!sessions.some(entry => (entry.initEvents ?? 0) > 0)
      || terminalSessionEvents !== evidence.terminalEventCount || models.length === 0))) {
    throw new Error('workflow_telemetry_evidence_mismatch');
  }
  if (evidence.identityConsistent && (sessions.length > 1 || primaryModels.length > 1)
    || telemetry.sessionId !== undefined && (sessions.length !== 1
      || sessions[0]!.value.toLowerCase() !== telemetry.sessionId.toLowerCase())) {
    throw new Error('workflow_telemetry_evidence_mismatch');
  }
  return evidence;
}
function parseWorkflowTelemetry(value: unknown, expectedProvider?: WorkflowProviderRoute): WorkflowTelemetry {
  const error = 'workflow_invalid_telemetry';
  const raw = telemetryObject(value, ['provider', 'durationMs', 'status', 'scope', 'inputTokens', 'outputTokens',
    'cacheReadTokens', 'cacheWriteTokens', 'sessionId', 'terminal', 'diagnostics', 'evidence'], error);
  if (!['claude', 'glm', 'mimo', 'codex'].includes(String(raw.provider))) throw new Error(error);
  if (expectedProvider !== undefined && raw.provider !== expectedProvider) throw new Error('workflow_telemetry_route_mismatch');
  if (!['measured', 'partial', 'unknown'].includes(String(raw.status))
    || !['all-models', 'main-loop', 'turn', 'unknown'].includes(String(raw.scope))) throw new Error(error);
  const telemetry: WorkflowTelemetry = { provider: raw.provider as WorkflowTelemetry['provider'],
    durationMs: telemetryInteger(raw.durationMs, 0, error), status: raw.status as WorkflowTelemetry['status'],
    scope: raw.scope as WorkflowTelemetry['scope'] };
  for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const) {
    if (raw[key] !== undefined) telemetry[key] = telemetryInteger(raw[key], 0, error);
  }
  if (raw.sessionId !== undefined) {
    const id = telemetryText(raw.sessionId, 36, error);
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) throw new Error(error);
    telemetry.sessionId = id;
  }
  if (raw.terminal !== undefined) {
    if (raw.terminal !== 'success' && raw.terminal !== 'failure') throw new Error(error);
    telemetry.terminal = raw.terminal;
  }
  if (raw.diagnostics !== undefined) {
    if (!Array.isArray(raw.diagnostics) || raw.diagnostics.length > 100) throw new Error(error);
    const diagnostics = raw.diagnostics.map(value => telemetryText(value, 160, error));
    if (new Set(diagnostics).size !== diagnostics.length || diagnostics.some(value => !/^[a-z][a-z0-9_]*$/.test(value))) throw new Error(error);
    telemetry.diagnostics = Object.freeze(diagnostics) as string[];
  }
  if (raw.evidence !== undefined) telemetry.evidence = parseWorkflowTelemetryEvidence(raw.evidence, telemetry);
  return Object.freeze(telemetry);
}
function parseArtifactDescriptor(value: unknown, expectedKind?: string): ArtifactDescriptor {
  const raw = exactObject(value, ['kind', 'path', 'contentHash', 'createdAt', 'producer', 'sizeBytes', 'retention', 'expiresAt']);
  const kind = literal(raw.kind);
  if (expectedKind !== undefined && kind !== expectedKind) throw new Error('workflow_invalid_artifact');
  const path = boundedText(raw.path, 4000);
  if (/[\r\n]/.test(path) || raw.contentHash === undefined || raw.sizeBytes === undefined) throw new Error('workflow_invalid_artifact');
  const producerRaw = exactObject(raw.producer, ['system', 'component', 'worker']);
  if (producerRaw.system !== 'omc' && producerRaw.system !== 'omx') throw new Error('workflow_invalid_artifact');
  const producer = Object.freeze({ system: producerRaw.system, component: literal(producerRaw.component),
    ...(producerRaw.worker === undefined ? {} : { worker: literal(producerRaw.worker) }) });
  const retention = raw.retention;
  if (!['ephemeral', 'session', 'until-completion', 'persistent'].includes(String(retention))) throw new Error('workflow_invalid_artifact');
  return Object.freeze({ kind, path, contentHash: digest(raw.contentHash), createdAt: timestamp(raw.createdAt), producer,
    sizeBytes: integer(raw.sizeBytes, 0, Number.MAX_SAFE_INTEGER), retention: retention as ArtifactDescriptor['retention'],
    ...(raw.expiresAt === undefined ? {} : { expiresAt: timestamp(raw.expiresAt) }) });
}
function parseWorkflowProcessResultSnapshot(value: unknown): WorkflowProcessResultSnapshot {
  const raw = exactObject(value, ['passed', 'error', 'integrityDiagnostic', 'parentExitedSuccessfully', 'stdoutTruncated', 'settlement']);
  if (raw.integrityDiagnostic !== undefined && (typeof raw.integrityDiagnostic !== 'string'
    || raw.integrityDiagnostic.length > 220 || !/^workflow_[a-z_:]+$/.test(raw.integrityDiagnostic))) throw new Error('workflow_invalid_process_result');
  if (typeof raw.passed !== 'boolean' || typeof raw.parentExitedSuccessfully !== 'boolean'
    || typeof raw.stdoutTruncated !== 'boolean') throw new Error('workflow_invalid_process_result');
  const errors: NonNullable<WorkflowProcessResultSnapshot['error']>[] = [
    'launch_failed', 'timeout', 'interrupted', 'process_failed', 'throttled', 'protocol_failed', 'output_incomplete',
  ];
  if (raw.error !== undefined && !errors.includes(raw.error as NonNullable<WorkflowProcessResultSnapshot['error']>)
    || raw.passed === (raw.error !== undefined) || raw.passed && !raw.parentExitedSuccessfully) {
    throw new Error('workflow_invalid_process_result');
  }
  let settlement: WorkflowProcessSettlementSnapshot | undefined;
  if (raw.settlement !== undefined) {
    const saved = exactObject(raw.settlement, ['parentExitCode', 'parentExitSignal', 'outputComplete', 'termination', 'directChild', 'descendants']);
    if (saved.parentExitCode !== null && (!Number.isSafeInteger(saved.parentExitCode) || Number(saved.parentExitCode) < 0)
      || saved.parentExitSignal !== null && (typeof saved.parentExitSignal !== 'string' || !/^SIG[A-Z0-9]+$/.test(saved.parentExitSignal))
      || typeof saved.outputComplete !== 'boolean'
      || !['not-requested', 'attempted', 'failed'].includes(String(saved.termination))
      || !['not-started', 'exited', 'unconfirmed'].includes(String(saved.directChild))
      || !['not-started', 'unverified', 'cleaned'].includes(String(saved.descendants))) {
      throw new Error('workflow_invalid_process_result');
    }
    const parentExitedSuccessfully = saved.parentExitCode === 0 && saved.parentExitSignal === null && saved.directChild === 'exited';
    const notStarted = saved.directChild === 'not-started';
    if (raw.parentExitedSuccessfully !== parentExitedSuccessfully
      || raw.passed && saved.outputComplete === false
      || saved.descendants === 'cleaned' && (!parentExitedSuccessfully || saved.outputComplete === false)
      || (saved.descendants === 'not-started') !== notStarted
      || notStarted && (saved.parentExitCode !== null || saved.parentExitSignal !== null)) {
      throw new Error('workflow_invalid_process_result');
    }
    settlement = Object.freeze({ parentExitCode: saved.parentExitCode as number | null,
      parentExitSignal: saved.parentExitSignal as string | null, outputComplete: saved.outputComplete,
      termination: saved.termination as WorkflowProcessSettlementSnapshot['termination'],
      directChild: saved.directChild as WorkflowProcessSettlementSnapshot['directChild'],
      descendants: saved.descendants as WorkflowProcessSettlementSnapshot['descendants'] });
  }
  return Object.freeze({ passed: raw.passed, ...(raw.error === undefined ? {} : { error: raw.error as WorkflowProcessResultSnapshot['error'] }),
    ...(raw.integrityDiagnostic === undefined ? {} : { integrityDiagnostic: raw.integrityDiagnostic as string }),
    parentExitedSuccessfully: raw.parentExitedSuccessfully, stdoutTruncated: raw.stdoutTruncated,
    ...(settlement === undefined ? {} : { settlement }) });
}
function boundAttempt(value: unknown, role: 'implementer' | 'reviewer', ordinal: number): Record<string, unknown> {
  const raw = object(value);
  validateOrchestrationHost(raw.orchestrationHost);
  const binding = parseWorkflowBinding(raw.binding);
  const invocationId = boundedText(raw.invocationId, 36);
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(invocationId)) throw new Error('workflow_invalid_invocation_id');
  if (binding.role !== role || (raw.model !== undefined && raw.model !== binding.model)) throw new Error('workflow_invocation_binding_mismatch');
  if (!['completed', 'failed'].includes(String(raw.outcome)) || !Array.isArray(raw.artifacts)) throw new Error('workflow_invalid_invocation');
  const telemetry = parseWorkflowTelemetry(raw.telemetry, binding.providerRoute);
  const field = role === 'implementer' ? 'attempt' : 'pass';
  if (raw[field] !== ordinal) throw new Error('workflow_invocation_sequence_mismatch');
  if (role === 'implementer' && !['fresh', 'resume'].includes(String(raw.mode))) throw new Error('workflow_invalid_invocation_mode');
  const processResult = raw.processResult === undefined ? undefined : parseWorkflowProcessResultSnapshot(raw.processResult);
  const compatibility = role === 'reviewer' && raw.compatibility !== undefined
    ? parseWorkflowReviewCompatibilityBinding(raw.compatibility) : undefined;
  const parsed = { ...raw, startedAt: timestamp(raw.startedAt), binding, invocationId, telemetry,
    ...(processResult === undefined ? {} : { processResult }),
    ...(compatibility === undefined ? {} : { compatibility }) };
  // The outcome/telemetry may settle later; the reserved identity may not change.
  Object.defineProperties(parsed, { binding: { writable: false, configurable: false }, invocationId: { writable: false, configurable: false },
    telemetry: { writable: false, configurable: false },
    ...(processResult === undefined ? {} : { processResult: { writable: false, configurable: false } }),
    ...(compatibility === undefined ? {} : { compatibility: { writable: false, configurable: false } }),
    ...(raw.orchestrationHost === undefined ? {} : { orchestrationHost: { writable: false, configurable: false } }) });
  return parsed;
}
function validateOrchestrationHost(value: unknown): void {
  if (value !== undefined && value !== 'claude' && value !== 'codex') throw new Error('workflow_invalid_orchestration_host');
}
function parseWorkflowSetupAttempts(value: unknown): WorkflowSetupAttempt[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 1000) throw new Error('workflow_invalid_setup_history');
  return value.map((value, index) => {
    const raw = exactObject(value, ['sequence', 'startedAt', 'mode', 'outcome', 'error', 'detail', 'artifact']);
    const sequence = integer(raw.sequence, 1, 1000);
    if (sequence !== index + 1 || !['completed', 'failed'].includes(String(raw.outcome))
      || raw.mode !== undefined && raw.mode !== 'fresh' && raw.mode !== 'resume') throw new Error('workflow_invalid_setup_history');
    const details: WorkflowWorktreeSetupDetail[] = ['worktree_branch_mismatch', 'worktree_branch_in_use', 'worktree_path_mismatch', 'worktree_mismatch'];
    if (raw.outcome === 'failed') {
      if (raw.error !== 'workflow_worktree_setup_failed' || !raw.artifact || typeof raw.artifact !== 'object' || Array.isArray(raw.artifact)) {
        throw new Error('workflow_invalid_setup_history');
      }
      if (raw.detail !== undefined && !details.includes(raw.detail as WorkflowWorktreeSetupDetail)) throw new Error('workflow_invalid_setup_history');
    } else if (raw.error !== undefined || raw.detail !== undefined || raw.artifact !== undefined) throw new Error('workflow_invalid_setup_history');
    return Object.freeze({ sequence, startedAt: timestamp(raw.startedAt),
      ...(raw.mode === undefined ? {} : { mode: raw.mode as 'fresh' | 'resume' }), outcome: raw.outcome as WorkflowSetupAttempt['outcome'],
      ...(raw.error === undefined ? {} : { error: raw.error as 'workflow_worktree_setup_failed' }),
      ...(raw.detail === undefined ? {} : { detail: raw.detail as WorkflowWorktreeSetupDetail }),
      ...(raw.artifact === undefined ? {} : { artifact: parseArtifactDescriptor(raw.artifact, 'workflow-worktree-setup') }) });
  });
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
function leadIntegrationActor(value: unknown): WorkflowLeadIntegrationActor {
  const raw = exactObject(value, ['id', 'model']);
  const id = literal(raw.id, 200);
  const model = modelLiteral(raw.model);
  if ((id === 'unknown') !== (model === 'unknown')) throw new Error('workflow_invalid_lead_integration_actor');
  return Object.freeze({ id, model });
}
function literalPaths(value: unknown): string[] {
  const paths = texts(value).map(repositorySourceFilePath);
  if (!paths.length || new Set(paths).size !== paths.length) throw new Error('workflow_invalid_lead_integration_paths');
  return paths;
}
function frozenWorkflowCommand(value: unknown): WorkflowCommand {
  const parsed = parseWorkflowCommand(value);
  return Object.freeze({ command: parsed.command, args: Object.freeze([...parsed.args]) as string[] });
}
export function parseWorkflowLeadIntegrationIntent(value: unknown): WorkflowLeadIntegrationIntent {
  const raw = exactObject(value, ['expectedParent', 'expectedHead', 'actor', 'authorityRef', 'reason', 'paths', 'checks']);
  if (!Array.isArray(raw.checks) || !raw.checks.length || raw.checks.length > 30) throw new Error('workflow_lead_integration_checks_required');
  const checks = raw.checks.map(value => frozenWorkflowCommand(exactObject(value, ['command', 'args'])));
  const parsed: WorkflowLeadIntegrationIntent = { expectedParent: workflowSha(raw.expectedParent), expectedHead: workflowSha(raw.expectedHead),
    actor: leadIntegrationActor(raw.actor), authorityRef: boundedText(raw.authorityRef, 1000), reason: boundedText(raw.reason, 1000),
    paths: Object.freeze(literalPaths(raw.paths)), checks: Object.freeze(checks) };
  if (Buffer.byteLength(JSON.stringify(parsed)) > MAX_LEAD_INTEGRATION_BYTES) throw new Error('workflow_lead_integration_too_large');
  return Object.freeze(parsed);
}
export function parseWorkflowLeadIntegration(value: unknown): WorkflowLeadIntegration {
  const raw = exactObject(value, ['sequence', 'parent', 'head', 'changedFiles', 'orchestrationHost', 'actor', 'authorityRef', 'reason', 'checks', 'at']);
  validateOrchestrationHost(raw.orchestrationHost);
  if (raw.orchestrationHost === undefined) throw new Error('workflow_invalid_orchestration_host');
  if (!Array.isArray(raw.checks) || !raw.checks.length || raw.checks.length > 30) throw new Error('workflow_lead_integration_checks_required');
  const checks = raw.checks.map(value => {
    const check = exactObject(value, ['command', 'passed', 'artifacts']);
    if (check.passed !== true || !Array.isArray(check.artifacts) || check.artifacts.length > 100) throw new Error('workflow_invalid_lead_integration_check');
    return Object.freeze({ command: frozenWorkflowCommand(check.command), passed: true as const,
      artifacts: Object.freeze(check.artifacts.map(artifact => parseArtifactDescriptor(artifact))) });
  });
  const parsed: WorkflowLeadIntegration = { sequence: integer(raw.sequence, 1, MAX_LEAD_INTEGRATIONS), parent: workflowSha(raw.parent), head: workflowSha(raw.head),
    changedFiles: Object.freeze(literalPaths(raw.changedFiles)), orchestrationHost: raw.orchestrationHost as OrchestratorHost,
    actor: leadIntegrationActor(raw.actor), authorityRef: boundedText(raw.authorityRef, 1000), reason: boundedText(raw.reason, 1000),
    checks: Object.freeze(checks), at: timestamp(raw.at) };
  if (Buffer.byteLength(JSON.stringify(parsed)) > MAX_LEAD_INTEGRATION_BYTES) throw new Error('workflow_lead_integration_too_large');
  return Object.freeze(parsed);
}
function dispatchSupplementContent(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new Error('workflow_invalid_dispatch_supplement');
  }
  if (Buffer.byteLength(value, 'utf8') > MAX_DISPATCH_SUPPLEMENT_BYTES) {
    throw new Error('workflow_dispatch_supplement_too_large');
  }
  return value;
}
function dispatchSupplementFields(value: unknown): Omit<WorkflowDispatchSupplement,
  'sequence' | 'orchestrationHost' | 'at'> {
  const raw = exactObject(value, ['taskId', 'expectedInputHead', 'actor', 'authorityRef', 'reason', 'content', 'contentSha256']);
  const content = dispatchSupplementContent(raw.content);
  const contentSha256 = digest(raw.contentSha256);
  if (createHash('sha256').update(content, 'utf8').digest('hex') !== contentSha256) {
    throw new Error('workflow_dispatch_supplement_digest_mismatch');
  }
  return Object.freeze({ taskId: safeWorkflowId(raw.taskId), expectedInputHead: workflowSha(raw.expectedInputHead),
    actor: leadIntegrationActor(raw.actor), authorityRef: boundedText(raw.authorityRef, 1000),
    reason: boundedText(raw.reason, 1000), content, contentSha256 });
}
export function parseWorkflowDispatchSupplementIntent(value: unknown): WorkflowDispatchSupplementIntent {
  const parsed = dispatchSupplementFields(value);
  if (Buffer.byteLength(JSON.stringify(parsed), 'utf8') > MAX_DISPATCH_SUPPLEMENT_RECORD_BYTES) {
    throw new Error('workflow_dispatch_supplement_too_large');
  }
  return parsed;
}
export function parseWorkflowDispatchSupplement(value: unknown): WorkflowDispatchSupplement {
  const raw = exactObject(value, ['sequence', 'taskId', 'expectedInputHead', 'orchestrationHost', 'actor',
    'authorityRef', 'reason', 'content', 'contentSha256', 'at']);
  validateOrchestrationHost(raw.orchestrationHost);
  if (raw.orchestrationHost === undefined) throw new Error('workflow_invalid_orchestration_host');
  const fields = dispatchSupplementFields({ taskId: raw.taskId, expectedInputHead: raw.expectedInputHead,
    actor: raw.actor, authorityRef: raw.authorityRef, reason: raw.reason, content: raw.content,
    contentSha256: raw.contentSha256 });
  const parsed: WorkflowDispatchSupplement = { sequence: integer(raw.sequence, 1, MAX_DISPATCH_SUPPLEMENTS), ...fields,
    orchestrationHost: raw.orchestrationHost as OrchestratorHost, at: timestamp(raw.at) };
  if (Buffer.byteLength(JSON.stringify(parsed), 'utf8') > MAX_DISPATCH_SUPPLEMENT_RECORD_BYTES) {
    throw new Error('workflow_dispatch_supplement_too_large');
  }
  return Object.freeze(parsed);
}
export function parseWorkflowReviewBudgetExtensionIntent(value: unknown): WorkflowReviewBudgetExtensionIntent {
  const raw = exactObject(value, ['requestId', 'expectedHead', 'expectedCeiling', 'increment', 'actor', 'authorityRef', 'reason']);
  const expectedCeiling = integer(raw.expectedCeiling, 1, Number.MAX_SAFE_INTEGER);
  const increment = integer(raw.increment, 1, MAX_REVIEW_BUDGET_INCREMENT);
  integer(expectedCeiling + increment, 2, Number.MAX_SAFE_INTEGER);
  return Object.freeze({ requestId: literal(raw.requestId, 100), expectedHead: workflowSha(raw.expectedHead),
    expectedCeiling, increment, actor: leadIntegrationActor(raw.actor), authorityRef: boundedText(raw.authorityRef, 1000),
    reason: boundedText(raw.reason, 1000) });
}
export function parseWorkflowReviewBudgetExtension(value: unknown): WorkflowReviewBudgetExtension {
  const raw = exactObject(value, ['sequence', 'requestId', 'oldCeiling', 'newCeiling', 'head', 'orchestrationHost',
    'actor', 'authorityRef', 'reason', 'at']);
  validateOrchestrationHost(raw.orchestrationHost);
  if (raw.orchestrationHost === undefined) throw new Error('workflow_invalid_orchestration_host');
  const oldCeiling = integer(raw.oldCeiling, 1, Number.MAX_SAFE_INTEGER);
  const newCeiling = integer(raw.newCeiling, 2, Number.MAX_SAFE_INTEGER);
  if (newCeiling <= oldCeiling) throw new Error('workflow_invalid_review_budget_extension');
  if (newCeiling - oldCeiling > MAX_REVIEW_BUDGET_INCREMENT) throw new Error('workflow_invalid_review_budget_extension');
  return Object.freeze({ sequence: integer(raw.sequence, 1, Number.MAX_SAFE_INTEGER),
    requestId: literal(raw.requestId, 100), oldCeiling, newCeiling, head: workflowSha(raw.head),
    orchestrationHost: raw.orchestrationHost as OrchestratorHost, actor: leadIntegrationActor(raw.actor),
    authorityRef: boundedText(raw.authorityRef, 1000), reason: boundedText(raw.reason, 1000), at: timestamp(raw.at) });
}
export function workflowReviewCeiling(state: Pick<VersionedWorkflowState, 'options' | 'reviewBudgetExtensions'>): number {
  return state.reviewBudgetExtensions?.at(-1)?.newCeiling ?? state.options.maxReviewPasses;
}
function reviewBuildIdentity(value: unknown): WorkflowReviewBuildIdentity {
  const raw = exactObject(value, ['id', 'sha256']);
  return Object.freeze({ id: literal(raw.id, 120), sha256: digest(raw.sha256) });
}
/**
 * A transported adoption binds only the versioned per-response/per-buffer policy. The exact field
 * set is intentional: a descriptor carrying any total context/request/source/read ceiling is
 * refused here, so a saved or supplied total can never silently restrict the lossless delivery.
 */
function reviewTransportPolicy(value: unknown): WorkflowReviewTransportPolicy {
  const raw = exactObject(value, ['schemaVersion', 'responseBytes', 'bufferBytes']);
  const parsed = Object.freeze({ schemaVersion: integer(raw.schemaVersion, 1, 1_000_000),
    responseBytes: integer(raw.responseBytes, 1, 64 * 1024), bufferBytes: integer(raw.bufferBytes, 1, 8 * 1024 * 1024) });
  if (parsed.schemaVersion !== WORKFLOW_REVIEW_TRANSPORT_SCHEMA_VERSION
    || parsed.responseBytes !== WORKFLOW_REVIEW_READ_LIMIT_BYTES
    || parsed.bufferBytes !== WORKFLOW_REVIEW_BUFFER_LIMIT_BYTES) {
    throw new Error('workflow_review_compatibility_transport_unsupported');
  }
  return parsed;
}
/** Parse one immutable disk manifest descriptor. */
export function parseWorkflowReviewSourceManifestDescriptor(value: unknown): WorkflowReviewSourceManifestDescriptor {
  const raw = exactObject(value, ['schemaVersion', 'path', 'bytes', 'records', 'sha256']);
  if (raw.schemaVersion !== WORKFLOW_REVIEW_SOURCE_MANIFEST_SCHEMA_VERSION) {
    throw new Error('workflow_review_compatibility_source_unsupported');
  }
  // The manifest is a host file, not a repository member: it is an absolute path, and the byte and
  // record counts and the content digest are the only things that bind the (unbounded) path set.
  const path = boundedText(raw.path, 1000);
  if (!isAbsolute(path) || /[\r\n\0]/.test(path)) throw new Error('workflow_review_compatibility_invalid_paths');
  // A descriptor that binds no record at all, or a byte count that cannot be a length, is not an
  // authorized source: an empty or negative manifest is refused here rather than recorded.
  if (!Number.isSafeInteger(raw.bytes) || (raw.bytes as number) < 0
    || !Number.isSafeInteger(raw.records) || (raw.records as number) < 1) {
    throw new Error('workflow_review_compatibility_invalid_paths');
  }
  return Object.freeze({ schemaVersion: WORKFLOW_REVIEW_SOURCE_MANIFEST_SCHEMA_VERSION, path,
    bytes: raw.bytes as number, records: raw.records as number, sha256: digest(raw.sha256) });
}
/**
 * Bind one authorized source over the final-PR pair and its immutable disk manifest. The digest is
 * derived here, so an intent that omits it is bound by the controller and a recorded source that
 * carries one must match exactly. A pre-descriptor array-form record is still accepted, with its
 * original derivation, so old saved states load; nothing new is ever recorded in that form.
 */
function reviewAuthorizedSourceFields(value: unknown, recorded: boolean): WorkflowReviewAuthorizedSource {
  const raw = value as Record<string, unknown> | null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('workflow_review_compatibility_invalid_paths');
  if ('descriptor' in raw) {
    const fields = exactObject(value, recorded ? ['baseCommit', 'head', 'descriptor', 'digest'] : ['baseCommit', 'head', 'descriptor']);
    const binding = { baseCommit: workflowSha(fields.baseCommit), head: workflowSha(fields.head),
      descriptor: parseWorkflowReviewSourceManifestDescriptor(fields.descriptor) };
    const digestValue = createHash('sha256').update(JSON.stringify(binding)).digest('hex');
    if (recorded && fields.digest !== undefined && fields.digest !== digestValue) {
      throw new Error('workflow_review_compatibility_source_mismatch');
    }
    return Object.freeze({ ...binding, digest: digestValue });
  }
  // The legacy array form: a record saved before the disk descriptor. It parses, and its digest is
  // re-derived exactly as it was recorded, so the saved state loads without being rewritten — but
  // it carries no descriptor, so no new selection can name it and no review can be reserved for it.
  const fields = exactObject(value, recorded ? ['baseCommit', 'head', 'paths', 'digest'] : ['baseCommit', 'head', 'paths']);
  if (!Array.isArray(fields.paths) || !fields.paths.length) {
    throw new Error('workflow_review_compatibility_invalid_paths');
  }
  const paths = fields.paths.map(entry => repositorySourceFilePath(entry));
  if (new Set(paths).size !== paths.length) throw new Error('workflow_review_compatibility_invalid_paths');
  const legacy = { baseCommit: workflowSha(fields.baseCommit), head: workflowSha(fields.head),
    paths: Object.freeze([...paths].sort()) as string[] };
  const digestValue = createHash('sha256').update(JSON.stringify(legacy)).digest('hex');
  if (recorded && fields.digest !== undefined && fields.digest !== digestValue) {
    throw new Error('workflow_review_compatibility_source_mismatch');
  }
  return Object.freeze({ ...legacy, digest: digestValue });
}
/** The digest-free manifest shape a shared field parser re-reads: descriptor form, or legacy paths. */
function authorizedSourceShape(source: WorkflowReviewAuthorizedSource): Record<string, unknown> {
  return source.descriptor === undefined
    ? { baseCommit: source.baseCommit, head: source.head, paths: source.paths }
    : { baseCommit: source.baseCommit, head: source.head, descriptor: source.descriptor };
}
function reviewCompatibilityFields(value: unknown): WorkflowReviewCompatibilityAdoptionIntent {
  const raw = exactObject(value, ['requestId', 'source', 'controller', 'reader', 'transport', 'reviewerBindingId',
    'reviewerAuthFingerprint', 'actor', 'authorityRef', 'reason']);
  // The intent carries the authorized manifest descriptor without its derived digest; the controller
  // verifies the descriptor against the manifest on disk and binds the digest when it records it.
  const source = reviewAuthorizedSourceFields(raw.source, false);
  const parsed: WorkflowReviewCompatibilityAdoptionIntent = { requestId: literal(raw.requestId, 100),
    source: authorizedSourceShape(source) as WorkflowReviewCompatibilityAdoptionIntent['source'],
    controller: reviewBuildIdentity(raw.controller), reader: reviewBuildIdentity(raw.reader),
    transport: reviewTransportPolicy(raw.transport), reviewerBindingId: safeWorkflowId(raw.reviewerBindingId),
    reviewerAuthFingerprint: digest(raw.reviewerAuthFingerprint), actor: leadIntegrationActor(raw.actor),
    authorityRef: boundedText(raw.authorityRef, 1000), reason: boundedText(raw.reason, 1000) };
  // There is deliberately no aggregate intent ceiling: the authorized set lives in an immutable disk
  // manifest addressed by a bounded descriptor, and every individual field above is already bounded
  // on its own. A total here would cap the authorized file set the adoption may carry, which is
  // exactly the ceiling this delta removes.
  return Object.freeze(parsed);
}
export function parseWorkflowReviewCompatibilityAdoptionIntent(value: unknown): WorkflowReviewCompatibilityAdoptionIntent {
  return reviewCompatibilityFields(value);
}
export function parseWorkflowReviewCompatibilityAdoption(value: unknown): WorkflowReviewCompatibilityAdoption {
  const raw = exactObject(value, ['sequence', 'requestId', 'source', 'controller', 'reader', 'transport', 'reviewerBindingId',
    'reviewerAuthFingerprint', 'actor', 'authorityRef', 'reason', 'orchestrationHost', 'at']);
  validateOrchestrationHost(raw.orchestrationHost);
  if (raw.orchestrationHost === undefined) throw new Error('workflow_invalid_orchestration_host');
  const source = reviewAuthorizedSourceFields(raw.source, true);
  // The shared field parser reads the digest-free manifest shape; the verified source above — digest
  // included — is what the recorded adoption binds, so a tampered digest can never be re-derived.
  const fields = reviewCompatibilityFields({ requestId: raw.requestId,
    source: authorizedSourceShape(source), controller: raw.controller,
    reader: raw.reader, transport: raw.transport, reviewerBindingId: raw.reviewerBindingId,
    reviewerAuthFingerprint: raw.reviewerAuthFingerprint, actor: raw.actor, authorityRef: raw.authorityRef, reason: raw.reason });
  return Object.freeze({ sequence: integer(raw.sequence, 1, MAX_LEAD_INTEGRATIONS), ...fields, source,
    orchestrationHost: raw.orchestrationHost as OrchestratorHost, at: timestamp(raw.at) });
}
export function parseWorkflowReviewCompatibilityBinding(value: unknown): WorkflowReviewCompatibilityBinding {
  const raw = exactObject(value, ['adoptionSequence', 'bundleSha256', 'controllerSha256', 'readerSha256']);
  return Object.freeze({ adoptionSequence: integer(raw.adoptionSequence, 1, MAX_LEAD_INTEGRATIONS),
    bundleSha256: digest(raw.bundleSha256), controllerSha256: digest(raw.controllerSha256),
    readerSha256: digest(raw.readerSha256) });
}
/** New workflows budget completed reviews; omitted v1.5 states retain attempt-based accounting without migration. */
export function workflowReviewBudgetUsed(state: Pick<VersionedWorkflowState,
  'reviewBudgetBasis' | 'reviewPasses' | 'reviews'>): number {
  return state.reviewBudgetBasis === 'completed-reviews' ? state.reviews.length : state.reviewPasses;
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
    ...(raw.afterReviewPass === undefined ? {} : { afterReviewPass: integer(raw.afterReviewPass, 0, Number.MAX_SAFE_INTEGER) }) });
}
export function parseWorkflowBindingRefreshIntent(value: unknown): WorkflowBindingRefreshIntent {
  const raw = exactObject(value, ['role', 'sourceBindingId', 'newBindingId', 'model', 'effort', 'expectedHead', 'reason', 'authorityRef', 'taskId']);
  if (raw.role !== 'implementer' && raw.role !== 'reviewer') throw new Error('workflow_invalid_binding_refresh_intent');
  if (raw.taskId !== undefined && raw.role !== 'implementer') throw new Error('workflow_invalid_binding_refresh_intent');
  let effort: string | null | undefined;
  if (raw.effort === null) effort = null;
  else if (raw.effort !== undefined) effort = literal(raw.effort, 30);
  return Object.freeze({ role: raw.role, sourceBindingId: safeWorkflowId(raw.sourceBindingId),
    newBindingId: safeWorkflowId(raw.newBindingId), model: modelLiteral(raw.model),
    ...(raw.effort === undefined ? {} : { effort }), expectedHead: workflowSha(raw.expectedHead),
    reason: boundedText(raw.reason, 1000), authorityRef: boundedText(raw.authorityRef, 1000),
    ...(raw.taskId === undefined ? {} : { taskId: safeWorkflowId(raw.taskId) }) });
}
/** Pure contract loading only: caller still checks cwd, head, lock and persisted-file identity. */
export function parseWorkflowState(value: unknown): VersionedWorkflowState {
  const raw = object(value);
  if (!((raw.schemaVersion === 1 && (raw.profile === 'claude-glm-codex' || raw.profile === 'claude-mimo-codex')) || (raw.schemaVersion === 2 && raw.profile === 'role-substitution'))
    || !Array.isArray(raw.tasks) || !Array.isArray(raw.reviews)) throw new Error('workflow_invalid_state');
  const options = object(raw.options);
  if (raw.reviewBudgetBasis !== undefined && raw.reviewBudgetBasis !== 'completed-reviews') {
    throw new Error('workflow_invalid_review_budget_basis');
  }
  if (options.mode !== undefined && !['v1', 'balanced'].includes(String(options.mode))) throw new Error('workflow_invalid_mode');
  // Validate any present policy for both schemas; omission is never rewritten into a saved value.
  parseWorkflowProviderPolicy(options.providerPolicy);
  for (const task of raw.tasks) {
    const invocations = object(task).invocations;
    if (Array.isArray(invocations)) for (const invocation of invocations) validateOrchestrationHost(object(invocation).orchestrationHost);
  }
  if (Array.isArray(raw.reviewAttempts)) for (const attempt of raw.reviewAttempts) validateOrchestrationHost(object(attempt).orchestrationHost);
  if (raw.leadIntegrations !== undefined && (!Array.isArray(raw.leadIntegrations)
    || raw.leadIntegrations.length > MAX_LEAD_INTEGRATIONS)) throw new Error('workflow_invalid_lead_integrations');
  const leadIntegrations = (raw.leadIntegrations ?? []).map(parseWorkflowLeadIntegration);
  leadIntegrations.forEach((entry, index) => {
    if (entry.sequence !== index + 1) throw new Error('workflow_lead_integration_sequence_mismatch');
  });
  if (raw.dispatchSupplements !== undefined && (!Array.isArray(raw.dispatchSupplements)
    || raw.dispatchSupplements.length > MAX_DISPATCH_SUPPLEMENTS)) throw new Error('workflow_invalid_dispatch_supplements');
  const dispatchSupplements = (raw.dispatchSupplements ?? []).map(parseWorkflowDispatchSupplement);
  const supplementedTasks = new Set<string>();
  dispatchSupplements.forEach((entry, index) => {
    if (entry.sequence !== index + 1) throw new Error('workflow_dispatch_supplement_sequence_mismatch');
    if (supplementedTasks.has(entry.taskId)) throw new Error('workflow_duplicate_dispatch_supplement');
    supplementedTasks.add(entry.taskId);
  });
  const rejected = new Set(raw.tasks.filter(entry => object(entry).status === 'rejected').map(entry => safeWorkflowId(object(object(entry).task).id)));
  const plan = parseWorkflowPlan(raw.plan, rejected);
  if (dispatchSupplements.length && options.mode !== 'balanced') throw new Error('workflow_balanced_mode_required');
  for (const entry of dispatchSupplements) {
    const task = plan.tasks.find(task => task.id === entry.taskId);
    if (!task?.dependencies.length) throw new Error('workflow_invalid_dispatch_supplement_task');
  }
  let hasSetupHistory = false;
  let hasTelemetryEvidence = false;
  let hasProcessResultEvidence = false;
  if (raw.schemaVersion === 1) {
    hasSetupHistory = raw.tasks.some(entry => object(entry).setupAttempts !== undefined);
    const attemptHasEvidence = (value: unknown): boolean => {
      const telemetry = object(value).telemetry;
      return telemetry !== undefined && object(telemetry).evidence !== undefined;
    };
    hasTelemetryEvidence = raw.tasks.some(entry => {
      const invocations = object(entry).invocations;
      return Array.isArray(invocations) && invocations.some(attemptHasEvidence);
    }) || Array.isArray(raw.reviewAttempts) && raw.reviewAttempts.some(attemptHasEvidence);
    const attemptHasProcessResult = (value: unknown): boolean => object(value).processResult !== undefined;
    hasProcessResultEvidence = raw.tasks.some(entry => {
      const invocations = object(entry).invocations;
      return Array.isArray(invocations) && invocations.some(attemptHasProcessResult);
    }) || Array.isArray(raw.reviewAttempts) && raw.reviewAttempts.some(attemptHasProcessResult);
    // Preserve the accepted legacy shape byte-for-byte before requiring fields introduced by newer controllers.
    if (!hasSetupHistory && raw.leadIntegrations === undefined && raw.dispatchSupplements === undefined
      && raw.reviewBudgetExtensions === undefined && raw.taskRecoveries === undefined
      && raw.reviewCompatibilityAdoptions === undefined
      && raw.reviewBudgetBasis === undefined && !hasTelemetryEvidence && !hasProcessResultEvidence) return value as WorkflowState;
  }
  if (raw.reviewBudgetExtensions !== undefined && !Array.isArray(raw.reviewBudgetExtensions)) {
    throw new Error('workflow_invalid_review_budget_extensions');
  }
  const reviewBudgetExtensions = (raw.reviewBudgetExtensions ?? []).map(parseWorkflowReviewBudgetExtension);
  if (raw.reviewCompatibilityAdoptions !== undefined && (!Array.isArray(raw.reviewCompatibilityAdoptions)
    || raw.reviewCompatibilityAdoptions.length > MAX_LEAD_INTEGRATIONS)) {
    throw new Error('workflow_invalid_review_compatibility_adoptions');
  }
  const reviewCompatibilityAdoptions = (raw.reviewCompatibilityAdoptions ?? []).map(parseWorkflowReviewCompatibilityAdoption);
  if (raw.taskRecoveries !== undefined && (!Array.isArray(raw.taskRecoveries)
    || raw.taskRecoveries.length > MAX_WORKFLOW_TASK_RECOVERIES)) throw new Error('workflow_invalid_task_recoveries');
  const taskRecoveries = (raw.taskRecoveries ?? []).map(parseWorkflowTaskRecovery);
  const recoveryRequestIds = new Set<string>(); const recoveredTaskIds = new Set<string>();
  taskRecoveries.forEach((entry, index) => {
    if (entry.sequence !== index + 1 || recoveryRequestIds.has(entry.requestId)
      || recoveredTaskIds.has(entry.taskId) || entry.refsDigestBefore !== entry.refsDigestAfter) {
      throw new Error('workflow_task_recovery_chain_mismatch');
    }
    const contract = plan.tasks.find(task => task.id === entry.taskId);
    const saved = (raw.tasks as unknown[]).map(object).find(task => object(task.task).id === entry.taskId);
    const handoff = saved?.handoff === undefined ? undefined : object(saved.handoff);
    const invocations = saved?.invocations;
    const lastInvocation = Array.isArray(invocations) && invocations.length ? object(invocations.at(-1)) : undefined;
    const artifacts = handoff?.artifacts;
    const auditHashes = Array.isArray(artifacts) ? artifacts.map(object)
      .filter(artifact => artifact.kind === 'workflow-protected-ref-audit').map(artifact => artifact.contentHash) : [];
    if (!contract || !saved || !['completed', 'accepted', 'rejected'].includes(String(saved.status))
      || !Array.isArray(invocations) || saved.attempts !== invocations.length || handoff?.outcome !== 'completed'
      || handoff.commitSha !== entry.taskCommit || contract.baseCommit !== entry.baseCommit
      || lastInvocation?.error !== entry.oldError
      || contract.tests.length !== entry.checks.length
      || !contract.tests.every((check, checkIndex) => isDeepStrictEqual(check, entry.checks[checkIndex]?.command))
      || (entry.oldError === 'workflow_protected_refs_changed'
        && (entry.protectedRefAuditContentHash === undefined || !auditHashes.includes(entry.protectedRefAuditContentHash)))
      || (entry.oldError !== 'workflow_protected_refs_changed' && entry.protectedRefAuditContentHash !== undefined)) {
      throw new Error('workflow_task_recovery_evidence_mismatch');
    }
    recoveryRequestIds.add(entry.requestId); recoveredTaskIds.add(entry.taskId);
  });
  const budgetRequired = raw.schemaVersion === 2 || raw.reviewBudgetExtensions !== undefined;
  const initialReviewCeiling = budgetRequired || options.maxReviewPasses !== undefined
    ? integer(options.maxReviewPasses, 1, MAX_INITIAL_REVIEW_PASSES) : undefined;
  const requestIds = new Set<string>();
  let reviewCeiling = initialReviewCeiling;
  reviewBudgetExtensions.forEach((entry, index) => {
    if (entry.sequence !== index + 1 || entry.oldCeiling !== reviewCeiling || requestIds.has(entry.requestId)) {
      throw new Error('workflow_review_budget_extension_chain_mismatch');
    }
    requestIds.add(entry.requestId); reviewCeiling = entry.newCeiling;
  });
  const compatibilityRequestIds = new Set<string>();
  reviewCompatibilityAdoptions.forEach((entry, index) => {
    if (entry.sequence !== index + 1 || compatibilityRequestIds.has(entry.requestId)) {
      throw new Error('workflow_review_compatibility_chain_mismatch');
    }
    compatibilityRequestIds.add(entry.requestId);
  });
  integer(raw.reviewPasses, 0, Number.MAX_SAFE_INTEGER);
  if (raw.reviewBudgetBasis === 'completed-reviews') {
    const attempts = raw.reviewAttempts ?? [];
    if (!Array.isArray(attempts) || attempts.length !== raw.reviewPasses) {
      throw new Error('workflow_review_history_mismatch');
    }
    const completedPasses: number[] = [];
    attempts.forEach((attempt, index) => {
      const entry = object(attempt);
      if (entry.pass !== index + 1 || !['completed', 'failed'].includes(String(entry.outcome))) {
        throw new Error('workflow_review_history_mismatch');
      }
      if (entry.outcome === 'completed') completedPasses.push(index + 1);
    });
    const savedPasses = raw.reviews.map(review => object(review).pass);
    if (!isDeepStrictEqual(completedPasses, savedPasses)) throw new Error('workflow_review_history_mismatch');
  } else if (reviewCeiling !== undefined) {
    integer(raw.reviewPasses, 0, reviewCeiling);
  }
  // Preserve legacy shape and optional fields exactly; this is not a migration.
  if (raw.schemaVersion === 1) {
    // v1 states carry no role bindings, so an adoption could never be attributed to a reviewer there.
    if (reviewCompatibilityAdoptions.length) throw new Error('workflow_review_compatibility_binding_mismatch');
    if (dispatchSupplements.some(entry => entry.actor.id !== 'unknown')) {
      throw new Error('workflow_dispatch_supplement_actor_mismatch');
    }
    const implementerProvider: WorkflowProviderRoute = raw.profile === 'claude-mimo-codex' ? 'mimo' : 'glm';
    const parseLegacyAttempt = (value: unknown, expectedProvider: WorkflowProviderRoute): Record<string, unknown> => {
      const attempt = object(value);
      const processResult = attempt.processResult === undefined ? undefined : parseWorkflowProcessResultSnapshot(attempt.processResult);
      const parsed = { ...attempt, telemetry: parseWorkflowTelemetry(attempt.telemetry, expectedProvider),
        ...(processResult === undefined ? {} : { processResult }) };
      Object.defineProperty(parsed, 'telemetry', { writable: false, configurable: false });
      if (processResult !== undefined) Object.defineProperty(parsed, 'processResult', { writable: false, configurable: false });
      return parsed;
    };
    const hasInvocationEvidence = hasTelemetryEvidence || hasProcessResultEvidence;
    return { ...raw, tasks: raw.tasks.map(entry => {
      const task = object(entry); const setupAttempts = parseWorkflowSetupAttempts(task.setupAttempts);
      const invocations = hasInvocationEvidence && task.invocations !== undefined
        ? (() => { if (!Array.isArray(task.invocations)) throw new Error('workflow_invalid_invocation');
          return task.invocations.map(attempt => parseLegacyAttempt(attempt, implementerProvider)); })()
        : task.invocations;
      return { ...task, ...(task.setupAttempts === undefined ? {} : { setupAttempts: Object.freeze(setupAttempts) }),
        ...(task.invocations === undefined ? {} : { invocations }) };
    }), ...(hasInvocationEvidence && raw.reviewAttempts !== undefined
      ? { reviewAttempts: (() => { if (!Array.isArray(raw.reviewAttempts)) throw new Error('workflow_invalid_invocation');
        return raw.reviewAttempts.map(attempt => parseLegacyAttempt(attempt, 'codex')); })() } : {}),
    ...(raw.leadIntegrations === undefined ? {} : { leadIntegrations: Object.freeze(leadIntegrations) }),
    ...(raw.dispatchSupplements === undefined ? {} : { dispatchSupplements: Object.freeze(dispatchSupplements) }),
    ...(raw.reviewBudgetExtensions === undefined ? {} : { reviewBudgetExtensions: Object.freeze(reviewBudgetExtensions) }),
    ...(raw.reviewCompatibilityAdoptions === undefined ? {} : { reviewCompatibilityAdoptions: Object.freeze(reviewCompatibilityAdoptions) }),
    ...(raw.taskRecoveries === undefined ? {} : { taskRecoveries: Object.freeze(taskRecoveries) }) } as unknown as WorkflowState;
  }
  const maxAttempts = integer(options.maxAttempts, 1, 5);
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
    const setupAttempts = parseWorkflowSetupAttempts(task.setupAttempts);
    return { ...task, task: contract, ...(session ? { session } : {}),
      ...(task.setupAttempts === undefined ? {} : { setupAttempts: Object.freeze(setupAttempts) }),
      ...(task.invocations === undefined ? {} : { invocations: invocations.map((entry, index) => boundAttempt(entry, 'implementer', index + 1)) }) };
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
  const knownLeadActors = new Set<string>();
  const rememberLead = (binding: WorkflowRoleBinding) => {
    if (binding.role === 'lead') knownLeadActors.add(`${binding.id}\0${binding.model}`);
  };
  rememberLead(parsedBindings.lead);
  substitutions.forEach(entry => { rememberLead(entry.from); rememberLead(entry.to); });
  for (const entry of leadIntegrations) if (entry.actor.id !== 'unknown'
    && !knownLeadActors.has(`${entry.actor.id}\0${entry.actor.model}`)) throw new Error('workflow_lead_integration_actor_mismatch');
  for (const entry of dispatchSupplements) if (entry.actor.id !== 'unknown'
    && !knownLeadActors.has(`${entry.actor.id}\0${entry.actor.model}`)) throw new Error('workflow_dispatch_supplement_actor_mismatch');
  for (const entry of reviewBudgetExtensions) if (entry.actor.id !== 'unknown'
    && !knownLeadActors.has(`${entry.actor.id}\0${entry.actor.model}`)) throw new Error('workflow_review_budget_extension_actor_mismatch');
  for (const entry of taskRecoveries) if (entry.actor.id !== 'unknown'
    && !knownLeadActors.has(`${entry.actor.id}\0${entry.actor.model}`)) throw new Error('workflow_task_recovery_actor_mismatch');
  for (const entry of reviewCompatibilityAdoptions) {
    if (entry.actor.id !== 'unknown'
      && !knownLeadActors.has(`${entry.actor.id}\0${entry.actor.model}`)) throw new Error('workflow_review_compatibility_actor_mismatch');
    const reviewer = known.get(entry.reviewerBindingId);
    if (!reviewer || reviewer.role !== 'reviewer') throw new Error('workflow_review_compatibility_binding_mismatch');
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
    ...(raw.leadIntegrations === undefined ? {} : { leadIntegrations: Object.freeze(leadIntegrations) }),
    ...(raw.dispatchSupplements === undefined ? {} : { dispatchSupplements: Object.freeze(dispatchSupplements) }),
    ...(raw.reviewBudgetExtensions === undefined ? {} : { reviewBudgetExtensions: Object.freeze(reviewBudgetExtensions) }),
    ...(raw.reviewCompatibilityAdoptions === undefined ? {} : { reviewCompatibilityAdoptions: Object.freeze(reviewCompatibilityAdoptions) }),
    ...(raw.taskRecoveries === undefined ? {} : { taskRecoveries: Object.freeze(taskRecoveries) }),
    substitutions: Object.freeze(substitutions), bindings: Object.freeze(parsedBindings) } as unknown as WorkflowStateV2;
}
/** Compare saved contracts under the controller's lock; this does not reserve or execute work. */
export function validateWorkflowStateTransition(previous: unknown, next: unknown): void {
  const before = parseWorkflowState(previous); const after = parseWorkflowState(next);
  const persistedEqual = (left: unknown, right: unknown): boolean => isDeepStrictEqual(
    left === undefined ? undefined : JSON.parse(JSON.stringify(left)),
    right === undefined ? undefined : JSON.parse(JSON.stringify(right)));
  const preserveProcessResult = (entry: WorkflowInvocation | WorkflowReviewAttempt,
    replacement: WorkflowInvocation | WorkflowReviewAttempt, index: number,
    old: ReadonlyArray<WorkflowInvocation | WorkflowReviewAttempt>,
    current: ReadonlyArray<WorkflowInvocation | WorkflowReviewAttempt>): void => {
    if (entry.processResult !== undefined) {
      if (!persistedEqual(entry.processResult, replacement.processResult)) {
        throw new Error('workflow_process_result_history_rewritten');
      }
      return;
    }
    if (replacement.processResult !== undefined
      && (entry.error !== 'workflow_invocation_incomplete' || replacement.error !== 'workflow_invocation_incomplete'
        || index !== old.length - 1 || current.length !== old.length)) {
      throw new Error('workflow_process_result_history_rewritten');
    }
  };
  if (before.schemaVersion !== after.schemaVersion) throw new Error('workflow_implicit_migration_forbidden');
  // The initialization budget remains immutable in both schemas; extensions live only in their attributed ledger.
  if (before.options.maxReviewPasses !== after.options.maxReviewPasses
    || before.reviewBudgetBasis !== after.reviewBudgetBasis
    || after.reviewPasses < before.reviewPasses) throw new Error('workflow_budget_reset_forbidden');
  const oldReviewExtensions = before.reviewBudgetExtensions ?? [];
  const newReviewExtensions = after.reviewBudgetExtensions ?? [];
  if (newReviewExtensions.length < oldReviewExtensions.length || newReviewExtensions.length > oldReviewExtensions.length + 1
    || oldReviewExtensions.some((entry, index) => !isDeepStrictEqual(entry, newReviewExtensions[index]))) {
    throw new Error('workflow_review_budget_extension_history_rewritten');
  }
  if (newReviewExtensions.length === oldReviewExtensions.length + 1) {
    const appended = newReviewExtensions.at(-1)!;
    const oldCeiling = workflowReviewCeiling(before);
    const unavailable = workflowReviewBudgetUsed(before) !== oldCeiling || appended.oldCeiling !== oldCeiling
      || appended.head !== before.integrationHead
      || before.tasks.some(entry => entry.status === 'running'
        || entry.invocations?.some(invocation => invocation.error === 'workflow_invocation_incomplete'))
      || before.reviewAttempts?.some(attempt => attempt.error === 'workflow_invocation_incomplete');
    if (unavailable) throw new Error('workflow_review_budget_extension_origin_mismatch');
    if (appended.actor.id !== 'unknown' && before.schemaVersion === 2
      && (appended.actor.id !== before.bindings.lead.id || appended.actor.model !== before.bindings.lead.model)) {
      throw new Error('workflow_review_budget_extension_actor_mismatch');
    }
    const withoutExtension = (state: VersionedWorkflowState): Record<string, unknown> => {
      const copy = JSON.parse(JSON.stringify(state)) as Record<string, unknown>;
      delete copy.reviewBudgetExtensions;
      delete copy.updatedAt;
      return copy;
    };
    if (!isDeepStrictEqual(withoutExtension(before), withoutExtension(after))) {
      throw new Error('workflow_review_budget_extension_transition_invalid');
    }
  }
  // Administrative adoption is append-only and consumes no review; it may only be recorded
  // while the workflow is otherwise idle at its recorded head.
  const oldAdoptions = before.reviewCompatibilityAdoptions ?? [];
  const newAdoptions = after.reviewCompatibilityAdoptions ?? [];
  if (newAdoptions.length < oldAdoptions.length || newAdoptions.length > oldAdoptions.length + 1
    || oldAdoptions.some((entry, index) => !isDeepStrictEqual(entry, newAdoptions[index]))) {
    throw new Error('workflow_review_compatibility_history_rewritten');
  }
  if (newAdoptions.length === oldAdoptions.length + 1) {
    const appended = newAdoptions.at(-1)!;
    // The adopted final-PR head is the reviewed integration head. Its base is the final PR's own base,
    // which is deliberately not required to be the plan's narrower task base; that it is a real
    // ancestor of the head is proven against Git before the adoption is recorded, so this pure
    // validator keeps the origin check and the reward of a re-derived, unrewritten ledger entry.
    const unavailable = appended.source.head !== before.integrationHead
      || appended.source.baseCommit === appended.source.head
      || before.tasks.some(entry => entry.status === 'running'
        || entry.invocations?.some(invocation => invocation.error === 'workflow_invocation_incomplete'))
      || before.reviewAttempts?.some(attempt => attempt.error === 'workflow_invocation_incomplete');
    if (unavailable) throw new Error('workflow_review_compatibility_origin_mismatch');
    if (before.schemaVersion !== 2 || (appended.actor.id !== 'unknown'
      && (appended.actor.id !== before.bindings.lead.id || appended.actor.model !== before.bindings.lead.model))
      || appended.reviewerBindingId !== before.bindings.reviewer.id) {
      throw new Error('workflow_review_compatibility_actor_mismatch');
    }
    // The adoption must bind exactly the current versioned transport policy; a descriptor that
    // carries any total ceiling was already refused by the parser above.
    if (!isDeepStrictEqual(appended.transport, workflowReviewTransportPolicy())) {
      throw new Error('workflow_review_compatibility_transport_unsupported');
    }
    const withoutAdoption = (state: VersionedWorkflowState): Record<string, unknown> => {
      const copy = JSON.parse(JSON.stringify(state)) as Record<string, unknown>;
      delete copy.reviewCompatibilityAdoptions;
      delete copy.updatedAt;
      return copy;
    };
    if (!isDeepStrictEqual(withoutAdoption(before), withoutAdoption(after))) {
      throw new Error('workflow_review_compatibility_transition_invalid');
    }
  }
  const oldSupplements = before.dispatchSupplements ?? [];
  const newSupplements = after.dispatchSupplements ?? [];
  if (newSupplements.length < oldSupplements.length || newSupplements.length > oldSupplements.length + 1
    || oldSupplements.some((entry, index) => !isDeepStrictEqual(entry, newSupplements[index]))) {
    throw new Error('workflow_dispatch_supplement_history_rewritten');
  }
  if (newSupplements.length === oldSupplements.length + 1) {
    const appended = newSupplements.at(-1)!;
    const task = before.tasks.find(entry => entry.task.id === appended.taskId);
    const unavailable = !task || before.options.mode !== 'balanced' || appended.expectedInputHead !== before.integrationHead
      || task.status !== 'pending' || task.attempts !== 0 || !task.task.dependencies.length
      || task.task.dependencies.some(id => before.tasks.find(entry => entry.task.id === id)?.status !== 'accepted')
      || task.invocations !== undefined || task.setupAttempts !== undefined || task.session !== undefined
      || task.handoff !== undefined || task.claimToken !== undefined || task.worktree !== undefined || task.branch !== undefined
      || task.backoffUntil !== undefined || task.findingIds !== undefined || task.error !== undefined
      || before.tasks.some(entry => entry.status === 'running'
        || entry.invocations?.at(-1)?.error === 'workflow_invocation_incomplete');
    if (unavailable) throw new Error('workflow_dispatch_supplement_origin_mismatch');
    if (appended.actor.id !== 'unknown' && (before.schemaVersion !== 2
      || appended.actor.id !== before.bindings.lead.id || appended.actor.model !== before.bindings.lead.model)) {
      throw new Error('workflow_dispatch_supplement_actor_mismatch');
    }
    const withoutSupplement = (state: VersionedWorkflowState): Record<string, unknown> => {
      const copy = JSON.parse(JSON.stringify(state)) as Record<string, unknown>;
      delete copy.dispatchSupplements;
      delete copy.updatedAt;
      return copy;
    };
    if (!isDeepStrictEqual(withoutSupplement(before), withoutSupplement(after))) {
      throw new Error('workflow_dispatch_supplement_transition_invalid');
    }
  }
  const oldRecoveries = before.taskRecoveries ?? [];
  const newRecoveries = after.taskRecoveries ?? [];
  if (newRecoveries.length < oldRecoveries.length || newRecoveries.length > oldRecoveries.length + 1
    || oldRecoveries.some((entry, index) => !isDeepStrictEqual(entry, newRecoveries[index]))) {
    throw new Error('workflow_task_recovery_history_rewritten');
  }
  if (newRecoveries.length === oldRecoveries.length + 1) {
    const appended = newRecoveries.at(-1)!;
    const oldTask = before.tasks.find(entry => entry.task.id === appended.taskId);
    const newTask = after.tasks.find(entry => entry.task.id === appended.taskId);
    const unavailable = !oldTask || !newTask || oldTask.status !== 'failed' || oldTask.error !== appended.oldError
      || oldTask.handoff?.outcome !== 'completed' || oldTask.handoff.commitSha !== appended.taskCommit
      || oldTask.task.baseCommit !== appended.baseCommit || appended.head !== before.integrationHead
      || appended.refsDigestBefore !== appended.refsDigestAfter || newTask.status !== 'completed'
      || newTask.error !== undefined || newTask.updatedAt !== appended.at || after.stage !== 'integration'
      || before.tasks.some(entry => entry.status === 'running'
        || entry.invocations?.at(-1)?.error === 'workflow_invocation_incomplete');
    if (unavailable) throw new Error('workflow_task_recovery_origin_mismatch');
    if (appended.actor.id !== 'unknown' && (before.schemaVersion !== 2
      || appended.actor.id !== before.bindings.lead.id || appended.actor.model !== before.bindings.lead.model)) {
      throw new Error('workflow_task_recovery_actor_mismatch');
    }
    const normalized = (state: VersionedWorkflowState, restore?: WorkflowTaskState): Record<string, unknown> => {
      const copy = JSON.parse(JSON.stringify(state)) as Record<string, unknown>;
      delete copy.taskRecoveries; delete copy.updatedAt;
      if (restore) {
        const tasks = copy.tasks as Array<Record<string, unknown>>;
        const index = tasks.findIndex(entry => object(entry.task).id === restore.task.id);
        tasks[index] = JSON.parse(JSON.stringify(restore)) as Record<string, unknown>;
        copy.stage = before.stage;
      }
      return copy;
    };
    if (!isDeepStrictEqual(normalized(before), normalized(after, oldTask))) {
      throw new Error('workflow_task_recovery_transition_invalid');
    }
  }
  // Host provenance is immutable for both legacy and role-substitution workflows.
  const preserveHosts = (old: Array<WorkflowInvocation | WorkflowReviewAttempt>, current: Array<WorkflowInvocation | WorkflowReviewAttempt>) => {
    for (const [index, entry] of old.entries()) {
      if (!current[index] || entry.orchestrationHost !== current[index].orchestrationHost) throw new Error('workflow_orchestration_history_rewritten');
    }
  };
  for (const task of before.tasks) {
    const replacement = after.tasks.find(entry => entry.task.id === task.task.id);
    preserveHosts(task.invocations ?? [], replacement?.invocations ?? []);
    if (!replacement) continue;
    const oldSetup = task.setupAttempts ?? []; const newSetup = replacement.setupAttempts ?? [];
    if (newSetup.length < oldSetup.length || newSetup.length > oldSetup.length + 1
      || oldSetup.some((entry, index) => !isDeepStrictEqual(entry, newSetup[index]))) throw new Error('workflow_setup_history_rewritten');
    if (newSetup.length === oldSetup.length + 1) {
      const appended = newSetup.at(-1)!;
      const supplement = before.dispatchSupplements?.find(entry => entry.taskId === task.task.id);
      const expectedBase = oldSetup.length === 0 && task.attempts === 0 && task.task.dependencies.length
        ? supplement?.expectedInputHead ?? before.integrationHead : task.task.baseCommit;
      const expectedTask = { ...task.task, baseCommit: expectedBase };
      if (replacement.attempts !== task.attempts || !persistedEqual(replacement.invocations, task.invocations)
        || !persistedEqual(replacement.session, task.session) || !persistedEqual(replacement.handoff, task.handoff)
        || !isDeepStrictEqual(replacement.task, expectedTask)
        || replacement.claimToken !== undefined || appended.outcome === 'failed'
          && (replacement.status !== 'failed' || replacement.error !== 'workflow_worktree_setup_failed')
        || appended.outcome === 'completed' && (replacement.status !== 'pending' || replacement.error !== undefined)) {
        throw new Error('workflow_setup_history_origin_mismatch');
      }
    }
  }
  preserveHosts(before.reviewAttempts ?? [], after.reviewAttempts ?? []);
  const oldLeadIntegrations = before.leadIntegrations ?? [];
  const newLeadIntegrations = after.leadIntegrations ?? [];
  if (newLeadIntegrations.length < oldLeadIntegrations.length || newLeadIntegrations.length > oldLeadIntegrations.length + 1
    || oldLeadIntegrations.some((entry, index) => !isDeepStrictEqual(entry, newLeadIntegrations[index]))) {
    throw new Error('workflow_lead_integration_history_rewritten');
  }
  if (newLeadIntegrations.length === oldLeadIntegrations.length + 1) {
    const appended = newLeadIntegrations.at(-1)!;
    if (appended.parent !== before.integrationHead || appended.head !== after.integrationHead) throw new Error('workflow_lead_integration_origin_mismatch');
    if (after.verification !== undefined || after.stage !== 'integration') throw new Error('workflow_lead_integration_transition_invalid');
    if (!isDeepStrictEqual(before.plan, after.plan) || !isDeepStrictEqual(before.options, after.options)
      || !isDeepStrictEqual(before.tasks, after.tasks) || !isDeepStrictEqual(before.reviews, after.reviews)
      || !isDeepStrictEqual(before.reviewAttempts, after.reviewAttempts) || before.reviewPasses !== after.reviewPasses
      || before.createdAt !== after.createdAt || before.cwd !== after.cwd || before.profile !== after.profile) {
      throw new Error('workflow_lead_integration_history_rewritten');
    }
    if (before.schemaVersion === 2 && after.schemaVersion === 2
      && (!isDeepStrictEqual(before.bindings, after.bindings) || !isDeepStrictEqual(before.substitutions, after.substitutions))) {
      throw new Error('workflow_lead_integration_history_rewritten');
    }
  }
  if (before.schemaVersion === 1 && after.schemaVersion === 1) {
    const preserveLegacyAttempts = (old: Array<WorkflowInvocation | WorkflowReviewAttempt>,
      current: Array<WorkflowInvocation | WorkflowReviewAttempt>) => {
      for (const [index, entry] of old.entries()) {
        const replacement = current[index];
        if (!replacement || entry.startedAt !== replacement.startedAt || entry.model !== replacement.model
          || 'attempt' in entry && (!('attempt' in replacement) || entry.attempt !== replacement.attempt
            || entry.mode !== replacement.mode)
          || 'pass' in entry && (!('pass' in replacement) || entry.pass !== replacement.pass || entry.head !== replacement.head)) {
          throw new Error('workflow_invocation_identity_rewritten');
        }
        preserveProcessResult(entry, replacement, index, old, current);
        if (entry.telemetry.evidence !== undefined && !persistedEqual(entry.telemetry, replacement.telemetry)) {
          throw new Error('workflow_invocation_history_rewritten');
        }
        if (entry.error !== 'workflow_invocation_incomplete' && !persistedEqual(entry, replacement)) {
          throw new Error('workflow_invocation_history_rewritten');
        }
      }
    };
    for (const task of before.tasks) {
      const replacement = after.tasks.find(entry => entry.task.id === task.task.id);
      if (!replacement) throw new Error('workflow_invocation_history_rewritten');
      preserveLegacyAttempts(task.invocations ?? [], replacement.invocations ?? []);
    }
    preserveLegacyAttempts(before.reviewAttempts ?? [], after.reviewAttempts ?? []);
    return;
  }
  if (before.schemaVersion !== 2 || after.schemaVersion !== 2) return;
  if (before.cwd !== after.cwd || before.plan.name !== after.plan.name || before.plan.baseCommit !== after.plan.baseCommit
    || before.plan.integrationBranch !== after.plan.integrationBranch) throw new Error('workflow_state_identity_changed');
  if (before.options.maxAttempts !== after.options.maxAttempts || before.options.maxReviewPasses !== after.options.maxReviewPasses
    || before.reviewBudgetBasis !== after.reviewBudgetBasis
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
      preserveProcessResult(entry, replacement, index, old, current);
      if (entry.telemetry.evidence !== undefined && !persistedEqual(entry.telemetry, replacement.telemetry)) {
        throw new Error('workflow_invocation_history_rewritten');
      }
      if (entry.error !== 'workflow_invocation_incomplete' && !isDeepStrictEqual(entry, replacement)) throw new Error('workflow_invocation_history_rewritten');
    }
  };
  for (const task of before.tasks) {
    const replacement = after.tasks.find(entry => entry.task.id === task.task.id);
    if (!replacement || replacement.attempts < task.attempts) throw new Error('workflow_budget_reset_forbidden');
    preserveAttempts(task.invocations ?? [], replacement.invocations ?? []);
  }
  preserveAttempts(before.reviewAttempts ?? [], after.reviewAttempts ?? []);
  // A compatibility-bound review must reference an already-recorded adoption with matching build identities.
  for (const attempt of (after.reviewAttempts ?? []).slice((before.reviewAttempts ?? []).length)) {
    const binding = attempt.compatibility;
    if (binding === undefined) continue;
    const adoption = newAdoptions.find(entry => entry.sequence === binding.adoptionSequence);
    if (!adoption || binding.controllerSha256 !== adoption.controller.sha256
      || binding.readerSha256 !== adoption.reader.sha256) {
      throw new Error('workflow_review_compatibility_transition_invalid');
    }
  }
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
function repositoryPath(value: unknown, scope: boolean): string {
  const text = boundedText(value, 400).replaceAll('\\', '/');
  const path = scope && text.endsWith('/**') ? text.slice(0, -3) : text;
  if (path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..' || part === '.git' || part === '.omc')
    || /[:*?\r\n]/.test(path)) throw new Error('workflow_invalid_scope');
  if (process.platform === 'win32' && path.split('/').some(part => /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error('workflow_invalid_scope');
  return path;
}
export function scopePath(value: unknown): string {
  return repositoryPath(value, true);
}
function literalFilePath(value: unknown): string {
  return repositoryPath(value, false);
}
/** Lead adoption and review metadata may name this policy; worker scopes and handoffs may not. */
function repositorySourceFilePath(value: unknown): string {
  if (value === '.omc/routing.md') return value;
  const text = boundedText(value, 400);
  // Check before separator normalization, including case/trailing-dot aliases on Windows.
  if (text.split(/[\\/]/).some(part => /^\.omc[. ]*$/i.test(part))) throw new Error('workflow_invalid_scope');
  return literalFilePath(text);
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
    changedFiles: texts(raw.changedFiles).map(literalFilePath), tests, interfaceChanges: texts(raw.interfaceChanges, 30),
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
      ...(finding.file ? { file: repositorySourceFilePath(finding.file) } : {}), ...(finding.line ? { line: Number(finding.line) } : {}) };
  });
}
