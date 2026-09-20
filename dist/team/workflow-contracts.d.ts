import type { ArtifactDescriptor } from '../shared/artifact-descriptor.js';
import type { WorkflowTelemetry } from './workflow-usage.js';
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
    readonly executableIdentity?: Readonly<{
        path: string;
        sha256: string;
        version: string;
    }>;
    readonly capabilities: readonly WorkflowCapability[];
    readonly capabilityEvidenceSha256: string;
}
export interface WorkflowCommand {
    command: string;
    args: string[];
}
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
    tests: Array<{
        command: string;
        args: string[];
        passed: boolean;
    }>;
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
    session?: {
        id: string;
        confirmed: boolean;
        fingerprint: string;
        worktree: string;
        branch: string;
    };
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
    options: Required<Omit<WorkflowOptions, 'glmModel' | 'codexModel' | 'mode' | 'providerPolicy'>> & Pick<WorkflowOptions, 'glmModel' | 'codexModel' | 'mode' | 'providerPolicy'>;
    stage: 'implementation' | 'integration' | 'verification' | 'review' | 'adjudication' | 'remediation' | 'complete';
    tasks: WorkflowTaskState[];
    verification?: {
        head: string;
        passed: boolean;
        checks: Array<{
            command: WorkflowCommand;
            passed: boolean;
            artifacts: ArtifactDescriptor[];
        }>;
    };
    reviewPasses: number;
    reviews: Array<{
        pass: number;
        head: string;
        findings: WorkflowFinding[];
        artifacts: ArtifactDescriptor[];
    }>;
    reviewAttempts?: WorkflowReviewAttempt[];
    createdAt: string;
    updatedAt: string;
}
/** Legacy controller type stays unchanged until the V2 controller is wired explicitly. */
export type WorkflowRouteTelemetry = Omit<WorkflowTelemetry, 'provider'> & {
    provider: WorkflowProviderRoute;
};
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
    session?: NonNullable<WorkflowTaskState['session']> & {
        readonly binding: WorkflowRoleBinding;
    };
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
/** The only present value is 'supervised'; omission stays omitted and is never rewritten or migrated. */
export declare function parseWorkflowProviderPolicy(value: unknown): WorkflowProviderPolicy | undefined;
export declare function parseWorkflowBinding(value: unknown): WorkflowRoleBinding;
/** Binding compatibility only; caller must also verify confirmed session/cwd/base/context and budget. */
export declare function assertWorkflowResumeBinding(saved: unknown, selected: unknown): void;
export declare function parseWorkflowSubstitution(value: unknown): WorkflowSubstitution;
/** Pure contract loading only: caller still checks cwd, head, lock and persisted-file identity. */
export declare function parseWorkflowState(value: unknown): VersionedWorkflowState;
/** Compare saved contracts under the controller's lock; this does not reserve or execute work. */
export declare function validateWorkflowStateTransition(previous: unknown, next: unknown): void;
export declare function boundedText(value: unknown, limit?: number): string;
export declare function safeWorkflowId(value: unknown): string;
export declare function workflowSha(value: unknown): string;
export declare function scopePath(value: unknown): string;
export declare function matchesScope(path: string, scopes: string[]): boolean;
export declare function parseWorkflowCommand(value: unknown): WorkflowCommand;
export declare function parseWorkflowTask(value: unknown): WorkflowTask;
export declare function validateWorkflowTasks(tasks: WorkflowTask[], rejectedTaskIds?: ReadonlySet<string>): void;
export declare function parseWorkflowPlan(value: unknown, rejectedTaskIds?: ReadonlySet<string>): WorkflowPlan;
export declare function parseWorkflowHandoff(value: unknown, taskId: string): WorkflowHandoff;
export declare function parseWorkflowFindings(value: unknown, pass: number): WorkflowFinding[];
//# sourceMappingURL=workflow-contracts.d.ts.map