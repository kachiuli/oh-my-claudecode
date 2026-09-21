import { spawnSync } from "node:child_process";
import { readdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { readOrchestratorRepositoryConfig, readActiveOrchestrator, resolveOrchestratorPaths, updateOrchestratorRepositoryConfig, } from "../orchestration/selection.js";
import { probeCli } from "../team/cli-detection.js";
import { hasTomlTableInsertionConflict } from "./codex-config.js";
import { readNativeHookDiagnostics, } from "./hook-observation.js";
import { PROJECT_IGNORE_PATH, projectIgnoreAsset, projectIgnoreIssues, } from "./project-ignore.js";
import { RECEIPT_PATH, applyMutations, assetIssue, assertRelativePath, mergeManagedBlock, mergedCodexMarketplace, mergedCodexHooks, parseReceipt, portablePath, readSource, readTarget, removedManagedAssetContent, sha256, } from "./asset-ownership.js";
const GUIDANCE_START = "<!-- OMC:PROJECT-HOST:START -->";
const GUIDANCE_END = "<!-- OMC:PROJECT-HOST:END -->";
const MCP_START = "# BEGIN OMC PROJECT HOST MCP";
const MCP_END = "# END OMC PROJECT HOST MCP";
const HOST_ORDER = ["claude", "codex"];
function guidanceBlock(guidance) {
    return `${GUIDANCE_START}\n${guidance.trim()}\n${GUIDANCE_END}`;
}
function tomlString(value) {
    return JSON.stringify(value);
}
function codexMcpBlock(packageRoot, marketplaceName) {
    return [
        MCP_START,
        "[mcp_servers.omc]",
        'command = "node"',
        `args = [${tomlString(join(packageRoot, "bridge", "mcp-server.cjs"))}]`,
        "",
        `[plugins.${tomlString(`omc-project-host@${marketplaceName}`)}]`,
        "enabled = true",
        MCP_END,
    ].join("\n");
}
function nativeHookEntries(host) {
    const command = `omc orchestrator hook --host ${host}`;
    const commandWindows = `omc.cmd orchestrator hook --host ${host}`;
    const handler = (timeout) => ({
        type: "command",
        command,
        ...(host === "codex" ? { commandWindows } : {}),
        timeout,
    });
    return {
        SessionStart: [{ matcher: "*", hooks: [handler(10)] }],
        UserPromptSubmit: [{ hooks: [handler(10)] }],
        Stop: [{ hooks: [handler(10)] }],
        SessionEnd: [{ hooks: [handler(3)] }],
    };
}
function frontmatterValue(source, key) {
    const match = source.match(new RegExp(`^${key}:\\s*(.+?)\\s*$`, "m"));
    return match?.[1]?.replace(/^['"]|['"]$/g, "");
}
function codexAgentToml(source, fallbackName) {
    const name = frontmatterValue(source, "name") ?? fallbackName;
    const description = frontmatterValue(source, "description") ?? `OMC ${name} role`;
    const body = source.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim();
    return [
        `name = ${tomlString(name)}`,
        `description = ${tomlString(description)}`,
        `developer_instructions = ${tomlString(body)}`,
        "",
    ].join("\n");
}
function packageVersion(packageRoot) {
    try {
        const raw = JSON.parse(readSource(join(packageRoot, "package.json"), 128 * 1024));
        return typeof raw.version === "string" ? raw.version : "0.0.0";
    }
    catch {
        return "0.0.0";
    }
}
function skillContent(guidance) {
    return [
        "---",
        "name: omc-orchestration",
        "description: Operate the repository-scoped OMC workflow controller, switch lead hosts safely, and diagnose host integration.",
        "---",
        "",
        guidance.trim(),
        "",
        "Use `omc team workflow --help`, `omc orchestrator --help`, and `omc doctor hosts` for the installed command surface. Never edit workflow state JSON directly.",
        "",
    ].join("\n");
}
function hostAssets(root, host, packageRoot, guidance, previous) {
    const prior = new Map(previous?.assets.map((asset) => [asset.path, asset]) ?? []);
    const desired = [];
    const block = guidanceBlock(guidance);
    const skill = skillContent(guidance);
    if (host === "claude") {
        const instructionsPath = "CLAUDE.md";
        const current = readTarget(root, join(root, instructionsPath)).bytes?.toString("utf8") ??
            "";
        desired.push({
            path: instructionsPath,
            kind: "block",
            content: mergeManagedBlock(current, prior.get(instructionsPath), block, GUIDANCE_START, GUIDANCE_END),
            managedText: block,
        });
        const pluginRoot = join(".omc", "hosts", "claude", "plugin");
        const manifest = {
            name: "omc-project-host",
            version: packageVersion(packageRoot),
            description: "Repository-scoped OMC lead integration",
            author: { name: "oh-my-claudecode" },
            skills: ["./skills/omc-orchestration/"],
            mcpServers: "./.mcp.json",
        };
        desired.push({
            path: join(pluginRoot, ".claude-plugin", "plugin.json"),
            kind: "file",
            content: `${JSON.stringify(manifest, null, 2)}\n`,
        }, {
            path: join(pluginRoot, ".mcp.json"),
            kind: "file",
            content: `${JSON.stringify({ mcpServers: { omc: { command: "node", args: [join(packageRoot, "bridge", "mcp-server.cjs")] } } }, null, 2)}\n`,
        }, {
            path: join(pluginRoot, "hooks", "hooks.json"),
            kind: "file",
            content: `${JSON.stringify({ description: "OMC host session lifecycle checks", hooks: nativeHookEntries("claude") }, null, 2)}\n`,
        }, {
            path: join(pluginRoot, "skills", "omc-orchestration", "SKILL.md"),
            kind: "file",
            content: skill,
        });
        for (const entry of readdirSync(join(packageRoot, "agents"), {
            withFileTypes: true,
        })) {
            if (!entry.isFile() || !entry.name.endsWith(".md"))
                continue;
            desired.push({
                path: join(pluginRoot, "agents", entry.name),
                kind: "file",
                content: readSource(join(packageRoot, "agents", entry.name)),
            });
        }
        return desired;
    }
    const instructionsPath = "AGENTS.md";
    const instructions = readTarget(root, join(root, instructionsPath)).bytes?.toString("utf8") ??
        "";
    desired.push({
        path: instructionsPath,
        kind: "block",
        content: mergeManagedBlock(instructions, prior.get(instructionsPath), block, GUIDANCE_START, GUIDANCE_END),
        managedText: block,
    });
    const pluginRoot = join(".omc", "hosts", "codex", "plugin");
    const marketplacePath = portablePath(join(".agents", "plugins", "marketplace.json"));
    const currentMarketplace = readTarget(root, join(root, marketplacePath)).bytes?.toString("utf8") ?? "";
    const marketplace = mergedCodexMarketplace(currentMarketplace, prior.get(marketplacePath), {
        name: "omc-project-host",
        source: { source: "local", path: `./${portablePath(pluginRoot)}` },
        policy: {
            installation: "INSTALLED_BY_DEFAULT",
            authentication: "ON_USE",
        },
        category: "Productivity",
    });
    desired.push({
        path: marketplacePath,
        kind: "json-marketplace",
        content: marketplace.content,
        managedText: marketplace.managedText,
    });
    const configPath = portablePath(join(".codex", "config.toml"));
    const currentConfig = readTarget(root, join(root, configPath)).bytes?.toString("utf8") ?? "";
    const mcpBlock = codexMcpBlock(packageRoot, marketplace.marketplaceName);
    const previousConfig = prior.get(configPath);
    const unownedConfig = previousConfig?.managedText
        ? currentConfig.replace(previousConfig.managedText, "")
        : currentConfig;
    if (hasTomlTableInsertionConflict(unownedConfig, ["mcp_servers", "omc"])) {
        throw new Error("host_assets_mcp_name_collision: omc");
    }
    const pluginKey = `omc-project-host@${marketplace.marketplaceName}`;
    if (hasTomlTableInsertionConflict(unownedConfig, ["plugins", pluginKey])) {
        throw new Error(`host_assets_plugin_config_collision: omc-project-host@${marketplace.marketplaceName}`);
    }
    desired.push({
        path: configPath,
        kind: "block",
        content: mergeManagedBlock(currentConfig, previousConfig, mcpBlock, MCP_START, MCP_END),
        managedText: mcpBlock,
    });
    const hooks = nativeHookEntries("codex");
    const hooksPath = portablePath(join(".codex", "hooks.json"));
    const currentHooks = readTarget(root, join(root, hooksPath)).bytes?.toString("utf8") ?? "";
    const hookText = JSON.stringify(hooks);
    desired.push({
        path: hooksPath,
        kind: "json-hooks",
        content: mergedCodexHooks(currentHooks, prior.get(hooksPath), hooks),
        managedText: hookText,
    }, {
        path: join(pluginRoot, ".codex-plugin", "plugin.json"),
        kind: "file",
        content: `${JSON.stringify({
            name: "omc-project-host",
            version: packageVersion(packageRoot),
            description: "Repository-scoped OMC lead integration",
            author: { name: "oh-my-claudecode" },
            skills: "./skills/",
            hooks: "./hooks/hooks.json",
        }, null, 2)}\n`,
    }, {
        path: join(pluginRoot, "hooks", "hooks.json"),
        kind: "file",
        content: `${JSON.stringify({ hooks }, null, 2)}\n`,
    }, {
        path: join(pluginRoot, "skills", "omc-orchestration", "SKILL.md"),
        kind: "file",
        content: skill,
    }, {
        path: portablePath(join(".agents", "skills", "omc-orchestration", "SKILL.md")),
        kind: "file",
        content: skill,
    });
    for (const entry of readdirSync(join(packageRoot, "agents"), {
        withFileTypes: true,
    })) {
        if (!entry.isFile() || !entry.name.endsWith(".md"))
            continue;
        const source = readSource(join(packageRoot, "agents", entry.name));
        desired.push({
            path: portablePath(join(".codex", "agents", `${entry.name.slice(0, -3)}.toml`)),
            kind: "file",
            content: codexAgentToml(source, entry.name.slice(0, -3)),
        });
    }
    return desired;
}
function prepareSetupMutations(root, receipt, hosts, packageRoot, guidance) {
    const receiptAssets = {};
    const nextHosts = {
        ...receipt.hosts,
    };
    const desiredByPath = new Map();
    const shared = projectIgnoreAsset(root, receipt);
    desiredByPath.set(PROJECT_IGNORE_PATH, shared);
    for (const host of hosts) {
        const desired = hostAssets(root, host, packageRoot, guidance, receipt.hosts[host]);
        receiptAssets[host] = desired;
        for (const asset of desired) {
            const normalized = assertRelativePath(portablePath(asset.path));
            if (desiredByPath.has(normalized))
                throw new Error(`host_assets_duplicate_target: ${normalized}`);
            desiredByPath.set(normalized, { ...asset, path: normalized });
        }
        nextHosts[host] = {
            installedAt: receipt.hosts[host]?.installedAt ?? new Date().toISOString(),
            packageRoot,
            assets: desired.map((asset) => ({
                path: assertRelativePath(portablePath(asset.path)),
                kind: asset.kind,
                digest: sha256(asset.kind === "file" ? asset.content : (asset.managedText ?? "")),
                ...(asset.managedText === undefined
                    ? {}
                    : { managedText: asset.managedText }),
            })),
        };
    }
    const mutations = [];
    for (const [relativePath, asset] of desiredByPath) {
        const absolute = join(root, relativePath);
        const state = readTarget(root, absolute);
        const previousOwner = hosts
            .map((host) => receipt.hosts[host]?.assets.find((item) => item.path === relativePath))
            .concat(receipt.shared?.find((item) => item.path === relativePath))
            .find(Boolean);
        if (asset.kind === "file" && state.bytes && !previousOwner) {
            throw new Error(`host_assets_collision: ${relativePath}`);
        }
        if (asset.kind === "file" &&
            state.bytes &&
            previousOwner &&
            sha256(state.bytes) !== previousOwner.digest) {
            throw new Error(`host_assets_owned_file_modified: ${relativePath}`);
        }
        mutations.push({
            path: absolute,
            relativePath,
            before: state.bytes,
            ...(state.mode === undefined ? {} : { beforeMode: state.mode }),
            after: asset.content,
        });
    }
    for (const host of hosts) {
        const wanted = new Set((receiptAssets[host] ?? []).map((asset) => portablePath(asset.path)));
        for (const old of receipt.hosts[host]?.assets ?? []) {
            if (wanted.has(old.path) || desiredByPath.has(old.path))
                continue;
            const absolute = join(root, old.path);
            const state = readTarget(root, absolute);
            if (!state.bytes)
                continue;
            const after = removedManagedAssetContent(state.bytes, old);
            if (after === undefined)
                throw new Error(`host_assets_managed_content_modified: ${old.path}`);
            mutations.push({
                path: absolute,
                relativePath: old.path,
                before: state.bytes,
                ...(state.mode === undefined ? {} : { beforeMode: state.mode }),
                after,
            });
        }
    }
    const nextReceipt = {
        schemaVersion: 1,
        hosts: nextHosts,
        shared: [shared.receipt],
    };
    const receiptAbsolute = join(root, RECEIPT_PATH);
    const receiptState = readTarget(root, receiptAbsolute);
    mutations.push({
        path: receiptAbsolute,
        relativePath: portablePath(RECEIPT_PATH),
        before: receiptState.bytes,
        ...(receiptState.mode === undefined
            ? {}
            : { beforeMode: receiptState.mode }),
        after: `${JSON.stringify(nextReceipt, null, 2)}\n`,
    });
    return { mutations, nextReceipt, receiptAssets };
}
function normalizeHosts(hosts) {
    if (hosts.length === 0 || hosts.some((host) => !HOST_ORDER.includes(host))) {
        throw new Error("orchestrator_invalid_host");
    }
    return HOST_ORDER.filter((host) => hosts.includes(host));
}
function mergedConfig(current, requested) {
    const supportedHosts = HOST_ORDER.filter((host) => current?.supportedHosts.includes(host) || requested.includes(host));
    const defaultHost = current?.defaultHost ??
        (supportedHosts.includes("claude") ? "claude" : supportedHosts[0]);
    return {
        schemaVersion: 1,
        supportedHosts,
        ...(defaultHost ? { defaultHost } : {}),
    };
}
/** Install or refresh repository-scoped native host assets as one gated operation. */
export async function setupProjectHosts(cwd, hostsInput, options) {
    const hosts = normalizeHosts(hostsInput);
    const root = resolveOrchestratorPaths(cwd).repositoryRoot;
    let packageRoot;
    try {
        packageRoot = realpathSync(resolve(options.packageRoot));
    }
    catch {
        throw new Error("host_assets_invalid_package_root");
    }
    const guidance = readSource(join(packageRoot, "templates", "hosts", "orchestrator-guidance.md"));
    readSource(join(packageRoot, "bridge", "mcp-server.cjs"));
    const receipt = parseReceipt(root);
    if (options.dryRun) {
        const plan = prepareSetupMutations(root, receipt, hosts, packageRoot, guidance);
        const changedFiles = plan.mutations
            .filter((item) => item.after === null
            ? item.before !== null
            : item.before?.toString("utf8") !== item.after)
            .map((item) => item.relativePath);
        return {
            repositoryRoot: root,
            hosts,
            changedFiles,
            unchangedFiles: plan.mutations
                .filter((item) => !changedFiles.includes(item.relativePath))
                .map((item) => item.relativePath),
            dryRun: true,
        };
    }
    let transaction;
    try {
        await updateOrchestratorRepositoryConfig(root, (current) => {
            const currentReceipt = parseReceipt(root);
            const plan = prepareSetupMutations(root, currentReceipt, hosts, packageRoot, guidance);
            transaction = applyMutations(root, plan.mutations);
            return mergedConfig(current, hosts);
        });
    }
    catch (error) {
        transaction?.rollback();
        throw error;
    }
    return {
        repositoryRoot: root,
        hosts,
        changedFiles: transaction?.changedFiles ?? [],
        unchangedFiles: transaction?.unchangedFiles ?? [],
        ...(transaction?.backupDirectory
            ? { backupDirectory: transaction.backupDirectory }
            : {}),
        dryRun: false,
    };
}
function uninstallMutations(root, receipt, host) {
    const owned = receipt.hosts[host];
    if (!owned)
        throw new Error(`host_assets_not_installed: ${host}`);
    const mutations = [];
    const preserved = [];
    for (const asset of owned.assets) {
        const path = join(root, asset.path);
        const state = readTarget(root, path);
        if (!state.bytes)
            continue;
        const after = removedManagedAssetContent(state.bytes, asset);
        if (after === undefined) {
            preserved.push(asset.path);
            continue;
        }
        mutations.push({
            path,
            relativePath: asset.path,
            before: state.bytes,
            ...(state.mode === undefined ? {} : { beforeMode: state.mode }),
            after,
        });
    }
    const { [host]: _removed, ...remaining } = receipt.hosts;
    const nextReceipt = {
        schemaVersion: 1,
        hosts: remaining,
        ...(receipt.shared === undefined ? {} : { shared: receipt.shared }),
    };
    const receiptPath = join(root, RECEIPT_PATH);
    const receiptState = readTarget(root, receiptPath);
    mutations.push({
        path: receiptPath,
        relativePath: portablePath(RECEIPT_PATH),
        before: receiptState.bytes,
        ...(receiptState.mode === undefined
            ? {}
            : { beforeMode: receiptState.mode }),
        after: `${JSON.stringify(nextReceipt, null, 2)}\n`,
    });
    return { mutations, preserved, nextReceipt };
}
/** Remove only verified owned assets; user-modified assets are reported and retained. */
export async function uninstallProjectHost(cwd, host) {
    if (!HOST_ORDER.includes(host))
        throw new Error("orchestrator_invalid_host");
    const root = resolveOrchestratorPaths(cwd).repositoryRoot;
    let transaction;
    let preserved = [];
    let remainingHosts = [];
    try {
        await updateOrchestratorRepositoryConfig(root, (current) => {
            if (!current || !current.supportedHosts.includes(host)) {
                throw new Error(`orchestrator_host_not_supported: ${host}`);
            }
            remainingHosts = current.supportedHosts.filter((candidate) => candidate !== host);
            if (remainingHosts.length === 0)
                throw new Error("orchestrator_cannot_remove_last_host");
            const plan = uninstallMutations(root, parseReceipt(root), host);
            preserved = plan.preserved;
            transaction = applyMutations(root, plan.mutations);
            if (readActiveOrchestrator(root).host === host) {
                throw new Error("orchestrator_cannot_uninstall_active_host");
            }
            const defaultHost = current.defaultHost === host ? remainingHosts[0] : current.defaultHost;
            return {
                schemaVersion: 1,
                supportedHosts: remainingHosts,
                ...(defaultHost ? { defaultHost } : {}),
            };
        });
    }
    catch (error) {
        transaction?.rollback();
        throw error;
    }
    return {
        repositoryRoot: root,
        host,
        removedFiles: (transaction?.changedFiles ?? []).filter((path) => path !== portablePath(RECEIPT_PATH)),
        preservedFiles: preserved,
        remainingHosts,
    };
}
function codexNativeHooksSupported(cli) {
    if (!cli.found || !cli.path)
        return false;
    try {
        const result = spawnSync(cli.path, ["features", "list"], {
            encoding: "utf8",
            timeout: 5000,
            windowsHide: true,
            shell: false,
            stdio: ["ignore", "pipe", "pipe"],
        });
        return (result.status === 0 &&
            /^hooks\s+\S+\s+true\s*$/m.test(result.stdout ?? ""));
    }
    catch {
        return false;
    }
}
/** Inspect project assets without modifying repository or global configuration. */
export async function doctorProjectHosts(cwd) {
    const root = resolveOrchestratorPaths(cwd).repositoryRoot;
    const receipt = parseReceipt(root);
    const config = readOrchestratorRepositoryConfig(root);
    const generalIssues = [];
    if (!config)
        generalIssues.push("Repository host setup is not configured. Run omc setup --host both --scope project.");
    generalIssues.push(...projectIgnoreIssues(root, receipt));
    const entries = {};
    for (const host of HOST_ORDER) {
        const installed = receipt.hosts[host];
        const issues = [];
        if (config?.supportedHosts.includes(host) && !installed)
            issues.push("Host is configured but its asset receipt is missing.");
        if (installed && !config?.supportedHosts.includes(host))
            issues.push("Host assets exist but the shared config does not support this host.");
        for (const asset of installed?.assets ?? []) {
            const issue = assetIssue(root, asset);
            if (issue)
                issues.push(issue);
        }
        const cli = probeCli(host);
        if (config?.supportedHosts.includes(host) && !cli.found)
            issues.push(`CLI unavailable: ${cli.error ?? `${host} --version failed`}`);
        const nativeHooksSupported = host === "claude" ? cli.found : codexNativeHooksSupported(cli);
        const hookDiagnostics = readNativeHookDiagnostics(root, host, !cli.found
            ? "cli-unavailable"
            : nativeHooksSupported
                ? "supported"
                : "unsupported");
        entries[host] = Object.freeze({
            installed: installed !== undefined,
            healthy: installed !== undefined && issues.length === 0,
            cli,
            lifecycle: !installed
                ? "not-installed"
                : host === "claude"
                    ? "plugin-hooks"
                    : nativeHooksSupported
                        ? "native-hooks"
                        : "cli-gate-fallback",
            nativeHooksSupported,
            hookDiagnostics,
            issues: Object.freeze(issues),
        });
    }
    const configuredHealthy = config?.supportedHosts.every((host) => entries[host].healthy) ?? false;
    return Object.freeze({
        repositoryRoot: root,
        healthy: configuredHealthy && generalIssues.length === 0,
        hosts: Object.freeze(entries),
        issues: Object.freeze(generalIssues),
        lifecycleNotes: Object.freeze([
            "OMC does not inspect or modify native trust stores. Project trust and new or changed hook definitions must be reviewed in the host; observed execution is advisory only.",
            "Native hook definitions can be disabled or skipped; OMC CLI operation and publication gates remain authoritative.",
            "Codex SessionEnd is advisory, and hosted tools can bypass local tool hooks. Launch leases and explicit checkpoints enforce handoff safety.",
        ]),
    });
}
//# sourceMappingURL=project-setup.js.map