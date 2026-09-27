/** Read-only evidence collection shared by workflow inspection and recovery. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { expandPathForCompare } from "../lib/worktree-paths.js";
import type { ArtifactDescriptor } from "../shared/artifact-descriptor.js";
import { validateResolvedPath } from "./fs-utils.js";
import { getBranchName, getWorktreePath } from "./git-worktree.js";
import {
  matchesScope,
  type VersionedWorkflowState,
  type WorkflowTaskState,
} from "./workflow-contracts.js";
import { classifyOrphanedAttempt } from "./workflow-orphan.js";
import { teamStateRoot } from "./state-paths.js";

const MAX_GIT_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_CHANGED_FILES = 100;
const MAX_REF_AUDIT_BYTES = 512 * 1024;

export type WorkflowTaskInspectionClassification =
  | "recoverable-completed-handoff"
  | "dirty-partial"
  | "failed"
  | "missing"
  | "active"
  | "unverifiable";

export type WorkflowTaskInspectionNextAction =
  | "revalidate"
  | "preserve-and-inspect"
  | "retry-or-reject"
  | "wait"
  | "inspect"
  | "none";

export interface WorkflowTaskInspection {
  classification: WorkflowTaskInspectionClassification;
  nextAction: WorkflowTaskInspectionNextAction;
  /** Digest of every ref name and target observed by this inspection; ref names are never returned. */
  expectedRefsDigest: string | null;
  savedHead: string | null;
  observedHead: string | null;
  clean: boolean;
  registered: boolean;
}

interface GitResult {
  ok: boolean;
  output: string;
}

interface WorktreeObservation {
  exists: boolean;
  mappingMatches: boolean;
  observable: boolean;
  registered: boolean;
  clean: boolean;
  head: string | null;
  branchMatches: boolean;
  topLevelMatches: boolean;
}

function git(cwd: string, args: string[]): GitResult {
  try {
    return {
      ok: true,
      output: execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        stdio: "pipe",
        timeout: 30_000,
        windowsHide: true,
        maxBuffer: MAX_GIT_OUTPUT_BYTES,
      }),
    };
  } catch {
    return { ok: false, output: "" };
  }
}

function comparablePath(path: string): string {
  return expandPathForCompare(path) ?? resolve(path);
}

export function workflowRefsDigest(cwd: string): string | null {
  const result = git(cwd, [
    "for-each-ref",
    "--sort=refname",
    "--format=%(refname)%00%(objectname)",
  ]);
  if (!result.ok) return null;
  const records: Array<readonly [string, string]> = [];
  for (const line of result.output.split("\n")) {
    if (!line) continue;
    const separator = line.indexOf("\0");
    const ref = line.slice(0, separator);
    const object = line.slice(separator + 1).trim();
    if (separator <= 0 || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(object))
      return null;
    records.push([ref, object]);
  }
  records.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  const digest = createHash("sha256");
  for (const [ref, object] of records) {
    digest.update(String(Buffer.byteLength(ref)));
    digest.update(":");
    digest.update(ref);
    digest.update("\0");
    digest.update(object);
    digest.update("\n");
  }
  return digest.digest("hex");
}

