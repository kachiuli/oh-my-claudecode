import { type CliProbeResult } from "../team/cli-detection.js";
import { type RecordedOrchestratorSession } from "./state.js";
export { readOrchestratorRepositoryConfig, resolveOrchestratorPaths, } from "./state.js";
export type OrchestratorHost = "claude" | "codex";
export interface OrchestratorRepositoryConfig {
    readonly schemaVersion: 1;
    readonly supportedHosts: readonly OrchestratorHost[];
    readonly defaultHost?: OrchestratorHost;
}
export interface ActiveOrchestratorSnapshot {
    readonly host: OrchestratorHost;
    readonly source: "legacy" | "local" | "default" | "sole-supported";
    readonly supportedHosts: readonly OrchestratorHost[];
    readonly selectionRevision: string;
    readonly adopted: boolean;
}
export interface OrchestratorSessionIdentity {
    readonly host: OrchestratorHost;
    readonly sessionId: string;
}
export interface OrchestratorLeaseCredentials extends OrchestratorSessionIdentity {
    readonly leaseId: string;
    readonly selectionRevision: string;
    readonly token: string;
}
export type OrchestratorCheckpointKind = "before-work" | "completed-stage" | "paused" | "checkpointed";
export interface OrchestratorCheckpoint {
    readonly kind: OrchestratorCheckpointKind;
    readonly workflowName?: string;
    readonly reference?: string;
}
export interface OrchestratorHandoffRecord {
    readonly id: string;
    readonly from: OrchestratorHost;
    readonly to: OrchestratorHost;
    readonly fromSelectionRevision: string;
    readonly toSelectionRevision: string;
    readonly sessionId: string;
    readonly checkpoint: OrchestratorCheckpoint;
    readonly at: string;
}
export interface OrchestratorHostAvailability extends CliProbeResult {
    readonly guidance: string;
}
export interface OrchestratorStatus {
    readonly active: ActiveOrchestratorSnapshot;
    readonly availability: Readonly<Record<OrchestratorHost, OrchestratorHostAvailability>>;
    readonly lease: Readonly<{
        host: OrchestratorHost;
        sessionId: string;
        selectionRevision: string;
        ownerPid: number;
        acquiredAt: string;
    }> | null;
}
export interface OrchestratorPaths {
    readonly repositoryRoot: string;
    readonly repositoryKey: string;
    readonly config: string;
    readonly state: string;
    readonly operationLock: string;
}
export type OrchestratorHostProbe = (host: OrchestratorHost) => boolean | CliProbeResult;
export interface OrchestratorProbeOptions {
    readonly probe?: OrchestratorHostProbe;
}
export interface OrchestratorHandoffOptions extends OrchestratorProbeOptions {
    readonly credentials: OrchestratorLeaseCredentials;
    readonly checkpoint: OrchestratorCheckpoint;
}
export declare const ORCHESTRATOR_ENV: Readonly<{
    readonly host: "OMC_ORCHESTRATOR_HOST";
    readonly selectionRevision: "OMC_ORCHESTRATOR_SELECTION_REVISION";
    readonly leaseId: "OMC_ORCHESTRATOR_LEASE_ID";
    readonly leaseToken: "OMC_ORCHESTRATOR_LEASE_TOKEN";
    readonly sessionId: "OMC_ORCHESTRATOR_SESSION_ID";
}>;
export declare function readActiveOrchestrator(cwd: string): ActiveOrchestratorSnapshot;
export declare function readOrchestratorLeaseCredentialsFromEnvironment(environment?: NodeJS.ProcessEnv | Record<string, string | undefined>): OrchestratorLeaseCredentials | null;
export declare function orchestratorLeaseEnvironment(credentials: OrchestratorLeaseCredentials): Readonly<Record<string, string>>;
export declare function withOrchestratorOperation<T>(cwd: string, action: (active: ActiveOrchestratorSnapshot) => T | Promise<T>): Promise<T>;
export declare function probeOrchestratorCli(host: OrchestratorHost, options?: OrchestratorProbeOptions): OrchestratorHostAvailability;
export declare function updateOrchestratorRepositoryConfig(cwd: string, transform: (current: OrchestratorRepositoryConfig | null) => OrchestratorRepositoryConfig | Promise<OrchestratorRepositoryConfig>): Promise<OrchestratorRepositoryConfig>;
export declare function configureOrchestratorRepository(cwd: string, input: OrchestratorRepositoryConfig): Promise<OrchestratorRepositoryConfig>;
export declare function selectOrchestrator(cwd: string, target: OrchestratorHost, options?: OrchestratorProbeOptions): Promise<ActiveOrchestratorSnapshot>;
export declare function readOrchestratorStatus(cwd: string, options?: OrchestratorProbeOptions): OrchestratorStatus;
export declare function assertActiveOrchestratorAvailable(cwd: string, options?: OrchestratorProbeOptions): ActiveOrchestratorSnapshot;
export declare function acquireOrchestratorLease(cwd: string, session: OrchestratorSessionIdentity): Promise<OrchestratorLeaseCredentials>;
/** Register a spawned native host process so explicit crash recovery cannot overtake it. */
export declare function registerOrchestratorLeaseProcess(cwd: string, credentials: OrchestratorLeaseCredentials, pid: number): Promise<void>;
/** Explicitly clear a crashed lead lease only after every known process is dead and state is quiescent. */
export declare function recoverOrchestratorLease(cwd: string, checkpointInput: OrchestratorCheckpoint): Promise<void>;
export declare function releaseOrchestratorLease(cwd: string, credentials: OrchestratorLeaseCredentials, checkpointInput: OrchestratorCheckpoint): Promise<void>;
export declare function handoffOrchestrator(cwd: string, target: OrchestratorHost, options: OrchestratorHandoffOptions): Promise<{
    active: ActiveOrchestratorSnapshot;
    handoff: OrchestratorHandoffRecord;
}>;
export declare function recordOrchestratorSession(cwd: string, host: OrchestratorHost, sessionIdInput: string): Promise<RecordedOrchestratorSession>;
export declare function assertOrchestratorSession(cwd: string, host: OrchestratorHost, sessionIdInput: string): RecordedOrchestratorSession;
//# sourceMappingURL=selection.d.ts.map