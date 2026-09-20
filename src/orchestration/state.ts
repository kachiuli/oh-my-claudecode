import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  findWorkspaceRoot,
  getGitTopLevel,
  getOmcRoot,
  resolveProjectOmcPath,
} from "../lib/worktree-paths.js";
import type {
  ActiveOrchestratorSnapshot,
  OrchestratorCheckpoint,
  OrchestratorCheckpointKind,
  OrchestratorHandoffRecord,
  OrchestratorHost,
  OrchestratorPaths,
  OrchestratorRepositoryConfig,
  OrchestratorSessionIdentity,
} from "./selection.js";

export interface LocalSelection {
  readonly host: OrchestratorHost;
  readonly revision: string;
  readonly selectedAt: string;
}

export interface PersistedLease extends OrchestratorSessionIdentity {
  readonly leaseId: string;
  readonly selectionRevision: string;
  readonly tokenHash: string;
  readonly ownerPid: number;
  readonly relatedPids: readonly number[];
  readonly acquiredAt: string;
}

export interface OrchestratorCheckpointRecord extends OrchestratorSessionIdentity {
  readonly selectionRevision: string;
  readonly checkpoint: OrchestratorCheckpoint;
  readonly at: string;
}

export interface OrchestratorRuntimeState {
  readonly schemaVersion: 1;
  readonly selection?: LocalSelection;
  readonly lease?: PersistedLease;
  readonly lastCheckpoint?: OrchestratorCheckpointRecord;
  readonly handoffs?: readonly OrchestratorHandoffRecord[];
}

export interface RecordedOrchestratorSession extends OrchestratorSessionIdentity {
  readonly schemaVersion: 1;
  readonly selectionRevision: string;
  readonly recordedAt: string;
}

const HOSTS = ["claude", "codex"] as const;
const CONFIG_BYTES = 16 * 1024;
const STATE_BYTES = 4 * 1024 * 1024;
const MAX_HANDOFFS = 10_000;
const LEGACY_REVISION = createHash("sha256")
  .update("omc-orchestrator:legacy:claude:v1")
  .digest("hex");

export function isHost(value: unknown): value is OrchestratorHost {
  return HOSTS.some((host) => host === value);
}

export function exactObject(
  value: unknown,
  keys: readonly string[],
  error: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(error);
  }
  const object = value as Record<string, unknown>;
  if (Object.keys(object).some((key) => !keys.includes(key))) {
    throw new Error(error);
  }
  return object;
}

export function boundedText(
  value: unknown,
  max: number,
  error: string,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > max ||
    /[\0\r\n]/.test(value)
  ) {
    throw new Error(error);
  }
  return value;
}

export function parseTimestamp(value: unknown, error: string): string {
  const timestamp = boundedText(value, 64, error);
  if (!Number.isFinite(Date.parse(timestamp))) throw new Error(error);
  return timestamp;
}

export function parseRevision(value: unknown, error: string): string {
  const revision = boundedText(value, 64, error);
  if (
    !/^(?:[a-f0-9]{64}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/.test(
      revision,
    )
  ) {
    throw new Error(error);
  }
  return revision;
}

export function parseUuid(value: unknown, error: string): string {
  const id = boundedText(value, 36, error);
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)) {
    throw new Error(error);
  }
  return id;
}

export function parseSessionId(value: unknown): string {
  const sessionId = boundedText(value, 256, "orchestrator_invalid_session");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/.test(sessionId)) {
    throw new Error("orchestrator_invalid_session");
  }
  return sessionId;
}

export function parseCheckpoint(value: unknown): OrchestratorCheckpoint {
  const raw = exactObject(
    value,
    ["kind", "workflowName", "reference"],
    "orchestrator_invalid_checkpoint",
  );
  if (
    !["before-work", "completed-stage", "paused", "checkpointed"].includes(
      String(raw.kind),
    )
  ) {
    throw new Error("orchestrator_invalid_checkpoint");
  }
  return Object.freeze({
    kind: raw.kind as OrchestratorCheckpointKind,
    ...(raw.workflowName === undefined
      ? {}
      : {
          workflowName: boundedText(
            raw.workflowName,
            160,
            "orchestrator_invalid_checkpoint",
          ),
        }),
    ...(raw.reference === undefined
      ? {}
      : {
          reference: boundedText(
            raw.reference,
            500,
            "orchestrator_invalid_checkpoint",
          ),
        }),
  });
}

export function readBoundedJson(
  filePath: string,
  maxBytes: number,
  error: string,
): unknown {
  let info;
  try {
    info = lstatSync(filePath);
  } catch {
    throw new Error(error);
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) {
    throw new Error(error);
  }
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  } catch {
    throw new Error(error);
  }
}

