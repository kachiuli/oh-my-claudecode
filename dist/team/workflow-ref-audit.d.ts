import type { ArtifactDescriptor } from "../shared/artifact-descriptor.js";
export type WorkflowRefPhase = "provider-start" | "provider-complete" | "controller-replay" | "post-run";
export interface WorkflowWorkerRefEvidence {
    worker: string;
    commitSha?: string;
}
export interface WorkflowRefAuditResult {
    outcome: "unchanged" | "allowed-external-checkpoint" | "protected-refs-changed";
    artifact?: ArtifactDescriptor;
}
/** Phase-aware, bounded protected-ref audit. Exact ref evidence stays in a local artifact. */
export declare class WorkflowRefAudit {
    private readonly cwd;
    private readonly workflowName;
    private readonly baseline;
    private previous;
    private readonly changes;
    private overflow;
    private activeProviders;
    private completedProviders;
    private readonly providerWorkers;
    constructor(cwd: string, workflowName: string);
    providerStarted(worker: string): void;
    providerCompleted(worker: string): void;
    controllerReplayCompleted(): void;
    private observe;
    private objectTree;
    private relatedToWorker;
    private allowsExternalCheckpoint;
    finalize(artifactPath: () => string, workers: readonly WorkflowWorkerRefEvidence[]): WorkflowRefAuditResult;
}
//# sourceMappingURL=workflow-ref-audit.d.ts.map