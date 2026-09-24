import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initWorkflow, readWorkflow, runWorkflow } from '../workflow.js';
import type { WorkflowOptions, WorkflowPlan } from '../workflow-contracts.js';
import { createWorkflowFixture } from './helpers/workflow-fixture.js';

const provider = fileURLToPath(new URL('./helpers/workflow-provider.cjs', import.meta.url));
const check = { command: process.execPath, args: ['-e', 'process.exit(0)'] };

describe('issue #31 reproduction', () => {
  let fixture: ReturnType<typeof createWorkflowFixture>;

  beforeEach(() => {
    fixture = createWorkflowFixture();
    vi.stubEnv('OMC_WORKFLOW_TEST_CONFIG', fixture.configPath);
    vi.stubEnv('OMC_STATE_DIR', '');
    vi.stubEnv('PATHEXT', '.COM;.EXE;.BAT;.CMD');
    vi.stubEnv('__COMPAT_LAYER', 'RunAsInvoker');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fixture.dispose();
  });

  it.runIf(process.platform === 'win32')('does not spend an attempt before starting the provider from a Git Bash-shaped environment', async () => {
    const name = 'issue-31';
    const plan: WorkflowPlan = {
      name,
      objective: 'Run one supervised provider from a non-PowerShell parent environment',
      baseCommit: fixture.baseCommit,
      integrationBranch: 'integration/issue-31',
      tasks: [{
        id: 'one',
        objective: 'Write the owned fixture file',
        baseCommit: fixture.baseCommit,
        writeScope: ['feature/one.txt'],
        readScope: ['README.md'],
        prohibitedScope: ['package.json'],
        dependencies: [],
        contracts: ['Preserve existing behavior.'],
        acceptanceCriteria: ['feature/one.txt exists'],
        tests: [check],
      }],
      verification: [check],
    };
    const options: WorkflowOptions = {
      mode: 'balanced',
      workers: 1,
      maxWorkers: 1,
      maxAttempts: 1,
      maxReviewPasses: 1,
      timeoutMs: 15_000,
      backoffMs: 1,
      providerPolicy: 'supervised',
      glmCommand: provider,
      codexCommand: provider,
      glmModel: 'glm-test',
      codexModel: 'codex-test',
    };

    await initWorkflow(fixture.cwd, plan, options);
    await runWorkflow(fixture.cwd, name);
    await runWorkflow(fixture.cwd, name);

    const task = readWorkflow(fixture.cwd, name).tasks[0]!;
    const stderr = task.handoff?.artifacts.find(artifact => artifact.kind === 'workflow-stderr');
    expect.soft(fixture.events().filter(event => event.event === 'start')).toHaveLength(1);
    expect.soft(task).toMatchObject({ status: 'completed', attempts: 1 });
    if (stderr) {
      expect.soft(readFileSync(stderr.path, 'utf8')).not.toContain('workflow_supervisor_environment_mismatch');
    }
  }, 90_000);
});
