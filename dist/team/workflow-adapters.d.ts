import { type WorkflowProviderRoute, type WorkflowRoleBinding, type WorkflowReviewProvenance } from './workflow-contracts.js';
export interface WorkflowAuthProfile {
    ref: string;
    providerRoute: WorkflowProviderRoute;
    environment: NodeJS.ProcessEnv;
    /** Explicit private files used by this route; contents never enter a saved state or receipt. */
    files: readonly string[];
    /** Additional private values known only to the trusted runner, never sent to a child implicitly. */
    redactionValues?: readonly string[];
}
export interface WorkflowRuntime {
    resolveBinding(binding: WorkflowRoleBinding): {
        authProfile: WorkflowAuthProfile;
        capabilityEvidencePath: string;
    };
    /** Synthetic evidence is permitted only by an explicit test/compatibility runner. */
    allowSyntheticCapabilities?: boolean;
    reviewAuthorship?: {
        path: string;
        sha256: string;
    };
}
export interface PreparedWorkflowBinding {
    binding: WorkflowRoleBinding;
    command: string;
    environment: NodeJS.ProcessEnv;
    redactionEnvironment: NodeJS.ProcessEnv;
    actorId?: string;
    validation: 'synthetic' | 'authenticated';
}
export declare function fingerprintWorkflowAuthProfile(profile: WorkflowAuthProfile): string;
export declare function prepareWorkflowBinding(bindingValue: WorkflowRoleBinding, runtime?: WorkflowRuntime): PreparedWorkflowBinding;
export declare function workflowWorkerArguments(prepared: PreparedWorkflowBinding, session?: {
    id: string;
    resume: boolean;
}): string[];
export declare function workflowReviewerArguments(prepared: PreparedWorkflowBinding, schemaFile: string, resultFile: string, schema: unknown): string[];
export declare function workflowReviewProvenance(prepared: PreparedWorkflowBinding, head: string, runtime: WorkflowRuntime): WorkflowReviewProvenance;
/** Decode only a bounded Claude terminal envelope; transcripts are not a structured result. */
export declare function createClaudeWorkflowResultDecoder(): {
    write(chunk: Buffer): void;
    finish(): unknown;
};
//# sourceMappingURL=workflow-adapters.d.ts.map