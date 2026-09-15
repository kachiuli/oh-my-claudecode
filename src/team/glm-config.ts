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

/** Only executable names and absolute paths are accepted, never shell commands. */
export function validateGlmCommand(command: unknown): asserts command is string {
  if (typeof command !== 'string' || !command.trim() || /[\0\r\n]/.test(command)
    || (!isAbsolute(command) && !/^[A-Za-z0-9._-]+$/.test(command))) {
    throw new Error('team.glm.command must be an executable name or absolute path');
  }
  if (process.platform === 'win32' && /\.(cmd|bat|ps1)$/i.test(command)) {
    throw new Error('GLM requires a directly executable wrapper on Windows; shell scripts are unsupported');
  }
}

export function getGlmConfig(config: PluginConfig = {}, env: NodeJS.ProcessEnv = process.env): GlmConfig {
  const raw = config.team?.glm;
  if (raw !== undefined && (!raw || typeof raw !== 'object' || Array.isArray(raw))) {
    throw new Error('team.glm must be an object');
  }
  const command = env.OMC_GLM_COMMAND ?? raw?.command ?? 'claude-glm';
  validateGlmCommand(command);
  if (raw?.fallback !== undefined && raw.fallback !== false) {
    throw new Error('team.glm.fallback must be false: provider fallback is unsupported in V1');
  }
  const defaultWorkers = raw?.defaultWorkers ?? 4;
  const maxWorkers = raw?.maxWorkers ?? 6;
  if (!Number.isInteger(defaultWorkers) || !Number.isInteger(maxWorkers)
    || defaultWorkers < 1 || maxWorkers < 1 || defaultWorkers > maxWorkers || maxWorkers > ABSOLUTE_MAX_WORKERS) {
    throw new Error(`team.glm worker counts must be integers with 1 <= defaultWorkers <= maxWorkers <= ${ABSOLUTE_MAX_WORKERS}`);
  }
  const model = env.OMC_EXTERNAL_MODELS_DEFAULT_GLM_MODEL ?? env.OMC_GLM_DEFAULT_MODEL
    ?? config.externalModels?.defaults?.glmModel;
  if (model !== undefined && (typeof model !== 'string' || !model.trim() || /[\0\r\n]/.test(model))) {
    throw new Error('GLM model must be a non-empty single-line string');
  }
  return { command, fallback: false, defaultWorkers, maxWorkers, ...(model ? { model: model.trim() } : {}) };
}

export function resolveGlmExecutable(command: string): string {
  validateGlmCommand(command);
  let resolved = command;
  if (!isAbsolute(command)) {
    const result = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', [command], {
      encoding: 'utf8', timeout: 5000, shell: false, windowsHide: true,
    });
    if (result.error || result.status !== 0) throw new Error('GLM executable unavailable (fallback disabled)');
    resolved = result.stdout.split(/\r?\n/).find(line => line.trim())?.trim() ?? '';
  }
  validateGlmCommand(resolved);
  if (!isAbsolute(resolved) || !existsSync(resolved) || !statSync(resolved).isFile()) {
    throw new Error('GLM executable unavailable (fallback disabled)');
  }
  return resolved;
}

/** Expand the preset into the existing routing mechanism; explicit entries win. */
export function applyGlmProfile(config: PluginConfig): PluginConfig {
  if (config.team?.profile === undefined) return config;
  if (config.team.profile !== 'claude-glm-codex') throw new Error('Unknown team.profile');
  const roleRouting: Record<string, TeamRoleAssignmentSpec> = {
    orchestrator: { model: 'HIGH' }, planner: { provider: 'claude', model: 'HIGH' },
    architect: { provider: 'claude', model: 'HIGH' }, executor: { provider: 'glm' },
    debugger: { provider: 'glm' }, 'test-engineer': { provider: 'glm' },
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
      ops: { defaultAgentType: 'glm', worktreeMode: 'branch', ...config.team.ops },
      roleRouting,
    },
  };
}
