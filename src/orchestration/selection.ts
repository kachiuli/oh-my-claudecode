import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { atomicWriteJson } from "../lib/atomic-write.js";
import { acquireFileLock, releaseFileLock } from "../lib/file-lock.js";
import { getOmcRoot, resolveSessionStatePaths } from "../lib/worktree-paths.js";
import { isProcessAlive } from "../platform/index.js";
import { probeCli, type CliProbeResult } from "../team/cli-detection.js";
import {
  activeFrom,
  assertNoCompetingOmx,
  assertRuntimeStateWritable,
  boundedText,
  exactObject,
  isHost,
  parseCheckpoint,
  parseRepositoryConfig,
  parseRevision,
  parseSessionId,
  parseTimestamp,
  parseUuid,
  readBoundedJson,
  readOrchestratorRepositoryConfig,
  readRuntimeState,
  repositoryRoot,
  resolveOrchestratorPaths,
  type OrchestratorCheckpointRecord,
  type OrchestratorRuntimeState,
  type PersistedLease,
  type RecordedOrchestratorSession,
} from "./state.js";

export {
  readOrchestratorRepositoryConfig,
  resolveOrchestratorPaths,
} from "./state.js";

export type OrchestratorHost = "claude" | "codex";

export interface OrchestratorRepositoryConfig {
  readonly schemaVersion: 1;
  readonly supportedHosts: readonly OrchestratorHost[];
  readonly defaultHost?: OrchestratorHost;
}

export interface ActiveOrchestratorSnapshot {
  readonly host: OrchestratorHost;
  readonly source: "legacy" | "local" | "default" | "sole-supported";
  readonly supportedHosts: readonly OrchestratorHost[];
  readonly selectionRevision: string;
  readonly adopted: boolean;
}

export interface OrchestratorSessionIdentity {
  readonly host: OrchestratorHost;
  readonly sessionId: string;
}

export interface OrchestratorLeaseCredentials extends OrchestratorSessionIdentity {
  readonly leaseId: string;
  readonly selectionRevision: string;
  readonly token: string;
}

export type OrchestratorCheckpointKind =
  | "before-work"
  | "completed-stage"
  | "paused"
  | "checkpointed";

export interface OrchestratorCheckpoint {
  readonly kind: OrchestratorCheckpointKind;
  readonly workflowName?: string;
  readonly reference?: string;
}

export interface OrchestratorHandoffRecord {
  readonly id: string;
  readonly from: OrchestratorHost;
  readonly to: OrchestratorHost;
  readonly fromSelectionRevision: string;
  readonly toSelectionRevision: string;
  readonly sessionId: string;
  readonly checkpoint: OrchestratorCheckpoint;
  readonly at: string;
}

export interface OrchestratorHostAvailability extends CliProbeResult {
  readonly guidance: string;
}

export interface OrchestratorStatus {
  readonly active: ActiveOrchestratorSnapshot;
  readonly availability: Readonly<
    Record<OrchestratorHost, OrchestratorHostAvailability>
  >;
  readonly lease: Readonly<{
    host: OrchestratorHost;
    sessionId: string;
    selectionRevision: string;
    ownerPid: number;
    acquiredAt: string;
  }> | null;
}

export interface OrchestratorPaths {
  readonly repositoryRoot: string;
  readonly repositoryKey: string;
  readonly config: string;
  readonly state: string;
  readonly operationLock: string;
}

export type OrchestratorHostProbe = (
  host: OrchestratorHost,
) => boolean | CliProbeResult;

export interface OrchestratorProbeOptions {
  readonly probe?: OrchestratorHostProbe;
}

export interface OrchestratorHandoffOptions extends OrchestratorProbeOptions {
  readonly credentials: OrchestratorLeaseCredentials;
  readonly checkpoint: OrchestratorCheckpoint;
}

