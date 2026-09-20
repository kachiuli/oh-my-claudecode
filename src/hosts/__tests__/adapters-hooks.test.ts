import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configureOrchestratorRepository,
  ORCHESTRATOR_ENV,
  selectOrchestrator,
} from "../../orchestration/selection.js";
import { buildHostLaunchArgs } from "../adapters.js";
import { handleHostHook } from "../hooks.js";

const temporaryDirectories: string[] = [];

function temporaryRepository(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "omc-host-adapter-")));
  execFileSync("git", ["init", "-q"], { cwd: root, windowsHide: true });
  temporaryDirectories.push(root);
  return root;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("host launch adapters", () => {
  it("adds the managed Claude plugin without overriding user model or permission flags", () => {
    const root = temporaryRepository();
    expect(
      buildHostLaunchArgs(
        "claude",
        root,
        ["--model", "user-model"],
        "session-1",
      ),
    ).toEqual([
      "--plugin-dir",
      join(root, ".omc", "hosts", "claude", "plugin"),
      "--resume",
      "session-1",
      "--model",
      "user-model",
    ]);
  });

  it("pins Codex to the repository workspace-write sandbox and removes conflicting root flags", () => {
    const root = temporaryRepository();
    expect(
      buildHostLaunchArgs(
        "codex",
        root,
        ["--cd=/elsewhere", "--model", "user-model"],
        "thread-1",
      ),
    ).toEqual([
      "resume",
      "thread-1",
      "--sandbox",
      "workspace-write",
      "--cd",
      root,
      "--model",
      "user-model",
    ]);
  });

  it("preserves an explicit stricter Codex sandbox and rejects unsafe overrides", () => {
    const root = temporaryRepository();
    expect(buildHostLaunchArgs("codex", root, ["-sread-only"])).toContain(
      "read-only",
    );
    expect(() =>
      buildHostLaunchArgs("codex", root, ["--sandbox=danger-full-access"]),
    ).toThrow("orchestrator_unsafe_sandbox_override");
    expect(() =>
      buildHostLaunchArgs("codex", root, ["-sread-only", "--full-auto"]),
    ).toThrow("orchestrator_conflicting_sandbox_options");
  });

  it("rejects Codex sandbox bypasses, workspace expansion, and native config overrides", () => {
    const root = temporaryRepository();
    for (const args of [
      ["--dangerously-bypass-approvals-and-sandbox"],
      ["--yolo"],
      ["--add-dir", ".."],
      ["--add-dir=.."],
      ["-c", 'sandbox_mode="danger-full-access"'],
      ["-c", '"sandbox_mode" = "danger-full-access"'],
      ["-c", 'sandbox_workspace_write . "writable_roots"=[".."]'],
      ["-c", 'profiles.unsafe.sandbox_permissions=["disk-full-read-access"]'],
      ['--config=sandbox_workspace_write.writable_roots=[".."]'],
    ]) {
      expect(() => buildHostLaunchArgs("codex", root, args)).toThrow(
        /orchestrator_(?:unsafe_sandbox_bypass|workspace_expansion_refused|sandbox_config_override_refused)/,
      );
    }
  });

  it("preserves ordinary Codex config overrides and rejects remote hosts", () => {
    const root = temporaryRepository();
    expect(
      buildHostLaunchArgs("codex", root, ["-c", 'model="user-model"']),
    ).toContain('model="user-model"');
    expect(() =>
      buildHostLaunchArgs("codex", root, ["--remote", "ws://elsewhere"]),
    ).toThrow("orchestrator_remote_host_refused");
  });
});

describe("native host lifecycle adapter", () => {
  it("records SessionStart and rejects the same native session after a host switch", async () => {
    const root = temporaryRepository();
    for (const key of Object.values(ORCHESTRATOR_ENV))
      vi.stubEnv(key, undefined);
    await configureOrchestratorRepository(root, {
      schemaVersion: 1,
      supportedHosts: ["claude", "codex"],
      defaultHost: "codex",
    });
    const payload = {
      session_id: "thread-123",
      cwd: root,
      hook_event_name: "SessionStart",
      source: "startup",
    };
    const start = await handleHostHook(root, "codex", payload);
    expect(start.continue).toBe(true);
    await expect(
      handleHostHook(root, "codex", {
        session_id: "thread-123",
        cwd: root,
        hook_event_name: "Stop",
      }),
    ).resolves.toEqual({ continue: true, suppressOutput: true });

    await selectOrchestrator(root, "claude", { probe: () => true });
    await expect(
      handleHostHook(root, "codex", {
        session_id: "thread-123",
        cwd: root,
        hook_event_name: "Stop",
      }),
    ).rejects.toThrow("orchestrator_session_stale_or_cross_host");
  });
});
