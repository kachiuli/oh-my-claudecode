#!/usr/bin/env node
/** Packaged project setup smoke. All homes, providers and repositories are synthetic. */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
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
import { pathToFileURL } from "node:url";

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
const COMMAND_TIMEOUT_MS = 180_000;
// A clean dependency install of the packed archive regularly needs more than three minutes on hosted Windows runners.
const INSTALL_TIMEOUT_MS = 900_000;
function run(
  command,
  args,
  cwd = repository,
  input,
  timeout = COMMAND_TIMEOUT_MS,
) {
  const result = spawnSync(command, args, {
    cwd,
    env: environment,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    timeout,
    input,
  });
  assert.equal(result.error, undefined, `${command} failed to start`);
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(" ")}: ${result.stderr}\n${result.stdout}`,
  );
  return result.stdout;
}

async function abandonPackagedOperation(packageRoot) {
  const moduleUrl = pathToFileURL(
    join(packageRoot, "dist", "orchestration", "selection.js"),
  ).href;
  const program = [
    `import { withOrchestratorOperation } from ${JSON.stringify(moduleUrl)};`,
    "await withOrchestratorOperation(process.cwd(), async () => {",
    '  process.send("operation-held");',
    "  await new Promise(() => setInterval(() => {}, 1000));",
    "});",
  ].join("\n");
  const worker = spawn(
    process.execPath,
    ["--input-type=module", "-e", program],
    {
      cwd: repository,
      env: environment,
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  const closed = new Promise((resolveClose) =>
    worker.once("close", resolveClose),
  );
  let stderr = "";
  worker.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-8_192);
  });
  // Retain an error listener after readiness while shutdown is in progress.
  worker.on("error", (error) => {
    stderr = error.message;
  });
  try {
    await new Promise((resolveReady, reject) => {
      const onError = (error) => settle(error);
      const onExit = () =>
        settle(
          new Error(`Operation fixture exited before recovery: ${stderr}`),
        );
      const onMessage = (message) => {
        if (message === "operation-held") settle();
        else settle(new Error("Unexpected operation fixture message"));
      };
      const timeout = setTimeout(
        () => settle(new Error(`Operation fixture timed out: ${stderr}`)),
        30_000,
      );
      const settle = (error) => {
        clearTimeout(timeout);
        worker.off("error", onError);
        worker.off("exit", onExit);
        worker.off("message", onMessage);
        if (error) reject(error);
        else resolveReady();
      };
      worker.once("error", onError);
      worker.once("exit", onExit);
      worker.once("message", onMessage);
    });
    assert.equal(worker.kill("SIGKILL"), true);
  } finally {
    if (worker.exitCode === null && worker.signalCode === null)
      worker.kill("SIGKILL");
    let closeTimeout;
    try {
      await Promise.race([
        closed,
        new Promise((_, reject) => {
          closeTimeout = setTimeout(
            () =>
              reject(
                new Error("Operation fixture did not close after termination"),
              ),
            10_000,
          );
        }),
      ]);
    } finally {
      clearTimeout(closeTimeout);
    }
  }
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
  run(
    process.execPath,
    [
      npmCli,
      "install",
      "--prefix",
      prefix,
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      resolve(packageFile),
    ],
    repository,
    undefined,
    INSTALL_TIMEOUT_MS,
  );
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
  const diagnoseCodexHooks = () =>
    JSON.parse(omc("doctor", "hosts", "--json")).hosts.codex.hookDiagnostics;
  const unobserved = diagnoseCodexHooks();
  assert.equal(unobserved.definition, "installed");
  assert.equal(unobserved.execution.status, "unobserved");
  assert.equal(unobserved.nativeTrust, "not-established");
  assert.equal(unobserved.capability, "unsupported");
  assert.ok(unobserved.guidance.some((step) => step.includes("upgrade")));
  // Exercise the packaged hook adapter directly; this is not native trust evidence.
  run(
    process.execPath,
    [entry, "orchestrator", "hook", "--host", "codex"],
    repository,
    JSON.stringify({
      hook_event_name: "SessionStart",
      session_id: "package-smoke-session",
      cwd: repository,
      source: "startup",
    }),
  );
  const observed = diagnoseCodexHooks();
  assert.equal(observed.execution.status, "observed");
  assert.equal(observed.nativeTrust, "not-established");
  assert.equal(observed.advisory, true);
  omc("orchestrator", "use", "claude");
  omc("orchestrator", "use", "codex");
  assert.equal(diagnoseCodexHooks().execution.status, "stale");
  await abandonPackagedOperation(
    join(prefix, "node_modules", "oh-my-claude-sisyphus"),
  );
  const blocked = spawnSync(
    process.execPath,
    [entry, "orchestrator", "use", "codex"],
    { cwd: repository, env: environment, encoding: "utf8", timeout: 30_000 },
  );
  assert.equal(blocked.error, undefined);
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /orchestrator_operation_locked/);
  const recovered = JSON.parse(
    omc(
      "orchestrator",
      "recover",
      "--checkpoint",
      "paused",
      "--reference",
      "package-smoke-killed-operation",
    ),
  );
  assert.equal(recovered.lastRecovery.recoveredOperationLock, true);
  assert.equal(recovered.lastRecovery.recoveredLease, false);
  assert.equal(
    recovered.lastRecovery.checkpoint.reference,
    "package-smoke-killed-operation",
  );
  omc("orchestrator", "use", "codex");
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
    "PASS: packaged dual setup, idempotent upgrade, repeated switching, advisory hook diagnostics, killed-operation recovery, user-file preservation and independent uninstall (synthetic; no provider authentication).",
  );
} finally {
  rmSync(temporaryRoot, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}