const WORKFLOW_BYTES = 16 * 1024 * 1024;
const SMALL_STATE_BYTES = 16 * 1024;
const MAX_QUIESCENCE_ENTRIES = 4096;
const NEVER_REAP_STALE_LOCK_MS = Number.MAX_SAFE_INTEGER;

export const ORCHESTRATOR_ENV = Object.freeze({
  host: "OMC_ORCHESTRATOR_HOST",
  selectionRevision: "OMC_ORCHESTRATOR_SELECTION_REVISION",
  leaseId: "OMC_ORCHESTRATOR_LEASE_ID",
  leaseToken: "OMC_ORCHESTRATOR_LEASE_TOKEN",
  sessionId: "OMC_ORCHESTRATOR_SESSION_ID",
} as const);

const INSTALL_GUIDANCE: Readonly<Record<OrchestratorHost, string>> =
  Object.freeze({
    claude: "Install Claude Code and ensure 'claude --version' succeeds.",
    codex: "Install Codex CLI and ensure 'codex --version' succeeds.",
  });

export function readActiveOrchestrator(
  cwd: string,
): ActiveOrchestratorSnapshot {
  const paths = resolveOrchestratorPaths(cwd);
  const config = readOrchestratorRepositoryConfig(cwd);
  if (config) assertNoCompetingOmx(paths);
  return activeFrom(config, readRuntimeState(cwd));
}

async function writeRuntimeState(
  cwd: string,
  state: OrchestratorRuntimeState,
): Promise<void> {
  assertRuntimeStateWritable(state);
  await atomicWriteJson(resolveOrchestratorPaths(cwd).state, state);
}

async function withOperationGate<T>(
  cwd: string,
  action: (paths: OrchestratorPaths) => T | Promise<T>,
): Promise<T> {
  if (
    process.env.OMC_TEAM_WORKER ||
    process.env.OMC_TEAM_WORKER_NAME ||
    process.env.OMC_TEAM_WORKTREE_PATH
  ) {
    throw new Error("workflow_lead_authority_required");
  }
  const paths = resolveOrchestratorPaths(cwd);
  const handle = await acquireFileLock(paths.operationLock, {
    timeoutMs: 0,
    staleLockMs: NEVER_REAP_STALE_LOCK_MS,
  });
  if (!handle) throw new Error("orchestrator_operation_locked");
  try {
    const credentials = readOrchestratorLeaseCredentialsFromEnvironment();
    if (credentials) {
      const state = readRuntimeState(cwd);
      const active = activeFrom(readOrchestratorRepositoryConfig(cwd), state);
      assertLeaseCredentials(active, state.lease, credentials);
    }
    return await action(paths);
  } finally {
    releaseFileLock(handle);
  }
}

function credentialsTokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function equalDigest(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right))
    return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function assertLeaseCredentials(
  active: ActiveOrchestratorSnapshot,
  lease: PersistedLease | undefined,
  credentials: OrchestratorLeaseCredentials,
): void {
  if (
    !lease ||
    credentials.host !== active.host ||
    credentials.host !== lease.host ||
    credentials.selectionRevision !== active.selectionRevision ||
    credentials.selectionRevision !== lease.selectionRevision ||
    credentials.leaseId !== lease.leaseId ||
    credentials.sessionId !== lease.sessionId ||
    !equalDigest(credentialsTokenHash(credentials.token), lease.tokenHash)
  ) {
    throw new Error("orchestrator_lease_stale_or_revoked");
  }
}

