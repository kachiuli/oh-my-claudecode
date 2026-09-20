import { type VersionedWorkflowState } from './workflow-contracts.js';
/** Report known observations and their coverage; absent measurements never become zero cost. */
export declare function workflowUsage(input: VersionedWorkflowState): {
    quality: {
        tasks: number;
        accepted: number;
        failed: number;
        rejected: number;
        retries: number;
        resumedInvocations: number;
        verificationPassed: boolean | null;
        verificationCurrent: boolean | null;
        reviewPasses: number;
        failedReviewAttempts: number;
        unresolvedFindings: number;
        complete: boolean;
    };
    schemaVersion?: 2 | undefined;
    profile?: "role-substitution" | undefined;
    bindings?: {
        invocations: number;
        measured: number;
        partial: number;
        unknown: number;
        knownTokens: {
            [k: string]: {
                overflow?: boolean | undefined;
                tokens: number | null;
                reportedInvocations: number;
                totalInvocations: number;
            };
        };
        effort?: string | undefined;
        bindingId: string;
        role: import("./workflow-contracts.js").WorkflowRole;
        provider: import("./workflow-contracts.js").WorkflowProviderRoute;
        model: string;
    }[] | undefined;
    reviewAttemptRelations?: {
        [k: string]: number;
    } | undefined;
    name: string;
    mode: "balanced" | "v1";
    accounting: string;
    providers: {
        invocations: number;
        measured: number;
        partial: number;
        unknown: number;
        knownTokens: {
            [k: string]: {
                overflow?: boolean | undefined;
                tokens: number | null;
                reportedInvocations: number;
                totalInvocations: number;
            };
        };
        provider: "claude" | "codex" | "glm";
    }[];
};
//# sourceMappingURL=workflow-report.d.ts.map