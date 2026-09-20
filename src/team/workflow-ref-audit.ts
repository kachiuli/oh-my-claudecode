import { execFileSync, spawnSync } from "node:child_process";
import type { ArtifactDescriptor } from "../shared/artifact-descriptor.js";
import { writeTextArtifact } from "../shared/artifact-descriptor.js";

const MAX_RECORDED_CHANGES = 32;
const MAX_REF_OUTPUT_BYTES = 4 * 1024 * 1024;

export type WorkflowRefPhase =
  | "provider-start"
  | "provider-complete"
  | "controller-replay"
  | "post-run";

interface RefSnapshot {
  refs: Map<string, string>;
  rootHead: string;
  rootTree: string;
}

interface RefChange {
  ref: string;
  before: string | null;
  after: string | null;
  firstObservedPhase: WorkflowRefPhase;
  activeProviders: number;
  completedProviders: number;
  transitions: number;
}

export interface WorkflowWorkerRefEvidence {
  worker: string;
  commitSha?: string;
}

export interface WorkflowRefAuditResult {
  outcome:
    | "unchanged"
    | "allowed-external-checkpoint"
    | "protected-refs-changed";
  artifact?: ArtifactDescriptor;
}

function git(cwd: string, args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: "pipe",
      timeout: 30_000,
      windowsHide: true,
      maxBuffer: MAX_REF_OUTPUT_BYTES,
    }).trim();
  } catch {
    throw new Error("workflow_protected_ref_audit_failed");
  }
}

function snapshot(cwd: string, workflowName: string): RefSnapshot {
  const refs = new Map<string, string>();
  const output = git(cwd, [
    "for-each-ref",
    "--format=%(refname)%00%(objectname)",
  ]);
  for (const line of output.split("\n")) {
    if (!line) continue;
    const separator = line.indexOf("\0");
    if (separator <= 0) throw new Error("workflow_protected_ref_audit_failed");
    const ref = line.slice(0, separator);
    const object = line.slice(separator + 1);
    if (ref.startsWith(`refs/heads/omc-team/${workflowName}/`)) continue;
    if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(object))
      throw new Error("workflow_protected_ref_audit_failed");
    refs.set(ref, object);
  }
  return {
    refs,
    rootHead: git(cwd, ["rev-parse", "HEAD"]),
    rootTree: git(cwd, ["rev-parse", "HEAD^{tree}"]),
  };
}

function checkpointShape(ref: string): boolean {
  return (
    /^refs\/codex\/turn-diffs\/checkpoints\/[A-Za-z0-9][A-Za-z0-9._/-]{0,239}$/.test(
      ref,
    ) &&
    !ref.includes("..") &&
    !ref.includes("//") &&
    !ref.includes("@{") &&
    !ref.endsWith(".") &&
    !ref.endsWith(".lock")
  );
}

/** Phase-aware, bounded protected-ref audit. Exact ref evidence stays in a local artifact. */
export class WorkflowRefAudit {
  private readonly baseline: RefSnapshot;
  private previous: RefSnapshot;
  private readonly changes = new Map<string, RefChange>();
  private overflow = false;
  private activeProviders = 0;
  private completedProviders = 0;
  private readonly providerWorkers = new Set<string>();

  constructor(
    private readonly cwd: string,
    private readonly workflowName: string,
  ) {
    this.baseline = snapshot(cwd, workflowName);
    this.previous = this.baseline;
  }

  providerStarted(worker: string): void {
    this.providerWorkers.add(worker);
    this.activeProviders++;
    this.observe("provider-start");
  }

  providerCompleted(worker: string): void {
    if (!this.providerWorkers.has(worker))
      throw new Error("workflow_protected_ref_audit_failed");
    if (this.activeProviders <= 0)
      throw new Error("workflow_protected_ref_audit_failed");
    this.activeProviders--;
    this.completedProviders++;
    this.observe("provider-complete");
  }

  controllerReplayCompleted(): void {
    this.observe("controller-replay");
  }

