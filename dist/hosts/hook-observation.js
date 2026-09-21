import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWriteJson } from "../lib/atomic-write.js";
import { readActiveOrchestrator, readOrchestratorRepositoryConfig, resolveOrchestratorPaths, } from "../orchestration/selection.js";
import { exactObject, parseRevision, parseTimestamp, readBoundedJson, } from "../orchestration/state.js";
import { assetIssue, parseReceipt, sha256 } from "./asset-ownership.js";
export const NATIVE_HOST_HOOK_EVENTS = [
    "SessionStart",
    "SessionEnd",
    "UserPromptSubmit",
    "Stop",
];
const OBSERVATION_BYTES = 4 * 1024;
const HOOK_ASSET_PATHS = Object.freeze({
    claude: Object.freeze([".omc/hosts/claude/plugin/hooks/hooks.json"]),
    codex: Object.freeze([
        ".codex/hooks.json",
        ".omc/hosts/codex/plugin/hooks/hooks.json",
    ]),
});
export function isNativeHostHookEvent(value) {
    return NATIVE_HOST_HOOK_EVENTS.some((event) => event === value);
}
function hookDefinition(root, host) {
    const receipt = parseReceipt(root);
    const installed = receipt.hosts[host];
    if (!installed)
        return Object.freeze({ state: "missing" });
    const assets = HOOK_ASSET_PATHS[host].map((path) => installed.assets.find((asset) => asset.path === path));
    if (assets.some((asset) => asset === undefined)) {
        return Object.freeze({ state: "missing" });
    }
    const present = assets.filter((asset) => asset !== undefined);
    const digest = sha256(JSON.stringify(present.map((asset) => ({ path: asset.path, digest: asset.digest }))));
    const modified = present.some((asset) => assetIssue(root, asset));
    return Object.freeze({
        state: modified ? "modified" : "installed",
        digest,
    });
}
function observationPath(cwd, host) {
    const paths = resolveOrchestratorPaths(cwd);
    return join(dirname(paths.state), "hook-observations", `${host}.json`);
}
function digestField(value, error) {
    if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
        throw new Error(error);
    }
    return value;
}
function parseObservation(value) {
    const error = "host_hook_observation_invalid";
    const raw = exactObject(value, [
        "schemaVersion",
        "repositoryKey",
        "host",
        "event",
        "selectionRevision",
        "configDigest",
        "definitionDigest",
        "observedAt",
    ], error);
    if (raw.schemaVersion !== 1 ||
        (raw.host !== "claude" && raw.host !== "codex") ||
        typeof raw.event !== "string" ||
        !isNativeHostHookEvent(raw.event)) {
        throw new Error(error);
    }
    return Object.freeze({
        schemaVersion: 1,
        repositoryKey: digestField(raw.repositoryKey, error),
        host: raw.host,
        event: raw.event,
        selectionRevision: parseRevision(raw.selectionRevision, error),
        configDigest: digestField(raw.configDigest, error),
        definitionDigest: digestField(raw.definitionDigest, error),
        observedAt: parseTimestamp(raw.observedAt, error),
    });
}
function orchestratorConfigDigest(cwd) {
    return sha256(JSON.stringify(readOrchestratorRepositoryConfig(cwd)));
}
/** Snapshot the installed definition and configuration before the core gate runs. */
export function captureNativeHookObservationContext(cwd, host) {
    const paths = resolveOrchestratorPaths(cwd);
    const definition = hookDefinition(paths.repositoryRoot, host);
    if (definition.state !== "installed" || !definition.digest)
        return null;
    return Object.freeze({
        repositoryKey: paths.repositoryKey,
        configDigest: orchestratorConfigDigest(cwd),
        definitionDigest: definition.digest,
    });
}
/** Record advisory evidence only after the authoritative host hook gate accepts. */
export async function recordAcceptedHostHook(cwd, host, event, acceptedSelectionRevision, acceptedContext) {
    if (!acceptedContext)
        return;
    const paths = resolveOrchestratorPaths(cwd);
    const active = readActiveOrchestrator(cwd);
    const definition = hookDefinition(paths.repositoryRoot, host);
    if (paths.repositoryKey !== acceptedContext.repositoryKey ||
        active.host !== host ||
        active.selectionRevision !== acceptedSelectionRevision ||
        orchestratorConfigDigest(cwd) !== acceptedContext.configDigest ||
        definition.state !== "installed" ||
        definition.digest !== acceptedContext.definitionDigest) {
        return;
    }
    const observation = Object.freeze({
        schemaVersion: 1,
        repositoryKey: paths.repositoryKey,
        host,
        event,
        selectionRevision: acceptedSelectionRevision,
        configDigest: acceptedContext.configDigest,
        definitionDigest: acceptedContext.definitionDigest,
        observedAt: new Date().toISOString(),
    });
    await atomicWriteJson(observationPath(cwd, host), observation);
}
function hookGuidance(host, capability, definition, execution) {
    const guidance = [];
    if (definition !== "installed") {
        guidance.push("Run `omc setup --host both --scope project` to install or refresh the managed hook definition.");
    }
    if (capability === "cli-unavailable") {
        guidance.push(`Install ${host === "codex" ? "Codex" : "Claude Code"} and ensure its CLI version command succeeds.`);
    }
    else if (capability === "unsupported") {
        guidance.push("This CLI does not advertise native hook support; upgrade it when practical and rely on OMC's authoritative CLI gates meanwhile.");
    }
    else if (host === "codex") {
        guidance.push("Open this repository as a trusted Codex project, review new or changed definitions with `/hooks`, accept them in Codex, exercise a lifecycle event, then rerun `omc doctor hosts`.");
    }
    else {
        guidance.push("Start Claude through `omc launch` so the managed project plugin is loaded, exercise a lifecycle event, then rerun `omc doctor hosts`.");
    }
    if (execution === "observed") {
        guidance.push("Accepted execution was observed for the current selection and installed definition; this evidence is advisory, does not prove current native trust, and does not grant workflow authority.");
    }
    else if (execution === "stale" || execution === "malformed") {
        guidance.push("Existing execution evidence does not match the current repository, selection, or installed definition and is ignored.");
    }
    else if (execution === "unavailable") {
        guidance.push("Hook execution evidence is unavailable because the current orchestrator selection state could not be read. Run `omc orchestrator status`, resolve its reported state error, then rerun `omc doctor hosts`.");
    }
    return Object.freeze(guidance);
}
/** Read bounded advisory evidence without inspecting or modifying host trust stores. */
export function readNativeHookDiagnostics(cwd, host, capability) {
    const paths = resolveOrchestratorPaths(cwd);
    let active;
    try {
        active = readActiveOrchestrator(cwd);
    }
    catch {
        active = null;
    }
    const definition = hookDefinition(paths.repositoryRoot, host);
    const configDigest = orchestratorConfigDigest(cwd);
    const path = observationPath(cwd, host);
    let status = active ? "unobserved" : "unavailable";
    let record;
    if (active && existsSync(path)) {
        try {
            record = parseObservation(readBoundedJson(path, OBSERVATION_BYTES, "host_hook_observation_invalid"));
            status =
                definition.state === "installed" &&
                    definition.digest !== undefined &&
                    record.repositoryKey === paths.repositoryKey &&
                    record.host === host &&
                    active.host === host &&
                    record.selectionRevision === active.selectionRevision &&
                    record.configDigest === configDigest &&
                    record.definitionDigest === definition.digest
                    ? "observed"
                    : "stale";
        }
        catch {
            status = "malformed";
            record = undefined;
        }
    }
    const execution = Object.freeze({
        status,
        ...(status === "observed" && record
            ? {
                lastAcceptedEvent: record.event,
                observedAt: record.observedAt,
            }
            : {}),
    });
    return Object.freeze({
        capability,
        definition: definition.state,
        nativeTrust: "not-established",
        execution,
        advisory: true,
        guidance: hookGuidance(host, capability, definition.state, status),
    });
}
//# sourceMappingURL=hook-observation.js.map