import { execFileSync } from "node:child_process";
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
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearWorktreeCache, getOmcRoot } from "../../lib/worktree-paths.js";
import {
  ORCHESTRATOR_ENV,
  acquireOrchestratorLease,
  assertActiveOrchestratorAvailable,
  assertOrchestratorSession,
  configureOrchestratorRepository,
  handoffOrchestrator,
  orchestratorLeaseEnvironment,
  probeOrchestratorCli,
  readActiveOrchestrator,
  readOrchestratorStatus,
  recordOrchestratorSession,
  recoverOrchestratorLease,
  registerOrchestratorLeaseProcess,
  releaseOrchestratorLease,
  resolveOrchestratorPaths,
  selectOrchestrator,
  updateOrchestratorRepositoryConfig,
  withOrchestratorOperation,
  type OrchestratorLeaseCredentials,
} from "../selection.js";

const available = () => true;
const orchestratorEnvKeys = Object.values(ORCHESTRATOR_ENV);

describe("repository orchestrator selection", () => {
  let root: string;
  let repo: string;
  let previousStateDir: string | undefined;
  let previousLeaseEnvironment: Record<string, string | undefined>;

  beforeEach(() => {
    root = realpathSync(
      mkdtempSync(join(tmpdir(), "omc-orchestrator-selection-")),
    );
    repo = join(root, "repo");
    mkdirSync(repo, { recursive: true });
    execFileSync("git", ["init"], { cwd: repo, stdio: "pipe" });
    previousStateDir = process.env.OMC_STATE_DIR;
    delete process.env.OMC_STATE_DIR;
    previousLeaseEnvironment = Object.fromEntries(
      orchestratorEnvKeys.map((key) => [key, process.env[key]]),
    );
    for (const key of orchestratorEnvKeys) delete process.env[key];
    clearWorktreeCache();
  });

  afterEach(() => {
    if (previousStateDir === undefined) delete process.env.OMC_STATE_DIR;
    else process.env.OMC_STATE_DIR = previousStateDir;
    for (const key of orchestratorEnvKeys) {
      const value = previousLeaseEnvironment[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    clearWorktreeCache();
    rmSync(root, { recursive: true, force: true });
  });

  async function adopt(defaultHost: "claude" | "codex" = "claude") {
    return configureOrchestratorRepository(repo, {
      schemaVersion: 1,
      supportedHosts: ["claude", "codex"],
      defaultHost,
    });
  }

  function setLeaseEnvironment(
    credentials: OrchestratorLeaseCredentials,
  ): void {
    Object.assign(process.env, orchestratorLeaseEnvironment(credentials));
  }

  function clearLeaseEnvironment(): void {
    for (const key of orchestratorEnvKeys) delete process.env[key];
  }

  function seedHandoffHistory(
    credentials: OrchestratorLeaseCredentials,
    count: number,
    reference?: string,
  ): Buffer {
    const runtimePath = resolveOrchestratorPaths(repo).state;
    const runtime = JSON.parse(readFileSync(runtimePath, "utf8")) as Record<
      string,
      unknown
    >;
    const historyEntry = {
      id: "00000000-0000-0000-0000-000000000001",
      from: "claude",
      to: "codex",
      fromSelectionRevision: credentials.selectionRevision,
      toSelectionRevision: "00000000-0000-0000-0000-000000000002",
      sessionId: credentials.sessionId,
      checkpoint: {
        kind: "paused",
        ...(reference === undefined ? {} : { reference }),
      },
      at: "2026-01-01T00:00:00.000Z",
    };
    runtime.handoffs = Array.from({ length: count }, () => historyEntry);
    const bytes = Buffer.from(JSON.stringify(runtime));
    writeFileSync(runtimePath, bytes);
    return bytes;
  }

  it("keeps an unadopted repository on a byte-stable implicit Claude snapshot", async () => {
    const legacy = join(repo, "legacy-workflow.json");
    const bytes = '{"schemaVersion":1,"history":[{"provider":"glm"}]}\n';
    writeFileSync(legacy, bytes);

    expect(readActiveOrchestrator(repo)).toMatchObject({
      host: "claude",
      source: "legacy",
      adopted: false,
    });
    await expect(
      withOrchestratorOperation(repo, async (active) => active.host),
    ).resolves.toBe("claude");
    expect(readFileSync(legacy, "utf8")).toBe(bytes);
    expect(existsSync(resolveOrchestratorPaths(repo).state)).toBe(false);
  });

  it("switches in both directions repeatedly without rewriting bindings or assets", async () => {
    const workflow = join(
      getOmcRoot(repo),
      "state",
      "team",
      "demo",
      "workflow.json",
    );
    mkdirSync(dirname(workflow), { recursive: true });
    const workflowBytes =
      '{"tasks":[{"status":"pending"}],"bindings":{"implementer":"glm","reviewer":"codex"}}\n';
    writeFileSync(workflow, workflowBytes);
    const asset = join(repo, "AGENTS.md");
    writeFileSync(asset, "user-owned instructions\n");
    await adopt();
    const configBytes = readFileSync(
      resolveOrchestratorPaths(repo).config,
      "utf8",
    );

    const codex = await selectOrchestrator(repo, "codex", { probe: available });
    const codexAgain = await selectOrchestrator(repo, "codex", {
      probe: available,
    });
    expect(codex.host).toBe("codex");
    expect(codexAgain.selectionRevision).toBe(codex.selectionRevision);
    expect(
      (await selectOrchestrator(repo, "claude", { probe: available })).host,
    ).toBe("claude");
    expect(
      (await selectOrchestrator(repo, "codex", { probe: available })).host,
    ).toBe("codex");

    expect(readFileSync(workflow, "utf8")).toBe(workflowBytes);
    expect(readFileSync(asset, "utf8")).toBe("user-owned instructions\n");
    expect(readFileSync(resolveOrchestratorPaths(repo).config, "utf8")).toBe(
      configBytes,
    );
  });

  it("refuses an unavailable selected CLI without falling back or changing selection", async () => {
    await adopt();
    await expect(
      selectOrchestrator(repo, "codex", { probe: () => false }),
    ).rejects.toThrow(/orchestrator_host_unavailable.*codex.*Codex CLI/);
    expect(readActiveOrchestrator(repo).host).toBe("claude");

    const status = readOrchestratorStatus(repo, {
      probe: (host) => ({
        found: host === "claude",
        ...(host === "claude" ? { path: "/synthetic/claude" } : {}),
      }),
    });
    expect(status.active.host).toBe("claude");
    expect(status.availability.claude).toMatchObject({
      found: true,
      path: "/synthetic/claude",
    });
    expect(status.availability.codex.found).toBe(false);
    expect(
      assertActiveOrchestratorAvailable(repo, { probe: available }).host,
    ).toBe("claude");
    expect(
      probeOrchestratorCli("codex", { probe: () => false }).guidance,
    ).toMatch(/Codex CLI/);
  });

  it("allows the first local selection when shared configuration has no default", async () => {
    await configureOrchestratorRepository(repo, {
      schemaVersion: 1,
      supportedHosts: ["claude", "codex"],
    });
    expect(() => readActiveOrchestrator(repo)).toThrow(
      "orchestrator_selection_required",
    );
    await expect(
      selectOrchestrator(repo, "codex", { probe: available }),
    ).resolves.toMatchObject({ host: "codex", source: "local" });
  });

  it("serializes selection against controller operations and never reaps their lock", async () => {
    await adopt();
    let enter!: () => void;
    let leave!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      leave = resolve;
    });
    const operation = withOrchestratorOperation(repo, async () => {
      enter();
      await blocked;
    });
    await entered;
    await expect(
      selectOrchestrator(repo, "codex", { probe: available }),
    ).rejects.toThrow("orchestrator_operation_locked");
    leave();
    await operation;

    const lock = resolveOrchestratorPaths(repo).operationLock;
    mkdirSync(dirname(lock), { recursive: true });
    writeFileSync(lock, JSON.stringify({ pid: 2147483647, timestamp: 1 }));
    utimesSync(lock, new Date(0), new Date(0));
    await expect(
      selectOrchestrator(repo, "codex", { probe: available }),
    ).rejects.toThrow("orchestrator_operation_locked");
    expect(existsSync(lock)).toBe(true);
  });

  it("blocks running attempts and workflow locks but permits a paused checkpoint", async () => {
    await adopt();
    const workflow = join(
      getOmcRoot(repo),
      "state",
      "team",
      "demo",
      "workflow.json",
    );
    mkdirSync(dirname(workflow), { recursive: true });
    writeFileSync(workflow, JSON.stringify({ tasks: [{ status: "running" }] }));
    await expect(
      selectOrchestrator(repo, "codex", { probe: available }),
    ).rejects.toThrow("orchestrator_active_attempt");

    writeFileSync(workflow, JSON.stringify({ tasks: [{ status: "failed" }] }));
    writeFileSync(`${workflow}.lock`, "held");
    await expect(
      selectOrchestrator(repo, "codex", { probe: available }),
    ).rejects.toThrow("orchestrator_workflow_locked");
    rmSync(`${workflow}.lock`);

    const task = join(dirname(workflow), "tasks", "task-1.json");
    mkdirSync(dirname(task), { recursive: true });
    writeFileSync(
      task,
      JSON.stringify({ status: "pending", claim: { token: "held" } }),
    );
    await expect(
      selectOrchestrator(repo, "codex", { probe: available }),
    ).rejects.toThrow("orchestrator_active_attempt");
    writeFileSync(task, JSON.stringify({ status: "failed" }));

    await expect(
      selectOrchestrator(repo, "codex", { probe: available }),
    ).resolves.toMatchObject({ host: "codex", source: "local" });
  });

  it("uses a durable lead lease and atomically revokes the old host at handoff", async () => {
    await adopt();
    const claudeLease = await acquireOrchestratorLease(repo, {
      host: "claude",
      sessionId: "claude-launch-1",
    });

    await expect(
      selectOrchestrator(repo, "codex", { probe: available }),
    ).rejects.toThrow("orchestrator_active_lease");
    await expect(
      withOrchestratorOperation(repo, async () => undefined),
    ).rejects.toThrow("orchestrator_lease_required");
    setLeaseEnvironment(claudeLease);
    await expect(
      withOrchestratorOperation(repo, async (active) => active.host),
    ).resolves.toBe("claude");

    const result = await handoffOrchestrator(repo, "codex", {
      credentials: claudeLease,
      checkpoint: {
        kind: "paused",
        workflowName: "demo",
        reference: "checkpoint-3",
      },
      probe: available,
    });
    expect(result.active.host).toBe("codex");
    expect(result.handoff).toMatchObject({ from: "claude", to: "codex" });
    await expect(
      withOrchestratorOperation(repo, async () => undefined),
    ).rejects.toThrow("orchestrator_lease_stale_or_revoked");

    clearLeaseEnvironment();
    const codexLease = await acquireOrchestratorLease(repo, {
      host: "codex",
      sessionId: "codex-launch-1",
    });
    expect(codexLease.selectionRevision).toBe(result.active.selectionRevision);
    await releaseOrchestratorLease(repo, codexLease, {
      kind: "completed-stage",
      workflowName: "demo",
    });
    expect(readOrchestratorStatus(repo, { probe: available }).lease).toBeNull();
  });

  it("rejects stale host mutations after handoff without changing repository bytes", async () => {
    await adopt();
    const claudeLease = await acquireOrchestratorLease(repo, {
      host: "claude",
      sessionId: "stale-host",
    });
    setLeaseEnvironment(claudeLease);
    await handoffOrchestrator(repo, "codex", {
      credentials: claudeLease,
      checkpoint: { kind: "paused" },
      probe: available,
    });

    const paths = resolveOrchestratorPaths(repo);
    const configBytes = readFileSync(paths.config);
    const stateBytes = readFileSync(paths.state);
    let transformCalled = false;
    const mutations: Array<() => Promise<unknown>> = [
      () => selectOrchestrator(repo, "claude", { probe: available }),
      () =>
        updateOrchestratorRepositoryConfig(repo, (current) => {
          transformCalled = true;
          return current!;
        }),
      () =>
        acquireOrchestratorLease(repo, {
          host: "codex",
          sessionId: "stale-reacquire",
        }),
      () => recoverOrchestratorLease(repo, { kind: "checkpointed" }),
    ];
    for (const mutate of mutations) {
      await expect(mutate()).rejects.toThrow(
        "orchestrator_lease_stale_or_revoked",
      );
      expect(readFileSync(paths.config)).toEqual(configBytes);
      expect(readFileSync(paths.state)).toEqual(stateBytes);
    }
    expect(transformCalled).toBe(false);
  });

  it("rejects a handoff beyond the retained history limit without poisoning state", async () => {
    await adopt();
    const lease = await acquireOrchestratorLease(repo, {
      host: "claude",
      sessionId: "history-limit",
    });
    const before = seedHandoffHistory(lease, 10_000);
    expect(before.byteLength).toBeLessThanOrEqual(4 * 1024 * 1024);

    await expect(
      handoffOrchestrator(repo, "codex", {
        credentials: lease,
        checkpoint: { kind: "paused" },
        probe: available,
      }),
    ).rejects.toThrow("orchestrator_state_limit_reached");

    const runtimePath = resolveOrchestratorPaths(repo).state;
    expect(readFileSync(runtimePath)).toEqual(before);
    expect(readOrchestratorStatus(repo, { probe: available })).toMatchObject({
      active: { host: "claude" },
      lease: { sessionId: "history-limit" },
    });
  });

  it("rejects a handoff whose pretty UTF-8 runtime exceeds four MiB without replacing readable state", async () => {
    await adopt();
    const lease = await acquireOrchestratorLease(repo, {
      host: "claude",
      sessionId: "byte-limit",
    });
    const before = seedHandoffHistory(lease, 6_000, "界".repeat(100));
    expect(before.byteLength).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(
      Buffer.byteLength(JSON.stringify(JSON.parse(before.toString()), null, 2)),
    ).toBeGreaterThan(4 * 1024 * 1024);

    await expect(
      handoffOrchestrator(repo, "codex", {
        credentials: lease,
        checkpoint: { kind: "paused" },
        probe: available,
      }),
    ).rejects.toThrow("orchestrator_state_limit_reached");

    const runtimePath = resolveOrchestratorPaths(repo).state;
    expect(readFileSync(runtimePath)).toEqual(before);
    expect(readOrchestratorStatus(repo, { probe: available })).toMatchObject({
      active: { host: "claude" },
      lease: { sessionId: "byte-limit" },
    });
  });

  it("binds native sessions to one host and selection revision", async () => {
    await adopt();
    const claudeLease = await acquireOrchestratorLease(repo, {
      host: "claude",
      sessionId: "claude-launch",
    });
    setLeaseEnvironment(claudeLease);
    await recordOrchestratorSession(repo, "claude", "native-claude-1");
    expect(
      assertOrchestratorSession(repo, "claude", "native-claude-1"),
    ).toMatchObject({ host: "claude" });
    expect(() =>
      assertOrchestratorSession(repo, "codex", "native-claude-1"),
    ).toThrow("orchestrator_session_stale_or_cross_host");

    await handoffOrchestrator(repo, "codex", {
      credentials: claudeLease,
      checkpoint: { kind: "checkpointed" },
      probe: available,
    });
    expect(() =>
      assertOrchestratorSession(repo, "claude", "native-claude-1"),
    ).toThrow("orchestrator_session_stale_or_cross_host");

    clearLeaseEnvironment();
    const codexLease = await acquireOrchestratorLease(repo, {
      host: "codex",
      sessionId: "codex-launch",
    });
    setLeaseEnvironment(codexLease);
    await expect(
      recordOrchestratorSession(repo, "codex", "native-claude-1"),
    ).rejects.toThrow("orchestrator_session_stale_or_cross_host");
    await recordOrchestratorSession(repo, "codex", "native-codex-1");
    expect(
      assertOrchestratorSession(repo, "codex", "native-codex-1"),
    ).toMatchObject({ host: "codex" });
  });

  it("recovers a crashed lease explicitly and refuses live owners or known children", async () => {
    await adopt();
    const lease = await acquireOrchestratorLease(repo, {
      host: "claude",
      sessionId: "crash-test",
    });
    await expect(
      recoverOrchestratorLease(repo, { kind: "checkpointed" }),
    ).rejects.toThrow("orchestrator_lease_owner_alive");

    await registerOrchestratorLeaseProcess(repo, lease, 2147483646);
    const runtimePath = resolveOrchestratorPaths(repo).state;
    const runtime = JSON.parse(readFileSync(runtimePath, "utf8")) as {
      lease: { ownerPid: number; relatedPids: number[] };
    };
    expect(runtime.lease.relatedPids).toContain(2147483646);
    runtime.lease.ownerPid = 2147483647;
    runtime.lease.relatedPids = [process.pid];
    writeFileSync(runtimePath, JSON.stringify(runtime));
    await expect(
      recoverOrchestratorLease(repo, { kind: "checkpointed" }),
    ).rejects.toThrow("orchestrator_lease_owner_alive");

    runtime.lease.relatedPids = [];
    writeFileSync(runtimePath, JSON.stringify(runtime));
    await expect(
      recoverOrchestratorLease(repo, {
        kind: "checkpointed",
        reference: "operator-confirmed-crash",
      }),
    ).resolves.toBeUndefined();
    expect(readOrchestratorStatus(repo, { probe: available }).lease).toBeNull();
  });

  it("keeps committed config in the repository while local selection follows OMC_STATE_DIR", async () => {
    const central = join(root, "central-state");
    process.env.OMC_STATE_DIR = central;
    clearWorktreeCache();
    await adopt();
    await selectOrchestrator(repo, "codex", { probe: available });

    const paths = resolveOrchestratorPaths(repo);
    expect(paths.config).toBe(join(repo, ".omc", "orchestrator.json"));
    expect(paths.state.startsWith(central)).toBe(true);
    expect(existsSync(paths.config)).toBe(true);
    expect(existsSync(paths.state)).toBe(true);
  });

  it("keeps sibling repository selection and sessions isolated under one workspace gate", async () => {
    const workspace = mkdtempSync(
      join(homedir(), "omc-orchestrator-workspace-"),
    );
    const repoA = join(workspace, "repo-a");
    const repoB = join(workspace, "repo-b");
    try {
      mkdirSync(repoA);
      mkdirSync(repoB);
      execFileSync("git", ["init"], { cwd: repoA, stdio: "pipe" });
      execFileSync("git", ["init"], { cwd: repoB, stdio: "pipe" });
      writeFileSync(join(workspace, ".omc-workspace"), "{}\n");
      clearWorktreeCache();
      for (const sibling of [repoA, repoB]) {
        await configureOrchestratorRepository(sibling, {
          schemaVersion: 1,
          supportedHosts: ["claude", "codex"],
          defaultHost: "claude",
        });
      }
      await selectOrchestrator(repoA, "codex", { probe: available });

      const pathsA = resolveOrchestratorPaths(repoA);
      const pathsB = resolveOrchestratorPaths(repoB);
      expect(pathsA.repositoryRoot).toBe(repoA);
      expect(pathsB.repositoryRoot).toBe(repoB);
      expect(pathsA.config).toBe(join(repoA, ".omc", "orchestrator.json"));
      expect(pathsB.config).toBe(join(repoB, ".omc", "orchestrator.json"));
      expect(pathsA.repositoryKey).toMatch(/^[a-f0-9]{64}$/);
      expect(pathsB.repositoryKey).toMatch(/^[a-f0-9]{64}$/);
      expect(pathsA.repositoryKey).not.toBe(pathsB.repositoryKey);
      expect(pathsA.state).toBe(
        join(
          workspace,
          ".omc",
          "state",
          "orchestrator",
          "repositories",
          pathsA.repositoryKey,
          "runtime.json",
        ),
      );
      expect(pathsB.state).toBe(
        join(
          workspace,
          ".omc",
          "state",
          "orchestrator",
          "repositories",
          pathsB.repositoryKey,
          "runtime.json",
        ),
      );
      expect(pathsA.operationLock).toBe(
        join(workspace, ".omc", "state", "orchestrator", "operation.lock"),
      );
      expect(pathsB.operationLock).toBe(pathsA.operationLock);
      expect(existsSync(join(workspace, ".omc", "orchestrator.json"))).toBe(
        false,
      );
      expect(readActiveOrchestrator(repoA).host).toBe("codex");
      expect(readActiveOrchestrator(repoB).host).toBe("claude");

      const sharedSessionId = "same-native-session-id";
      const leaseA = await acquireOrchestratorLease(repoA, {
        host: "codex",
        sessionId: "repo-a-lead",
      });
      setLeaseEnvironment(leaseA);
      await recordOrchestratorSession(repoA, "codex", sharedSessionId);
      await releaseOrchestratorLease(repoA, leaseA, { kind: "checkpointed" });
      clearLeaseEnvironment();
      const leaseB = await acquireOrchestratorLease(repoB, {
        host: "claude",
        sessionId: "repo-b-lead",
      });
      setLeaseEnvironment(leaseB);
      await recordOrchestratorSession(repoB, "claude", sharedSessionId);
      await releaseOrchestratorLease(repoB, leaseB, { kind: "checkpointed" });
      clearLeaseEnvironment();
      expect(
        assertOrchestratorSession(repoA, "codex", sharedSessionId).host,
      ).toBe("codex");
      expect(
        assertOrchestratorSession(repoB, "claude", sharedSessionId).host,
      ).toBe("claude");

      let enter!: () => void;
      let leave!: () => void;
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      const blocked = new Promise<void>((resolve) => {
        leave = resolve;
      });
      const operation = withOrchestratorOperation(repoA, async () => {
        enter();
        await blocked;
      });
      await entered;
      try {
        await expect(
          selectOrchestrator(repoB, "codex", { probe: available }),
        ).rejects.toThrow("orchestrator_operation_locked");
      } finally {
        leave();
        await operation;
      }
    } finally {
      clearLeaseEnvironment();
      clearWorktreeCache();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("allows historical OMX plans but refuses a competing OMX engine", async () => {
    mkdirSync(join(repo, ".omx", "plans"), { recursive: true });
    await expect(adopt()).resolves.toMatchObject({ schemaVersion: 1 });
    mkdirSync(join(repo, ".omx", "state"), { recursive: true });
    expect(() => readActiveOrchestrator(repo)).toThrow(
      "orchestrator_competing_omx_state_requires_explicit_import",
    );
  });

  it("refuses competing OMX state at a parent workspace anchor", async () => {
    const workspace = mkdtempSync(join(homedir(), "omc-orchestrator-omx-"));
    const nestedRepo = join(workspace, "repo");
    try {
      mkdirSync(nestedRepo);
      execFileSync("git", ["init"], { cwd: nestedRepo, stdio: "pipe" });
      writeFileSync(join(workspace, ".omc-workspace"), "{}\n");
      mkdirSync(join(workspace, ".omx", "state"), { recursive: true });
      clearWorktreeCache();
      await expect(
        configureOrchestratorRepository(nestedRepo, {
          schemaVersion: 1,
          supportedHosts: ["claude", "codex"],
          defaultHost: "claude",
        }),
      ).rejects.toThrow(
        "orchestrator_competing_omx_state_requires_explicit_import",
      );
      expect(existsSync(resolveOrchestratorPaths(nestedRepo).config)).toBe(
        false,
      );
    } finally {
      clearWorktreeCache();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("holds the configuration gate across an installer transform", async () => {
    await adopt("claude");
    let enter!: () => void;
    let leave!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      leave = resolve;
    });
    const update = updateOrchestratorRepositoryConfig(repo, async (current) => {
      expect(current?.defaultHost).toBe("claude");
      enter();
      await blocked;
      return { ...current!, defaultHost: "codex" };
    });
    await entered;
    await expect(
      selectOrchestrator(repo, "codex", { probe: available }),
    ).rejects.toThrow("orchestrator_operation_locked");
    leave();
    await expect(update).resolves.toMatchObject({ defaultHost: "codex" });
  });

  it.each([
    "OMC_TEAM_WORKER",
    "OMC_TEAM_WORKER_NAME",
    "OMC_TEAM_WORKTREE_PATH",
  ])("refuses worker mutations after controller exit via %s", async (key) => {
    await adopt();
    await selectOrchestrator(repo, "claude", { probe: available });
    const paths = resolveOrchestratorPaths(repo);
    const config = readFileSync(paths.config);
    const state = readFileSync(paths.state);
    const previous = process.env[key];
    process.env[key] = "task-worker";
    try {
      await expect(
        selectOrchestrator(repo, "codex", { probe: available }),
      ).rejects.toThrow("workflow_lead_authority_required");
      await expect(
        updateOrchestratorRepositoryConfig(repo, (current) => current!),
      ).rejects.toThrow("workflow_lead_authority_required");
      await expect(
        acquireOrchestratorLease(repo, {
          host: "claude",
          sessionId: "native-session",
        }),
      ).rejects.toThrow("workflow_lead_authority_required");
      await expect(
        recoverOrchestratorLease(repo, { kind: "checkpointed" }),
      ).rejects.toThrow("workflow_lead_authority_required");
      await expect(
        recordOrchestratorSession(repo, "claude", "native-session"),
      ).rejects.toThrow("workflow_lead_authority_required");
      expect(readFileSync(paths.config)).toEqual(config);
      expect(readFileSync(paths.state)).toEqual(state);
      expect(existsSync(paths.operationLock)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  });
});
