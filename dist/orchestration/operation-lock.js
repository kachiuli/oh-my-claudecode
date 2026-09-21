import { randomUUID } from "node:crypto";
import { closeSync, constants as fsConstants, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, unlinkSync, writeFileSync, } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { currentProcessStartIdentity, isProcessIdentityDead, isValidProcessStartIdentity, } from "../team/team-owner-epoch.js";
class RecoveryClaimRetentionRequired extends Error {
    constructor(message, cause) {
        super(message, cause === undefined ? undefined : { cause });
        this.name = "RecoveryClaimRetentionRequired";
    }
}
const LOCK_BYTES = 16 * 1024;
const PATH_CHARS = 4096;
let ownProcessStartIdentity;
export function cachedCurrentProcessStartIdentity() {
    if (ownProcessStartIdentity === undefined) {
        ownProcessStartIdentity = currentProcessStartIdentity();
    }
    return ownProcessStartIdentity;
}
function isUuid(value) {
    return (typeof value === "string" &&
        /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value));
}
function isTimestamp(value) {
    return (typeof value === "string" &&
        value.length <= 64 &&
        Number.isFinite(Date.parse(value)));
}
function isBoundedAbsolutePath(value) {
    return (typeof value === "string" &&
        value.length > 0 &&
        value.length <= PATH_CHARS &&
        !/[\0\r\n]/.test(value) &&
        isAbsolute(value));
}
function isRepositoryKey(value) {
    return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
function exactKeys(value, keys) {
    return (!!value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        Object.keys(value).every((key) => keys.includes(key)) &&
        keys.every((key) => key in value));
}
function parseOperationRecord(value) {
    const keys = [
        "schemaVersion",
        "kind",
        "pid",
        "processStartedAt",
        "nonce",
        "repositoryRoot",
        "repositoryKey",
        "stateRoot",
        "acquiredAt",
    ];
    if (!exactKeys(value, keys) ||
        value.schemaVersion !== 1 ||
        value.kind !== "orchestrator-operation" ||
        !Number.isSafeInteger(value.pid) ||
        Number(value.pid) <= 0 ||
        !(value.processStartedAt === null ||
            isValidProcessStartIdentity(value.processStartedAt)) ||
        !isUuid(value.nonce) ||
        !isBoundedAbsolutePath(value.repositoryRoot) ||
        !isRepositoryKey(value.repositoryKey) ||
        !isBoundedAbsolutePath(value.stateRoot) ||
        !isTimestamp(value.acquiredAt)) {
        throw new Error("orchestrator_operation_lock_unverifiable");
    }
    return value;
}
function parseRecoveryClaim(value) {
    const keys = [
        "schemaVersion",
        "kind",
        "pid",
        "processStartedAt",
        "nonce",
        "repositoryRoot",
        "repositoryKey",
        "stateRoot",
        "operationNonce",
        "acquiredAt",
    ];
    if (!exactKeys(value, keys) ||
        value.schemaVersion !== 1 ||
        value.kind !== "orchestrator-operation-recovery" ||
        !Number.isSafeInteger(value.pid) ||
        Number(value.pid) <= 0 ||
        !isValidProcessStartIdentity(value.processStartedAt) ||
        !isUuid(value.nonce) ||
        !isBoundedAbsolutePath(value.repositoryRoot) ||
        !isRepositoryKey(value.repositoryKey) ||
        !isBoundedAbsolutePath(value.stateRoot) ||
        !(value.operationNonce === null || isUuid(value.operationNonce)) ||
        !isTimestamp(value.acquiredAt)) {
        throw new Error("orchestrator_recovery_claim_unverifiable");
    }
    return value;
}
function readBoundedRecord(path, parse, missing) {
    let pathInfo;
    try {
        pathInfo = lstatSync(path);
    }
    catch (error) {
        if (error.code === "ENOENT" &&
            missing === "allow")
            return null;
        throw error;
    }
    if (!pathInfo.isFile() ||
        pathInfo.isSymbolicLink() ||
        pathInfo.size > LOCK_BYTES) {
        return parse({});
    }
    let fd;
    let bytes;
    let value;
    try {
        fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
        const opened = fstatSync(fd);
        if (!opened.isFile() ||
            opened.size > LOCK_BYTES ||
            opened.dev !== pathInfo.dev ||
            opened.ino !== pathInfo.ino) {
            return parse({});
        }
        const buffer = Buffer.alloc(LOCK_BYTES + 1);
        let offset = 0;
        while (offset < buffer.length) {
            const count = readSync(fd, buffer, offset, buffer.length - offset, null);
            if (count === 0)
                break;
            offset += count;
        }
        if (offset > LOCK_BYTES)
            return parse({});
        bytes = buffer.toString("utf8", 0, offset);
        const afterRead = fstatSync(fd);
        const afterPathRead = lstatSync(path);
        if (afterRead.dev !== opened.dev ||
            afterRead.ino !== opened.ino ||
            afterRead.size !== opened.size ||
            afterRead.mtimeMs !== opened.mtimeMs ||
            afterPathRead.isSymbolicLink() ||
            afterPathRead.dev !== opened.dev ||
            afterPathRead.ino !== opened.ino) {
            return parse({});
        }
        value = JSON.parse(bytes);
    }
    catch {
        return parse({});
    }
    finally {
        if (fd !== undefined)
            closeSync(fd);
    }
    return Object.freeze({ record: parse(value), bytes });
}
function stateRoot(paths) {
    mkdirSync(dirname(paths.operationLock), { recursive: true, mode: 0o700 });
    return realpathSync(dirname(paths.operationLock));
}
function assertRecordBinding(paths, record) {
    if (record.repositoryRoot !== paths.repositoryRoot ||
        record.repositoryKey !== paths.repositoryKey ||
        record.stateRoot !== stateRoot(paths)) {
        throw new Error("orchestrator_operation_lock_foreign");
    }
}
function writeLinkedRecord(path, nonce, bytes) {
    const tempPath = `${path}.${nonce}.tmp`;
    writeFileSync(tempPath, bytes, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
        flush: true,
    });
    try {
        linkSync(tempPath, path);
    }
    finally {
        try {
            unlinkSync(tempPath);
        }
        catch {
            // A unique temporary name can only already be absent after external cleanup.
        }
    }
}
function recoveryClaimPath(operationLock) {
    return `${operationLock}.recovery`;
}
function pathEntryExists(path) {
    try {
        lstatSync(path);
        return true;
    }
    catch (error) {
        if (error.code === "ENOENT")
            return false;
        return true;
    }
}
function recoveryInProgress(operationLock) {
    return pathEntryExists(recoveryClaimPath(operationLock));
}
function restoreCapturedPath(path, capturedPath) {
    try {
        linkSync(capturedPath, path);
        unlinkSync(capturedPath);
        return true;
    }
    catch {
        return false;
    }
}
function releaseOwnedPath(path, owned, parse) {
    const current = readBoundedRecord(path, parse, "allow");
    if (!current ||
        current.record.nonce !== owned.record.nonce ||
        current.bytes !== owned.bytes) {
        return false;
    }
    const capturedPath = `${path}.${owned.record.nonce}.${randomUUID()}.release`;
    try {
        renameSync(path, capturedPath);
    }
    catch {
        return false;
    }
    let captured;
    try {
        captured = readBoundedRecord(capturedPath, parse, "reject");
    }
    catch {
        if (!restoreCapturedPath(path, capturedPath)) {
            throw new Error("orchestrator_lock_release_rollback_failed");
        }
        return false;
    }
    if (!captured ||
        captured.record.nonce !== owned.record.nonce ||
        captured.bytes !== owned.bytes) {
        if (!restoreCapturedPath(path, capturedPath)) {
            throw new Error("orchestrator_lock_release_rollback_failed");
        }
        return false;
    }
    unlinkSync(capturedPath);
    return true;
}
export function tryAcquireOrchestratorOperationLock(paths, processStartedAt = cachedCurrentProcessStartIdentity()) {
    const sharedStateRoot = stateRoot(paths);
    if (recoveryInProgress(paths.operationLock))
        return null;
    const record = Object.freeze({
        schemaVersion: 1,
        kind: "orchestrator-operation",
        pid: process.pid,
        processStartedAt,
        nonce: randomUUID(),
        repositoryRoot: paths.repositoryRoot,
        repositoryKey: paths.repositoryKey,
        stateRoot: sharedStateRoot,
        acquiredAt: new Date().toISOString(),
    });
    const bytes = JSON.stringify(record);
    try {
        writeLinkedRecord(paths.operationLock, record.nonce, bytes);
    }
    catch (error) {
        if (error.code === "EEXIST")
            return null;
        throw error;
    }
    if (recoveryInProgress(paths.operationLock)) {
        if (!releaseOwnedPath(paths.operationLock, { record, bytes }, parseOperationRecord)) {
            throw new Error("orchestrator_operation_lock_ownership_lost");
        }
        return null;
    }
    return Object.freeze({ path: paths.operationLock, record, bytes });
}
export function releaseOrchestratorOperationLock(handle) {
    if (!releaseOwnedPath(handle.path, { record: handle.record, bytes: handle.bytes }, parseOperationRecord)) {
        throw new Error("orchestrator_operation_lock_ownership_lost");
    }
}
function readOperationLock(path) {
    return readBoundedRecord(path, parseOperationRecord, "allow");
}
function assertRecoverableOwner(paths, observation) {
    assertRecordBinding(paths, observation.record);
    if (observation.record.processStartedAt === null ||
        !isProcessIdentityDead({
            pid: observation.record.pid,
            process_started_at: observation.record.processStartedAt,
        })) {
        throw new Error("orchestrator_operation_owner_not_confirmed_dead");
    }
}
function acquireRecoveryClaim(paths, operationNonce) {
    const processStartedAt = cachedCurrentProcessStartIdentity();
    if (!isValidProcessStartIdentity(processStartedAt)) {
        throw new Error("orchestrator_recovery_identity_unavailable");
    }
    const path = recoveryClaimPath(paths.operationLock);
    if (pathEntryExists(path)) {
        readBoundedRecord(path, parseRecoveryClaim, "reject");
        throw new Error("orchestrator_recovery_claim_locked");
    }
    const claim = Object.freeze({
        schemaVersion: 1,
        kind: "orchestrator-operation-recovery",
        pid: process.pid,
        processStartedAt,
        nonce: randomUUID(),
        repositoryRoot: paths.repositoryRoot,
        repositoryKey: paths.repositoryKey,
        stateRoot: stateRoot(paths),
        operationNonce,
        acquiredAt: new Date().toISOString(),
    });
    const bytes = JSON.stringify(claim);
    try {
        writeLinkedRecord(path, claim.nonce, bytes);
    }
    catch (error) {
        if (error.code === "EEXIST") {
            throw new Error("orchestrator_recovery_claim_locked");
        }
        throw error;
    }
    return claim;
}
function releaseRecoveryClaim(operationLock, claim) {
    const bytes = JSON.stringify(claim);
    if (!releaseOwnedPath(recoveryClaimPath(operationLock), { record: claim, bytes }, parseRecoveryClaim)) {
        throw new Error("orchestrator_recovery_claim_ownership_lost");
    }
}
function captureRecoveredOperationLock(path, expected) {
    const current = readOperationLock(path);
    if (!current ||
        current.record.nonce !== expected.record.nonce ||
        current.bytes !== expected.bytes) {
        throw new Error("orchestrator_operation_lock_changed");
    }
    const retiredPath = `${path}.${expected.record.nonce}.recovered`;
    try {
        linkSync(path, retiredPath);
    }
    catch {
        throw new Error("orchestrator_operation_lock_changed");
    }
    try {
        const retired = readOperationLock(retiredPath);
        const held = readOperationLock(path);
        if (!retired ||
            retired.record.nonce !== expected.record.nonce ||
            retired.bytes !== expected.bytes ||
            !held ||
            held.record.nonce !== expected.record.nonce ||
            held.bytes !== expected.bytes) {
            throw new Error("orchestrator_operation_lock_changed");
        }
        unlinkSync(path);
        if (pathEntryExists(path)) {
            throw new RecoveryClaimRetentionRequired("orchestrator_operation_lock_rollback_failed");
        }
        return retiredPath;
    }
    catch (error) {
        if (error instanceof RecoveryClaimRetentionRequired)
            throw error;
        if (!pathEntryExists(path)) {
            if (!restoreCapturedPath(path, retiredPath)) {
                throw new RecoveryClaimRetentionRequired("orchestrator_operation_lock_rollback_failed", error);
            }
        }
        else {
            let released = false;
            try {
                released = releaseOwnedPath(retiredPath, expected, parseOperationRecord);
            }
            catch (cleanupError) {
                throw new RecoveryClaimRetentionRequired("orchestrator_operation_lock_rollback_failed", cleanupError);
            }
            if (!released) {
                throw new RecoveryClaimRetentionRequired("orchestrator_operation_lock_rollback_failed", error);
            }
        }
        throw new Error("orchestrator_operation_lock_changed", { cause: error });
    }
}
function restoreCapturedOperationLock(path, capturedPath, expected) {
    const captured = readOperationLock(capturedPath);
    if (!captured ||
        captured.record.nonce !== expected.record.nonce ||
        captured.bytes !== expected.bytes ||
        !restoreCapturedPath(path, capturedPath)) {
        throw new Error("orchestrator_operation_lock_rollback_failed");
    }
}
function discardCapturedOperationLock(capturedPath, expected) {
    if (!releaseOwnedPath(capturedPath, expected, parseOperationRecord)) {
        throw new Error("orchestrator_operation_lock_cleanup_failed");
    }
}
/*
 * The recovery claim excludes cooperating lock acquirers while the abandoned
 * record is captured. A failed exact capture retains both evidence generations
 * and the claim rather than guessing which pathname is authoritative.
 */
