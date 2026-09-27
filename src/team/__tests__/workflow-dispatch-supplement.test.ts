import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acceptWorkflowTask, finishWorkflow, initWorkflow, initWorkflowV2, readWorkflow, reviewWorkflow,
  runWorkflow, supplementWorkflowTask, verifyWorkflow, workflowStatus,
} from '../workflow.js';
import { parseWorkflowBinding, type WorkflowDispatchSupplementIntent, type WorkflowOptions,
  type WorkflowPlan, type WorkflowTask } from '../workflow-contracts.js';
import { buildWorkflowPrompt, workflowContextFingerprint, workflowPromptFingerprint,
  workflowSessionFingerprint } from '../workflow-prompt.js';
import { createWorkflowFixture } from './helpers/workflow-fixture.js';
import { binding, hash, runtimeFixture } from './helpers/workflow-v2-fixture.js';

const provider = fileURLToPath(new URL('./helpers/workflow-provider.cjs', import.meta.url));
const passingCheck = { command: process.execPath, args: ['-e', 'process.exit(0)'] };
const content = 'Use task-a\'s public parser and preserve its exact return values.';
const contentSha256 = createHash('sha256').update(content).digest('hex');

describe('lead-authorized dispatch supplements', () => {
  let fixture: ReturnType<typeof createWorkflowFixture>;
  const name = 'supplement';
  const options: WorkflowOptions = { mode: 'balanced', workers: 2, maxWorkers: 2, maxAttempts: 1,
    maxReviewPasses: 2, timeoutMs: 15_000, backoffMs: 0, glmCommand: provider, codexCommand: provider,
    glmModel: 'glm-test', codexModel: 'codex-test' };

  beforeEach(() => {
    fixture = createWorkflowFixture();
    vi.stubEnv('OMC_WORKFLOW_TEST_CONFIG', fixture.configPath);
    vi.stubEnv('OMC_STATE_DIR', '');
  });
  afterEach(() => { vi.unstubAllEnvs(); fixture.dispose(); });

  function task(id: string, dependencies: string[] = []): WorkflowTask {
    return { id, objective: `Implement ${id}`, baseCommit: fixture.baseCommit, writeScope: [`feature/${id}.txt`],
      readScope: ['README.md'], prohibitedScope: ['package.json'], dependencies, contracts: ['Preserve exact return values'],
      acceptanceCriteria: [`feature/${id}.txt exists`], tests: [passingCheck] };
  }
  function plan(tasks: WorkflowTask[]): WorkflowPlan {
    return { name, objective: 'Exercise one attributed clarification', baseCommit: fixture.baseCommit,
      integrationBranch: 'integration/supplement', tasks, verification: [passingCheck], sharedContext: 'Use accepted dependency APIs.' };
  }
  function intent(head: string, overrides: Partial<WorkflowDispatchSupplementIntent> = {}): WorkflowDispatchSupplementIntent {
    return { taskId: 'b', expectedInputHead: head, actor: { id: 'unknown', model: 'unknown' },
      authorityRef: 'issue-41', reason: 'Clarify the accepted dependency contract', content, contentSha256, ...overrides };
  }
  async function ready(tasks = [task('a'), task('b', ['a'])]) {
    await initWorkflow(fixture.cwd, plan(tasks), options);
    await runWorkflow(fixture.cwd, name);
    await acceptWorkflowTask(fixture.cwd, name, 'a');
    return readWorkflow(fixture.cwd, name).integrationHead;
  }

  it('delivers one exact receipt and keeps the dependent task pinned to its authorized input head', async () => {
    fixture.configure({ tasks: { b: { requiresFiles: ['feature/a.txt'] } } });
    const tasks = [task('a'), task('c'), task('b', ['a'])];
    await initWorkflow(fixture.cwd, plan(tasks), options);
    await runWorkflow(fixture.cwd, name);
    await acceptWorkflowTask(fixture.cwd, name, 'a');
    const inputHead = readWorkflow(fixture.cwd, name).integrationHead;
    const before = readWorkflow(fixture.cwd, name);
    const aPrompt = buildWorkflowPrompt(before, before.tasks[0]!, 'C:/synthetic/result.json');
    const aContext = workflowContextFingerprint(before, before.tasks[0]!);
    const aSession = workflowSessionFingerprint(before, before.tasks[0]!, provider, before.tasks[0]!.worktree!);

    const supplemented = await supplementWorkflowTask(fixture.cwd, name, intent(inputHead));
    const receipt = supplemented.dispatchSupplements![0]!;
    expect(receipt).toMatchObject({ sequence: 1, taskId: 'b', expectedInputHead: inputHead,
      orchestrationHost: 'claude', actor: { id: 'unknown', model: 'unknown' }, content, contentSha256 });
    expect(supplemented.tasks[2]!.task).toEqual(before.tasks[2]!.task);
    expect(supplemented.plan).toEqual(before.plan);
    expect(buildWorkflowPrompt(supplemented, supplemented.tasks[0]!, 'C:/synthetic/result.json')).toBe(aPrompt);
    expect(workflowContextFingerprint(supplemented, supplemented.tasks[0]!)).toBe(aContext);
    expect(workflowSessionFingerprint(supplemented, supplemented.tasks[0]!, provider, supplemented.tasks[0]!.worktree!)).toBe(aSession);

    await acceptWorkflowTask(fixture.cwd, name, 'c');
    expect(readWorkflow(fixture.cwd, name).integrationHead).not.toBe(inputHead);
    await runWorkflow(fixture.cwd, name);
    let state = readWorkflow(fixture.cwd, name);
    const dependent = state.tasks[2]!;
    const launch = fixture.events().find(event => event.event === 'start' && event.taskId === 'b')!;
    const prompt = JSON.parse(launch.prompt);
    expect(dependent.task.baseCommit).toBe(inputHead);
    expect(fixture.git('rev-parse', `${dependent.handoff!.commitSha}^`)).toBe(inputHead);
    expect(prompt.dispatchSupplement).toEqual(receipt);
    expect(prompt.dispatchSupplementPolicy).toContain('Preserve the original task contract');
    expect(prompt.task).toEqual(dependent.task);
    expect(dependent.invocations![0]!.promptFingerprint).toBe(workflowPromptFingerprint(launch.prompt));
    expect(dependent.invocations![0]!.contextFingerprint).toBe(workflowContextFingerprint(state, dependent));
    const status = workflowStatus(fixture.cwd, name);
    expect(status).toMatchObject({ dispatchSupplementCount: 1,
      dispatchSupplements: [expect.objectContaining({ taskId: 'b', contentSha256 })] });
    expect(JSON.stringify(status)).not.toContain(content);

    await acceptWorkflowTask(fixture.cwd, name, 'b');
    await verifyWorkflow(fixture.cwd, name);
    await reviewWorkflow(fixture.cwd, name);
    state = await finishWorkflow(fixture.cwd, name);
    expect(state.stage).toBe('complete');
  }, 60_000);

  it('refuses unsafe, stale, unauthorized, duplicate, or ineligible input before dispatch', async () => {
    const head = await ready([task('a'), task('b', ['a']), task('c')]);
    await expect(supplementWorkflowTask(fixture.cwd, name, intent(fixture.baseCommit)))
      .rejects.toThrow('workflow_dispatch_supplement_head_mismatch');
    await expect(supplementWorkflowTask(fixture.cwd, name, intent(head, { taskId: 'c' })))
      .rejects.toThrow('workflow_dispatch_supplement_unstarted_task_required');
    await expect(supplementWorkflowTask(fixture.cwd, name, intent(head, { actor: { id: 'lead', model: 'gpt-6' } })))
      .rejects.toThrow('workflow_dispatch_supplement_actor_mismatch');

    writeFileSync(`${fixture.cwd}/README.md`, '# dirty\n');
    await expect(supplementWorkflowTask(fixture.cwd, name, intent(head))).rejects.toThrow('workflow_integration_worktree_dirty');
    fixture.git('restore', 'README.md');
    vi.stubEnv('OMC_TEAM_WORKER', 'task-a');
    await expect(supplementWorkflowTask(fixture.cwd, name, intent(head))).rejects.toThrow('workflow_lead_authority_required');
    vi.stubEnv('OMC_TEAM_WORKER', '');

    vi.stubEnv('OMC_FIXTURE_API_TOKEN', 'synthetic-supplement-secret');
    const secret = 'Use synthetic-supplement-secret for access.';
    await expect(supplementWorkflowTask(fixture.cwd, name, intent(head, { content: secret,
      contentSha256: createHash('sha256').update(secret).digest('hex') }))).rejects.toThrow('workflow_sensitive_input_rejected');
    const oversized = '界'.repeat(2731);
    await expect(supplementWorkflowTask(fixture.cwd, name, intent(head, { content: oversized,
      contentSha256: createHash('sha256').update(oversized).digest('hex') }))).rejects.toThrow('workflow_dispatch_supplement_too_large');

    await supplementWorkflowTask(fixture.cwd, name, intent(head));
    await expect(supplementWorkflowTask(fixture.cwd, name, intent(head))).rejects.toThrow('workflow_dispatch_supplement_already_exists');
    expect(fixture.events().filter(event => event.event === 'start')).toHaveLength(2);
  }, 60_000);

  it('requires every dependency to be accepted before recording clarification', async () => {
    await initWorkflow(fixture.cwd, plan([task('a'), task('b', ['a'])]), options);
    await expect(supplementWorkflowTask(fixture.cwd, name, intent(fixture.baseCommit)))
      .rejects.toThrow('workflow_dependency_not_integrated');
    expect(readWorkflow(fixture.cwd, name).dispatchSupplements).toBeUndefined();
    expect(fixture.events()).toEqual([]);
  });

  it('records prompt evidence for a V2 implementer without session-resume capability', async () => {
    const configured = runtimeFixture(fixture);
    const selected = configured.selectedBinding('implementer', 'claude', 'actor-author');
    const profile = configured.profiles.get(selected.id)!;
    const evidence = JSON.parse(readFileSync(profile.capabilityEvidencePath, 'utf8'));
    evidence.capabilities = ['structured-handoff'];
    const evidenceBytes = JSON.stringify(evidence);
    writeFileSync(profile.capabilityEvidencePath, evidenceBytes);
    const implementer = parseWorkflowBinding({ ...selected, capabilities: ['structured-handoff'],
      capabilityEvidenceSha256: hash(evidenceBytes) });
    const lead = binding('lead', 'codex');
    await initWorkflowV2(fixture.cwd, plan([task('a'), task('b', ['a'])]), {
      lead, implementer, reviewer: configured.selectedBinding('reviewer', 'codex', 'actor-reviewer'),
    }, { workers: 1, maxWorkers: 1, maxAttempts: 1, maxReviewPasses: 1, timeoutMs: 15_000, backoffMs: 0 });
    await runWorkflow(fixture.cwd, name, configured.runtime);
    await acceptWorkflowTask(fixture.cwd, name, 'a');
    const head = readWorkflow(fixture.cwd, name).integrationHead;
    await supplementWorkflowTask(fixture.cwd, name, intent(head, { actor: { id: lead.id, model: lead.model } }));
    await runWorkflow(fixture.cwd, name, configured.runtime);
    const state = readWorkflow(fixture.cwd, name);
    const dependent = state.tasks[1]!;
    expect(dependent.session).toBeUndefined();
    expect(dependent.invocations![0]).toMatchObject({ promptFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      contextFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) });
    const events = readFileSync(fixture.eventsPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const launch = events.find(event => event.role === 'implementer' && event.request.task.id === 'b');
    expect(launch.args).not.toContain('--session-id');
    expect(launch.args).not.toContain('--resume');
    expect(launch.request.dispatchSupplement).toMatchObject({ taskId: 'b', expectedInputHead: head });
  }, 60_000);
});
