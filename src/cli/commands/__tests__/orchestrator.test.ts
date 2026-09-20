import { describe, expect, it } from "vitest";
import { Command } from "commander";
import {
  orchestratorHost,
  registerOrchestratorCommands,
} from "../orchestrator.js";

describe("orchestrator CLI", () => {
  it("registers discoverable host operations and explicit checkpoint handoff", () => {
    const program = new Command();
    registerOrchestratorCommands(program);
    const command = program.commands.find(
      (entry) => entry.name() === "orchestrator",
    )!;
    expect(command.commands.map((entry) => entry.name())).toEqual(
      expect.arrayContaining(["status", "use", "handoff", "hook"]),
    );
    const handoff = command.commands.find(
      (entry) => entry.name() === "handoff",
    )!;
    expect(
      handoff.options.find((option) => option.long === "--checkpoint")
        ?.mandatory,
    ).toBe(true);
  });
  it("keeps provider model names distinct from host names", () => {
    expect(orchestratorHost("claude")).toBe("claude");
    expect(orchestratorHost("codex")).toBe("codex");
    for (const value of ["glm", "glm-5.3-flash", "both", "Codex", ""])
      expect(() => orchestratorHost(value)).toThrow();
  });
});
