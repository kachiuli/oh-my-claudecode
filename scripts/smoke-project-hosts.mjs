#!/usr/bin/env node
/** Packaged project setup smoke. All homes, providers and repositories are synthetic. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

const packageFile = process.argv[2];
if (!packageFile || !existsSync(packageFile))
  throw new Error("Usage: node scripts/smoke-project-hosts.mjs <package.tgz>");
const temporaryRoot = mkdtempSync(join(tmpdir(), "omc-project-package-"));
const repository = join(temporaryRoot, "repository");
const home = join(temporaryRoot, "home");
const prefix = join(temporaryRoot, "installation");
const bin = join(temporaryRoot, "bin");
for (const path of [repository, home, prefix, bin])
  mkdirSync(path, { recursive: true });
const environment = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  CLAUDE_CONFIG_DIR: join(home, ".claude"),
  CODEX_HOME: join(home, ".codex"),
  OMC_CONFIG_DIR: join(home, ".omc"),
  OMC_CLI_SKIP_PARSE: "",
  PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
};
for (const name of Object.keys(environment)) {
  if (
    /^(?:OMC_(?:TEAM_|ORCHESTRATOR_|STATE_DIR|SESSION_ID)|CLAUDECODE|CLAUDE_CODE_SESSION_ID)/.test(
      name,
    )
  )
    delete environment[name];
  if (
    /^(?:OPENAI_|ANTHROPIC_|OMC_GLM_|GLM_|ZAI_|Z_AI_|CLAUDE_(?!CONFIG_DIR$)|CODEX_(?!HOME$))/i.test(
      name,
    )
  )
    delete environment[name];
}
function run(command, args, cwd = repository) {
  const result = spawnSync(command, args, {
    cwd,
    env: environment,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    timeout: 180_000,
  });
  assert.equal(result.error, undefined, `${command} failed to start`);
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(" ")}: ${result.stderr}\n${result.stdout}`,
  );
  return result.stdout;
}
try {
  // Native executable fixtures prove CLI discovery/switching only; they do not authenticate providers.
  for (const host of ["claude", "codex"])
    copyFileSync(
      process.execPath,
      join(bin, `${host}${process.platform === "win32" ? ".exe" : ""}`),
    );
  const npmCli = process.env.npm_execpath;
  if (!npmCli)
    throw new Error(
      "Run through npm run smoke:project-hosts -- <package.tgz> so npm_execpath is available.",
    );
  run(process.execPath, [
    npmCli,
    "install",
    "--prefix",
    prefix,
    "--no-audit",
    "--no-fund",
    "--package-lock=false",
    resolve(packageFile),
  ]);
  run(process.execPath, [
    "-e",
    'const Database = require(process.argv[1]); const db = new Database(":memory:"); if (db.prepare("select 1 as ok").get().ok !== 1) process.exitCode = 1; db.close();',
    join(prefix, "node_modules", "better-sqlite3"),
  ]);
  const entry = join(
    prefix,
    "node_modules",
    "oh-my-claude-sisyphus",
    "bin",
    "oh-my-claudecode.js",
  );
  const omc = (...args) => run(process.execPath, [entry, ...args]);
  run("git", ["init", "-b", "main"]);
  writeFileSync(join(repository, "CLAUDE.md"), "# User Claude guidance\n");
  writeFileSync(join(repository, "AGENTS.md"), "# User Codex guidance\n");
  mkdirSync(join(repository, ".codex"));
  writeFileSync(
    join(repository, ".codex", "config.toml"),
    'model = "user-selected-model"\n',
  );
  omc("setup", "--host", "both", "--scope", "project");
  const assets = [
    "CLAUDE.md",
    "AGENTS.md",
    ".codex/config.toml",
    ".omc/orchestrator.json",
  ];
  const before = new Map(
    assets.map((path) => [path, readFileSync(join(repository, path))]),
  );
  omc("setup", "--host", "both", "--scope", "project");
  for (const [path, bytes] of before)
    assert.deepEqual(
      readFileSync(join(repository, path)),
      bytes,
      `Idempotent setup changed ${path}`,
    );
  for (const host of ["codex", "claude", "codex"])
    omc("orchestrator", "use", host);
  for (const [path, bytes] of before)
    assert.deepEqual(
      readFileSync(join(repository, path)),
      bytes,
      `Switching rewrote ${path}`,
    );
  assert.match(omc("orchestrator", "status", "--json"), /codex/);
  assert.match(omc("doctor", "hosts", "--json"), /codex/);
  assert.match(
    readFileSync(join(repository, "AGENTS.md"), "utf8"),
    /User Codex guidance/,
  );
  assert.match(
    readFileSync(join(repository, ".codex/config.toml"), "utf8"),
    /user-selected-model/,
  );
  omc("update", "--host", "both", "--scope", "project");
  omc("uninstall", "--host", "claude", "--scope", "project");
  assert.equal(
    readFileSync(join(repository, "CLAUDE.md"), "utf8"),
    "# User Claude guidance\n",
  );
  assert.deepEqual(
    readFileSync(join(repository, "AGENTS.md")),
    before.get("AGENTS.md"),
  );
  console.log(
    "PASS: packaged dual setup, idempotent upgrade, repeated switching, user-file preservation and independent uninstall (synthetic; no provider authentication).",
  );
} finally {
  rmSync(temporaryRoot, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}