export function readOrchestratorLeaseCredentialsFromEnvironment(
  environment:
    | NodeJS.ProcessEnv
    | Record<string, string | undefined> = process.env,
): OrchestratorLeaseCredentials | null {
  const values = [
    environment[ORCHESTRATOR_ENV.host],
    environment[ORCHESTRATOR_ENV.selectionRevision],
    environment[ORCHESTRATOR_ENV.leaseId],
    environment[ORCHESTRATOR_ENV.leaseToken],
    environment[ORCHESTRATOR_ENV.sessionId],
  ];
  if (values.every((value) => value === undefined || value === "")) return null;
  if (values.some((value) => value === undefined || value === ""))
    throw new Error("orchestrator_lease_environment_incomplete");
  const [host, revision, leaseId, token, sessionId] = values as string[];
  if (!isHost(host)) throw new Error("orchestrator_lease_environment_invalid");
  return Object.freeze({
    host,
    selectionRevision: parseRevision(
      revision,
      "orchestrator_lease_environment_invalid",
    ),
    leaseId: parseUuid(leaseId, "orchestrator_lease_environment_invalid"),
    token: boundedText(token, 128, "orchestrator_lease_environment_invalid"),
    sessionId: parseSessionId(sessionId),
  });
}

export function orchestratorLeaseEnvironment(
  credentials: OrchestratorLeaseCredentials,
): Readonly<Record<string, string>> {
  return Object.freeze({
    [ORCHESTRATOR_ENV.host]: credentials.host,
    [ORCHESTRATOR_ENV.selectionRevision]: credentials.selectionRevision,
    [ORCHESTRATOR_ENV.leaseId]: credentials.leaseId,
    [ORCHESTRATOR_ENV.leaseToken]: credentials.token,
    [ORCHESTRATOR_ENV.sessionId]: credentials.sessionId,
  });
}

function assertOperationCaller(
  active: ActiveOrchestratorSnapshot,
  state: OrchestratorRuntimeState,
): void {
  const credentials = readOrchestratorLeaseCredentialsFromEnvironment();
  if (credentials) {
    assertLeaseCredentials(active, state.lease, credentials);
  } else if (state.lease) {
    throw new Error("orchestrator_lease_required");
  }
}

export async function withOrchestratorOperation<T>(
  cwd: string,
  action: (active: ActiveOrchestratorSnapshot) => T | Promise<T>,
): Promise<T> {
  return withOperationGate(cwd, async (paths) => {
    const config = readOrchestratorRepositoryConfig(cwd);
    if (config) assertNoCompetingOmx(paths);
    const state = readRuntimeState(cwd);
    const active = activeFrom(config, state);
    assertOperationCaller(active, state);
    return action(active);
  });
}

function normalizedProbeResult(
  host: OrchestratorHost,
  probe?: OrchestratorHostProbe,
): OrchestratorHostAvailability {
  const result = probe ? probe(host) : probeCli(host);
  const normalized: CliProbeResult =
    typeof result === "boolean" ? { found: result } : result;
  return Object.freeze({ ...normalized, guidance: INSTALL_GUIDANCE[host] });
}

export function probeOrchestratorCli(
  host: OrchestratorHost,
  options: OrchestratorProbeOptions = {},
): OrchestratorHostAvailability {
  if (!isHost(host)) throw new Error("orchestrator_invalid_host");
  return normalizedProbeResult(host, options.probe);
}

function assertHostAvailable(
  host: OrchestratorHost,
  probe?: OrchestratorHostProbe,
): void {
  if (!normalizedProbeResult(host, probe).found) {
    throw new Error(
      `orchestrator_host_unavailable: ${host}. ${INSTALL_GUIDANCE[host]}`,
    );
  }
}

function walkQuiescenceTree(
  directory: string,
  visit: (path: string) => void,
  budget: { remaining: number },
): void {
  if (!existsSync(directory)) return;
  const rootInfo = lstatSync(directory);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
    throw new Error("orchestrator_quiescence_unverified");
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    budget.remaining--;
    if (budget.remaining < 0)
      throw new Error("orchestrator_quiescence_scan_overflow");
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink())
      throw new Error("orchestrator_quiescence_unverified");
    if (entry.isDirectory()) walkQuiescenceTree(path, visit, budget);
    else if (entry.isFile()) visit(path);
  }
}

