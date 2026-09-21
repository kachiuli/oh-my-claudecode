import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

interface LockPaths {
  readonly repositoryRoot: string;
  readonly repositoryKey: string;
  readonly operationLock: string;
}

interface Fixture {
  readonly root: string;
  readonly paths: LockPaths;
  readonly stateRoot: string;
}

interface ModuleOptions {
  readonly currentIdentity?: string | null;
  readonly ownerDead?: boolean;
}

const temporaryDirectories: string[] = [];

function fixture(): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "omc-operation-lock-")));
  const repositoryRoot = join(root, "repository");
  const operationLock = join(root, "state", "orchestrator", "operation.lock");
  mkdirSync(repositoryRoot, { recursive: true });
  mkdirSync(dirname(operationLock), { recursive: true });
  temporaryDirectories.push(root);
  return {
    root,
    paths: {
      repositoryRoot,
      repositoryKey: "a".repeat(64),
      operationLock,
    },
    stateRoot: realpathSync(dirname(operationLock)),
  };
}

async function loadOperationLock(options: ModuleOptions = {}) {
  const currentIdentity =
    options.currentIdentity === undefined
      ? "test:current-process"
      : options.currentIdentity;
  const ownerDead = options.ownerDead ?? true;
  vi.resetModules();
  vi.doMock("../../team/team-owner-epoch.js", () => ({
    currentProcessStartIdentity: vi.fn(() => currentIdentity),
    isProcessIdentityDead: vi.fn(() => ownerDead),
    isValidProcessStartIdentity: vi.fn(
      (value: unknown) =>
        typeof value === "string" && /^test:[a-z0-9-]+$/.test(value),
    ),
  }));
  return import("../operation-lock.js");
}

function operationRecord(
  testFixture: Fixture,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: "orchestrator-operation",
    pid: 999_999,
    processStartedAt: "test:dead-owner",
    nonce: randomUUID(),
    repositoryRoot: testFixture.paths.repositoryRoot,
    repositoryKey: testFixture.paths.repositoryKey,
    stateRoot: testFixture.stateRoot,
    acquiredAt: new Date().toISOString(),
    ...overrides,
  };
}

function writeOperationRecord(
  testFixture: Fixture,
  overrides: Record<string, unknown> = {},
): string {
  const bytes = JSON.stringify(operationRecord(testFixture, overrides));
  writeFileSync(testFixture.paths.operationLock, bytes, "utf8");
  return bytes;
}

function createDanglingJunction(path: string, root: string): void {
  const target = join(root, `removed-target-${randomUUID()}`);
  mkdirSync(target, { recursive: true });
  symlinkSync(target, path, "junction");
  rmSync(target, { recursive: true, force: true });
}

