import { type WorkflowHandoff } from "./workflow-contracts.js";
import { type WorkflowPublicationEnvironment } from "./workflow-process.js";
export interface WorkflowPublicationContract {
    canonicalTask: Readonly<{
        source: "dispatch.task";
        taskId: string;
    }>;
    helperResult: Readonly<{
        purpose: "optional-local-validation";
        publishVerifiedBytesUnchanged: true;
    }>;
    designatedResult: Readonly<{
        path: string;
        authorization: "create-this-file-only";
        overwrite: false;
        stdoutIsHandoff: false;
    }>;
    publishCommand: string;
    finalization: readonly string[];
}
export interface WorkflowJsonArtifactRead {
    value: unknown;
    artifactPath: string;
}
export interface WorkflowHandoffArtifactRead extends WorkflowJsonArtifactRead {
    value: WorkflowHandoff;
}
export interface WorkflowPublicationIssue {
    workflowRoot: string;
    workflowName: string;
    taskId: string;
    worker: string;
    attempt: number;
    worktree: string;
    resultFile: string;
}
export interface IssuedWorkflowPublication {
    environment: WorkflowPublicationEnvironment;
    revoke(): void;
}
export interface WorkflowPublicationContext {
    cwd: string;
    environment?: NodeJS.ProcessEnv | Record<string, string | undefined>;
}
/** Worker-facing publication contract. The command is portable across supported OMC installations. */
export declare function workflowPublicationContract(taskId: string, resultFile: string): WorkflowPublicationContract;
/** Issue one exact task/attempt publication capability; only its hash enters controller state. */
export declare function issueWorkflowPublication(input: WorkflowPublicationIssue): IssuedWorkflowPublication;
/**
 * Publish a helper-verified handoff without changing its bytes. This is the only worker-authorized
 * write inside controller state, and exclusive creation preserves any pre-existing evidence.
 */
export declare function publishWorkflowResultArtifact(sourceFile: string, resultFile: string, taskId: string, context: WorkflowPublicationContext): {
    sizeBytes: number;
    sha256: string;
};
/** Read the exact designated artifact. Valid safe bytes survive normal controller validation unchanged. */
export declare function readWorkflowResultArtifact(resultFile: string, expectedParent: string, taskId: string, environment?: NodeJS.ProcessEnv): WorkflowHandoffArtifactRead;
/** Generic bounded result reader used by the existing reviewer transports. */
export declare function readWorkflowJsonArtifact(resultFile: string, expectedParent: string, environment?: NodeJS.ProcessEnv): WorkflowJsonArtifactRead;
/** Native Claude reviewer output is controller-published and remains distinct from worker publication. */
export declare function publishNativeClaudeResult(resultFile: string, value: unknown, environment?: NodeJS.ProcessEnv): void;
//# sourceMappingURL=workflow-publication.d.ts.map