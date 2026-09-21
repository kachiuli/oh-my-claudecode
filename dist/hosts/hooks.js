import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { assertOrchestratorSession, recordOrchestratorSession, resolveOrchestratorPaths, } from "../orchestration/selection.js";
import { captureNativeHookObservationContext, isNativeHostHookEvent, recordAcceptedHostHook, } from "./hook-observation.js";
function boundedField(value, maximum, error) {
    if (typeof value !== "string" ||
        value.length === 0 ||
        value.length > maximum ||
        value.includes("\0")) {
        throw new Error(error);
    }
    return value;
}
function hookWorkingDirectory(invocationCwd, payloadCwd) {
    const invocationRoot = resolveOrchestratorPaths(invocationCwd).repositoryRoot;
    let payloadRoot;
    try {
        const payloadDirectory = realpathSync(resolve(boundedField(payloadCwd, 4096, "orchestrator_invalid_hook_payload")));
        payloadRoot = resolveOrchestratorPaths(payloadDirectory).repositoryRoot;
    }
    catch {
        throw new Error("orchestrator_invalid_hook_payload");
    }
    if (payloadRoot !== invocationRoot) {
        throw new Error("orchestrator_hook_repository_mismatch");
    }
    return payloadRoot;
}
/** Translate the common Claude/Codex lifecycle payload into host session checks. */
export async function handleHostHook(invocationCwd, host, payloadInput) {
    if (host !== "claude" && host !== "codex") {
        throw new Error("orchestrator_invalid_host");
    }
    if (!payloadInput ||
        typeof payloadInput !== "object" ||
        Array.isArray(payloadInput)) {
        throw new Error("orchestrator_invalid_hook_payload");
    }
    const payload = payloadInput;
    const event = boundedField(payload.hook_event_name, 64, "orchestrator_invalid_hook_payload");
    if (!isNativeHostHookEvent(event)) {
        throw new Error(`orchestrator_unsupported_hook_event: ${event}`);
    }
    const sessionId = boundedField(payload.session_id, 256, "orchestrator_invalid_hook_payload");
    const cwd = hookWorkingDirectory(invocationCwd, payload.cwd);
    let observationContext = null;
    try {
        observationContext = captureNativeHookObservationContext(cwd, host);
    }
    catch {
        // Diagnostics are optional for legacy or partially installed host assets.
    }
    if (event === "SessionStart") {
        if (payload.source !== undefined &&
            !["startup", "resume", "clear", "compact"].includes(String(payload.source))) {
            throw new Error("orchestrator_invalid_hook_payload");
        }
        const acceptedSession = await recordOrchestratorSession(cwd, host, sessionId);
        try {
            await recordAcceptedHostHook(cwd, host, event, acceptedSession.selectionRevision, observationContext);
        }
        catch {
            // Execution observations are advisory and never weaken the core gate.
        }
        return Object.freeze({
            continue: true,
            suppressOutput: true,
            hookSpecificOutput: Object.freeze({
                hookEventName: "SessionStart",
                additionalContext: "OMC registered this native lead session. Shared workflow mutations remain protected by the repository operation gate and host lease.",
            }),
        });
    }
    const acceptedSession = assertOrchestratorSession(cwd, host, sessionId);
    try {
        await recordAcceptedHostHook(cwd, host, event, acceptedSession.selectionRevision, observationContext);
    }
    catch {
        // Legacy hooks and authoritative session checks remain usable without diagnostics.
    }
    return Object.freeze({ continue: true, suppressOutput: true });
}
//# sourceMappingURL=hooks.js.map