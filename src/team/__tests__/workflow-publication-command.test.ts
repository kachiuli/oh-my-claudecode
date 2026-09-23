import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { workflowPublicationContract } from "../workflow-publication.js";

type EntrypointKind = "bridge" | "package-bin";

interface ShellCase {
  name: "bash" | "powershell" | "cmd";
  command: string;
  args(shellCommand: string): string[];
}

function availableShells(): ShellCase[] {
  const shells: ShellCase[] = [];
  const bashCandidates =
    process.platform === "win32"
      ? [
          "C:\\Program Files\\Git\\bin\\bash.exe",
          "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
        ]
      : ["/bin/bash"];
  const bash = bashCandidates.find(existsSync);
  if (bash) {
    shells.push({
      name: "bash",
      command: bash,
      args: (command) => ["-lc", command],
    });
  }
  if (process.platform === "win32") {
    shells.push(
      {
        name: "powershell",
        command: "powershell.exe",
        args: (command) => [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          command,
        ],
      },
      {
        name: "cmd",
        command: process.env.ComSpec ?? "cmd.exe",
        args: (command) => ["/d", "/v:off", "/s", "/c", command],
      },
    );
  }
  return shells;
}

describe("workflow publication command", () => {
  const originalArgv = [...process.argv];
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "omc-publication-command-"));
  });

  afterEach(() => {
    process.argv.splice(0, process.argv.length, ...originalArgv);
    rmSync(root, { recursive: true, force: true });
  });

  function fixtureEntrypoint(kind: EntrypointKind): string {
    const checkout = join(root, "checkout $() & %OMC_ATTACK% '");
    const entrypoint =
      kind === "bridge"
        ? join(checkout, "bridge", "cli.cjs")
        : join(checkout, "bin", "oh-my-claudecode.js");
    mkdirSync(join(entrypoint, ".."), { recursive: true });
    writeFileSync(
      entrypoint,
      "require('node:fs').writeFileSync(process.env.OMC_PUBLICATION_CAPTURE, JSON.stringify({execPath:process.execPath,entrypoint:process.argv[1],args:process.argv.slice(2)}));",
    );
    return realpathSync(entrypoint);
  }

  function hostileInputs() {
    const marker = join(root, "shell-injection-marker.txt");
    const nodeWrite = `node -e "require('node:fs').writeFileSync(${JSON.stringify(marker)},'injected')"`;
    const hostile = `$( ${nodeWrite} ) & %OMC_ATTACK% "double" 'single' $HOME`;
    return { marker, hostile, nodeWrite };
  }

  it.each(["bridge", "package-bin"] as const)(
    "uses canonical Node argv for the %s entrypoint",
    (kind) => {
      const entrypoint = fixtureEntrypoint(kind);
      const { hostile } = hostileInputs();
      process.argv.splice(
        0,
        process.argv.length,
        process.execPath,
        entrypoint,
        "team",
        "workflow",
        "run",
      );

      const publication = workflowPublicationContract(hostile, hostile);

      expect(publication.helperResult).toMatchObject({
        path: expect.stringMatching(
          /^\.omc-workflow-handoff-[a-f0-9]{16}\.json$/,
        ),
        authorization: "create-this-file-only",
        overwrite: false,
      });
      expect(publication.publishInvocation).toMatchObject({
        command: process.execPath,
        sourceArgumentIndex: 5,
      });
      expect(publication.publishCommandTransport).toBe(
        "base64url-node-exec-file",
      );
      expect(publication.publishCommandShells).toEqual([
        "bash",
        "powershell",
        "cmd",
      ]);
      expect(publication.publishInvocation.args).toEqual([
        entrypoint,
        "team",
        "workflow",
        "publish-result",
        "--source",
        publication.helperResult.path,
        "--result-file",
        hostile,
        "--task-id",
        hostile,
      ]);
      expect(publication.publishCommand).not.toContain(hostile);
    },
  );

  for (const kind of ["bridge", "package-bin"] as const) {
    for (const shell of availableShells()) {
      it(`preserves hostile argv through the ${kind} ${shell.name} fallback`, () => {
        const entrypoint = fixtureEntrypoint(kind);
        const capture = join(root, `capture-${kind}-${shell.name}.json`);
        const { marker, hostile, nodeWrite } = hostileInputs();
        process.argv.splice(
          0,
          process.argv.length,
          process.execPath,
          entrypoint,
        );
        const publication = workflowPublicationContract(hostile, hostile);
        const shellCommand = publication.publishCommand;
        expect(shellCommand).toBeTypeOf("string");

        let shellArgs = shell.args(shellCommand!);
        if (shell.name === "cmd") {
          const batch = join(root, "invoke-publication.cmd");
          writeFileSync(batch, `@echo off\r\n${shellCommand}\r\n`);
          shellArgs = ["/d", "/v:off", "/c", batch];
        }
        const executed = spawnSync(shell.command, shellArgs, {
          cwd: root,
          encoding: "utf8",
          env: {
            ...process.env,
            OMC_ATTACK: nodeWrite,
            OMC_PUBLICATION_CAPTURE: capture,
            OMC_WORKFLOW_HELPER_RESULT: `${hostile} " & ${nodeWrite}`,
          },
        });

        expect({
          status: executed.status,
          error: executed.error?.message,
          stdout: executed.stdout,
          stderr: executed.stderr,
        }).toEqual({ status: 0, error: undefined, stdout: "", stderr: "" });
        expect(existsSync(marker)).toBe(false);
        expect(JSON.parse(readFileSync(capture, "utf8"))).toEqual({
          execPath: process.execPath,
          entrypoint,
          args: publication.publishInvocation.args.slice(1),
        });
      });
    }
  }

  it("does not claim a safe shell fallback for an unknown launcher", () => {
    process.argv.splice(
      0,
      process.argv.length,
      process.execPath,
      join(root, "unknown-runner.js"),
    );

    const publication = workflowPublicationContract(
      "task-a",
      "/workflow/result.json",
    );

    expect(publication.publishInvocation).toMatchObject({
      command: "omc",
      args: [
        "team",
        "workflow",
        "publish-result",
        "--source",
        publication.helperResult.path,
        "--result-file",
        "/workflow/result.json",
        "--task-id",
        "task-a",
      ],
      sourceArgumentIndex: 4,
    });
    expect(publication.publishCommand).toBeNull();
    expect(publication.publishCommandTransport).toBeNull();
    expect(publication.publishCommandShells).toBeNull();
  });
});
