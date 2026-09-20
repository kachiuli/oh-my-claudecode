import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync, } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { atomicWriteFileSync } from "../lib/atomic-write.js";
import { resolveProjectOmcPath } from "../lib/worktree-paths.js";
export const RECEIPT_PATH = ".omc/hosts/receipt.json";
const RECEIPT_MAX_BYTES = 4 * 1024 * 1024;
const TEXT_MAX_BYTES = 16 * 1024 * 1024;
export function sha256(value) {
    return createHash("sha256").update(value).digest("hex");
}
export function portablePath(value) {
    return value.split(sep).join("/");
}
export function assertRelativePath(value) {
    if (typeof value !== "string" ||
        value.length === 0 ||
        value.length > 4096 ||
        isAbsolute(value) ||
        value.includes("\0")) {
        throw new Error("host_assets_invalid_receipt");
    }
    const normalized = value.replaceAll("\\", "/");
    if (normalized
        .split("/")
        .some((part) => part === "" || part === "." || part === "..")) {
        throw new Error("host_assets_invalid_receipt");
    }
    return normalized;
}
function withinRoot(root, target) {
    const relation = relative(root, target);
    return (relation === "" ||
        (!relation.startsWith(`..${sep}`) &&
            relation !== ".." &&
            !isAbsolute(relation)));
}
function assertSafeTarget(root, target) {
    const absolute = resolve(target);
    if (!withinRoot(root, absolute))
        throw new Error("host_assets_path_escape");
    let current = root;
    const relation = relative(root, absolute);
    for (const part of relation.split(sep).filter(Boolean)) {
        current = join(current, part);
        if (!existsSync(current))
            continue;
        const info = lstatSync(current);
        if (info.isSymbolicLink())
            throw new Error(`host_assets_symlink_refused: ${portablePath(relative(root, current))}`);
        if (current !== absolute && !info.isDirectory()) {
            throw new Error(`host_assets_invalid_parent: ${portablePath(relative(root, current))}`);
        }
    }
}
export function readTarget(root, target) {
    assertSafeTarget(root, target);
    if (!existsSync(target))
        return { bytes: null };
    const info = lstatSync(target);
    if (!info.isFile() ||
        info.isSymbolicLink() ||
        info.nlink > 1 ||
        info.size > TEXT_MAX_BYTES) {
        throw new Error(`host_assets_unsafe_target: ${portablePath(relative(root, target))}`);
    }
    return { bytes: readFileSync(target), mode: info.mode };
}
export function readSource(path, maximum = TEXT_MAX_BYTES) {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > maximum) {
        throw new Error(`host_assets_invalid_package_source: ${path}`);
    }
    return readFileSync(path, "utf8");
}
export function parseReceipt(root) {
    const path = resolveProjectOmcPath("hosts/receipt.json", root);
    if (!existsSync(path))
        return { schemaVersion: 1, hosts: {} };
    const content = readTarget(root, path).bytes;
    if (!content || content.length > RECEIPT_MAX_BYTES)
        throw new Error("host_assets_invalid_receipt");
    let raw;
    try {
        raw = JSON.parse(content.toString("utf8"));
    }
    catch {
        throw new Error("host_assets_invalid_receipt");
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
        throw new Error("host_assets_invalid_receipt");
    const object = raw;
    if (object.schemaVersion !== 1 ||
        !object.hosts ||
        typeof object.hosts !== "object" ||
        Array.isArray(object.hosts)) {
        throw new Error("host_assets_invalid_receipt");
    }
    const parseAssets = (value) => {
        if (!Array.isArray(value))
            throw new Error("host_assets_invalid_receipt");
        const assets = value.map((item) => {
            if (!item || typeof item !== "object" || Array.isArray(item))
                throw new Error("host_assets_invalid_receipt");
            const asset = item;
            const pathValue = assertRelativePath(asset.path);
            if (!["file", "block", "json-hooks", "json-marketplace"].includes(String(asset.kind)))
                throw new Error("host_assets_invalid_receipt");
            if (typeof asset.digest !== "string" ||
                !/^[a-f0-9]{64}$/.test(asset.digest)) {
                throw new Error("host_assets_invalid_receipt");
            }
            if (asset.kind !== "file" && typeof asset.managedText !== "string") {
                throw new Error("host_assets_invalid_receipt");
            }
            return {
                path: pathValue,
                kind: asset.kind,
                digest: asset.digest,
                ...(typeof asset.managedText === "string"
                    ? { managedText: asset.managedText }
                    : {}),
            };
        });
        if (new Set(assets.map((asset) => asset.path)).size !== assets.length) {
            throw new Error("host_assets_invalid_receipt");
        }
        return assets;
    };
    const hosts = {};
    for (const host of ["claude", "codex"]) {
        const value = object.hosts[host];
        if (value === undefined)
            continue;
        if (!value || typeof value !== "object" || Array.isArray(value))
            throw new Error("host_assets_invalid_receipt");
        const entry = value;
        if (typeof entry.installedAt !== "string" ||
            typeof entry.packageRoot !== "string" ||
            !Array.isArray(entry.assets)) {
            throw new Error("host_assets_invalid_receipt");
        }
        const assets = parseAssets(entry.assets);
        hosts[host] = {
            installedAt: entry.installedAt,
            packageRoot: entry.packageRoot,
            assets,
        };
    }
    const shared = object.shared === undefined ? undefined : parseAssets(object.shared);
    return {
        schemaVersion: 1,
        hosts,
        ...(shared === undefined ? {} : { shared }),
    };
}
export function mergeManagedBlock(existing, previous, nextBlock, start, end) {
    if (previous) {
        if (!previous.managedText || !existing.includes(previous.managedText)) {
            throw new Error(`host_assets_managed_content_modified: ${previous.path}`);
        }
        return existing.replace(previous.managedText, nextBlock);
    }
    if (existing.includes(start) || existing.includes(end)) {
        throw new Error("host_assets_unowned_managed_block");
    }
    const base = existing.trimEnd();
    return `${base ? `${base}\n\n` : ""}${nextBlock}\n`;
}
export function removeManagedBlock(existing, receipt) {
    if (!receipt.managedText || !existing.includes(receipt.managedText))
        return undefined;
    const result = existing
        .replace(receipt.managedText, "")
        .replace(/^\s*\n/, "")
        .replace(/\n{3,}/g, "\n\n");
    return result.trim().length === 0 ? null : `${result.trimEnd()}\n`;
}
function sameJson(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}
function parseManagedHooks(text) {
    if (!text)
        throw new Error("host_assets_invalid_receipt");
    try {
        const value = JSON.parse(text);
        if (!value || typeof value !== "object" || Array.isArray(value))
            throw new Error();
        return value;
    }
    catch {
        throw new Error("host_assets_invalid_receipt");
    }
}
function parseHooksDocument(existing) {
    if (existing.trim() === "")
        return {};
    let value;
    try {
        value = JSON.parse(existing);
    }
    catch {
        throw new Error("host_assets_invalid_codex_hooks");
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("host_assets_invalid_codex_hooks");
    }
    return value;
}
export function mergedCodexHooks(existing, previous, nextEntries) {
    const document = parseHooksDocument(existing);
    const rawHooks = document.hooks;
    if (rawHooks !== undefined &&
        (!rawHooks || typeof rawHooks !== "object" || Array.isArray(rawHooks))) {
        throw new Error("host_assets_invalid_codex_hooks");
    }
    const hooks = { ...(rawHooks ?? {}) };
    if (previous) {
        const oldEntries = parseManagedHooks(previous.managedText);
        for (const [event, groups] of Object.entries(oldEntries)) {
            const current = hooks[event];
            if (!Array.isArray(current))
                throw new Error(`host_assets_managed_content_modified: ${previous.path}`);
            const remaining = [...current];
            for (const group of groups) {
                const index = remaining.findIndex((item) => sameJson(item, group));
                if (index < 0)
                    throw new Error(`host_assets_managed_content_modified: ${previous.path}`);
                remaining.splice(index, 1);
            }
            if (remaining.length === 0)
                delete hooks[event];
            else
                hooks[event] = remaining;
        }
    }
    else if (existing.includes("omc orchestrator hook --host codex")) {
        throw new Error("host_assets_unowned_codex_hook");
    }
    for (const [event, groups] of Object.entries(nextEntries)) {
        const current = hooks[event];
        if (current !== undefined && !Array.isArray(current))
            throw new Error("host_assets_invalid_codex_hooks");
        hooks[event] = [...(current ?? []), ...groups];
    }
    document.hooks = hooks;
    return `${JSON.stringify(document, null, 2)}\n`;
}
export function removedCodexHooks(existing, receipt) {
    const document = parseHooksDocument(existing);
    const rawHooks = document.hooks;
    if (!rawHooks || typeof rawHooks !== "object" || Array.isArray(rawHooks))
        return undefined;
    const hooks = { ...rawHooks };
    const entries = parseManagedHooks(receipt.managedText);
    for (const [event, groups] of Object.entries(entries)) {
        const current = hooks[event];
        if (!Array.isArray(current))
            return undefined;
        for (const group of groups) {
            if (!current.some((item) => sameJson(item, group)))
                return undefined;
        }
    }
    for (const [event, groups] of Object.entries(entries)) {
        const remaining = [...hooks[event]];
        for (const group of groups) {
            const index = remaining.findIndex((item) => sameJson(item, group));
            remaining.splice(index, 1);
        }
        if (remaining.length === 0)
            delete hooks[event];
        else
            hooks[event] = remaining;
    }
    if (Object.keys(hooks).length === 0)
        delete document.hooks;
    else
        document.hooks = hooks;
    return Object.keys(document).length === 0
        ? null
        : `${JSON.stringify(document, null, 2)}\n`;
}
function parseMarketplaceDocument(existing) {
    if (existing.trim() === "") {
        return {
            name: "omc-project",
            interface: { displayName: "OMC Project" },
            plugins: [],
        };
    }
    let value;
    try {
        value = JSON.parse(existing);
    }
    catch {
        throw new Error("host_assets_invalid_codex_marketplace");
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("host_assets_invalid_codex_marketplace");
    }
    return value;
}
function checkedMarketplace(document) {
    if (typeof document.name !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(document.name) ||
        !Array.isArray(document.plugins)) {
        throw new Error("host_assets_invalid_codex_marketplace");
    }
    return { name: document.name, plugins: document.plugins };
}
function parseManagedMarketplace(text) {
    if (!text)
        throw new Error("host_assets_invalid_receipt");
    let value;
    try {
        value = JSON.parse(text);
    }
    catch {
        throw new Error("host_assets_invalid_receipt");
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("host_assets_invalid_receipt");
    }
    const managed = value;
    if (typeof managed.marketplaceName !== "string" ||
        !managed.entry ||
        typeof managed.entry !== "object" ||
        Array.isArray(managed.entry) ||
        !managed.baseDocument ||
        typeof managed.baseDocument !== "object" ||
        Array.isArray(managed.baseDocument) ||
        typeof managed.originalText !== "string") {
        throw new Error("host_assets_invalid_receipt");
    }
    return managed;
}
export function mergedCodexMarketplace(existing, previous, nextEntry) {
    const document = parseMarketplaceDocument(existing);
    const checked = checkedMarketplace(document);
    let baseDocument = structuredClone(document);
    let originalText = existing;
    if (previous) {
        const managed = parseManagedMarketplace(previous.managedText);
        if (managed.marketplaceName !== checked.name) {
            throw new Error(`host_assets_managed_content_modified: ${previous.path}`);
        }
        const index = checked.plugins.findIndex((entry) => sameJson(entry, managed.entry));
        if (index < 0) {
            throw new Error(`host_assets_managed_content_modified: ${previous.path}`);
        }
        checked.plugins.splice(index, 1);
        baseDocument = managed.baseDocument;
        originalText = managed.originalText;
    }
    else if (checked.plugins.some((entry) => entry &&
        typeof entry === "object" &&
        !Array.isArray(entry) &&
        entry.name === nextEntry.name)) {
        throw new Error("host_assets_plugin_name_collision: omc-project-host");
    }
    checked.plugins.push(nextEntry);
    const managed = {
        marketplaceName: checked.name,
        entry: nextEntry,
        baseDocument,
        originalText,
    };
    return {
        content: `${JSON.stringify(document, null, 2)}\n`,
        managedText: JSON.stringify(managed),
        marketplaceName: checked.name,
    };
}
export function removedCodexMarketplace(existing, receipt) {
    const document = parseMarketplaceDocument(existing);
    const checked = checkedMarketplace(document);
    const managed = parseManagedMarketplace(receipt.managedText);
    if (managed.marketplaceName !== checked.name)
        return undefined;
    const index = checked.plugins.findIndex((entry) => sameJson(entry, managed.entry));
    if (index < 0)
        return undefined;
    checked.plugins.splice(index, 1);
    if (sameJson(document, managed.baseDocument)) {
        return managed.originalText.trim() === "" ? null : managed.originalText;
    }
    return `${JSON.stringify(document, null, 2)}\n`;
}
export function removedManagedAssetContent(content, receipt) {
    if (receipt.kind === "file") {
        return sha256(content) === receipt.digest ? null : undefined;
    }
    const text = content.toString("utf8");
    if (receipt.kind === "block")
        return removeManagedBlock(text, receipt);
    if (receipt.kind === "json-hooks")
        return removedCodexHooks(text, receipt);
    return removedCodexMarketplace(text, receipt);
}
function restoreMutation(mutation) {
    if (mutation.before === null) {
        if (existsSync(mutation.path))
            unlinkSync(mutation.path);
        return;
    }
    atomicWriteFileSync(mutation.path, mutation.before.toString("utf8"));
    if (mutation.beforeMode !== undefined)
        chmodSync(mutation.path, mutation.beforeMode & 0o777);
}
function removeBackupDirectory(root, path) {
    const absolute = resolve(path);
    if (!withinRoot(resolveProjectOmcPath("hosts/backups", root), absolute))
        return;
    if (existsSync(absolute))
        rmSync(absolute, { recursive: true, force: true });
}
export function applyMutations(root, mutations) {
    const changed = mutations.filter((mutation) => {
        if (mutation.after === null)
            return mutation.before !== null;
        return mutation.before?.toString("utf8") !== mutation.after;
    });
    const unchanged = mutations.filter((mutation) => !changed.includes(mutation));
    if (changed.length === 0) {
        return {
            changedFiles: [],
            unchangedFiles: unchanged.map((item) => item.relativePath),
            rollback() { },
        };
    }
    const backupDirectory = resolveProjectOmcPath(join("hosts", "backups", `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}`), root);
    const applied = [];
    let rolledBack = false;
    try {
        for (const mutation of changed) {
            if (mutation.before === null)
                continue;
            const backup = join(backupDirectory, mutation.relativePath);
            assertSafeTarget(backupDirectory, backup);
            mkdirSync(dirname(backup), { recursive: true });
            writeFileSync(backup, mutation.before, { flag: "wx", mode: 0o600 });
        }
        for (const mutation of changed) {
            const current = readTarget(root, mutation.path).bytes;
            if ((current?.toString("base64") ?? null) !==
                (mutation.before?.toString("base64") ?? null)) {
                throw new Error(`host_assets_concurrent_change: ${mutation.relativePath}`);
            }
            if (mutation.after === null) {
                if (current)
                    unlinkSync(mutation.path);
            }
            else {
                atomicWriteFileSync(mutation.path, mutation.after);
                if (mutation.beforeMode !== undefined)
                    chmodSync(mutation.path, mutation.beforeMode & 0o777);
            }
            applied.push(mutation);
        }
    }
    catch (error) {
        for (const mutation of [...applied].reverse())
            restoreMutation(mutation);
        rolledBack = true;
        removeBackupDirectory(root, backupDirectory);
        throw error;
    }
    return {
        changedFiles: changed.map((item) => item.relativePath),
        unchangedFiles: unchanged.map((item) => item.relativePath),
        backupDirectory: portablePath(relative(root, backupDirectory)),
        rollback() {
            if (rolledBack)
                return;
            for (const mutation of [...applied].reverse())
                restoreMutation(mutation);
            rolledBack = true;
            removeBackupDirectory(root, backupDirectory);
        },
    };
}
export function assetIssue(root, asset) {
    const state = readTarget(root, join(root, asset.path));
    if (!state.bytes)
        return `missing managed asset: ${asset.path}`;
    const text = state.bytes.toString("utf8");
    if (asset.kind === "file") {
        return sha256(state.bytes) === asset.digest
            ? null
            : `modified managed asset: ${asset.path}`;
    }
    if (asset.kind === "block") {
        return asset.managedText && text.includes(asset.managedText)
            ? null
            : `modified managed block: ${asset.path}`;
    }
    if (asset.kind === "json-marketplace") {
        try {
            const document = parseMarketplaceDocument(text);
            const checked = checkedMarketplace(document);
            const managed = parseManagedMarketplace(asset.managedText);
            return checked.name === managed.marketplaceName &&
                checked.plugins.some((entry) => sameJson(entry, managed.entry))
                ? null
                : `modified managed marketplace: ${asset.path}`;
        }
        catch {
            return `invalid managed marketplace: ${asset.path}`;
        }
    }
    try {
        const entries = parseManagedHooks(asset.managedText);
        const document = parseHooksDocument(text);
        const hooks = document.hooks;
        if (!hooks)
            return `missing managed hooks: ${asset.path}`;
        for (const [event, groups] of Object.entries(entries)) {
            const current = hooks[event];
            if (!Array.isArray(current) ||
                groups.some((group) => !current.some((item) => sameJson(item, group)))) {
                return `modified managed hooks: ${asset.path}`;
            }
        }
        return null;
    }
    catch {
        return `invalid managed hooks: ${asset.path}`;
    }
}
//# sourceMappingURL=asset-ownership.js.map