function captureOrRetainRecoveryClaim(path, expected) {
    try {
        return captureRecoveredOperationLock(path, expected);
    }
    catch (error) {
        if (error instanceof RecoveryClaimRetentionRequired)
            throw error;
        if (pathEntryExists(`${path}.${expected.record.nonce}.recovered`)) {
            throw new RecoveryClaimRetentionRequired("orchestrator_operation_lock_rollback_failed", error);
        }
        throw error;
    }
}
export async function withExplicitOrchestratorOperationRecovery(paths, preflight, action) {
    const initial = readOperationLock(paths.operationLock);
    if (initial)
        assertRecoverableOwner(paths, initial);
    const claim = acquireRecoveryClaim(paths, initial?.record.nonce ?? null);
    let releaseClaim = true;
    try {
        const held = readOperationLock(paths.operationLock);
        if (initial) {
            if (!held ||
                held.record.nonce !== initial.record.nonce ||
                held.bytes !== initial.bytes) {
                throw new Error("orchestrator_operation_lock_changed");
            }
            assertRecoverableOwner(paths, held);
        }
        else if (held) {
            throw new Error("orchestrator_operation_locked");
        }
        const abandoned = held?.record ?? null;
        await preflight(abandoned);
        let capturedPath = null;
        try {
            capturedPath = held
                ? captureOrRetainRecoveryClaim(paths.operationLock, held)
                : null;
        }
        catch (error) {
            if (error instanceof RecoveryClaimRetentionRequired)
                releaseClaim = false;
            throw error;
        }
        let value;
        try {
            value = await action(abandoned);
        }
        catch (error) {
            if (capturedPath) {
                try {
                    restoreCapturedOperationLock(paths.operationLock, capturedPath, held);
                }
                catch {
                    releaseClaim = false;
                    throw new Error("orchestrator_operation_lock_rollback_failed", {
                        cause: error,
                    });
                }
            }
            throw error;
        }
        if (capturedPath) {
            try {
                discardCapturedOperationLock(capturedPath, held);
            }
            catch (error) {
                releaseClaim = false;
                throw error;
            }
        }
        return Object.freeze({ value, recoveredOperationLock: held !== null });
    }
    finally {
        if (releaseClaim)
            releaseRecoveryClaim(paths.operationLock, claim);
    }
}
//# sourceMappingURL=operation-lock.js.map