function cleanWorktree(output: string): boolean {
  return output
    .split("\n")
    .every((line) => !line || /^\?\? \.omc\//.test(line));
}

function observeWorktree(
  state: VersionedWorkflowState,
  entry: WorkflowTaskState,
): WorktreeObservation {
  const expected = getWorktreePath(state.cwd, state.plan.name, entry.worker);
  const expectedBranch = getBranchName(state.plan.name, entry.worker);
  const mappingMatches =
    entry.worktree !== undefined &&
    resolve(entry.worktree) === resolve(expected) &&
    entry.branch === expectedBranch;
  try {
    validateResolvedPath(
      expected,
      join(teamStateRoot(state.cwd, ""), "..", "..", "team"),
    );
  } catch {
    return {
      exists: existsSync(expected),
      mappingMatches,
      observable: false,
      registered: false,
      clean: false,
      head: null,
      branchMatches: false,
      topLevelMatches: false,
    };
  }
  if (!existsSync(expected)) {
    return {
      exists: false,
      mappingMatches,
      observable: false,
      registered: false,
      clean: false,
      head: null,
      branchMatches: false,
      topLevelMatches: false,
    };
  }

  const worktrees = git(state.cwd, ["worktree", "list", "--porcelain"]);
  const head = git(expected, ["rev-parse", "--verify", "HEAD^{commit}"]);
  const branch = git(expected, ["branch", "--show-current"]);
  const topLevel = git(expected, ["rev-parse", "--show-toplevel"]);
  const status = git(expected, [
    "status",
    "--porcelain",
    "--untracked-files=all",
  ]);
  const canonicalExpected = comparablePath(expected);
  const registered =
    worktrees.ok &&
    worktrees.output
      .split("\n")
      .some(
        (line) =>
          line.startsWith("worktree ") &&
          comparablePath(line.slice("worktree ".length).trim()) ===
            canonicalExpected,
      );
  return {
    exists: true,
    mappingMatches,
    observable:
      worktrees.ok && head.ok && branch.ok && topLevel.ok && status.ok,
    registered,
    clean: status.ok && cleanWorktree(status.output),
    head: head.ok ? head.output.trim() : null,
    branchMatches: branch.ok && branch.output.trim() === expectedBranch,
    topLevelMatches:
      topLevel.ok &&
      comparablePath(topLevel.output.trim()) === canonicalExpected,
  };
}

function hasExactCheckEvidence(entry: WorkflowTaskState): boolean {
  const handoff = entry.handoff;
  if (
    !handoff ||
    handoff.outcome !== "completed" ||
    handoff.tests.some((test) => !test.passed)
  )
    return false;
  return entry.task.tests.every((expected) =>
    handoff.tests.some(
      (observed) =>
        observed.passed &&
        observed.command === expected.command &&
        JSON.stringify(observed.args) === JSON.stringify(expected.args),
    ),
  );
}

function hasExactCommitEvidence(
  state: VersionedWorkflowState,
  entry: WorkflowTaskState,
  observation: WorktreeObservation,
): boolean {
  const savedHead = entry.handoff?.commitSha;
  if (
    !savedHead ||
    observation.head !== savedHead ||
    !observation.mappingMatches ||
    !observation.registered ||
    !observation.branchMatches ||
    !observation.topLevelMatches
  )
    return false;
  const expected = getWorktreePath(state.cwd, state.plan.name, entry.worker);
  const parents = git(expected, [
    "rev-list",
    "--parents",
    "-n",
    "1",
    savedHead,
  ]);
  if (!parents.ok) return false;
  const parentParts = parents.output.trim().split(" ");
  if (
    parentParts.length !== 2 ||
    parentParts[0] !== savedHead ||
    parentParts[1] !== entry.task.baseCommit
  )
    return false;
  const changed = git(expected, [
    "diff",
    "--name-only",
    "--no-renames",
    "-z",
    entry.task.baseCommit,
    savedHead,
  ]);
  if (!changed.ok) return false;
  const files = changed.output.split("\0").filter(Boolean);
  if (files.length === 0 || files.length > MAX_CHANGED_FILES) return false;
  if (
    files.some(
      (file) =>
        !matchesScope(file, entry.task.writeScope) ||
        matchesScope(file, entry.task.prohibitedScope),
    )
  )
    return false;
  return (
    JSON.stringify([...files].sort()) ===
    JSON.stringify([...entry.handoff!.changedFiles].sort())
  );
}

function exactHash(value: unknown): value is string {
  return (
    typeof value === "string" && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value)
  );
}

function validRefAuditChange(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const change = value as Record<string, unknown>;
  return (
    typeof change.ref === "string" &&
    change.ref.startsWith("refs/") &&
    (change.before === null || exactHash(change.before)) &&
    (change.after === null || exactHash(change.after)) &&
    [
      "provider-start",
      "provider-complete",
      "controller-replay",
      "post-run",
    ].includes(String(change.firstObservedPhase)) &&
    Number.isSafeInteger(change.activeProviders) &&
    Number(change.activeProviders) >= 0 &&
    Number.isSafeInteger(change.completedProviders) &&
    Number(change.completedProviders) >= 0 &&
    Number.isSafeInteger(change.transitions) &&
    Number(change.transitions) >= 1
  );
}

function readProtectedRefAudit(
  state: VersionedWorkflowState,
  descriptor: ArtifactDescriptor,
): unknown | null {
  try {
    if (
      descriptor.kind !== "workflow-protected-ref-audit" ||
      typeof descriptor.contentHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(descriptor.contentHash) ||
      !Number.isSafeInteger(descriptor.sizeBytes) ||
      Number(descriptor.sizeBytes) < 1 ||
      Number(descriptor.sizeBytes) > MAX_REF_AUDIT_BYTES
    )
      return null;
    const artifactRoot = realpathSync(
      join(teamStateRoot(state.cwd, state.plan.name), "artifacts"),
    );
    const path = resolve(descriptor.path);
    if (realpathSync(dirname(path)) !== artifactRoot) return null;
    const info = lstatSync(path);
    if (
      info.isSymbolicLink() ||
      !info.isFile() ||
      info.nlink !== 1 ||
      info.size !== descriptor.sizeBytes
    )
      return null;
    const bytes = readFileSync(path);
    if (
      bytes.length !== descriptor.sizeBytes ||
      createHash("sha256").update(bytes).digest("hex") !==
        descriptor.contentHash
    )
      return null;
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    return null;
  }
}

