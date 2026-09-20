import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acceptWorkflowTask, finishWorkflow, initWorkflow, readWorkflow, resumeWorkflowTask,
  reviewWorkflow, runWorkflow, verifyWorkflow, workflowStatus,
} from '../workflow.js';
import type { WorkflowOptions, WorkflowPlan, WorkflowState, WorkflowTask } from '../workflow-contracts.js';
import { createWorkflowFixture } from './helpers/workflow-fixture.js';

const provider = fileURLToPath(new URL('./helpers/workflow-provider.cjs', import.meta.url));
const check = { command: process.execPath, args: ['-e', 'process.exit(0)'] };
const sharedContext = 'This repository preserves the public API and exact return values. Read the task contracts and run its checks.';

describe('balanced workflow with real repositories and provider processes', () => {
  let fixture: ReturnType<typeof createWorkflowFixture>;
  const name = 'balanced';
  const options: WorkflowOptions = {
    mode: 'balanced', workers: 2, maxWorkers: 2, maxAttempts: 2, maxReviewPasses: 2,
    timeoutMs: 15000, backoffMs: 1, glmCommand: provider, codexCommand: provider,
    glmModel: 'glm-test', codexModel: 'codex-test',
  };

  beforeEach(() => {
    fixture = createWorkflowFixture();
    vi.stubEnv('OMC_WORKFLOW_TEST_CONFIG', fixture.configPath);
    vi.stubEnv('OMC_STATE_DIR', '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    fixture.dispose();
  });

  function task(id: string, overrides: Partial<WorkflowTask> = {}): WorkflowTask {
    return {
      id, objective: `Implement ${id} without changing behavior outside its scope`, baseCommit: fixture.baseCommit,
      writeScope: [`feature/${id}.txt`], readScope: ['README.md'], prohibitedScope: ['package.json'],
      dependencies: [], contracts: ['Preserve the public API and exact return values.'],
      acceptanceCriteria: [`feature/${id}.txt exists and passes the declared check`], tests: [check], ...overrides,
    };
  }
  function plan(tasks = [task('a')], overrides: Partial<WorkflowPlan> = {}): WorkflowPlan {
    return { name, objective: 'Implement the feature safely', baseCommit: fixture.baseCommit,
      integrationBranch: 'integration/balanced', tasks, verification: [check], sharedContext, ...overrides };
  }
  function editState(change: (state: WorkflowState) => void) {
    const state = readWorkflow(fixture.cwd, name);
    if (state.schemaVersion !== 1) throw new Error('Expected the unchanged legacy workflow fixture');
    change(state);
    writeFileSync(String(workflowStatus(fixture.cwd, name).stateFile), JSON.stringify(state));
  }
  function workerGit(...args: string[]) {
    const worktree = readWorkflow(fixture.cwd, name).tasks[0]!.worktree!;
    return execFileSync('git', args, { cwd: worktree, encoding: 'utf8', stdio: 'pipe', windowsHide: true }).trim();
  }
  async function pauseTask(overrides: Partial<WorkflowOptions> = {}) {
    fixture.configure({ tasks: { a: { pauseBeforeWork: true } } });
    await initWorkflow(fixture.cwd, plan(), { ...options, timeoutMs: 2000, ...overrides });
    await runWorkflow(fixture.cwd, name);
    const entry = readWorkflow(fixture.cwd, name).tasks[0]!;
    expect(entry.status).toBe('failed');
    expect(entry.error).toBe('workflow_timeout');
    expect(entry.attempts).toBe(1);
    expect(entry.session?.confirmed).toBe(true);
    expect(workerGit('status', '--porcelain')).toBe('');
    expect(workerGit('rev-parse', 'HEAD')).toBe(fixture.baseCommit);
    fixture.configure({});
    return entry;
  }

  it('preserves the default V1 invocation arguments and completion gates', async () => {
    const original = plan();
    delete original.sharedContext;
    const defaults = { ...options };
    delete defaults.mode;
    await initWorkflow(fixture.cwd, original, defaults);
    await runWorkflow(fixture.cwd, name);
    await expect(finishWorkflow(fixture.cwd, name)).rejects.toThrow();
    await acceptWorkflowTask(fixture.cwd, name, 'a');
    await verifyWorkflow(fixture.cwd, name);
    await reviewWorkflow(fixture.cwd, name);
    await finishWorkflow(fixture.cwd, name);
    const [worker, reviewer] = fixture.events().filter(event => event.event === 'start');
    expect(worker!.args).toContain('-p');
    expect(worker!.args).not.toContain('--session-id');
    expect(worker!.args).not.toContain('--output-format');
    expect(worker!.args).not.toContain('--resume');
    expect(reviewer!.args).not.toContain('--json');
    expect(reviewer!.args).toContain('read-only');
    expect(readWorkflow(fixture.cwd, name).tasks[0]!.invocations).toEqual([
      expect.objectContaining({ attempt: 1, mode: 'fresh', orchestrationHost: 'claude', outcome: 'completed' }),
    ]);
  }, 20000);

  it('shares a stable instruction/context prefix while keeping complete contracts and separate task sessions', async () => {
    const tasks = [task('a'), task('b')];
    await initWorkflow(fixture.cwd, plan(tasks), options);
    await runWorkflow(fixture.cwd, name);
    const launches = fixture.events().filter(event => event.event === 'start');
    expect(launches).toHaveLength(2);
    const prefixes = launches.map(event => event.prompt.slice(0, event.prompt.indexOf('"task":')));
    expect(prefixes[0]).toBe(prefixes[1]);
    for (const event of launches) {
      const prompt = JSON.parse(event.prompt);
      expect(prompt.sharedContext).toBe(sharedContext);
      expect(prompt.task).toEqual(tasks.find(item => item.id === event.taskId));
      expect(event.args).toEqual(expect.arrayContaining(['--model', 'glm-test', '-p', '--output-format', 'stream-json', '--verbose', '--session-id']));
      expect(event.args).not.toContain('--resume');
    }
    const state = readWorkflow(fixture.cwd, name);
    expect(state.tasks.map(entry => entry.status)).toEqual(['completed', 'completed']);
    expect(new Set(state.tasks.map(entry => entry.session?.id)).size).toBe(2);
    expect(new Set(state.tasks.map(entry => entry.worktree)).size).toBe(2);
    expect(state.tasks.every(entry => entry.session?.confirmed)).toBe(true);
    expect(state.tasks.every(entry => entry.invocations?.length === 1)).toBe(true);
    expect(fixture.git('rev-parse', 'HEAD')).toBe(fixture.baseCommit);
  }, 20000);

  it('passes accepted dependency evidence to a fresh isolated task without dropping its full contract', async () => {
    fixture.configure({ tasks: { a: { summary: 'Accepted implementation detail. '.repeat(25), metadata: ['Keep exact return values.'] },
      b: { requiresFiles: ['feature/a.txt'] } } });
    await initWorkflow(fixture.cwd, plan([task('a'), task('b', { dependencies: ['a'] })]), options);
    await runWorkflow(fixture.cwd, name);
    expect(fixture.events().filter(event => event.event === 'start').map(event => event.taskId)).toEqual(['a']);
    await acceptWorkflowTask(fixture.cwd, name, 'a');
    await runWorkflow(fixture.cwd, name);
    const state = readWorkflow(fixture.cwd, name);
    const launched = fixture.events().find(event => event.event === 'start' && event.taskId === 'b')!;
    const prompt = JSON.parse(launched.prompt);
    expect(prompt.task).toEqual(state.tasks[1]!.task);
    expect(prompt.acceptedDependencies).toHaveLength(1);
    expect(prompt.acceptedDependencies[0]).toMatchObject({ taskId: 'a', commitSha: state.tasks[0]!.handoff!.commitSha, preview: true });
    expect(prompt.acceptedDependencies[0].summary).toContain('Accepted implementation detail.');
    expect(prompt.acceptedDependencies[0].artifacts.some((artifact: { path: string }) => artifact.path.endsWith('.result.json'))).toBe(true);
    expect(JSON.stringify(prompt.acceptedDependencies).length).toBeLessThan(6000);
    expect(state.tasks[1]!.session?.id).not.toBe(state.tasks[0]!.session?.id);
    expect(launched.args).not.toContain('--resume');
    expect(state.tasks[1]!.status).toBe('completed');
  }, 20000);

  it('records provider usage and a failed review without letting telemetry satisfy quality gates', async () => {
    await initWorkflow(fixture.cwd, plan(), options);
    await runWorkflow(fixture.cwd, name);
    await expect(reviewWorkflow(fixture.cwd, name)).rejects.toThrow();
    await acceptWorkflowTask(fixture.cwd, name, 'a');
    await verifyWorkflow(fixture.cwd, name);
    fixture.configure({ tasks: { review: { beforeWorkFailure: true } } });
    await expect(reviewWorkflow(fixture.cwd, name)).rejects.toThrow('workflow_review_process_failed');
    let state = readWorkflow(fixture.cwd, name);
    expect(state.tasks[0]!.invocations).toHaveLength(1);
    expect(state.tasks[0]!.invocations![0]!.outcome).toBe('completed');
    expect(state.tasks[0]!.invocations![0]!.telemetry).toMatchObject({ provider: 'glm', status: 'measured', scope: 'all-models',
      inputTokens: 220, outputTokens: 30, cacheReadTokens: 80, cacheWriteTokens: 20 });
    expect(state.reviewAttempts).toHaveLength(1);
    expect(state.reviewAttempts![0]!.outcome).toBe('failed');
    expect(state.reviewAttempts![0]!.telemetry).toMatchObject({ provider: 'codex', inputTokens: 150, outputTokens: 25, cacheReadTokens: 100 });
    expect(state.reviewPasses).toBe(1);
    await expect(finishWorkflow(fixture.cwd, name)).rejects.toThrow();
    fixture.configure({});
    await reviewWorkflow(fixture.cwd, name);
    await finishWorkflow(fixture.cwd, name);
    state = readWorkflow(fixture.cwd, name);
    expect(state.reviewAttempts?.map(attempt => attempt.outcome)).toEqual(['failed', 'completed']);
    expect(state.reviews).toHaveLength(1);
    expect(state.stage).toBe('complete');
    expect(fixture.events().filter(event => event.event === 'start' && event.role === 'codex')
      .every(event => event.args.includes('--json') && event.args.includes('read-only') && event.args.includes('codex-test'))).toBe(true);
    expect(JSON.stringify(workflowStatus(fixture.cwd, name)).length).toBeLessThanOrEqual(16 * 1024);
  }, 20000);

  it('explicitly resumes only the confirmed original task and still requires acceptance, checks and review', async () => {
    const paused = await pauseTask();
    await runWorkflow(fixture.cwd, name);
    expect(fixture.events().filter(event => event.event === 'start')).toHaveLength(1);
    await resumeWorkflowTask(fixture.cwd, name, 'a', fixture.baseCommit, 'Retry after the provider timeout was resolved.');
    const state = readWorkflow(fixture.cwd, name);
    const resumed = state.tasks[0]!;
    expect(resumed.status).toBe('completed');
    expect(resumed.attempts).toBe(2);
    expect(resumed.worktree).toBe(paused.worktree);
    expect(resumed.branch).toBe(paused.branch);
    expect(resumed.session?.id).toBe(paused.session?.id);
    expect(resumed.invocations?.map(attempt => [attempt.mode, attempt.outcome])).toEqual([['fresh', 'failed'], ['resume', 'completed']]);
    const launches = fixture.events().filter(event => event.event === 'start');
    expect(launches[1]!.args).toContain('--resume');
    expect(launches[1]!.args[launches[1]!.args.indexOf('--resume') + 1]).toBe(paused.session?.id);
    expect(launches[1]!.args).not.toContain('--session-id');
    expect(JSON.parse(launches[1]!.prompt).task).toEqual(JSON.parse(launches[0]!.prompt).task);
    expect(fixture.git('rev-parse', 'HEAD')).toBe(fixture.baseCommit);
    await expect(finishWorkflow(fixture.cwd, name)).rejects.toThrow();
    await acceptWorkflowTask(fixture.cwd, name, 'a');
    await verifyWorkflow(fixture.cwd, name);
    await reviewWorkflow(fixture.cwd, name);
    await finishWorkflow(fixture.cwd, name);
    expect(readFileSync(join(fixture.cwd, 'feature/a.txt'), 'utf8')).toBe('a\n');
  }, 20000);

  it.each(['expected-head', 'dirty-worker', 'worker-branch', 'worker-head', 'lead-head', 'task-contract', 'shared-context', 'model', 'command', 'worker-authority', 'budget'])(
    'rejects resume after %s changes before starting another provider process', async boundary => {
      await pauseTask(boundary === 'budget' ? { maxAttempts: 1 } : {});
      let expectedHead = fixture.baseCommit;
      switch (boundary) {
        case 'expected-head': expectedHead = 'f'.repeat(40); break;
        case 'dirty-worker': writeFileSync(join(readWorkflow(fixture.cwd, name).tasks[0]!.worktree!, 'user-work.txt'), 'Preserve user work.'); break;
        case 'worker-branch': workerGit('switch', '-c', 'different-worker-branch'); break;
        case 'worker-head': workerGit('commit', '--allow-empty', '-m', 'Manual worker commit'); break;
        case 'lead-head': fixture.git('commit', '--allow-empty', '-m', 'Manual lead commit'); break;
        case 'task-contract': editState(state => { state.tasks[0]!.task.contracts.push('New requirement after the first invocation.'); }); break;
        case 'shared-context': editState(state => { state.plan.sharedContext = 'Changed architecture after the first invocation.'; }); break;
        case 'model': editState(state => { state.options.glmModel = 'different-model'; }); break;
        case 'command': editState(state => { state.options.glmCommand = process.execPath; }); break;
        case 'worker-authority': vi.stubEnv('OMC_TEAM_WORKER', 'balanced/task-a'); break;
      }
      await expect(resumeWorkflowTask(fixture.cwd, name, 'a', expectedHead, 'Attempt a continuation.')).rejects.toThrow();
      expect(fixture.events().filter(event => event.event === 'start')).toHaveLength(1);
      expect(readWorkflow(fixture.cwd, name).tasks[0]!.attempts).toBe(1);
      if (boundary === 'dirty-worker') expect(readFileSync(join(readWorkflow(fixture.cwd, name).tasks[0]!.worktree!, 'user-work.txt'), 'utf8')).toBe('Preserve user work.');
    }, 15000,
  );

  it('does not silently start a fresh session when an explicit resume fails', async () => {
    await pauseTask({ maxAttempts: 5 });
    fixture.configure({ tasks: { a: { beforeWorkFailure: true } } });
    await resumeWorkflowTask(fixture.cwd, name, 'a', fixture.baseCommit, 'Retry the same session.');
    const state = readWorkflow(fixture.cwd, name);
    expect(state.tasks[0]!.status).toBe('failed');
    expect(state.tasks[0]!.attempts).toBe(2);
    expect(fixture.events().filter(event => event.event === 'start')).toHaveLength(2);
    expect(state.tasks[0]!.invocations?.map(attempt => attempt.mode)).toEqual(['fresh', 'resume']);
    fixture.configure({});
    await runWorkflow(fixture.cwd, name);
    expect(fixture.events().filter(event => event.event === 'start')).toHaveLength(2);
    expect(readWorkflow(fixture.cwd, name).tasks[0]!.attempts).toBe(2);
  }, 15000);

  it('refuses reuse when the provider never confirms the requested session', async () => {
    fixture.configure({ tasks: { a: { pauseBeforeWork: true, omitSession: true } } });
    await initWorkflow(fixture.cwd, plan(), { ...options, timeoutMs: 2000 });
    await runWorkflow(fixture.cwd, name);
    expect(readWorkflow(fixture.cwd, name).tasks[0]!.session?.confirmed).not.toBe(true);
    await expect(resumeWorkflowTask(fixture.cwd, name, 'a', fixture.baseCommit, 'Retry with an unconfirmed session.')).rejects.toThrow();
    expect(fixture.events().filter(event => event.event === 'start')).toHaveLength(1);
  }, 15000);

  it('keeps successful work usable when the provider omits usage instead of reporting zero tokens', async () => {
    fixture.configure({ tasks: { a: { omitUsage: true } } });
    await initWorkflow(fixture.cwd, plan(), options);
    await runWorkflow(fixture.cwd, name);
    const entry = readWorkflow(fixture.cwd, name).tasks[0]!;
    expect(entry.status).toBe('completed');
    expect(entry.invocations![0]!.telemetry).toMatchObject({ status: 'unknown', terminal: 'success' });
    expect(entry.invocations![0]!.telemetry.inputTokens).toBeUndefined();
    expect(entry.invocations![0]!.telemetry.cacheReadTokens).toBeUndefined();
  }, 15000);

  it('preserves failed work and refuses reuse when the provider reports a different session', async () => {
    fixture.configure({ tasks: { a: { sessionId: '784bedf0-cfae-47d9-8440-5b31f5de7e3c' } } });
    await initWorkflow(fixture.cwd, plan(), options);
    await runWorkflow(fixture.cwd, name);
    const entry = readWorkflow(fixture.cwd, name).tasks[0]!;
    expect(entry.status).toBe('failed');
    expect(entry.error).toBe('workflow_session_identity_mismatch');
    expect(entry.session?.confirmed).toBe(false);
    expect(workerGit('rev-parse', 'HEAD')).not.toBe(fixture.baseCommit);
    await expect(resumeWorkflowTask(fixture.cwd, name, 'a', fixture.baseCommit, 'Try the mismatched session.')).rejects.toThrow();
    expect(fixture.events().filter(event => event.event === 'start')).toHaveLength(1);
    expect(readFileSync(join(entry.worktree!, 'feature/a.txt'), 'utf8')).toBe('a\n');
  }, 15000);

  it('refuses reuse when an accepted prerequisite has been revoked', async () => {
    fixture.configure({ tasks: { b: { pauseBeforeWork: true } } });
    await initWorkflow(fixture.cwd, plan([task('a'), task('b', { dependencies: ['a'] })]), options);
    await runWorkflow(fixture.cwd, name);
    await acceptWorkflowTask(fixture.cwd, name, 'a');
    editState(state => { state.options.timeoutMs = 2000; });
    await runWorkflow(fixture.cwd, name);
    expect(readWorkflow(fixture.cwd, name).tasks[1]!.session?.confirmed).toBe(true);
    editState(state => { state.tasks[0]!.status = 'rejected'; });
    fixture.configure({});
    await expect(resumeWorkflowTask(fixture.cwd, name, 'b', fixture.git('rev-parse', 'HEAD'), 'Retry after prerequisite revocation.')).rejects.toThrow();
    expect(fixture.events().filter(event => event.event === 'start')).toHaveLength(2);
    expect(readWorkflow(fixture.cwd, name).tasks[1]!.attempts).toBe(1);
  }, 20000);

  it('refuses reuse after the provider route changes while preserving the original session record', async () => {
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://first.example.invalid');
    const original = await pauseTask();
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://second.example.invalid');
    await expect(resumeWorkflowTask(fixture.cwd, name, 'a', fixture.baseCommit, 'Retry against another provider route.'))
      .rejects.toThrow('workflow_session_identity_changed');
    expect(readWorkflow(fixture.cwd, name).tasks[0]!.session).toEqual(original.session);
    expect(fixture.events().filter(event => event.event === 'start')).toHaveLength(1);
  }, 15000);

  it('refuses reuse after the wrapper changes at the same command path', async () => {
    const copiedProvider = join(fixture.root, 'provider.cjs');
    const source = readFileSync(provider, 'utf8');
    writeFileSync(copiedProvider, source);
    await pauseTask({ glmCommand: copiedProvider });
    writeFileSync(copiedProvider, `${source}\n// Changed wrapper configuration.\n`);
    await expect(resumeWorkflowTask(fixture.cwd, name, 'a', fixture.baseCommit, 'Retry through the modified wrapper.'))
      .rejects.toThrow('workflow_session_identity_changed');
    expect(fixture.events().filter(event => event.event === 'start')).toHaveLength(1);
  }, 15000);

  it('persists only an explicit supervised policy and refuses a malformed saved value before any launch', async () => {
    await initWorkflow(fixture.cwd, plan(), options);
    expect(readWorkflow(fixture.cwd, name).options).not.toHaveProperty('providerPolicy');
    expect(workflowStatus(fixture.cwd, name).providerPolicy).toBe('legacy');
    const path = String(workflowStatus(fixture.cwd, name).stateFile);
    const tampered = JSON.parse(readFileSync(path, 'utf8'));
    tampered.options.providerPolicy = 'unsupervised';
    writeFileSync(path, JSON.stringify(tampered));
    await expect(runWorkflow(fixture.cwd, name)).rejects.toThrow('workflow_invalid_policy');
    expect(() => readWorkflow(fixture.cwd, name)).toThrow('workflow_invalid_policy');
    expect(fixture.events()).toEqual([]);
  });

  it('persists and reports the supervised policy that initialization selected', async () => {
    await initWorkflow(fixture.cwd, plan(), { ...options, providerPolicy: 'supervised' });
    expect(readWorkflow(fixture.cwd, name).options).toMatchObject({ providerPolicy: 'supervised', timeoutMs: 15000 });
    expect(workflowStatus(fixture.cwd, name)).toMatchObject({ providerPolicy: 'supervised', mode: 'balanced', stage: 'implementation' });
  });

  it.each([null, true, 0, [], {}, 'legacy', 'Supervised', ' supervised'])(
    'refuses the unsupported initialization policy %j before creating state or a branch', async policy => {
      await expect(initWorkflow(fixture.cwd, plan(), { ...options, providerPolicy: policy as 'supervised' }))
        .rejects.toThrow('workflow_invalid_policy');
      expect(fixture.events()).toEqual([]);
      expect(existsSync(join(fixture.cwd, '.omc/state/team', name))).toBe(false);
      expect(fixture.git('branch', '--show-current')).toBe('main');
    });

  it('keeps a worker-declared check finite under supervised policy instead of removing its bound', async () => {
    const slow = { command: process.execPath, args: ['-e', 'setTimeout(() => {}, 6000)'] };
    await initWorkflow(fixture.cwd, plan([task('a', { tests: [slow] })]),
      { ...options, timeoutMs: 900, maxAttempts: 1, providerPolicy: 'supervised' });
    const started = Date.now();
    await runWorkflow(fixture.cwd, name);
    const elapsed = Date.now() - started;
    const failed = readWorkflow(fixture.cwd, name).tasks[0]!;
    expect(failed).toMatchObject({ status: 'failed', error: 'workflow_worker_test_failed', attempts: 1 });
    // The provider claimed the checks passed; only the controller's own finite run can fail them.
    expect(failed.handoff?.tests.every(test => test.passed)).toBe(true);
    // The declared check sleeps for six seconds, so only a bounded local run can finish this quickly.
    expect(elapsed).toBeLessThan(5000);
  }, 30000);

  it('keeps integrated verification finite under supervised policy instead of removing its bound', async () => {
    const slow = { command: process.execPath, args: ['-e', 'setTimeout(() => {}, 6000)'] };
    await initWorkflow(fixture.cwd, plan(undefined, { verification: [slow] }),
      { ...options, timeoutMs: 900, maxAttempts: 1, providerPolicy: 'supervised' });
    await runWorkflow(fixture.cwd, name);
    await acceptWorkflowTask(fixture.cwd, name, 'a');
    const started = Date.now();
    await verifyWorkflow(fixture.cwd, name);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(readWorkflow(fixture.cwd, name).verification?.passed).toBe(false);
  }, 30000);

  it('does not dispatch a second provider attempt for output_incomplete while an attempt remains', async () => {
    fixture.configure({ tasks: { a: { outputIncomplete: true } } });
    await initWorkflow(fixture.cwd, plan(), { ...options, timeoutMs: 2000, maxAttempts: 3, providerPolicy: 'supervised' });
    await runWorkflow(fixture.cwd, name);
    const failed = readWorkflow(fixture.cwd, name).tasks[0]!;
    expect(failed).toMatchObject({ status: 'failed', error: 'workflow_output_incomplete', attempts: 1 });
    expect(failed.invocations).toHaveLength(1);
    expect(failed.invocations?.[0]).toMatchObject({ outcome: 'failed', error: 'workflow_output_incomplete' });
    expect(fixture.events().filter(event => event.event === 'start')).toHaveLength(1);
    expect(workerGit('rev-parse', 'HEAD')).toBe(fixture.baseCommit);
    // The original attempt and its process artifacts remain inspectable.
    expect(failed.handoff?.artifacts.map(artifact => artifact.kind).sort()).toEqual(['workflow-stderr', 'workflow-stdout']);
    for (const artifact of failed.handoff!.artifacts) expect(existsSync(artifact.path)).toBe(true);
    await runWorkflow(fixture.cwd, name);
    expect(fixture.events().filter(event => event.event === 'start')).toHaveLength(1);
    expect(readWorkflow(fixture.cwd, name).tasks[0]!.attempts).toBe(1);
  }, 30000);

  it('requires inspection of another retained running worker before resuming failed work', async () => {
    fixture.configure({ tasks: { a: { pauseBeforeWork: true } } });
    await initWorkflow(fixture.cwd, plan([task('a'), task('b')]), { ...options, timeoutMs: 2000 });
    await runWorkflow(fixture.cwd, name);
    expect(readWorkflow(fixture.cwd, name).tasks[0]!.session?.confirmed).toBe(true);
    editState(state => { state.tasks[1]!.status = 'running'; });
    fixture.configure({});
    await expect(resumeWorkflowTask(fixture.cwd, name, 'a', fixture.baseCommit, 'Retry while another worker needs inspection.'))
      .rejects.toThrow('workflow_interrupted_worker_requires_inspection');
    expect(fixture.events().filter(event => event.event === 'start')).toHaveLength(2);
    expect(readWorkflow(fixture.cwd, name).tasks[0]!.attempts).toBe(1);
  }, 15000);
});
