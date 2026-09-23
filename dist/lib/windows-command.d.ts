export interface WindowsBatchInvocation {
    command: string;
    args: string[];
    windowsVerbatimArguments: true;
}
/** Prefer a Windows PATH candidate with an executable PATHEXT suffix. */
export declare function selectWindowsExecutableCandidate(candidates: readonly string[], pathext?: string): string | undefined;
/** Return only the canonical Windows system command processor; inherited COMSPEC is untrusted. */
export declare function validatedComspec(): string | undefined;
/** Build a literal cmd.exe invocation for a resolved .cmd/.bat shim. */
export declare function resolveWindowsBatchInvocation(command: string, args: string[]): WindowsBatchInvocation;
//# sourceMappingURL=windows-command.d.ts.map