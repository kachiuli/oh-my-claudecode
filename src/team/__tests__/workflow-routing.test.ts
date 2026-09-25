import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import * as loader from '../../config/loader.js';
import { initWorkflow, readWorkflow, workflowStatus } from '../workflow.js';
import { workflowUsage } from '../workflow-report.js';
import type { PluginConfig } from '../../shared/types.js';
import { createWorkflowFixture } from './helpers/workflow-fixture.js';

describe('workflow snapshots existing role routing', () => {
  let fixture: ReturnType<typeof createWorkflowFixture>;
  beforeEach(() => { fixture = createWorkflowFixture(); });
  afterEach(() => { vi.restoreAllMocks(); fixture.dispose(); });
  function plan() {
    return { name: 'routing', objective: 'Implement scoped change', baseCommit: fixture.baseCommit,
      integrationBranch: 'integration/routing', tasks: [{ id: 'task', objective: 'Implement task', baseCommit: fixture.baseCommit,
        writeScope: ['src'], readScope: [], prohibitedScope: [], dependencies: [], contracts: [], acceptanceCriteria: ['Works'], tests: [] }],
      verification: [{ command: process.execPath, args: ['-e', 'process.exit(0)'] }] };
  }
  it('uses explicit executor/reviewer models and keeps the snapshot after configuration changes', async () => {
    const config: PluginConfig = { team: { roleRouting: {
      executor: { provider: 'glm', model: 'glm-role-model' },
      'code-reviewer': { provider: 'codex', model: 'codex-role-model' },
    } }, externalModels: { defaults: { glmModel: 'glm-default', codexModel: 'codex-default' } } };
    const load = vi.spyOn(loader, 'loadConfig').mockReturnValue(config);
    const state = await initWorkflow(fixture.cwd, plan());
    expect(state.options.glmModel).toBe('glm-role-model');
    expect(state.options.codexModel).toBe('codex-role-model');
    load.mockReturnValue({});
    expect(readWorkflow(fixture.cwd, 'routing').options).toEqual(state.options);
  });
  it('uses external provider defaults when the role does not override the model', async () => {
    vi.spyOn(loader, 'loadConfig').mockReturnValue({ externalModels: { defaults: { glmModel: 'glm-default', codexModel: 'codex-default' } } });
    const state = await initWorkflow(fixture.cwd, plan());
    expect(state.options.glmModel).toBe('glm-default');
    expect(state.options.codexModel).toBe('codex-default');
  });
  it('keeps MiMo identity and selected Flash model in a saved workflow', async () => {
    vi.spyOn(loader, 'loadConfig').mockReturnValue({ team: { profile: 'claude-mimo-codex',
      mimo: { command: process.execPath } }, externalModels: { defaults: { mimoModel: 'mimo-v2.6-flash' } } });
    const state = await initWorkflow(fixture.cwd, plan());
    expect(state.profile).toBe('claude-mimo-codex');
    expect(state.options.glmCommand).toBe(process.execPath);
    expect(state.options.glmModel).toBe('mimo-v2.6-flash');
    expect(readWorkflow(fixture.cwd, 'routing').profile).toBe('claude-mimo-codex');
    expect(workflowStatus(fixture.cwd, 'routing')).toMatchObject({
      tasks: [{ provider: 'mimo', model: 'mimo-v2.6-flash' }],
    });
    expect(workflowUsage(state).providers.map(provider => provider.provider)).toEqual(['mimo', 'codex']);
  });
  it.each(['executor', 'code-reviewer'] as const)('fails before creating state or switching branches when %s conflicts with the pipeline', async role => {
    vi.spyOn(loader, 'loadConfig').mockReturnValue({ team: { roleRouting: { [role]: { provider: 'claude' } } } });
    await expect(initWorkflow(fixture.cwd, plan())).rejects.toThrow('workflow_role_routing_requires_glm_executor_and_codex_reviewer');
    expect(fixture.git('branch', '--show-current')).toBe('main');
    expect(existsSync(join(fixture.cwd, '.omc/state/team/routing/workflow.json'))).toBe(false);
  });
});
