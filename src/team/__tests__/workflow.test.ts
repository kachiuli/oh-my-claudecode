import { existsSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acceptWorkflowTask, addWorkflowFix, adjudicateWorkflow, cleanupWorkflow, finishWorkflow, initWorkflow,
  readWorkflow, rejectWorkflowTask, reviewWorkflow, runWorkflow, verifyWorkflow, workflowStatus,
} from '../workflow.js';
import type { WorkflowOptions, WorkflowPlan, WorkflowTask } from '../workflow-contracts.js';
import { cleanupTeamWorktrees, ensureWorkerWorktree } from '../git-worktree.js';
import { currentProcessStartIdentity } from '../team-owner-epoch.js';
import { assertOrchestratorQuiescent, assertOrchestratorRecoveryQuiescent } from '../../orchestration/quiescence.js';
import { createWorkflowFixture, type FixtureEvent } from './helpers/workflow-fixture.js';

const provider = fileURLToPath(new URL('./helpers/workflow-provider.cjs', import.meta.url));
const check = { command: process.execPath, args: ['-e', 'process.exit(0)'] };

function peakConcurrency(events: FixtureEvent[]) {
  let running = 0;
  let peak = 0;
  for (const event of events.filter(item => item.role === 'glm')) {
    running += event.event === 'start' ? 1 : -1;
    peak = Math.max(peak, running);
  }
  return peak;
}

