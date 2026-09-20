import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { atomicWriteFileSync } from "../lib/atomic-write.js";
import { resolveProjectOmcPath } from "../lib/worktree-paths.js";
import type { OrchestratorHost } from "../orchestration/selection.js";

export const RECEIPT_PATH = ".omc/hosts/receipt.json";
const RECEIPT_MAX_BYTES = 4 * 1024 * 1024;
const TEXT_MAX_BYTES = 16 * 1024 * 1024;

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

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function portablePath(value: string): string {
  return value.split(sep).join("/");
}

export function assertRelativePath(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4096 ||
    isAbsolute(value) ||
    value.includes("\0")
  ) {
    throw new Error("host_assets_invalid_receipt");
  }
  const normalized = value.replaceAll("\\", "/");
  if (
    normalized
      .split("/")
      .some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error("host_assets_invalid_receipt");
  }
  return normalized;
}

function withinRoot(root: string, target: string): boolean {
  const relation = relative(root, target);
  return (
    relation === "" ||
    (!relation.startsWith(`..${sep}`) &&
      relation !== ".." &&
      !isAbsolute(relation))
  );
}

function assertSafeTarget(root: string, target: string): void {
  const absolute = resolve(target);
  if (!withinRoot(root, absolute)) throw new Error("host_assets_path_escape");
  let current = root;
  const relation = relative(root, absolute);
  for (const part of relation.split(sep).filter(Boolean)) {
    current = join(current, part);
    if (!existsSync(current)) continue;
    const info = lstatSync(current);
    if (info.isSymbolicLink())
      throw new Error(
        `host_assets_symlink_refused: ${portablePath(relative(root, current))}`,
      );
    if (current !== absolute && !info.isDirectory()) {
      throw new Error(
        `host_assets_invalid_parent: ${portablePath(relative(root, current))}`,
      );
    }
  }
}

export function readTarget(
  root: string,
  target: string,
): { bytes: Buffer | null; mode?: number } {
  assertSafeTarget(root, target);
  if (!existsSync(target)) return { bytes: null };
  const info = lstatSync(target);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink > 1 ||
    info.size > TEXT_MAX_BYTES
  ) {
    throw new Error(
      `host_assets_unsafe_target: ${portablePath(relative(root, target))}`,
    );
  }
  return { bytes: readFileSync(target), mode: info.mode };
}

export function readSource(path: string, maximum = TEXT_MAX_BYTES): string {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maximum) {
    throw new Error(`host_assets_invalid_package_source: ${path}`);
  }
  return readFileSync(path, "utf8");
}

