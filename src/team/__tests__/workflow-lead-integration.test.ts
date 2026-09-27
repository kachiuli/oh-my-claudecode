import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acceptWorkflowTask, finishWorkflow, initWorkflow, integrateWorkflowLeadCommit, readWorkflow,
  reviewWorkflow, runWorkflow, verifyWorkflow,
} from '../workflow.js';
import type { WorkflowLeadIntegrationIntent, WorkflowOptions, WorkflowPlan, WorkflowTask } from '../workflow-contracts.js';
import { createWorkflowFixture } from './helpers/workflow-fixture.js';

const provider = fileURLToPath(new URL('./helpers/workflow-provider.cjs', import.meta.url));
const passingCheck = { command: process.execPath, args: ['-e', 'process.exit(0)'] };

describe('attributed lead integration', () => {
  let fixture: ReturnType<typeof createWorkflowFixture>;
  const name = 'lead-integration';
  const options: WorkflowOptions = { workers: 2, maxWorkers: 2, maxAttempts: 1, maxReviewPasses: 2,
    timeoutMs: 15_000, backoffMs: 0, glmCommand: provider, codexCommand: provider };

  beforeEach(() => {
    fixture = createWorkflowFixture();
    vi.stubEnv('OMC_WORKFLOW_TEST_CONFIG', fixture.configPath);
    vi.stubEnv('OMC_STATE_DIR', '');
  });
  afterEach(() => { vi.unstubAllEnvs(); fixture.dispose(); });

  function task(id: string): WorkflowTask {
    return { id, objective: `Implement ${id}`, baseCommit: fixture.baseCommit, writeScope: [`feature/${id}.txt`],
      readScope: ['README.md'], prohibitedScope: ['package.json'], dependencies: [], contracts: [],
      acceptanceCriteria: [`feature/${id}.txt exists`], tests: [passingCheck] };
  }
  function plan(tasks = [task('a'), task('b')]): WorkflowPlan {
    return { name, objective: 'Integrate two components', baseCommit: fixture.baseCommit,
      integrationBranch: 'integration/lead', tasks, verification: [passingCheck] };
  }
  async function settle(tasks = [task('a'), task('b')], selectedOptions = options) {
    await initWorkflow(fixture.cwd, plan(tasks), selectedOptions);
    await runWorkflow(fixture.cwd, name);
    for (const entry of tasks) await acceptWorkflowTask(fixture.cwd, name, entry.id);
  }
  function commit(path = 'registry/pins.txt', content = 'pin=v1\n') {
    const parent = fixture.git('rev-parse', 'HEAD');
    mkdirSync(join(fixture.cwd, 'registry'), { recursive: true });
    writeFileSync(join(fixture.cwd, path), content);
    fixture.git('add', '--', path);
    fixture.git('commit', '-m', 'Pin integrated registry');
    return { parent, head: fixture.git('rev-parse', 'HEAD'), path };
  }
  function intent(change: ReturnType<typeof commit>, overrides: Partial<WorkflowLeadIntegrationIntent> = {}): WorkflowLeadIntegrationIntent {
    return { expectedParent: change.parent, expectedHead: change.head, actor: { id: 'unknown', model: 'unknown' },
      authorityRef: 'issue-39-approved', reason: 'Pin the shared registry after native tasks settled.', paths: [change.path],
      checks: [passingCheck], ...overrides };
  }

  it('adopts one direct child with immutable evidence and still requires normal verification and review', async () => {
    await settle();
    const before = readWorkflow(fixture.cwd, name);
    const change = commit();
    const integrated = await integrateWorkflowLeadCommit(fixture.cwd, name, intent(change));
    expect(integrated.integrationHead).toBe(change.head);
    expect(integrated.tasks.map(entry => [entry.status, entry.attempts])).toEqual(before.tasks.map(entry => [entry.status, entry.attempts]));
    expect(integrated.reviewPasses).toBe(before.reviewPasses);
    expect(integrated.verification).toBeUndefined();
    expect(integrated.leadIntegrations).toEqual([expect.objectContaining({ sequence: 1, parent: change.parent, head: change.head,
      changedFiles: [change.path], orchestrationHost: 'claude', actor: { id: 'unknown', model: 'unknown' },
      authorityRef: 'issue-39-approved', checks: [expect.objectContaining({ command: passingCheck, passed: true })] })]);
    await expect(finishWorkflow(fixture.cwd, name)).rejects.toThrow('workflow_current_verification_required');
    await verifyWorkflow(fixture.cwd, name);
    await expect(finishWorkflow(fixture.cwd, name)).rejects.toThrow('workflow_review_required');
    await reviewWorkflow(fixture.cwd, name);
    expect((await finishWorkflow(fixture.cwd, name)).stage).toBe('complete');
  }, 60_000);

  it('does not let a stale successful review complete a newly integrated head', async () => {
    await settle([task('a')]);
    await verifyWorkflow(fixture.cwd, name);
    await reviewWorkflow(fixture.cwd, name);
    const reviewedHead = readWorkflow(fixture.cwd, name).reviews.at(-1)!.head;
    const change = commit();
    await integrateWorkflowLeadCommit(fixture.cwd, name, intent(change));
    expect(reviewedHead).toBe(change.parent);
    await verifyWorkflow(fixture.cwd, name);
    await expect(finishWorkflow(fixture.cwd, name)).rejects.toThrow('workflow_current_review_required');
    await reviewWorkflow(fixture.cwd, name);
    await finishWorkflow(fixture.cwd, name);
  }, 60_000);

  it.each([
    ['stale parent', (_change: ReturnType<typeof commit>) => ({ expectedParent: fixture.baseCommit }), 'workflow_lead_integration_parent_mismatch'],
    ['wrong head', (_change: ReturnType<typeof commit>) => ({ expectedHead: fixture.baseCommit }), 'workflow_lead_integration_head_mismatch'],
    ['wrong paths', (_change: ReturnType<typeof commit>) => ({ paths: ['registry/other.txt'] }), 'workflow_lead_integration_changed_files_mismatch'],
    ['failed check', (_change: ReturnType<typeof commit>) => ({ checks: [{ command: process.execPath, args: ['-e', 'process.exit(1)'] }] }), 'workflow_lead_integration_check_failed'],
  ] as const)('refuses %s without advancing saved integration state', async (_label, changeIntent, error) => {
    await settle([task('a')]);
    const change = commit();
    await expect(integrateWorkflowLeadCommit(fixture.cwd, name, intent(change, changeIntent(change))))
      .rejects.toThrow(error);
    const state = readWorkflow(fixture.cwd, name);
    expect(state.integrationHead).toBe(change.parent);
    expect(state.leadIntegrations).toBeUndefined();
  }, 60_000);

  it('refuses a multi-commit range', async () => {
    await settle([task('a')]);
    const first = commit('registry/pins.txt', 'pin=v1\n');
    const second = commit('registry/second.txt', 'pin=v2\n');
    await expect(integrateWorkflowLeadCommit(fixture.cwd, name, intent({ parent: first.parent, head: second.head, path: second.path },
      { paths: [first.path, second.path] }))).rejects.toThrow('workflow_lead_integration_single_commit_required');
    expect(readWorkflow(fixture.cwd, name).integrationHead).toBe(first.parent);
  }, 60_000);

  it('keeps leading whitespace in the exact NUL-delimited changed path', async () => {
    await settle([task('a')]);
    const change = commit(' leading-registry.txt', 'pin=v1\n');
    await expect(integrateWorkflowLeadCommit(fixture.cwd, name,
      intent(change, { paths: ['leading-registry.txt'] }))).rejects.toThrow('workflow_lead_integration_changed_files_mismatch');
    expect(readWorkflow(fixture.cwd, name).integrationHead).toBe(change.parent);
  }, 60_000);

  it('refuses a dirty checkout, worker caller, and a check that changes refs', async () => {
    await settle([task('a')]);
    const dirty = commit();
    writeFileSync(join(fixture.cwd, 'README.md'), '# dirty\n');
    await expect(integrateWorkflowLeadCommit(fixture.cwd, name, intent(dirty))).rejects.toThrow('workflow_integration_worktree_dirty');
    fixture.git('restore', 'README.md');

    vi.stubEnv('OMC_TEAM_WORKER', 'task-a');
    await expect(integrateWorkflowLeadCommit(fixture.cwd, name, intent(dirty))).rejects.toThrow('workflow_lead_authority_required');
    vi.stubEnv('OMC_TEAM_WORKER', '');

    const refChanging = intent(dirty, { checks: [{ command: process.execPath, args: ['-e',
      "require('node:child_process').execFileSync('git',['tag','lead-check-mutated'])"] }] });
    await expect(integrateWorkflowLeadCommit(fixture.cwd, name, refChanging))
      .rejects.toThrow('workflow_lead_integration_repository_changed');
    expect(readWorkflow(fixture.cwd, name).integrationHead).toBe(dirty.parent);
  }, 60_000);

  it('refuses an unknown/concrete actor pair before recording evidence', async () => {
    await settle([task('a')]);
    const change = commit();
    await expect(integrateWorkflowLeadCommit(fixture.cwd, name, { ...intent(change), actor: { id: 'unknown', model: 'gpt-6' } }))
      .rejects.toThrow('workflow_invalid_lead_integration_actor');
  }, 60_000);
});
