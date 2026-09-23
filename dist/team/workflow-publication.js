import { createHash, randomBytes, randomUUID, timingSafeEqual, } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync, writeSync, } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseWorkflowHandoff, parseWorkflowState, safeWorkflowId, } from "./workflow-contracts.js";
import { atomicWriteJson, validateResolvedPath } from "./fs-utils.js";
import { teamStateRoot } from "./state-paths.js";
import { redactWorkflowText, WORKFLOW_PUBLICATION_ENV, } from "./workflow-process.js";
const MAX_RESULT_BYTES = 64 * 1024;
const MAX_CAPABILITY_BYTES = 16 * 1024;
const MAX_WORKFLOW_BYTES = 16 * 1024 * 1024;
const SHELL_PUBLICATION_TRAMPOLINE = "const i=JSON.parse(Buffer.from(process.argv[1],'base64url'));require('node:child_process').execFileSync(i.command,i.args,{stdio:'inherit',shell:false})";
function workflowHelperResultPath(taskId, resultFile) {
    return `.omc-workflow-handoff-${createHash("sha256")
        .update(`${taskId}\0${resultFile}`)
        .digest("hex")
        .slice(0, 16)}.json`;
}
function currentCliEntrypoint() {
    try {
        const entrypoint = realpathSync(resolve(process.argv[1] ?? ""));
        const name = basename(entrypoint).toLowerCase();
        const parent = basename(dirname(entrypoint)).toLowerCase();
        if ((name === "cli.cjs" && parent === "bridge") ||
            (name === "oh-my-claudecode.js" && parent === "bin")) {
            return entrypoint;
        }
    }
    catch {
        /* Unknown launchers retain the installed omc argv contract without a shell fallback. */
    }
    return undefined;
}
function publicationCommand(taskId, resultFile, helperResult) {
    const entrypoint = currentCliEntrypoint();
    const command = entrypoint ? process.execPath : "omc";
    const args = [
        ...(entrypoint ? [entrypoint] : []),
        "team",
        "workflow",
        "publish-result",
        "--source",
        helperResult,
        "--result-file",
        resultFile,
        "--task-id",
        taskId,
    ];
    const sourceArgumentIndex = (entrypoint ? 1 : 0) + 4;
    const publishInvocation = Object.freeze({
        command,
        args: Object.freeze(args),
        sourceArgumentIndex,
    });
    const publishCommand = entrypoint
        ? `node -e "${SHELL_PUBLICATION_TRAMPOLINE}" "${Buffer.from(JSON.stringify({ command, args })).toString("base64url")}"`
        : null;
    return {
        publishInvocation,
        publishCommand,
        publishCommandTransport: entrypoint ? "base64url-node-exec-file" : null,
        publishCommandShells: entrypoint
            ? Object.freeze(["bash", "powershell", "cmd"])
            : null,
    };
}
/** Worker-facing publication contract. The command is portable across supported OMC installations. */
export function workflowPublicationContract(taskId, resultFile) {
    const helperResult = workflowHelperResultPath(taskId, resultFile);
    const command = publicationCommand(taskId, resultFile, helperResult);
    return {
        canonicalTask: Object.freeze({ source: "dispatch.task", taskId }),
        helperResult: Object.freeze({
            purpose: "optional-local-validation",
            path: helperResult,
            authorization: "create-this-file-only",
            overwrite: false,
            publishVerifiedBytesUnchanged: true,
        }),
        designatedResult: Object.freeze({
            path: resultFile,
            authorization: "create-this-file-only",
            overwrite: false,
            stdoutIsHandoff: false,
        }),
        ...command,
        finalization: Object.freeze([
            "Pass only dispatch.task to helpers that expect the canonical task; the full dispatch envelope is not a WorkflowTask.",
            "After committing task work, exclusively create helperResult.path in the worker worktree; never overwrite an existing helper file.",
            "Validate helperResult.path against the handoff schema and this canonical taskId.",
            "Prefer executing publishInvocation.command with publishInvocation.args as an argument array. A shell-only worker may run publishCommand unchanged when it is present; never interpolate paths into it, and stop when it is null.",
            "Publish the already verified bytes exclusively to designatedResult.path; never overwrite an existing result file.",
            "Re-read the destination and confirm byte equality, JSON parsing, handoff schema, and canonical taskId.",
            "The publisher removes helperResult.path only after destination verification succeeds; do not remove it yourself.",
            "The destination can remain if publication fails after writing it; do not alter any remaining destination or helper artifact, and stop for diagnosis.",
            "End the provider response only after the exact designated result exists and all destination checks pass.",
        ]),
    };
}
function canonicalParent(path, expectedParent) {
    const parent = dirname(path);
    const canonical = expectedParent ?? realpathSync(parent);
    if (lstatSync(parent).isSymbolicLink() || realpathSync(parent) !== canonical)
        throw new Error("workflow_artifact_parent_changed");
    validateResolvedPath(path, canonical);
    return canonical;
}
function regularBytes(path, maximum, expectedParent) {
    canonicalParent(path, expectedParent);
    if (!existsSync(path))
        throw new Error("workflow_designated_result_missing");
    const info = lstatSync(path);
    if (info.isSymbolicLink())
        throw new Error("workflow_result_symlink_rejected");
    if (!info.isFile() || info.nlink !== 1)
        throw new Error("workflow_result_not_regular_file");
    if (info.size > maximum)
        throw new Error("workflow_artifact_invalid_or_oversized");
    const bytes = readFileSync(path);
    if (bytes.length > maximum)
        throw new Error("workflow_artifact_invalid_or_oversized");
    return bytes;
}
function regularResultBytes(path, expectedParent) {
    return regularBytes(path, MAX_RESULT_BYTES, expectedParent);
}
function sameFileIdentity(info, identity) {
    return info.dev === identity.dev && info.ino === identity.ino;
}
function readAuthorizedHelper(path, expectedParent) {
    canonicalParent(path, expectedParent);
    if (!existsSync(path))
        throw new Error("workflow_designated_result_missing");
    const initial = lstatSync(path);
    if (initial.isSymbolicLink())
        throw new Error("workflow_result_symlink_rejected");
    if (!initial.isFile() || initial.nlink !== 1)
        throw new Error("workflow_result_not_regular_file");
    if (initial.size > MAX_RESULT_BYTES)
        throw new Error("workflow_artifact_invalid_or_oversized");
    const identity = Object.freeze({ dev: initial.dev, ino: initial.ino });
    const descriptor = openSync(path, constants.O_RDONLY);
    try {
        const opened = fstatSync(descriptor);
        if (!opened.isFile() ||
            opened.nlink !== 1 ||
            opened.size > MAX_RESULT_BYTES ||
            !sameFileIdentity(opened, identity)) {
            throw new Error("workflow_helper_identity_changed");
        }
        const bytes = readFileSync(descriptor);
        const finalDescriptor = fstatSync(descriptor);
        const finalPath = lstatSync(path);
        if (bytes.length > MAX_RESULT_BYTES ||
            !finalDescriptor.isFile() ||
            finalDescriptor.nlink !== 1 ||
            finalPath.isSymbolicLink() ||
            !finalPath.isFile() ||
            finalPath.nlink !== 1 ||
            !sameFileIdentity(finalDescriptor, identity) ||
            !sameFileIdentity(finalPath, identity)) {
            throw new Error("workflow_helper_identity_changed");
        }
        return { bytes, identity };
    }
    finally {
        closeSync(descriptor);
    }
}
function removeAuthorizedHelper(path, identity) {
    const info = lstatSync(path);
    if (info.isSymbolicLink() ||
        !info.isFile() ||
        info.nlink !== 1 ||
        !sameFileIdentity(info, identity)) {
        throw new Error("workflow_helper_identity_changed");
    }
    unlinkSync(path);
}
function exactRecord(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("workflow_publication_not_authorized");
    const record = value;
    const keys = [
        "schemaVersion",
        "id",
        "tokenHash",
        "workflowName",
        "taskId",
        "worker",
        "attempt",
        "workflowRoot",
        "stateRoot",
        "worktree",
        "helperResultFile",
        "resultFile",
    ];
    if (Object.keys(record).length !== keys.length ||
        Object.keys(record).some((key) => !keys.includes(key)) ||
        record.schemaVersion !== 2 ||
        typeof record.id !== "string" ||
        typeof record.tokenHash !== "string" ||
        typeof record.workflowName !== "string" ||
        typeof record.taskId !== "string" ||
        typeof record.worker !== "string" ||
        !Number.isSafeInteger(record.attempt) ||
        typeof record.workflowRoot !== "string" ||
        typeof record.stateRoot !== "string" ||
        typeof record.worktree !== "string" ||
        typeof record.helperResultFile !== "string" ||
        typeof record.resultFile !== "string")
        throw new Error("workflow_publication_not_authorized");
    return record;
}
function capabilityPath(stateRoot, id) {
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id))
        throw new Error("workflow_publication_not_authorized");
    const artifacts = join(stateRoot, "artifacts");
    validateResolvedPath(artifacts, stateRoot);
    return { artifacts, capability: join(artifacts, `.publication-${id}.json`) };
}
function tokenMatches(token, hash) {
    if (!/^[a-f0-9]{64}$/.test(token) || !/^[a-f0-9]{64}$/.test(hash))
        return false;
    const actual = createHash("sha256").update(token).digest();
    return timingSafeEqual(actual, Buffer.from(hash, "hex"));
}
/** Issue one exact task/attempt publication capability; only its hash enters controller state. */
export function issueWorkflowPublication(input) {
    const workflowRoot = realpathSync(input.workflowRoot);
    const worktree = realpathSync(input.worktree);
    const workflowName = safeWorkflowId(input.workflowName);
    const taskId = safeWorkflowId(input.taskId);
    if (!/^task-[a-z0-9][a-z0-9-]*$/.test(input.worker) ||
        !Number.isSafeInteger(input.attempt) ||
        input.attempt < 1 ||
        input.attempt > 5) {
        throw new Error("workflow_invalid_publication_authority");
    }
    const id = randomUUID();
    const stateRoot = realpathSync(teamStateRoot(workflowRoot, workflowName));
    const { artifacts, capability } = capabilityPath(stateRoot, id);
    const canonicalArtifacts = realpathSync(artifacts);
    const resultFile = resolve(input.resultFile);
    const expectedResult = resolve(canonicalArtifacts, `${input.worker}-${input.attempt}.result.json`);
    if (resultFile !== expectedResult ||
        realpathSync(dirname(resultFile)) !== canonicalArtifacts) {
        throw new Error("workflow_invalid_publication_authority");
    }
    const token = randomBytes(32).toString("hex");
    const helperResultFile = resolve(worktree, workflowHelperResultPath(taskId, resultFile));
    if (dirname(helperResultFile) !== worktree)
        throw new Error("workflow_invalid_publication_authority");
    const record = {
        schemaVersion: 2,
        id,
        tokenHash: createHash("sha256").update(token).digest("hex"),
        workflowName,
        taskId,
        worker: input.worker,
        attempt: input.attempt,
        workflowRoot,
        stateRoot,
        worktree,
        helperResultFile,
        resultFile,
    };
    writeFileSync(capability, `${JSON.stringify(record)}\n`, {
        flag: "wx",
        mode: 0o600,
    });
    let revoked = false;
    return Object.freeze({
        environment: Object.freeze({
            [WORKFLOW_PUBLICATION_ENV.capabilityId]: id,
            [WORKFLOW_PUBLICATION_ENV.capabilityToken]: token,
            [WORKFLOW_PUBLICATION_ENV.workflowRoot]: workflowRoot,
            [WORKFLOW_PUBLICATION_ENV.workflowName]: workflowName,
            [WORKFLOW_PUBLICATION_ENV.stateRoot]: stateRoot,
        }),
        revoke() {
            if (revoked)
                return;
            revoked = true;
            try {
                unlinkSync(capability);
            }
            catch (error) {
                if (error.code !== "ENOENT")
                    throw error;
            }
        },
    });
}
function authorizePublication(sourceFile, resultFile, taskId, context) {
    const environment = context.environment ?? process.env;
    const id = environment[WORKFLOW_PUBLICATION_ENV.capabilityId];
    const token = environment[WORKFLOW_PUBLICATION_ENV.capabilityToken];
    const rootInput = environment[WORKFLOW_PUBLICATION_ENV.workflowRoot];
    const nameInput = environment[WORKFLOW_PUBLICATION_ENV.workflowName];
    const stateRootInput = environment[WORKFLOW_PUBLICATION_ENV.stateRoot];
    if (!id || !token || !rootInput || !nameInput || !stateRootInput)
        throw new Error("workflow_publication_not_authorized");
    let workflowRoot;
    let stateRoot;
    let cwd;
    try {
        workflowRoot = realpathSync(rootInput);
        stateRoot = realpathSync(stateRootInput);
        cwd = realpathSync(context.cwd);
    }
    catch {
        throw new Error("workflow_publication_not_authorized");
    }
    const workflowName = safeWorkflowId(nameInput);
    const { artifacts, capability } = capabilityPath(stateRoot, id);
    let record;
    try {
        record = exactRecord(JSON.parse(regularBytes(capability, MAX_CAPABILITY_BYTES, realpathSync(artifacts)).toString("utf8")));
    }
    catch {
        throw new Error("workflow_publication_not_authorized");
    }
    if (!tokenMatches(token, record.tokenHash) ||
        record.id !== id ||
        record.workflowName !== workflowName ||
        record.workflowRoot !== workflowRoot ||
        record.stateRoot !== stateRoot ||
        record.taskId !== taskId ||
        resolve(record.resultFile) !== resolve(resultFile) ||
        environment.OMC_TEAM_WORKER !== record.worker ||
        !environment.OMC_TEAM_WORKTREE_PATH) {
        throw new Error("workflow_publication_not_authorized");
    }
    let environmentWorktree;
    let recordWorktree;
    try {
        environmentWorktree = realpathSync(environment.OMC_TEAM_WORKTREE_PATH);
        recordWorktree = realpathSync(record.worktree);
    }
    catch {
        throw new Error("workflow_publication_not_authorized");
    }
    if (cwd !== recordWorktree || environmentWorktree !== recordWorktree)
        throw new Error("workflow_publication_not_authorized");
    const expectedHelperResult = resolve(recordWorktree, workflowHelperResultPath(taskId, record.resultFile));
    if (resolve(sourceFile) !== record.helperResultFile ||
        record.helperResultFile !== expectedHelperResult ||
        dirname(record.helperResultFile) !== recordWorktree) {
        throw new Error("workflow_publication_not_authorized");
    }
    const stateFile = join(stateRoot, "workflow.json");
    let state;
    try {
        state = parseWorkflowState(JSON.parse(regularBytes(stateFile, MAX_WORKFLOW_BYTES, dirname(stateFile)).toString("utf8")));
    }
    catch {
        throw new Error("workflow_publication_not_authorized");
    }
    const entry = state.tasks.find((candidate) => candidate.task.id === taskId);
    const invocation = entry?.invocations?.at(-1);
    let stateCwd;
    let stateWorktree;
    try {
        stateCwd = realpathSync(state.cwd);
        stateWorktree = realpathSync(entry?.worktree ?? "");
    }
    catch {
        throw new Error("workflow_publication_not_authorized");
    }
    const expectedResult = resolve(artifacts, `${record.worker}-${record.attempt}.result.json`);
    if (stateCwd !== workflowRoot ||
        state.plan.name !== workflowName ||
        !entry ||
        entry.worker !== record.worker ||
        entry.status !== "running" ||
        entry.attempts !== record.attempt ||
        invocation?.attempt !== record.attempt ||
        invocation.error !== "workflow_invocation_incomplete" ||
        stateWorktree !== recordWorktree ||
        resolve(resultFile) !== expectedResult)
        throw new Error("workflow_publication_not_authorized");
    return {
        capability,
        helperResultFile: record.helperResultFile,
        worktree: recordWorktree,
    };
}
function parseResultBytes(bytes, taskId) {
    let parsed;
    try {
        parsed = JSON.parse(bytes.toString("utf8"));
    }
    catch {
        throw new Error("workflow_invalid_result");
    }
    return parseWorkflowHandoff(parsed, taskId);
}
/**
 * Publish a helper-verified handoff without changing its bytes. This is the only worker-authorized
 * write inside controller state, and exclusive creation preserves any pre-existing evidence.
 */
