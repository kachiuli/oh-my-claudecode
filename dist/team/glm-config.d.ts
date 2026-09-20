import type { PluginConfig } from '../shared/types.js';
export interface GlmConfig {
    command: string;
    fallback: false;
    defaultWorkers: number;
    maxWorkers: number;
    model?: string;
}
/** Only executable names and absolute paths are accepted, never shell commands. */
export declare function validateGlmCommand(command: unknown): asserts command is string;
export declare function getGlmConfig(config?: PluginConfig, env?: NodeJS.ProcessEnv): GlmConfig;
export declare function resolveGlmExecutable(command: string): string;
/** Expand the preset into the existing routing mechanism; explicit entries win. */
export declare function applyGlmProfile(config: PluginConfig): PluginConfig;
//# sourceMappingURL=glm-config.d.ts.map