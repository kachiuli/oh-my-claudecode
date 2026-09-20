import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  parseWorkflowHandoff,
  parseWorkflowState,
  safeWorkflowId,
  type WorkflowHandoff,
} from "./workflow-contracts.js";
import { atomicWriteJson, validateResolvedPath } from "./fs-utils.js";
import { teamStateRoot } from "./state-paths.js";
import {
  redactWorkflowText,
  WORKFLOW_PUBLICATION_ENV,
  type WorkflowPublicationEnvironment,
} from "./workflow-process.js";

const MAX_RESULT_BYTES = 64 * 1024;
const MAX_CAPABILITY_BYTES = 16 * 1024;
const MAX_WORKFLOW_BYTES = 16 * 1024 * 1024;

export interface WorkflowPublicationContract {
  canonicalTask: Readonly<{ source: "dispatch.task"; taskId: string }>;
  helperResult: Readonly<{
    purpose: "optional-local-validation";
    publishVerifiedBytesUnchanged: true;
  }>;
  designatedResult: Readonly<{
    path: string;
    authorization: "create-this-file-only";
    overwrite: false;
    stdoutIsHandoff: false;
  }>;
  publishCommand: string;
  finalization: readonly string[];
}

export interface WorkflowJsonArtifactRead {
  value: unknown;
  artifactPath: string;
}

export interface WorkflowHandoffArtifactRead extends WorkflowJsonArtifactRead {
  value: WorkflowHandoff;
}

interface WorkflowPublicationCapabilityRecord {
  schemaVersion: 1;
  id: string;
  tokenHash: string;
  workflowName: string;
  taskId: string;
  worker: string;
  attempt: number;
  workflowRoot: string;
  stateRoot: string;
  worktree: string;
  resultFile: string;
}

export interface WorkflowPublicationIssue {
  workflowRoot: string;
  workflowName: string;
  taskId: string;
  worker: string;
  attempt: number;
  worktree: string;
  resultFile: string;
}

export interface IssuedWorkflowPublication {
  environment: WorkflowPublicationEnvironment;
  revoke(): void;
}

export interface WorkflowPublicationContext {
  cwd: string;
  environment?: NodeJS.ProcessEnv | Record<string, string | undefined>;
}

/** Worker-facing publication contract. The command is portable across supported OMC installations. */
export function workflowPublicationContract(
  taskId: string,
  resultFile: string,
): WorkflowPublicationContract {
  return {
    canonicalTask: Object.freeze({ source: "dispatch.task", taskId }),
    helperResult: Object.freeze({
      purpose: "optional-local-validation",
      publishVerifiedBytesUnchanged: true,
    }),
    designatedResult: Object.freeze({
      path: resultFile,
      authorization: "create-this-file-only",
      overwrite: false,
      stdoutIsHandoff: false,
    }),
    publishCommand: `omc team workflow publish-result --source <helper-local-json> --result-file ${JSON.stringify(resultFile)} --task-id ${JSON.stringify(taskId)}`,
    finalization: Object.freeze([
      "Pass only dispatch.task to helpers that expect the canonical task; the full dispatch envelope is not a WorkflowTask.",
      "Validate the helper-local JSON against the handoff schema and this canonical taskId.",
      "Publish the already verified bytes exclusively to designatedResult.path; never overwrite an existing file.",
      "Re-read the destination and confirm byte equality, JSON parsing, handoff schema, and canonical taskId.",
      "End the provider response only after the exact designated result exists and all destination checks pass.",
    ]),
  };
}

function canonicalParent(path: string, expectedParent?: string): string {
  const parent = dirname(path);
  const canonical = expectedParent ?? realpathSync(parent);
  if (lstatSync(parent).isSymbolicLink() || realpathSync(parent) !== canonical)
    throw new Error("workflow_artifact_parent_changed");
  validateResolvedPath(path, canonical);
  return canonical;
}

