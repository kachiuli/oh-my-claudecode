import { lstatSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { getOmcRoot } from "../lib/worktree-paths.js";
import { isProcessAlive } from "../platform/index.js";
import { validateLegacyTeamConfig, validateRevisionedTeamConfig, } from "../team/monitor.js";
import { isProcessIdentityDead, isValidProcessStartIdentity, } from "../team/team-owner-epoch.js";
import { classifyOrphanedAttempt } from "../team/workflow-orphan.js";
import { readBoundedJson, readRuntimeStateFile, repositoryRoot, } from "./state.js";
const WORKFLOW_BYTES = 16 * 1024 * 1024;
const SMALL_STATE_BYTES = 16 * 1024;
const TEAM_CONFIG_BYTES = 1024 * 1024;
const MAX_QUIESCENCE_ENTRIES = 4096;
function lstatIfPresent(path) {
    try {
        return lstatSync(path);
    }
    catch (error) {
        if (error.code === "ENOENT")
            return null;
        throw new Error("orchestrator_quiescence_unverified");
    }
}
function walkQuiescenceTree(directory, visit, budget) {
    const rootInfo = lstatIfPresent(directory);
    if (!rootInfo)
        return;
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
        throw new Error("orchestrator_quiescence_unverified");
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        budget.remaining--;
        if (budget.remaining < 0)
            throw new Error("orchestrator_quiescence_scan_overflow");
        const path = join(directory, entry.name);
        if (entry.isSymbolicLink())
            throw new Error("orchestrator_quiescence_unverified");
        if (entry.isDirectory())
            walkQuiescenceTree(path, visit, budget);
        else if (entry.isFile())
            visit(path);
    }
}
function assertWorkflowFileQuiescent(path, orphaned) {
    const raw = readBoundedJson(path, WORKFLOW_BYTES, "orchestrator_quiescence_unverified");
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
        throw new Error("orchestrator_quiescence_unverified");
    const tasks = raw.tasks;
    if (!Array.isArray(tasks))
        throw new Error("orchestrator_quiescence_unverified");
    const workflowName = raw.plan?.name;
    const statuses = new Set([
        "pending",
        "running",
        "completed",
        "failed",
        "accepted",
        "rejected",
    ]);
    for (const task of tasks) {
        if (!task || typeof task !== "object" || Array.isArray(task)) {
            throw new Error("orchestrator_quiescence_unverified");
        }
        const status = task.status;
        if (typeof status !== "string" || !statuses.has(status)) {
            throw new Error("orchestrator_quiescence_unverified");
        }
        if (status !== "running")
            continue;
        if (!orphaned)
            throw new Error("orchestrator_active_attempt");
        const outcome = classifyOrphanedAttempt(task);
        if (outcome === "provider-alive")
            throw new Error("orchestrator_active_provider");
        if (outcome !== "orphaned")
            throw new Error("orchestrator_active_attempt");
        const taskId = task.task?.id;
        // An orphaned attempt is excused only for the workflow directory that owns the record.
        if (typeof workflowName !== "string" ||
            typeof taskId !== "string" ||
            basename(dirname(path)) !== workflowName) {
            throw new Error("orchestrator_quiescence_unverified");
        }
        let ids = orphaned.get(workflowName);
        if (!ids) {
            ids = new Set();
            orphaned.set(workflowName, ids);
        }
        ids.add(taskId);
    }
}
function assertTaskFileQuiescent(path, orphaned) {
    const raw = readBoundedJson(path, SMALL_STATE_BYTES, "orchestrator_quiescence_unverified");
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
        throw new Error("orchestrator_quiescence_unverified");
    const task = raw;
    const statuses = new Set([
        "pending",
        "blocked",
        "in_progress",
        "completed",
        "failed",
    ]);
    if (typeof task.status !== "string" || !statuses.has(task.status)) {
        throw new Error("orchestrator_quiescence_unverified");
    }
    const terminal = ["completed", "failed"].includes(task.status);
    const active = task.status === "running" ||
        task.status === "in_progress" ||
        (!terminal && task.claim !== undefined);
    if (!active)
        return;
    // A task projection may only stay active when its own workflow attempt, in its own team directory, was proven orphaned.
    const metadata = task.metadata;
    const allowed = orphaned !== undefined &&
        typeof metadata?.workflow === "string" &&
        typeof metadata?.task_id === "string" &&
        basename(dirname(dirname(path))) === metadata.workflow &&
        orphaned.get(metadata.workflow)?.has(metadata.task_id) === true;
    if (!allowed)
        throw new Error("orchestrator_active_attempt");
}
function isWorkflowLockName(name) {
    return (name.endsWith(".lock") ||
        name.startsWith(".lock-") ||
        name.endsWith("-lock"));
}
/** Same age the advisory file lock requires before it reaps its own abandoned lock files. */
const ABANDONED_FILE_LOCK_MS = 30_000;
/**
 * A process killed mid-operation leaves its `*.lock` file behind. Such a file counts as abandoned, not held,
 * only when it is old enough, names its owner PID, and that owner is verifiably gone: a recorded start identity
 * proves it even across PID reuse, otherwise the PID must not be running at all. The advisory lock reaps the
 * same files itself on its next acquisition, so no quiescence check treats them as activity.
 */
