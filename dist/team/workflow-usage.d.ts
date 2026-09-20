export interface WorkflowTelemetry {
    provider: 'glm' | 'codex' | 'claude';
    durationMs: number;
    status: 'measured' | 'partial' | 'unknown';
    scope: 'all-models' | 'main-loop' | 'turn' | 'unknown';
    /** Total input, including cache reads and cache creation where the provider reports them. */
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    sessionId?: string;
    terminal?: 'success' | 'failure';
    diagnostics?: string[];
}
/** Reads only provider metadata; neither transcripts nor raw error messages survive this boundary. */
export declare function createWorkflowUsageCollector(provider: WorkflowTelemetry['provider']): {
    write(chunk: Buffer): void;
    finish(outcome: {
        durationMs: number;
        passed: boolean;
    }): WorkflowTelemetry;
};
//# sourceMappingURL=workflow-usage.d.ts.map