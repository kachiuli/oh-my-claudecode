/** Minimal TOML key scanner used only to prevent redefining managed Codex tables. */
/**
 * True when appending `[target.path]` would redefine a table or extend a parent
 * that was already assigned as a value/inline table.
 */
export declare function hasTomlTableInsertionConflict(source: string, target: readonly string[]): boolean;
//# sourceMappingURL=codex-config.d.ts.map