describe('Claude/GLM/Codex workflow with real local fake providers', () => {
  let fixture: ReturnType<typeof createWorkflowFixture>;
  const name = 'feature';
  const options: WorkflowOptions = {
    workers: 3, maxWorkers: 3, maxAttempts: 2, maxReviewPasses: 2,
    timeoutMs: 15000, backoffMs: 1, glmCommand: provider, codexCommand: provider,
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
      id, objective: `Implement feature component ${id}`, baseCommit: fixture.baseCommit,
      writeScope: [`feature/${id}.txt`], readScope: ['README.md'], prohibitedScope: ['package.json'],
      dependencies: [], contracts: ['Preserve the public API.'], acceptanceCriteria: [`feature/${id}.txt exists`],
      tests: [check], ...overrides,
    };
  }
  function plan(tasks: WorkflowTask[] = [task('a')], overrides: Partial<WorkflowPlan> = {}): WorkflowPlan {
    return {
      name, objective: 'Implement feature X', baseCommit: fixture.baseCommit,
      integrationBranch: 'integration/feature', tasks, verification: [check], ...overrides,
    };
  }
  async function integrateOne(customPlan = plan()) {
    await initWorkflow(fixture.cwd, customPlan, options);
    await runWorkflow(fixture.cwd, name);
    await acceptWorkflowTask(fixture.cwd, name, 'a');
  }

  it('captures the legacy Codex reviewer command from the environment with explicit option precedence', async () => {
    vi.stubEnv('OMC_CODEX_COMMAND', process.execPath);
    const fromEnvironment = await initWorkflow(fixture.cwd, plan(), { ...options, codexCommand: undefined });
    expect(fromEnvironment.options.codexCommand).toBe(process.execPath);

    fixture.dispose();
    fixture = createWorkflowFixture();
    vi.stubEnv('OMC_WORKFLOW_TEST_CONFIG', fixture.configPath);
    const explicit = await initWorkflow(fixture.cwd, plan(), { ...options, codexCommand: provider });
    expect(explicit.options.codexCommand).toBe(provider);
  });

  describe('attempt orphaned by a dead controller', () => {
    function exitedPid(): number {
      const child = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { windowsHide: true });
      expect(child.status).toBe(0);
      return child.pid!;
    }
    async function orphanRunningAttempt(identity: unknown, controller?: unknown, attempt = 1) {
      await initWorkflow(fixture.cwd, plan(), options);
      const stateFile = String(workflowStatus(fixture.cwd, name).stateFile);
      const state = JSON.parse(readFileSync(stateFile, 'utf8'));
      state.tasks[0] = { ...state.tasks[0], status: 'running', attempts: 1, claimToken: randomUUID(), invocations: [{
        orchestrationHost: 'claude', attempt, mode: 'fresh', model: 'glm-5.3', startedAt: new Date().toISOString(),
        outcome: 'failed', error: 'workflow_invocation_incomplete', artifacts: [],
        telemetry: { provider: 'glm', durationMs: 0, status: 'unknown', scope: 'unknown' },
        ...(identity === undefined ? {} : { process: identity }),
        ...(controller === undefined ? {} : { controller }),
      }] };
      writeFileSync(stateFile, JSON.stringify(state));
      return stateFile;
    }
    function capability(stateFile: string, attempt: number) {
      const artifacts = join(stateFile, '..', 'artifacts');
      mkdirSync(artifacts, { recursive: true });
      const path = join(artifacts, `.publication-${randomUUID()}.json`);
      writeFileSync(path, JSON.stringify({ taskId: 'a', worker: 'task-a', attempt }));
      return path;
    }

    it('lets explicit rejection settle an attempt whose provider is verifiably dead and revokes its capability', async () => {
      const stateFile = await orphanRunningAttempt({ pid: exitedPid(), processStartedAt: currentProcessStartIdentity() });
      const stale = capability(stateFile, 1);
      const unrelated = capability(stateFile, 2);
      await expect(runWorkflow(fixture.cwd, name)).rejects.toThrow('workflow_interrupted_worker_requires_inspection');
      const settled = await rejectWorkflowTask(fixture.cwd, name, 'a', 'lead crashed during the attempt');
      const task = settled.tasks[0];
      expect(task.status).toBe('rejected');
      expect(task.error).toBe('lead crashed during the attempt');
      expect(task.claimToken).toBeUndefined();
      expect(task.invocations?.[0]).toMatchObject({ outcome: 'failed', error: 'workflow_invocation_interrupted', attempt: 1 });
      const projected = JSON.parse(readFileSync(join(stateFile, '..', 'tasks', `task-${task.canonicalId}.json`), 'utf8'));
      expect(projected.status).toBe('failed');
      expect(projected.claim).toBeUndefined();
      expect(existsSync(stale)).toBe(false);
      expect(existsSync(unrelated)).toBe(true);
    });

    it.each([
      ['a bare dead provider PID', () => ({ pid: exitedPid(), processStartedAt: null }), undefined],
      ['no provider but a verifiably dead controller', () => undefined, () => ({ pid: exitedPid(), processStartedAt: currentProcessStartIdentity() })],
    ])('settles an attempt with %s', async (_name, identity, controller) => {
      await orphanRunningAttempt(identity(), controller?.());
      const settled = await rejectWorkflowTask(fixture.cwd, name, 'a', 'lead crashed before the provider reported');
      expect(settled.tasks[0].status).toBe('rejected');
      expect(settled.tasks[0].invocations?.[0].error).toBe('workflow_invocation_interrupted');
    });

    it.each([
      ['a live provider', () => ({ pid: process.pid, processStartedAt: currentProcessStartIdentity() }), undefined, 1],
      ['a bare live provider PID', () => ({ pid: process.pid, processStartedAt: null }), undefined, 1],
      ['no recorded provider or controller', () => undefined, undefined, 1],
      ['no provider and a live controller', () => undefined, () => ({ pid: process.pid, processStartedAt: currentProcessStartIdentity() }), 1],
      ['an attempt number that is not the current one', () => ({ pid: exitedPid(), processStartedAt: currentProcessStartIdentity() }), undefined, 2],
    ])('refuses to settle an attempt with %s', async (_name, identity, controller, attempt) => {
      await orphanRunningAttempt(identity(), controller?.(), attempt);
      await expect(rejectWorkflowTask(fixture.cwd, name, 'a', 'not verifiable')).rejects.toThrow('workflow_interrupted_worker_requires_inspection');
      expect(readWorkflow(fixture.cwd, name).tasks[0].status).toBe('running');
    });

    it('validates the reason before settling an orphaned attempt', async () => {
      await orphanRunningAttempt({ pid: exitedPid(), processStartedAt: currentProcessStartIdentity() });
      await expect(rejectWorkflowTask(fixture.cwd, name, 'a', 'x'.repeat(1001))).rejects.toThrow('workflow_invalid_text');
      const task = readWorkflow(fixture.cwd, name).tasks[0];
      expect(task.status).toBe('running');
      expect(task.claimToken).toBeDefined();
      expect(task.invocations?.[0].error).toBe('workflow_invocation_incomplete');
    });

    it('lets recovery pass, rejection settle, and selection resume after a crash left the attempt and advisory lock behind', async () => {
      const stateFile = await orphanRunningAttempt({ pid: exitedPid(), processStartedAt: currentProcessStartIdentity() });
      const lock = `${stateFile}.lock`;
      writeFileSync(lock, JSON.stringify({ pid: exitedPid(), timestamp: Date.now() - 120_000 }));
      const past = new Date(Date.now() - 120_000);
      utimesSync(lock, past, past);
      expect(() => assertOrchestratorRecoveryQuiescent(fixture.cwd)).not.toThrow();
      expect(() => assertOrchestratorQuiescent(fixture.cwd)).toThrow('orchestrator_active_attempt');
      await rejectWorkflowTask(fixture.cwd, name, 'a', 'lead crashed during the attempt');
      expect(existsSync(lock)).toBe(false);
      expect(() => assertOrchestratorQuiescent(fixture.cwd)).not.toThrow();
    });
  });

  it.skipIf(process.platform !== 'win32').each([false, true])('runs and accepts a worker through a Windows short path with existing worktree=%s', async existing => {
    const shortRoot = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
      Add-Type -TypeDefinition 'using System; using System.Text; using System.Runtime.InteropServices; public static class ShortPath { [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern uint GetShortPathName(string path, StringBuilder output, uint size); }'
      $buffer = [System.Text.StringBuilder]::new(32768)
      if ([ShortPath]::GetShortPathName($env:OMC_TEST_SHORT_PATH, $buffer, 32768) -eq 0) { throw 'short_path_unavailable' }
      $buffer.ToString()
    `], { encoding: 'utf8', windowsHide: true, env: { ...process.env, OMC_TEST_SHORT_PATH: fixture.cwd } }).trim();
    expect(shortRoot).toMatch(/~\d/);
    await initWorkflow(shortRoot, plan(), options);
    if (existing) ensureWorkerWorktree(name, 'task-a', shortRoot, { mode: 'named', baseRef: fixture.baseCommit });
    await runWorkflow(shortRoot, name);
    const completed = readWorkflow(shortRoot, name);
    expect(completed.tasks[0]?.error).toBeUndefined();
    expect(completed.tasks[0]).toMatchObject({ status: 'completed', attempts: 1 });
    expect(fixture.events().filter(event => event.role === 'glm' && event.event === 'start')).toHaveLength(1);
    expect(existsSync(join(fixture.cwd, 'feature/a.txt'))).toBe(false);
    await acceptWorkflowTask(shortRoot, name, 'a');
    expect(readWorkflow(shortRoot, name).tasks[0]?.status).toBe('accepted');
    expect(readFileSync(join(fixture.cwd, 'feature/a.txt'), 'utf8')).toBe('a\n');
    expect(fixture.git('rev-parse', 'main')).toBe(fixture.baseCommit);
  });

  it.each(['different directory', 'missing directory', 'wrong branch'])('refuses acceptance for a completed worker with %s', async mismatch => {
    await initWorkflow(fixture.cwd, plan(), options);
    await runWorkflow(fixture.cwd, name);
    const state = readWorkflow(fixture.cwd, name);
    expect(state.tasks[0]?.status).toBe('completed');
    const entry = state.tasks[0]!;
    if (mismatch === 'wrong branch') {
      execFileSync('git', ['checkout', '--detach'], { cwd: entry.worktree, stdio: 'pipe', windowsHide: true });
    } else {
      entry.worktree = mismatch === 'different directory' ? fixture.cwd : join(fixture.cwd, 'missing');
      writeFileSync(join(fixture.cwd, '.omc/state/team', name, 'workflow.json'), JSON.stringify(state));
    }
    await expect(acceptWorkflowTask(fixture.cwd, name, 'a')).rejects.toThrow(
      mismatch === 'wrong branch' ? 'workflow_worker_branch_mismatch' : 'workflow_worker_mapping_mismatch',
    );
    expect(readWorkflow(fixture.cwd, name).tasks[0]?.status).toBe('completed');
    expect(existsSync(join(fixture.cwd, 'feature/a.txt'))).toBe(false);
    expect(fixture.git('rev-parse', 'main')).toBe(fixture.baseCommit);
  });

  it('implements three isolated tasks, integrates only on lead acceptance, and completes one bounded fix/re-review', async () => {
    fixture.configure({ barrierCount: 3, reviewFindings: true, tasks: { a: { stdoutBytes: 300000 } } });
    await initWorkflow(fixture.cwd, plan([task('a'), task('b'), task('c')]), options);
    await runWorkflow(fixture.cwd, name);
    const implemented = await readWorkflow(fixture.cwd, name);
    expect(implemented.tasks.map(item => item.status)).toEqual(['completed', 'completed', 'completed']);
    expect(peakConcurrency(fixture.events())).toBe(3);
    expect(new Set(implemented.tasks.map(item => item.worktree)).size).toBe(3);
    expect(new Set(implemented.tasks.map(item => item.branch)).size).toBe(3);
    expect(fixture.git('rev-parse', 'main')).toBe(fixture.baseCommit);
    expect(existsSync(join(fixture.cwd, 'feature/a.txt'))).toBe(false);
    for (const item of implemented.tasks) {
      const launched = fixture.events().find(event => event.event === 'start' && event.taskId === item.task.id)!;
      expect(launched.cwd.toLowerCase()).toBe(item.worktree!.toLowerCase());
      expect(launched.branch).toBe(item.branch);
      expect(item.handoff?.commitSha).toMatch(/^[a-f0-9]{40}$/);
      expect(item.handoff?.changedFiles).toEqual([`feature/${item.task.id}.txt`]);
      expect(JSON.stringify(item.handoff)).not.toContain('WORKER_PRIVATE_TRANSCRIPT');
      expect(JSON.stringify(item.handoff).length).toBeLessThan(12000);
      await acceptWorkflowTask(fixture.cwd, name, item.task.id);
    }
    expect(fixture.git('branch', '--show-current')).toBe('integration/feature');
    await verifyWorkflow(fixture.cwd, name);
    await reviewWorkflow(fixture.cwd, name);
    const reviewed = await readWorkflow(fixture.cwd, name);
    const findings = reviewed.reviews[0]!.findings;
    expect(findings.map(item => item.severity)).toEqual(['P1', 'P3']);
    await adjudicateWorkflow(fixture.cwd, name, [
      { findingId: findings[0]!.id, disposition: 'fix', reason: 'Missing guard violates the contract.' },
      { findingId: findings[1]!.id, disposition: 'dismiss', reason: 'Unrelated style is outside this task.' },
    ]);
    await addWorkflowFix(fixture.cwd, name, task('fix', { baseCommit: fixture.git('rev-parse', 'HEAD') }), [findings[0]!.id]);
    await runWorkflow(fixture.cwd, name);
    await acceptWorkflowTask(fixture.cwd, name, 'fix');
    await verifyWorkflow(fixture.cwd, name);
    await reviewWorkflow(fixture.cwd, name);
    await finishWorkflow(fixture.cwd, name);
    const finished = await readWorkflow(fixture.cwd, name);
    expect(finished.stage).toBe('complete');
    expect(finished.reviewPasses).toBe(2);
    expect(finished.reviews[1]!.findings).toEqual([]);
    expect(fixture.git('rev-parse', 'main')).toBe(fixture.baseCommit);
    expect(fixture.git('status', '--porcelain')).toBe('');
    const reviews = fixture.events().filter(event => event.role === 'codex' && event.event === 'start');
    expect(reviews).toHaveLength(2);
    for (const review of reviews) {
      expect(review.args).toContain('read-only');
      expect(review.prompt).not.toContain('WORKER_PRIVATE_TRANSCRIPT');
      expect(review.prompt).toContain('Preserve the public API');
    }
    expect(JSON.stringify(await workflowStatus(fixture.cwd, name))).not.toContain('WORKER_PRIVATE_TRANSCRIPT');
    const preservedWorktree = finished.tasks[0]!.worktree!;
    writeFileSync(join(preservedWorktree, 'post-completion-user-work.txt'), 'Keep user changes.\n');
    const cleanup = await cleanupWorkflow(fixture.cwd, name);
    expect(cleanup.removed).toHaveLength(3);
    expect(cleanup.preserved).toEqual([expect.objectContaining({ taskId: 'a' })]);
    expect(readFileSync(join(preservedWorktree, 'post-completion-user-work.txt'), 'utf8')).toContain('Keep user changes');
    expect((await readWorkflow(fixture.cwd, name)).stage).toBe('complete');
  }, 60000);

  it('queues excess tasks at the requested worker limit', async () => {
    fixture.configure({ barrierCount: 2, delayMs: 50 });
    await initWorkflow(fixture.cwd, plan(['a', 'b', 'c', 'd', 'e'].map(id => task(id))), { ...options, workers: 2 });
    await runWorkflow(fixture.cwd, name);
    expect(peakConcurrency(fixture.events())).toBe(2);
    expect((await readWorkflow(fixture.cwd, name)).tasks.every(item => item.status === 'completed')).toBe(true);
    expect(fixture.events().filter(event => event.event === 'start')).toHaveLength(5);
  });

  it('rejects a requested worker count above the configured maximum', async () => {
    await expect(initWorkflow(fixture.cwd, plan(), { ...options, workers: 4, maxWorkers: 3 })).rejects.toThrow(/limit/i);
    expect(fixture.events()).toEqual([]);
  });

  it('waits for explicit dependency acceptance before launching the dependent worker', async () => {
    fixture.configure({ tasks: { b: { requiresFiles: ['feature/a.txt'] } } });
    await initWorkflow(fixture.cwd, plan([task('a'), task('b', { dependencies: ['a'] })]), options);
    await runWorkflow(fixture.cwd, name);
    expect(fixture.events().filter(event => event.event === 'start').map(event => event.taskId)).toEqual(['a']);
    await acceptWorkflowTask(fixture.cwd, name, 'a');
    await runWorkflow(fixture.cwd, name);
    expect(fixture.events().filter(event => event.event === 'start').map(event => event.taskId)).toEqual(['a', 'b']);
    expect((await readWorkflow(fixture.cwd, name)).tasks[1]!.status).toBe('completed');
  });

  it('bounds repeated worker failures and keeps huge stderr in artifacts', async () => {
    fixture.configure({ tasks: { a: { fail: true, stderrBytes: 500000 } } });
    await initWorkflow(fixture.cwd, plan(), options);
    await runWorkflow(fixture.cwd, name);
    const failed = (await readWorkflow(fixture.cwd, name)).tasks[0]!;
    expect(failed.status).toBe('failed');
    expect(failed.attempts).toBe(2);
    expect(fixture.events().filter(event => event.event === 'start')).toHaveLength(2);
    expect(JSON.stringify(failed).length).toBeLessThan(12000);
    expect(JSON.stringify(failed)).not.toContain('WORKER_PRIVATE_TRANSCRIPT');
    expect(failed.handoff?.artifacts.length).toBeGreaterThan(0);
    await runWorkflow(fixture.cwd, name);
    expect(fixture.events().filter(event => event.event === 'start')).toHaveLength(2);
    expect(fixture.git('rev-parse', 'main')).toBe(fixture.baseCommit);
  });

  it('removes only the provider elapsed bound under supervised policy while an omitted policy keeps the finite saved timeout', async () => {
    const delayed = 2500;
    const finite = 1200;
    fixture.configure({ tasks: { a: { delayMs: delayed }, review: { delayMs: delayed } } });
    // Paired control: with no saved policy the identical delayed provider is terminated at the bound.
    const control = 'finite';
    await initWorkflow(fixture.cwd, plan(undefined, { name: control, integrationBranch: 'integration/finite' }),
      { ...options, timeoutMs: finite, maxAttempts: 1 });
    await runWorkflow(fixture.cwd, control);
    const controlState = readWorkflow(fixture.cwd, control);
    expect(controlState.tasks[0]).toMatchObject({ status: 'failed', error: 'workflow_timeout', attempts: 1 });
    expect(controlState.options).not.toHaveProperty('providerPolicy');
    expect(workflowStatus(fixture.cwd, control).providerPolicy).toBe('legacy');
    const observed = fixture.events().length;

    await initWorkflow(fixture.cwd, plan(), { ...options, timeoutMs: finite, maxAttempts: 1, providerPolicy: 'supervised' });
    const implemented = await runWorkflow(fixture.cwd, name);
    expect(implemented.tasks[0]).toMatchObject({ status: 'completed', attempts: 1 });
    expect(implemented.options).toMatchObject({ providerPolicy: 'supervised', timeoutMs: finite });
    expect(workflowStatus(fixture.cwd, name).providerPolicy).toBe('supervised');
    await acceptWorkflowTask(fixture.cwd, name, 'a');
    await verifyWorkflow(fixture.cwd, name);
    expect((await reviewWorkflow(fixture.cwd, name)).reviewPasses).toBe(1);

    // Both supervised provider processes ran past the threshold that ended the equivalent finite one.
    const launches = fixture.events().slice(observed);
    for (const role of ['glm', 'codex'] as const) {
      const start = launches.find(event => event.role === role && event.event === 'start')!;
      const end = launches.find(event => event.role === role && event.event === 'end')!;
      expect(end.time - start.time).toBeGreaterThanOrEqual(delayed);
    }
    expect(fixture.events().filter(event => event.role === 'glm' && event.event === 'start')).toHaveLength(2);
  }, 30000);

  it('fails closed when the GLM executable is unavailable', async () => {
    await initWorkflow(fixture.cwd, plan(), { ...options, glmCommand: join(fixture.root, 'missing-glm-provider') });
    await expect(runWorkflow(fixture.cwd, name)).rejects.toThrow(/unavailable.*fallback_disabled/);
    const pending = (await readWorkflow(fixture.cwd, name)).tasks[0]!;
    expect(pending.status).toBe('pending');
    expect(pending.attempts).toBe(0);
    expect(fixture.events()).toEqual([]);
    expect(fixture.git('rev-parse', 'main')).toBe(fixture.baseCommit);
  });

  it.each([
    ['glm', 'failure', 'json'], ['glm', 'timeout', 'json'], ['glm', 'interrupted', 'json'], ['glm', 'artifact', 'json'],
    ['glm', 'failure', 'invalid'], ['glm', 'failure', 'oversized'],
    ['codex', 'failure', 'json'], ['codex', 'timeout', 'json'], ['codex', 'interrupted', 'json'], ['codex', 'artifact', 'json'],
  ])('sanitizes %s result metadata after %s with %s output', async (role, resultFailure, resultFormat) => {
    const secret = 'fake-result-credential-123456';
    vi.stubEnv('OMC_FIXTURE_API_TOKEN', secret);
    if (role === 'codex') {
      await integrateOne();
      await verifyWorkflow(fixture.cwd, name);
      // Give successful setup its normal timeout, then bound only the failing reviewer.
      const path = String(workflowStatus(fixture.cwd, name).stateFile);
      const state = readWorkflow(fixture.cwd, name);
      state.options.timeoutMs = 2000;
      writeFileSync(path, JSON.stringify(state));
    } else {
      await initWorkflow(fixture.cwd, plan(), { ...options, maxAttempts: 1, timeoutMs: 2000 });
    }
    fixture.configure({ tasks: { [role === 'codex' ? 'review' : 'a']: { resultFailure, resultFormat } } });
    const root = join(fixture.cwd, '.omc/state/team', name, 'artifacts');
    const prefix = role === 'codex' ? 'review-1' : 'task-a-1';
    const resultFile = join(root, `${prefix}.result.json`);
    const interrupt = resultFailure === 'interrupted' ? setInterval(() => {
      if (existsSync(resultFile)) { clearInterval(interrupt); process.emit('SIGINT'); }
    }, 20) : undefined;
    try {
      if (role === 'codex') {
        await expect(reviewWorkflow(fixture.cwd, name)).rejects.toThrow(
          resultFailure === 'artifact' ? 'workflow_artifact_write_refused' : 'workflow_review_process_failed',
        );
      } else {
        await runWorkflow(fixture.cwd, name);
        const failed = readWorkflow(fixture.cwd, name).tasks[0]!;
        expect(failed.status).toBe('failed');
        expect(failed.error).toBe(resultFailure === 'artifact' ? 'workflow_artifact_write_refused'
          : ['timeout', 'interrupted'].includes(resultFailure) ? `workflow_${resultFailure}` : 'workflow_process_failed');
        expect(existsSync(failed.worktree!)).toBe(true);
      }
    } finally { clearInterval(interrupt); }
    const retained = readFileSync(resultFile, 'utf8');
    expect(retained).not.toContain(secret);
    expect(Buffer.byteLength(retained)).toBeLessThanOrEqual(64 * 1024);
    expect(() => JSON.parse(retained)).not.toThrow();
    expect(readdirSync(root).filter(file => file.includes('.tmp.'))).toEqual([]);
  }, 20000);

  it('replaces a completed rejected fix while preserving its history and unsatisfied dependencies', async () => {
    fixture.configure({ findings: [{ severity: 'P1', message: 'Repair feature a.', file: 'feature/a.txt', line: 1 }] });
    await integrateOne();
    await verifyWorkflow(fixture.cwd, name);
    await reviewWorkflow(fixture.cwd, name);
    const findingId = readWorkflow(fixture.cwd, name).reviews[0]!.findings[0]!.id;
    await adjudicateWorkflow(fixture.cwd, name, [{ findingId, disposition: 'fix', reason: 'Repair the bug.' }]);
    const fix = (id: string, dependencies: string[] = []) => task(id, {
      baseCommit: fixture.git('rev-parse', 'HEAD'), writeScope: ['feature/a.txt'], dependencies,
    });
    await addWorkflowFix(fixture.cwd, name, fix('fix-one'), [findingId]);
    await runWorkflow(fixture.cwd, name);
    await rejectWorkflowTask(fixture.cwd, name, 'fix-one', 'This repair misses the requirement.');
    const rejected = readWorkflow(fixture.cwd, name).tasks[1]!;
    expect(rejected.handoff?.commitSha).toMatch(/^[a-f0-9]{40}$/);
    await addWorkflowFix(fixture.cwd, name, fix('blocked-fix', ['fix-one']), [findingId]);
    await runWorkflow(fixture.cwd, name);
    expect(readWorkflow(fixture.cwd, name).tasks[2]!.status).toBe('pending');
    expect(fixture.events().some(event => event.taskId === 'blocked-fix')).toBe(false);
    await expect(acceptWorkflowTask(fixture.cwd, name, 'blocked-fix')).rejects.toThrow();
    await rejectWorkflowTask(fixture.cwd, name, 'blocked-fix', 'Replace without the rejected prerequisite.');
    await addWorkflowFix(fixture.cwd, name, fix('fix-two'), [findingId]);
    expect(readWorkflow(fixture.cwd, name).plan.tasks).toHaveLength(4);
    await runWorkflow(fixture.cwd, name);
    await acceptWorkflowTask(fixture.cwd, name, 'fix-two');
    await verifyWorkflow(fixture.cwd, name);
    const state = readWorkflow(fixture.cwd, name);
    expect(state.tasks.map(entry => entry.status)).toEqual(['accepted', 'rejected', 'rejected', 'accepted']);
    expect(state.reviews[0]!.findings[0]!.fixedBy).toBe('fix-two');
    expect(state.verification?.passed).toBe(true);
    expect(readFileSync(join(rejected.worktree!, 'feature/a.txt'), 'utf8')).toBe('fix-one\n');
    expect(fixture.git('rev-parse', rejected.branch!)).toBe(rejected.handoff!.commitSha);
    expect(readFileSync(join(fixture.cwd, 'feature/a.txt'), 'utf8')).toBe('fix-two\n');
  }, 30000);

  it.each(['hardlink', 'parent', 'directory'])('refuses a provider-controlled result %s without modifying protected files', async resultLink => {
    const protectedRoot = join(fixture.root, 'protected');
    mkdirSync(protectedRoot);
    const target = join(protectedRoot, 'task-a-1.result.json');
    const original = JSON.stringify({ summary: 'Protected unrelated content.' });
    writeFileSync(target, original);
    fixture.configure({ tasks: { a: { resultFailure: 'linked', resultLink,
      resultTarget: resultLink === 'parent' ? protectedRoot : target } } });
    await initWorkflow(fixture.cwd, plan(), { ...options, maxAttempts: 1 });
    await runWorkflow(fixture.cwd, name);
    const failed = readWorkflow(fixture.cwd, name).tasks[0]!;
    expect(failed.status).toBe('failed');
    expect(failed.error).toBe(resultLink === 'parent' ? 'workflow_artifact_parent_changed' : 'workflow_result_not_regular_file');
    expect(readFileSync(target, 'utf8')).toBe(original);
    expect(readdirSync(protectedRoot)).toEqual(['task-a-1.result.json']);
  });

  it.each(['invalid', 'missing'])('retains process artifacts when an exit-zero worker returns %s metadata', async resultFormat => {
    fixture.configure({ tasks: { a: { resultFailure: 'success', resultFormat } } });
    await initWorkflow(fixture.cwd, plan(), { ...options, maxAttempts: 1 });
    await runWorkflow(fixture.cwd, name);
    const failed = readWorkflow(fixture.cwd, name).tasks[0]!;
    expect(failed.status).toBe('failed');
    expect(failed.error).toBe(resultFormat === 'invalid' ? 'workflow_invalid_result' : 'workflow_designated_result_missing');
    expect(failed.handoff?.outcome).toBe('failed');
    expect(failed.handoff?.artifacts.map(artifact => artifact.kind)).toEqual(['workflow-stdout', 'workflow-stderr']);
    for (const artifact of failed.handoff!.artifacts) expect(existsSync(artifact.path)).toBe(true);
  });

  it.each(['stdout-only', 'local-only'] as const)(
    'does not replay or retry when a normally completed worker publishes a valid handoff to %s', async publication => {
      const replayMarker = join(fixture.root, `replay-${publication}.txt`);
      const replay = { command: process.execPath,
        args: ['-e', 'require("node:fs").writeFileSync(process.argv[1], "replayed")', replayMarker] };
      fixture.configure({ tasks: { a: { publication } } });
      await initWorkflow(fixture.cwd, plan([task('a', { tests: [replay] })]), { ...options, maxAttempts: 3 });
      await runWorkflow(fixture.cwd, name);
      const state = readWorkflow(fixture.cwd, name); const failed = state.tasks[0]!;
      expect(failed).toMatchObject({ status: 'failed', error: 'workflow_designated_result_missing', attempts: 1 });
      expect(existsSync(replayMarker)).toBe(false);
      expect(existsSync(join(fixture.cwd, '.omc/state/team', name, 'artifacts', 'task-a-1.result.json'))).toBe(false);
      expect(failed.handoff?.artifacts.map(artifact => artifact.kind).sort()).toEqual(['workflow-stderr', 'workflow-stdout']);
      await runWorkflow(fixture.cwd, name);
      expect(fixture.events().filter(event => event.role === 'glm' && event.event === 'start')).toHaveLength(1);
      await expect(acceptWorkflowTask(fixture.cwd, name, 'a')).rejects.toThrow('workflow_task_not_awaiting_acceptance');
    },
  );

  it('preserves exclusively published result bytes and reaches controller replay', async () => {
    const replayMarker = join(fixture.root, 'replay-published.txt');
    const replay = { command: process.execPath,
      args: ['-e', 'require("node:fs").writeFileSync(process.argv[1], "replayed")', replayMarker] };
    fixture.configure({ tasks: { a: { prettyResult: true } } });
    await initWorkflow(fixture.cwd, plan([task('a', { tests: [replay] })]), { ...options, maxAttempts: 1 });
    await runWorkflow(fixture.cwd, name);
    const state = readWorkflow(fixture.cwd, name); const completed = state.tasks[0]!;
    const resultFile = join(fixture.cwd, '.omc/state/team', name, 'artifacts', 'task-a-1.result.json');
    expect(completed).toMatchObject({ status: 'completed', attempts: 1 });
    const publishedBytes = readFileSync(resultFile, 'utf8');
    expect(publishedBytes.startsWith('{\n  "taskId"')).toBe(true);
    expect(publishedBytes.endsWith('}\n')).toBe(true);
    expect(readFileSync(replayMarker, 'utf8')).toBe('replayed');
    const prompt = JSON.parse(fixture.events().find(event => event.event === 'start')!.prompt);
    expect(prompt.task).toEqual(completed.task);
    expect(prompt.publication).toMatchObject({
      canonicalTask: { source: 'dispatch.task', taskId: 'a' },
      designatedResult: { path: resultFile, authorization: 'create-this-file-only', overwrite: false, stdoutIsHandoff: false },
    });
    expect(prompt.publication.publishInvocation).toMatchObject({
      command: 'omc',
      args: expect.arrayContaining([
        'team', 'workflow', 'publish-result', '--result-file', resultFile, '--task-id', 'a',
      ]),
    });
    expect(prompt.publication.publishCommand).toBeNull();
  });

  it('rejects a designated handoff whose task identity does not match the canonical task', async () => {
    fixture.configure({ tasks: { a: { handoffTaskId: 'different-task' } } });
    await initWorkflow(fixture.cwd, plan(), { ...options, maxAttempts: 1 });
    await runWorkflow(fixture.cwd, name);
    expect(readWorkflow(fixture.cwd, name).tasks[0]).toMatchObject({
      status: 'failed', error: 'workflow_invalid_handoff_identity', attempts: 1,
    });
  });

  it.each(['branch', 'tag', 'checkpoint'] as const)(
    'fails closed with private phase evidence when a provider changes a protected %s ref', async protectedRef => {
      fixture.configure({ tasks: { a: { protectedRef } } });
      await initWorkflow(fixture.cwd, plan(), { ...options, maxAttempts: 1 });
      await expect(runWorkflow(fixture.cwd, name)).rejects.toThrow('workflow_protected_refs_changed');
      const state = readWorkflow(fixture.cwd, name); const failed = state.tasks[0]!;
      expect(failed).toMatchObject({ status: 'failed', error: 'workflow_protected_refs_changed' });
      const descriptor = failed.handoff?.artifacts.find(artifact => artifact.kind === 'workflow-protected-ref-audit');
      expect(descriptor).toBeDefined();
      const audit = JSON.parse(readFileSync(descriptor!.path, 'utf8'));
      expect(audit).toMatchObject({ writer: 'unknown', outcome: 'protected-refs-changed', overflow: false });
      expect(audit.changes).toEqual(expect.arrayContaining([expect.objectContaining({ firstObservedPhase: 'provider-complete' })]));
      const routine = JSON.stringify(workflowStatus(fixture.cwd, name));
      expect(routine).not.toContain(audit.changes[0].ref);
      expect(routine).not.toContain('firstObservedPhase');
    },
  );

  it.each(['branch-add', 'branch-delete', 'tag-move', 'tag-delete'] as const)(
    'fails closed for protected ref operation %s', async protectedRef => {
      if (protectedRef.endsWith('delete') || protectedRef === 'tag-move') {
        const namespace = protectedRef.startsWith('branch') ? 'heads' : 'tags';
        fixture.git('update-ref', `refs/${namespace}/protected-existing`, fixture.baseCommit);
      }
      fixture.configure({ tasks: { a: { protectedRef } } });
      await initWorkflow(fixture.cwd, plan(), { ...options, maxAttempts: 1 });
      await expect(runWorkflow(fixture.cwd, name)).rejects.toThrow('workflow_protected_refs_changed');
      expect(readWorkflow(fixture.cwd, name).tasks[0]).toMatchObject({ status: 'failed', error: 'workflow_protected_refs_changed' });
    },
  );

  it('allows only an unrelated root-tree Codex checkpoint first observed during controller replay', async () => {
    const checkpoint = 'refs/codex/turn-diffs/checkpoints/external-replay-a';
    const replay = { command: 'git', args: ['update-ref', checkpoint, fixture.baseCommit] };
    await initWorkflow(fixture.cwd, plan([task('a', { tests: [replay] })]), { ...options, maxAttempts: 1 });
    await runWorkflow(fixture.cwd, name);
    const completed = readWorkflow(fixture.cwd, name).tasks[0]!;
    expect(completed).toMatchObject({ status: 'completed', attempts: 1 });
    const descriptor = completed.handoff?.artifacts.find(artifact => artifact.kind === 'workflow-protected-ref-audit');
    const audit = JSON.parse(readFileSync(descriptor!.path, 'utf8'));
    expect(audit).toMatchObject({ writer: 'unknown', outcome: 'allowed-external-checkpoint', overflow: false });
    expect(audit.changes).toEqual([expect.objectContaining({ ref: checkpoint, before: null,
      firstObservedPhase: 'controller-replay', activeProviders: 0 })]);
  });

  it('rejects a checkpoint prefix when replay points it at the worker commit', async () => {
    const checkpoint = 'refs/codex/turn-diffs/checkpoints/related-replay-a';
    const replay = { command: 'git', args: ['update-ref', checkpoint, 'HEAD'] };
    await initWorkflow(fixture.cwd, plan([task('a', { tests: [replay] })]), { ...options, maxAttempts: 1 });
    await expect(runWorkflow(fixture.cwd, name)).rejects.toThrow('workflow_protected_refs_changed');
    expect(readWorkflow(fixture.cwd, name).tasks[0]).toMatchObject({ status: 'failed', error: 'workflow_protected_refs_changed' });
  });

  it('rejects a root-tree checkpoint whose commit descends from the worker commit', async () => {
    const checkpoint = 'refs/codex/turn-diffs/checkpoints/worker-descendant-replay-a';
    const script = [
      "const {execFileSync}=require('node:child_process');",
      "const git=(...args)=>execFileSync('git',args,{encoding:'utf8'}).trim();",
      "const tree=git('rev-parse','HEAD~1^{tree}');",
      "const parent=git('rev-parse','HEAD');",
      "const commit=git('commit-tree',tree,'-p',parent,'-m','Synthetic related checkpoint');",
      `git('update-ref',${JSON.stringify(checkpoint)},commit);`,
    ].join('');
    const replay = { command: process.execPath, args: ['-e', script] };
    await initWorkflow(fixture.cwd, plan([task('a', { tests: [replay] })]), { ...options, maxAttempts: 1 });
    await expect(runWorkflow(fixture.cwd, name)).rejects.toThrow('workflow_protected_refs_changed');
    expect(readWorkflow(fixture.cwd, name).tasks[0]).toMatchObject({ status: 'failed', error: 'workflow_protected_refs_changed' });
  });

  it('fails closed when checkpoint evidence is first observed while another provider is active', async () => {
    const checkpoint = 'refs/codex/turn-diffs/checkpoints/overlapping-provider';
    const replay = { command: 'git', args: ['update-ref', checkpoint, fixture.baseCommit] };
    fixture.configure({ barrierCount: 2, tasks: { b: { delayMs: 1200 } } });
    await initWorkflow(fixture.cwd, plan([task('a', { tests: [replay] }), task('b')]),
      { ...options, workers: 2, maxAttempts: 1 });
    await expect(runWorkflow(fixture.cwd, name)).rejects.toThrow('workflow_protected_refs_changed');
    const state = readWorkflow(fixture.cwd, name);
    expect(state.tasks.every(entry => entry.status === 'failed' && entry.error === 'workflow_protected_refs_changed')).toBe(true);
    const descriptor = state.tasks[0]!.handoff?.artifacts.find(artifact => artifact.kind === 'workflow-protected-ref-audit');
    const audit = JSON.parse(readFileSync(descriptor!.path, 'utf8'));
    expect(audit.changes).toEqual([expect.objectContaining({ ref: checkpoint,
      firstObservedPhase: 'controller-replay', activeProviders: 1 })]);
  });

  it('bounds protected-ref evidence and fails closed when the delta overflows', async () => {
    fixture.configure({ tasks: { a: { protectedRef: 'overflow' } } });
    await initWorkflow(fixture.cwd, plan(), { ...options, maxAttempts: 1 });
    await expect(runWorkflow(fixture.cwd, name)).rejects.toThrow('workflow_protected_refs_changed');
    const failed = readWorkflow(fixture.cwd, name).tasks[0]!;
    const descriptor = failed.handoff?.artifacts.find(artifact => artifact.kind === 'workflow-protected-ref-audit');
    const audit = JSON.parse(readFileSync(descriptor!.path, 'utf8'));
    expect(audit).toMatchObject({ outcome: 'protected-refs-changed', overflow: true });
    expect(audit.changes).toHaveLength(32);
  });

  it.each(['dirty', 'badBranch'] as const)('preserves the worktree and fails safely after a worker leaves %s state', async behavior => {
    fixture.configure({ tasks: { a: { [behavior]: true } } });
    await initWorkflow(fixture.cwd, plan(), options);
    if (behavior === 'badBranch') {
      await expect(runWorkflow(fixture.cwd, name)).rejects.toThrow('workflow_protected_refs_changed');
    } else {
      await runWorkflow(fixture.cwd, name);
    }
    const failed = (await readWorkflow(fixture.cwd, name)).tasks[0]!;
    expect(failed.status).toBe('failed');
    expect(existsSync(failed.worktree!)).toBe(true);
    expect(readFileSync(join(failed.worktree!, 'feature/a.txt'), 'utf8')).toBe('a\n');
    if (behavior === 'dirty') {
      const cleanup = cleanupTeamWorktrees(name, fixture.cwd);
      expect(cleanup.preserved.some(item => item.path === failed.worktree)).toBe(true);
      expect(readFileSync(join(failed.worktree!, 'uncommitted-user-work.txt'), 'utf8')).toContain('preserve');
    }
    await expect(acceptWorkflowTask(fixture.cwd, name, 'a')).rejects.toThrow();
    expect(fixture.git('rev-parse', 'main')).toBe(fixture.baseCommit);
  });

  it('rejects out-of-scope committed writes even when the worker claims completion', async () => {
    fixture.configure({ tasks: { a: { file: 'outside.txt' } } });
    await initWorkflow(fixture.cwd, plan(), options);
    await runWorkflow(fixture.cwd, name);
    const failed = (await readWorkflow(fixture.cwd, name)).tasks[0]!;
    expect(failed.status).toBe('failed');
    expect(existsSync(join(failed.worktree!, 'outside.txt'))).toBe(true);
    await expect(acceptWorkflowTask(fixture.cwd, name, 'a')).rejects.toThrow();
  });

  it('never integrates a lead-rejected worker commit', async () => {
    await initWorkflow(fixture.cwd, plan(), options);
    await runWorkflow(fixture.cwd, name);
    await rejectWorkflowTask(fixture.cwd, name, 'a', 'The implementation does not satisfy the requirement.');
    expect((await readWorkflow(fixture.cwd, name)).tasks[0]!.status).toBe('rejected');
    expect(existsSync(join(fixture.cwd, 'feature/a.txt'))).toBe(false);
    await expect(acceptWorkflowTask(fixture.cwd, name, 'a')).rejects.toThrow();
  });

  it('gates review on integration and successful deterministic verification', async () => {
    await initWorkflow(fixture.cwd, plan(), options);
    await expect(reviewWorkflow(fixture.cwd, name)).rejects.toThrow();
    await runWorkflow(fixture.cwd, name);
    await acceptWorkflowTask(fixture.cwd, name, 'a');
    await expect(reviewWorkflow(fixture.cwd, name)).rejects.toThrow();
    expect(fixture.events().some(event => event.role === 'codex')).toBe(false);
  });

  it('blocks review after an integration verification failure', async () => {
    await integrateOne(plan(undefined, { verification: [{ command: process.execPath, args: ['-e', 'process.exit(12)'] }] }));
    await verifyWorkflow(fixture.cwd, name);
    expect((await readWorkflow(fixture.cwd, name)).verification?.passed).toBe(false);
    await expect(reviewWorkflow(fixture.cwd, name)).rejects.toThrow();
    expect(fixture.events().some(event => event.role === 'codex')).toBe(false);
  });

  it('rejects a review when the verified integration head has changed', async () => {
    await integrateOne();
    await verifyWorkflow(fixture.cwd, name);
    writeFileSync(join(fixture.cwd, 'new.txt'), 'unverified\n');
    fixture.git('add', 'new.txt');
    fixture.git('commit', '-m', 'Unverified integration change');
    await expect(reviewWorkflow(fixture.cwd, name)).rejects.toThrow();
    expect(fixture.events().some(event => event.role === 'codex')).toBe(false);
  });

  it('detects read-only reviewer mutation and preserves the changed file for inspection', async () => {
    fixture.configure({ mutateReview: true });
    await integrateOne();
    await verifyWorkflow(fixture.cwd, name);
    await expect(reviewWorkflow(fixture.cwd, name)).rejects.toThrow(/modif|mutat|dirty|read.only/i);
    expect(readFileSync(join(fixture.cwd, 'README.md'), 'utf8')).toContain('unauthorized review mutation');
    await expect(finishWorkflow(fixture.cwd, name)).rejects.toThrow();
  });

  it('detects a reviewer changing another branch even when the integration head stays clean', async () => {
    fixture.configure({ mutateReviewRef: true });
    await integrateOne();
    await verifyWorkflow(fixture.cwd, name);
    await expect(reviewWorkflow(fixture.cwd, name)).rejects.toThrow(/modif|mutat|ref/i);
    await expect(finishWorkflow(fixture.cwd, name)).rejects.toThrow();
  });

  it('stops review launches at the configured maximum', async () => {
    await integrateOne();
    await verifyWorkflow(fixture.cwd, name);
    await reviewWorkflow(fixture.cwd, name);
    await reviewWorkflow(fixture.cwd, name);
    await expect(reviewWorkflow(fixture.cwd, name)).rejects.toThrow(/limit|maximum|passes/i);
    expect(fixture.events().filter(event => event.role === 'codex' && event.event === 'start')).toHaveLength(2);
  });

  it('does not let an unadjudicated high-priority finding finish the workflow', async () => {
    fixture.configure({ reviewFindings: true });
    await integrateOne();
    await verifyWorkflow(fixture.cwd, name);
    await reviewWorkflow(fixture.cwd, name);
    await expect(finishWorkflow(fixture.cwd, name)).rejects.toThrow();
  });

  it('executes each declared worker test locally instead of trusting its claimed result', async () => {
    await initWorkflow(fixture.cwd, plan([task('a', { tests: [{ command: process.execPath, args: ['-e', 'process.exit(19)'] }] })]), options);
    await runWorkflow(fixture.cwd, name);
    expect((await readWorkflow(fixture.cwd, name)).tasks[0]!.status).toBe('failed');
    expect(fixture.git('rev-parse', 'main')).toBe(fixture.baseCommit);
  });

  it('bounds status for the maximum planned task count and reports omitted rows', async () => {
    await initWorkflow(fixture.cwd, plan(Array.from({ length: 100 }, (_, index) => task(`component-${String(index).padStart(20, '0')}`))), options);
    const status = workflowStatus(fixture.cwd, name);
    expect(Buffer.byteLength(JSON.stringify(status))).toBeLessThanOrEqual(16 * 1024);
    expect(status.omittedTasks).toBeGreaterThan(0);
    expect((status.tasks as unknown[]).length + Number(status.omittedTasks)).toBe(100);
    expect(status.failedTasks).toBe(0);
    expect(existsSync(String(status.stateFile))).toBe(true);
  });

  it('bounds status with maximum findings and retains failed-task totals when task rows are omitted', async () => {
    const findings = Array.from({ length: 50 }, () => ({ severity: 'P2', message: 'Relevant review observation. '.repeat(20) }));
    const metadata = Array.from({ length: 3 }, () => 'Interface assumption or risk. '.repeat(30));
    fixture.configure({ findings, tasks: {
      a: { metadata }, b: { metadata }, c: { metadata }, fix: { fail: true },
    } });
    await initWorkflow(fixture.cwd, plan([task('a'), task('b'), task('c')]), { ...options, maxAttempts: 1 });
    await runWorkflow(fixture.cwd, name);
    for (const id of ['a', 'b', 'c']) await acceptWorkflowTask(fixture.cwd, name, id);
    await verifyWorkflow(fixture.cwd, name);
    await reviewWorkflow(fixture.cwd, name);
    const findingId = readWorkflow(fixture.cwd, name).reviews[0]!.findings[0]!.id;
    await adjudicateWorkflow(fixture.cwd, name, [{ findingId, disposition: 'fix', reason: 'Address this valid issue.' }]);
    await addWorkflowFix(fixture.cwd, name, task('fix', { baseCommit: fixture.git('rev-parse', 'HEAD') }), [findingId]);
    await runWorkflow(fixture.cwd, name);
    const status = workflowStatus(fixture.cwd, name);
    expect(Buffer.byteLength(JSON.stringify(status))).toBeLessThanOrEqual(16 * 1024);
    expect(status.failedTasks).toBe(1);
    expect(status.omittedTasks).toBeGreaterThan(0);
    expect((status.tasks as unknown[]).length + Number(status.omittedTasks)).toBe(4);
    expect((status.findings as unknown[]).length + Number(status.omittedFindings)).toBe(50);
    expect(readWorkflow(fixture.cwd, name).tasks.find(item => item.task.id === 'fix')?.status).toBe('failed');
  }, 60000);

  it('rejects every lead mutator when invoked from a team worker scope', async () => {
    await initWorkflow(fixture.cwd, plan(), options);
    const before = JSON.stringify(readWorkflow(fixture.cwd, name));
    vi.stubEnv('OMC_TEAM_WORKER', 'task-a');
    const mutations = [
      () => initWorkflow(fixture.cwd, plan(), options),
      () => runWorkflow(fixture.cwd, name),
      () => acceptWorkflowTask(fixture.cwd, name, 'a'),
      () => rejectWorkflowTask(fixture.cwd, name, 'a', 'Worker cannot adjudicate.'),
      () => verifyWorkflow(fixture.cwd, name),
      () => reviewWorkflow(fixture.cwd, name),
      () => adjudicateWorkflow(fixture.cwd, name, []),
      () => addWorkflowFix(fixture.cwd, name, task('fix'), []),
      () => finishWorkflow(fixture.cwd, name),
      () => cleanupWorkflow(fixture.cwd, name),
    ];
    for (const mutation of mutations) await expect(mutation()).rejects.toThrow('workflow_lead_authority_required');
    expect(JSON.stringify(readWorkflow(fixture.cwd, name))).toBe(before);
    expect(fixture.events()).toEqual([]);
  });
});
