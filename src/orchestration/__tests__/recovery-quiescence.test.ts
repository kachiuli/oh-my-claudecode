import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearWorktreeCache, getOmcRoot } from "../../lib/worktree-paths.js";
import { currentProcessStartIdentity } from "../../team/team-owner-epoch.js";
import {
  assertOrchestratorQuiescent,
  assertOrchestratorRecoveryQuiescent,
} from "../quiescence.js";
import { resolveOrchestratorPaths } from "../state.js";

interface RecoveryFixture {
  readonly root: string;
  readonly stateRoot: string;
  readonly teamRoot: string;
  readonly repositoryStates: string;
  readonly siblingKey: string;
}

const temporaryDirectories: string[] = [];
const isolatedEnvironmentKeys = [
  "OMC_STATE_DIR",
  "OMC_TEAM_WORKER",
  "OMX_TEAM_WORKER",
  "OMC_TEAM_WORKER_NAME",
  "OMC_TEAM_WORKTREE_PATH",
  "OMC_TEAM_WORKER_CWD",
  "OMC_ORCHESTRATOR_HOST",
  "OMC_ORCHESTRATOR_SELECTION_REVISION",
  "OMC_ORCHESTRATOR_LEASE_ID",
  "OMC_ORCHESTRATOR_LEASE_TOKEN",
  "OMC_ORCHESTRATOR_SESSION_ID",
] as const;
let previousEnvironment: Record<string, string | undefined> = {};

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value), "utf8");
}

function fixtureAt(candidate: string): RecoveryFixture {
  const root = realpathSync(candidate);
  writeFileSync(join(root, ".omc-workspace"), "{}", "utf8");
  process.env.OMC_STATE_DIR = join(root, "central-state");
  clearWorktreeCache();
  const paths = resolveOrchestratorPaths(root);
  const stateRoot = join(getOmcRoot(paths.repositoryRoot), "state");
  const currentKey = paths.repositoryKey;
  const siblingKey = `${currentKey[0] === "a" ? "b" : "a"}`.repeat(64);
  return {
    root,
    stateRoot,
    teamRoot: join(stateRoot, "team", "demo-team"),
    repositoryStates: join(stateRoot, "orchestrator", "repositories"),
    siblingKey,
  };
}

function fixture(): RecoveryFixture {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "omc-recovery-quiescence-")),
  );
  temporaryDirectories.push(root);
  return fixtureAt(root);
}

function worker(operationalState: "active" | "stopped" = "stopped") {
  return {
    name: "worker-1",
    index: 1,
    role: "executor",
    worker_cli: "claude",
    assigned_tasks: [],
    operational_state: operationalState,
  };
}

function teamConfig(operationalState: "active" | "stopped" = "stopped") {
  return {
    name: "demo-team",
    task: "Exercise recovery quiescence",
    agent_type: "claude",
    worker_launch_mode: "prompt",
    worker_count: 1,
    max_workers: 1,
    workers: [worker(operationalState)],
    created_at: "2026-09-21T00:00:00.000Z",
    tmux_session: "demo-team:0",
    next_task_id: 2,
    leader_pane_id: null,
    hud_pane_id: null,
    resize_hook_name: null,
    resize_hook_target: null,
    lifecycle_state: "stopped",
  };
}

function pendingTask() {
  return {
    id: "1",
    subject: "Pending work",
    description: "This task has not been claimed",
    status: "pending",
    owner: "",
    blocks: [],
    blockedBy: [],
    created_at: "2026-09-21T00:00:00.000Z",
  };
}

function heartbeat(status: "polling" | "shutdown" = "polling") {
  return {
    workerName: "worker-1",
    teamName: "demo-team",
    provider: "claude",
    pid: process.pid,
    lastPollAt: new Date().toISOString(),
    consecutiveErrors: 0,
    status,
  };
}

function lease(ownerProcessStartedAt?: string | null) {
  return {
    host: "codex",
    sessionId: "sibling-session",
    leaseId: "11111111-1111-4111-8111-111111111111",
    selectionRevision: "a".repeat(64),
    tokenHash: "b".repeat(64),
    ownerPid: process.pid,
    relatedPids: [],
    ...(ownerProcessStartedAt === undefined ? {} : { ownerProcessStartedAt }),
    relatedProcesses: [],
    processRegistration: "not-started",
    acquiredAt: "2026-09-21T00:00:00.000Z",
  };
}

