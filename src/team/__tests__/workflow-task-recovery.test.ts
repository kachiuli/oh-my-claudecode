import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acceptWorkflowTask,
  initWorkflow,
  inspectWorkflowTask,
  readWorkflow,
  recoverWorkflowTask,
  runWorkflow,
  workflowStatus,
} from "../workflow.js";
import type {
  WorkflowOptions,
  WorkflowPlan,
  WorkflowTask,
} from "../workflow-contracts.js";
import {
  appendWorkflowTaskRecovery,
  parseWorkflowTaskRecovery,
  parseWorkflowTaskRecoveryIntent,
  type WorkflowTaskRecovery,
  type WorkflowStateWithTaskRecoveries,
} from "../workflow-task-recovery.js";
import { createWorkflowFixture } from "./helpers/workflow-fixture.js";

const provider = fileURLToPath(
  new URL("./helpers/workflow-provider.cjs", import.meta.url),
);

describe("workflow task recovery evidence transition", () => {
  let fixture: ReturnType<typeof createWorkflowFixture>;
  const name = "task-recovery";
  const failingCheck = {
    command: process.execPath,
    args: ["-e", "process.exit(9)"],
  };
  const options: WorkflowOptions = {
    workers: 1,
    maxWorkers: 1,
    maxAttempts: 1,
    maxReviewPasses: 2,
    timeoutMs: 15_000,
    backoffMs: 1,
    glmCommand: provider,
    codexCommand: provider,
  };

  beforeEach(() => {
    fixture = createWorkflowFixture();
    vi.stubEnv("OMC_WORKFLOW_TEST_CONFIG", fixture.configPath);
    vi.stubEnv("OMC_STATE_DIR", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fixture.dispose();
  });

  function task(): WorkflowTask {
    return {
      id: "a",
      objective: "Implement a recoverable task",
      baseCommit: fixture.baseCommit,
      writeScope: ["feature/a.txt"],
      readScope: ["README.md"],
      prohibitedScope: ["package.json"],
      dependencies: [],
      contracts: ["Preserve the public API."],
      acceptanceCriteria: ["feature/a.txt exists"],
      tests: [failingCheck],
    };
  }

  function plan(): WorkflowPlan {
    return {
      name,
      objective: "Recover retained validated work",
      baseCommit: fixture.baseCommit,
      integrationBranch: "integration/task-recovery",
      tasks: [task()],
      verification: [
        { command: process.execPath, args: ["-e", "process.exit(0)"] },
      ],
    };
  }

  function recoveryCheck(marker: string) {
    return {
      command: process.execPath,
      args: [
        "-e",
        "process.exit(require('node:fs').existsSync(process.argv[1]) ? 0 : 9)",
        marker,
      ],
    };
  }

  function recoveryIntent(
    inspection: ReturnType<typeof inspectWorkflowTask>,
    overrides: Record<string, unknown> = {},
  ) {
    return {
      requestId: "recover-a-1",
      expectedHead: readWorkflow(fixture.cwd, name).integrationHead,
      expectedRefsDigest: inspection.expectedRefsDigest,
      expectedTaskCommit: inspection.savedHead,
      actor: { id: "unknown", model: "unknown" },
      authorityRef: "workflow-v1.6-recovery",
      reason: "Revalidate the retained completed handoff.",
      ...overrides,
    };
  }

  async function failedState(): Promise<WorkflowStateWithTaskRecoveries> {
    await initWorkflow(fixture.cwd, plan(), options);
    await runWorkflow(fixture.cwd, name);
    const state = readWorkflow(fixture.cwd, name);
    expect(state.tasks[0]).toMatchObject({
      status: "failed",
      attempts: 1,
      error: "workflow_worker_test_failed",
      handoff: { outcome: "completed" },
    });
    expect(state.tasks[0]!.attempts).toBe(state.options.maxAttempts);
    return state;
  }

  function receipt(
    state: WorkflowStateWithTaskRecoveries,
  ): WorkflowTaskRecovery {
    const inspection = inspectWorkflowTask(fixture.cwd, name, "a");
    return parseWorkflowTaskRecovery({
      sequence: 1,
      taskId: "a",
      requestId: "recover-a-1",
      oldError: state.tasks[0]!.error,
      taskCommit: state.tasks[0]!.handoff!.commitSha,
      baseCommit: state.tasks[0]!.task.baseCommit,
      head: state.integrationHead,
      refsDigestBefore: inspection.expectedRefsDigest,
      refsDigestAfter: inspection.expectedRefsDigest,
      orchestrationHost: "codex",
      actor: { id: "codex-lead", model: "gpt-6-astra" },
      authorityRef: "workflow-v1.6-recovery",
      reason:
        "Revalidate the retained completed handoff after the check environment recovered.",
      checks: [
        {
          command: failingCheck,
          passed: true,
          artifacts: [],
        },
      ],
      at: new Date().toISOString(),
    });
  }

  it("strictly parses and freezes the authorized intent", () => {
    const parsed = parseWorkflowTaskRecoveryIntent({
      requestId: "recover-a-1",
      expectedHead: "a".repeat(40),
      expectedRefsDigest: "b".repeat(64),
      expectedTaskCommit: "c".repeat(40),
      actor: { id: "codex-lead", model: "gpt-6-astra" },
      authorityRef: "workflow-v1.6-recovery",
      reason: "Revalidate retained work.",
    });
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.actor)).toBe(true);
    expect(() =>
      parseWorkflowTaskRecoveryIntent({ ...parsed, extra: true }),
    ).toThrow("workflow_invalid_task_recovery");
    expect(() =>
      parseWorkflowTaskRecoveryIntent({
        ...parsed,
        actor: { id: "unknown", model: "gpt-6-astra" },
      }),
    ).toThrow("workflow_invalid_task_recovery_actor");
  });

  it("appends a present-day receipt after attempts are exhausted without rewriting failure history", async () => {
    const state = await failedState();
    const oldAttempt = JSON.stringify(state.tasks[0]!.invocations);
    const oldHandoff = JSON.stringify(state.tasks[0]!.handoff);
    const attempts = state.tasks[0]!.attempts;
    const record = receipt(state);

    expect(appendWorkflowTaskRecovery(state, record)).toBe(true);

    expect(state.tasks[0]).toMatchObject({ status: "completed", attempts });
    expect(state.tasks[0]!.error).toBeUndefined();
    expect(JSON.stringify(state.tasks[0]!.invocations)).toBe(oldAttempt);
    expect(JSON.stringify(state.tasks[0]!.handoff)).toBe(oldHandoff);
    expect(state.taskRecoveries).toEqual([record]);
    expect(Object.isFrozen(state.taskRecoveries)).toBe(true);
    expect(Object.isFrozen(state.taskRecoveries![0]!.checks)).toBe(true);

    expect(appendWorkflowTaskRecovery(state, record)).toBe(false);
    expect(() =>
      appendWorkflowTaskRecovery(state, {
        ...record,
        reason: "Conflicting replay.",
      }),
    ).toThrow("workflow_task_recovery_request_conflict");
  });

  it("refuses mismatched head, commit, check, and ref evidence", async () => {
    for (const mutate of [
      (record: WorkflowTaskRecovery) => ({ ...record, head: "d".repeat(40) }),
      (record: WorkflowTaskRecovery) => ({
        ...record,
        taskCommit: "d".repeat(40),
      }),
      (record: WorkflowTaskRecovery) => ({
        ...record,
        refsDigestAfter: "e".repeat(64),
      }),
      (record: WorkflowTaskRecovery) => ({ ...record, checks: [] }),
    ]) {
      const state = await failedState();
      const record = receipt(state);
      expect(() => appendWorkflowTaskRecovery(state, mutate(record))).toThrow();
      expect(state.tasks[0]).toMatchObject({
        status: "failed",
        error: "workflow_worker_test_failed",
      });
      fixture.dispose();
      fixture = createWorkflowFixture();
      vi.stubEnv("OMC_WORKFLOW_TEST_CONFIG", fixture.configPath);
    }
  });

  it("revalidates exact retained evidence after attempts are exhausted and preserves old failure history", async () => {
    const marker = join(fixture.root, "recovery-ready");
    const check = recoveryCheck(marker);
    await initWorkflow(
      fixture.cwd,
      {
        ...plan(),
        tasks: [{ ...task(), tests: [check] }],
      },
      options,
    );
    await runWorkflow(fixture.cwd, name);
    const failed = readWorkflow(fixture.cwd, name);
    const oldInvocations = JSON.stringify(failed.tasks[0]!.invocations);
    const oldHandoff = JSON.stringify(failed.tasks[0]!.handoff);
    expect(failed.tasks[0]).toMatchObject({
      status: "failed",
      attempts: options.maxAttempts,
      error: "workflow_worker_test_failed",
    });
    const inspected = inspectWorkflowTask(fixture.cwd, name, "a");
    expect(inspected.classification).toBe("recoverable-completed-handoff");

    await expect(
      recoverWorkflowTask(
        fixture.cwd,
        name,
        "a",
        recoveryIntent(inspected, { expectedHead: "d".repeat(40) }),
      ),
    ).rejects.toThrow("workflow_task_recovery_head_mismatch");
    await expect(
      recoverWorkflowTask(
        fixture.cwd,
        name,
        "a",
        recoveryIntent(inspected, { expectedRefsDigest: "e".repeat(64) }),
      ),
    ).rejects.toThrow("workflow_task_recovery_refs_mismatch");
    await expect(
      recoverWorkflowTask(
        fixture.cwd,
        name,
        "a",
        recoveryIntent(inspected, { expectedTaskCommit: "f".repeat(40) }),
      ),
    ).rejects.toThrow("workflow_task_recovery_commit_mismatch");
    await expect(
      recoverWorkflowTask(
        fixture.cwd,
        name,
        "a",
        recoveryIntent(inspected),
      ),
    ).rejects.toThrow("workflow_task_recovery_check_failed");
    expect(readWorkflow(fixture.cwd, name).tasks[0]).toMatchObject({
      status: "failed",
      attempts: options.maxAttempts,
      error: "workflow_worker_test_failed",
    });

    writeFileSync(marker, "ready\n");
    const recovered = await recoverWorkflowTask(
      fixture.cwd,
      name,
      "a",
      recoveryIntent(inspected),
    );
    expect(recovered.tasks[0]).toMatchObject({
      status: "completed",
      attempts: options.maxAttempts,
    });
    expect(recovered.tasks[0]!.error).toBeUndefined();
    expect(JSON.stringify(recovered.tasks[0]!.invocations)).toBe(oldInvocations);
    expect(JSON.stringify(recovered.tasks[0]!.handoff)).toBe(oldHandoff);
    expect(recovered.taskRecoveries).toEqual([
      expect.objectContaining({
        sequence: 1,
        taskId: "a",
        requestId: "recover-a-1",
        oldError: "workflow_worker_test_failed",
        taskCommit: inspected.savedHead,
        head: failed.integrationHead,
        refsDigestBefore: inspected.expectedRefsDigest,
        refsDigestAfter: inspected.expectedRefsDigest,
        checks: [expect.objectContaining({ command: check, passed: true })],
      }),
    ]);
    expect(workflowStatus(fixture.cwd, name)).toMatchObject({
      taskRecoveryCount: 1,
      taskRecoveries: [
        expect.objectContaining({ taskId: "a", requestId: "recover-a-1" }),
      ],
    });
    expect(
      await recoverWorkflowTask(
        fixture.cwd,
        name,
        "a",
        recoveryIntent(inspected),
      ),
    ).toEqual(recovered);
    expect((await acceptWorkflowTask(fixture.cwd, name, "a")).tasks[0]!.status).toBe(
      "accepted",
    );
  }, 60_000);

  it("requires an intact saved unknown-writer audit and never rewrites historical protected-ref evidence", async () => {
    fixture.configure({ tasks: { a: { protectedRef: "branch" } } });
    await initWorkflow(
      fixture.cwd,
      {
        ...plan(),
        tasks: [{ ...task(), tests: [{ command: process.execPath, args: ["-e", "process.exit(0)"] }] }],
      },
      options,
    );
    await expect(runWorkflow(fixture.cwd, name)).rejects.toThrow(
      "workflow_protected_refs_changed",
    );
    const failed = readWorkflow(fixture.cwd, name);
    const historicalInvocations = JSON.stringify(failed.tasks[0]!.invocations);
    const historicalHandoff = JSON.stringify(failed.tasks[0]!.handoff);
    const descriptor = failed.tasks[0]!.handoff!.artifacts.find(
      (artifact) => artifact.kind === "workflow-protected-ref-audit",
    )!;
    const auditBytes = readFileSync(descriptor.path, "utf8");
    const inspected = inspectWorkflowTask(fixture.cwd, name, "a");

    const recovered = await recoverWorkflowTask(
      fixture.cwd,
      name,
      "a",
      recoveryIntent(inspected),
    );

    expect(recovered.taskRecoveries?.[0]).toMatchObject({
      oldError: "workflow_protected_refs_changed",
      protectedRefAuditContentHash: descriptor.contentHash,
    });
    expect(readFileSync(descriptor.path, "utf8")).toBe(auditBytes);
    expect(JSON.stringify(recovered.tasks[0]!.invocations)).toBe(historicalInvocations);
    expect(JSON.stringify(recovered.tasks[0]!.handoff)).toBe(historicalHandoff);
  }, 60_000);

  it("refuses missing tasks and preserves dirty retained work for inspection", async () => {
    await initWorkflow(fixture.cwd, plan(), options);
    const missing = inspectWorkflowTask(fixture.cwd, name, "missing");
    await expect(
      recoverWorkflowTask(
        fixture.cwd,
        name,
        "missing",
        recoveryIntent(missing, { expectedTaskCommit: "a".repeat(40) }),
      ),
    ).rejects.toThrow("workflow_task_recovery_evidence_missing");

    fixture.dispose();
    fixture = createWorkflowFixture();
    vi.stubEnv("OMC_WORKFLOW_TEST_CONFIG", fixture.configPath);
    fixture.configure({ tasks: { a: { dirty: true } } });
    await initWorkflow(fixture.cwd, plan(), options);
    await runWorkflow(fixture.cwd, name);
    const dirty = inspectWorkflowTask(fixture.cwd, name, "a");
    expect(dirty.classification).toBe("dirty-partial");
    await expect(
      recoverWorkflowTask(
        fixture.cwd,
        name,
        "a",
        recoveryIntent(dirty),
      ),
    ).rejects.toThrow("workflow_task_recovery_worktree_dirty");
    expect(readWorkflow(fixture.cwd, name).tasks[0]).toMatchObject({
      status: "failed",
      attempts: 1,
    });
  }, 60_000);
});
