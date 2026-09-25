#!/usr/bin/env node
/** Offline validation using installed native CLIs; never makes a model request. Run after build. */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { setupProjectHosts } from "../dist/hosts/project-setup.js";
import {
  selectOrchestrator,
  readOrchestratorStatus,
} from "../dist/orchestration/selection.js";
import { launchProjectOrchestrator } from "../dist/cli/project-launch.js";
import { resolveProjectOmcPath } from "../dist/lib/worktree-paths.js";
const packageRoot = resolve(".");
if (!process.argv[2] || !process.argv[3])
  throw new Error(
    "Usage: node scripts/smoke-native-project-hosts.mjs <claude-executable> <codex-executable>",
  );
const root = mkdtempSync(join(tmpdir(), "omc-native-help-"));
const home = join(root, "home");
const repository = join(root, "repo");
mkdirSync(home);
mkdirSync(repository);
const binaries = { claude: process.argv[2], codex: process.argv[3] };
for (const key of Object.keys(process.env)) {
  if (
    /^(?:OMC_(?:ORCHESTRATOR_|WORKFLOW_|TEAM_|STATE_DIR)|OPENAI_|ANTHROPIC_|ZAI_|Z_AI_|GLM_|MIMO_|OMC_GLM_|OMC_MIMO_|CLAUDE_|CLAUDECODE|CODEX_)/i.test(
      key,
    )
  )
    delete process.env[key];
}
Object.assign(process.env, {
  HOME: home,
  USERPROFILE: home,
  CLAUDE_CONFIG_DIR: join(home, ".claude"),
  CODEX_HOME: join(home, ".codex"),
});
try {
  execFileSync("git", ["init", "-q"], { cwd: repository });
  await setupProjectHosts(repository, ["claude", "codex"], { packageRoot });
  const validation = execFileSync(
    binaries.claude,
    [
      "plugin",
      "validate",
      resolveProjectOmcPath("hosts/claude/plugin", repository),
    ],
    { cwd: repository, env: process.env, encoding: "utf8", timeout: 30000 },
  );
  console.log(validation);
  mkdirSync(process.env.CODEX_HOME, { recursive: true });
  writeFileSync(
    join(process.env.CODEX_HOME, "config.toml"),
    `[projects.${JSON.stringify(repository)}]\ntrust_level = "trusted"\n`,
  );
  const servers = JSON.parse(
    execFileSync(binaries.codex, ["mcp", "list", "--json"], {
      cwd: repository,
      env: process.env,
      encoding: "utf8",
      timeout: 30000,
    }),
  );
  assert.ok(servers.some((server) => server.name === "omc"));
  execFileSync(binaries.codex, ["plugin", "marketplace", "add", repository], {
    cwd: repository,
    env: process.env,
    encoding: "utf8",
    timeout: 30000,
  });
  const plugins = JSON.parse(
    execFileSync(
      binaries.codex,
      [
        "plugin",
        "list",
        "--marketplace",
        "omc-project",
        "--available",
        "--json",
      ],
      {
        cwd: repository,
        env: process.env,
        encoding: "utf8",
        timeout: 30000,
      },
    ),
  );
  const availablePlugins = Array.isArray(plugins)
    ? plugins
    : [...(plugins.available ?? []), ...(plugins.installed ?? [])];
  assert.ok(
    availablePlugins.some(
      (plugin) =>
        plugin.pluginId === "omc-project-host@omc-project" ||
        plugin.name === "omc-project-host",
    ),
  );
  console.log(
    "PASS native Claude plugin validation and Codex trusted-project MCP/marketplace parsing (offline).",
  );
  const probe = (host) => ({ found: true, path: binaries[host] });
  for (const host of ["claude", "codex"]) {
    await selectOrchestrator(repository, host, { probe });
    const handled = await launchProjectOrchestrator(["--help"], {
      cwd: repository,
      probe,
    });
    assert.equal(handled, true);
    assert.equal(process.exitCode ?? 0, 0);
    assert.equal(readOrchestratorStatus(repository, { probe }).lease, null);
    console.log(
      `PASS native ${host} executable accepts project launch arguments and releases lease (help only; no authentication).`,
    );
  }
} finally {
  rmSync(root, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}