function assertWorkflowFileQuiescent(path: string): void {
  const raw = readBoundedJson(
    path,
    WORKFLOW_BYTES,
    "orchestrator_quiescence_unverified",
  );
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("orchestrator_quiescence_unverified");
  const tasks = (raw as { tasks?: unknown }).tasks;
  if (!Array.isArray(tasks))
    throw new Error("orchestrator_quiescence_unverified");
  if (
    tasks.some(
      (task) =>
        task &&
        typeof task === "object" &&
        !Array.isArray(task) &&
        (task as { status?: unknown }).status === "running",
    )
  ) {
    throw new Error("orchestrator_active_attempt");
  }
}

function assertTaskFileQuiescent(path: string): void {
  const raw = readBoundedJson(
    path,
    SMALL_STATE_BYTES,
    "orchestrator_quiescence_unverified",
  );
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("orchestrator_quiescence_unverified");
  const task = raw as { status?: unknown; claim?: unknown };
  const terminal = ["completed", "failed", "cancelled"].includes(
    String(task.status),
  );
  if (
    task.status === "running" ||
    task.status === "in_progress" ||
    (!terminal && task.claim !== undefined)
  ) {
    throw new Error("orchestrator_active_attempt");
  }
}

function assertQuiescent(cwd: string): void {
  const stateRoot = join(getOmcRoot(repositoryRoot(cwd)), "state");
  const inspect = (path: string) => {
    const name = basename(path);
    if (
      name.endsWith(".lock") ||
      name.startsWith(".lock-") ||
      name.endsWith("-lock")
    ) {
      throw new Error("orchestrator_workflow_locked");
    }
    if (name === "workflow.json") assertWorkflowFileQuiescent(path);
    if (/^task-[^.]+\.json$/.test(name) && basename(dirname(path)) === "tasks")
      assertTaskFileQuiescent(path);
  };
  const budget = { remaining: MAX_QUIESCENCE_ENTRIES };
  walkQuiescenceTree(join(stateRoot, "team"), inspect, budget);
  walkQuiescenceTree(join(stateRoot, "team-recovery"), inspect, budget);
}

export async function updateOrchestratorRepositoryConfig(
  cwd: string,
  transform: (
    current: OrchestratorRepositoryConfig | null,
  ) => OrchestratorRepositoryConfig | Promise<OrchestratorRepositoryConfig>,
): Promise<OrchestratorRepositoryConfig> {
  return withOperationGate(cwd, async (paths) => {
    assertNoCompetingOmx(paths);
    const state = readRuntimeState(cwd);
    if (state.lease) throw new Error("orchestrator_active_lease");
    assertQuiescent(cwd);
    const current = readOrchestratorRepositoryConfig(cwd);
    const config = parseRepositoryConfig(await transform(current));
    if (
      state.selection &&
      !config.supportedHosts.includes(state.selection.host)
    ) {
      throw new Error("orchestrator_selected_host_not_supported");
    }
    if (current && JSON.stringify(current) === JSON.stringify(config))
      return current;
    await atomicWriteJson(paths.config, config);
    return config;
  });
}

export async function configureOrchestratorRepository(
  cwd: string,
  input: OrchestratorRepositoryConfig,
): Promise<OrchestratorRepositoryConfig> {
  const config = parseRepositoryConfig(input);
  return updateOrchestratorRepositoryConfig(cwd, () => config);
}

export async function selectOrchestrator(
  cwd: string,
  target: OrchestratorHost,
  options: OrchestratorProbeOptions = {},
): Promise<ActiveOrchestratorSnapshot> {
  if (!isHost(target)) throw new Error("orchestrator_invalid_host");
  return withOperationGate(cwd, async (paths) => {
    const config = readOrchestratorRepositoryConfig(cwd);
    if (!config) throw new Error("orchestrator_project_setup_required");
    assertNoCompetingOmx(paths);
    if (!config.supportedHosts.includes(target))
      throw new Error("orchestrator_host_not_supported");
    assertHostAvailable(target, options.probe);
    const state = readRuntimeState(cwd);
    if (state.lease) throw new Error("orchestrator_active_lease");
    assertQuiescent(cwd);
    if (state.selection?.host === target) return activeFrom(config, state);
    const selectedAt = new Date().toISOString();
    const next: OrchestratorRuntimeState = {
      ...state,
      schemaVersion: 1,
      selection: { host: target, revision: randomUUID(), selectedAt },
    };
    await writeRuntimeState(cwd, next);
    return activeFrom(config, next);
  });
}