export function repositoryRoot(cwd: string): string {
  let root: string;
  try {
    root = realpathSync(resolve(cwd));
  } catch {
    throw new Error("orchestrator_invalid_working_directory");
  }
  // Repository-owned configuration, installed assets, and native launch cwd stay with the
  // physical checkout. A parent workspace marker may relocate shared runtime state only.
  return getGitTopLevel(root) ?? findWorkspaceRoot(root) ?? root;
}

function repositoryStateKey(root: string): string {
  return createHash("sha256").update(root).digest("hex");
}

export function resolveOrchestratorPaths(cwd: string): OrchestratorPaths {
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

export function parseRepositoryConfig(
  value: unknown,
): OrchestratorRepositoryConfig {
  const raw = exactObject(
    value,
    ["schemaVersion", "supportedHosts", "defaultHost"],
    "orchestrator_invalid_config",
  );
  if (
    raw.schemaVersion !== 1 ||
    !Array.isArray(raw.supportedHosts) ||
    raw.supportedHosts.length < 1 ||
    raw.supportedHosts.length > HOSTS.length
  ) {
    throw new Error("orchestrator_invalid_config");
  }
  const supportedHosts = raw.supportedHosts.map((host) => {
    if (!isHost(host)) throw new Error("orchestrator_invalid_config");
    return host;
  });
  if (new Set(supportedHosts).size !== supportedHosts.length) {
    throw new Error("orchestrator_invalid_config");
  }
  if (
    raw.defaultHost !== undefined &&
    (!isHost(raw.defaultHost) || !supportedHosts.includes(raw.defaultHost))
  ) {
    throw new Error("orchestrator_invalid_config");
  }
  return Object.freeze({
    schemaVersion: 1,
    supportedHosts: Object.freeze([...supportedHosts]),
    ...(raw.defaultHost === undefined ? {} : { defaultHost: raw.defaultHost }),
  });
}

export function readOrchestratorRepositoryConfig(
  cwd: string,
): OrchestratorRepositoryConfig | null {
  const path = resolveOrchestratorPaths(cwd).config;
  if (!existsSync(path)) return null;
  return parseRepositoryConfig(
    readBoundedJson(path, CONFIG_BYTES, "orchestrator_invalid_config"),
  );
}

function parseLocalSelection(value: unknown): LocalSelection {
  const raw = exactObject(
    value,
    ["host", "revision", "selectedAt"],
    "orchestrator_invalid_state",
  );
  if (!isHost(raw.host)) throw new Error("orchestrator_invalid_state");
  return Object.freeze({
    host: raw.host,
    revision: parseRevision(raw.revision, "orchestrator_invalid_state"),
    selectedAt: parseTimestamp(raw.selectedAt, "orchestrator_invalid_state"),
  });
}

function parseLease(value: unknown): PersistedLease {
  const raw = exactObject(
    value,
    [
      "host",
      "sessionId",
      "leaseId",
      "selectionRevision",
      "tokenHash",
      "ownerPid",
      "relatedPids",
      "acquiredAt",
    ],
    "orchestrator_invalid_state",
  );
  if (!isHost(raw.host)) throw new Error("orchestrator_invalid_state");
  const tokenHash = boundedText(
    raw.tokenHash,
    64,
    "orchestrator_invalid_state",
  );
  if (!/^[a-f0-9]{64}$/.test(tokenHash)) {
    throw new Error("orchestrator_invalid_state");
  }
  if (
    !Number.isSafeInteger(raw.ownerPid) ||
    Number(raw.ownerPid) <= 0 ||
    !Array.isArray(raw.relatedPids) ||
    raw.relatedPids.length > 32 ||
    raw.relatedPids.some(
      (pid) => !Number.isSafeInteger(pid) || Number(pid) <= 0,
    ) ||
    new Set(raw.relatedPids).size !== raw.relatedPids.length
  ) {
    throw new Error("orchestrator_invalid_state");
  }
  return Object.freeze({
    host: raw.host,
    sessionId: parseSessionId(raw.sessionId),
    leaseId: parseUuid(raw.leaseId, "orchestrator_invalid_state"),
    selectionRevision: parseRevision(
      raw.selectionRevision,
      "orchestrator_invalid_state",
    ),
    tokenHash,
    ownerPid: Number(raw.ownerPid),
    relatedPids: Object.freeze(raw.relatedPids.map(Number)),
    acquiredAt: parseTimestamp(raw.acquiredAt, "orchestrator_invalid_state"),
  });
}

function parseCheckpointRecord(value: unknown): OrchestratorCheckpointRecord {
  const raw = exactObject(
    value,
    ["host", "sessionId", "selectionRevision", "checkpoint", "at"],
    "orchestrator_invalid_state",
  );
  if (!isHost(raw.host)) throw new Error("orchestrator_invalid_state");
  return Object.freeze({
    host: raw.host,
    sessionId: parseSessionId(raw.sessionId),
    selectionRevision: parseRevision(
      raw.selectionRevision,
      "orchestrator_invalid_state",
    ),
    checkpoint: parseCheckpoint(raw.checkpoint),
    at: parseTimestamp(raw.at, "orchestrator_invalid_state"),
  });
}

function parseHandoff(value: unknown): OrchestratorHandoffRecord {
  const raw = exactObject(
    value,
    [
      "id",
      "from",
      "to",
      "fromSelectionRevision",
      "toSelectionRevision",
      "sessionId",
      "checkpoint",
      "at",
    ],
    "orchestrator_invalid_state",
  );
  if (!isHost(raw.from) || !isHost(raw.to) || raw.from === raw.to) {
    throw new Error("orchestrator_invalid_state");
  }
  return Object.freeze({
    id: parseUuid(raw.id, "orchestrator_invalid_state"),
    from: raw.from,
    to: raw.to,
    fromSelectionRevision: parseRevision(
      raw.fromSelectionRevision,
      "orchestrator_invalid_state",
    ),
    toSelectionRevision: parseRevision(
      raw.toSelectionRevision,
      "orchestrator_invalid_state",
    ),
    sessionId: parseSessionId(raw.sessionId),
    checkpoint: parseCheckpoint(raw.checkpoint),
    at: parseTimestamp(raw.at, "orchestrator_invalid_state"),
  });
}

export function readRuntimeState(cwd: string): OrchestratorRuntimeState {
  const path = resolveOrchestratorPaths(cwd).state;
  if (!existsSync(path)) return Object.freeze({ schemaVersion: 1 });
  const raw = exactObject(
    readBoundedJson(path, STATE_BYTES, "orchestrator_invalid_state"),
    ["schemaVersion", "selection", "lease", "lastCheckpoint", "handoffs"],
    "orchestrator_invalid_state",
  );
  if (raw.schemaVersion !== 1) throw new Error("orchestrator_invalid_state");
  if (
    raw.handoffs !== undefined &&
    (!Array.isArray(raw.handoffs) || raw.handoffs.length > MAX_HANDOFFS)
  ) {
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
    ...(raw.handoffs === undefined
      ? {}
      : { handoffs: Object.freeze(raw.handoffs.map(parseHandoff)) }),
  });
}

