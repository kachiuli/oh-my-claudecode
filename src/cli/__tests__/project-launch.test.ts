import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import {
  projectHostEnvironment,
  launchProjectOrchestrator,
} from "../project-launch.js";
import {
  configureOrchestratorRepository,
  handoffOrchestrator,
  ORCHESTRATOR_ENV,
  readOrchestratorLeaseCredentialsFromEnvironment,
  readOrchestratorStatus,
  recordOrchestratorSession,
  selectOrchestrator,
} from "../../orchestration/selection.js";
import { createWorkflowFixture } from "../../team/__tests__/helpers/workflow-fixture.js";

describe("project native orchestrator launch", () => {
  let fixture: ReturnType<typeof createWorkflowFixture>;
  const probe = () => ({
    found: true,
    path: process.execPath,
    version: "synthetic-native-host",
  });
  beforeEach(async () => {
    fixture = createWorkflowFixture();
    for (const key of Object.values(ORCHESTRATOR_ENV))
      vi.stubEnv(key, undefined);
    for (const key of [
      "OMC_TEAM_WORKER",
      "OMC_TEAM_WORKER_NAME",
      "OMC_TEAM_WORKTREE_PATH",
    ])
      vi.stubEnv(key, undefined);
    await configureOrchestratorRepository(fixture.cwd, {
      schemaVersion: 1,
      supportedHosts: ["claude", "codex"],
      defaultHost: "claude",
    });
  });
  afterEach(() => {
    process.exitCode = 0;
    vi.unstubAllEnvs();
    fixture.dispose();
  });

  it("launches the selected native Codex lead with an isolated host environment and releases its lease", async () => {
    await selectOrchestrator(fixture.cwd, "codex", { probe });
    vi.stubEnv("ANTHROPIC_API_KEY", "synthetic-anthropic");
    vi.stubEnv("OPENAI_API_KEY", "synthetic-openai");
    const run = vi.fn(
      async (
        _command: string,
        args: string[],
        options: { cwd: string; env: NodeJS.ProcessEnv },
      ) => {
        expect(args).toContain("--sandbox");
        expect(args).toContain("workspace-write");
        expect(options.cwd).toBe(fixture.cwd);
        expect(options.env.ANTHROPIC_API_KEY).toBeUndefined();
        expect(options.env.OPENAI_API_KEY).toBe("synthetic-openai");
        expect(
          readOrchestratorLeaseCredentialsFromEnvironment(options.env)?.host,
        ).toBe("codex");
        expect(readOrchestratorStatus(fixture.cwd, { probe }).lease?.host).toBe(
          "codex",
        );
        return 0;
      },
    );
    expect(
      await launchProjectOrchestrator(["Lead this OMC workflow"], {
        cwd: fixture.cwd,
        probe,
        run,
      }),
    ).toBe(true);
    expect(run).toHaveBeenCalledOnce();
    expect(readOrchestratorStatus(fixture.cwd, { probe }).lease).toBeNull();
  });

  it("fails for a missing selected CLI without invoking another host", async () => {
    await selectOrchestrator(fixture.cwd, "codex", { probe });
    const run = vi.fn(async () => 0);
    await expect(
      launchProjectOrchestrator([], {
        cwd: fixture.cwd,
        probe: (host) => host === "claude",
        run,
      }),
    ).rejects.toThrow("orchestrator_host_unavailable");
    expect(run).not.toHaveBeenCalled();
  });

  it.each(["claude", "codex"] as const)(
    "consumes OMC notification flags before launching %s",
    async (host) => {
      await selectOrchestrator(fixture.cwd, host, { probe });
      vi.stubEnv("OMC_SLACK", "1");
      const run = vi.fn(
        async (
          _command: string,
          args: string[],
          options: { env: NodeJS.ProcessEnv },
        ) => {
          expect(args).toContain("lead this workflow");
          for (const flag of [
            "--notify",
            "false",
            "--telegram",
            "--discord",
            "--slack=false",
            "--webhook=0",
            "--openclaw=false",
          ])
            expect(args).not.toContain(flag);
          expect(options.env).toMatchObject({
            OMC_NOTIFY: "0",
            OMC_TELEGRAM: "1",
            OMC_DISCORD: "1",
            OMC_SLACK: "0",
            OMC_WEBHOOK: "0",
            OMC_OPENCLAW: "0",
          });
          return 0;
        },
      );
      await launchProjectOrchestrator(
        [
          "--notify",
          "false",
          "--telegram",
          "--discord",
          "--slack=false",
          "--webhook=0",
          "--openclaw=false",
          "lead this workflow",
        ],
        { cwd: fixture.cwd, probe, run },
      );
      expect(run).toHaveBeenCalledOnce();
      expect(process.env.OMC_SLACK).toBe("1");
    },
  );

  it("gives a Claude lead the controller's provider timeout for native Bash calls unless the user set one", () => {
    expect(projectHostEnvironment("claude", {})).toMatchObject({
      BASH_DEFAULT_TIMEOUT_MS: "3600000",
      BASH_MAX_TIMEOUT_MS: "3600000",
    });
    expect(
      projectHostEnvironment("claude", { BASH_DEFAULT_TIMEOUT_MS: "1000" }),
    ).toMatchObject({
      BASH_DEFAULT_TIMEOUT_MS: "1000",
      BASH_MAX_TIMEOUT_MS: "3600000",
    });
    const codex = projectHostEnvironment("codex", {});
    expect(codex.BASH_DEFAULT_TIMEOUT_MS).toBeUndefined();
    expect(codex.BASH_MAX_TIMEOUT_MS).toBeUndefined();
  });

  it.each(["claude", "codex"] as const)(
    "refuses legacy permission aliases on the adopted %s host",
    async (host) => {
      await selectOrchestrator(fixture.cwd, host, { probe });
      const run = vi.fn(async () => 0);
      for (const flag of [
        "--madmax",
        "--yolo",
        "--dangerously-skip-permissions",
      ])
        await expect(
          launchProjectOrchestrator([flag], { cwd: fixture.cwd, probe, run }),
        ).rejects.toThrow("orchestrator_unsafe_permission_alias");
      expect(run).not.toHaveBeenCalled();
    },
  );

  it("retains native exit status and releases a failed launch lease", async () => {
    const run = vi.fn(async () => 7);
    await launchProjectOrchestrator([], { cwd: fixture.cwd, probe, run });
    expect(process.exitCode).toBe(7);
    expect(readOrchestratorStatus(fixture.cwd, { probe }).lease).toBeNull();
    await expect(
      launchProjectOrchestrator([], {
        cwd: fixture.cwd,
        probe,
        run: async () => {
          throw new Error("synthetic spawn failure");
        },
      }),
    ).rejects.toThrow("synthetic spawn failure");
    expect(readOrchestratorStatus(fixture.cwd, { probe }).lease).toBeNull();
  });

  it("permits resume only for a registered native session from this host and selection", async () => {
    await selectOrchestrator(fixture.cwd, "codex", { probe });
    const sessionId = randomUUID();
    await recordOrchestratorSession(fixture.cwd, "codex", sessionId);
    const run = vi.fn(async (_command: string, args: string[]) => {
      expect(args).toContain("resume");
      expect(args).toContain(sessionId);
      return 0;
    });
    await launchProjectOrchestrator(["--resume", sessionId], {
      cwd: fixture.cwd,
      probe,
      run,
    });
    await selectOrchestrator(fixture.cwd, "claude", { probe });
    await expect(
      launchProjectOrchestrator(["--resume", sessionId], {
        cwd: fixture.cwd,
        probe,
        run,
      }),
    ).rejects.toThrow("orchestrator_session_stale_or_cross_host");
    await selectOrchestrator(fixture.cwd, "codex", { probe });
    await expect(
      launchProjectOrchestrator(["--resume", sessionId], {
        cwd: fixture.cwd,
        probe,
        run,
      }),
    ).rejects.toThrow("orchestrator_session_stale_or_cross_host");
    expect(run).toHaveBeenCalledOnce();
  });

  it("allows explicit checkpoint handoff while the old native host exits", async () => {
    await launchProjectOrchestrator([], {
      cwd: fixture.cwd,
      probe,
      run: async (_command, _args, options) => {
        const credentials = readOrchestratorLeaseCredentialsFromEnvironment(
          options.env,
        )!;
        await handoffOrchestrator(fixture.cwd, "codex", {
          credentials,
          checkpoint: {
            kind: "paused",
            reference: "synthetic-quiescent-boundary",
          },
          probe,
        });
        return 0;
      },
    });
    expect(readOrchestratorStatus(fixture.cwd, { probe }).active.host).toBe(
      "codex",
    );
    expect(readOrchestratorStatus(fixture.cwd, { probe }).lease).toBeNull();
  });

  it.each(
    [
      ["resume", "--last"],
      ["--continue"],
      ["--session-id", "some-session"],
      ["--cd", "/another/repository"],
      ["--worktree"],
      ["-C/another/repository"],
      ["-wbranch"],
      ["-rforeign-session"],
      ["--continue=true"],
      ["attach", "foreign-session"],
      ["respawn", "foreign-session"],
      ["--from-pr", "123"],
      ["--teleport", "foreign-session"],
      ["--cloud"],
      ["--environment=remote"],
      ["--safe-mode"],
      ["--bare"],
      ["--bg"],
      ["--background"],
      ["--permission-mode", "bypassPermissions"],
      ["--permission-mode=bypassPermissions"],
      ["--allow-dangerously-skip-permissions"],
    ].map((args) => ({ args })),
  )(
    "refuses unmanaged native session/root arguments $args",
    async ({ args }) => {
      await expect(
        launchProjectOrchestrator(args, {
          cwd: fixture.cwd,
          probe,
          run: async () => 0,
        }),
      ).rejects.toThrow();
    },
  );

  it.each([
    { host: "codex" as const, command: "app" },
    { host: "codex" as const, command: "queue" },
    { host: "codex" as const, command: "agents" },
    { host: "codex" as const, command: "exec-server" },
    { host: "claude" as const, command: "agents" },
    { host: "claude" as const, command: "ultrareview" },
  ])(
    "refuses the unmanaged $host $command command",
    async ({ host, command }) => {
      await selectOrchestrator(fixture.cwd, host, { probe });
      await expect(
        launchProjectOrchestrator([command], {
          cwd: fixture.cwd,
          probe,
          run: async () => 0,
        }),
      ).rejects.toThrow("orchestrator_unmanaged_session_transport");
    },
  );

  it("keeps OpenAI, Anthropic and GLM host credentials separate", () => {
    const environment = {
      OPENAI_API_KEY: "synthetic-o",
      ANTHROPIC_API_KEY: "synthetic-a",
      ZAI_API_KEY: "synthetic-z",
      OMC_GLM_COMMAND: "synthetic-glm",
      CODEX_HOME: "private-codex",
      CLAUDE_CONFIG_DIR: "private-claude",
      PATH: "system",
    };
    expect(projectHostEnvironment("codex", environment)).toEqual({
      OPENAI_API_KEY: "synthetic-o",
      CODEX_HOME: "private-codex",
      PATH: "system",
    });
    expect(projectHostEnvironment("claude", environment)).toEqual({
      ANTHROPIC_API_KEY: "synthetic-a",
      CLAUDE_CONFIG_DIR: "private-claude",
      PATH: "system",
      BASH_DEFAULT_TIMEOUT_MS: "3600000",
      BASH_MAX_TIMEOUT_MS: "3600000",
    });
    expect(() =>
      projectHostEnvironment("claude", {
        ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic",
      }),
    ).toThrow("orchestrator_foreign_claude_endpoint");
  });
});
