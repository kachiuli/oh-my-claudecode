import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fsUtils from '../fs-utils.js';
import * as processRunner from '../workflow-process.js';
import * as publication from '../workflow-publication.js';
import { ensureWorkerWorktree } from '../git-worktree.js';
import { currentProcessStartIdentity } from '../team-owner-epoch.js';
import { initWorkflow, initWorkflowV2, inspectWorkflowTask, readWorkflow, rejectWorkflowTask, runWorkflow, workflowStatus } from '../workflow.js';
import type { WorkflowProviderProcessIdentity, WorkflowState, WorkflowStateV2 } from '../workflow-contracts.js';
import { createWorkflowFixture } from './helpers/workflow-fixture.js';
import { binding, runtimeFixture } from './helpers/workflow-v2-fixture.js';

const name = 'persistence';
const error = () => Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM', syscall: 'rename' });

describe('issue64 reservation persistence and guarded historical settlement', () => {
  let fixture: ReturnType<typeof createWorkflowFixture>;
  beforeEach(() => { fixture = createWorkflowFixture(); vi.stubEnv('OMC_STATE_DIR', ''); });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); fixture.dispose(); });
  async function initialize() {
    const configured = runtimeFixture(fixture); const check = { command: process.execPath, args: ['-e', 'process.exit(0)'] };
    await initWorkflowV2(fixture.cwd, { name, objective: 'Exercise reservation persistence', baseCommit: fixture.baseCommit,
      integrationBranch: `integration/${name}`, verification: [check], tasks: [{ id: 'a', objective: 'Implement the owned component',
        baseCommit: fixture.baseCommit, writeScope: ['feature/a.txt'], readScope: ['README.md'], prohibitedScope: [], dependencies: [],
        contracts: ['Preserve reservation history'], acceptanceCriteria: ['One consistent terminal attempt'], tests: [check] }] }, {
      lead: binding('lead', 'codex'), implementer: configured.selectedBinding('implementer', 'glm', 'actor-author'),
      reviewer: configured.selectedBinding('reviewer', 'codex', 'actor-reviewer'),
    }, { mode: 'balanced', workers: 1, maxWorkers: 1, maxAttempts: 2, maxReviewPasses: 1, timeoutMs: 15000, backoffMs: 0 });
    return configured;
  }
  const stateFile = () => String(workflowStatus(fixture.cwd, name).stateFile);
  const readState = () => {
    const state = readWorkflow(fixture.cwd, name); if (state.schemaVersion !== 2) throw new Error('Expected the V2 fixture'); return state;
  };
  function snapshot() {
    const root = dirname(stateFile()); const files: Record<string, string> = {};
    for (const name of readdirSync(root, { recursive: true })) {
      const path = join(root, String(name));
      try { files[String(name)] = readFileSync(path).toString('base64'); } catch { /* directories carry no bytes */ }
    }
    return { files, refs: fixture.git('for-each-ref', '--sort=refname', '--format=%(refname) %(objectname)') };
  }
  function failReservation(persistent: boolean) {
    const actual = fsUtils.atomicWriteJson; const first = error(); const attempts: WorkflowState[] = []; let armed = false;
    const write = vi.spyOn(fsUtils, 'atomicWriteJson').mockImplementation((path, value, mode) => {
      const state = value as WorkflowState; const entry = state.tasks?.[0];
      if (path.endsWith('workflow.json') && entry?.attempts === 1 && (!armed || persistent)) {
        attempts.push(JSON.parse(JSON.stringify(value)) as WorkflowState); const next = armed ? error() : first; armed = true; throw next;
      }
      return actual(path, value, mode);
    });
    return { first, attempts, write };
  }
  async function deadController(): Promise<WorkflowProviderProcessIdentity> {
    const child = spawn(process.execPath, ['-e', 'process.stdout.write("ready");process.stdin.resume();process.stdin.on("end",()=>process.exit(1));'],
      { cwd: fixture.cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const closed = once(child, 'close'); await once(child.stdout, 'data');
    const identity = { pid: child.pid!, processStartedAt: currentProcessStartIdentity(child.pid!) };
    expect(identity.processStartedAt).not.toBeNull(); child.stdin.end(); expect(await closed).toEqual([1, null]); return identity;
  }
  async function historical(controller: unknown, changes: Record<string, unknown> = {}) {
    const configured = await initialize(); const path = stateFile(); const state = readState();
    const entry = state.tasks[0]!; const worktree = ensureWorkerWorktree(name, entry.worker, fixture.cwd, { mode: 'named', baseRef: fixture.baseCommit })!;
    entry.worktree = worktree.path; entry.branch = worktree.branch; entry.status = 'running'; entry.attempts = 1; entry.claimToken = randomUUID();
    entry.setupAttempts = [{ sequence: 1, mode: 'fresh', startedAt: new Date().toISOString(), outcome: 'completed' }];
    entry.invocations = [{ orchestrationHost: 'codex', invocationId: randomUUID(), binding: state.bindings.implementer,
      model: state.bindings.implementer.model, attempt: 1, mode: 'fresh', startedAt: new Date().toISOString(),
      outcome: 'failed', error: 'workflow_worker_persistence_failed', artifacts: [],
      telemetry: { provider: 'glm', durationMs: 0, status: 'unknown', scope: 'unknown' },
      ...(controller === undefined ? {} : { controller: controller as WorkflowProviderProcessIdentity }), ...changes }];
    writeFileSync(path, JSON.stringify(state, null, 2) + '\n'); return { configured, before: readState() };
  }

  it('keeps a once-failed first reservation terminal and launches no publication, provider or check', async () => {
    const configured = await initialize(); const before = readState(); const injected = failReservation(false);
    const provider = vi.spyOn(processRunner, 'runWorkflowProcess'); const issued = vi.spyOn(publication, 'issueWorkflowPublication');
    await expect(runWorkflow(fixture.cwd, name, configured.runtime)).rejects.toBe(injected.first);
    const state = readState(); const entry = state.tasks[0]!;
    expect(entry).toMatchObject({ status: 'failed', attempts: 1, error: 'workflow_worker_persistence_failed',
      setupAttempts: [{ sequence: 1, outcome: 'completed' }],
      invocations: [{ attempt: 1, outcome: 'failed', error: 'workflow_worker_persistence_failed', telemetry: { status: 'unknown', scope: 'unknown' } }] });
    expect(entry.claimToken).toBeUndefined(); expect(entry.invocations![0]!.process).toBeUndefined();
    expect(entry.invocations![0]!.processResult).toBeUndefined(); expect(entry.handoff).toBeUndefined(); expect(entry.session).toBeUndefined();
    expect(state.bindings).toEqual(before.bindings); expect(state.plan).toEqual(before.plan);
    expect(provider).not.toHaveBeenCalled(); expect(issued).not.toHaveBeenCalled(); expect(fixture.events()).toEqual([]);
    const projection = JSON.parse(readFileSync(join(dirname(stateFile()), 'tasks', `task-${entry.canonicalId}.json`), 'utf8'));
    expect(projection.status).toBe('failed'); expect(projection.claim).toBeUndefined();
    await runWorkflow(fixture.cwd, name, configured.runtime); expect(readWorkflow(fixture.cwd, name).tasks[0]!.attempts).toBe(1);
    expect(provider).not.toHaveBeenCalled();
  });
  it('retains the first persistent write error and all failed cleanup saves without claiming durable state', async () => {
    const configured = await initialize(); const injected = failReservation(true);
    let failure: unknown; try { await runWorkflow(fixture.cwd, name, configured.runtime); } catch (caught) { failure = caught; }
    const errors: unknown[] = [];
    const collect = (value: unknown) => { if (value instanceof AggregateError) for (const nested of value.errors) collect(nested); else errors.push(value); };
    collect(failure); expect(errors[0]).toBe(injected.first); expect(errors.length).toBeGreaterThan(1);
    expect(injected.attempts.slice(1).every(state => state.tasks[0]!.status === 'failed'
      && state.tasks[0]!.error === 'workflow_worker_persistence_failed')).toBe(true);
    expect(fixture.events()).toEqual([]); injected.write.mockRestore();
    expect(readWorkflow(fixture.cwd, name).tasks[0]!).toMatchObject({ attempts: 0, status: 'pending', setupAttempts: [{ outcome: 'completed' }] });
  });
  it('keeps legacy reservation failures terminal and preserves the original write failure as the cause', async () => {
    const configured = await initialize(); const plan = readState().plan;
    await initWorkflow(fixture.cwd, { ...plan, name: 'legacy-persistence', integrationBranch: 'integration/legacy-persistence' }, {
      maxAttempts: 2, workers: 1, maxWorkers: 1, timeoutMs: 15000, backoffMs: 0,
      glmCommand: fileURLToPath(new URL('./helpers/workflow-provider.cjs', import.meta.url)),
    });
    const injected = failReservation(false); const provider = vi.spyOn(processRunner, 'runWorkflowProcess'); const issued = vi.spyOn(publication, 'issueWorkflowPublication');
    await expect(runWorkflow(fixture.cwd, 'legacy-persistence', configured.runtime)).rejects.toMatchObject({ message: 'workflow_worker_persistence_failed', cause: injected.first });
    const state = readWorkflow(fixture.cwd, 'legacy-persistence');
    expect(state.tasks[0]).toMatchObject({ status: 'failed', attempts: 1, error: 'workflow_worker_persistence_failed',
      invocations: [{ outcome: 'failed', error: 'workflow_worker_persistence_failed' }] });
    expect(provider).not.toHaveBeenCalled(); expect(issued).not.toHaveBeenCalled();
  });
  it('inspects and explicitly rejects the exact historical tuple while preserving terminal invocation history', async () => {
    const { before } = await historical(await deadController()); const bytes = snapshot();
    expect(inspectWorkflowTask(fixture.cwd, name, 'a')).toMatchObject({ classification: 'failed', nextAction: 'retry-or-reject' });
    expect(snapshot()).toEqual(bytes);
    const provider = vi.spyOn(processRunner, 'runWorkflowProcess'); const issued = vi.spyOn(publication, 'issueWorkflowPublication');
    const settled = await rejectWorkflowTask(fixture.cwd, name, 'a', 'Inspected pre-provider persistence failure.');
    const after = settled.tasks[0]!;
    expect(after).toMatchObject({ status: 'rejected', attempts: 1, error: 'Inspected pre-provider persistence failure.' });
    expect(after.invocations).toEqual(before.tasks[0]!.invocations); expect(after.setupAttempts).toEqual(before.tasks[0]!.setupAttempts);
    expect(after.task).toEqual(before.tasks[0]!.task); expect((settled as WorkflowStateV2).bindings).toEqual(before.bindings); expect(after.claimToken).toBeUndefined();
    expect(fixture.git('rev-parse', 'HEAD')).toBe(fixture.baseCommit); expect(provider).not.toHaveBeenCalled(); expect(issued).not.toHaveBeenCalled();
  });
  const refusalCases: Array<[string, () => unknown, Record<string, unknown>]> = [
    ['live exact controller', (): WorkflowProviderProcessIdentity => ({ pid: process.pid, processStartedAt: currentProcessStartIdentity() }), {}],
    ['bare live/reused PID', (): WorkflowProviderProcessIdentity => ({ pid: process.pid, processStartedAt: null }), {}],
    ['missing controller', (): undefined => undefined, {}],
    ['malformed controller', (): WorkflowProviderProcessIdentity => ({ pid: process.pid, processStartedAt: 'invalid' }), {}],
    ['recorded provider', () => undefined, { process: { pid: process.pid, processStartedAt: null } }],
    ['recorded process result', () => undefined, { processResult: { passed: false, error: 'launch_failed', parentExitedSuccessfully: false, stdoutTruncated: false } }],
  ];
  it.each(refusalCases)('refuses %s settlement without any saved-state/ref/artifact byte changes', async (_label, controller, changes) => {
    await historical(controller(), changes); const before = snapshot();
    await expect(rejectWorkflowTask(fixture.cwd, name, 'a', 'Do not settle ambiguous evidence.')).rejects.toThrow('workflow_interrupted_worker_requires_inspection');
    expect(snapshot()).toEqual(before);
  });
  it.each(['live provider', 'dead provider', 'process result', 'completed outcome', 'different error'])(
    'refuses a dead-controller tuple with %s without changing retained bytes', async variant => {
      const controller = await deadController(); const changes: Record<string, unknown> = {};
      if (variant === 'live provider') changes.process = { pid: process.pid, processStartedAt: currentProcessStartIdentity() };
      if (variant === 'dead provider') changes.process = await deadController();
      if (variant === 'process result') changes.processResult = { passed: false, error: 'launch_failed', parentExitedSuccessfully: false, stdoutTruncated: false };
      if (variant === 'completed outcome') changes.outcome = 'completed';
      if (variant === 'different error') changes.error = 'workflow_worker_failed';
      await historical(controller, changes); const before = snapshot();
      expect(inspectWorkflowTask(fixture.cwd, name, 'a')).toMatchObject({ classification: 'unverifiable', nextAction: 'inspect' });
      await expect(rejectWorkflowTask(fixture.cwd, name, 'a', 'Preserve the incompatible tuple.')).rejects.toThrow('workflow_interrupted_worker_requires_inspection');
      expect(snapshot()).toEqual(before);
    });
  it('keeps before-effect rejection guards byte-preserving while a permitted changed action persists', async () => {
    await initialize(); const before = snapshot();
    await expect(rejectWorkflowTask(fixture.cwd, name, 'a', 'x'.repeat(1001))).rejects.toThrow('workflow_invalid_text'); expect(snapshot()).toEqual(before);
    const rejected = await rejectWorkflowTask(fixture.cwd, name, 'a', 'A legitimate pending-task disposition.');
    expect(rejected.tasks[0]!.status).toBe('rejected'); expect(snapshot()).not.toEqual(before);
  });
  it('finishes pending canonical projections after a partially durable setup save', async () => {
    const configured = await initialize(); const original = fsUtils.atomicWriteJson; const first = error();
    let latest: WorkflowState | undefined; let failed = false; let projectionWrites = 0;
    vi.spyOn(fsUtils, 'atomicWriteJson').mockImplementation((path, value, mode) => {
      if (path.endsWith('workflow.json')) latest = JSON.parse(JSON.stringify(value)) as WorkflowState;
      if (path.endsWith('task-1.json') && latest?.tasks[0]!.attempts === 0 && latest.tasks[0]!.setupAttempts?.length === 1) {
        projectionWrites++;
        if (!failed) { failed = true; throw first; }
      }
      return original(path, value, mode);
    });
    const provider = vi.spyOn(processRunner, 'runWorkflowProcess'); const issued = vi.spyOn(publication, 'issueWorkflowPublication');
    await expect(runWorkflow(fixture.cwd, name, configured.runtime)).rejects.toBe(first);
    expect(projectionWrites).toBe(2); expect(readState().tasks[0]).toMatchObject({ attempts: 0, status: 'pending', setupAttempts: [{ outcome: 'completed' }] });
    expect(provider).not.toHaveBeenCalled(); expect(issued).not.toHaveBeenCalled();
  });
});