export function assertRuntimeStateWritable(
  state: OrchestratorRuntimeState,
): void {
  if ((state.handoffs?.length ?? 0) > MAX_HANDOFFS) {
    throw new Error("orchestrator_state_limit_reached");
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(state, null, 2);
  } catch {
    throw new Error("orchestrator_invalid_state");
  }
  if (Buffer.byteLength(serialized, "utf8") > STATE_BYTES) {
    throw new Error("orchestrator_state_limit_reached");
  }
}

function selectionRevision(config: OrchestratorRepositoryConfig): string {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}

export function assertNoCompetingOmx(paths: OrchestratorPaths): void {
  const roots = new Set([
    paths.repositoryRoot,
    findWorkspaceRoot(paths.repositoryRoot),
  ]);
  for (const root of roots) {
    if (!root) continue;
    const omxRoot = join(root, ".omx");
    if (
      existsSync(join(omxRoot, "state")) ||
      existsSync(join(omxRoot, "setup-scope.json"))
    ) {
      throw new Error(
        "orchestrator_competing_omx_state_requires_explicit_import",
      );
    }
  }
}

export function activeFrom(
  config: OrchestratorRepositoryConfig | null,
  state: OrchestratorRuntimeState,
): ActiveOrchestratorSnapshot {
  if (!config) {
    return Object.freeze({
      host: "claude",
      source: "legacy",
      supportedHosts: Object.freeze(["claude"] as OrchestratorHost[]),
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
  const host =
    config.defaultHost ??
    (config.supportedHosts.length === 1 ? config.supportedHosts[0] : undefined);
  if (!host) throw new Error("orchestrator_selection_required");
  return Object.freeze({
    host,
    source: config.defaultHost ? "default" : "sole-supported",
    supportedHosts: config.supportedHosts,
    selectionRevision: selectionRevision(config),
    adopted: true,
  });
}
