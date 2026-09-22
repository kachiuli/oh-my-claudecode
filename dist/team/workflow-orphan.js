import { isProcessIdentityDead, isValidProcessStartIdentity } from './team-owner-epoch.js';
function noProcessWithPid(pid) {
    try {
        process.kill(pid, 0);
        return false;
    }
    catch (error) {
        return error.code === 'ESRCH';
    }
}
/**
 * A start identity proves death precisely, even across PID reuse. A bare PID (identity `null`) proves death
 * only when no process with that PID exists at all; a live PID is conservatively treated as the recorded process.
 */
export function recordedProcessOutcome(identity) {
    if (!identity || typeof identity !== 'object' || Array.isArray(identity))
        return 'unverifiable';
    const { pid, processStartedAt } = identity;
    if (!Number.isSafeInteger(pid) || Number(pid) <= 0)
        return 'unverifiable';
    if (isValidProcessStartIdentity(processStartedAt)) {
        return isProcessIdentityDead({ pid: Number(pid), process_started_at: processStartedAt }) ? 'dead' : 'alive';
    }
    if (processStartedAt !== null)
        return 'unverifiable';
    return noProcessWithPid(Number(pid)) ? 'dead' : 'alive';
}
/**
 * The single rule shared by explicit recovery and explicit rejection. The task's latest attempt must be the
 * current, still-incomplete one. It is orphaned when its recorded provider process is verifiably dead, or,
 * when no provider was ever recorded, when the controller that started the attempt is verifiably dead.
 * Anything else stays an active attempt that requires inspection.
 */
export function classifyOrphanedAttempt(task) {
    const invocations = task.invocations;
    const last = Array.isArray(invocations) ? invocations.at(-1) : undefined;
    if (!last || typeof last !== 'object' || Array.isArray(last))
        return 'unverifiable';
    const record = last;
    if (record.error !== 'workflow_invocation_incomplete' || record.attempt !== task.attempts)
        return 'unverifiable';
    if (record.process !== undefined) {
        const provider = recordedProcessOutcome(record.process);
        return provider === 'dead' ? 'orphaned' : provider === 'alive' ? 'provider-alive' : 'unverifiable';
    }
    const controller = recordedProcessOutcome(record.controller);
    return controller === 'dead' ? 'orphaned' : controller === 'alive' ? 'controller-alive' : 'unverifiable';
}
//# sourceMappingURL=workflow-orphan.js.map