export function readOrchestratorStatus(
  cwd: string,
  options: OrchestratorProbeOptions = {},
): OrchestratorStatus {
  const paths = resolveOrchestratorPaths(cwd);
  const config = readOrchestratorRepositoryConfig(cwd);
  if (config) assertNoCompetingOmx(paths);
  const state = readRuntimeState(cwd);
  const active = activeFrom(config, state);
  const lease = state.lease
    ? Object.freeze({
        host: state.lease.host,
        sessionId: state.lease.sessionId,
        selectionRevision: state.lease.selectionRevision,
        ownerPid: state.lease.ownerPid,
        acquiredAt: state.lease.acquiredAt,
      })
    : null;
  return Object.freeze({
    active,
    availability: Object.freeze({
      claude: normalizedProbeResult("claude", options.probe),
      codex: normalizedProbeResult("codex", options.probe),
    }),
    lease,
  });
}

export function assertActiveOrchestratorAvailable(
  cwd: string,
  options: OrchestratorProbeOptions = {},
): ActiveOrchestratorSnapshot {
  const active = readActiveOrchestrator(cwd);
  assertHostAvailable(active.host, options.probe);
  return active;
}

export async function acquireOrchestratorLease(
  cwd: string,
  session: OrchestratorSessionIdentity,
): Promise<OrchestratorLeaseCredentials> {
  if (!isHost(session.host)) throw new Error("orchestrator_invalid_host");
  const sessionId = parseSessionId(session.sessionId);
  return withOperationGate(cwd, async (paths) => {
    const config = readOrchestratorRepositoryConfig(cwd);
    if (config) assertNoCompetingOmx(paths);
    const state = readRuntimeState(cwd);
    const active = activeFrom(config, state);
    if (session.host !== active.host)
      throw new Error("orchestrator_session_host_mismatch");
    if (state.lease) throw new Error("orchestrator_active_lease");
    assertQuiescent(cwd);
    const token = randomBytes(32).toString("hex");
    const credentials: OrchestratorLeaseCredentials = Object.freeze({
      host: active.host,
      sessionId,
      leaseId: randomUUID(),
      selectionRevision: active.selectionRevision,
      token,
    });
    const lease: PersistedLease = {
      host: credentials.host,
      sessionId: credentials.sessionId,
      leaseId: credentials.leaseId,
      selectionRevision: credentials.selectionRevision,
      tokenHash: credentialsTokenHash(token),
      ownerPid: process.pid,
      relatedPids: [],
      acquiredAt: new Date().toISOString(),
    };
    await writeRuntimeState(cwd, { ...state, schemaVersion: 1, lease });
    return credentials;
  });
}

/** Register a spawned native host process so explicit crash recovery cannot overtake it. */
export async function registerOrchestratorLeaseProcess(
  cwd: string,
  credentials: OrchestratorLeaseCredentials,
  pid: number,
): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error("orchestrator_invalid_process");
  }
  await withOperationGate(cwd, async (paths) => {
    const config = readOrchestratorRepositoryConfig(cwd);
    if (config) assertNoCompetingOmx(paths);
    const state = readRuntimeState(cwd);
    const active = activeFrom(config, state);
    assertLeaseCredentials(active, state.lease, credentials);
    const lease = state.lease!;
    if (pid === lease.ownerPid || lease.relatedPids.includes(pid)) return;
    if (lease.relatedPids.length >= 32) {
      throw new Error("orchestrator_process_limit_reached");
    }
    await writeRuntimeState(cwd, {
      ...state,
      schemaVersion: 1,
      lease: { ...lease, relatedPids: [...lease.relatedPids, pid] },
    });
  });
}

