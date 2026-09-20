import { type WorkflowRuntime } from './workflow-adapters.js';
import { type WorkflowState as LegacyWorkflowState, type VersionedWorkflowState as WorkflowState, type WorkflowStateV2, type WorkflowRole, type WorkflowOptions, type WorkflowFinding } from './workflow-contracts.js';
export type { WorkflowState, WorkflowOptions, WorkflowPlan, WorkflowTask, WorkflowHandoff, WorkflowFinding } from './workflow-contracts.js';
export declare function readWorkflow(cwd: string, name: string): WorkflowState;
export declare function initWorkflow(cwd: string, rawPlan: unknown, options?: WorkflowOptions): Promise<LegacyWorkflowState>;
export declare function initWorkflowV2(cwd: string, rawPlan: unknown, bindings: Record<WorkflowRole, unknown>, options?: WorkflowOptions): Promise<WorkflowStateV2>;
export declare function substituteWorkflowBinding(cwd: string, name: string, input: {
    role: WorkflowRole;
    binding: unknown;
    expectedHead: string;
    reason: string;
    authorityRef: string;
    taskId?: string;
}): Promise<WorkflowState>;
export declare function runWorkflow(cwd: string, name: string, runtime?: WorkflowRuntime): Promise<WorkflowState>;
/** Explicit continuation of a verified conversation in the same pristine task worktree. */
export declare function resumeWorkflowTask(cwd: string, name: string, taskId: string, expectedHead: string, reason: string, runtime?: WorkflowRuntime): Promise<WorkflowState>;
export declare function acceptWorkflowTask(cwd: string, name: string, taskId: string): Promise<WorkflowState>;
export declare function rejectWorkflowTask(cwd: string, name: string, taskId: string, reason: string): Promise<WorkflowState>;
export declare function verifyWorkflow(cwd: string, name: string): Promise<WorkflowState>;
/** Review locations are metadata; retain raw artifacts and validate the relative copy with the normal scope guard. */
export declare function parseWorkflowReviewFindings(value: unknown, pass: number, cwd: string): WorkflowFinding[];
export declare function reviewWorkflow(cwd: string, name: string, runtime?: WorkflowRuntime): Promise<WorkflowState>;
export declare function adjudicateWorkflow(cwd: string, name: string, decisions: Array<{
    findingId: string;
    disposition: 'fix' | 'dismiss';
    reason: string;
}>): Promise<WorkflowState>;
export declare function addWorkflowFix(cwd: string, name: string, rawTask: unknown, findingIds: string[]): Promise<WorkflowState>;
export declare function finishWorkflow(cwd: string, name: string): Promise<WorkflowState>;
export declare function workflowStatus(cwd: string, name: string): Record<string, unknown>;
/** Explicit completed-workflow cleanup; rejected/failed and changed worktrees remain inspectable. */
export declare function cleanupWorkflow(cwd: string, name: string): Promise<{
    removed: string[];
    preserved: Array<{
        taskId: string;
        reason: string;
    }>;
}>;
//# sourceMappingURL=workflow.d.ts.map