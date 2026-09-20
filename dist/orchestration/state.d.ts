import type { ActiveOrchestratorSnapshot, OrchestratorCheckpoint, OrchestratorHandoffRecord, OrchestratorHost, OrchestratorPaths, OrchestratorRepositoryConfig, OrchestratorSessionIdentity } from "./selection.js";
export interface LocalSelection {
    readonly host: OrchestratorHost;
    readonly revision: string;
    readonly selectedAt: string;
}
export interface PersistedLease extends OrchestratorSessionIdentity {
    readonly leaseId: string;
    readonly selectionRevision: string;
    readonly tokenHash: string;
    readonly ownerPid: number;
    readonly relatedPids: readonly number[];
    readonly acquiredAt: string;
}
export interface OrchestratorCheckpointRecord extends OrchestratorSessionIdentity {
    readonly selectionRevision: string;
    readonly checkpoint: OrchestratorCheckpoint;
    readonly at: string;
}
export interface OrchestratorRuntimeState {
    readonly schemaVersion: 1;
    readonly selection?: LocalSelection;
    readonly lease?: PersistedLease;
    readonly lastCheckpoint?: OrchestratorCheckpointRecord;
    readonly handoffs?: readonly OrchestratorHandoffRecord[];
}
export interface RecordedOrchestratorSession extends OrchestratorSessionIdentity {
    readonly schemaVersion: 1;
    readonly selectionRevision: string;
    readonly recordedAt: string;
}
export declare function isHost(value: unknown): value is OrchestratorHost;
export declare function exactObject(value: unknown, keys: readonly string[], error: string): Record<string, unknown>;
export declare function boundedText(value: unknown, max: number, error: string): string;
export declare function parseTimestamp(value: unknown, error: string): string;
export declare function parseRevision(value: unknown, error: string): string;
export declare function parseUuid(value: unknown, error: string): string;
export declare function parseSessionId(value: unknown): string;
export declare function parseCheckpoint(value: unknown): OrchestratorCheckpoint;
export declare function readBoundedJson(filePath: string, maxBytes: number, error: string): unknown;
export declare function repositoryRoot(cwd: string): string;
export declare function resolveOrchestratorPaths(cwd: string): OrchestratorPaths;
export declare function parseRepositoryConfig(value: unknown): OrchestratorRepositoryConfig;
export declare function readOrchestratorRepositoryConfig(cwd: string): OrchestratorRepositoryConfig | null;
export declare function readRuntimeState(cwd: string): OrchestratorRuntimeState;
export declare function assertRuntimeStateWritable(state: OrchestratorRuntimeState): void;
export declare function assertNoCompetingOmx(paths: OrchestratorPaths): void;
export declare function activeFrom(config: OrchestratorRepositoryConfig | null, state: OrchestratorRuntimeState): ActiveOrchestratorSnapshot;
//# sourceMappingURL=state.d.ts.map