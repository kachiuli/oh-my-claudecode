import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { applyGlmProfile, getGlmConfig, getMimoConfig, resolveGlmExecutable, resolveMimoExecutable } from '../glm-config.js';
import { buildLaunchArgs, getContract, getPromptModeArgs, isPromptModeAgent, resolveDefaultWorkerModel, normalizeExternalModelsDefaults } from '../model-contract.js';
import { probeGlmCli, probeMimoCli } from '../cli-detection.js';
import { parseAskArgs } from '../../cli/ask.js';
import { parseTeamArgs } from '../../cli/commands/team.js';
import { loadConfig, validateTeamConfig, generateConfigSchema } from '../../config/loader.js';
import { resolveRoleAssignment, buildResolvedRoutingSnapshot } from '../stage-router.js';
import { startTeam } from '../runtime.js';

vi.mock('../../cli/commands/team-workflow.js', () => ({ workflowCommand: vi.fn() }));

afterEach(() => vi.unstubAllEnvs());

describe('GLM CLI provider', () => {
  it('rejects the legacy runtime before spawning a GLM worker without isolation', async () => {
    await expect(startTeam({ teamName: 'glm-legacy', workerCount: 1, agentTypes: ['glm'], tasks: [], cwd: process.cwd() }))
      .rejects.toThrow('team_start_unsafe_runtime_v1');
  });
  it('parses ask and team specifications as a real provider', () => {
    expect(parseAskArgs(['glm', 'inspect subsystem']).provider).toBe('glm');
    const team = parseTeamArgs(['4:glm', 'implement scoped tasks']);
    expect(team.workerCount).toBe(4);
    expect(team.agentTypes).toEqual(['glm', 'glm', 'glm', 'glm']);
    expect(parseTeamArgs(['implement tasks'], 'glm', 4).workerCount).toBe(4);
  });

  it('provides one-shot args and preserves literal model and task arguments', () => {
    const model = 'glm-5;echo should-not-run';
    const prompt = '--untrusted $(touch exploit)\nsecond line';
    expect(getContract('glm').agentType).toBe('glm');
    expect(isPromptModeAgent('glm')).toBe(true);
    expect(buildLaunchArgs('glm', { teamName: 'glm-test', workerName: 'worker-1', cwd: process.cwd(), model }))
      .toEqual(['--dangerously-skip-permissions', '--model', model]);
    expect(getPromptModeArgs('glm', prompt)).toEqual(['-p', prompt]);
  });

  it('defaults to fail-closed with OMC-side 4/6 concurrency', () => {
    expect(getGlmConfig({}, {})).toEqual({ command: 'claude-glm', fallback: false, defaultWorkers: 4, maxWorkers: 6 });
    expect(() => getGlmConfig({ team: { glm: { fallback: true } } }, {})).toThrow('fallback');
  });

  it.each(['claude-glm --model x', 'claude-glm; echo x', './claude-glm', 'claude-glm\nsecret', ''])('rejects unsafe command %j', command => {
    expect(() => getGlmConfig({ team: { glm: { command } } }, {})).toThrow('command');
  });

  it('resolves a local executable and reports launchability without its output', () => {
    const config = getGlmConfig({ team: { glm: { command: process.execPath } }, externalModels: { defaults: { glmModel: 'glm-custom' } } }, {});
    expect(resolveGlmExecutable(config.command)).toBe(process.execPath);
    expect(probeGlmCli(config)).toEqual({ found: true, launchable: true, path: process.execPath, modelOverride: true, fallback: false });
  });

  it('fails closed for missing executables', () => {
    const config = getGlmConfig({ team: { glm: { command: join(tmpdir(), 'omc-nonexistent-glm-provider-78236') } } }, {});
    expect(() => resolveGlmExecutable(config.command)).toThrow('fallback disabled');
    expect(probeGlmCli(config)).toMatchObject({ found: false, launchable: false, fallback: false });
  });

  it('distinguishes an existing but unlaunchable executable', () => {
    const directory = mkdtempSync(join(tmpdir(), 'omc-glm-probe-'));
    try {
      const command = join(directory, 'not-executable');
      writeFileSync(command, 'not a program');
      expect(probeGlmCli(getGlmConfig({ team: { glm: { command } } }, {}))).toMatchObject({ found: true, launchable: false, fallback: false });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('supports configuration and environment model override without a default model', () => {
    expect(resolveDefaultWorkerModel('glm', {}, {})).toBeUndefined();
    expect(resolveDefaultWorkerModel('glm', {}, { glmModel: 'glm-code' })).toBe('glm-code');
    expect(getGlmConfig({ externalModels: { defaults: { glmModel: 'config-model' } } }, { OMC_GLM_DEFAULT_MODEL: 'env-model' }).model).toBe('env-model');
    expect(normalizeExternalModelsDefaults({ glmModel: ' glm-code ' })).toEqual({ glmModel: 'glm-code' });
  });

  it.each([{ defaultWorkers: 7, maxWorkers: 6 }, { defaultWorkers: 0 }, { maxWorkers: 21 }, { defaultWorkers: 1.5 }])('rejects invalid limits %j', glm => {
    expect(() => getGlmConfig({ team: { glm } }, {})).toThrow('worker counts');
  });

  it('expands the profile through canonical role routing with explicit overrides', () => {
    const config = applyGlmProfile({ team: { profile: 'claude-glm-codex', roleRouting: { debugger: { provider: 'claude' } } } });
    expect(resolveRoleAssignment('executor', config).provider).toBe('glm');
    expect(resolveRoleAssignment('debugger', config).provider).toBe('claude');
    expect(resolveRoleAssignment('critic', config).provider).toBe('codex');
    expect(resolveRoleAssignment('orchestrator', config).provider).toBe('claude');
    expect(buildResolvedRoutingSnapshot(config)['test-engineer'].primary.provider).toBe('glm');
    expect(() => validateTeamConfig(config)).not.toThrow();
  });

  it('inherits preset providers for model-only and agent-only role overrides', () => {
    const config = applyGlmProfile({ team: { profile: 'claude-glm-codex', roleRouting: {
      executor: { model: 'glm-custom', agent: 'testEngineer' },
      'code-reviewer': { model: 'codex-custom' },
    } } });
    expect(resolveRoleAssignment('executor', config)).toEqual({ provider: 'glm', model: 'glm-custom', agent: 'testEngineer' });
    expect(resolveRoleAssignment('code-reviewer', config)).toMatchObject({ provider: 'codex', model: 'codex-custom' });
    expect(applyGlmProfile(config)).toEqual(config);
  });

  it('applies alias-keyed explicit overrides over preset canonical roles', () => {
    const roleRouting = Object.fromEntries([['reviewer', { provider: 'gemini', model: 'review-custom' }]]);
    const config = applyGlmProfile({ team: { profile: 'claude-glm-codex', roleRouting } });
    expect(resolveRoleAssignment('code-reviewer', config)).toMatchObject({ provider: 'gemini', model: 'review-custom' });
  });

  it('keeps explicit canonical role precedence over its alias', () => {
    const roleRouting = Object.fromEntries([
      ['code-reviewer', { model: 'canonical-model' }], ['reviewer', { model: 'alias-model' }],
    ]);
    const config = applyGlmProfile({ team: { profile: 'claude-glm-codex', roleRouting } });
    expect(resolveRoleAssignment('code-reviewer', config)).toMatchObject({ provider: 'codex', model: 'canonical-model' });
  });

  it('loads profile-only project config with GLM workers and branch worktrees', () => {
    const directory = mkdtempSync(join(tmpdir(), 'omc-glm-profile-'));
    const previousCwd = process.cwd();
    try {
      mkdirSync(join(directory, '.claude'));
      writeFileSync(join(directory, '.claude', 'omc.jsonc'), JSON.stringify({ team: { profile: 'claude-glm-codex' } }));
      process.chdir(directory);
      const config = loadConfig();
      expect(config.team?.ops).toMatchObject({ defaultAgentType: 'glm', worktreeMode: 'branch' });
      expect(config.team?.roleRouting?.executor).toEqual({ provider: 'glm' });
    } finally {
      process.chdir(previousCwd);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('leaves zero-config routing untouched and includes GLM in generated schema', () => {
    const config = {};
    expect(applyGlmProfile(config)).toBe(config);
    expect(resolveRoleAssignment('executor', config).provider).toBe('claude');
    expect(JSON.stringify(generateConfigSchema())).toContain('glmModel');
  });
});

describe('MiMo Claude Code worker', () => {
  it.each(['mimo-v2.6-pro', 'mimo-v2.6-flash'])('keeps the exact %s model ID', model => {
    expect(parseAskArgs(['mimo', 'inspect subsystem']).provider).toBe('mimo');
    expect(parseTeamArgs(['2:mimo', 'implement scoped tasks']).agentTypes).toEqual(['mimo', 'mimo']);
    expect(isPromptModeAgent('mimo')).toBe(true);
    expect(buildLaunchArgs('mimo', { teamName: 'mimo-test', workerName: 'worker-1', cwd: process.cwd(), model }))
      .toEqual(['--dangerously-skip-permissions', '--model', model]);
  });

  it('keeps separate MiMo and GLM commands, models, and fail-closed checks', () => {
    expect(getMimoConfig({}, {})).toEqual({ command: 'claude-mimo', fallback: false, defaultWorkers: 4, maxWorkers: 6 });
    const config = { team: { glm: { command: 'claude-glm' }, mimo: { command: process.execPath } },
      externalModels: { defaults: { glmModel: 'glm-5.3', mimoModel: 'mimo-v2.6-flash' } } };
    expect(getGlmConfig(config, {}).model).toBe('glm-5.3');
    expect(getMimoConfig(config, {}).model).toBe('mimo-v2.6-flash');
    expect(resolveMimoExecutable(process.execPath)).toBe(process.execPath);
    expect(probeMimoCli(getMimoConfig(config, {}))).toMatchObject({ found: true, launchable: true, modelOverride: true });
    expect(() => getMimoConfig({ team: { mimo: { command: 'claude-mimo; echo unsafe' } } }, {})).toThrow('command');
    expect(() => getMimoConfig({ team: { mimo: { fallback: true } } }, {})).toThrow('fallback');
  });

  it('routes the MiMo preset without changing the GLM preset', () => {
    const mimo = applyGlmProfile({ team: { profile: 'claude-mimo-codex' },
      externalModels: { defaults: { mimoModel: 'mimo-v2.6-pro' } } });
    expect(resolveRoleAssignment('executor', mimo)).toMatchObject({ provider: 'mimo', model: 'mimo-v2.6-pro' });
    expect(resolveRoleAssignment('code-reviewer', mimo).provider).toBe('codex');
    expect(mimo.team?.ops?.defaultAgentType).toBe('mimo');
    expect(resolveRoleAssignment('executor', applyGlmProfile({ team: { profile: 'claude-glm-codex' } })).provider).toBe('glm');
    expect(() => validateTeamConfig(mimo)).not.toThrow();
    expect(JSON.stringify(generateConfigSchema())).toContain('mimoModel');
  });
});
