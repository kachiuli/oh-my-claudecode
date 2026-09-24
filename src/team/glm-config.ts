import { existsSync, statSync } from 'fs';
import { isAbsolute } from 'path';
import { spawnSync } from 'child_process';
import type { PluginConfig, TeamRoleAssignmentSpec } from '../shared/types.js';
import { ABSOLUTE_MAX_WORKERS } from './types.js';
import { normalizeDelegationRole } from '../features/delegation-routing/types.js';

export interface GlmConfig {
  command: string;
  fallback: false;
  defaultWorkers: number;
  maxWorkers: number;
  model?: string;
}
export type MimoConfig = GlmConfig;
type CompatibleWorker = 'glm' | 'mimo';

/** Only executable names and absolute paths are accepted, never shell commands. */
function validateWorkerCommand(command: unknown, provider: CompatibleWorker): asserts command is string {
  if (typeof command !== 'string' || !command.trim() || /[\0\r\n]/.test(command)
    || (!isAbsolute(command) && !/^[A-Za-z0-9._-]+$/.test(command))) {
    throw new Error(`team.${provider}.command must be an executable name or absolute path`);
  }
  if (process.platform === 'win32' && /\.(cmd|bat|ps1)$/i.test(command)) {
    throw new Error(`${provider.toUpperCase()} requires a directly executable wrapper on Windows; shell scripts are unsupported`);
  }
}

export function validateGlmCommand(command: unknown): asserts command is string {
  validateWorkerCommand(command, 'glm');
}

function getWorkerConfig(provider: CompatibleWorker, config: PluginConfig, env: NodeJS.ProcessEnv): GlmConfig {
  const raw = config.team?.[provider];
  if (raw !== undefined && (!raw || typeof raw !== 'object' || Array.isArray(raw))) {
    throw new Error(`team.${provider} must be an object`);
  }
  const upper = provider.toUpperCase();
  const command = env[`OMC_${upper}_COMMAND`] ?? raw?.command ?? `claude-${provider}`;
  validateWorkerCommand(command, provider);
  if (raw?.fallback !== undefined && raw.fallback !== false) {
    throw new Error(`team.${provider}.fallback must be false: provider fallback is unsupported in V1`);
  }
  const defaultWorkers = raw?.defaultWorkers ?? 4;
  const maxWorkers = raw?.maxWorkers ?? 6;
  if (!Number.isInteger(defaultWorkers) || !Number.isInteger(maxWorkers)
    || defaultWorkers < 1 || maxWorkers < 1 || defaultWorkers > maxWorkers || maxWorkers > ABSOLUTE_MAX_WORKERS) {
    throw new Error(`team.${provider} worker counts must be integers with 1 <= defaultWorkers <= maxWorkers <= ${ABSOLUTE_MAX_WORKERS}`);
  }
  const model = env[`OMC_EXTERNAL_MODELS_DEFAULT_${upper}_MODEL`] ?? env[`OMC_${upper}_DEFAULT_MODEL`]
    ?? config.externalModels?.defaults?.[`${provider}Model`];
  if (model !== undefined && (typeof model !== 'string' || !model.trim() || /[\0\r\n]/.test(model))) {
    throw new Error(`${upper} model must be a non-empty single-line string`);
  }
  return { command, fallback: false, defaultWorkers, maxWorkers, ...(model ? { model: model.trim() } : {}) };
}

export function getGlmConfig(config: PluginConfig = {}, env: NodeJS.ProcessEnv = process.env): GlmConfig {
  return getWorkerConfig('glm', config, env);
}

export function getMimoConfig(config: PluginConfig = {}, env: NodeJS.ProcessEnv = process.env): MimoConfig {
  return getWorkerConfig('mimo', config, env);
}

function resolveWorkerExecutable(command: string, provider: CompatibleWorker): string {
  validateWorkerCommand(command, provider);
  let resolved = command;
  if (!isAbsolute(command)) {
    const result = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', [command], {
      encoding: 'utf8', timeout: 5000, shell: false, windowsHide: true,
    });
    if (result.error || result.status !== 0) throw new Error(`${provider.toUpperCase()} executable unavailable (fallback disabled)`);
    resolved = result.stdout.split(/\r?\n/).find(line => line.trim())?.trim() ?? '';
  }
  validateWorkerCommand(resolved, provider);
  if (!isAbsolute(resolved) || !existsSync(resolved) || !statSync(resolved).isFile()) {
    throw new Error(`${provider.toUpperCase()} executable unavailable (fallback disabled)`);
  }
  return resolved;
}

export function resolveGlmExecutable(command: string): string {
  return resolveWorkerExecutable(command, 'glm');
}

export function resolveMimoExecutable(command: string): string {
  return resolveWorkerExecutable(command, 'mimo');
}

/** Expand the preset into the existing routing mechanism; explicit entries win. */
export function applyGlmProfile(config: PluginConfig): PluginConfig {
  if (config.team?.profile === undefined) return config;
  const provider = config.team.profile === 'claude-glm-codex' ? 'glm'
    : config.team.profile === 'claude-mimo-codex' ? 'mimo' : undefined;
  if (!provider) throw new Error('Unknown team.profile');
  const roleRouting: Record<string, TeamRoleAssignmentSpec> = {
    orchestrator: { model: 'HIGH' }, planner: { provider: 'claude', model: 'HIGH' },
    architect: { provider: 'claude', model: 'HIGH' }, executor: { provider },
    debugger: { provider }, 'test-engineer': { provider },
    critic: { provider: 'codex' }, 'code-reviewer': { provider: 'codex' },
  };
  const overrides = config.team.roleRouting;
  for (const [role, spec] of Object.entries(overrides ?? {})) {
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error(`team.roleRouting.${role} must be an object`);
    const canonical = normalizeDelegationRole(role);
    // Match the router's precedence when both an alias and its canonical key are supplied.
    if (role !== canonical && overrides && Object.prototype.hasOwnProperty.call(overrides, canonical)) continue;
    roleRouting[canonical] = { ...roleRouting[canonical], ...spec };
  }
  return {
    ...config,
    team: {
      ...config.team,
      ops: { defaultAgentType: provider, worktreeMode: 'branch', ...config.team.ops },
      roleRouting,
    },
  };
}