function regularBytes(
  path: string,
  maximum: number,
  expectedParent?: string,
): Buffer {
  canonicalParent(path, expectedParent);
  if (!existsSync(path)) throw new Error("workflow_designated_result_missing");
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

function regularResultBytes(path: string, expectedParent?: string): Buffer {
  return regularBytes(path, MAX_RESULT_BYTES, expectedParent);
}

function exactRecord(value: unknown): WorkflowPublicationCapabilityRecord {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("workflow_publication_not_authorized");
  const record = value as Record<string, unknown>;
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
    "resultFile",
  ];
  if (
    Object.keys(record).length !== keys.length ||
    Object.keys(record).some((key) => !keys.includes(key)) ||
    record.schemaVersion !== 1 ||
    typeof record.id !== "string" ||
    typeof record.tokenHash !== "string" ||
    typeof record.workflowName !== "string" ||
    typeof record.taskId !== "string" ||
    typeof record.worker !== "string" ||
    !Number.isSafeInteger(record.attempt) ||
    typeof record.workflowRoot !== "string" ||
    typeof record.stateRoot !== "string" ||
    typeof record.worktree !== "string" ||
    typeof record.resultFile !== "string"
  )
    throw new Error("workflow_publication_not_authorized");
  return record as unknown as WorkflowPublicationCapabilityRecord;
}

function capabilityPath(
  stateRoot: string,
  id: string,
): { artifacts: string; capability: string } {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id))
    throw new Error("workflow_publication_not_authorized");
  const artifacts = join(stateRoot, "artifacts");
  validateResolvedPath(artifacts, stateRoot);
  return { artifacts, capability: join(artifacts, `.publication-${id}.json`) };
}

function tokenMatches(token: string, hash: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(token) || !/^[a-f0-9]{64}$/.test(hash))
    return false;
  const actual = createHash("sha256").update(token).digest();
  return timingSafeEqual(actual, Buffer.from(hash, "hex"));
}

/** Issue one exact task/attempt publication capability; only its hash enters controller state. */
export function issueWorkflowPublication(
  input: WorkflowPublicationIssue,
): IssuedWorkflowPublication {
  const workflowRoot = realpathSync(input.workflowRoot);
  const worktree = realpathSync(input.worktree);
  const workflowName = safeWorkflowId(input.workflowName);
  const taskId = safeWorkflowId(input.taskId);
  if (
    !/^task-[a-z0-9][a-z0-9-]*$/.test(input.worker) ||
    !Number.isSafeInteger(input.attempt) ||
    input.attempt < 1 ||
    input.attempt > 5
  ) {
    throw new Error("workflow_invalid_publication_authority");
  }
  const id = randomUUID();
  const stateRoot = realpathSync(teamStateRoot(workflowRoot, workflowName));
  const { artifacts, capability } = capabilityPath(stateRoot, id);
  const canonicalArtifacts = realpathSync(artifacts);
  const resultFile = resolve(input.resultFile);
  const expectedResult = resolve(
    canonicalArtifacts,
    `${input.worker}-${input.attempt}.result.json`,
  );
  if (
    resultFile !== expectedResult ||
    realpathSync(dirname(resultFile)) !== canonicalArtifacts
  ) {
    throw new Error("workflow_invalid_publication_authority");
  }
  const token = randomBytes(32).toString("hex");
  const record: WorkflowPublicationCapabilityRecord = {
    schemaVersion: 1,
    id,
    tokenHash: createHash("sha256").update(token).digest("hex"),
    workflowName,
    taskId,
    worker: input.worker,
    attempt: input.attempt,
    workflowRoot,
    stateRoot,
    worktree,
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
    }) as WorkflowPublicationEnvironment,
    revoke() {
      if (revoked) return;
      revoked = true;
      try {
        unlinkSync(capability);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    },
  });
}