function deferred(): {
  readonly promise: Promise<void>;
  resolve(): void;
} {
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

afterEach(() => {
  vi.doUnmock("../../team/team-owner-epoch.js");
  vi.resetModules();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("orchestrator operation lock", () => {
  it("acquires exclusively and releases only its own ordinary lock", async () => {
    const testFixture = fixture();
    const module = await loadOperationLock();

    const first = module.tryAcquireOrchestratorOperationLock(testFixture.paths);
    expect(first).not.toBeNull();
    expect(
      module.tryAcquireOrchestratorOperationLock(testFixture.paths),
    ).toBeNull();
    expect(existsSync(testFixture.paths.operationLock)).toBe(true);

    module.releaseOrchestratorOperationLock(first!);

    expect(existsSync(testFixture.paths.operationLock)).toBe(false);
    const second = module.tryAcquireOrchestratorOperationLock(
      testFixture.paths,
      null,
    );
    expect(second?.record.processStartedAt).toBeNull();
    module.releaseOrchestratorOperationLock(second!);
    expect(existsSync(testFixture.paths.operationLock)).toBe(false);

    const superseded = module.tryAcquireOrchestratorOperationLock(
      testFixture.paths,
    );
    unlinkSync(testFixture.paths.operationLock);
    const replacement = JSON.stringify(operationRecord(testFixture));
    writeFileSync(testFixture.paths.operationLock, replacement, "utf8");
    expect(() => module.releaseOrchestratorOperationLock(superseded!)).toThrow(
      "orchestrator_operation_lock_ownership_lost",
    );
    expect(readFileSync(testFixture.paths.operationLock, "utf8")).toBe(
      replacement,
    );
  });

  it.each([
    ["dead structured", () => undefined],
    ["legacy", () => ({ pid: 999_999, timestamp: 1 })],
  ])("never implicitly reaps a %s record", async (_name, legacyRecord) => {
    const testFixture = fixture();
    const module = await loadOperationLock({ ownerDead: true });
    const value = legacyRecord();
    const bytes = value
      ? JSON.stringify(value)
      : JSON.stringify(operationRecord(testFixture));
    writeFileSync(testFixture.paths.operationLock, bytes, "utf8");

    expect(
      module.tryAcquireOrchestratorOperationLock(testFixture.paths),
    ).toBeNull();
    expect(readFileSync(testFixture.paths.operationLock, "utf8")).toBe(bytes);
  });

  it("explicitly recovers an exact dead-owner record", async () => {
    const testFixture = fixture();
    const module = await loadOperationLock({ ownerDead: true });
    writeOperationRecord(testFixture);
    const observed: string[] = [];

    const result = await module.withExplicitOrchestratorOperationRecovery(
      testFixture.paths,
      (record) => {
        observed.push(`preflight:${record?.nonce}`);
      },
      (record) => {
        observed.push(`action:${record?.nonce}`);
        return "recovered";
      },
    );

    expect(result).toEqual({
      value: "recovered",
      recoveredOperationLock: true,
    });
    expect(observed).toHaveLength(2);
    expect(observed[0]?.replace("preflight", "action")).toBe(observed[1]);
    expect(existsSync(testFixture.paths.operationLock)).toBe(false);
    expect(existsSync(`${testFixture.paths.operationLock}.recovery`)).toBe(
      false,
    );
  });

  it.each([
    ["unknown", null],
    ["live", "test:live-owner"],
  ])("refuses a %s owner and retains its evidence", async (_name, identity) => {
    const testFixture = fixture();
    const module = await loadOperationLock({ ownerDead: false });
    const bytes = writeOperationRecord(testFixture, {
      processStartedAt: identity,
    });
    const action = vi.fn();

    await expect(
      module.withExplicitOrchestratorOperationRecovery(
        testFixture.paths,
        () => undefined,
        action,
      ),
    ).rejects.toThrow("orchestrator_operation_owner_not_confirmed_dead");
    expect(action).not.toHaveBeenCalled();
    expect(readFileSync(testFixture.paths.operationLock, "utf8")).toBe(bytes);
  });

  it("refuses a dead record bound to a foreign repository", async () => {
    const testFixture = fixture();
    const module = await loadOperationLock({ ownerDead: true });
    const bytes = writeOperationRecord(testFixture, {
      repositoryRoot: join(testFixture.root, "other-repository"),
    });

    await expect(
      module.withExplicitOrchestratorOperationRecovery(
        testFixture.paths,
        () => undefined,
        () => undefined,
      ),
    ).rejects.toThrow("orchestrator_operation_lock_foreign");
    expect(readFileSync(testFixture.paths.operationLock, "utf8")).toBe(bytes);
  });

  it.each(["malformed", "oversized", "dangling-symlink"])(
    "refuses a %s operation record",
    async (kind) => {
      const testFixture = fixture();
      const module = await loadOperationLock({ ownerDead: true });
      if (kind === "malformed") {
        writeFileSync(testFixture.paths.operationLock, "{not-json", "utf8");
      } else if (kind === "oversized") {
        writeFileSync(
          testFixture.paths.operationLock,
          "x".repeat(20_000),
          "utf8",
        );
      } else {
        createDanglingJunction(
          testFixture.paths.operationLock,
          testFixture.root,
        );
      }
      const action = vi.fn();

      await expect(
        module.withExplicitOrchestratorOperationRecovery(
          testFixture.paths,
          () => undefined,
          action,
        ),
      ).rejects.toThrow("orchestrator_operation_lock_unverifiable");
      expect(action).not.toHaveBeenCalled();
      if (kind === "dangling-symlink") {
        expect(
          lstatSync(testFixture.paths.operationLock).isSymbolicLink(),
        ).toBe(true);
      } else {
        expect(readFileSync(testFixture.paths.operationLock, "utf8")).toBe(
          kind === "malformed" ? "{not-json" : "x".repeat(20_000),
        );
      }
    },
  );

  it.each(["malformed", "oversized", "dangling-symlink"])(
    "refuses a %s recovery claim",
    async (kind) => {
      const testFixture = fixture();
      const module = await loadOperationLock();
      const claim = `${testFixture.paths.operationLock}.recovery`;
      if (kind === "malformed") {
        writeFileSync(claim, "{not-json", "utf8");
      } else if (kind === "oversized") {
        writeFileSync(claim, "x".repeat(20_000), "utf8");
      } else {
        createDanglingJunction(claim, testFixture.root);
        expect(
          module.tryAcquireOrchestratorOperationLock(testFixture.paths),
        ).toBeNull();
      }
      const action = vi.fn();

      await expect(
        module.withExplicitOrchestratorOperationRecovery(
          testFixture.paths,
          () => undefined,
          action,
        ),
      ).rejects.toThrow("orchestrator_recovery_claim_unverifiable");
      expect(action).not.toHaveBeenCalled();
      if (kind === "dangling-symlink") {
        expect(lstatSync(claim).isSymbolicLink()).toBe(true);
      } else {
        expect(readFileSync(claim, "utf8")).toBe(
          kind === "malformed" ? "{not-json" : "x".repeat(20_000),
        );
      }
    },
  );

  it("allows ordinary locking without identity but refuses explicit recovery", async () => {
    const testFixture = fixture();
    const module = await loadOperationLock({
      currentIdentity: null,
      ownerDead: true,
    });
    const ordinary = module.tryAcquireOrchestratorOperationLock(
      testFixture.paths,
    );
    expect(ordinary?.record.processStartedAt).toBeNull();
    module.releaseOrchestratorOperationLock(ordinary!);
    const bytes = writeOperationRecord(testFixture);

    await expect(
      module.withExplicitOrchestratorOperationRecovery(
        testFixture.paths,
        () => undefined,
        () => undefined,
      ),
    ).rejects.toThrow("orchestrator_recovery_identity_unavailable");
    expect(readFileSync(testFixture.paths.operationLock, "utf8")).toBe(bytes);
  });

  it("serializes recovery and blocks ordinary acquisition behind the claim", async () => {
    const testFixture = fixture();
    const module = await loadOperationLock({ ownerDead: true });
    writeOperationRecord(testFixture);
    const preflightStarted = deferred();
    const releasePreflight = deferred();
    const action = vi.fn();
    const first = module.withExplicitOrchestratorOperationRecovery(
      testFixture.paths,
      () => {
        preflightStarted.resolve();
        return releasePreflight.promise;
      },
      action,
    );
    await preflightStarted.promise;

    expect(
      module.tryAcquireOrchestratorOperationLock(testFixture.paths),
    ).toBeNull();
    await expect(
      module.withExplicitOrchestratorOperationRecovery(
        testFixture.paths,
        () => undefined,
        () => undefined,
      ),
    ).rejects.toThrow("orchestrator_recovery_claim_locked");

    releasePreflight.resolve();
    await expect(first).resolves.toMatchObject({
      recoveredOperationLock: true,
    });
    expect(action).toHaveBeenCalledOnce();
  });

  it("preserves evidence and clears the recovery claim when preflight fails", async () => {
    const testFixture = fixture();
    const module = await loadOperationLock({ ownerDead: true });
    const original = writeOperationRecord(testFixture);
    const action = vi.fn();

    await expect(
      module.withExplicitOrchestratorOperationRecovery(
        testFixture.paths,
        () => {
          throw new Error("preflight-failed");
        },
        action,
      ),
    ).rejects.toThrow("preflight-failed");
    expect(action).not.toHaveBeenCalled();
    expect(readFileSync(testFixture.paths.operationLock, "utf8")).toBe(
      original,
    );
    expect(existsSync(`${testFixture.paths.operationLock}.recovery`)).toBe(
      false,
    );
  });

  it("rejects preflight replacement before mutation and preserves the replacement", async () => {
    const testFixture = fixture();
    const module = await loadOperationLock({ ownerDead: true });
    writeOperationRecord(testFixture);
    const replacement = JSON.stringify(
      operationRecord(testFixture, { nonce: randomUUID() }),
    );
    const action = vi.fn();

    await expect(
      module.withExplicitOrchestratorOperationRecovery(
        testFixture.paths,
        () => {
          unlinkSync(testFixture.paths.operationLock);
          writeFileSync(testFixture.paths.operationLock, replacement, "utf8");
        },
        action,
      ),
    ).rejects.toThrow("orchestrator_operation_lock_changed");
    expect(action).not.toHaveBeenCalled();
    expect(readFileSync(testFixture.paths.operationLock, "utf8")).toBe(
      replacement,
    );
    expect(existsSync(`${testFixture.paths.operationLock}.recovery`)).toBe(
      false,
    );
  });

  it("restores exact operation evidence when the recovery mutation fails", async () => {
    const testFixture = fixture();
    const module = await loadOperationLock({ ownerDead: true });
    const original = writeOperationRecord(testFixture);

    await expect(
      module.withExplicitOrchestratorOperationRecovery(
        testFixture.paths,
        () => undefined,
        () => {
          throw new Error("mutation-failed");
        },
      ),
    ).rejects.toThrow("mutation-failed");
    expect(readFileSync(testFixture.paths.operationLock, "utf8")).toBe(
      original,
    );
    expect(existsSync(`${testFixture.paths.operationLock}.recovery`)).toBe(
      false,
    );
  });

  it("leaves the claim and both evidence generations when rollback is unsafe", async () => {
    const testFixture = fixture();
    const module = await loadOperationLock({ ownerDead: true });
    const original = writeOperationRecord(testFixture);
    const replacement = JSON.stringify(
      operationRecord(testFixture, { nonce: randomUUID() }),
    );

    await expect(
      module.withExplicitOrchestratorOperationRecovery(
        testFixture.paths,
        () => undefined,
        () => {
          writeFileSync(testFixture.paths.operationLock, replacement, "utf8");
          throw new Error("mutation-failed");
        },
      ),
    ).rejects.toThrow("orchestrator_operation_lock_rollback_failed");
    expect(readFileSync(testFixture.paths.operationLock, "utf8")).toBe(
      replacement,
    );
    expect(existsSync(`${testFixture.paths.operationLock}.recovery`)).toBe(
      true,
    );
    const recoveredEvidence = `${testFixture.paths.operationLock}.${JSON.parse(original).nonce}.recovered`;
    expect(readFileSync(recoveredEvidence, "utf8")).toBe(original);
  });
});
