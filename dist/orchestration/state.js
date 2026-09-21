import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { findWorkspaceRoot, getGitTopLevel, getOmcRoot, resolveProjectOmcPath, } from "../lib/worktree-paths.js";
const HOSTS = ["claude", "codex"];
const CONFIG_BYTES = 16 * 1024;
const STATE_BYTES = 4 * 1024 * 1024;
const MAX_HANDOFFS = 10_000;
const LEGACY_REVISION = createHash("sha256")
    .update("omc-orchestrator:legacy:claude:v1")
    .digest("hex");
export function isHost(value) {
    return HOSTS.some((host) => host === value);
}
export function exactObject(value, keys, error) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(error);
    }
    const object = value;
    if (Object.keys(object).some((key) => !keys.includes(key))) {
        throw new Error(error);
    }
    return object;
}
export function boundedText(value, max, error) {
    if (typeof value !== "string" ||
        value.length === 0 ||
        value.length > max ||
        /[\0\r\n]/.test(value)) {
        throw new Error(error);
    }
    return value;
}
export function parseTimestamp(value, error) {
    const timestamp = boundedText(value, 64, error);
    if (!Number.isFinite(Date.parse(timestamp)))
        throw new Error(error);
    return timestamp;
}
export function parseRevision(value, error) {
    const revision = boundedText(value, 64, error);
    if (!/^(?:[a-f0-9]{64}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/.test(revision)) {
        throw new Error(error);
    }
    return revision;
}
export function parseUuid(value, error) {
    const id = boundedText(value, 36, error);
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)) {
        throw new Error(error);
    }
    return id;
}
export function parseSessionId(value) {
    const sessionId = boundedText(value, 256, "orchestrator_invalid_session");
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/.test(sessionId)) {
        throw new Error("orchestrator_invalid_session");
    }
    return sessionId;
}
export function parseCheckpoint(value) {
    const raw = exactObject(value, ["kind", "workflowName", "reference"], "orchestrator_invalid_checkpoint");
    if (!["before-work", "completed-stage", "paused", "checkpointed"].includes(String(raw.kind))) {
        throw new Error("orchestrator_invalid_checkpoint");
    }
    return Object.freeze({
        kind: raw.kind,
        ...(raw.workflowName === undefined
            ? {}
            : {
                workflowName: boundedText(raw.workflowName, 160, "orchestrator_invalid_checkpoint"),
            }),
        ...(raw.reference === undefined
            ? {}
            : {
                reference: boundedText(raw.reference, 500, "orchestrator_invalid_checkpoint"),
            }),
    });
}
export function readBoundedJson(filePath, maxBytes, error) {
    let info;
    try {
        info = lstatSync(filePath);
    }
    catch {
        throw new Error(error);
    }
    if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) {
        throw new Error(error);
    }
    try {
        return JSON.parse(readFileSync(filePath, "utf8"));
    }
    catch {
        throw new Error(error);
    }
}
export function repositoryRoot(cwd) {
    let root;
    try {
        root = realpathSync(resolve(cwd));
    }
    catch {
        throw new Error("orchestrator_invalid_working_directory");
    }
    // Repository-owned configuration, installed assets, and native launch cwd stay with the
    // physical checkout. A parent workspace marker may relocate shared runtime state only.
    return getGitTopLevel(root) ?? findWorkspaceRoot(root) ?? root;
}
function repositoryStateKey(root) {
    return createHash("sha256").update(root).digest("hex");
}
export function resolveOrchestratorPaths(cwd) {
    const root = repositoryRoot(cwd);
    const stateRoot = join(getOmcRoot(root), "state", "orchestrator");
    const repositoryKey = repositoryStateKey(root);
    return Object.freeze({
        repositoryRoot: root,
        repositoryKey,
        config: resolveProjectOmcPath("orchestrator.json", root),
        state: join(stateRoot, "repositories", repositoryKey, "runtime.json"),
        operationLock: join(stateRoot, "operation.lock"),
    });
}
export function parseRepositoryConfig(value) {
    const raw = exactObject(value, ["schemaVersion", "supportedHosts", "defaultHost"], "orchestrator_invalid_config");
    if (raw.schemaVersion !== 1 ||
        !Array.isArray(raw.supportedHosts) ||
        raw.supportedHosts.length < 1 ||
        raw.supportedHosts.length > HOSTS.length) {
        throw new Error("orchestrator_invalid_config");
    }
    const supportedHosts = raw.supportedHosts.map((host) => {
        if (!isHost(host))
            throw new Error("orchestrator_invalid_config");
        return host;
    });
    if (new Set(supportedHosts).size !== supportedHosts.length) {
        throw new Error("orchestrator_invalid_config");
    }
    if (raw.defaultHost !== undefined &&
        (!isHost(raw.defaultHost) || !supportedHosts.includes(raw.defaultHost))) {
        throw new Error("orchestrator_invalid_config");
    }
    return Object.freeze({
        schemaVersion: 1,
        supportedHosts: Object.freeze([...supportedHosts]),
        ...(raw.defaultHost === undefined ? {} : { defaultHost: raw.defaultHost }),
    });
}
export function readOrchestratorRepositoryConfig(cwd) {
    const path = resolveOrchestratorPaths(cwd).config;
    try {
        lstatSync(path);
    }
    catch (error) {
        if (error.code === "ENOENT")
            return null;
        throw new Error("orchestrator_invalid_config");
    }
    return parseRepositoryConfig(readBoundedJson(path, CONFIG_BYTES, "orchestrator_invalid_config"));
}
function parseLocalSelection(value) {
    const raw = exactObject(value, ["host", "revision", "selectedAt"], "orchestrator_invalid_state");
    if (!isHost(raw.host))
        throw new Error("orchestrator_invalid_state");
    return Object.freeze({
        host: raw.host,
        revision: parseRevision(raw.revision, "orchestrator_invalid_state"),
        selectedAt: parseTimestamp(raw.selectedAt, "orchestrator_invalid_state"),
    });
}
function parseLease(value) {
    const raw = exactObject(value, [
        "host",
        "sessionId",
        "leaseId",
        "selectionRevision",
        "tokenHash",
        "ownerPid",
        "relatedPids",
        "ownerProcessStartedAt",
        "relatedProcesses",
        "processRegistration",
        "acquiredAt",
    ], "orchestrator_invalid_state");
    if (!isHost(raw.host))
        throw new Error("orchestrator_invalid_state");
    const tokenHash = boundedText(raw.tokenHash, 64, "orchestrator_invalid_state");
    if (!/^[a-f0-9]{64}$/.test(tokenHash)) {
        throw new Error("orchestrator_invalid_state");
    }
    if (!Number.isSafeInteger(raw.ownerPid) ||
        Number(raw.ownerPid) <= 0 ||
        !Array.isArray(raw.relatedPids) ||
        raw.relatedPids.length > 32 ||
        raw.relatedPids.some((pid) => !Number.isSafeInteger(pid) || Number(pid) <= 0) ||
        new Set(raw.relatedPids).size !== raw.relatedPids.length) {
        throw new Error("orchestrator_invalid_state");
    }
    const relatedPids = raw.relatedPids.map(Number);
    const ownerProcessStartedAt = parsePersistedProcessStartIdentity(raw.ownerProcessStartedAt);
    let relatedProcesses;
    if (raw.relatedProcesses !== undefined) {
        if (!Array.isArray(raw.relatedProcesses) ||
            raw.relatedProcesses.length !== relatedPids.length) {
            throw new Error("orchestrator_invalid_state");
        }
        relatedProcesses = Object.freeze(raw.relatedProcesses.map((value, index) => {
            const process = exactObject(value, ["pid", "processStartedAt"], "orchestrator_invalid_state");
            if (!Number.isSafeInteger(process.pid) ||
                Number(process.pid) <= 0 ||
                Number(process.pid) !== relatedPids[index]) {
                throw new Error("orchestrator_invalid_state");
            }
            return Object.freeze({
                pid: Number(process.pid),
                processStartedAt: parsePersistedProcessStartIdentity(process.processStartedAt, true),
            });
        }));
    }
    if (raw.processRegistration !== undefined &&
        !["not-started", "pending", "complete"].includes(String(raw.processRegistration))) {
        throw new Error("orchestrator_invalid_state");
    }
    return Object.freeze({
        host: raw.host,
        sessionId: parseSessionId(raw.sessionId),
        leaseId: parseUuid(raw.leaseId, "orchestrator_invalid_state"),
        selectionRevision: parseRevision(raw.selectionRevision, "orchestrator_invalid_state"),
        tokenHash,
        ownerPid: Number(raw.ownerPid),
        relatedPids: Object.freeze(relatedPids),
        ...(raw.ownerProcessStartedAt === undefined
            ? {}
            : { ownerProcessStartedAt }),
        ...(relatedProcesses === undefined ? {} : { relatedProcesses }),
        ...(raw.processRegistration === undefined
            ? {}
            : {
                processRegistration: raw.processRegistration,
            }),
        acquiredAt: parseTimestamp(raw.acquiredAt, "orchestrator_invalid_state"),
    });
}
function parsePersistedProcessStartIdentity(value, required = false) {
    if (value === undefined && !required)
        return undefined;
    if (value === null)
        return null;
    if (typeof value !== "string" ||
        value.length < 3 ||
        value.length > 1024 ||
        !/^[a-z0-9_-]{1,32}:[^\0\r\n]+$/i.test(value)) {
        throw new Error("orchestrator_invalid_state");
    }
    return value;
}
function parseCheckpointRecord(value) {
    const raw = exactObject(value, ["host", "sessionId", "selectionRevision", "checkpoint", "at"], "orchestrator_invalid_state");
    if (!isHost(raw.host))
        throw new Error("orchestrator_invalid_state");
    return Object.freeze({
        host: raw.host,
        sessionId: parseSessionId(raw.sessionId),
        selectionRevision: parseRevision(raw.selectionRevision, "orchestrator_invalid_state"),
        checkpoint: parseCheckpoint(raw.checkpoint),
        at: parseTimestamp(raw.at, "orchestrator_invalid_state"),
    });
}
function parseRecoveryRecord(value) {
    const raw = exactObject(value, [
        "id",
        "host",
        "selectionRevision",
        "checkpoint",
        "recoveredOperationLock",
        "recoveredLease",
        "operationOwner",
        "at",
    ], "orchestrator_invalid_state");
    if (!isHost(raw.host) ||
        typeof raw.recoveredOperationLock !== "boolean" ||
        typeof raw.recoveredLease !== "boolean") {
        throw new Error("orchestrator_invalid_state");
    }
    let operationOwner;
    if (raw.operationOwner !== undefined) {
        const owner = exactObject(raw.operationOwner, ["pid", "processStartedAt", "nonce"], "orchestrator_invalid_state");
        if (!Number.isSafeInteger(owner.pid) || Number(owner.pid) <= 0) {
            throw new Error("orchestrator_invalid_state");
        }
        const processStartedAt = parsePersistedProcessStartIdentity(owner.processStartedAt, true);
        if (processStartedAt === null)
            throw new Error("orchestrator_invalid_state");
        operationOwner = Object.freeze({
            pid: Number(owner.pid),
            processStartedAt,
            nonce: parseUuid(owner.nonce, "orchestrator_invalid_state"),
        });
    }
    return Object.freeze({
        id: parseUuid(raw.id, "orchestrator_invalid_state"),
        host: raw.host,
        selectionRevision: parseRevision(raw.selectionRevision, "orchestrator_invalid_state"),
        checkpoint: parseCheckpoint(raw.checkpoint),
        recoveredOperationLock: raw.recoveredOperationLock,
        recoveredLease: raw.recoveredLease,
        ...(operationOwner === undefined ? {} : { operationOwner }),
        at: parseTimestamp(raw.at, "orchestrator_invalid_state"),
    });
}
function parseHandoff(value) {
    const raw = exactObject(value, [
        "id",
        "from",
        "to",
        "fromSelectionRevision",
        "toSelectionRevision",
        "sessionId",
        "checkpoint",
        "at",
    ], "orchestrator_invalid_state");
    if (!isHost(raw.from) || !isHost(raw.to) || raw.from === raw.to) {
        throw new Error("orchestrator_invalid_state");
    }
    return Object.freeze({
        id: parseUuid(raw.id, "orchestrator_invalid_state"),
        from: raw.from,
        to: raw.to,
        fromSelectionRevision: parseRevision(raw.fromSelectionRevision, "orchestrator_invalid_state"),
        toSelectionRevision: parseRevision(raw.toSelectionRevision, "orchestrator_invalid_state"),
        sessionId: parseSessionId(raw.sessionId),
        checkpoint: parseCheckpoint(raw.checkpoint),
        at: parseTimestamp(raw.at, "orchestrator_invalid_state"),
    });
}
export function readRuntimeState(cwd) {
    const path = resolveOrchestratorPaths(cwd).state;
    return readRuntimeStateFile(path);
}
export function readRuntimeStateFile(path) {
    try {
        lstatSync(path);
    }
    catch (error) {
        if (error.code === "ENOENT") {
            return Object.freeze({ schemaVersion: 1 });
        }
        throw new Error("orchestrator_invalid_state");
    }
    const raw = exactObject(readBoundedJson(path, STATE_BYTES, "orchestrator_invalid_state"), [
        "schemaVersion",
        "selection",
        "lease",
        "lastCheckpoint",
        "lastRecovery",
        "handoffs",
    ], "orchestrator_invalid_state");
    if (raw.schemaVersion !== 1)
        throw new Error("orchestrator_invalid_state");
    if (raw.handoffs !== undefined &&
        (!Array.isArray(raw.handoffs) || raw.handoffs.length > MAX_HANDOFFS)) {
        throw new Error("orchestrator_invalid_state");
    }
    return Object.freeze({
        schemaVersion: 1,
        ...(raw.selection === undefined
            ? {}
            : { selection: parseLocalSelection(raw.selection) }),
        ...(raw.lease === undefined ? {} : { lease: parseLease(raw.lease) }),
        ...(raw.lastCheckpoint === undefined
            ? {}
            : { lastCheckpoint: parseCheckpointRecord(raw.lastCheckpoint) }),
        ...(raw.lastRecovery === undefined
            ? {}
            : { lastRecovery: parseRecoveryRecord(raw.lastRecovery) }),
        ...(raw.handoffs === undefined
            ? {}
            : { handoffs: Object.freeze(raw.handoffs.map(parseHandoff)) }),
    });
}
export function assertRuntimeStateWritable(state) {
    if ((state.handoffs?.length ?? 0) > MAX_HANDOFFS) {
        throw new Error("orchestrator_state_limit_reached");
    }
    let serialized;
    try {
        serialized = JSON.stringify(state, null, 2);
    }
    catch {
        throw new Error("orchestrator_invalid_state");
    }
    if (Buffer.byteLength(serialized, "utf8") > STATE_BYTES) {
        throw new Error("orchestrator_state_limit_reached");
    }
}
function selectionRevision(config) {
    return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}
