import { type OrchestratorHost, type OrchestratorHostProbe } from "../orchestration/selection.js";
export interface ProjectLaunchOptions {
    cwd?: string;
    probe?: OrchestratorHostProbe;
    run?: (command: string, args: string[], options: NativeHostRunOptions) => Promise<number>;
}
interface NativeHostRunOptions {
    cwd: string;
    env: NodeJS.ProcessEnv;
    registerProcess: (pid: number) => Promise<void>;
}
/** Exclude credentials and session context belonging to a different native host. */
export declare function projectHostEnvironment(host: OrchestratorHost, environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
/** Returns false only for repositories that have not adopted project host setup. */
export declare function launchProjectOrchestrator(args: string[], options?: ProjectLaunchOptions): Promise<boolean>;
export {};
//# sourceMappingURL=project-launch.d.ts.map