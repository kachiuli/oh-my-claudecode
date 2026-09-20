import { type ArtifactDescriptor } from '../shared/artifact-descriptor.js';
import { type WorkflowTelemetry } from './workflow-usage.js';
export declare const WORKFLOW_PUBLICATION_ENV: Readonly<{
    readonly capabilityId: "OMC_WORKFLOW_PUBLICATION_ID";
    readonly capabilityToken: "OMC_WORKFLOW_PUBLICATION_TOKEN";
    readonly workflowRoot: "OMC_WORKFLOW_PUBLICATION_ROOT";
    readonly workflowName: "OMC_WORKFLOW_PUBLICATION_WORKFLOW";
    readonly stateRoot: "OMC_WORKFLOW_PUBLICATION_STATE_ROOT";
}>;
export type WorkflowPublicationEnvironment = Readonly<Record<(typeof WORKFLOW_PUBLICATION_ENV)[keyof typeof WORKFLOW_PUBLICATION_ENV], string>>;
/** Redact before any captured process data reaches an artifact or caller. */
export declare function redactWorkflowText(text: string, caseInsensitive?: boolean, privateEnvironment?: NodeJS.ProcessEnv): string;
/** Bounded, output-free account of how an explicitly unbounded run ended. */
export interface WorkflowProcessSettlement {
    parentExitCode: number | null;
    parentExitSignal: string | null;
    outputComplete: boolean;
    termination: 'not-requested' | 'attempted' | 'failed';
    directChild: 'not-started' | 'exited' | 'unconfirmed';
    descendants: 'not-started' | 'unverified';
}
export interface WorkflowProcessResult {
    passed: boolean;
    error?: 'launch_failed' | 'timeout' | 'interrupted' | 'process_failed' | 'throttled' | 'protocol_failed' | 'output_incomplete';
    artifacts: ArtifactDescriptor[];
    /** Present only for an explicitly unbounded (timeoutMs: null) run. */
    settlement?: WorkflowProcessSettlement;
    telemetry?: WorkflowTelemetry;
}
/** One-shot execution only; no shell, transcript handoff or env serialization. */
export declare function runWorkflowProcess(input: {
    command: string;
    args: string[];
    cwd: string;
    stdin?: string;
    artifactPrefix: string;
    /** Elapsed lifetime bound in milliseconds, or null for an explicitly unbounded run. */
    timeoutMs: number | null;
    provider?: WorkflowTelemetry['provider'];
    worker?: string;
    collectUsage?: boolean;
    environment?: NodeJS.ProcessEnv;
    /** One-shot worker publication authority. Only these exact keys reach the provider. */
    publicationEnvironment?: WorkflowPublicationEnvironment;
    redactionEnvironment?: NodeJS.ProcessEnv;
    /** Operation decoder receives raw bounded-protocol chunks only inside the controller. */
    onStdout?: (chunk: Buffer) => void;
}): Promise<WorkflowProcessResult>;
//# sourceMappingURL=workflow-process.d.ts.map