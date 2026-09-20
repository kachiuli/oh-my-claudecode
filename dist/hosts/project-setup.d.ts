import { type OrchestratorHost } from "../orchestration/selection.js";
import { type CliProbeResult } from "../team/cli-detection.js";
export interface SetupProjectHostsOptions {
    readonly packageRoot: string;
    readonly dryRun?: boolean;
}
export interface SetupProjectHostsResult {
    readonly repositoryRoot: string;
    readonly hosts: readonly OrchestratorHost[];
    readonly changedFiles: readonly string[];
    readonly unchangedFiles: readonly string[];
    readonly backupDirectory?: string;
    readonly dryRun: boolean;
}
export interface UninstallProjectHostResult {
    readonly repositoryRoot: string;
    readonly host: OrchestratorHost;
    readonly removedFiles: readonly string[];
    readonly preservedFiles: readonly string[];
    readonly remainingHosts: readonly OrchestratorHost[];
}
export interface HostAssetDoctorEntry {
    readonly installed: boolean;
    readonly healthy: boolean;
    readonly cli: CliProbeResult;
    readonly lifecycle: "plugin-hooks" | "native-hooks" | "cli-gate-fallback" | "not-installed";
    readonly nativeHooksSupported: boolean;
    readonly issues: readonly string[];
}
export interface ProjectHostsDoctorResult {
    readonly repositoryRoot: string;
    readonly healthy: boolean;
    readonly hosts: Readonly<Record<OrchestratorHost, HostAssetDoctorEntry>>;
    readonly issues: readonly string[];
    readonly lifecycleNotes: readonly string[];
}
/** Install or refresh repository-scoped native host assets as one gated operation. */
export declare function setupProjectHosts(cwd: string, hostsInput: readonly OrchestratorHost[], options: SetupProjectHostsOptions): Promise<SetupProjectHostsResult>;
/** Remove only verified owned assets; user-modified assets are reported and retained. */
export declare function uninstallProjectHost(cwd: string, host: OrchestratorHost): Promise<UninstallProjectHostResult>;
/** Inspect project assets without modifying repository or global configuration. */
export declare function doctorProjectHosts(cwd: string): Promise<ProjectHostsDoctorResult>;
//# sourceMappingURL=project-setup.d.ts.map