function authorizePublication(
  resultFile: string,
  taskId: string,
  context: WorkflowPublicationContext,
): { capability: string; worktree: string } {
  const environment = context.environment ?? process.env;
  const id = environment[WORKFLOW_PUBLICATION_ENV.capabilityId];
  const token = environment[WORKFLOW_PUBLICATION_ENV.capabilityToken];
  const rootInput = environment[WORKFLOW_PUBLICATION_ENV.workflowRoot];
  const nameInput = environment[WORKFLOW_PUBLICATION_ENV.workflowName];
  const stateRootInput = environment[WORKFLOW_PUBLICATION_ENV.stateRoot];
  if (!id || !token || !rootInput || !nameInput || !stateRootInput)
    throw new Error("workflow_publication_not_authorized");
  let workflowRoot: string;
  let stateRoot: string;
  let cwd: string;
  try {
    workflowRoot = realpathSync(rootInput);
    stateRoot = realpathSync(stateRootInput);
    cwd = realpathSync(context.cwd);
  } catch {
    throw new Error("workflow_publication_not_authorized");
  }
  const workflowName = safeWorkflowId(nameInput);
  const { artifacts, capability } = capabilityPath(stateRoot, id);
  let record: WorkflowPublicationCapabilityRecord;
  try {
    record = exactRecord(
      JSON.parse(
        regularBytes(
          capability,
          MAX_CAPABILITY_BYTES,
          realpathSync(artifacts),
        ).toString("utf8"),
      ),
    );
  } catch {
    throw new Error("workflow_publication_not_authorized");
  }
  if (
    !tokenMatches(token, record.tokenHash) ||
    record.id !== id ||
    record.workflowName !== workflowName ||
    record.workflowRoot !== workflowRoot ||
    record.stateRoot !== stateRoot ||
    record.taskId !== taskId ||
    resolve(record.resultFile) !== resolve(resultFile) ||
    environment.OMC_TEAM_WORKER !== record.worker ||
    !environment.OMC_TEAM_WORKTREE_PATH
  ) {
    throw new Error("workflow_publication_not_authorized");
  }
  let environmentWorktree: string;
  let recordWorktree: string;
  try {
    environmentWorktree = realpathSync(environment.OMC_TEAM_WORKTREE_PATH);
    recordWorktree = realpathSync(record.worktree);
  } catch {
    throw new Error("workflow_publication_not_authorized");
  }
  if (cwd !== recordWorktree || environmentWorktree !== recordWorktree)
    throw new Error("workflow_publication_not_authorized");
  const stateFile = join(stateRoot, "workflow.json");
  let state;
  try {
    state = parseWorkflowState(
      JSON.parse(
        regularBytes(
          stateFile,
          MAX_WORKFLOW_BYTES,
          dirname(stateFile),
        ).toString("utf8"),
      ),
    );
  } catch {
    throw new Error("workflow_publication_not_authorized");
  }
  const entry = state.tasks.find((candidate) => candidate.task.id === taskId);
  const invocation = entry?.invocations?.at(-1);
  let stateCwd: string;
  let stateWorktree: string;
  try {
    stateCwd = realpathSync(state.cwd);
    stateWorktree = realpathSync(entry?.worktree ?? "");
  } catch {
    throw new Error("workflow_publication_not_authorized");
  }
  const expectedResult = resolve(
    artifacts,
    `${record.worker}-${record.attempt}.result.json`,
  );
  if (
    stateCwd !== workflowRoot ||
    state.plan.name !== workflowName ||
    !entry ||
    entry.worker !== record.worker ||
    entry.status !== "running" ||
    entry.attempts !== record.attempt ||
    invocation?.attempt !== record.attempt ||
    invocation.error !== "workflow_invocation_incomplete" ||
    stateWorktree !== recordWorktree ||
    resolve(resultFile) !== expectedResult
  )
    throw new Error("workflow_publication_not_authorized");
  return { capability, worktree: recordWorktree };
}

function parseResultBytes(bytes: Buffer, taskId: string): WorkflowHandoff {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("workflow_invalid_result");
  }
  return parseWorkflowHandoff(parsed, taskId);
}

