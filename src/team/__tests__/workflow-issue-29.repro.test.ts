import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acceptWorkflowTask,
  initWorkflow,
  readWorkflow,
  runWorkflow,
  workflowStatus,
} from '../workflow.js';
import type {
  WorkflowOptions,
  WorkflowPlan,
  WorkflowTask,
} from '../workflow-contracts.js';
import { createWorkflowFixture } from './helpers/workflow-fixture.js';

const provider = fileURLToPath(
  new URL('./helpers/workflow-provider.cjs', import.meta.url),
);
const check = { command: process.execPath, args: ['-e', 'process.exit(0)'] };

describe('issue #29 reproduction', () => {
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

  function task(id: string, dependencies: string[] = []): WorkflowTask {
    return {
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
    };
  }

  it(
    'explains pending dependency gates and runs accepted work despite an unrelated failure',
    async () => {
      const name = 'issue-29';
      const plan: WorkflowPlan = {
        name,
        objective: 'Reproduce dependency readiness reporting',
        baseCommit: fixture.baseCommit,
        integrationBranch: 'integration/issue-29',
        tasks: [
          task('dependency'),
          task('dependent', ['dependency']),
          task('unrelated-failure'),
          task('blocked-by-failure', ['unrelated-failure']),
        ],
        verification: [check],
      };
      const options: WorkflowOptions = {
        mode: 'balanced',
        workers: 2,
        maxWorkers: 2,
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

      fixture.configure({ tasks: { 'unrelated-failure': { fail: true } } });
      await initWorkflow(fixture.cwd, plan, options);

      const initiallyProjected = (
        workflowStatus(fixture.cwd, name).tasks as Array<
          Record<string, unknown>
        >
      ).find((entry) => entry.id === 'dependent');
      expect(initiallyProjected).toMatchObject({
        status: 'pending',
        readiness: 'blocked',
        blockedReason: 'awaiting_dependency_completion',
        blockedBy: ['dependency'],
      });

      await runWorkflow(fixture.cwd, name);

      const state = readWorkflow(fixture.cwd, name);
      const status = workflowStatus(fixture.cwd, name);
      const dependency = state.tasks.find(
        (entry) => entry.task.id === 'dependency',
      )!;
      const dependent = state.tasks.find(
        (entry) => entry.task.id === 'dependent',
      )!;
      const unrelatedFailure = state.tasks.find(
        (entry) => entry.task.id === 'unrelated-failure',
      )!;
      const unavailableDependent = (
        status.tasks as Array<Record<string, unknown>>
      ).find((entry) => entry.id === 'blocked-by-failure');

      expect(dependency.status).toBe('completed');
      expect(unrelatedFailure).toMatchObject({ status: 'failed', attempts: 1 });
      expect(unrelatedFailure.handoff?.outcome).toBe('failed');
      expect(dependent).toMatchObject({ status: 'pending', attempts: 0 });
      expect(state.stage).toBe('integration');
      expect(status.failedTasks).toBe(1);
      expect(Buffer.byteLength(JSON.stringify(status))).toBeLessThanOrEqual(
        16 * 1024,
      );
      expect(unavailableDependent).toMatchObject({
        status: 'pending',
        readiness: 'blocked',
        blockedReason: 'dependency_unavailable',
        blockedBy: ['unrelated-failure'],
      });

      await acceptWorkflowTask(fixture.cwd, name, 'dependency');
      await runWorkflow(fixture.cwd, name);
      expect(
        readWorkflow(fixture.cwd, name).tasks.find(
          (entry) => entry.task.id === 'dependent',
        ),
      ).toMatchObject({ status: 'completed', attempts: 1 });

      const projected = (status.tasks as Array<Record<string, unknown>>).find(
        (entry) => entry.id === 'dependent',
      );
      expect(projected).toMatchObject({
        status: 'pending',
        readiness: 'blocked',
        blockedReason: 'awaiting_dependency_acceptance',
        blockedBy: ['dependency'],
      });
      for (const entry of (
        status.tasks as Array<Record<string, unknown>>
      ).filter(
        (entry) =>
          !['dependent', 'blocked-by-failure'].includes(String(entry.id)),
      )) {
        expect(entry).not.toHaveProperty('readiness');
        expect(entry).not.toHaveProperty('blockedBy');
        expect(entry).not.toHaveProperty('blockedReason');
      }
    },
    process.platform === 'win32' ? 90_000 : 30_000,
  );
});
