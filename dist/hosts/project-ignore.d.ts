import { type AssetReceipt, type ProjectHostReceipt } from "./asset-ownership.js";
export declare const PROJECT_IGNORE_PATH = ".gitignore";
/** Shared project ownership: committed host declaration, ignored local runtime/install data. */
export declare function projectIgnoreAsset(root: string, receipt: ProjectHostReceipt): {
    path: string;
    kind: "block";
    content: string;
    managedText: string;
    receipt: AssetReceipt;
};
export declare function projectIgnoreIssues(root: string, receipt: ProjectHostReceipt): string[];
//# sourceMappingURL=project-ignore.d.ts.map