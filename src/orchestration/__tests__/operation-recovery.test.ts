import {
  execFileSync,
  spawn,
  spawnSync,
  type ChildProcess,
} from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearWorktreeCache, getOmcRoot } from "../../lib/worktree-paths.js";
import { currentProcessStartIdentity } from "../../team/team-owner-epoch.js";
import {
  configureOrchestratorRepository,
  readOrchestratorStatus,
  recoverOrchestratorLease,
  resolveOrchestratorPaths,
} from "../selection.js";

const projectRoot = resolve(import.meta.dirname, "../../..");
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

async function waitForLine(
  child: ChildProcess,
  expected: string,
): Promise<string> {
  child.stdout?.setEncoding("utf8");
  let output = "";
  return await new Promise<string>((resolveLine, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`child output timeout: ${output}`)),
      10_000,
    );
    child.stdout?.on("data", (chunk: string) => {
      output += chunk;
      if (!output.includes(expected)) return;
      clearTimeout(timeout);
      resolveLine(output);
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`child exited before lock: ${code}; ${output}`));
    });
  });
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

describe("explicit orchestrator operation-lock recovery", () => {
  let root: string;
  let repo: string;
  let child: ChildProcess | undefined;
  let relatedChild: ChildProcess | undefined;
  let relatedPid: number | undefined;
  let previousEnvironment: Record<string, string | undefined>;

  beforeEach(async () => {
    previousEnvironment = Object.fromEntries(
      isolatedEnvironmentKeys.map((key) => [key, process.env[key]]),
    );
    for (const key of isolatedEnvironmentKeys) delete process.env[key];
    root = realpathSync(mkdtempSync(join(tmpdir(), "omc-operation-recovery-")));
    process.env.OMC_STATE_DIR = join(root, "isolated-state");
    repo = join(root, "repo");
    mkdirSync(repo, { recursive: true });
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    clearWorktreeCache();
    await configureOrchestratorRepository(repo, {
      schemaVersion: 1,
      supportedHosts: ["claude", "codex"],
      defaultHost: "claude",
    });
    expect(resolveOrchestratorPaths(repo).state.startsWith(root)).toBe(true);
  });

  afterEach(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit").catch(() => undefined);
    }
    child = undefined;
    if (
      relatedChild &&
      relatedChild.exitCode === null &&
      relatedChild.signalCode === null
    ) {
      try {
        relatedChild.kill("SIGKILL");
        await once(relatedChild, "exit");
      } catch {
        // The fixture is removed only after the best-effort child cleanup.
      }
    }
    relatedChild = undefined;
    relatedPid = undefined;
    for (const key of isolatedEnvironmentKeys) {
      const value = previousEnvironment[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    clearWorktreeCache();
    rmSync(root, { recursive: true, force: true });
  });

  it("recovers a lock abandoned by a killed real subprocess without a lease", async () => {
    const moduleUrl = pathToFileURL(
      resolve(projectRoot, "src/orchestration/selection.ts"),
    ).href;
    const script = [
      `import { withOrchestratorOperation } from ${JSON.stringify(moduleUrl)};`,
      `await withOrchestratorOperation(${JSON.stringify(repo)}, async () => {`,
      `  console.log("operation-held");`,
      `  await new Promise((resolve) => {`,
      `    const keepAlive = setInterval(() => {}, 1000);`,
      `    process.once("SIGTERM", () => { clearInterval(keepAlive); resolve(); });`,
      `  });`,
      `});`,
    ].join("\n");
    child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", script],
      { cwd: projectRoot, stdio: ["ignore", "pipe", "pipe"] },
    );
    await waitForLine(child, "operation-held");
    const operationLock = resolveOrchestratorPaths(repo).operationLock;
    expect(existsSync(operationLock)).toBe(true);
    expect(child.kill("SIGKILL")).toBe(true);
    await once(child, "exit");
    child = undefined;

    await expect(
      recoverOrchestratorLease(repo, {
        kind: "checkpointed",
        reference: "killed-controller",
      }),
    ).resolves.toBeUndefined();
    const status = readOrchestratorStatus(repo, { probe: () => true });
    expect(status.lease).toBeNull();
    expect(status.lastRecovery).toMatchObject({
      checkpoint: { kind: "checkpointed", reference: "killed-controller" },
      recoveredOperationLock: true,
      recoveredLease: false,
    });
    expect(existsSync(operationLock)).toBe(false);
  });

  it("recovers the crash triple: a killed lock holder, an orphaned running attempt and an abandoned advisory lock", async () => {
    const exitedPid = () => {
      const child = spawnSync(process.execPath, ["-e", "process.exit(0)"], {
        windowsHide: true,
      });
      expect(child.status).toBe(0);
      return child.pid!;
    };
    const teamRoot = join(getOmcRoot(repo), "state", "team", "crash-triple");
    const task = {
      id: "one",
      objective: "Interrupted work",
      baseCommit: "b".repeat(40),
      writeScope: ["src/one.ts"],
      readScope: [],
      prohibitedScope: [],
      dependencies: [],
      contracts: [],
      acceptanceCriteria: ["Recovery settles the crash"],
      tests: [],
    };
    const workflowPath = join(teamRoot, "workflow.json");
    mkdirSync(join(teamRoot, "tasks"), { recursive: true });
    writeFileSync(
      workflowPath,
      JSON.stringify({
        schemaVersion: 1,
        profile: "claude-glm-codex",
        cwd: repo,
        integrationHead: "b".repeat(40),
        plan: {
          name: "crash-triple",
          objective: "Interrupted work",
          baseCommit: "b".repeat(40),
          integrationBranch: "integration/crash-triple",
          tasks: [task],
          verification: [],
        },
        options: {
          workers: 1,
          maxWorkers: 1,
          maxAttempts: 1,
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
            status: "running",
            attempts: 1,
            worker: "task-one",
            claimToken: "claim-token",
            updatedAt: "2026-09-22T00:00:00.000Z",
            invocations: [
              {
                orchestrationHost: "claude",
                attempt: 1,
                mode: "fresh",
                model: "glm-5.3-flash",
                startedAt: "2026-09-22T00:00:00.000Z",
                outcome: "failed",
                error: "workflow_invocation_incomplete",
                artifacts: [],
                telemetry: {
                  provider: "glm",
                  durationMs: 0,
                  status: "unknown",
                  scope: "unknown",
                },
                process: {
                  pid: exitedPid(),
                  processStartedAt: currentProcessStartIdentity(),
                },
              },
            ],
          },
        ],
        stage: "implementation",
        reviewPasses: 0,
        reviews: [],
        createdAt: "2026-09-22T00:00:00.000Z",
        updatedAt: "2026-09-22T00:00:00.000Z",
      }),
      "utf8",
    );
    writeFileSync(
      join(teamRoot, "tasks", "task-1.json"),
      JSON.stringify({
        id: "1",
        subject: "Interrupted work",
        description: "Interrupted work",
        status: "in_progress",
        owner: "task-one",
        created_at: "2026-09-22T00:00:00.000Z",
        version: 2,
        claim: {
          owner: "task-one",
          token: "claim-token",
          leased_until: "2026-09-22T00:02:00.000Z",
        },
        metadata: { workflow: "crash-triple", task_id: "one" },
      }),
      "utf8",
    );
    const advisoryLock = `${workflowPath}.lock`;
    writeFileSync(
      advisoryLock,
      JSON.stringify({ pid: exitedPid(), timestamp: Date.now() - 120_000 }),
      "utf8",
    );
    const past = new Date(Date.now() - 120_000);
    utimesSync(advisoryLock, past, past);
    const workflowBytes = readFileSync(workflowPath);

    const moduleUrl = pathToFileURL(
      resolve(projectRoot, "src/orchestration/selection.ts"),
    ).href;
    const script = [
      `import { withOrchestratorOperation } from ${JSON.stringify(moduleUrl)};`,
      `await withOrchestratorOperation(${JSON.stringify(repo)}, async () => {`,
      `  console.log("operation-held");`,
      `  await new Promise((resolve) => {`,
      `    const keepAlive = setInterval(() => {}, 1000);`,
      `    process.once("SIGTERM", () => { clearInterval(keepAlive); resolve(); });`,
      `  });`,
      `});`,
    ].join("\n");
    child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", script],
      { cwd: projectRoot, stdio: ["ignore", "pipe", "pipe"] },
    );
    await waitForLine(child, "operation-held");
    const operationLock = resolveOrchestratorPaths(repo).operationLock;
    expect(existsSync(operationLock)).toBe(true);
    expect(child.kill("SIGKILL")).toBe(true);
    await once(child, "exit");
    child = undefined;

    await expect(
      recoverOrchestratorLease(repo, {
        kind: "paused",
        reference: "crash-triple",
      }),
    ).resolves.toBeUndefined();
    expect(existsSync(operationLock)).toBe(false);
    expect(readOrchestratorStatus(repo, { probe: () => true })).toMatchObject({
      lease: null,
      lastRecovery: { recoveredOperationLock: true, recoveredLease: false },
    });
    // Recovery records the boundary without touching the workflow history or the advisory lock.
    expect(readFileSync(workflowPath).equals(workflowBytes)).toBe(true);
    expect(existsSync(advisoryLock)).toBe(true);
  });

  it("recovers a standalone lease whose real owner subprocess was killed", async () => {
    const workflowPath = join(
      getOmcRoot(repo),
      "state",
      "team",
      "recovery-history",
      "workflow.json",
    );
    mkdirSync(resolve(workflowPath, ".."), { recursive: true });
    writeFileSync(
      workflowPath,
      '{\n  "tasks": [{ "status": "failed" }],\n  "reviews": [{ "summary": "preserve 界 history" }]\n}\n',
      "utf8",
    );
    const workflowBytes = readFileSync(workflowPath);
    const moduleUrl = pathToFileURL(
      resolve(projectRoot, "src/orchestration/selection.ts"),
    ).href;
    const script = [
      `import { acquireOrchestratorLease } from ${JSON.stringify(moduleUrl)};`,
      `await acquireOrchestratorLease(${JSON.stringify(repo)}, { host: "claude", sessionId: "killed-lease-owner" });`,
      `console.log("lease-held");`,
      `setInterval(() => {}, 1000);`,
    ].join("\n");
    child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", script],
      { cwd: projectRoot, stdio: ["ignore", "pipe", "pipe"] },
    );
    await waitForLine(child, "lease-held");
    expect(child.kill("SIGKILL")).toBe(true);
    await once(child, "exit");
    child = undefined;

    await expect(
      recoverOrchestratorLease(repo, {
        kind: "checkpointed",
        reference: "standalone-lease-owner-killed",
      }),
    ).resolves.toBeUndefined();
    expect(readOrchestratorStatus(repo, { probe: () => true })).toMatchObject({
      lease: null,
      lastRecovery: {
        recoveredOperationLock: false,
        recoveredLease: true,
      },
    });
    expect(readFileSync(workflowPath)).toEqual(workflowBytes);
  });

  it("refuses a killed controller's pending spawn-registration window byte-for-byte", async () => {
    const moduleUrl = pathToFileURL(
      resolve(projectRoot, "src/orchestration/selection.ts"),
    ).href;
    const script = [
      `import { acquireOrchestratorLease, beginOrchestratorLeaseProcessRegistration } from ${JSON.stringify(moduleUrl)};`,
      `const lease = await acquireOrchestratorLease(${JSON.stringify(repo)}, { host: "claude", sessionId: "pending-registration" });`,
      `await beginOrchestratorLeaseProcessRegistration(${JSON.stringify(repo)}, lease);`,
      `console.log("registration-pending");`,
      `setInterval(() => {}, 1000);`,
    ].join("\n");
    child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", script],
      { cwd: projectRoot, stdio: ["ignore", "pipe", "pipe"] },
    );
    await waitForLine(child, "registration-pending");
    expect(child.kill("SIGKILL")).toBe(true);
    await once(child, "exit");
    child = undefined;
    const runtimePath = resolveOrchestratorPaths(repo).state;
    const before = readFileSync(runtimePath);

    await expect(
      recoverOrchestratorLease(repo, { kind: "checkpointed" }),
    ).rejects.toThrow("orchestrator_lease_processes_unverifiable");
    expect(readFileSync(runtimePath)).toEqual(before);
  });

  it("does not recover a dead controller lease until its registered worker exits", async () => {
    const moduleUrl = pathToFileURL(
      resolve(projectRoot, "src/orchestration/selection.ts"),
    ).href;
    relatedChild = spawn(
      process.execPath,
      ["--eval", "setInterval(() => {}, 1000)"],
      { stdio: "ignore", windowsHide: true },
    );
    expect(relatedChild.pid).toBeTypeOf("number");
    relatedPid = relatedChild.pid!;
    const script = [
      `import { acquireOrchestratorLease, beginOrchestratorLeaseProcessRegistration, registerOrchestratorLeaseProcess } from ${JSON.stringify(moduleUrl)};`,
      `const lease = await acquireOrchestratorLease(${JSON.stringify(repo)}, { host: "claude", sessionId: "registered-worker" });`,
      `await beginOrchestratorLeaseProcessRegistration(${JSON.stringify(repo)}, lease);`,
      `await registerOrchestratorLeaseProcess(${JSON.stringify(repo)}, lease, ${relatedPid});`,
      `console.log("worker-registered:${relatedPid}");`,
      `setInterval(() => {}, 1000);`,
    ].join("\n");
    child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", script],
      { cwd: projectRoot, stdio: ["ignore", "pipe", "pipe"] },
    );
    const output = await waitForLine(child, "worker-registered:");
    const match = /worker-registered:(\d+)/.exec(output);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBe(relatedPid);
    expect(pidIsAlive(relatedPid)).toBe(true);
    expect(child.kill("SIGKILL")).toBe(true);
    await once(child, "exit");
    child = undefined;
    const runtimePath = resolveOrchestratorPaths(repo).state;
    const before = readFileSync(runtimePath);

    await expect(
      recoverOrchestratorLease(repo, { kind: "checkpointed" }),
    ).rejects.toThrow("orchestrator_lease_process_not_confirmed_dead");
    expect(readFileSync(runtimePath)).toEqual(before);

    expect(relatedChild.kill("SIGKILL")).toBe(true);
    await once(relatedChild, "exit");
    relatedChild = undefined;
    relatedPid = undefined;
    await expect(
      recoverOrchestratorLease(repo, {
        kind: "checkpointed",
        reference: "registered-worker-exited",
      }),
    ).resolves.toBeUndefined();
    expect(readOrchestratorStatus(repo, { probe: () => true })).toMatchObject({
      lease: null,
      lastRecovery: {
        recoveredOperationLock: false,
        recoveredLease: true,
      },
    });
  });
});