/**
 * Publish a helper-verified handoff without changing its bytes. This is the only worker-authorized
 * write inside controller state, and exclusive creation preserves any pre-existing evidence.
 */
export function publishWorkflowResultArtifact(
  sourceFile: string,
  resultFile: string,
  taskId: string,
  context: WorkflowPublicationContext,
): { sizeBytes: number; sha256: string } {
  taskId = safeWorkflowId(taskId);
  const authority = authorizePublication(resultFile, taskId, context);
  validateResolvedPath(realpathSync(sourceFile), authority.worktree);
  const source = regularResultBytes(sourceFile);
  parseResultBytes(source, taskId);
  canonicalParent(resultFile, dirname(authority.capability));
  if (existsSync(resultFile)) throw new Error("workflow_result_already_exists");
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      resultFile,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    let offset = 0;
    while (offset < source.length)
      offset += writeSync(descriptor, source, offset, source.length - offset);
    fsyncSync(descriptor);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error("workflow_result_already_exists");
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  const published = regularResultBytes(resultFile);
  if (!published.equals(source))
    throw new Error("workflow_result_publication_mismatch");
  parseResultBytes(published, taskId);
  try {
    unlinkSync(authority.capability);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return {
    sizeBytes: published.length,
    sha256: createHash("sha256").update(published).digest("hex"),
  };
}

/** Read the exact designated artifact. Valid safe bytes survive normal controller validation unchanged. */
export function readWorkflowResultArtifact(
  resultFile: string,
  expectedParent: string,
  taskId: string,
  environment?: NodeJS.ProcessEnv,
): WorkflowHandoffArtifactRead {
  const parsed = readWorkflowJsonArtifact(
    resultFile,
    expectedParent,
    environment,
  );
  try {
    return {
      value: parseWorkflowHandoff(parsed.value, taskId),
      artifactPath: parsed.artifactPath,
    };
  } catch (error) {
    atomicWriteJson(resultFile, { error: "workflow_invalid_result" });
    throw error;
  }
}

/** Generic bounded result reader used by the existing reviewer transports. */
export function readWorkflowJsonArtifact(
  resultFile: string,
  expectedParent: string,
  environment?: NodeJS.ProcessEnv,
): WorkflowJsonArtifactRead {
  let bytes: Buffer;
  try {
    bytes = regularResultBytes(resultFile, expectedParent);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error("workflow_designated_result_missing");
    if (
      error instanceof Error &&
      error.message === "workflow_artifact_invalid_or_oversized"
    ) {
      // An oversized regular single-link result is controller-owned evidence and can be safely replaced.
      try {
        const info = lstatSync(resultFile);
        if (info.isFile() && !info.isSymbolicLink() && info.nlink === 1)
          atomicWriteJson(resultFile, { error: "workflow_invalid_result" });
      } catch {
        /* Preserve the original refusal when safe replacement cannot be proven. */
      }
    }
    throw error;
  }
  const text = bytes.toString("utf8");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
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
    } catch {
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
    } catch {
      throw new Error("workflow_artifact_write_refused");
    }
    if (readFileSync(artifactPath, "utf8") !== redacted)
      throw new Error("workflow_result_publication_mismatch");
    return { value, artifactPath };
  }
  return { value, artifactPath: resultFile };
}

/** Native Claude reviewer output is controller-published and remains distinct from worker publication. */
export function publishNativeClaudeResult(
  resultFile: string,
  value: unknown,
  environment?: NodeJS.ProcessEnv,
): void {
  canonicalParent(resultFile);
  try {
    const content = redactWorkflowText(
      JSON.stringify(value),
      false,
      environment,
    );
    const descriptor = openSync(
      resultFile,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    try {
      let offset = 0;
      const bytes = Buffer.from(content);
      while (offset < bytes.length)
        offset += writeSync(descriptor, bytes, offset, bytes.length - offset);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error("workflow_result_already_exists");
    throw error;
  }
}
