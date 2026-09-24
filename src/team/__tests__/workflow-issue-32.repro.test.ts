import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acceptWorkflowTask, initWorkflow, readWorkflow, runWorkflow } from '../workflow.js';
import type { WorkflowOptions, WorkflowPlan, WorkflowTask } from '../workflow-contracts.js';
import { createWorkflowFixture } from './helpers/workflow-fixture.js';

const provider = fileURLToPath(new URL('./helpers/workflow-provider.cjs', import.meta.url));

describe('issue #32 dependent check base', () => {
  let fixture: ReturnType<typeof createWorkflowFixture>;

  beforeEach(() => {
    fixture = createWorkflowFixture();
    vi.stubEnv('OMC_WORKFLOW_TEST_CONFIG', fixture.configPath);
    vi.stubEnv('OMC_STATE_DIR', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fixture.dispose();
  });

  it('rejects a stale dependent check before dispatch and accepts a base-independent check', async () => {
    const name = 'issue-32';
    const check = { command: 'git', args: ['diff', '--check', fixture.baseCommit, 'HEAD'] };
    const task = (id: string, dependencies: string[] = []): WorkflowTask => ({
      id,
      objective: `Implement ${id}`,
      baseCommit: fixture.baseCommit,
      writeScope: [`feature/${id}.txt`],
      readScope: ['README.md'],
      prohibitedScope: ['package.json'],
      dependencies,
      contracts: ['Preserve existing behavior.'],
      acceptanceCriteria: [`feature/${id}.txt exists`],
      tests: [check],
    });
    const plan: WorkflowPlan = {
      name,
      objective: 'Reproduce a dependent check that keeps the original base SHA',
      baseCommit: fixture.baseCommit,
      integrationBranch: 'integration/issue-32',
      tasks: [task('first'), task('dependent', ['first'])],
      verification: [check],
    };
    const options: WorkflowOptions = {
      mode: 'balanced', workers: 1, maxWorkers: 1, maxAttempts: 1,
      maxReviewPasses: 1, timeoutMs: 15_000, backoffMs: 1,
      providerPolicy: 'supervised', glmCommand: provider, codexCommand: provider,
      glmModel: 'glm-test', codexModel: 'codex-test',
    };
    await expect(initWorkflow(fixture.cwd, plan, options)).rejects.toThrow(
      'workflow_dependent_test_uses_plan_base',
    );
    expect(fixture.events()).toEqual([]);
    expect(fixture.git('branch', '--show-current')).toBe('main');
    expect(() => readWorkflow(fixture.cwd, name)).toThrow();

    plan.tasks[1]!.tests = [{ command: 'git', args: ['diff', '--check', fixture.baseCommit.toUpperCase(), 'HEAD'] }];
    await expect(initWorkflow(fixture.cwd, plan, options)).rejects.toThrow(
      'workflow_dependent_test_uses_plan_base',
    );
    expect(fixture.git('branch', '--show-current')).toBe('main');

    plan.tasks[1]!.tests = [{ command: 'git', args: ['diff', '--check', 'HEAD~1', 'HEAD'] }];
    await initWorkflow(fixture.cwd, plan, options);
    await runWorkflow(fixture.cwd, name);
    await acceptWorkflowTask(fixture.cwd, name, 'first');
    await runWorkflow(fixture.cwd, name);
    const dependent = readWorkflow(fixture.cwd, name).tasks[1]!;
    expect(dependent.task.baseCommit).not.toBe(fixture.baseCommit);
    expect(dependent).toMatchObject({ status: 'completed', attempts: 1 });
  }, process.platform === 'win32' ? 90_000 : 30_000);
});
