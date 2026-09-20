import { join } from "node:path";
import { assetIssue, mergeManagedBlock, readTarget, sha256, } from "./asset-ownership.js";
export const PROJECT_IGNORE_PATH = ".gitignore";
const PROJECT_IGNORE_START = "# BEGIN OMC PROJECT HOST STATE";
const PROJECT_IGNORE_END = "# END OMC PROJECT HOST STATE";
const PROJECT_IGNORE_BLOCK = [
    PROJECT_IGNORE_START,
    "/.omc/state/",
    "/.omc/hosts/",
    PROJECT_IGNORE_END,
].join("\n");
/** Shared project ownership: committed host declaration, ignored local runtime/install data. */
export function projectIgnoreAsset(root, receipt) {
    const previous = receipt.shared?.find((asset) => asset.path === PROJECT_IGNORE_PATH);
    const existing = readTarget(root, join(root, PROJECT_IGNORE_PATH)).bytes?.toString("utf8") ??
        "";
    return {
        path: PROJECT_IGNORE_PATH,
        kind: "block",
        content: mergeManagedBlock(existing, previous, PROJECT_IGNORE_BLOCK, PROJECT_IGNORE_START, PROJECT_IGNORE_END),
        managedText: PROJECT_IGNORE_BLOCK,
        receipt: {
            path: PROJECT_IGNORE_PATH,
            kind: "block",
            digest: sha256(PROJECT_IGNORE_BLOCK),
            managedText: PROJECT_IGNORE_BLOCK,
        },
    };
}
export function projectIgnoreIssues(root, receipt) {
    if (Object.keys(receipt.hosts).length > 0 && !receipt.shared?.length) {
        return [
            "Shared project ignore ownership is missing. Rerun project host setup/update.",
        ];
    }
    return (receipt.shared ?? [])
        .map((asset) => assetIssue(root, asset))
        .filter((issue) => issue !== null);
}
//# sourceMappingURL=project-ignore.js.map