/** Accept only intact, bounded unknown-writer evidence for the explicit protected-ref exception. */
export function hasRecoverableProtectedRefAudit(
  state: VersionedWorkflowState,
  entry: WorkflowTaskState,
): boolean {
  if (entry.error !== "workflow_protected_refs_changed") return false;
  const descriptors =
    entry.handoff?.artifacts.filter(
      (artifact) => artifact.kind === "workflow-protected-ref-audit",
    ) ?? [];
  if (descriptors.length !== 1) return false;
  const value = readProtectedRefAudit(state, descriptors[0]!);
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const audit = value as Record<string, unknown>;
  if (
    audit.schemaVersion !== 1 ||
    audit.kind !== "workflow-protected-ref-audit" ||
    audit.writer !== "unknown" ||
    audit.outcome !== "protected-refs-changed" ||
    audit.overflow !== false ||
    !Array.isArray(audit.changes) ||
    audit.changes.length < 1 ||
    audit.changes.length > 32 ||
    !audit.changes.every(validRefAuditChange)
  )
    return false;
  const names = audit.changes.map(
    (change) => (change as Record<string, unknown>).ref,
  );
  return new Set(names).size === names.length;
}

function result(
  classification: WorkflowTaskInspectionClassification,
  nextAction: WorkflowTaskInspectionNextAction,
  refsDigest: string | null,
  savedHead: string | null,
  observation?: WorktreeObservation,
): WorkflowTaskInspection {
  return {
    classification,
    nextAction,
    expectedRefsDigest: refsDigest,
    savedHead,
    observedHead: observation?.head ?? null,
    clean: observation?.clean ?? false,
    registered: observation?.registered ?? false,
  };
}

const BLOCKED_RECOVERY_ERRORS = new Set([
  "workflow_worker_modified_protected_refs",
  "workflow_protected_ref_audit_failed",
  "workflow_session_identity_mismatch",
]);

/** A state-based seam avoids a workflow-controller import cycle during locked recovery. */
export function inspectWorkflowTaskState(
  state: VersionedWorkflowState,
  taskId: string,
): WorkflowTaskInspection {
  const refsDigest = workflowRefsDigest(state.cwd);
  const entry = state.tasks.find((candidate) => candidate.task.id === taskId);
  if (!entry) return result("missing", "none", refsDigest, null);

  const savedHead = entry.handoff?.commitSha ?? null;
  if (
    entry.status === "running" ||
    entry.invocations?.at(-1)?.error === "workflow_invocation_incomplete"
  ) {
    const process = classifyOrphanedAttempt(entry);
    if (process === "provider-alive" || process === "controller-alive")
      return result("active", "wait", refsDigest, savedHead);
    if (process === "unverifiable")
      return result("unverifiable", "inspect", refsDigest, savedHead);
    return result("failed", "retry-or-reject", refsDigest, savedHead);
  }

  const observation = observeWorktree(state, entry);
  if (!observation.exists)
    return result("missing", "inspect", refsDigest, savedHead, observation);
  if (
    !observation.observable ||
    !observation.mappingMatches ||
    !observation.registered
  )
    return result(
      "unverifiable",
      "inspect",
      refsDigest,
      savedHead,
      observation,
    );
  if (!observation.clean)
    return result(
      "dirty-partial",
      "preserve-and-inspect",
      refsDigest,
      savedHead,
      observation,
    );
  if (entry.handoff?.outcome !== "completed" || !hasExactCheckEvidence(entry))
    return result(
      "failed",
      "retry-or-reject",
      refsDigest,
      savedHead,
      observation,
    );
  const protectedRefsAllowed =
    entry.error !== "workflow_protected_refs_changed" ||
    hasRecoverableProtectedRefAudit(state, entry);
  if (
    entry.status !== "failed" ||
    refsDigest === null ||
    BLOCKED_RECOVERY_ERRORS.has(entry.error ?? "") ||
    !protectedRefsAllowed ||
    !hasExactCommitEvidence(state, entry, observation)
  )
    return result(
      "failed",
      "retry-or-reject",
      refsDigest,
      savedHead,
      observation,
    );
  return result(
    "recoverable-completed-handoff",
    "revalidate",
    refsDigest,
    savedHead,
    observation,
  );
}
