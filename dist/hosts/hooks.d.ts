import { type OrchestratorHost } from "../orchestration/selection.js";
export interface NativeHostHookInput {
    readonly session_id?: unknown;
    readonly cwd?: unknown;
    readonly hook_event_name?: unknown;
    readonly source?: unknown;
    readonly reason?: unknown;
}
export interface NativeHostHookOutput {
    readonly continue: true;
    readonly suppressOutput: true;
    readonly hookSpecificOutput?: Readonly<{
        hookEventName: "SessionStart";
        additionalContext: string;
    }>;
}
/** Translate the common Claude/Codex lifecycle payload into host session checks. */
export declare function handleHostHook(invocationCwd: string, host: OrchestratorHost, payloadInput: unknown): Promise<NativeHostHookOutput>;
//# sourceMappingURL=hooks.d.ts.map