  private observe(phase: WorkflowRefPhase): void {
    const current = snapshot(this.cwd, this.workflowName);
    const names = new Set([
      ...this.previous.refs.keys(),
      ...current.refs.keys(),
    ]);
    for (const ref of names) {
      const before = this.previous.refs.get(ref) ?? null;
      const after = current.refs.get(ref) ?? null;
      if (before === after) continue;
      const recorded = this.changes.get(ref);
      if (recorded) {
        recorded.after = after;
        recorded.transitions++;
      } else if (this.changes.size < MAX_RECORDED_CHANGES) {
        this.changes.set(ref, {
          ref,
          before: this.baseline.refs.get(ref) ?? null,
          after,
          firstObservedPhase: phase,
          activeProviders: this.activeProviders,
          completedProviders: this.completedProviders,
          transitions: 1,
        });
      } else {
        this.overflow = true;
      }
    }
    this.previous = current;
  }

  private objectTree(object: string): string | undefined {
    try {
      if (git(this.cwd, ["cat-file", "-t", object]) !== "commit")
        return undefined;
      return git(this.cwd, ["rev-parse", `${object}^{tree}`]);
    } catch {
      return undefined;
    }
  }

  private relatedToWorker(object: string, workerCommit: string): boolean {
    if (object === this.baseline.rootHead) return false;
    const ancestor = (left: string, right: string): boolean => {
      const result = spawnSync(
        "git",
        ["merge-base", "--is-ancestor", left, right],
        {
          cwd: this.cwd,
          stdio: "ignore",
          timeout: 30_000,
          windowsHide: true,
        },
      );
      if (!result.error && result.status === 0) return true;
      if (!result.error && result.status === 1) return false;
      throw new Error("workflow_protected_ref_audit_failed");
    };
    try {
      return ancestor(object, workerCommit) || ancestor(workerCommit, object);
    } catch {
      return true;
    }
  }

  private allowsExternalCheckpoint(
    workers: readonly WorkflowWorkerRefEvidence[],
  ): boolean {
    if (this.overflow || this.changes.size === 0) return false;
    if (
      this.previous.rootHead !== this.baseline.rootHead ||
      this.previous.rootTree !== this.baseline.rootTree
    )
      return false;
    const byWorker = new Map(
      workers.map((worker) => [worker.worker, worker.commitSha]),
    );
    if ([...this.providerWorkers].some((worker) => !byWorker.get(worker)))
      return false;
    const workerCommits = new Set(
      [...this.providerWorkers].map((worker) => byWorker.get(worker)!),
    );
    const workerTrees = new Set<string>();
    for (const commit of workerCommits) {
      const tree = this.objectTree(commit);
      if (!tree) return false;
      workerTrees.add(tree);
    }
    for (const change of this.changes.values()) {
      if (
        change.before !== null ||
        change.after === null ||
        change.transitions !== 1 ||
        change.firstObservedPhase !== "controller-replay" ||
        change.activeProviders !== 0 ||
        change.completedProviders < 1 ||
        !checkpointShape(change.ref) ||
        this.previous.refs.get(change.ref) !== change.after
      )
        return false;
      const tree = this.objectTree(change.after);
      if (
        !tree ||
        tree !== this.baseline.rootTree ||
        workerCommits.has(change.after) ||
        workerTrees.has(tree) ||
        [...workerCommits].some((commit) =>
          this.relatedToWorker(change.after!, commit),
        )
      )
        return false;
    }
    return true;
  }

  finalize(
    artifactPath: () => string,
    workers: readonly WorkflowWorkerRefEvidence[],
  ): WorkflowRefAuditResult {
    this.observe("post-run");
    if (this.changes.size === 0 && !this.overflow)
      return { outcome: "unchanged" };
    const allowed = this.allowsExternalCheckpoint(workers);
    const body =
      JSON.stringify(
        {
          schemaVersion: 1,
          kind: "workflow-protected-ref-audit",
          writer: "unknown",
          outcome: allowed
            ? "allowed-external-checkpoint"
            : "protected-refs-changed",
          overflow: this.overflow,
          root: {
            before: {
              head: this.baseline.rootHead,
              tree: this.baseline.rootTree,
            },
            after: {
              head: this.previous.rootHead,
              tree: this.previous.rootTree,
            },
          },
          changes: [...this.changes.values()],
        },
        null,
        2,
      ) + "\n";
    const artifact = writeTextArtifact({
      path: artifactPath(),
      content: body,
      exclusive: true,
      kind: "workflow-protected-ref-audit",
      producer: { system: "omc", component: "team-workflow" },
      retention: "until-completion",
    });
    return {
      outcome: allowed
        ? "allowed-external-checkpoint"
        : "protected-refs-changed",
      artifact,
    };
  }
}