export function assertNoCompetingOmx(paths) {
    const roots = new Set([
        paths.repositoryRoot,
        findWorkspaceRoot(paths.repositoryRoot),
    ]);
    for (const root of roots) {
        if (!root)
            continue;
        const omxRoot = join(root, ".omx");
        if (pathEntryExists(join(omxRoot, "state")) ||
            pathEntryExists(join(omxRoot, "setup-scope.json"))) {
            throw new Error("orchestrator_competing_omx_state_requires_explicit_import");
        }
    }
}
function pathEntryExists(path) {
    try {
        lstatSync(path);
        return true;
    }
    catch (error) {
        return error.code !== "ENOENT";
    }
}
export function activeFrom(config, state) {
    if (!config) {
        return Object.freeze({
            host: "claude",
            source: "legacy",
            supportedHosts: Object.freeze(["claude"]),
            selectionRevision: LEGACY_REVISION,
            adopted: false,
        });
    }
    if (state.selection) {
        if (!config.supportedHosts.includes(state.selection.host)) {
            throw new Error("orchestrator_selected_host_not_supported");
        }
        return Object.freeze({
            host: state.selection.host,
            source: "local",
            supportedHosts: config.supportedHosts,
            selectionRevision: state.selection.revision,
            adopted: true,
        });
    }
    const host = config.defaultHost ??
        (config.supportedHosts.length === 1 ? config.supportedHosts[0] : undefined);
    if (!host)
        throw new Error("orchestrator_selection_required");
    return Object.freeze({
        host,
        source: config.defaultHost ? "default" : "sole-supported",
        supportedHosts: config.supportedHosts,
        selectionRevision: selectionRevision(config),
        adopted: true,
    });
}
//# sourceMappingURL=state.js.map