import type { VersionedWorkflowState, WorkflowTaskState } from './workflow-contracts.js';
type WorkflowState = Pick<VersionedWorkflowState, 'plan' | 'options' | 'tasks' | 'profile'>;
export declare function workflowPromptFingerprint(prompt: string): string;
export declare function buildWorkflowPrompt(state: WorkflowState, entry: WorkflowTaskState, resultFile: string): string;
export declare function workflowContextFingerprint(state: WorkflowState): string;
export declare function workflowSessionFingerprint(state: WorkflowState, entry: WorkflowTaskState, command: string, worktree: string): string;
export {};
//# sourceMappingURL=workflow-prompt.d.ts.map