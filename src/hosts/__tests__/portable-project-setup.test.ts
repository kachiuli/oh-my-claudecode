import {
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assetIssue,
  mergeManagedBlock,
  mergePortableManagedBlock,
  removeManagedBlock,
  parseReceipt,
  RECEIPT_PATH,
  sha256,
} from "../asset-ownership.js";
import { setupProjectHosts, uninstallProjectHost } from "../project-setup.js";

const PACKAGE_ROOT = resolve(".");
const GUIDANCE_START = "<!-- OMC:PROJECT-HOST:START -->";
const GUIDANCE_END = "<!-- OMC:PROJECT-HOST:END -->";
const GUIDANCE_BLOCK = [
  GUIDANCE_START,
  readFileSync(
    join(PACKAGE_ROOT, "templates", "hosts", "orchestrator-guidance.md"),
    "utf8",
  ).trim(),
  GUIDANCE_END,
].join("\n");
const IGNORE_START = "# BEGIN OMC PROJECT HOST STATE";
const IGNORE_END = "# END OMC PROJECT HOST STATE";
const IGNORE_BLOCK = [
  IGNORE_START,
  "/.omc/state/",
  "/.omc/hosts/",
  IGNORE_END,
].join("\n");
const temporaryDirectories: string[] = [];

function temporaryRepository(): string {
  const root = mkdtempSync(join(tmpdir(), "omc-portable-host-assets-"));
  temporaryDirectories.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root, windowsHide: true });
  return root;
}

function write(root: string, path: string, content: string): void {
  const absolute = join(root, path);
  mkdirSync(resolve(absolute, ".."), { recursive: true });
  writeFileSync(absolute, content, "utf8");
}

function writePortableFragments(root: string): Record<string, string> {
  const fragments = {
    "AGENTS.md": `# User guidance  \r\n\r\n${GUIDANCE_BLOCK}\n\nKeep this suffix\t\r\n\r\n`,
    "CLAUDE.md": `${GUIDANCE_BLOCK}\n`,
    ".gitignore": `user-cache/  \r\n\r\n${IGNORE_BLOCK}\n\n!user-cache/keep\t\r\n\r\n`,
  };
  for (const [path, content] of Object.entries(fragments)) {
    write(root, path, content);
  }
  return fragments;
}