export function publishWorkflowResultArtifact(sourceFile, resultFile, taskId, context) {
    taskId = safeWorkflowId(taskId);
    const authority = authorizePublication(sourceFile, resultFile, taskId, context);
    const helper = readAuthorizedHelper(authority.helperResultFile, authority.worktree);
    const source = helper.bytes;
    parseResultBytes(source, taskId);
    canonicalParent(resultFile, dirname(authority.capability));
    if (existsSync(resultFile))
        throw new Error("workflow_result_already_exists");
    let descriptor;
    try {
        descriptor = openSync(resultFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
        let offset = 0;
        while (offset < source.length)
            offset += writeSync(descriptor, source, offset, source.length - offset);
        fsyncSync(descriptor);
    }
    catch (error) {
        if (error.code === "EEXIST")
            throw new Error("workflow_result_already_exists");
        throw error;
    }
    finally {
        if (descriptor !== undefined)
            closeSync(descriptor);
    }
    const published = regularResultBytes(resultFile);
    if (!published.equals(source))
        throw new Error("workflow_result_publication_mismatch");
    parseResultBytes(published, taskId);
    // Later errors retain the destination and capability; a failed helper unlink retains the helper too.
    removeAuthorizedHelper(authority.helperResultFile, helper.identity);
    try {
        unlinkSync(authority.capability);
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
    }
    return {
        sizeBytes: published.length,
        sha256: createHash("sha256").update(published).digest("hex"),
    };
}
/** Read the exact designated artifact. Valid safe bytes survive normal controller validation unchanged. */
export function readWorkflowResultArtifact(resultFile, expectedParent, taskId, environment) {
    const parsed = readWorkflowJsonArtifact(resultFile, expectedParent, environment);
    try {
        return {
            value: parseWorkflowHandoff(parsed.value, taskId),
            artifactPath: parsed.artifactPath,
        };
    }
    catch (error) {
        atomicWriteJson(resultFile, { error: "workflow_invalid_result" });
        throw error;
    }
}
/** Generic bounded result reader used by the existing reviewer transports. */
export function readWorkflowJsonArtifact(resultFile, expectedParent, environment) {
    let bytes;
    try {
        bytes = regularResultBytes(resultFile, expectedParent);
    }
    catch (error) {
        if (error.code === "ENOENT")
            throw new Error("workflow_designated_result_missing");
        if (error instanceof Error &&
            error.message === "workflow_artifact_invalid_or_oversized") {
            // An oversized regular single-link result is controller-owned evidence and can be safely replaced.
            try {
                const info = lstatSync(resultFile);
                if (info.isFile() && !info.isSymbolicLink() && info.nlink === 1)
                    atomicWriteJson(resultFile, { error: "workflow_invalid_result" });
            }
            catch {
                /* Preserve the original refusal when safe replacement cannot be proven. */
            }
        }
        throw error;
    }
    const text = bytes.toString("utf8");
    let value;
    try {
        value = JSON.parse(text);
    }
    catch {
        if (redactWorkflowText(text, false, environment) !== text) {
            atomicWriteJson(resultFile, {
                error: "workflow_sensitive_result_rejected",
            });
            throw new Error("workflow_sensitive_result_rejected");
        }
        atomicWriteJson(resultFile, { error: "workflow_invalid_result" });
        throw new Error("workflow_invalid_result");
    }
    const normalized = JSON.stringify(value);
    const redacted = redactWorkflowText(normalized, false, environment);
    if (redacted !== normalized) {
        // Preserve normal verified bytes. When credentials require redaction, publish a separate safe
        // artifact and quarantine the unsafe designated bytes instead of silently treating them as exact.
        try {
            value = JSON.parse(redacted);
        }
        catch {
            atomicWriteJson(resultFile, {
                error: "workflow_sensitive_result_rejected",
            });
            throw new Error("workflow_sensitive_result_rejected");
        }
        // Quarantine raw credential-bearing bytes before any later publication step can fail.
        atomicWriteJson(resultFile, {
            error: "workflow_sensitive_result_quarantined",
        });
        const artifactPath = `${resultFile}.sanitized-${randomUUID()}.json`;
        canonicalParent(artifactPath, expectedParent);
        try {
            writeFileSync(artifactPath, redacted, { flag: "wx", mode: 0o600 });
        }
        catch {
            throw new Error("workflow_artifact_write_refused");
        }
        if (readFileSync(artifactPath, "utf8") !== redacted)
            throw new Error("workflow_result_publication_mismatch");
        return { value, artifactPath };
    }
    return { value, artifactPath: resultFile };
}
/** Native Claude reviewer output is controller-published and remains distinct from worker publication. */
export function publishNativeClaudeResult(resultFile, value, environment) {
    canonicalParent(resultFile);
    try {
        const content = redactWorkflowText(JSON.stringify(value), false, environment);
        const descriptor = openSync(resultFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
        try {
            let offset = 0;
            const bytes = Buffer.from(content);
            while (offset < bytes.length)
                offset += writeSync(descriptor, bytes, offset, bytes.length - offset);
            fsyncSync(descriptor);
        }
        finally {
            closeSync(descriptor);
        }
    }
    catch (error) {
        if (error.code === "EEXIST")
            throw new Error("workflow_result_already_exists");
        throw error;
    }
}
//# sourceMappingURL=workflow-publication.js.map