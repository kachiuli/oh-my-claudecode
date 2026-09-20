import { resolveProjectOmcPath } from "../lib/worktree-paths.js";
import {
  resolveOrchestratorPaths,
  type OrchestratorHost,
} from "../orchestration/selection.js";

function checkedResumeId(resumeId: string | undefined): string | undefined {
  if (resumeId === undefined) return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/.test(resumeId)) {
    throw new Error("orchestrator_invalid_session");
  }
  return resumeId;
}

function withoutCodexWorkspaceOverrides(args: readonly string[]): {
  args: string[];
  sandbox: "read-only" | "workspace-write";
} {
  const result: string[] = [];
  let sandbox: "read-only" | "workspace-write" = "workspace-write";
  let readOnlyRequested = false;
  let workspaceWriteConvenience = false;
  const applySandbox = (requested: string | undefined): void => {
    if (requested !== "read-only" && requested !== "workspace-write") {
      throw new Error("orchestrator_unsafe_sandbox_override");
    }
    if (requested === "read-only") {
      sandbox = "read-only";
      readOnlyRequested = true;
    }
  };
  const isSandboxConfigOverride = (value: string): boolean => {
    const key = value
      .replace(/^=/, "")
      .split("=", 1)[0]
      ?.replace(/[\s"']/g, "");
    return (
      key === "sandbox_workspace_write" ||
      /(?:^|\.)(?:sandbox_mode|sandbox_permissions|sandbox_workspace_write(?:\.writable_roots)?)$/.test(
        key ?? "",
      )
    );
  };
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--sandbox" || value === "-s") {
      const requested = args[index + 1];
      applySandbox(requested);
      index += 1;
      continue;
    }
    if (value.startsWith("--sandbox=") || value.startsWith("-s=")) {
      applySandbox(value.slice(value.indexOf("=") + 1));
      continue;
    }
    if (value.startsWith("-s") && !value.startsWith("--")) {
      applySandbox(value.slice(2));
      continue;
    }
    if (
      value === "--dangerously-bypass-approvals-and-sandbox" ||
      value.startsWith("--dangerously-bypass-approvals-and-sandbox=") ||
      value === "--yolo" ||
      value.startsWith("--yolo=")
    ) {
      throw new Error("orchestrator_unsafe_sandbox_bypass");
    }
    if (value === "--add-dir" || value.startsWith("--add-dir=")) {
      throw new Error("orchestrator_workspace_expansion_refused");
    }
    if (value === "--worktree" || value.startsWith("--worktree=")) {
      throw new Error("orchestrator_workspace_expansion_refused");
    }
    if (
      value === "--remote" ||
      value.startsWith("--remote=") ||
      value === "--remote-auth-token-env" ||
      value.startsWith("--remote-auth-token-env=")
    ) {
      throw new Error("orchestrator_remote_host_refused");
    }
    if (value === "-c" || value === "--config") {
      const override = args[index + 1];
      if (override === undefined)
        throw new Error("orchestrator_invalid_config");
      if (isSandboxConfigOverride(override)) {
        throw new Error("orchestrator_sandbox_config_override_refused");
      }
      result.push(value, override);
      index += 1;
      continue;
    }
    if (
      value.startsWith("--config=") ||
      (value.startsWith("-c") && value.length > 2)
    ) {
      const override = value.startsWith("--config=")
        ? value.slice("--config=".length)
        : value.slice(2);
      if (isSandboxConfigOverride(override)) {
        throw new Error("orchestrator_sandbox_config_override_refused");
      }
      result.push(value);
      continue;
    }
    if (value === "--full-auto" || value === "--approve-for-me") {
      workspaceWriteConvenience = true;
    }
    if (value === "--cd" || value === "-C") {
      if (args[index + 1] === undefined) {
        throw new Error("orchestrator_invalid_working_directory");
      }
      index += 1;
      continue;
    }
    if (value.startsWith("--cd=")) {
      continue;
    }
    result.push(value);
  }
  if (workspaceWriteConvenience && readOnlyRequested) {
    throw new Error("orchestrator_conflicting_sandbox_options");
  }
  return { args: result, sandbox };
}

/** Build project-scoped native CLI arguments without changing provider/model settings. */
export function buildHostLaunchArgs(
  host: OrchestratorHost,
  cwd: string,
  args: readonly string[],
  resumeId?: string,
): string[] {
  const repositoryRoot = resolveOrchestratorPaths(cwd).repositoryRoot;
  const checkedId = checkedResumeId(resumeId);

  if (host === "claude") {
    return [
      "--plugin-dir",
      resolveProjectOmcPath("hosts/claude/plugin", repositoryRoot),
      ...(checkedId ? ["--resume", checkedId] : []),
      ...args,
    ];
  }

  if (host === "codex") {
    const normalized = withoutCodexWorkspaceOverrides(args);
    return [
      ...(checkedId ? ["resume", checkedId] : []),
      "--sandbox",
      normalized.sandbox,
      "--cd",
      repositoryRoot,
      ...normalized.args,
    ];
  }

  throw new Error("orchestrator_invalid_host");
}