function isAbandonedFileLock(path) {
    let info;
    try {
        info = lstatSync(path);
    }
    catch {
        return false;
    }
    if (!info.isFile() || Date.now() - info.mtimeMs < ABANDONED_FILE_LOCK_MS)
        return false;
    let raw;
    try {
        raw = readBoundedJson(path, SMALL_STATE_BYTES, "orchestrator_quiescence_unverified");
    }
    catch {
        return false;
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
        return false;
    const record = raw;
    const pid = record.pid;
    if (!Number.isSafeInteger(pid) || Number(pid) <= 0)
        return false;
    if (record.process_started_at !== undefined) {
        return (isValidProcessStartIdentity(record.process_started_at) &&
            isProcessIdentityDead({
                pid: Number(pid),
                process_started_at: record.process_started_at,
            }));
    }
    return !isProcessAlive(Number(pid));
}
export function assertOrchestratorQuiescent(cwd, options = {}) {
    const stateRoot = join(getOmcRoot(repositoryRoot(cwd)), "state");
    const roots = [join(stateRoot, "team"), join(stateRoot, "team-recovery")];
    const orphaned = options.allowOrphanedAttempts
        ? new Map()
        : undefined;
    if (orphaned) {
        // Workflow records are classified first so task projections can be matched against them.
        const preflight = { remaining: MAX_QUIESCENCE_ENTRIES };
        for (const root of roots) {
            walkQuiescenceTree(root, (path) => {
                if (basename(path) === "workflow.json")
                    assertWorkflowFileQuiescent(path, orphaned);
            }, preflight);
        }
    }
    const inspect = (path) => {
        const name = basename(path);
        if (isWorkflowLockName(name)) {
            if (!isAbandonedFileLock(path))
                throw new Error("orchestrator_workflow_locked");
            return;
        }
        if (name === "workflow.json")
            assertWorkflowFileQuiescent(path, orphaned);
        if (/^task-[^.]+\.json$/.test(name) && basename(dirname(path)) === "tasks")
            assertTaskFileQuiescent(path, orphaned);
    };
    const budget = { remaining: MAX_QUIESCENCE_ENTRIES };
    for (const root of roots)
        walkQuiescenceTree(root, inspect, budget);
}
function assertLeaseProcessDead(pid, processStartedAt) {
    if (!isValidProcessStartIdentity(processStartedAt) ||
        !isProcessIdentityDead({ pid, process_started_at: processStartedAt })) {
        throw new Error("orchestrator_lease_process_not_confirmed_dead");
    }
}
export function assertLeaseProcessesRecoverable(lease) {
    if (lease.processRegistration === undefined ||
        lease.processRegistration === "pending" ||
        lease.relatedProcesses === undefined) {
        throw new Error("orchestrator_lease_processes_unverifiable");
    }
    if (lease.processRegistration === "not-started" &&
        (lease.relatedPids.length !== 0 || lease.relatedProcesses.length !== 0)) {
        throw new Error("orchestrator_lease_processes_unverifiable");
    }
    if (lease.processRegistration === "complete" &&
        lease.relatedProcesses.length === 0) {
        throw new Error("orchestrator_lease_processes_unverifiable");
    }
    assertLeaseProcessDead(lease.ownerPid, lease.ownerProcessStartedAt);
    for (const process of lease.relatedProcesses) {
        assertLeaseProcessDead(process.pid, process.processStartedAt);
    }
}
function assertPidConfirmedDead(pid) {
    if (!Number.isSafeInteger(pid) || Number(pid) <= 0) {
        throw new Error("orchestrator_provider_process_unverifiable");
    }
    try {
        process.kill(Number(pid), 0);
    }
    catch (error) {
        if (error.code === "ESRCH")
            return;
        throw new Error("orchestrator_provider_process_not_confirmed_dead");
    }
    throw new Error("orchestrator_provider_process_not_confirmed_dead");
}
function assertHeartbeatQuiescent(path) {
    const raw = readBoundedJson(path, SMALL_STATE_BYTES, "orchestrator_quiescence_unverified");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new Error("orchestrator_quiescence_unverified");
    }
    const heartbeat = raw;
    if (!["shutdown", "quarantined"].includes(String(heartbeat.status))) {
        throw new Error("orchestrator_active_provider");
    }
    assertPidConfirmedDead(heartbeat.pid);
}
function assertWorkerIdentityQuiescent(path) {
    const raw = readBoundedJson(path, SMALL_STATE_BYTES, "orchestrator_quiescence_unverified");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new Error("orchestrator_quiescence_unverified");
    }
    const identity = raw;
    if (!["dead", "stopped"].includes(String(identity.operational_state))) {
        throw new Error("orchestrator_active_provider");
    }
    if (identity.pid !== undefined)
        assertPidConfirmedDead(identity.pid);
}
function assertWorkerStatusQuiescent(path) {
    const raw = readBoundedJson(path, SMALL_STATE_BYTES, "orchestrator_quiescence_unverified");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new Error("orchestrator_quiescence_unverified");
    }
    const status = raw;
    if (!["done", "failed"].includes(String(status.state))) {
        throw new Error("orchestrator_active_provider");
    }
}
function assertReadyEvidenceQuiescent(path) {
    const workerRoot = dirname(path);
    const identity = join(workerRoot, "identity.json");
    const status = join(workerRoot, "status.json");
    if (!lstatIfPresent(identity) || !lstatIfPresent(status)) {
        throw new Error("orchestrator_provider_process_unverifiable");
    }
    assertWorkerIdentityQuiescent(identity);
    assertWorkerStatusQuiescent(status);
}
function assertTeamConfigQuiescent(path) {
    const raw = readBoundedJson(path, TEAM_CONFIG_BYTES, "orchestrator_quiescence_unverified");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new Error("orchestrator_quiescence_unverified");
    }
    const expectedTeamName = basename(dirname(path));
    const validated = Object.hasOwn(raw, "state_revision")
        ? validateRevisionedTeamConfig(raw, expectedTeamName)
        : validateLegacyTeamConfig(raw, expectedTeamName);
    if (!validated)
        throw new Error("orchestrator_quiescence_unverified");
    const config = validated;
    if (!["active", "shutting_down", "stopped"].includes(String(config.lifecycle_state))) {
        throw new Error("orchestrator_quiescence_unverified");
    }
    if (config.active_recovery !== undefined ||
        config.active_scale_up !== undefined ||
        config.active_scale_down !== undefined ||
        config.shutdown_attempt !== undefined ||
        (config.lifecycle_state !== "stopped" &&
            config.service_descriptor !== undefined)) {
        throw new Error("orchestrator_active_provider");
    }
    const owner = config.runtime_owner_epoch;
    if (owner !== undefined) {
        if (!owner || typeof owner !== "object" || Array.isArray(owner)) {
            throw new Error("orchestrator_provider_process_unverifiable");
        }
        const identity = owner;
        if (!Number.isSafeInteger(identity.pid) ||
            Number(identity.pid) <= 0 ||
            !isValidProcessStartIdentity(identity.process_started_at) ||
            !isProcessIdentityDead({
                pid: Number(identity.pid),
                process_started_at: identity.process_started_at,
            })) {
            throw new Error("orchestrator_provider_process_not_confirmed_dead");
        }
    }
    else if (config.lifecycle_state !== "stopped") {
        throw new Error("orchestrator_provider_process_unverifiable");
    }
    for (const value of config.workers) {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
            throw new Error("orchestrator_quiescence_unverified");
        }
        const worker = value;
        if (!["dead", "stopped"].includes(String(worker.operational_state))) {
            throw new Error("orchestrator_active_provider");
        }
        if (worker.pid !== undefined)
            assertPidConfirmedDead(worker.pid);
    }
}
function assertTeamLifecycleQuiescent(stateRoot, budget) {
    walkQuiescenceTree(join(stateRoot, "team"), (path) => {
        const name = basename(path);
        if (name === "heartbeat.json")
            assertHeartbeatQuiescent(path);
        if (name === "config.json")
            assertTeamConfigQuiescent(path);
        if (basename(dirname(dirname(path))) === "workers" &&
            name === "identity.json") {
            assertWorkerIdentityQuiescent(path);
        }
        if (basename(dirname(dirname(path))) === "workers" &&
            name === "status.json") {
            assertWorkerStatusQuiescent(path);
        }
        if (name === ".ready")
            assertReadyEvidenceQuiescent(path);
    }, budget);
    walkQuiescenceTree(join(stateRoot, "team-bridge"), (path) => {
        const name = basename(path);
        if (name.endsWith(".lock") ||
            name.startsWith(".lock-") ||
            name.endsWith("-lock")) {
            throw new Error("orchestrator_workflow_locked");
        }
        if (name.endsWith(".heartbeat.json"))
            assertHeartbeatQuiescent(path);
    }, budget);
}
function assertRepositoryRuntimeLeasesRecoverable(stateRoot, budget) {
    const repositories = join(stateRoot, "orchestrator", "repositories");
    const rootInfo = lstatIfPresent(repositories);
    if (!rootInfo)
        return;
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
        throw new Error("orchestrator_quiescence_unverified");
    for (const entry of readdirSync(repositories, { withFileTypes: true })) {
        budget.remaining--;
        if (budget.remaining < 0)
            throw new Error("orchestrator_quiescence_scan_overflow");
        if (entry.isSymbolicLink() ||
            !entry.isDirectory() ||
            !/^[a-f0-9]{64}$/.test(entry.name)) {
            throw new Error("orchestrator_quiescence_unverified");
        }
        const runtime = join(repositories, entry.name, "runtime.json");
        const state = readRuntimeStateFile(runtime);
        if (state.lease)
            assertLeaseProcessesRecoverable(state.lease);
    }
}
export function assertOrchestratorRecoveryQuiescent(cwd) {
    assertOrchestratorQuiescent(cwd, { allowOrphanedAttempts: true });
    const stateRoot = join(getOmcRoot(repositoryRoot(cwd)), "state");
    const budget = { remaining: MAX_QUIESCENCE_ENTRIES };
    assertTeamLifecycleQuiescent(stateRoot, budget);
    assertRepositoryRuntimeLeasesRecoverable(stateRoot, budget);
}
//# sourceMappingURL=quiescence.js.map