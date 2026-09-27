import {
  existsSync,
  readFileSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { currentProcessStartIdentity } from "../team-owner-epoch.js";
import {
  initWorkflow,
  readWorkflow,
  recoverWorkflowTask,
  runWorkflow,
} from "../workflow.js";
import type {
  WorkflowOptions,
  WorkflowPlan,
  WorkflowTask,
} from "../workflow-contracts.js";
import { inspectWorkflowTask } from "../workflow.js";
import { createWorkflowFixture } from "./helpers/workflow-fixture.js";

const provider = fileURLToPath(
  new URL("./helpers/workflow-provider.cjs", import.meta.url),
);
const passingCheck = {
  command: process.execPath,
  args: ["-e", "process.exit(0)"],
};

describe("read-only workflow task recovery inspection", () => {
  let fixture: ReturnType<typeof createWorkflowFixture>;
  const name = "recovery-inspection";
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

  function task(tests = [passingCheck]): WorkflowTask {
    return {
      id: "a",
      objective: "Implement feature component a",
      baseCommit: fixture.baseCommit,
      writeScope: ["feature/a.txt"],
      readScope: ["README.md"],
      prohibitedScope: ["package.json"],
      dependencies: [],
      contracts: ["Preserve the public API."],
      acceptanceCriteria: ["feature/a.txt exists"],
      tests,
    };
  }

  function plan(tests = [passingCheck]): WorkflowPlan {
    return {
      name,
      objective: "Inspect retained worker evidence",
      baseCommit: fixture.baseCommit,
      integrationBranch: "integration/recovery-inspection",
      tasks: [task(tests)],
      verification: [passingCheck],
    };
  }

  function statePath(): string {
    return join(fixture.cwd, ".omc", "state", "team", name, "workflow.json");
  }

  it("classifies a clean failed task with exact completed handoff evidence as a revalidation candidate", async () => {
    const failingCheck = {
      command: process.execPath,
      args: ["-e", "process.exit(9)"],
    };
    await initWorkflow(fixture.cwd, plan([failingCheck]), options);
    await runWorkflow(fixture.cwd, name);
    expect(readWorkflow(fixture.cwd, name).tasks[0]).toMatchObject({
      status: "failed",
      error: "workflow_worker_test_failed",
      handoff: { outcome: "completed" },
    });
    const stateBefore = readFileSync(statePath(), "utf8");
    const refsBefore = fixture.git(
      "for-each-ref",
      "--format=%(refname)%00%(objectname)",
    );

    const inspected = inspectWorkflowTask(fixture.cwd, name, "a");

    expect(inspected).toMatchObject({
      classification: "recoverable-completed-handoff",
      nextAction: "revalidate",
      clean: true,
      registered: true,
    });
    expect(inspected.savedHead).toBe(inspected.observedHead);
    expect(inspected.expectedRefsDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(readFileSync(statePath(), "utf8")).toBe(stateBefore);
    expect(
      fixture.git("for-each-ref", "--format=%(refname)%00%(objectname)"),
    ).toBe(refsBefore);
  });

  it("preserves dirty partial work and exposes no private path or ref name", async () => {
    fixture.configure({ tasks: { a: { dirty: true } } });
    await initWorkflow(fixture.cwd, plan(), options);
    await runWorkflow(fixture.cwd, name);
    fixture.git(
      "update-ref",
      "refs/private/recovery-inspection-secret",
      fixture.baseCommit,
    );

    const inspected = inspectWorkflowTask(fixture.cwd, name, "a");

    expect(inspected).toMatchObject({
      classification: "dirty-partial",
      nextAction: "preserve-and-inspect",
      clean: false,
      registered: true,
    });
    expect(JSON.stringify(inspected)).not.toContain(fixture.root);
    expect(JSON.stringify(inspected)).not.toContain(
      "recovery-inspection-secret",
    );
  });

  it("refuses a retained worktree whose observed commit no longer matches the saved handoff", async () => {
    const failingCheck = {
      command: process.execPath,
      args: ["-e", "process.exit(9)"],
    };
    await initWorkflow(fixture.cwd, plan([failingCheck]), options);
    await runWorkflow(fixture.cwd, name);
    const worktree = readWorkflow(fixture.cwd, name).tasks[0]!.worktree!;
    writeFileSync(
      join(worktree, "feature", "a.txt"),
      "changed after failure\n",
    );
    fixture.git("-C", worktree, "add", "--", "feature/a.txt");
    fixture.git("-C", worktree, "commit", "--amend", "--no-edit");

    expect(inspectWorkflowTask(fixture.cwd, name, "a").classification).toBe(
      "failed",
    );
  });

  it("refuses a retained commit whose saved and observed changes escape task scope", async () => {
    const failingCheck = {
      command: process.execPath,
      args: ["-e", "process.exit(9)"],
    };
    await initWorkflow(fixture.cwd, plan([failingCheck]), options);
    await runWorkflow(fixture.cwd, name);
    const worktree = readWorkflow(fixture.cwd, name).tasks[0]!.worktree!;
    writeFileSync(join(worktree, "outside.txt"), "outside task scope\n");
    fixture.git("-C", worktree, "add", "--", "outside.txt");
    fixture.git("-C", worktree, "commit", "--amend", "--no-edit");
    const amended = fixture.git("-C", worktree, "rev-parse", "HEAD");
    const state = JSON.parse(readFileSync(statePath(), "utf8"));
    state.tasks[0].handoff.commitSha = amended;
    state.tasks[0].handoff.changedFiles = ["feature/a.txt", "outside.txt"];
    writeFileSync(statePath(), JSON.stringify(state));

    expect(inspectWorkflowTask(fixture.cwd, name, "a").classification).toBe(
      "failed",
    );
  });

  it("accepts extra or reordered passing handoff evidence while refusing failed or missing declared checks", async () => {
    const failingCheck = {
      command: process.execPath,
      args: ["-e", "process.exit(9)"],
    };
    await initWorkflow(
      fixture.cwd,
      plan([failingCheck, passingCheck]),
      options,
    );
    await runWorkflow(fixture.cwd, name);
    const state = JSON.parse(readFileSync(statePath(), "utf8"));
    const declared = state.tasks[0].handoff.tests;
    state.tasks[0].handoff.tests = [
      declared[1],
      { command: process.execPath, args: ["-e", "process.exit(0)"], passed: true },
      declared[0],
    ];
    writeFileSync(statePath(), JSON.stringify(state));
    expect(inspectWorkflowTask(fixture.cwd, name, "a").classification).toBe(
      "recoverable-completed-handoff",
    );

    state.tasks[0].handoff.tests[2].passed = false;
    writeFileSync(statePath(), JSON.stringify(state));
    expect(inspectWorkflowTask(fixture.cwd, name, "a").classification).toBe(
      "failed",
    );

    state.tasks[0].handoff.tests = state.tasks[0].handoff.tests.slice(0, 2);
    writeFileSync(statePath(), JSON.stringify(state));
    expect(inspectWorkflowTask(fixture.cwd, name, "a").classification).toBe(
      "failed",
    );
  });

  it("refuses a deterministic worktree redirected through a symlink or junction", async () => {
    const sentinel = join(fixture.root, "escaped-check-ran");
    const failingCheck = {
      command: process.execPath,
      args: [
        "-e",
        "require('node:fs').writeFileSync(process.argv[1], 'ran'); process.exit(9)",
        sentinel,
      ],
    };
    await initWorkflow(fixture.cwd, plan([failingCheck]), options);
    await runWorkflow(fixture.cwd, name);
    expect(existsSync(sentinel)).toBe(true);
    unlinkSync(sentinel);
    const state = readWorkflow(fixture.cwd, name);
    const worktree = state.tasks[0]!.worktree!;
    const escaped = join(fixture.root, "escaped-worktree");
    renameSync(worktree, escaped);
    symlinkSync(
      escaped,
      worktree,
      process.platform === "win32" ? "junction" : "dir",
    );

    const inspected = inspectWorkflowTask(fixture.cwd, name, "a");
    expect(inspected).toMatchObject({
      classification: "unverifiable",
      nextAction: "inspect",
      clean: false,
      registered: false,
    });
    await expect(
      recoverWorkflowTask(fixture.cwd, name, "a", {
        requestId: "redirected-worktree-recovery",
        expectedHead: state.integrationHead,
        expectedRefsDigest: inspected.expectedRefsDigest,
        expectedTaskCommit: state.tasks[0]!.handoff!.commitSha,
        actor: { id: "unknown", model: "unknown" },
        authorityRef: "workflow-v1.6-security-review",
        reason: "The redirected worktree must fail closed before checks run.",
      }),
    ).rejects.toThrow("workflow_task_recovery_unverifiable");
    expect(existsSync(sentinel)).toBe(false);
  });

  it("blocks a failed handoff and reports a missing task without creating a worktree", async () => {
    fixture.configure({ tasks: { a: { fail: true } } });
    await initWorkflow(fixture.cwd, plan(), options);
    expect(inspectWorkflowTask(fixture.cwd, name, "unknown")).toMatchObject({
      classification: "missing",
      nextAction: "none",
      savedHead: null,
      observedHead: null,
      clean: false,
      registered: false,
    });
    await runWorkflow(fixture.cwd, name);
    expect(inspectWorkflowTask(fixture.cwd, name, "a")).toMatchObject({
      classification: "failed",
      nextAction: "retry-or-reject",
      clean: true,
      registered: true,
    });
  });

  it.each([
    [
      "active",
      { pid: process.pid, processStartedAt: currentProcessStartIdentity() },
      "active",
      "wait",
    ],
    ["unverifiable", undefined, "unverifiable", "inspect"],
  ] as const)(
    "blocks a %s incomplete invocation before inspecting retained work",
    async (_label, identity, classification, nextAction) => {
      await initWorkflow(fixture.cwd, plan(), options);
      const state = JSON.parse(readFileSync(statePath(), "utf8"));
      state.tasks[0] = {
        ...state.tasks[0],
        status: "running",
        attempts: 1,
        invocations: [
          {
            orchestrationHost: "claude",
            attempt: 1,
            mode: "fresh",
            startedAt: new Date().toISOString(),
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
          },
        ],
      };
      writeFileSync(statePath(), JSON.stringify(state));

      expect(inspectWorkflowTask(fixture.cwd, name, "a")).toMatchObject({
        classification,
        nextAction,
        clean: false,
        registered: false,
      });
    },
  );

  it("changes only the opaque ref digest when the all-ref snapshot changes", async () => {
    await initWorkflow(fixture.cwd, plan(), options);
    const before = inspectWorkflowTask(fixture.cwd, name, "unknown");
    fixture.git("update-ref", "refs/private/opaque-name", fixture.baseCommit);
    const after = inspectWorkflowTask(fixture.cwd, name, "unknown");
    expect(after.expectedRefsDigest).not.toBe(before.expectedRefsDigest);
    expect(JSON.stringify(after)).not.toContain("opaque-name");
  });

  it("permits explicit revalidation only with an intact non-overflowing unknown-writer ref audit", async () => {
    fixture.configure({ tasks: { a: { protectedRef: "branch" } } });
    await initWorkflow(fixture.cwd, plan(), options);
    await expect(runWorkflow(fixture.cwd, name)).rejects.toThrow(
      "workflow_protected_refs_changed",
    );
    const failed = readWorkflow(fixture.cwd, name).tasks[0]!;
    expect(failed.error).toBe("workflow_protected_refs_changed");
    expect(inspectWorkflowTask(fixture.cwd, name, "a").classification).toBe(
      "recoverable-completed-handoff",
    );

    const descriptor = failed.handoff!.artifacts.find(
      (artifact) => artifact.kind === "workflow-protected-ref-audit",
    )!;
    const original = readFileSync(descriptor.path, "utf8");
    writeFileSync(descriptor.path, `${original} `);
    expect(inspectWorkflowTask(fixture.cwd, name, "a").classification).toBe(
      "failed",
    );
  });

  it("refuses overflowed audits and errors that identify the worker as the protected-ref writer", async () => {
    fixture.configure({ tasks: { a: { protectedRef: "overflow" } } });
    await initWorkflow(fixture.cwd, plan(), options);
    await expect(runWorkflow(fixture.cwd, name)).rejects.toThrow(
      "workflow_protected_refs_changed",
    );
    expect(inspectWorkflowTask(fixture.cwd, name, "a").classification).toBe(
      "failed",
    );

    const state = JSON.parse(readFileSync(statePath(), "utf8"));
    state.tasks[0].error = "workflow_worker_modified_protected_refs";
    writeFileSync(statePath(), JSON.stringify(state));
    expect(inspectWorkflowTask(fixture.cwd, name, "a").classification).toBe(
      "failed",
    );
  });
});