function differentCurrentProcessIdentity(): string {
  const current = currentProcessStartIdentity();
  expect(current).not.toBeNull();
  const darwin = /^darwin:([1-9]\d*):(\d+)$/.exec(current!);
  const numeric = /^(linux|win32):([1-9]\d*)$/.exec(current!);
  if (darwin) {
    const micros = Number(darwin[2]);
    return micros === 0
      ? `darwin:${Number(darwin[1]) + 1}:0`
      : `darwin:${darwin[1]}:${micros === 999_999 ? micros - 1 : micros + 1}`;
  }
  if (numeric) return `${numeric[1]}:${BigInt(numeric[2]) + 1n}`;
  const separator = current!.indexOf(":");
  return `${current!.slice(0, separator)}:${current!.slice(separator + 1)}-different`;
}

function writeSiblingRuntime(
  testFixture: RecoveryFixture,
  value: unknown,
): string {
  const path = join(
    testFixture.repositoryStates,
    testFixture.siblingKey,
    "runtime.json",
  );
  writeJson(path, value);
  return path;
}

function createDanglingJunction(path: string, root: string): void {
  const target = join(root, `junction-target-${randomUUID()}`);
  mkdirSync(target, { recursive: true });
  mkdirSync(dirname(path), { recursive: true });
  symlinkSync(target, path, "junction");
  rmSync(target, { recursive: true, force: true });
}

function workflowState(status: "pending" | "running" = "pending") {
  const task = {
    id: "one",
    objective: "Exercise recovery quiescence",
    baseCommit: "b".repeat(40),
    writeScope: ["src/one.ts"],
    readScope: [],
    prohibitedScope: [],
    dependencies: [],
    contracts: [],
    acceptanceCriteria: ["Recovery remains conservative"],
    tests: [],
  };
  return {
    schemaVersion: 1,
    profile: "claude-glm-codex",
    cwd: "C:/project",
    integrationHead: "b".repeat(40),
    plan: {
      name: "recovery",
      objective: "Exercise recovery quiescence",
      baseCommit: "b".repeat(40),
      integrationBranch: "integration/recovery",
      tasks: [task],
      verification: [],
    },
    options: {
      mode: "balanced",
      workers: 1,
      maxWorkers: 1,
      maxAttempts: 2,
      maxReviewPasses: 1,
      timeoutMs: 1_000,
      backoffMs: 0,
      glmCommand: "glm",
      codexCommand: "codex",
    },
    tasks: [
      {
        task,
        canonicalId: "1",
        status,
        attempts: 0,
        worker: "task-one",
        updatedAt: "2026-09-21T00:00:00.000Z",
      },
    ],
    stage: "implementation",
    reviewPasses: 0,
    reviews: [],
    createdAt: "2026-09-21T00:00:00.000Z",
    updatedAt: "2026-09-21T00:00:00.000Z",
  };
}

beforeEach(() => {
  previousEnvironment = Object.fromEntries(
    isolatedEnvironmentKeys.map((key) => [key, process.env[key]]),
  );
  for (const key of isolatedEnvironmentKeys) delete process.env[key];
  clearWorktreeCache();
});

