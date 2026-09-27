import { isDeepStrictEqual } from "node:util";
import type { OrchestratorHost } from "../orchestration/selection.js";
import type { ArtifactDescriptor } from "../shared/artifact-descriptor.js";
import type {
  VersionedWorkflowState,
  WorkflowCommand,
  WorkflowLeadIntegrationActor,
} from "./workflow-contracts.js";

const MAX_RECOVERY_RECORD_BYTES = 128 * 1024;
export const MAX_WORKFLOW_TASK_RECOVERIES = 100;

export interface WorkflowTaskRecoveryIntent {
  readonly requestId: string;
  readonly expectedHead: string;
  readonly expectedRefsDigest: string;
  readonly expectedTaskCommit: string;
  readonly actor: WorkflowLeadIntegrationActor;
  readonly authorityRef: string;
  readonly reason: string;
}

export interface WorkflowTaskRecoveryCheck {
  readonly command: WorkflowCommand;
  readonly passed: true;
  readonly artifacts: readonly ArtifactDescriptor[];
}

export interface WorkflowTaskRecovery {
  readonly sequence: number;
  readonly taskId: string;
  readonly requestId: string;
  readonly oldError: string;
  readonly taskCommit: string;
  readonly baseCommit: string;
  readonly head: string;
  readonly refsDigestBefore: string;
  readonly refsDigestAfter: string;
  readonly orchestrationHost: OrchestratorHost;
  readonly actor: WorkflowLeadIntegrationActor;
  readonly authorityRef: string;
  readonly reason: string;
  readonly checks: readonly WorkflowTaskRecoveryCheck[];
  readonly protectedRefAuditContentHash?: string;
  readonly at: string;
}

export type WorkflowStateWithTaskRecoveries = VersionedWorkflowState & {
  taskRecoveries?: readonly WorkflowTaskRecovery[];
};

function exactObject(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("workflow_invalid_task_recovery");
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some((key) => !keys.includes(key)))
    throw new Error("workflow_invalid_task_recovery");
  return raw;
}

function text(value: unknown, maximum: number): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > maximum ||
    value.includes("\0")
  )
    throw new Error("workflow_invalid_task_recovery");
  return value;
}

function literal(value: unknown, maximum: number): string {
  const parsed = text(value, maximum);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/.test(parsed))
    throw new Error("workflow_invalid_task_recovery");
  return parsed;
}

function sha(value: unknown): string {
  const parsed = text(value, 64);
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(parsed))
    throw new Error("workflow_invalid_task_recovery");
  return parsed;
}

function digest(value: unknown): string {
  const parsed = text(value, 64);
  if (!/^[a-f0-9]{64}$/.test(parsed))
    throw new Error("workflow_invalid_task_recovery");
  return parsed;
}

function taskId(value: unknown): string {
  const parsed = text(value, 30);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(parsed))
    throw new Error("workflow_invalid_task_recovery");
  return parsed;
}

function actor(value: unknown): WorkflowLeadIntegrationActor {
  const raw = exactObject(value, ["id", "model"]);
  const id = literal(raw.id, 200);
  const model = literal(raw.model, 200);
  if ((id === "unknown") !== (model === "unknown"))
    throw new Error("workflow_invalid_task_recovery_actor");
  return Object.freeze({ id, model });
}

function command(value: unknown): WorkflowCommand {
  const raw = exactObject(value, ["command", "args"]);
  const executable = text(raw.command, 1000);
  if (
    /[\r\n]/.test(executable) ||
    !Array.isArray(raw.args) ||
    raw.args.length > 100 ||
    raw.args.some(
      (argument) =>
        typeof argument !== "string" ||
        argument.length > 4000 ||
        argument.includes("\0"),
    )
  )
    throw new Error("workflow_invalid_task_recovery_check");
  return Object.freeze({
    command: executable,
    args: Object.freeze([...raw.args]) as string[],
  });
}

function timestamp(value: unknown): string {
  const parsed = text(value, 24);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(parsed) ||
    !Number.isFinite(Date.parse(parsed)) ||
    new Date(parsed).toISOString() !== parsed
  )
    throw new Error("workflow_invalid_task_recovery");
  return parsed;
}

function artifact(value: unknown): ArtifactDescriptor {
  const raw = exactObject(value, [
    "kind",
    "path",
    "contentHash",
    "createdAt",
    "producer",
    "sizeBytes",
    "retention",
    "expiresAt",
  ]);
  const producer = exactObject(raw.producer, ["system", "component", "worker"]);
  if (
    (producer.system !== "omc" && producer.system !== "omx") ||
    !["ephemeral", "session", "until-completion", "persistent"].includes(
      String(raw.retention),
    ) ||
    !Number.isSafeInteger(raw.sizeBytes) ||
    Number(raw.sizeBytes) < 0
  )
    throw new Error("workflow_invalid_task_recovery_artifact");
  const parsed: ArtifactDescriptor = {
    kind: literal(raw.kind, 160),
    path: text(raw.path, 4000),
    contentHash: digest(raw.contentHash),
    createdAt: timestamp(raw.createdAt),
    producer: Object.freeze({
      system: producer.system,
      component: literal(producer.component, 160),
      ...(producer.worker === undefined
        ? {}
        : { worker: literal(producer.worker, 160) }),
    }) as ArtifactDescriptor["producer"],
    sizeBytes: Number(raw.sizeBytes),
    retention: raw.retention as ArtifactDescriptor["retention"],
    ...(raw.expiresAt === undefined
      ? {}
      : { expiresAt: timestamp(raw.expiresAt) }),
  };
  if (/[\r\n]/.test(parsed.path))
    throw new Error("workflow_invalid_task_recovery_artifact");
  return Object.freeze(parsed);
}