export function parseReceipt(root: string): ProjectHostReceipt {
  const path = resolveProjectOmcPath("hosts/receipt.json", root);
  if (!existsSync(path)) return { schemaVersion: 1, hosts: {} };
  const content = readTarget(root, path).bytes;
  if (!content || content.length > RECEIPT_MAX_BYTES)
    throw new Error("host_assets_invalid_receipt");
  let raw: unknown;
  try {
    raw = JSON.parse(content.toString("utf8")) as unknown;
  } catch {
    throw new Error("host_assets_invalid_receipt");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("host_assets_invalid_receipt");
  const object = raw as Record<string, unknown>;
  if (
    object.schemaVersion !== 1 ||
    !object.hosts ||
    typeof object.hosts !== "object" ||
    Array.isArray(object.hosts)
  ) {
    throw new Error("host_assets_invalid_receipt");
  }
  const parseAssets = (value: unknown): AssetReceipt[] => {
    if (!Array.isArray(value)) throw new Error("host_assets_invalid_receipt");
    const assets = value.map((item): AssetReceipt => {
      if (!item || typeof item !== "object" || Array.isArray(item))
        throw new Error("host_assets_invalid_receipt");
      const asset = item as Record<string, unknown>;
      const pathValue = assertRelativePath(asset.path);
      if (
        !["file", "block", "json-hooks", "json-marketplace"].includes(
          String(asset.kind),
        )
      )
        throw new Error("host_assets_invalid_receipt");
      if (
        typeof asset.digest !== "string" ||
        !/^[a-f0-9]{64}$/.test(asset.digest)
      ) {
        throw new Error("host_assets_invalid_receipt");
      }
      if (asset.kind !== "file" && typeof asset.managedText !== "string") {
        throw new Error("host_assets_invalid_receipt");
      }
      return {
        path: pathValue,
        kind: asset.kind as AssetKind,
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
  const hosts: Partial<Record<OrchestratorHost, HostReceipt>> = {};
  for (const host of ["claude", "codex"] as const) {
    const value = (object.hosts as Record<string, unknown>)[host];
    if (value === undefined) continue;
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("host_assets_invalid_receipt");
    const entry = value as Record<string, unknown>;
    if (
      typeof entry.installedAt !== "string" ||
      typeof entry.packageRoot !== "string" ||
      !Array.isArray(entry.assets)
    ) {
      throw new Error("host_assets_invalid_receipt");
    }
    const assets = parseAssets(entry.assets);
    hosts[host] = {
      installedAt: entry.installedAt,
      packageRoot: entry.packageRoot,
      assets,
    };
  }
  const shared =
    object.shared === undefined ? undefined : parseAssets(object.shared);
  return {
    schemaVersion: 1,
    hosts,
    ...(shared === undefined ? {} : { shared }),
  };
}

export function mergeManagedBlock(
  existing: string,
  previous: AssetReceipt | undefined,
  nextBlock: string,
  start: string,
  end: string,
): string {
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

export function removeManagedBlock(
  existing: string,
  receipt: AssetReceipt,
): string | null | undefined {
  if (!receipt.managedText || !existing.includes(receipt.managedText))
    return undefined;
  const result = existing
    .replace(receipt.managedText, "")
    .replace(/^\s*\n/, "")
    .replace(/\n{3,}/g, "\n\n");
  return result.trim().length === 0 ? null : `${result.trimEnd()}\n`;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function parseManagedHooks(text: string | undefined): HookMap {
  if (!text) throw new Error("host_assets_invalid_receipt");
  try {
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error();
    return value as HookMap;
  } catch {
    throw new Error("host_assets_invalid_receipt");
  }
}

function parseHooksDocument(existing: string): Record<string, unknown> {
  if (existing.trim() === "") return {};
  let value: unknown;
  try {
    value = JSON.parse(existing) as unknown;
  } catch {
    throw new Error("host_assets_invalid_codex_hooks");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("host_assets_invalid_codex_hooks");
  }
  return value as Record<string, unknown>;
}

export function mergedCodexHooks(
  existing: string,
  previous: AssetReceipt | undefined,
  nextEntries: HookMap,
): string {
  const document = parseHooksDocument(existing);
  const rawHooks = document.hooks;
  if (
    rawHooks !== undefined &&
    (!rawHooks || typeof rawHooks !== "object" || Array.isArray(rawHooks))
  ) {
    throw new Error("host_assets_invalid_codex_hooks");
  }
  const hooks = { ...((rawHooks ?? {}) as Record<string, unknown>) };
  if (previous) {
    const oldEntries = parseManagedHooks(previous.managedText);
    for (const [event, groups] of Object.entries(oldEntries)) {
      const current = hooks[event];
      if (!Array.isArray(current))
        throw new Error(
          `host_assets_managed_content_modified: ${previous.path}`,
        );
      const remaining = [...current];
      for (const group of groups) {
        const index = remaining.findIndex((item) => sameJson(item, group));
        if (index < 0)
          throw new Error(
            `host_assets_managed_content_modified: ${previous.path}`,
          );
        remaining.splice(index, 1);
      }
      if (remaining.length === 0) delete hooks[event];
      else hooks[event] = remaining;
    }
  } else if (existing.includes("omc orchestrator hook --host codex")) {
    throw new Error("host_assets_unowned_codex_hook");
  }
  for (const [event, groups] of Object.entries(nextEntries)) {
    const current = hooks[event];
    if (current !== undefined && !Array.isArray(current))
      throw new Error("host_assets_invalid_codex_hooks");
    hooks[event] = [...((current as unknown[] | undefined) ?? []), ...groups];
  }
  document.hooks = hooks;
  return `${JSON.stringify(document, null, 2)}\n`;
}

export function removedCodexHooks(
  existing: string,
  receipt: AssetReceipt,
): string | null | undefined {
  const document = parseHooksDocument(existing);
  const rawHooks = document.hooks;
  if (!rawHooks || typeof rawHooks !== "object" || Array.isArray(rawHooks))
    return undefined;
  const hooks = { ...(rawHooks as Record<string, unknown>) };
  const entries = parseManagedHooks(receipt.managedText);
  for (const [event, groups] of Object.entries(entries)) {
    const current = hooks[event];
    if (!Array.isArray(current)) return undefined;
    for (const group of groups) {
      if (!current.some((item) => sameJson(item, group))) return undefined;
    }
  }
  for (const [event, groups] of Object.entries(entries)) {
    const remaining = [...(hooks[event] as unknown[])];
    for (const group of groups) {
      const index = remaining.findIndex((item) => sameJson(item, group));
      remaining.splice(index, 1);
    }
    if (remaining.length === 0) delete hooks[event];
    else hooks[event] = remaining;
  }
  if (Object.keys(hooks).length === 0) delete document.hooks;
  else document.hooks = hooks;
  return Object.keys(document).length === 0
    ? null
    : `${JSON.stringify(document, null, 2)}\n`;
}

interface ManagedMarketplace {
  readonly marketplaceName: string;
  readonly entry: Record<string, unknown>;
  readonly baseDocument: Record<string, unknown>;
  readonly originalText: string;
}

function parseMarketplaceDocument(existing: string): Record<string, unknown> {
  if (existing.trim() === "") {
    return {
      name: "omc-project",
      interface: { displayName: "OMC Project" },
      plugins: [],
    };
  }
  let value: unknown;
  try {
    value = JSON.parse(existing) as unknown;
  } catch {
    throw new Error("host_assets_invalid_codex_marketplace");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("host_assets_invalid_codex_marketplace");
  }
  return value as Record<string, unknown>;
}

function checkedMarketplace(document: Record<string, unknown>): {
  name: string;
  plugins: unknown[];
} {
  if (
    typeof document.name !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(document.name) ||
    !Array.isArray(document.plugins)
  ) {
    throw new Error("host_assets_invalid_codex_marketplace");
  }
  return { name: document.name, plugins: document.plugins };
}

function parseManagedMarketplace(text: string | undefined): ManagedMarketplace {
  if (!text) throw new Error("host_assets_invalid_receipt");
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new Error("host_assets_invalid_receipt");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("host_assets_invalid_receipt");
  }
  const managed = value as Record<string, unknown>;
  if (
    typeof managed.marketplaceName !== "string" ||
    !managed.entry ||
    typeof managed.entry !== "object" ||
    Array.isArray(managed.entry) ||
    !managed.baseDocument ||
    typeof managed.baseDocument !== "object" ||
    Array.isArray(managed.baseDocument) ||
    typeof managed.originalText !== "string"
  ) {
    throw new Error("host_assets_invalid_receipt");
  }
  return managed as unknown as ManagedMarketplace;
}

export function mergedCodexMarketplace(
  existing: string,
  previous: AssetReceipt | undefined,
  nextEntry: Record<string, unknown>,
): { content: string; managedText: string; marketplaceName: string } {
  const document = parseMarketplaceDocument(existing);
  const checked = checkedMarketplace(document);
  let baseDocument = structuredClone(document);
  let originalText = existing;
  if (previous) {
    const managed = parseManagedMarketplace(previous.managedText);
    if (managed.marketplaceName !== checked.name) {
      throw new Error(`host_assets_managed_content_modified: ${previous.path}`);
    }
    const index = checked.plugins.findIndex((entry) =>
      sameJson(entry, managed.entry),
    );
    if (index < 0) {
      throw new Error(`host_assets_managed_content_modified: ${previous.path}`);
    }
    checked.plugins.splice(index, 1);
    baseDocument = managed.baseDocument;
    originalText = managed.originalText;
  } else if (
    checked.plugins.some(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        !Array.isArray(entry) &&
        (entry as Record<string, unknown>).name === nextEntry.name,
    )
  ) {
    throw new Error("host_assets_plugin_name_collision: omc-project-host");
  }
  checked.plugins.push(nextEntry);
  const managed: ManagedMarketplace = {
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

export function removedCodexMarketplace(
  existing: string,
  receipt: AssetReceipt,
): string | null | undefined {
  const document = parseMarketplaceDocument(existing);
  const checked = checkedMarketplace(document);
  const managed = parseManagedMarketplace(receipt.managedText);
  if (managed.marketplaceName !== checked.name) return undefined;
  const index = checked.plugins.findIndex((entry) =>
    sameJson(entry, managed.entry),
  );
  if (index < 0) return undefined;
  checked.plugins.splice(index, 1);
  if (sameJson(document, managed.baseDocument)) {
    return managed.originalText.trim() === "" ? null : managed.originalText;
  }
  return `${JSON.stringify(document, null, 2)}\n`;
}

export function removedManagedAssetContent(
  content: Buffer,
  receipt: AssetReceipt,
): string | null | undefined {
  if (receipt.kind === "file") {
    return sha256(content) === receipt.digest ? null : undefined;
  }
  const text = content.toString("utf8");
  if (receipt.kind === "block") return removeManagedBlock(text, receipt);
  if (receipt.kind === "json-hooks") return removedCodexHooks(text, receipt);
  return removedCodexMarketplace(text, receipt);
}

function restoreMutation(mutation: Mutation): void {
  if (mutation.before === null) {
    if (existsSync(mutation.path)) unlinkSync(mutation.path);
    return;
  }
  atomicWriteFileSync(mutation.path, mutation.before.toString("utf8"));
  if (mutation.beforeMode !== undefined)
    chmodSync(mutation.path, mutation.beforeMode & 0o777);
}

function removeBackupDirectory(root: string, path: string): void {
  const absolute = resolve(path);
  if (!withinRoot(resolveProjectOmcPath("hosts/backups", root), absolute))
    return;
  if (existsSync(absolute)) rmSync(absolute, { recursive: true, force: true });
}

export function applyMutations(
  root: string,
  mutations: readonly Mutation[],
): AppliedTransaction {
  const changed = mutations.filter((mutation) => {
    if (mutation.after === null) return mutation.before !== null;
    return mutation.before?.toString("utf8") !== mutation.after;
  });
  const unchanged = mutations.filter((mutation) => !changed.includes(mutation));
  if (changed.length === 0) {
    return {
      changedFiles: [],
      unchangedFiles: unchanged.map((item) => item.relativePath),
      rollback() {},
    };
  }
  const backupDirectory = resolveProjectOmcPath(
    join(
      "hosts",
      "backups",
      `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}`,
    ),
    root,
  );
  const applied: Mutation[] = [];
  let rolledBack = false;
  try {
    for (const mutation of changed) {
      if (mutation.before === null) continue;
      const backup = join(backupDirectory, mutation.relativePath);
      assertSafeTarget(backupDirectory, backup);
      mkdirSync(dirname(backup), { recursive: true });
      writeFileSync(backup, mutation.before, { flag: "wx", mode: 0o600 });
    }
    for (const mutation of changed) {
      const current = readTarget(root, mutation.path).bytes;
      if (
        (current?.toString("base64") ?? null) !==
        (mutation.before?.toString("base64") ?? null)
      ) {
        throw new Error(
          `host_assets_concurrent_change: ${mutation.relativePath}`,
        );
      }
      if (mutation.after === null) {
        if (current) unlinkSync(mutation.path);
      } else {
        atomicWriteFileSync(mutation.path, mutation.after);
        if (mutation.beforeMode !== undefined)
          chmodSync(mutation.path, mutation.beforeMode & 0o777);
      }
      applied.push(mutation);
    }
  } catch (error) {
    for (const mutation of [...applied].reverse()) restoreMutation(mutation);
    rolledBack = true;
    removeBackupDirectory(root, backupDirectory);
    throw error;
  }
  return {
    changedFiles: changed.map((item) => item.relativePath),
    unchangedFiles: unchanged.map((item) => item.relativePath),
    backupDirectory: portablePath(relative(root, backupDirectory)),
    rollback() {
      if (rolledBack) return;
      for (const mutation of [...applied].reverse()) restoreMutation(mutation);
      rolledBack = true;
      removeBackupDirectory(root, backupDirectory);
    },
  };
}

export function assetIssue(root: string, asset: AssetReceipt): string | null {
  const state = readTarget(root, join(root, asset.path));
  if (!state.bytes) return `missing managed asset: ${asset.path}`;
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
    } catch {
      return `invalid managed marketplace: ${asset.path}`;
    }
  }
  try {
    const entries = parseManagedHooks(asset.managedText);
    const document = parseHooksDocument(text);
    const hooks = document.hooks as Record<string, unknown> | undefined;
    if (!hooks) return `missing managed hooks: ${asset.path}`;
    for (const [event, groups] of Object.entries(entries)) {
      const current = hooks[event];
      if (
        !Array.isArray(current) ||
        groups.some((group) => !current.some((item) => sameJson(item, group)))
      ) {
        return `modified managed hooks: ${asset.path}`;
      }
    }
    return null;
  } catch {
    return `invalid managed hooks: ${asset.path}`;
  }
}