/** Explicitly clear a crashed lead lease only after every known process is dead and state is quiescent. */
export async function recoverOrchestratorLease(
  cwd: string,
  checkpointInput: OrchestratorCheckpoint,
): Promise<void> {
  const checkpoint = parseCheckpoint(checkpointInput);
  await withOperationGate(cwd, async (paths) => {
    const config = readOrchestratorRepositoryConfig(cwd);
    if (config) assertNoCompetingOmx(paths);
    const state = readRuntimeState(cwd);
    const lease = state.lease;
    if (!lease) throw new Error("orchestrator_lease_not_found");
    if (
      isProcessAlive(lease.ownerPid) ||
      lease.relatedPids.some((pid) => isProcessAlive(pid))
    ) {
      throw new Error("orchestrator_lease_owner_alive");
    }
    assertQuiescent(cwd);
    const lastCheckpoint: OrchestratorCheckpointRecord = {
      host: lease.host,
      sessionId: lease.sessionId,
      selectionRevision: lease.selectionRevision,
      checkpoint,
      at: new Date().toISOString(),
    };
    const { lease: _lease, ...withoutLease } = state;
    await writeRuntimeState(cwd, {
      ...withoutLease,
      schemaVersion: 1,
      lastCheckpoint,
    });
  });
}

export async function releaseOrchestratorLease(
  cwd: string,
  credentials: OrchestratorLeaseCredentials,
  checkpointInput: OrchestratorCheckpoint,
): Promise<void> {
  const checkpoint = parseCheckpoint(checkpointInput);
  await withOperationGate(cwd, async (paths) => {
    const config = readOrchestratorRepositoryConfig(cwd);
    if (config) assertNoCompetingOmx(paths);
    const state = readRuntimeState(cwd);
    const active = activeFrom(config, state);
    assertLeaseCredentials(active, state.lease, credentials);
    assertQuiescent(cwd);
    const lastCheckpoint: OrchestratorCheckpointRecord = {
      host: credentials.host,
      sessionId: credentials.sessionId,
      selectionRevision: credentials.selectionRevision,
      checkpoint,
      at: new Date().toISOString(),
    };
    const { lease: _lease, ...withoutLease } = state;
    await writeRuntimeState(cwd, {
      ...withoutLease,
      schemaVersion: 1,
      lastCheckpoint,
    });
  });
}

export async function handoffOrchestrator(
  cwd: string,
  target: OrchestratorHost,
  options: OrchestratorHandoffOptions,
): Promise<{
  active: ActiveOrchestratorSnapshot;
  handoff: OrchestratorHandoffRecord;
}> {
  if (!isHost(target)) throw new Error("orchestrator_invalid_host");
  const checkpoint = parseCheckpoint(options.checkpoint);
  return withOperationGate(cwd, async (paths) => {
    const config = readOrchestratorRepositoryConfig(cwd);
    if (!config) throw new Error("orchestrator_project_setup_required");
    assertNoCompetingOmx(paths);
    if (!config.supportedHosts.includes(target))
      throw new Error("orchestrator_host_not_supported");
    assertHostAvailable(target, options.probe);
    const state = readRuntimeState(cwd);
    const active = activeFrom(config, state);
    if (active.host === target)
      throw new Error("orchestrator_handoff_same_host");
    assertLeaseCredentials(active, state.lease, options.credentials);
    assertQuiescent(cwd);
    const at = new Date().toISOString();
    const nextRevision = randomUUID();
    const handoff: OrchestratorHandoffRecord = Object.freeze({
      id: randomUUID(),
      from: active.host,
      to: target,
      fromSelectionRevision: active.selectionRevision,
      toSelectionRevision: nextRevision,
      sessionId: options.credentials.sessionId,
      checkpoint,
      at,
    });
    const lastCheckpoint: OrchestratorCheckpointRecord = {
      host: options.credentials.host,
      sessionId: options.credentials.sessionId,
      selectionRevision: options.credentials.selectionRevision,
      checkpoint,
      at,
    };
    const { lease: _lease, ...withoutLease } = state;
    const next: OrchestratorRuntimeState = {
      ...withoutLease,
      schemaVersion: 1,
      selection: { host: target, revision: nextRevision, selectedAt: at },
      lastCheckpoint,
      handoffs: [...(state.handoffs ?? []), handoff],
    };
    await writeRuntimeState(cwd, next);
    return Object.freeze({ active: activeFrom(config, next), handoff });
  });
}

