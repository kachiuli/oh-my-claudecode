import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { acquireOrchestratorLease, assertActiveOrchestratorAvailable, assertOrchestratorSession, beginOrchestratorLeaseProcessRegistration, orchestratorLeaseEnvironment, probeOrchestratorCli, readOrchestratorRepositoryConfig, releaseOrchestratorLease, resolveOrchestratorPaths, registerOrchestratorLeaseProcess, } from "../orchestration/selection.js";
import { buildHostLaunchArgs } from "../hosts/adapters.js";
import { extractOmcLaunchOptions } from "./launch.js";
/** Matches the controller's maximum `--timeout-ms` so one native Bash call can outlive any provider attempt. */
export const CLAUDE_LEAD_BASH_TIMEOUT_MS = 3_600_000;
/** Exclude credentials and session context belonging to a different native host. */
export function projectHostEnvironment(host, environment) {
    const result = { ...environment };
    for (const key of Object.keys(result)) {
        const foreign = host === "codex"
            ? /^(?:ANTHROPIC_|CLAUDE_|CLAUDECODE$)/i
            : /^(?:OPENAI_|CODEX_)/i;
        if (foreign.test(key) ||
            /^(?:OMX_|OMC_GLM_|GLM_|ZAI_|Z_AI_)/i.test(key) ||
            /^(?:CODEX_THREAD_ID|CLAUDE_CODE_SESSION_ID)$/i.test(key))
            delete result[key];
    }
    if (host === "claude" &&
        result.ANTHROPIC_BASE_URL &&
        result.ANTHROPIC_BASE_URL.replace(/\/$/, "") !== "https://api.anthropic.com") {
        throw new Error("orchestrator_foreign_claude_endpoint: launch Claude with its own Anthropic configuration; bind GLM as a worker separately.");
    }
    if (host === "claude") {
        // The native Bash tool stops commands after two minutes by default, which kills a supervised
        // workflow run mid-attempt. Align the default with the controller's maximum provider timeout;
        // an explicit user setting always wins.
        for (const key of ["BASH_DEFAULT_TIMEOUT_MS", "BASH_MAX_TIMEOUT_MS"]) {
            if (!result[key])
                result[key] = String(CLAUDE_LEAD_BASH_TIMEOUT_MS);
        }
    }
    return result;
}
function launchArguments(host, args) {
    const remaining = [];
    let resumeId;
    for (let index = 0; index < args.length; index++) {
        const argument = args[index];
        if (/^--(?:remote|remote-workspace|cloud|environment|teleport|from-pr)(?:=|$)/.test(argument) ||
            ["attach", "respawn", "remote-control", "cloud", "app-server"].includes(argument) ||
            (host === "codex" &&
                ["app", "queue", "agents", "exec-server"].includes(argument)) ||
            (host === "claude" && ["agents", "ultrareview"].includes(argument))) {
            throw new Error("orchestrator_unmanaged_session_transport: launch a local fresh session or use --resume with a registered native session ID.");
        }
        if (host === "claude" &&
            (/^--(?:safe-mode|bare|allow-dangerously-skip-permissions|bg|background)(?:=|$)/.test(argument) ||
                argument === "--permission-mode=bypassPermissions" ||
                (argument === "--permission-mode" &&
                    args[index + 1] === "bypassPermissions"))) {
            throw new Error("orchestrator_incompatible_native_mode: keep project integration and native permission checks enabled.");
        }
        if (/^--(?:madmax|yolo|dangerously-skip-permissions)(?:=|$)/.test(argument)) {
            throw new Error("orchestrator_unsafe_permission_alias: project launches retain native permission checks; remove the bypass flag.");
        }
        if (argument === "--resume") {
            const next = args[++index];
            if (resumeId || !next || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(next))
                throw new Error("orchestrator_invalid_resume_session");
            resumeId = next;
        }
        else {
            if (/^(?:resume|fork|--resume=.*|--continue(?:=.*)?|--last|--session-id(?:=.*)?)$/.test(argument) ||
                (host === "claude" && /^-[rc]/.test(argument))) {
                throw new Error("Use omc launch --resume <registered-native-session-id>; sessions from another host or selection are refused.");
            }
            if (/^(?:--cd(?:=.*)?|--worktree(?:=.*)?)$/.test(argument) ||
                /^-(?:C|w)/.test(argument)) {
                throw new Error("Launch from the intended repository; the shared OMC controller owns workflow worktrees.");
            }
            remaining.push(argument);
        }
    }
    return { args: remaining, ...(resumeId ? { resumeId } : {}) };
}
async function runNativeHost(command, args, options) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd: options.cwd,
            env: options.env,
            stdio: "inherit",
            shell: false,
            windowsHide: true,
        });
        let registrationError;
        const registration = child.pid
            ? options.registerProcess(child.pid).catch((error) => {
                registrationError = error;
                child.kill();
            })
            : Promise.resolve();
        const interrupt = () => {
            child.kill("SIGINT");
        };
        const terminate = () => {
            child.kill("SIGTERM");
        };
        process.on("SIGINT", interrupt);
        process.on("SIGTERM", terminate);
        const cleanup = () => {
            process.off("SIGINT", interrupt);
            process.off("SIGTERM", terminate);
        };
        child.once("error", () => {
            cleanup();
            reject(new Error("orchestrator_launch_failed: verify the selected native CLI executable."));
        });
        child.once("close", (code, signal) => {
            cleanup();
            void registration.then(() => registrationError
                ? reject(registrationError)
                : resolve(code ?? (signal === "SIGINT" ? 130 : 1)), reject);
        });
    });
}
/** Returns false only for repositories that have not adopted project host setup. */
export async function launchProjectOrchestrator(args, options = {}) {
    const cwd = options.cwd ?? process.cwd();
    if (!readOrchestratorRepositoryConfig(cwd))
        return false;
    if (process.env.OMC_TEAM_WORKER ||
        process.env.OMC_TEAM_WORKER_NAME ||
        process.env.OMC_TEAM_WORKTREE_PATH) {
        throw new Error("workflow_lead_authority_required");
    }
    const { repositoryRoot } = resolveOrchestratorPaths(cwd);
    const active = assertActiveOrchestratorAvailable(repositoryRoot, options);
    const cli = probeOrchestratorCli(active.host, options);
    if (!cli.path ||
        (process.platform === "win32" && /\.(?:cmd|bat|ps1)$/i.test(cli.path))) {
        throw new Error(`orchestrator_native_executable_required: install a directly executable ${active.host} CLI.`);
    }
    const wrapper = extractOmcLaunchOptions(args);
    const requested = launchArguments(active.host, wrapper.args);
    const environment = projectHostEnvironment(active.host, {
        ...process.env,
        ...wrapper.environment,
    });
    const lease = await acquireOrchestratorLease(repositoryRoot, {
        host: active.host,
        sessionId: randomUUID(),
    });
    try {
        if (requested.resumeId)
            assertOrchestratorSession(repositoryRoot, active.host, requested.resumeId);
        const hostArgs = buildHostLaunchArgs(active.host, repositoryRoot, requested.args, requested.resumeId);
        await beginOrchestratorLeaseProcessRegistration(repositoryRoot, lease);
        const code = await (options.run ?? runNativeHost)(cli.path, hostArgs, {
            cwd: repositoryRoot,
            env: { ...environment, ...orchestratorLeaseEnvironment(lease) },
            registerProcess: (pid) => registerOrchestratorLeaseProcess(repositoryRoot, lease, pid),
        });
        if (code !== 0)
            process.exitCode = code;
    }
    finally {
        await releaseOrchestratorLease(repositoryRoot, lease, {
            kind: "checkpointed",
            reference: "native-host-process-exited",
        }).catch((error) => {
            // An explicit handoff revokes the old lease while the former host exits.
            if (!(error instanceof Error) ||
                error.message !== "orchestrator_lease_stale_or_revoked")
                throw error;
        });
    }
    return true;
}
//# sourceMappingURL=project-launch.js.map