afterEach(() => {
  for (const key of isolatedEnvironmentKeys) {
    const value = previousEnvironment[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  clearWorktreeCache();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("orchestrator recovery quiescence", () => {
  it("reads fixture state through a canonical directory alias", () => {
    const container = realpathSync(
      mkdtempSync(join(tmpdir(), "omc-recovery-quiescence-alias-")),
    );
    temporaryDirectories.push(container);
    const actual = join(container, "actual");
    const alias = join(container, "alias");
    mkdirSync(actual);
    symlinkSync(actual, alias, "junction");
    const testFixture = fixtureAt(alias);
    const productionStateRoot = join(
      getOmcRoot(resolveOrchestratorPaths(alias).repositoryRoot),
      "state",
    );
    expect(testFixture.root).toBe(realpathSync(actual));
    expect(testFixture.stateRoot).toBe(productionStateRoot);
    writeJson(
      join(testFixture.teamRoot, "workflow.json"),
      workflowState("running"),
    );

    expect(() => assertOrchestratorRecoveryQuiescent(alias)).toThrow(
      "orchestrator_active_attempt",
    );
  });

  it("refuses a live idle worker while allowing its unclaimed pending task once stopped", () => {
    const testFixture = fixture();
    const config = join(testFixture.teamRoot, "config.json");
    const task = join(testFixture.teamRoot, "tasks", "task-1.json");
    const status = join(
      testFixture.teamRoot,
      "workers",
      "worker-1",
      "status.json",
    );
    writeJson(config, teamConfig("active"));
    writeJson(task, pendingTask());
    writeJson(status, {
      state: "idle",
      updated_at: "2026-09-21T00:00:00.000Z",
    });

    expect(() => assertOrchestratorRecoveryQuiescent(testFixture.root)).toThrow(
      "orchestrator_active_provider",
    );

    writeJson(config, teamConfig("stopped"));
    writeJson(status, {
      state: "done",
      updated_at: "2026-09-21T00:00:00.000Z",
    });
    expect(() =>
      assertOrchestratorRecoveryQuiescent(testFixture.root),
    ).not.toThrow();
  });

  it.each([
    ["without a team config", false],
    ["despite a stopped team config", true],
  ])("detects a live bridge *.heartbeat.json %s", (_name, withConfig) => {
    const testFixture = fixture();
    if (withConfig) {
      writeJson(join(testFixture.teamRoot, "config.json"), teamConfig());
    }
    writeJson(
      join(
        testFixture.stateRoot,
        "team-bridge",
        "demo-team",
        "worker-1.heartbeat.json",
      ),
      heartbeat(),
    );

    expect(() => assertOrchestratorRecoveryQuiescent(testFixture.root)).toThrow(
      "orchestrator_active_provider",
    );
  });

  it.each([
    ["live", () => currentProcessStartIdentity()],
    ["unknown", () => null],
  ])("refuses a %s sibling shared-root lease", (_name, ownerIdentity) => {
    const testFixture = fixture();
    const identity = ownerIdentity();
    if (_name === "live") expect(identity).not.toBeNull();
    writeSiblingRuntime(testFixture, {
      schemaVersion: 1,
      lease: lease(identity),
    });

    expect(() => assertOrchestratorRecoveryQuiescent(testFixture.root)).toThrow(
      "orchestrator_lease_process_not_confirmed_dead",
    );
  });

  it("refuses a legacy sibling lease with unverifiable process registration", () => {
    const testFixture = fixture();
    const {
      relatedProcesses: _related,
      processRegistration: _registration,
      ...legacy
    } = lease();
    writeSiblingRuntime(testFixture, {
      schemaVersion: 1,
      lease: legacy,
    });

    expect(() => assertOrchestratorRecoveryQuiescent(testFixture.root)).toThrow(
      "orchestrator_lease_processes_unverifiable",
    );
  });

  it("accepts a sibling lease whose reused PID has a different start identity", () => {
    const testFixture = fixture();
    writeSiblingRuntime(testFixture, {
      schemaVersion: 1,
      lease: lease(differentCurrentProcessIdentity()),
    });

    expect(() =>
      assertOrchestratorRecoveryQuiescent(testFixture.root),
    ).not.toThrow();
  });

  it("refuses malformed sibling runtime state", () => {
    const testFixture = fixture();
    const runtime = join(
      testFixture.repositoryStates,
      testFixture.siblingKey,
      "runtime.json",
    );
    mkdirSync(dirname(runtime), { recursive: true });
    writeFileSync(runtime, "{not-json", "utf8");

    expect(() => assertOrchestratorRecoveryQuiescent(testFixture.root)).toThrow(
      "orchestrator_invalid_state",
    );
  });

  it.each(["team", "runtime"] as const)(
    "refuses a dangling %s state junction",
    (kind) => {
      const testFixture = fixture();
      const path =
        kind === "team"
          ? join(testFixture.stateRoot, "team")
          : join(
              testFixture.repositoryStates,
              testFixture.siblingKey,
              "runtime.json",
            );
      if (kind === "runtime") mkdirSync(dirname(path), { recursive: true });
      createDanglingJunction(path, testFixture.root);

      expect(() =>
        assertOrchestratorRecoveryQuiescent(testFixture.root),
      ).toThrow(
        kind === "team"
          ? "orchestrator_quiescence_unverified"
          : "orchestrator_invalid_state",
      );
      expect(lstatSync(path).isSymbolicLink()).toBe(true);
    },
  );

  it("refuses a stopped team whose recorded owner is still alive", () => {
    const testFixture = fixture();
    const processStartedAt = currentProcessStartIdentity();
    expect(processStartedAt).not.toBeNull();
    writeJson(join(testFixture.teamRoot, "config.json"), {
      ...teamConfig(),
      runtime_owner_epoch: {
        epoch: 1,
        nonce: randomUUID(),
        pid: process.pid,
        process_started_at: processStartedAt,
        created_at: "2026-09-21T00:00:00.000Z",
      },
    });

    expect(() => assertOrchestratorRecoveryQuiescent(testFixture.root)).toThrow(
      "orchestrator_provider_process_not_confirmed_dead",
    );
  });

  it.each([
    ["running workflow", "orchestrator_active_attempt"],
    ["claimed task", "orchestrator_active_attempt"],
    ["workflow lock", "orchestrator_workflow_locked"],
  ])("refuses an active %s", (kind, error) => {
    const testFixture = fixture();
    const workflow = join(testFixture.teamRoot, "workflow.json");
    if (kind === "running workflow") {
      writeJson(workflow, workflowState("running"));
    } else if (kind === "claimed task") {
      writeJson(join(testFixture.teamRoot, "tasks", "task-1.json"), {
        ...pendingTask(),
        claim: {
          owner: "worker-1",
          token: "claim-token",
          leased_until: "2026-09-21T01:00:00.000Z",
        },
      });
    } else {
      mkdirSync(dirname(workflow), { recursive: true });
      writeFileSync(`${workflow}.lock`, "held", "utf8");
    }

    expect(() => assertOrchestratorRecoveryQuiescent(testFixture.root)).toThrow(
      error,
    );
  });

  describe("attempts orphaned by a dead controller", () => {
    function exitedPid(): number {
      const child = spawnSync(process.execPath, ["-e", "process.exit(0)"], {
        windowsHide: true,
      });
      expect(child.status).toBe(0);
      expect(child.pid).toBeGreaterThan(0);
      return child.pid!;
    }

    function runningWorkflow(identity: unknown) {
      const state = workflowState("running");
      const invocation = {
        orchestrationHost: "claude",
        attempt: 1,
        mode: "fresh",
        model: "glm-5.3-flash",
        startedAt: "2026-09-21T00:00:00.000Z",
        outcome: "failed",
        error: "workflow_invocation_incomplete",
        artifacts: [],
        telemetry: {
          provider: "glm",
          durationMs: 0,
          status: "unknown",
          scope: "unknown",
        },
        ...(identity === undefined ? {} : { process: identity }),
      };
      return {
        ...state,
        tasks: [
          {
            ...state.tasks[0],
            attempts: 1,
            claimToken: randomUUID(),
            invocations: [invocation],
          },
        ],
      };
    }

    function projectedTask(taskId: string) {
      return {
        ...pendingTask(),
        status: "in_progress",
        owner: "task-one",
        claim: {
          owner: "task-one",
          token: "claim-token",
          leased_until: "2026-09-21T01:00:00.000Z",
        },
        metadata: { workflow: "recovery", task_id: taskId },
      };
    }

    it("treats a running task whose provider is verifiably dead as orphaned only during explicit recovery", () => {
      const testFixture = fixture();
      const dead = {
        pid: exitedPid(),
        processStartedAt: currentProcessStartIdentity(),
      };
      writeJson(
        join(testFixture.teamRoot, "workflow.json"),
        runningWorkflow(dead),
      );
      writeJson(
        join(testFixture.teamRoot, "tasks", "task-1.json"),
        projectedTask("one"),
      );

      expect(() =>
        assertOrchestratorRecoveryQuiescent(testFixture.root),
      ).not.toThrow();
      expect(() => assertOrchestratorQuiescent(testFixture.root)).toThrow(
        "orchestrator_active_attempt",
      );
    });

    it("refuses a running task whose recorded provider is still alive", () => {
      const testFixture = fixture();
      writeJson(
        join(testFixture.teamRoot, "workflow.json"),
        runningWorkflow({
          pid: process.pid,
          processStartedAt: currentProcessStartIdentity(),
        }),
      );

      expect(() =>
        assertOrchestratorRecoveryQuiescent(testFixture.root),
      ).toThrow("orchestrator_active_provider");
    });

    it.each([
      ["no recorded process", undefined],
      ["a malformed identity", { pid: "42", processStartedAt: null }],
    ])(
      "keeps a running task with %s as an active attempt",
      (_name, identity) => {
        const testFixture = fixture();
        writeJson(
          join(testFixture.teamRoot, "workflow.json"),
          runningWorkflow(identity),
        );

        expect(() =>
          assertOrchestratorRecoveryQuiescent(testFixture.root),
        ).toThrow("orchestrator_active_attempt");
      },
    );

    it("refuses an active task projection that does not belong to the orphaned attempt", () => {
      const testFixture = fixture();
      writeJson(
        join(testFixture.teamRoot, "workflow.json"),
        runningWorkflow({
          pid: exitedPid(),
          processStartedAt: currentProcessStartIdentity(),
        }),
      );
      writeJson(
        join(testFixture.teamRoot, "tasks", "task-1.json"),
        projectedTask("two"),
      );

      expect(() =>
        assertOrchestratorRecoveryQuiescent(testFixture.root),
      ).toThrow("orchestrator_active_attempt");
    });

    it.each([
      ["a dead owner and enough age", true, true, true],
      ["a live owner", false, true, false],
      ["a dead owner but recent activity", true, false, false],
    ])(
      "passes an abandoned workflow lock with %s only during explicit recovery",
      (_name, deadOwner, aged, expected) => {
        const testFixture = fixture();
        const workflow = join(testFixture.teamRoot, "workflow.json");
        writeJson(workflow, workflowState("pending"));
        const lock = `${workflow}.lock`;
        writeJson(lock, {
          pid: deadOwner ? exitedPid() : process.pid,
          timestamp: Date.now(),
        });
        if (aged) {
          const past = new Date(Date.now() - 120_000);
          utimesSync(lock, past, past);
        }

        const recovery = () =>
          assertOrchestratorRecoveryQuiescent(testFixture.root);
        if (expected) expect(recovery).not.toThrow();
        else expect(recovery).toThrow("orchestrator_workflow_locked");
        expect(() => assertOrchestratorQuiescent(testFixture.root)).toThrow(
          "orchestrator_workflow_locked",
        );
      },
    );
  });

  it.each(["workflow", "task"] as const)(
    "rejects an unknown %s status",
    (kind) => {
      const testFixture = fixture();
      if (kind === "workflow") {
        const workflow = workflowState();
        writeJson(join(testFixture.teamRoot, "workflow.json"), {
          ...workflow,
          tasks: workflow.tasks.map((task) => ({
            ...task,
            status: "unknown",
          })),
        });
      } else {
        writeJson(join(testFixture.teamRoot, "tasks", "task-1.json"), {
          ...pendingTask(),
          status: "unknown",
        });
      }

      expect(() =>
        assertOrchestratorRecoveryQuiescent(testFixture.root),
      ).toThrow("orchestrator_quiescence_unverified");
    },
  );

  it("accepts quiescent state without changing workflow bytes", () => {
    const testFixture = fixture();
    const workflow = join(testFixture.teamRoot, "workflow.json");
    writeJson(join(testFixture.teamRoot, "config.json"), teamConfig());
    writeJson(workflow, workflowState());
    writeJson(
      join(testFixture.teamRoot, "tasks", "task-1.json"),
      pendingTask(),
    );
    const before = readFileSync(workflow);

    expect(() =>
      assertOrchestratorRecoveryQuiescent(testFixture.root),
    ).not.toThrow();

    expect(readFileSync(workflow)).toEqual(before);
  });
});
