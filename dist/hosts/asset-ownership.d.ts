import type { OrchestratorHost } from "../orchestration/selection.js";
export declare const RECEIPT_PATH = ".omc/hosts/receipt.json";
export type AssetKind = "file" | "block" | "json-hooks" | "json-marketplace";
export interface AssetReceipt {
    readonly path: string;
    readonly kind: AssetKind;
    readonly digest: string;
    readonly managedText?: string;
}
export interface HostReceipt {
    readonly installedAt: string;
    readonly packageRoot: string;
    readonly assets: readonly AssetReceipt[];
}
export interface ProjectHostReceipt {
    readonly schemaVersion: 1;
    readonly hosts: Partial<Record<OrchestratorHost, HostReceipt>>;
    readonly shared?: readonly AssetReceipt[];
}
export interface Mutation {
    readonly path: string;
    readonly relativePath: string;
    readonly before: Buffer | null;
    readonly beforeMode?: number;
    readonly after: string | null;
}
export interface AppliedTransaction {
    readonly changedFiles: readonly string[];
    readonly unchangedFiles: readonly string[];
    readonly backupDirectory?: string;
    rollback(): void;
}
export type HookMap = Record<string, readonly Record<string, unknown>[]>;
export declare function sha256(value: string | Buffer): string;
export declare function portablePath(value: string): string;
export declare function assertRelativePath(value: unknown): string;
export declare function readTarget(root: string, target: string): {
    bytes: Buffer | null;
    mode?: number;
};
export declare function readSource(path: string, maximum?: number): string;
export declare function parseReceipt(root: string): ProjectHostReceipt;
export declare function mergeManagedBlock(existing: string, previous: AssetReceipt | undefined, nextBlock: string, start: string, end: string): string;
export declare function removeManagedBlock(existing: string, receipt: AssetReceipt): string | null | undefined;
export declare function mergedCodexHooks(existing: string, previous: AssetReceipt | undefined, nextEntries: HookMap): string;
export declare function removedCodexHooks(existing: string, receipt: AssetReceipt): string | null | undefined;
export declare function mergedCodexMarketplace(existing: string, previous: AssetReceipt | undefined, nextEntry: Record<string, unknown>): {
    content: string;
    managedText: string;
    marketplaceName: string;
};
export declare function removedCodexMarketplace(existing: string, receipt: AssetReceipt): string | null | undefined;
export declare function removedManagedAssetContent(content: Buffer, receipt: AssetReceipt): string | null | undefined;
export declare function applyMutations(root: string, mutations: readonly Mutation[]): AppliedTransaction;
export declare function assetIssue(root: string, asset: AssetReceipt): string | null;
//# sourceMappingURL=asset-ownership.d.ts.map