function expectFragmentsUnchanged(
  root: string,
  fragments: Record<string, string>,
): void {
  for (const [path, content] of Object.entries(fragments)) {
    expect(readFileSync(join(root, path))).toEqual(Buffer.from(content));
  }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("portable project host fragments", () => {
  it("requires explicit adoption and accepts an exact block at EOF", () => {
    const original = `# User guidance\r\n${GUIDANCE_BLOCK}`;
    expect(() =>
      mergeManagedBlock(
        original,
        undefined,
        GUIDANCE_BLOCK,
        GUIDANCE_START,
        GUIDANCE_END,
      ),
    ).toThrow("host_assets_unowned_managed_block");
    expect(
      mergeManagedBlock(
        original,
        undefined,
        GUIDANCE_BLOCK,
        GUIDANCE_START,
        GUIDANCE_END,
        { adoptExactBlock: true },
      ),
    ).toBe(original);
  });

  it.each([
    ["claude", "LF"],
    ["claude", "CRLF"],
    ["codex", "LF"],
    ["codex", "CRLF"],
  ] as const)(
    "plans %s adoption with %s without writing or changing source bytes",
    async (host, lineEnding) => {
      const root = temporaryRepository();
      const fragments = writePortableFragments(root);
      for (const path of Object.keys(fragments)) {
        fragments[path] = fragments[path]
          .replaceAll("\r\n", "\n")
          .replaceAll("\n", lineEnding === "CRLF" ? "\r\n" : "\n");
        write(root, path, fragments[path]);
      }

      const result = await setupProjectHosts(root, [host], {
        packageRoot: PACKAGE_ROOT,
        dryRun: true,
      });

      expect(result.dryRun).toBe(true);
      expect(result.unchangedFiles).toContain(".gitignore");
      expect(result.unchangedFiles).toContain(
        host === "codex" ? "AGENTS.md" : "CLAUDE.md",
      );
      expect(result.changedFiles).toContain(RECEIPT_PATH);
      expectFragmentsUnchanged(root, fragments);
      expect(existsSync(join(root, ".omc"))).toBe(false);
      expect(existsSync(join(root, ".codex"))).toBe(false);
      expect(existsSync(join(root, ".agents"))).toBe(false);
    },
  );

  it.each([false, true])(
    "bootstraps a clone with autocrlf=%s and supports update and uninstall",
    async (autocrlf) => {
      const source = temporaryRepository();
      const sourceFragments = writePortableFragments(source);
      for (const [path, content] of Object.entries(sourceFragments)) {
        write(source, path, content.replaceAll("\r\n", "\n"));
      }
      execFileSync("git", ["config", "core.autocrlf", "false"], {
        cwd: source,
      });
      await setupProjectHosts(source, ["claude", "codex"], {
        packageRoot: PACKAGE_ROOT,
      });
      execFileSync(
        "git",
        [
          "add",
          "AGENTS.md",
          "CLAUDE.md",
          ".gitignore",
          ".omc/orchestrator.json",
        ],
        { cwd: source },
      );
      execFileSync(
        "git",
        [
          "-c",
          "user.name=OMC Test",
          "-c",
          "user.email=omc@example.invalid",
          "commit",
          "-qm",
          "Portable project host guidance",
        ],
        { cwd: source },
      );
      const root = join(source, "clone");
      execFileSync("git", [
        "-c",
        `core.autocrlf=${autocrlf}`,
        "clone",
        "-q",
        "--no-local",
        source,
        root,
      ]);
      const fragments = Object.fromEntries(
        Object.keys(sourceFragments).map((path) => [
          path,
          readFileSync(join(root, path), "utf8"),
        ]),
      );
      const clonedGuidance = GUIDANCE_BLOCK.replaceAll("\r\n", "\n").replaceAll(
        "\n",
        autocrlf ? "\r\n" : "\n",
      );
      const clonedIgnore = IGNORE_BLOCK.replaceAll(
        "\n",
        autocrlf ? "\r\n" : "\n",
      );
      expect(fragments["CLAUDE.md"]).toBe(
        `${clonedGuidance}${autocrlf ? "\r\n" : "\n"}`,
      );
      expect(existsSync(join(root, RECEIPT_PATH))).toBe(false);

      const result = await setupProjectHosts(root, ["claude", "codex"], {
        packageRoot: PACKAGE_ROOT,
      });

      expect(result.unchangedFiles).toEqual(
        expect.arrayContaining(Object.keys(fragments)),
      );
      expect(result.changedFiles).toContain(RECEIPT_PATH);
      expectFragmentsUnchanged(root, fragments);
      const receipt = parseReceipt(root);
      for (const [host, path] of [
        ["claude", "CLAUDE.md"],
        ["codex", "AGENTS.md"],
      ] as const) {
        expect(
          receipt.hosts[host]?.assets.find((asset) => asset.path === path),
        ).toEqual({
          path,
          kind: "block",
          digest: sha256(clonedGuidance),
          managedText: clonedGuidance,
        });
      }
      for (const asset of [
        ...(receipt.shared ?? []),
        ...Object.values(receipt.hosts).flatMap((host) => host.assets),
      ]) {
        expect(assetIssue(root, asset)).toBeNull();
      }
      expect(receipt.shared).toEqual([
        {
          path: ".gitignore",
          kind: "block",
          digest: sha256(clonedIgnore),
          managedText: clonedIgnore,
        },
      ]);
      expect(
        (
          await setupProjectHosts(root, ["claude", "codex"], {
            packageRoot: PACKAGE_ROOT,
          })
        ).changedFiles,
      ).toEqual([]);
      expectFragmentsUnchanged(root, fragments);

      const updatedPackage = join(source, "updated-package");
      const updatedBlock = GUIDANCE_BLOCK.replace(
        GUIDANCE_END,
        `Additional package guidance.\n${GUIDANCE_END}`,
      );
      write(
        updatedPackage,
        "templates/hosts/orchestrator-guidance.md",
        updatedBlock.slice(
          GUIDANCE_START.length + 1,
          -(GUIDANCE_END.length + 1),
        ),
      );
      write(
        updatedPackage,
        "bridge/mcp-server.cjs",
        readFileSync(join(PACKAGE_ROOT, "bridge", "mcp-server.cjs"), "utf8"),
      );
      write(
        updatedPackage,
        "package.json",
        readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"),
      );
      cpSync(join(PACKAGE_ROOT, "agents"), join(updatedPackage, "agents"), {
        recursive: true,
      });

      const updated = await setupProjectHosts(root, ["claude", "codex"], {
        packageRoot: updatedPackage,
      });
      expect(updated.changedFiles).toEqual(
        expect.arrayContaining(["AGENTS.md", "CLAUDE.md", RECEIPT_PATH]),
      );
      expectFragmentsUnchanged(
        root,
        Object.fromEntries(
          Object.entries(fragments).map(([path, content]) => [
            path,
            content.replace(clonedGuidance, updatedBlock),
          ]),
        ),
      );
      expect(parseReceipt(root).hosts.codex?.installedAt).toBe(
        receipt.hosts.codex?.installedAt,
      );
      expect(
        (
          await setupProjectHosts(root, ["claude", "codex"], {
            packageRoot: updatedPackage,
          })
        ).changedFiles,
      ).toEqual([]);

      const removed = await uninstallProjectHost(root, "codex");
      expect(removed.remainingHosts).toEqual(["claude"]);
      expect(removed.preservedFiles).toEqual([]);
      const instructions = readFileSync(join(root, "AGENTS.md"), "utf8");
      expect(instructions).not.toContain(GUIDANCE_START);
      expect(instructions).toContain(
        `# User guidance  ${autocrlf ? "\r\n" : "\n"}`,
      );
      expect(instructions).toContain("Keep this suffix");
      expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe(
        fragments[".gitignore"],
      );
      expect(parseReceipt(root).hosts.codex).toBeUndefined();
      expect(existsSync(join(root, ".codex", "agents", "executor.toml"))).toBe(
        false,
      );
    },
  );

  it("keeps existing ownership on the replaced block despite unrelated marker text", () => {
    const previous = {
      path: "AGENTS.md",
      kind: "block" as const,
      digest: sha256(GUIDANCE_BLOCK),
      managedText: GUIDANCE_BLOCK,
    };
    const prefix = `User discusses ${GUIDANCE_START} and ${GUIDANCE_END} here.\n`;
    const updated = GUIDANCE_BLOCK.replace(
      GUIDANCE_END,
      `New guidance.\n${GUIDANCE_END}`,
    );
    expect(
      mergePortableManagedBlock(
        `${prefix}${GUIDANCE_BLOCK}`,
        previous,
        updated,
        GUIDANCE_START,
        GUIDANCE_END,
      ),
    ).toEqual({
      content: `${prefix}${updated}`,
      managedText: updated,
    });
  });

  it("uninstalls adopted CRLF blocks using their original receipt bytes", async () => {
    const root = temporaryRepository();
    const fragments = writePortableFragments(root);
    for (const [path, content] of Object.entries(fragments)) {
      write(
        root,
        path,
        content.replaceAll("\r\n", "\n").replaceAll("\n", "\r\n"),
      );
    }
    await setupProjectHosts(root, ["claude", "codex"], {
      packageRoot: PACKAGE_ROOT,
    });
    expect((await uninstallProjectHost(root, "codex")).preservedFiles).toEqual(
      [],
    );

    const instructions = readFileSync(join(root, "AGENTS.md"), "utf8");
    expect(instructions).not.toContain(GUIDANCE_START);
    expect(instructions).toContain("# User guidance  \r\n");
    expect(instructions).toContain("Keep this suffix");
    const ignore = removeManagedBlock(
      readFileSync(join(root, ".gitignore"), "utf8"),
      parseReceipt(root).shared![0],
    );
    expect(ignore).not.toContain(IGNORE_START);
    expect(ignore).toContain("user-cache/  \r\n");
    expect(ignore).toContain("!user-cache/keep");
  });

  for (const dryRun of [true, false]) {
    describe(dryRun ? "dry run refusal" : "setup refusal", () => {
      for (const [path, block, start, end] of [
        ["AGENTS.md", GUIDANCE_BLOCK, GUIDANCE_START, GUIDANCE_END],
        ["CLAUDE.md", GUIDANCE_BLOCK, GUIDANCE_START, GUIDANCE_END],
        [".gitignore", IGNORE_BLOCK, IGNORE_START, IGNORE_END],
      ]) {
        it.each([
          ["modified body", block.replace("\n", "\nuser edit\n")],
          ["unknown body", `${start}\nunknown\n${end}`],
          ["duplicate block", `${block}\n${block}`],
          ["extra start", `${start}\n${block}`],
          ["extra end", `${block}\n${end}`],
          ["missing end", block.replace(end, "")],
          ["missing start", block.replace(start, "")],
          ["reversed markers", `${end}\n${start}`],
          ["embedded start", `prefix${block}`],
          ["embedded end", `${block}suffix`],
          ["indented marker", ` ${block}`],
          [
            "bare CR block",
            block.replaceAll("\r\n", "\n").replaceAll("\n", "\r"),
          ],
          [
            "CRLF edited body",
            block
              .replaceAll("\r\n", "\n")
              .replaceAll("\n", "\r\n")
              .replace("\r\n", "\r\nuser edit\r\n"),
          ],
        ])(`rejects ${path} with %s`, async (_name, invalid) => {
          const root = temporaryRepository();
          const fragments = {
            ...writePortableFragments(root),
            [path]: invalid,
          };
          write(root, path, invalid);

          await expect(
            setupProjectHosts(root, ["claude", "codex"], {
              packageRoot: PACKAGE_ROOT,
              dryRun,
            }),
          ).rejects.toThrow("host_assets_unowned_managed_block");

          expectFragmentsUnchanged(root, fragments);
          expect(existsSync(join(root, RECEIPT_PATH))).toBe(false);
          expect(existsSync(join(root, ".omc", "orchestrator.json"))).toBe(
            false,
          );
          expect(existsSync(join(root, ".codex"))).toBe(false);
        });
      }
    });
  }

  it.each(["{not-json", '{"schemaVersion":1,"hosts":[]}'])(
    "does not replace malformed ownership receipts: %s",
    async (content) => {
      const root = temporaryRepository();
      const fragments = writePortableFragments(root);
      write(root, RECEIPT_PATH, content);
      for (const dryRun of [true, false]) {
        await expect(
          setupProjectHosts(root, ["claude", "codex"], {
            packageRoot: PACKAGE_ROOT,
            dryRun,
          }),
        ).rejects.toThrow("host_assets_invalid_receipt");
        expectFragmentsUnchanged(root, fragments);
        expect(readFileSync(join(root, RECEIPT_PATH), "utf8")).toBe(content);
        expect(existsSync(join(root, ".omc", "orchestrator.json"))).toBe(false);
      }
    },
  );

  it("does not adopt generated files even when their contents match", async () => {
    const source = temporaryRepository();
    await setupProjectHosts(source, ["codex"], { packageRoot: PACKAGE_ROOT });
    const root = temporaryRepository();
    const fragments = writePortableFragments(root);
    const path = ".agents/skills/omc-orchestration/SKILL.md";
    const content = readFileSync(join(source, path), "utf8");
    write(root, path, content);

    for (const dryRun of [true, false]) {
      await expect(
        setupProjectHosts(root, ["claude", "codex"], {
          packageRoot: PACKAGE_ROOT,
          dryRun,
        }),
      ).rejects.toThrow(`host_assets_collision: ${path}`);
      expectFragmentsUnchanged(root, fragments);
      expect(readFileSync(join(root, path), "utf8")).toBe(content);
      expect(existsSync(join(root, RECEIPT_PATH))).toBe(false);
      expect(existsSync(join(root, ".omc", "orchestrator.json"))).toBe(false);
      expect(existsSync(join(root, ".omc", "hosts", "claude"))).toBe(false);
    }
  });

  it.each(["symlink", "hardlink"])(
    "refuses a %s portable target",
    async (kind) => {
      const root = temporaryRepository();
      const fragments = writePortableFragments(root);
      const outside = temporaryRepository();
      write(outside, "AGENTS.md", fragments["AGENTS.md"]);
      rmSync(join(root, "AGENTS.md"));
      const link = kind === "symlink" ? symlinkSync : linkSync;
      link(join(outside, "AGENTS.md"), join(root, "AGENTS.md"));

      for (const dryRun of [true, false]) {
        await expect(
          setupProjectHosts(root, ["codex"], {
            packageRoot: PACKAGE_ROOT,
            dryRun,
          }),
        ).rejects.toThrow(
          kind === "symlink"
            ? "host_assets_symlink_refused"
            : "host_assets_unsafe_target",
        );
        expectFragmentsUnchanged(root, fragments);
        expect(readFileSync(join(outside, "AGENTS.md"), "utf8")).toBe(
          fragments["AGENTS.md"],
        );
        expect(existsSync(join(root, RECEIPT_PATH))).toBe(false);
      }
    },
  );

  it("refuses modified blocks after adoption and preserves them on uninstall", async () => {
    const root = temporaryRepository();
    writePortableFragments(root);
    await setupProjectHosts(root, ["claude", "codex"], {
      packageRoot: PACKAGE_ROOT,
    });
    const receipt = readFileSync(join(root, RECEIPT_PATH));
    const modified = `${GUIDANCE_START}\nuser replacement\n${GUIDANCE_END}\n`;
    write(root, "AGENTS.md", modified);

    await expect(
      setupProjectHosts(root, ["codex"], { packageRoot: PACKAGE_ROOT }),
    ).rejects.toThrow("host_assets_managed_content_modified: AGENTS.md");
    expect(readFileSync(join(root, RECEIPT_PATH))).toEqual(receipt);
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toBe(modified);
    expect(
      (await uninstallProjectHost(root, "codex")).preservedFiles,
    ).toContain("AGENTS.md");
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toBe(modified);
  });
});