function recordedSessionPath(cwd: string, sessionId: string): string {
  const orchestrator = resolveOrchestratorPaths(cwd);
  const paths = resolveSessionStatePaths(
    `orchestrator-session-${orchestrator.repositoryKey}`,
    sessionId,
    orchestrator.repositoryRoot,
  );
  return paths.sessionScoped;
}

function parseRecordedSession(value: unknown): RecordedOrchestratorSession {
  const raw = exactObject(
    value,
    ["schemaVersion", "host", "sessionId", "selectionRevision", "recordedAt"],
    "orchestrator_invalid_session_state",
  );
  if (raw.schemaVersion !== 1 || !isHost(raw.host))
    throw new Error("orchestrator_invalid_session_state");
  return Object.freeze({
    schemaVersion: 1,
    host: raw.host,
    sessionId: parseSessionId(raw.sessionId),
    selectionRevision: parseRevision(
      raw.selectionRevision,
      "orchestrator_invalid_session_state",
    ),
    recordedAt: parseTimestamp(
      raw.recordedAt,
      "orchestrator_invalid_session_state",
    ),
  });
}

export async function recordOrchestratorSession(
  cwd: string,
  host: OrchestratorHost,
  sessionIdInput: string,
): Promise<RecordedOrchestratorSession> {
  if (!isHost(host)) throw new Error("orchestrator_invalid_host");
  const sessionId = parseSessionId(sessionIdInput);
  return withOrchestratorOperation(cwd, async (active) => {
    if (host !== active.host)
      throw new Error("orchestrator_session_host_mismatch");
    const record: RecordedOrchestratorSession = Object.freeze({
      schemaVersion: 1,
      host,
      sessionId,
      selectionRevision: active.selectionRevision,
      recordedAt: new Date().toISOString(),
    });
    const path = recordedSessionPath(cwd, sessionId);
    if (existsSync(path)) {
      const existing = parseRecordedSession(
        readBoundedJson(
          path,
          SMALL_STATE_BYTES,
          "orchestrator_invalid_session_state",
        ),
      );
      if (
        existing.host !== record.host ||
        existing.selectionRevision !== record.selectionRevision
      ) {
        throw new Error("orchestrator_session_stale_or_cross_host");
      }
      return existing;
    }
    await atomicWriteJson(path, record);
    return record;
  });
}

export function assertOrchestratorSession(
  cwd: string,
  host: OrchestratorHost,
  sessionIdInput: string,
): RecordedOrchestratorSession {
  if (!isHost(host)) throw new Error("orchestrator_invalid_host");
  const sessionId = parseSessionId(sessionIdInput);
  const path = recordedSessionPath(cwd, sessionId);
  if (!existsSync(path)) throw new Error("orchestrator_session_not_registered");
  const record = parseRecordedSession(
    readBoundedJson(
      path,
      SMALL_STATE_BYTES,
      "orchestrator_invalid_session_state",
    ),
  );
  const active = readActiveOrchestrator(cwd);
  if (
    record.host !== host ||
    record.sessionId !== sessionId ||
    record.host !== active.host ||
    record.selectionRevision !== active.selectionRevision
  ) {
    throw new Error("orchestrator_session_stale_or_cross_host");
  }
  return record;
}
