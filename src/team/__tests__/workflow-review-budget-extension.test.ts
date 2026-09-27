import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withOrchestratorOperation } from '../../orchestration/selection.js';
import {
  acceptWorkflowTask, extendWorkflowReviewBudget, finishWorkflow, initWorkflow, initWorkflowV2, integrateWorkflowLeadCommit,
  readWorkflow, reviewWorkflow, runWorkflow, verifyWorkflow, workflowStatus,
} from '../workflow.js';
import type { WorkflowOptions, WorkflowPlan, WorkflowReviewBudgetExtensionIntent, WorkflowTask } from '../workflow-contracts.js';
import { createWorkflowFixture } from './helpers/workflow-fixture.js';
import { binding } from './helpers/workflow-v2-fixture.js';

const provider = fileURLToPath(new URL('./helpers/workflow-provider.cjs', import.meta.url));
const passingCheck = { command: process.execPath, args: ['-e', 'process.exit(0)'] };

describe('attributed review-budget extensions', () => {
  let fixture: ReturnType<typeof createWorkflowFixture>;
  const name = 'review-budget';
  const options: WorkflowOptions = { workers: 1, maxWorkers: 1, maxAttempts: 1, maxReviewPasses: 1,
    timeoutMs: 15_000, backoffMs: 0, glmCommand: provider, codexCommand: provider };

  beforeEach(() => {
    fixture = createWorkflowFixture();
    vi.stubEnv('OMC_WORKFLOW_TEST_CONFIG', fixture.configPath);
    vi.stubEnv('OMC_STATE_DIR', '');
  });
  afterEach(() => { vi.unstubAllEnvs(); fixture.dispose(); });

  function task(): WorkflowTask {
    return { id: 'a', objective: 'Implement a', baseCommit: fixture.baseCommit, writeScope: ['feature/a.txt'],
      readScope: ['README.md'], prohibitedScope: ['package.json'], dependencies: [], contracts: [],
      acceptanceCriteria: ['feature/a.txt exists'], tests: [passingCheck] };
  }
  function plan(): WorkflowPlan {
    return { name, objective: 'Exercise an authorized review extension', baseCommit: fixture.baseCommit,
      integrationBranch: 'integration/review-budget', tasks: [task()], verification: [passingCheck] };
  }
  function intent(head: string, overrides: Partial<WorkflowReviewBudgetExtensionIntent> = {}): WorkflowReviewBudgetExtensionIntent {
    return { requestId: 'review-budget-2', expectedHead: head, expectedCeiling: 1, increment: 1,
      actor: { id: 'claude-lead', model: 'claude-fable-5' }, authorityRef: 'issue-44',
      reason: 'Authorize one additional correction cycle', ...overrides };
  }
  async function exhaust() {
    await initWorkflow(fixture.cwd, plan(), options);
    await runWorkflow(fixture.cwd, name);
    await acceptWorkflowTask(fixture.cwd, name, 'a');
    await verifyWorkflow(fixture.cwd, name);
    await reviewWorkflow(fixture.cwd, name);
    return readWorkflow(fixture.cwd, name).integrationHead;
  }

  it('appends one receipt, keeps exact replay idempotent, and enables review and lead integration up to the new ceiling', async () => {
    const head = await exhaust();
    const launches = fixture.events().filter(event => event.event === 'start').length;
    const extended = await extendWorkflowReviewBudget(fixture.cwd, name, intent(head));
    expect(extended.options.maxReviewPasses).toBe(1);
    expect(extended.reviewPasses).toBe(1);
    expect(extended.reviewBudgetExtensions).toEqual([expect.objectContaining({ sequence: 1, requestId: 'review-budget-2',
      oldCeiling: 1, newCeiling: 2, head, orchestrationHost: 'claude',
      actor: { id: 'claude-lead', model: 'claude-fable-5' } })]);
    expect(fixture.events().filter(event => event.event === 'start')).toHaveLength(launches);
    expect(workflowStatus(fixture.cwd, name)).toMatchObject({ reviewPasses: 1, initialMaxReviewPasses: 1,
      maxReviewPasses: 2, reviewBudgetExtensionCount: 1,
      reviewBudgetExtensions: [expect.objectContaining({ requestId: 'review-budget-2', oldCeiling: 1, newCeiling: 2 })] });

    const replayed = await extendWorkflowReviewBudget(fixture.cwd, name, intent(head));
    expect(replayed).toEqual(extended);
    await expect(extendWorkflowReviewBudget(fixture.cwd, name, intent(head, { reason: 'Different authority decision' })))
      .rejects.toThrow('workflow_review_budget_extension_request_conflict');
    await expect(extendWorkflowReviewBudget(fixture.cwd, name, intent(head, { requestId: 'stale-request' })))
      .rejects.toThrow('workflow_review_budget_extension_stale');

    const parent = fixture.git('rev-parse', 'HEAD');
    mkdirSync(join(fixture.cwd, 'registry'), { recursive: true });
    writeFileSync(join(fixture.cwd, 'registry/pins.txt'), 'pin=v2\n');
    fixture.git('add', '--', 'registry/pins.txt');
    fixture.git('commit', '-m', 'Pin reviewed integration');
    const integratedHead = fixture.git('rev-parse', 'HEAD');
    await integrateWorkflowLeadCommit(fixture.cwd, name, { expectedParent: parent, expectedHead: integratedHead,
      actor: { id: 'unknown', model: 'unknown' }, authorityRef: 'issue-44-follow-up',
      reason: 'Apply the approved correction', paths: ['registry/pins.txt'], checks: [passingCheck] });
    await verifyWorkflow(fixture.cwd, name);
    const reviewed = await reviewWorkflow(fixture.cwd, name);
    expect(reviewed.reviewPasses).toBe(2);
    await expect(reviewWorkflow(fixture.cwd, name)).rejects.toThrow('workflow_review_limit_reached');
    const completed = await finishWorkflow(fixture.cwd, name);
    expect((await extendWorkflowReviewBudget(fixture.cwd, name, intent(head))).stage).toBe('complete');
    expect(readWorkflow(fixture.cwd, name)).toEqual(completed);
  }, 60_000);

  it('requires exhaustion, a clean current head, lead authority, and the selected V2 lead actor', async () => {
    await initWorkflow(fixture.cwd, plan(), options);
    const head = readWorkflow(fixture.cwd, name).integrationHead;
    await expect(extendWorkflowReviewBudget(fixture.cwd, name, intent(head))).rejects.toThrow('workflow_review_budget_not_exhausted');
    await expect(extendWorkflowReviewBudget(fixture.cwd, name, intent(head, {
      actor: { id: 'lead-codex', model: 'gpt-6-astra' },
    }))).rejects.toThrow('workflow_review_budget_not_exhausted');

    writeFileSync(join(fixture.cwd, 'README.md'), '# dirty\n');
    await expect(extendWorkflowReviewBudget(fixture.cwd, name, intent(head))).rejects.toThrow('workflow_integration_worktree_dirty');
    fixture.git('restore', 'README.md');
    vi.stubEnv('OMC_TEAM_WORKER', 'task-a');
    await expect(extendWorkflowReviewBudget(fixture.cwd, name, intent(head))).rejects.toThrow('workflow_lead_authority_required');
    vi.stubEnv('OMC_TEAM_WORKER', '');

    fixture.dispose();
    fixture = createWorkflowFixture();
    vi.stubEnv('OMC_WORKFLOW_TEST_CONFIG', fixture.configPath);
    await initWorkflowV2(fixture.cwd, plan(), {
      lead: binding('lead', 'codex'), implementer: binding('implementer', 'claude'), reviewer: binding('reviewer', 'codex'),
    }, options);
    const v2Head = readWorkflow(fixture.cwd, name).integrationHead;
    await expect(extendWorkflowReviewBudget(fixture.cwd, name, intent(v2Head, {
      actor: { id: 'other-lead', model: 'gpt-6-astra' },
    }))).rejects.toThrow('workflow_review_budget_extension_actor_mismatch');
    await expect(extendWorkflowReviewBudget(fixture.cwd, name, intent(v2Head, {
      actor: { id: 'lead-codex', model: 'gpt-6-astra' },
    }))).rejects.toThrow('workflow_review_budget_not_exhausted');
  }, 60_000);

  it('rejects a concurrent controller operation before changing the ledger', async () => {
    const head = await exhaust();
    let enter!: () => void;
    let leave!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const blocked = new Promise<void>(resolve => { leave = resolve; });
    const operation = withOrchestratorOperation(fixture.cwd, async () => { enter(); await blocked; });
    await entered;
    await expect(extendWorkflowReviewBudget(fixture.cwd, name, intent(head))).rejects.toThrow('orchestrator_operation_locked');
    expect(readWorkflow(fixture.cwd, name).reviewBudgetExtensions).toBeUndefined();
    leave();
    await operation;
  }, 60_000);
});
