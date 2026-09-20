import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readOrchestratorRepositoryConfig,
  selectOrchestrator,
} from "../../orchestration/selection.js";
import {
  doctorProjectHosts,
  setupProjectHosts,
  uninstallProjectHost,
} from "../project-setup.js";

const PACKAGE_ROOT = resolve(".");
const temporaryDirectories: string[] = [];

function temporaryRepository(): string {
  const root = mkdtempSync(join(tmpdir(), "omc-host-assets-"));
  execFileSync("git", ["init", "-q"], { cwd: root, windowsHide: true });
  temporaryDirectories.push(root);
  return root;
}

function write(path: string, content: string): void {
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, content, "utf8");
}

function isIgnored(root: string, path: string): boolean {
  const result = spawnSync("git", ["check-ignore", "-q", "--", path], {
    cwd: root,
    windowsHide: true,
  });
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error(`git_check_ignore_failed: ${result.status}`);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("project host setup", () => {
  it("installs both hosts idempotently while preserving project instructions, hooks, and MCP config", async () => {
    const root = temporaryRepository();
    write(join(root, "CLAUDE.md"), "# User Claude guidance\n");
    write(join(root, "AGENTS.md"), "# User Codex guidance\n");
    write(
      join(root, ".codex", "config.toml"),
      '[mcp_servers.user]\ncommand = "user-server"\n',
    );
    write(
      join(root, ".codex", "hooks.json"),
      `${JSON.stringify({ description: "user hooks", hooks: { PostToolUse: [{ hooks: [{ type: "command", command: "user-check" }] }] } }, null, 2)}\n`,
    );
    write(
      join(root, ".agents", "plugins", "marketplace.json"),
      `${JSON.stringify({ name: "user-market", plugins: [{ name: "user-plugin", source: { source: "local", path: "./plugins/user" } }] }, null, 2)}\n`,
    );

    const first = await setupProjectHosts(root, ["claude", "codex"], {
      packageRoot: PACKAGE_ROOT,
    });
    expect(first.dryRun).toBe(false);
    expect(first.changedFiles).toContain("CLAUDE.md");
    expect(first.changedFiles).toContain("AGENTS.md");
    expect(readFileSync(join(root, "CLAUDE.md"), "utf8")).toContain(
      "# User Claude guidance",
    );
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toContain(
      "# User Codex guidance",
    );
    expect(readFileSync(join(root, ".codex", "config.toml"), "utf8")).toContain(
      "[mcp_servers.user]",
    );
    expect(readFileSync(join(root, ".codex", "config.toml"), "utf8")).toContain(
      "[mcp_servers.omc]",
    );
    expect(readFileSync(join(root, ".codex", "config.toml"), "utf8")).toContain(
      '[plugins."omc-project-host@user-market"]',
    );
    const hooks = JSON.parse(
      readFileSync(join(root, ".codex", "hooks.json"), "utf8"),
    ) as {
      description: string;
      hooks: Record<string, unknown[]>;
    };
    expect(hooks.description).toBe("user hooks");
    expect(hooks.hooks.PostToolUse).toHaveLength(1);
    expect(hooks.hooks.SessionStart).toHaveLength(1);
    const pluginHooks = JSON.parse(
      readFileSync(
        join(root, ".omc", "hosts", "codex", "plugin", "hooks", "hooks.json"),
        "utf8",
      ),
    ) as { hooks: Record<string, unknown[]> };
    expect(pluginHooks.hooks.SessionStart).toHaveLength(1);
    const marketplace = JSON.parse(
      readFileSync(
        join(root, ".agents", "plugins", "marketplace.json"),
        "utf8",
      ),
    ) as {
      plugins: {
        name: string;
        policy?: { installation?: string; authentication?: string };
        category?: string;
      }[];
    };
    expect(marketplace.plugins.map((entry) => entry.name)).toEqual([
      "user-plugin",
      "omc-project-host",
    ]);
    expect(marketplace.plugins[1]).toMatchObject({
      policy: {
        installation: "INSTALLED_BY_DEFAULT",
        authentication: "ON_USE",
      },
      category: "Productivity",
    });
    expect(
      existsSync(
        join(root, ".agents", "skills", "omc-orchestration", "SKILL.md"),
      ),
    ).toBe(true);
    expect(existsSync(join(root, ".codex", "agents", "executor.toml"))).toBe(
      true,
    );
    expect(
      existsSync(
        join(
          root,
          ".omc",
          "hosts",
          "claude",
          "plugin",
          ".claude-plugin",
          "plugin.json",
        ),
      ),
    ).toBe(true);
    expect(readOrchestratorRepositoryConfig(root)).toEqual({
      schemaVersion: 1,
      supportedHosts: ["claude", "codex"],
      defaultHost: "claude",
    });

    const second = await setupProjectHosts(root, ["claude", "codex"], {
      packageRoot: PACKAGE_ROOT,
    });
    expect(second.changedFiles).toEqual([]);
  });

  it("reports a dry run without writing files", async () => {
    const root = temporaryRepository();
    const result = await setupProjectHosts(root, ["codex"], {
      packageRoot: PACKAGE_ROOT,
      dryRun: true,
    });
    expect(result.dryRun).toBe(true);
    expect(result.changedFiles).toContain("AGENTS.md");
    expect(existsSync(join(root, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(root, ".omc", "orchestrator.json"))).toBe(false);
  });

  it("leaves shared config visible and ignores local setup data in a fresh repository", async () => {
    const root = temporaryRepository();
    await setupProjectHosts(root, ["codex"], { packageRoot: PACKAGE_ROOT });
    write(join(root, ".omc", "state", "local.json"), "{}\n");

    expect(isIgnored(root, ".omc/orchestrator.json")).toBe(false);
    expect(isIgnored(root, ".omc/state/local.json")).toBe(true);
    expect(isIgnored(root, ".omc/hosts/receipt.json")).toBe(true);
  });

  it("preserves existing project ignore semantics and unrelated OMC exceptions", async () => {
    const root = temporaryRepository();
    const original = [
      "user-cache/",
      "/.omc/*",
      "!/.omc/user-kept/",
      "!/.omc/user-kept/**",
      "",
    ].join("\n");
    write(join(root, ".gitignore"), original);
    write(join(root, ".omc", "user-kept", "note.txt"), "user-owned\n");
    write(join(root, ".omc", "notepad.md"), "private\n");

    await setupProjectHosts(root, ["codex"], { packageRoot: PACKAGE_ROOT });
    write(join(root, ".omc", "state", "local.json"), "{}\n");

    const installed = readFileSync(join(root, ".gitignore"), "utf8");
    expect(installed).toContain(original.trimEnd());
    expect(installed.match(/# BEGIN OMC PROJECT HOST STATE/g)).toHaveLength(1);
    expect(
      readFileSync(join(root, ".omc", "user-kept", "note.txt"), "utf8"),
    ).toBe("user-owned\n");
    expect(isIgnored(root, ".omc/orchestrator.json")).toBe(true);
    expect(isIgnored(root, ".omc/user-kept/note.txt")).toBe(false);
    expect(isIgnored(root, ".omc/notepad.md")).toBe(true);
    expect(isIgnored(root, ".omc/state/local.json")).toBe(true);
    expect(isIgnored(root, ".omc/hosts/receipt.json")).toBe(true);

    await setupProjectHosts(root, ["codex"], { packageRoot: PACKAGE_ROOT });
    expect(
      readFileSync(join(root, ".gitignore"), "utf8").match(
        /# BEGIN OMC PROJECT HOST STATE/g,
      ),
    ).toHaveLength(1);
  });

  it("fails before mutation when an unowned generated-file target collides", async () => {
    const root = temporaryRepository();
    write(join(root, "CLAUDE.md"), "# unchanged\n");
    write(
      join(root, ".agents", "skills", "omc-orchestration", "SKILL.md"),
      "user-owned\n",
    );
    await expect(
      setupProjectHosts(root, ["claude", "codex"], {
        packageRoot: PACKAGE_ROOT,
      }),
    ).rejects.toThrow("host_assets_collision");
    expect(readFileSync(join(root, "CLAUDE.md"), "utf8")).toBe("# unchanged\n");
    expect(existsSync(join(root, ".gitignore"))).toBe(false);
    expect(existsSync(join(root, ".omc", "orchestrator.json"))).toBe(false);
    expect(existsSync(join(root, ".omc", "hosts", "receipt.json"))).toBe(false);
  });

  it("refuses a user-owned Codex plugin config table without mutating files", async () => {
    const root = temporaryRepository();
    const config =
      '[plugins . "omc-project-host@team-market"]\nenabled = false\n';
    write(join(root, ".codex", "config.toml"), config);
    write(
      join(root, ".agents", "plugins", "marketplace.json"),
      '{"name":"team-market","plugins":[]}\n',
    );

    await expect(
      setupProjectHosts(root, ["codex"], { packageRoot: PACKAGE_ROOT }),
    ).rejects.toThrow("host_assets_plugin_config_collision");
    expect(readFileSync(join(root, ".codex", "config.toml"), "utf8")).toBe(
      config,
    );
    expect(existsSync(join(root, "AGENTS.md"))).toBe(false);
  });

  it.each([
    {
      name: "spaced and quoted MCP table",
      config: '[mcp_servers . "omc"]\ncommand = "user-server"\n',
      error: "host_assets_mcp_name_collision",
    },
    {
      name: "quoted MCP dotted assignment",
      config: '"mcp_servers" . "omc" = { command = "user-server" }\n',
      error: "host_assets_mcp_name_collision",
    },
    {
      name: "inline plugin parent",
      config:
        'plugins = { "omc-project-host@team-market" = { enabled = false } }\n',
      error: "host_assets_plugin_config_collision",
    },
    {
      name: "plugin assignment under its parent table",
      config:
        '[plugins]\n"omc-project-host@team-market" = { enabled = false }\n',
      error: "host_assets_plugin_config_collision",
    },
  ])("refuses $name without any setup mutation", async ({ config, error }) => {
    const root = temporaryRepository();
    const marketplace = '{"name":"team-market","plugins":[]}\n';
    write(join(root, ".codex", "config.toml"), config);
    write(join(root, ".agents", "plugins", "marketplace.json"), marketplace);

    await expect(
      setupProjectHosts(root, ["codex"], { packageRoot: PACKAGE_ROOT }),
    ).rejects.toThrow(error);
    expect(readFileSync(join(root, ".codex", "config.toml"), "utf8")).toBe(
      config,
    );
    expect(
      readFileSync(
        join(root, ".agents", "plugins", "marketplace.json"),
        "utf8",
      ),
    ).toBe(marketplace);
    expect(existsSync(join(root, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(root, ".omc", "orchestrator.json"))).toBe(false);
    expect(existsSync(join(root, ".omc", "hosts", "receipt.json"))).toBe(false);
  });

  it("removes only managed content from obsolete block and JSON-hook assets", async () => {
    const root = temporaryRepository();
    await setupProjectHosts(root, ["codex"], { packageRoot: PACKAGE_ROOT });
    const block = "<!-- OLD OMC -->\nmanaged\n<!-- END OLD OMC -->";
    const legacyHook = {
      matcher: "*",
      hooks: [{ type: "command", command: "old-omc-hook" }],
    };
    const managedHooks = JSON.stringify({ SessionStart: [legacyHook] });
    write(join(root, "LEGACY.md"), `# user\n\n${block}\n`);
    write(
      join(root, ".codex", "legacy-hooks.json"),
      `${JSON.stringify(
        {
          hooks: {
            PostToolUse: [
              { hooks: [{ type: "command", command: "user-hook" }] },
            ],
            SessionStart: [legacyHook],
          },
        },
        null,
        2,
      )}\n`,
    );
    const receiptPath = join(root, ".omc", "hosts", "receipt.json");
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as {
      hosts: { codex: { assets: Record<string, unknown>[] } };
    };
    receipt.hosts.codex.assets.push(
      {
        path: "LEGACY.md",
        kind: "block",
        digest: createHash("sha256").update(block).digest("hex"),
        managedText: block,
      },
      {
        path: ".codex/legacy-hooks.json",
        kind: "json-hooks",
        digest: createHash("sha256").update(managedHooks).digest("hex"),
        managedText: managedHooks,
      },
    );
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");

    await setupProjectHosts(root, ["codex"], { packageRoot: PACKAGE_ROOT });

    expect(readFileSync(join(root, "LEGACY.md"), "utf8")).toBe("# user\n");
    const hooks = JSON.parse(
      readFileSync(join(root, ".codex", "legacy-hooks.json"), "utf8"),
    ) as { hooks: Record<string, unknown[]> };
    expect(hooks.hooks.PostToolUse).toHaveLength(1);
    expect(hooks.hooks.SessionStart).toBeUndefined();
  });

  it("uninstalls only verified assets, preserves modifications, and retains the other host", async () => {
    const root = temporaryRepository();
    await setupProjectHosts(root, ["claude", "codex"], {
      packageRoot: PACKAGE_ROOT,
    });
    await selectOrchestrator(root, "codex", { probe: () => true });
    const modified = join(
      root,
      ".omc",
      "hosts",
      "claude",
      "plugin",
      "agents",
      "executor.md",
    );
    writeFileSync(modified, "# user changed this managed projection\n", "utf8");

    const result = await uninstallProjectHost(root, "claude");
    expect(result.remainingHosts).toEqual(["codex"]);
    expect(result.preservedFiles).toContain(
      ".omc/hosts/claude/plugin/agents/executor.md",
    );
    expect(readFileSync(modified, "utf8")).toBe(
      "# user changed this managed projection\n",
    );
    expect(existsSync(join(root, "CLAUDE.md"))).toBe(false);
    expect(existsSync(join(root, "AGENTS.md"))).toBe(true);
    expect(existsSync(join(root, ".codex", "agents", "executor.toml"))).toBe(
      true,
    );
    expect(readOrchestratorRepositoryConfig(root)?.supportedHosts).toEqual([
      "codex",
    ]);
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toContain(
      "# BEGIN OMC PROJECT HOST STATE",
    );
    expect(isIgnored(root, ".omc/orchestrator.json")).toBe(false);
    expect(isIgnored(root, ".omc/hosts/receipt.json")).toBe(true);
  });

  it("restores an existing Codex marketplace when its managed plugin is removed", async () => {
    const root = temporaryRepository();
    const originalMarketplace =
      '{"name":"team-market","plugins":[{"name":"team-plugin","source":{"source":"local","path":"./plugins/team"}}]}\n';
    write(
      join(root, ".agents", "plugins", "marketplace.json"),
      originalMarketplace,
    );
    await setupProjectHosts(root, ["claude", "codex"], {
      packageRoot: PACKAGE_ROOT,
    });

    await uninstallProjectHost(root, "codex");

    expect(
      readFileSync(
        join(root, ".agents", "plugins", "marketplace.json"),
        "utf8",
      ),
    ).toBe(originalMarketplace);
    expect(
      existsSync(
        join(
          root,
          ".omc",
          "hosts",
          "codex",
          "plugin",
          ".codex-plugin",
          "plugin.json",
        ),
      ),
    ).toBe(false);
  });

  it("rolls back every owned removal when uninstall targets the active host", async () => {
    const root = temporaryRepository();
    await setupProjectHosts(root, ["claude", "codex"], {
      packageRoot: PACKAGE_ROOT,
    });
    const beforeInstructions = readFileSync(join(root, "CLAUDE.md"), "utf8");
    const beforeReceipt = readFileSync(
      join(root, ".omc", "hosts", "receipt.json"),
      "utf8",
    );

    await expect(uninstallProjectHost(root, "claude")).rejects.toThrow(
      "orchestrator_cannot_uninstall_active_host",
    );
    expect(readFileSync(join(root, "CLAUDE.md"), "utf8")).toBe(
      beforeInstructions,
    );
    expect(
      readFileSync(join(root, ".omc", "hosts", "receipt.json"), "utf8"),
    ).toBe(beforeReceipt);
    expect(
      existsSync(join(root, ".omc", "hosts", "claude", "plugin", ".mcp.json")),
    ).toBe(true);
    expect(readOrchestratorRepositoryConfig(root)?.supportedHosts).toEqual([
      "claude",
      "codex",
    ]);
  });

  it("refuses to remove the final supported host without touching its assets", async () => {
    const root = temporaryRepository();
    await setupProjectHosts(root, ["codex"], { packageRoot: PACKAGE_ROOT });
    const beforeReceipt = readFileSync(
      join(root, ".omc", "hosts", "receipt.json"),
      "utf8",
    );

    await expect(uninstallProjectHost(root, "codex")).rejects.toThrow(
      "orchestrator_cannot_remove_last_host",
    );
    expect(
      readFileSync(join(root, ".omc", "hosts", "receipt.json"), "utf8"),
    ).toBe(beforeReceipt);
    expect(existsSync(join(root, ".codex", "agents", "executor.toml"))).toBe(
      true,
    );
  });

  it("doctor detects modified managed assets without changing them", async () => {
    const root = temporaryRepository();
    await setupProjectHosts(root, ["codex"], { packageRoot: PACKAGE_ROOT });
    const agent = join(root, ".codex", "agents", "executor.toml");
    writeFileSync(agent, "user modification\n", "utf8");

    const result = await doctorProjectHosts(root);
    expect(result.hosts.codex.installed).toBe(true);
    expect(result.hosts.codex.healthy).toBe(false);
    expect(result.hosts.codex.issues).toContain(
      "modified managed asset: .codex/agents/executor.toml",
    );
    expect(readFileSync(agent, "utf8")).toBe("user modification\n");
  });

  it("doctor reports a modified shared ignore block", async () => {
    const root = temporaryRepository();
    await setupProjectHosts(root, ["codex"], { packageRoot: PACKAGE_ROOT });
    const path = join(root, ".gitignore");
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace("/.omc/state/", "/.omc/changed/"),
      "utf8",
    );

    const result = await doctorProjectHosts(root);
    expect(result.healthy).toBe(false);
    expect(result.issues).toContain("modified managed block: .gitignore");
  });
});
