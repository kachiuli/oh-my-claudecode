import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkflowRefAudit } from "../workflow-ref-audit.js";
import { createWorkflowFixture } from "./helpers/workflow-fixture.js";

describe("workflow protected-ref observation context", () => {
  let fixture: ReturnType<typeof createWorkflowFixture>;

  beforeEach(() => {
    fixture = createWorkflowFixture();
  });

  afterEach(() => {
    fixture.dispose();
  });

  it("records bounded lifecycle context without claiming a writer", () => {
    const audit = new WorkflowRefAudit(fixture.cwd, "context");
    fixture.git("update-ref", "refs/tags/before-start", fixture.baseCommit);
    audit.providerStarted("task-alpha");
    fixture.git("update-ref", "refs/tags/before-complete", fixture.baseCommit);
    audit.providerCompleted("task-alpha");

    const result = audit.finalize(
      () => join(fixture.root, "ref-audit.json"),
      [{ worker: "task-alpha", commitSha: fixture.baseCommit }],
    );
    expect(result.outcome).toBe("protected-refs-changed");
    const artifact = JSON.parse(
      readFileSync(result.artifact!.path, "utf8"),
    ) as {
      writer: string;
      changes: Array<{
        ref: string;
        observationContext: {
          meaning: string;
          activeWorkers: string[];
          completedWorkers: string[];
          boundaryWorker?: string;
          truncated: boolean;
        };
      }>;
    };
    expect(artifact.writer).toBe("unknown");
    expect(
      artifact.changes.find((change) => change.ref.endsWith("before-start")),
    ).toMatchObject({
      observationContext: {
        meaning: "observation-context-not-writer-attribution",
        activeWorkers: ["task-alpha"],
        completedWorkers: [],
        boundaryWorker: "task-alpha",
        truncated: false,
      },
    });
    expect(
      artifact.changes.find((change) => change.ref.endsWith("before-complete")),
    ).toMatchObject({
      observationContext: {
        meaning: "observation-context-not-writer-attribution",
        activeWorkers: [],
        completedWorkers: ["task-alpha"],
        boundaryWorker: "task-alpha",
        truncated: false,
      },
    });
  });

  it("caps worker sets retained with a ref observation", () => {
    const audit = new WorkflowRefAudit(fixture.cwd, "bounded-context");
    for (let index = 0; index < 40; index++)
      audit.providerStarted(`task-${String(index).padStart(2, "0")}`);
    fixture.git("update-ref", "refs/tags/bounded-context", fixture.baseCommit);
    audit.controllerReplayCompleted();
    const result = audit.finalize(
      () => join(fixture.root, "bounded-ref-audit.json"),
      [],
    );
    const artifact = JSON.parse(
      readFileSync(result.artifact!.path, "utf8"),
    ) as {
      changes: Array<{
        observationContext: { activeWorkers: string[]; truncated: boolean };
      }>;
    };
    expect(artifact.changes[0]!.observationContext.activeWorkers).toHaveLength(
      32,
    );
    expect(artifact.changes[0]!.observationContext.truncated).toBe(true);
  });
});
