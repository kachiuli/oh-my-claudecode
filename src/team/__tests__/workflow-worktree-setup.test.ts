import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorkflowFixture } from './helpers/workflow-fixture.js';
import { binding, runtimeFixture } from './helpers/workflow-v2-fixture.js';

const injected = vi.hoisted(() => ({ fail: false, stderr: '', message: '', code: '', calls: 0 }));
vi.mock('../git-worktree.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../git-worktree.js')>();
  return { ...actual, ensureWorkerWorktree: (...args: Parameters<typeof actual.ensureWorkerWorktree>) => {
    injected.calls++;
    if (injected.fail) throw Object.assign(new Error(injected.message), { stderr: Buffer.from(injected.stderr),
      ...(injected.code ? { code: injected.code } : {}) });
    return actual.ensureWorkerWorktree(...args);
  } };
});

import { getBranchName, getWorktreePath } from '../git-worktree.js';
import { acceptWorkflowTask, initWorkflowV2, readWorkflow, resumeWorkflowTask, runWorkflow, workflowStatus } from '../workflow.js';

const check = { command: process.execPath, args: ['-e', 'process.exit(0)'] };

describe('workflow worktree setup accounting', () => {
  let fixture: ReturnType<typeof createWorkflowFixture>;
  beforeEach(() => {
    fixture = createWorkflowFixture();
    injected.fail = false; injected.stderr = ''; injected.message = ''; injected.code = ''; injected.calls = 0;
    vi.stubEnv('OMC_STATE_DIR', '');
  });
  afterEach(() => { vi.unstubAllEnvs(); fixture.dispose(); });

  function workflowTask(id: string, baseCommit = fixture.baseCommit, dependencies: string[] = []) {
    return { id, objective: 'Exercise worktree setup', baseCommit, writeScope: [`feature/${id}.txt`],
      readScope: ['README.md'], prohibitedScope: [], dependencies, contracts: ['Provider starts only after setup'],
      acceptanceCriteria: ['Provider attempt accounting stays exact'], tests: [check] };
  }
  async function initialize(name: string, baseCommit = fixture.baseCommit, maxAttempts = 1) {
    const configured = runtimeFixture(fixture);
    const task = workflowTask('a', baseCommit);
    await initWorkflowV2(fixture.cwd, { name, objective: 'Exercise worktree setup recovery', baseCommit,
      integrationBranch: `integration/${name}`, tasks: [task], verification: [check] }, {
      lead: binding('lead', 'codex'), implementer: configured.selectedBinding('implementer', 'glm', 'actor-author'),
      reviewer: configured.selectedBinding('reviewer', 'codex', 'actor-reviewer'),
    }, { mode: 'balanced', workers: 1, maxWorkers: 1, maxAttempts, maxReviewPasses: 1, timeoutMs: 15_000, backoffMs: 0 });
    return configured;
  }

  it('records an injected pre-provider failure and explicitly retries the retained branch without spending an attempt', async () => {
    const name = 'setup-retry';
    const configured = await initialize(name);
    const branch = getBranchName(name, 'task-a');
    fixture.git('branch', branch, fixture.baseCommit);
    const secret = 'synthetic-private-glm-sentinel';
    injected.fail = true;
    injected.message = `Command failed: git worktree add --token ${secret} ${fixture.cwd}`;
    injected.stderr = `fatal: unable to create ${fixture.cwd}\\private-file: token=${secret}\nFilename too long\n`;

    await runWorkflow(fixture.cwd, name, configured.runtime);
    const failed = readWorkflow(fixture.cwd, name).tasks[0]!;
    expect(failed).toMatchObject({ status: 'failed', error: 'workflow_worktree_setup_failed', attempts: 0,
      setupAttempts: [{ sequence: 1, outcome: 'failed', error: 'workflow_worktree_setup_failed' }] });
    expect(failed.invocations).toBeUndefined();
    expect(failed.claimToken).toBeUndefined();
    expect(failed.session).toBeUndefined();
    expect(failed.worktree).toBeUndefined();
    expect(readFileSync(fixture.eventsPath, 'utf8')).toBe('');
    expect(fixture.git('rev-parse', branch)).toBe(fixture.baseCommit);
    expect(fixture.git('worktree', 'list', '--porcelain')).not.toContain(`branch refs/heads/${branch}`);
    const artifact = failed.setupAttempts![0]!.artifact!;
    const diagnostic = readFileSync(artifact.path, 'utf8');
    expect(artifact.kind).toBe('workflow-worktree-setup');
    expect(diagnostic).toContain('Filename too long');
    expect(diagnostic).toContain('[REDACTED]');
    expect(diagnostic).toContain('[PATH]');
    expect(diagnostic).not.toContain(secret);
    expect(diagnostic).not.toContain('worktree add');
    expect(diagnostic).not.toContain(fixture.cwd);
    expect(diagnostic.length).toBeLessThanOrEqual(4097);
    expect(workflowStatus(fixture.cwd, name).tasks).toEqual([expect.objectContaining({ attempts: 0, setupAttempts: 1,
      setup: expect.objectContaining({ sequence: 1, outcome: 'failed', error: 'workflow_worktree_setup_failed' }) })]);

    injected.fail = false;
    await runWorkflow(fixture.cwd, name, configured.runtime);
    const completed = readWorkflow(fixture.cwd, name).tasks[0]!;
    expect(completed.status).toBe('completed');
    expect(completed.attempts).toBe(1);
    expect(completed.invocations).toHaveLength(1);
    expect(completed.setupAttempts?.map(entry => entry.outcome)).toEqual(['failed', 'completed']);
    expect(completed.setupAttempts?.[0]?.artifact).toEqual(artifact);
    expect(readFileSync(fixture.eventsPath, 'utf8').split(/\r?\n/).filter(Boolean)
      .filter(line => JSON.parse(line).event === 'start')).toHaveLength(1);
    expect(existsSync(getWorktreePath(fixture.cwd, name, 'task-a'))).toBe(true);
  }, 60_000);

  it('reports an allowlisted no-stderr refusal without retaining the raw error message', async () => {
    const name = 'setup-coded-refusal';
    const configured = await initialize(name);
    const secret = 'synthetic-command-secret';
    injected.fail = true; injected.code = 'worktree_branch_mismatch'; injected.stderr = '';
    injected.message = `git worktree add ${fixture.cwd} --token=${secret}`;

    await runWorkflow(fixture.cwd, name, configured.runtime);
    const failed = readWorkflow(fixture.cwd, name).tasks[0]!;
    const artifactPath = failed.setupAttempts![0]!.artifact!.path;
    expect(failed.setupAttempts![0]).toMatchObject({ detail: 'worktree_branch_mismatch' });
    expect(readFileSync(artifactPath, 'utf8')).toBe('worktree_branch_mismatch\n');
    expect(readFileSync(artifactPath, 'utf8')).not.toContain(secret);
    expect(workflowStatus(fixture.cwd, name).tasks).toEqual([expect.objectContaining({ setup: expect.objectContaining({
      detail: 'worktree_branch_mismatch', artifactPath,
    }) })]);
  }, 60_000);

  it('keeps a failed resume setup explicit until the operator retries the resume', async () => {
    const name = 'resume-setup-retry';
    const configured = await initialize(name, fixture.baseCommit, 2);
    fixture.configure({ tasks: { a: { failBeforeWork: true } } });
    await runWorkflow(fixture.cwd, name, configured.runtime);
    const initial = readWorkflow(fixture.cwd, name).tasks[0]!;
    expect(initial).toMatchObject({ status: 'failed', attempts: 1, session: { confirmed: true } });
    expect(initial.invocations).toHaveLength(1);
    const settledInvocation = structuredClone(initial.invocations![0]!);

    injected.fail = true; injected.code = 'worktree_branch_in_use';
    await resumeWorkflowTask(fixture.cwd, name, 'a', fixture.baseCommit,
      'Retry the confirmed session after inspection.', configured.runtime);
    const setupFailed = readWorkflow(fixture.cwd, name).tasks[0]!;
    expect(setupFailed).toMatchObject({ status: 'failed', attempts: 1,
      setupAttempts: [expect.objectContaining({ mode: 'fresh', outcome: 'completed' }),
        expect.objectContaining({ mode: 'resume', outcome: 'failed' })] });
    expect(setupFailed.invocations).toEqual([settledInvocation]);
    expect(readFileSync(fixture.eventsPath, 'utf8').split(/\r?\n/).filter(Boolean)
      .filter(line => JSON.parse(line).event === 'start')).toHaveLength(1);

    injected.fail = false; injected.code = ''; fixture.configure({});
    await runWorkflow(fixture.cwd, name, configured.runtime);
    expect(readWorkflow(fixture.cwd, name).tasks[0]).toMatchObject({ status: 'failed', attempts: 1 });
    expect(readWorkflow(fixture.cwd, name).tasks[0]!.invocations).toHaveLength(1);

    await resumeWorkflowTask(fixture.cwd, name, 'a', fixture.baseCommit,
      'Retry the confirmed session after repairing setup.', configured.runtime);
    const completed = readWorkflow(fixture.cwd, name).tasks[0]!;
    expect(completed).toMatchObject({ status: 'completed', attempts: 2 });
    expect(completed.invocations?.map(entry => entry.mode)).toEqual(['fresh', 'resume']);
    expect(completed.setupAttempts?.at(-1)).toMatchObject({ mode: 'resume', outcome: 'completed' });
    expect(readFileSync(fixture.eventsPath, 'utf8').split(/\r?\n/).filter(Boolean)
      .filter(line => JSON.parse(line).event === 'start')).toHaveLength(2);
  }, 60_000);

  it('refuses setup redispatch when a prior failed invocation is still incomplete', async () => {
    const name = 'incomplete-setup-guard';
    const configured = await initialize(name, fixture.baseCommit, 2);
    fixture.configure({ tasks: { a: { failBeforeWork: true } } });
    await runWorkflow(fixture.cwd, name, configured.runtime);
    const stateFile = String(workflowStatus(fixture.cwd, name).stateFile);
    const raw = JSON.parse(readFileSync(stateFile, 'utf8'));
    raw.tasks[0].invocations[0].outcome = 'failed';
    raw.tasks[0].invocations[0].error = 'workflow_invocation_incomplete';
    writeFileSync(stateFile, `${JSON.stringify(raw, null, 2)}\n`);
    const before = readWorkflow(fixture.cwd, name).tasks[0]!;
    const setupCalls = injected.calls;
    const starts = readFileSync(fixture.eventsPath, 'utf8').split(/\r?\n/).filter(Boolean)
      .filter(line => JSON.parse(line).event === 'start').length;

    injected.fail = true; injected.code = 'worktree_branch_in_use';
    await expect(runWorkflow(fixture.cwd, name, configured.runtime))
      .rejects.toThrow('workflow_interrupted_worker_requires_inspection');
    const after = readWorkflow(fixture.cwd, name).tasks[0]!;
    expect(after.invocations).toEqual(before.invocations);
    expect(after.setupAttempts).toEqual(before.setupAttempts);
    expect(injected.calls).toBe(setupCalls);
    expect(readFileSync(fixture.eventsPath, 'utf8').split(/\r?\n/).filter(Boolean)
      .filter(line => JSON.parse(line).event === 'start')).toHaveLength(starts);
  }, 60_000);

  it('keeps a dependent task setup base stable when another task is accepted before explicit retry', async () => {
    const name = 'setup-dependent-retry';
    const configured = runtimeFixture(fixture);
    const tasks = [workflowTask('a'), workflowTask('c'), workflowTask('b', fixture.baseCommit, ['a'])];
    await initWorkflowV2(fixture.cwd, { name, objective: 'Preserve the first dependency base', baseCommit: fixture.baseCommit,
      integrationBranch: `integration/${name}`, tasks, verification: [check] }, {
      lead: binding('lead', 'codex'), implementer: configured.selectedBinding('implementer', 'glm', 'actor-author'),
      reviewer: configured.selectedBinding('reviewer', 'codex', 'actor-reviewer'),
    }, { mode: 'balanced', workers: 2, maxWorkers: 2, maxAttempts: 1, maxReviewPasses: 1,
      timeoutMs: 15_000, backoffMs: 0 });
    await runWorkflow(fixture.cwd, name, configured.runtime);
    await acceptWorkflowTask(fixture.cwd, name, 'a');
    const firstDependencyBase = fixture.git('rev-parse', 'HEAD');
    fixture.git('branch', getBranchName(name, 'task-b'), firstDependencyBase);
    injected.fail = true; injected.code = 'worktree_branch_in_use';
    await runWorkflow(fixture.cwd, name, configured.runtime);
    expect(readWorkflow(fixture.cwd, name).tasks.find(entry => entry.task.id === 'b')).toMatchObject({
      attempts: 0, task: { baseCommit: firstDependencyBase }, setupAttempts: [{ outcome: 'failed' }],
    });

    await acceptWorkflowTask(fixture.cwd, name, 'c');
    expect(fixture.git('rev-parse', 'HEAD')).not.toBe(firstDependencyBase);
    injected.fail = false; injected.code = '';
    await runWorkflow(fixture.cwd, name, configured.runtime);
    const completed = readWorkflow(fixture.cwd, name).tasks.find(entry => entry.task.id === 'b')!;
    expect(completed).toMatchObject({ status: 'completed', attempts: 1, task: { baseCommit: firstDependencyBase } });
    expect(completed.setupAttempts?.map(entry => entry.outcome)).toEqual(['failed', 'completed']);
    expect(completed.invocations).toHaveLength(1);
  }, 60_000);

  it.skipIf(process.platform !== 'win32')('retains a native long-path diagnostic and succeeds after core.longpaths is repaired', async () => {
    const name = 'setup-longpath';
    const worktreeRoot = getWorktreePath(fixture.cwd, name, 'task-a');
    const relativeLength = 269 - worktreeRoot.length - 1;
    const componentCharacters = relativeLength - 2;
    const firstLength = Math.floor(componentCharacters / 3);
    const secondLength = Math.floor(componentCharacters / 3);
    const fileLength = componentCharacters - firstLength - secondLength;
    expect(relativeLength).toBeGreaterThanOrEqual(20);
    expect(Math.max(firstLength, secondLength, fileLength)).toBeLessThanOrEqual(200);
    const trackedPath = join('a'.repeat(firstLength), 'b'.repeat(secondLength), `${'c'.repeat(fileLength - 4)}.txt`);
    const sourcePath = join(fixture.cwd, trackedPath);
    expect(join(worktreeRoot, trackedPath)).toHaveLength(269);
    expect(sourcePath.length).toBeLessThan(260);
    fixture.git('config', 'core.longpaths', 'true');
    mkdirSync(dirname(sourcePath), { recursive: true });
    writeFileSync(sourcePath, 'native Windows long-path fixture\n');
    fixture.git('add', '--', trackedPath);
    fixture.git('commit', '-m', 'Add long-path fixture');
    const baseCommit = fixture.git('rev-parse', 'HEAD');
    fixture.git('config', 'core.longpaths', 'false');
    const configured = await initialize(name, baseCommit);

    await runWorkflow(fixture.cwd, name, configured.runtime);
    const failed = readWorkflow(fixture.cwd, name).tasks[0]!;
    expect(failed).toMatchObject({ status: 'failed', error: 'workflow_worktree_setup_failed', attempts: 0 });
    expect(failed.invocations).toBeUndefined();
    expect(readFileSync(fixture.eventsPath, 'utf8')).toBe('');
    expect(readFileSync(failed.setupAttempts![0]!.artifact!.path, 'utf8')).toMatch(/filename too long/i);

    fixture.git('config', 'core.longpaths', 'true');
    await runWorkflow(fixture.cwd, name, configured.runtime);
    const completed = readWorkflow(fixture.cwd, name).tasks[0]!;
    expect(completed).toMatchObject({ status: 'completed', attempts: 1 });
    expect(completed.invocations).toHaveLength(1);
    expect(completed.setupAttempts?.map(entry => entry.outcome)).toEqual(['failed', 'completed']);
    expect(readFileSync(fixture.eventsPath, 'utf8').split(/\r?\n/).filter(Boolean)
      .filter(line => JSON.parse(line).event === 'start')).toHaveLength(1);
  }, 60_000);
});