function recoveryCheck(value: unknown): WorkflowTaskRecoveryCheck {
  const raw = exactObject(value, ["command", "passed", "artifacts"]);
  if (
    raw.passed !== true ||
    !Array.isArray(raw.artifacts) ||
    raw.artifacts.length > 100
  )
    throw new Error("workflow_invalid_task_recovery_check");
  return Object.freeze({
    command: command(raw.command),
    passed: true,
    artifacts: Object.freeze(raw.artifacts.map(artifact)),
  });
}

function sizeBound(value: unknown): void {
  if (
    Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_RECOVERY_RECORD_BYTES
  )
    throw new Error("workflow_task_recovery_too_large");
}

export function parseWorkflowTaskRecoveryIntent(
  value: unknown,
): WorkflowTaskRecoveryIntent {
  const raw = exactObject(value, [
    "requestId",
    "expectedHead",
    "expectedRefsDigest",
    "expectedTaskCommit",
    "actor",
    "authorityRef",
    "reason",
  ]);
  const parsed: WorkflowTaskRecoveryIntent = Object.freeze({
    requestId: literal(raw.requestId, 100),
    expectedHead: sha(raw.expectedHead),
    expectedRefsDigest: digest(raw.expectedRefsDigest),
    expectedTaskCommit: sha(raw.expectedTaskCommit),
    actor: actor(raw.actor),
    authorityRef: text(raw.authorityRef, 1000),
    reason: text(raw.reason, 1000),
  });
  sizeBound(parsed);
  return parsed;
}

export function parseWorkflowTaskRecovery(
  value: unknown,
): WorkflowTaskRecovery {
  const raw = exactObject(value, [
    "sequence",
    "taskId",
    "requestId",
    "oldError",
    "taskCommit",
    "baseCommit",
    "head",
    "refsDigestBefore",
    "refsDigestAfter",
    "orchestrationHost",
    "actor",
    "authorityRef",
    "reason",
    "checks",
    "protectedRefAuditContentHash",
    "at",
  ]);
  if (
    !Number.isSafeInteger(raw.sequence) ||
    Number(raw.sequence) < 1 ||
    Number(raw.sequence) > MAX_WORKFLOW_TASK_RECOVERIES ||
    (raw.orchestrationHost !== "claude" && raw.orchestrationHost !== "codex") ||
    !Array.isArray(raw.checks) ||
    raw.checks.length > 30
  )
    throw new Error("workflow_invalid_task_recovery");
  const oldError = text(raw.oldError, 200);
  if (!/^workflow_[a-z_]+$/.test(oldError))
    throw new Error("workflow_invalid_task_recovery");
  const parsed: WorkflowTaskRecovery = Object.freeze({
    sequence: Number(raw.sequence),
    taskId: taskId(raw.taskId),
    requestId: literal(raw.requestId, 100),
    oldError,
    taskCommit: sha(raw.taskCommit),
    baseCommit: sha(raw.baseCommit),
    head: sha(raw.head),
    refsDigestBefore: digest(raw.refsDigestBefore),
    refsDigestAfter: digest(raw.refsDigestAfter),
    orchestrationHost: raw.orchestrationHost,
    actor: actor(raw.actor),
    authorityRef: text(raw.authorityRef, 1000),
    reason: text(raw.reason, 1000),
    checks: Object.freeze(raw.checks.map(recoveryCheck)),
    ...(raw.protectedRefAuditContentHash === undefined
      ? {}
      : {
          protectedRefAuditContentHash: digest(
            raw.protectedRefAuditContentHash,
          ),
        }),
    at: timestamp(raw.at),
  });
  sizeBound(parsed);
  return parsed;
}

/** Apply only the final evidence transition; caller owns locks, current-head checks, and check execution. */
export function appendWorkflowTaskRecovery(
  state: WorkflowStateWithTaskRecoveries,
  value: unknown,
): boolean {
  const receipt = parseWorkflowTaskRecovery(value);
  const recoveries = state.taskRecoveries ?? [];
  const replay = recoveries.find(
    (entry) => entry.requestId === receipt.requestId,
  );
  if (replay) {
    if (!isDeepStrictEqual(replay, receipt))
      throw new Error("workflow_task_recovery_request_conflict");
    return false;
  }
  if (
    recoveries.length >= MAX_WORKFLOW_TASK_RECOVERIES ||
    receipt.sequence !== recoveries.length + 1 ||
    receipt.refsDigestBefore !== receipt.refsDigestAfter
  )
    throw new Error("workflow_invalid_task_recovery");
  const entry = state.tasks.find(
    (candidate) => candidate.task.id === receipt.taskId,
  );
  if (
    !entry ||
    entry.status !== "failed" ||
    entry.error !== receipt.oldError ||
    state.integrationHead !== receipt.head ||
    entry.task.baseCommit !== receipt.baseCommit ||
    entry.handoff?.outcome !== "completed" ||
    entry.handoff.commitSha !== receipt.taskCommit ||
    entry.task.tests.length !== receipt.checks.length ||
    !entry.task.tests.every((expected, index) =>
      isDeepStrictEqual(expected, receipt.checks[index]?.command),
    ) ||
    receipt.checks.some((check) => check.passed !== true)
  )
    throw new Error("workflow_task_recovery_evidence_mismatch");
  state.taskRecoveries = Object.freeze([...recoveries, receipt]);
  entry.status = "completed";
  delete entry.error;
  entry.updatedAt = receipt.at;
  return true;
}
