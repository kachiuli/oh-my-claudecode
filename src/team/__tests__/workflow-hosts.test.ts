import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  configureOrchestratorRepository,
  ORCHESTRATOR_ENV,
  selectOrchestrator,
  type OrchestratorHost,
} from "../../orchestration/selection.js";
import {
  acceptWorkflowTask,
  finishWorkflow,
  initWorkflowV2,
  readWorkflow,
  rejectWorkflowTask,
  reviewWorkflow,
  runWorkflow,
  verifyWorkflow,
} from "../workflow.js";
import { currentProcessStartIdentity } from "../team-owner-epoch.js";
import type {
  WorkflowPlan,
  WorkflowProviderRoute,
} from "../workflow-contracts.js";
import { createWorkflowFixture } from "./helpers/workflow-fixture.js";
import { binding, runtimeFixture } from "./helpers/workflow-v2-fixture.js";

/** Actual subprocesses and Git worktrees; the providers are explicitly synthetic. */
describe("shared workflow under Claude and Codex orchestration hosts", () => {
  let fixture: ReturnType<typeof createWorkflowFixture>;
  const probe = () => true;
  beforeEach(async () => {
    fixture = createWorkflowFixture();
    vi.stubEnv("OMC_STATE_DIR", "");
    for (const key of Object.values(ORCHESTRATOR_ENV))
      vi.stubEnv(key, undefined);
    await configureOrchestratorRepository(fixture.cwd, {
      schemaVersion: 1,
      supportedHosts: ["claude", "codex"],
      defaultHost: "claude",
    });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    fixture.dispose();
  });
  function plan(): WorkflowPlan {
    const check = {
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
    };
    return {
      name: "hosts",
      objective: "One shared workflow across native lead hosts",
      baseCommit: fixture.baseCommit,
      integrationBranch: "integration/hosts",
      verification: [check],
      tasks: [
        {
          id: "component",
          objective: "Implement owned component",
          baseCommit: fixture.baseCommit,
          writeScope: ["feature/component.txt"],
          readScope: ["README.md"],
          prohibitedScope: [],
          dependencies: [],
          contracts: [],
          acceptanceCriteria: ["The declared check passes"],
          tests: [check],
        },
      ],
    };
  }
  const scenarios: Array<[OrchestratorHost, string, WorkflowProviderRoute]> = [
    ["claude", "glm-5.3", "codex"],
    ["codex", "glm-5.3", "codex"],
    ["claude", "glm-5.3-flash", "codex"],
    ["codex", "glm-5.3-flash", "claude"],
    ["claude", "glm-5.3-flash[1m]", "claude"],
    ["codex", "glm-5.3-flash[1m]", "claude"],
  ];
  it.each(scenarios)(
    "%s lead runs exact %s with %s review and all shared gates",
    async (host, model, reviewer) => {
      await selectOrchestrator(fixture.cwd, host, { probe });
      const configured = runtimeFixture(fixture);
      const bindings = {
        lead: binding("lead", host),
        implementer: configured.selectedBinding(
          "implementer",
          "glm",
          undefined,
          "",
          {},
          model,
        ),
        reviewer: configured.selectedBinding("reviewer", reviewer),
      };
      await initWorkflowV2(fixture.cwd, plan(), bindings, {
        providerPolicy: "supervised",
        maxAttempts: 1,
        maxReviewPasses: 1,
      });
      const statePath = join(
        fixture.cwd,
        ".omc/state/team/hosts/workflow.json",
      );
      const original = readFileSync(statePath);
      readWorkflow(fixture.cwd, "hosts");
      expect(readFileSync(statePath)).toEqual(original);
      const produced = await runWorkflow(
        fixture.cwd,
        "hosts",
        configured.runtime,
      );
      expect(produced.tasks[0]).toMatchObject({
        status: "completed",
        attempts: 1,
      });
      expect(produced.tasks[0].invocations?.[0]).toMatchObject({
        orchestrationHost: host,
        model,
        telemetry: { provider: "glm" },
      });
      await acceptWorkflowTask(fixture.cwd, "hosts", "component");
      await verifyWorkflow(fixture.cwd, "hosts");
      const reviewed = await reviewWorkflow(
        fixture.cwd,
        "hosts",
        configured.runtime,
      );
      expect(reviewed.reviewAttempts?.[0]).toMatchObject({
        orchestrationHost: host,
        telemetry: { provider: reviewer },
      });
      expect((await finishWorkflow(fixture.cwd, "hosts")).stage).toBe(
        "complete",
      );
      const events = readFileSync(fixture.eventsPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(
        events.find((event) => event.role === "implementer").args,
      ).toContain(model);
      expect(events.find((event) => event.role === "reviewer").route).toBe(
        reviewer,
      );
    },
    process.platform === "win32" ? 150000 : 30000,
  );

  it("continues from a shared checkpoint, keeps providers fixed, and retains attempt host history", async () => {
    const configured = runtimeFixture(fixture);
    const bindings = {
      lead: binding("lead", "claude"),
      implementer: configured.selectedBinding("implementer", "glm"),
      reviewer: configured.selectedBinding("reviewer", "codex"),
    };
    await initWorkflowV2(fixture.cwd, plan(), bindings, {
      providerPolicy: "supervised",
      maxAttempts: 1,
      maxReviewPasses: 1,
    });
    const produced = await runWorkflow(
      fixture.cwd,
      "hosts",
      configured.runtime,
    );
    // The provider's process identity is captured at spawn so a crashed controller's attempt can be proven dead.
    expect(produced.tasks[0].invocations?.[0].process?.pid).toBeGreaterThan(0);
    const attempt = JSON.stringify(produced.tasks[0].invocations?.[0]);
    await selectOrchestrator(fixture.cwd, "codex", { probe });
    const before = readWorkflow(fixture.cwd, "hosts");
    expect(before.schemaVersion === 2 && before.bindings).toEqual(bindings);
    await acceptWorkflowTask(fixture.cwd, "hosts", "component");
    await verifyWorkflow(fixture.cwd, "hosts");
    const reviewed = await reviewWorkflow(
      fixture.cwd,
      "hosts",
      configured.runtime,
    );
    expect(reviewed.reviewAttempts?.[0].orchestrationHost).toBe("codex");
    expect(JSON.stringify(reviewed.tasks[0].invocations?.[0])).toBe(attempt);
    await selectOrchestrator(fixture.cwd, "claude", { probe });
    const complete = await finishWorkflow(fixture.cwd, "hosts");
    expect(complete.stage).toBe("complete");
    expect(complete.schemaVersion === 2 && complete.bindings).toEqual(bindings);
    expect(complete.tasks[0].invocations?.[0].orchestrationHost).toBe("claude");
    expect(complete.reviewAttempts?.[0].orchestrationHost).toBe("codex");
  }, process.platform === "win32" ? 150000 : 30000);

  it("settles a role-substitution attempt orphaned by a dead controller through explicit rejection", async () => {
    const configured = runtimeFixture(fixture);
    const bindings = {
      lead: binding("lead", "claude"),
      implementer: configured.selectedBinding("implementer", "glm"),
      reviewer: configured.selectedBinding("reviewer", "codex"),
    };
    await initWorkflowV2(fixture.cwd, plan(), bindings, {
      providerPolicy: "supervised",
      maxAttempts: 1,
      maxReviewPasses: 1,
    });
    const stateFile = join(
      fixture.cwd,
      ".omc",
      "state",
      "team",
      "hosts",
      "workflow.json",
    );
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    const exited = spawnSync(process.execPath, ["-e", "process.exit(0)"], {
      windowsHide: true,
    });
    state.tasks[0] = {
      ...state.tasks[0],
      status: "running",
      attempts: 1,
      claimToken: randomUUID(),
      invocations: [
        {
          orchestrationHost: "claude",
          attempt: 1,
          mode: "fresh",
          invocationId: randomUUID(),
          binding: state.bindings.implementer,
          model: state.bindings.implementer.model,
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
          process: {
            pid: exited.pid,
            processStartedAt: currentProcessStartIdentity(),
          },
        },
      ],
    };
    writeFileSync(stateFile, JSON.stringify(state));
    const settled = await rejectWorkflowTask(
      fixture.cwd,
      "hosts",
      "component",
      "lead crashed during the attempt",
    );
    expect(settled.schemaVersion).toBe(2);
    expect(settled.tasks[0].status).toBe("rejected");
    expect(settled.tasks[0].invocations?.[0]).toMatchObject({
      attempt: 1,
      outcome: "failed",
      error: "workflow_invocation_interrupted",
    });
  });

  it.each(["claude", "codex"] as const)(
    "%s lead rejects stdout-only worker handoff without retry or backfill",
    async (host) => {
      await selectOrchestrator(fixture.cwd, host, { probe });
      const configured = runtimeFixture(fixture);
      const bindings = {
        lead: binding("lead", host),
        implementer: configured.selectedBinding("implementer", "glm"),
        reviewer: configured.selectedBinding("reviewer", "codex"),
      };
      await initWorkflowV2(fixture.cwd, plan(), bindings, {
        providerPolicy: "supervised",
        maxAttempts: 1,
        maxReviewPasses: 1,
      });
      fixture.configure({
        tasks: { component: { publication: "stdout-only" } },
      });
      const failed = await runWorkflow(
        fixture.cwd,
        "hosts",
        configured.runtime,
      );
      expect(failed.tasks[0]).toMatchObject({
        status: "failed",
        attempts: 1,
        error: "workflow_designated_result_missing",
      });
      expect(failed.tasks[0].invocations?.[0]).toMatchObject({
        orchestrationHost: host,
        outcome: "failed",
        error: "workflow_designated_result_missing",
      });
      expect(
        readFileSync(
          join(
            fixture.cwd,
            ".omc/state/team/hosts/artifacts/task-component-1.stdout.log",
          ),
          "utf8",
        ),
      ).toContain('"taskId":"component"');
      await expect(
        runWorkflow(fixture.cwd, "hosts", configured.runtime),
      ).rejects.toThrow("workflow_attempt_limit_reached");
      expect(readWorkflow(fixture.cwd, "hosts").tasks[0].attempts).toBe(1);
    },
  );

  it.each(["claude", "codex"] as const)(
    "%s lead fails closed on a worker checkpoint-shaped protected ref",
    async (host) => {
      await selectOrchestrator(fixture.cwd, host, { probe });
      const configured = runtimeFixture(fixture);
      const bindings = {
        lead: binding("lead", host),
        implementer: configured.selectedBinding("implementer", "glm"),
        reviewer: configured.selectedBinding("reviewer", "codex"),
      };
      await initWorkflowV2(fixture.cwd, plan(), bindings, {
        providerPolicy: "supervised",
        maxAttempts: 1,
        maxReviewPasses: 1,
      });
      fixture.configure({
        tasks: { component: { protectedRef: "checkpoint" } },
      });
      await expect(
        runWorkflow(fixture.cwd, "hosts", configured.runtime),
      ).rejects.toThrow("workflow_protected_refs_changed");
      const failed = readWorkflow(fixture.cwd, "hosts").tasks[0];
      expect(failed).toMatchObject({
        status: "failed",
        attempts: 1,
        error: "workflow_protected_refs_changed",
      });
      expect(failed.invocations?.[0]).toMatchObject({
        orchestrationHost: host,
        outcome: "failed",
        error: "workflow_protected_refs_changed",
      });
    },
  );
});
