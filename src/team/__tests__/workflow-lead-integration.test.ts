import { linkSync, mkdirSync, readFileSync, readdirSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acceptWorkflowTask, extendWorkflowReviewBudget, finishWorkflow, initWorkflow, integrateWorkflowLeadCommit, readWorkflow,
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
    const run = await runWorkflow(fixture.cwd, name);
    expect(run.tasks.map(entry => ({ status: entry.status, error: entry.error })))
      .toEqual(tasks.map(() => ({ status: 'completed', error: undefined })));
    for (const entry of tasks) await acceptWorkflowTask(fixture.cwd, name, entry.id);
  }
  function commit(path = 'registry/pins.txt', content = 'pin=v1\n') {
    const parent = fixture.git('rev-parse', 'HEAD');
    mkdirSync(dirname(join(fixture.cwd, path)), { recursive: true });
    writeFileSync(join(fixture.cwd, path), content);
    fixture.git('add', '-f', '--', path);
    fixture.git('commit', '-m', 'Pin integrated registry');
    return { parent, head: fixture.git('rev-parse', 'HEAD'), path };
  }
  function intent(change: ReturnType<typeof commit>, overrides: Partial<WorkflowLeadIntegrationIntent> = {}): WorkflowLeadIntegrationIntent {
    return { expectedParent: change.parent, expectedHead: change.head, actor: { id: 'unknown', model: 'unknown' },
      authorityRef: 'issue-39-approved', reason: 'Pin the shared registry after native tasks settled.', paths: [change.path],
      checks: [passingCheck], ...overrides };
  }

  it.each(['registry/pins.txt', '.omc/routing.md'])('adopts one direct child for %s with evidence and normal verification/review gates', async path => {
    await settle();
    const before = readWorkflow(fixture.cwd, name);
    const change = commit(path);
    const events = fixture.events();
    const integrated = await integrateWorkflowLeadCommit(fixture.cwd, name, intent(change));
    expect(integrated.integrationHead).toBe(change.head);
    expect(integrated.tasks).toEqual(before.tasks);
    expect(integrated.reviews).toEqual(before.reviews);
    expect(integrated.reviewAttempts).toEqual(before.reviewAttempts);
    expect(fixture.events()).toEqual(events);
    expect(fixture.git('show', `${change.head}:${path}`)).toBe('pin=v1');
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

  it.each(['registry/pins.txt', '.omc/routing.md'])('does not let a stale successful review complete an updated %s', async path => {
    fixture.baseCommit = commit(path, 'pin=initial\n').head;
    await settle([task('a')]);
    await verifyWorkflow(fixture.cwd, name);
    await reviewWorkflow(fixture.cwd, name);
    const reviewedHead = readWorkflow(fixture.cwd, name).reviews.at(-1)!.head;
    const before = readWorkflow(fixture.cwd, name);
    const change = commit(path);
    const integrated = await integrateWorkflowLeadCommit(fixture.cwd, name, intent(change));
    expect(integrated.tasks).toEqual(before.tasks);
    expect(integrated.reviews).toEqual(before.reviews);
    expect(integrated.reviewAttempts).toEqual(before.reviewAttempts);
    expect(reviewedHead).toBe(change.parent);
    await verifyWorkflow(fixture.cwd, name);
    await expect(finishWorkflow(fixture.cwd, name)).rejects.toThrow('workflow_current_review_required');
    await reviewWorkflow(fixture.cwd, name);
    await finishWorkflow(fixture.cwd, name);
  }, 60_000);

  it('retains a routing-policy review finding and requires its adjudication before completion or another lead integration', async () => {
    await settle([task('a')]);
    const change = commit('.omc/routing.md');
    await integrateWorkflowLeadCommit(fixture.cwd, name, intent(change));
    await verifyWorkflow(fixture.cwd, name);
    fixture.configure({ findings: [{ severity: 'P1', message: 'Correct the routing policy.', file: '.omc/routing.md', line: 1 }] });
    const reviewed = await reviewWorkflow(fixture.cwd, name);
    expect(reviewed.reviews.at(-1)?.findings[0]).toMatchObject({ file: '.omc/routing.md', severity: 'P1' });
    await expect(finishWorkflow(fixture.cwd, name)).rejects.toThrow('workflow_unresolved_findings');
    const correction = commit('.omc/routing.md', 'pin=v2\n');
    await expect(integrateWorkflowLeadCommit(fixture.cwd, name, intent(correction)))
      .rejects.toThrow('workflow_findings_require_adjudication_or_fix');
    expect(readWorkflow(fixture.cwd, name).reviews).toEqual(reviewed.reviews);
    expect(readWorkflow(fixture.cwd, name).leadIntegrations).toEqual(reviewed.leadIntegrations);
  }, 60_000);

  it('requires settled tasks before adopting a routing policy', async () => {
    await initWorkflow(fixture.cwd, plan([task('a')]), options);
    const change = commit('.omc/routing.md');
    await expect(integrateWorkflowLeadCommit(fixture.cwd, name, intent(change))).rejects.toThrow('workflow_integration_incomplete');
    expect(readWorkflow(fixture.cwd, name).integrationHead).toBe(change.parent);
    expect(fixture.events()).toEqual([]);
  }, 60_000);

  it('does not resolve the root routing exception relative to a nested workflow cwd', async () => {
    fixture.baseCommit = commit('nested/.omc/routing.md').head;
    const cwd = join(fixture.cwd, 'nested');
    await initWorkflow(cwd, plan([task('a')]), options);
    await runWorkflow(cwd, name);
    await acceptWorkflowTask(cwd, name, 'a');
    const change = commit('.omc/routing.md');
    await expect(integrateWorkflowLeadCommit(cwd, name, intent(change)))
      .rejects.toThrow('workflow_lead_integration_routing_policy_invalid');
    expect(readWorkflow(cwd, name).integrationHead).toBe(change.parent);
    expect(readWorkflow(cwd, name).leadIntegrations).toBeUndefined();
  }, 60_000);

  it('refuses undeclared files and failing checks when adopting a routing policy', async () => {
    await settle([task('a')]);
    const change = commit('.omc/routing.md');
    await expect(integrateWorkflowLeadCommit(fixture.cwd, name, intent(change, { paths: ['README.md'] })))
      .rejects.toThrow('workflow_lead_integration_changed_files_mismatch');
    await expect(integrateWorkflowLeadCommit(fixture.cwd, name, intent(change, {
      checks: [{ command: process.execPath, args: ['-e', 'process.exit(1)'] }],
    }))).rejects.toThrow('workflow_lead_integration_check_failed');
    expect(readWorkflow(fixture.cwd, name).integrationHead).toBe(change.parent);
    expect(readWorkflow(fixture.cwd, name).leadIntegrations).toBeUndefined();
  }, 60_000);

  it.each(['delete', 'untrack'])('refuses to %s routing policy even if an ignored regular copy remains', async operation => {
    fixture.baseCommit = commit('.omc/routing.md').head;
    await settle([task('a')]);
    const parent = fixture.git('rev-parse', 'HEAD');
    fixture.git('rm', ...(operation === 'untrack' ? ['--cached'] : []), '--', '.omc/routing.md');
    fixture.git('commit', '-m', 'Remove routing policy from source');
    const change = { parent, head: fixture.git('rev-parse', 'HEAD'), path: '.omc/routing.md' };
    await expect(integrateWorkflowLeadCommit(fixture.cwd, name, intent(change)))
      .rejects.toThrow('workflow_lead_integration_routing_policy_invalid');
    expect(readWorkflow(fixture.cwd, name).integrationHead).toBe(parent);
    expect(readWorkflow(fixture.cwd, name).leadIntegrations).toBeUndefined();
  }, 60_000);

  it.for(['hardlink', 'directory', 'case collision', 'parent symlink'])('rejects a routing policy with a %s before running checks', { timeout: 60_000 }, async (hazard, { skip }) => {
    await settle([task('a')]);
    const change = commit('.omc/routing.md');
    const path = join(fixture.cwd, change.path);
    if (hazard === 'hardlink') linkSync(path, join(fixture.cwd, '.omc', 'policy-copy.md'));
    if (hazard === 'directory') {
      fixture.git('update-index', '--assume-unchanged', '--', change.path);
      unlinkSync(path); mkdirSync(path);
    }
    if (hazard === 'case collision') {
      writeFileSync(join(fixture.cwd, '.omc', 'ROUTING.MD'), 'collision\n');
      if (!readdirSync(join(fixture.cwd, '.omc')).includes('ROUTING.MD')) skip('Filesystem folds case collisions into one file');
    }
    if (hazard === 'parent symlink') {
      const target = join(fixture.root, 'runtime');
      renameSync(join(fixture.cwd, '.omc'), target);
      symlinkSync(target, join(fixture.cwd, '.omc'), process.platform === 'win32' ? 'junction' : 'dir');
    }
    const marker = join(fixture.root, 'check-ran');
    await expect(integrateWorkflowLeadCommit(fixture.cwd, name, intent(change, {
      checks: [{ command: process.execPath, args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`] }],
    }))).rejects.toThrow(hazard === 'parent symlink' ? 'workflow_integration_worktree_dirty' : 'workflow_lead_integration_routing_policy_invalid');
    expect(() => readFileSync(marker)).toThrow();
    expect(readWorkflow(fixture.cwd, name).integrationHead).toBe(change.parent);
  });

  it.each(['--assume-unchanged', '--skip-worktree'])('refuses routing content hidden by %s before running checks', async flag => {
    await settle([task('a')]);
    const change = commit('.omc/routing.md');
    fixture.git('update-index', flag, '--', change.path);
    writeFileSync(join(fixture.cwd, change.path), 'uncommitted routing policy\n');
    expect(fixture.git('status', '--porcelain')).toBe('');
    const marker = join(fixture.root, 'check-ran');
    await expect(integrateWorkflowLeadCommit(fixture.cwd, name, intent(change, {
      checks: [{ command: process.execPath, args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`] }],
    }))).rejects.toThrow('workflow_lead_integration_routing_policy_invalid');
    expect(() => readFileSync(marker)).toThrow();
    expect(readWorkflow(fixture.cwd, name).integrationHead).toBe(change.parent);
    expect(readWorkflow(fixture.cwd, name).leadIntegrations).toBeUndefined();
  }, 60_000);

  it.each([
    ['--assume-unchanged', false], ['--assume-unchanged', true],
    ['--skip-worktree', false], ['--skip-worktree', true],
  ] as const)('refuses a check adding %s (hidden content: %s)', async (flag, changeContent) => {
    await settle([task('a')]);
    const change = commit('.omc/routing.md');
    await expect(integrateWorkflowLeadCommit(fixture.cwd, name, intent(change, {
      checks: [{ command: process.execPath, args: ['-e',
        `require('node:child_process').execFileSync('git', ['update-index', '${flag}', '--', '.omc/routing.md']);`
        + (changeContent ? "require('node:fs').writeFileSync('.omc/routing.md', 'hidden content\\n');" : '')] }],
    }))).rejects.toThrow('workflow_lead_integration_repository_changed');
    expect(fixture.git('status', '--porcelain')).toBe('');
    expect(readWorkflow(fixture.cwd, name).integrationHead).toBe(change.parent);
    expect(readWorkflow(fixture.cwd, name).leadIntegrations).toBeUndefined();
  }, 60_000);

  it('accepts regular tracked routing content with Git CRLF normalization', async () => {
    fixture.git('config', 'core.autocrlf', 'true');
    await settle([task('a')]);
    const change = commit('.omc/routing.md', 'pin=v1\r\n');
    expect(readFileSync(join(fixture.cwd, change.path), 'utf8')).toContain('\r\n');
    expect(fixture.git('show', `${change.head}:${change.path}`)).toBe('pin=v1');
    expect((await integrateWorkflowLeadCommit(fixture.cwd, name, intent(change))).integrationHead).toBe(change.head);
  }, 60_000);

  it.skipIf(process.platform === 'win32')('rejects a tracked routing symlink even in a clean checkout', async () => {
    await settle([task('a')]);
    const parent = fixture.git('rev-parse', 'HEAD');
    symlinkSync('../README.md', join(fixture.cwd, '.omc', 'routing.md'));
    fixture.git('add', '-f', '--', '.omc/routing.md');
    fixture.git('commit', '-m', 'Add routing symlink');
    const change = { parent, head: fixture.git('rev-parse', 'HEAD'), path: '.omc/routing.md' };
    await expect(integrateWorkflowLeadCommit(fixture.cwd, name, intent(change)))
      .rejects.toThrow('workflow_lead_integration_routing_policy_invalid');
    expect(readWorkflow(fixture.cwd, name).integrationHead).toBe(parent);
  }, 60_000);

  it('rechecks routing file identity after checks without losing prior integration evidence', async () => {
    await settle([task('a')]);
    const first = commit('.omc/routing.md');
    const before = await integrateWorkflowLeadCommit(fixture.cwd, name, intent(first));
    const change = commit('.omc/routing.md', 'pin=v2\n');
    await expect(integrateWorkflowLeadCommit(fixture.cwd, name, intent(change, {
      checks: [{ command: process.execPath, args: ['-e', "require('node:fs').linkSync('.omc/routing.md', '.omc/policy-copy.md')"] }],
    }))).rejects.toThrow('workflow_lead_integration_repository_changed');
    const saved = readWorkflow(fixture.cwd, name);
    expect(saved.integrationHead).toBe(first.head);
    expect(saved.leadIntegrations).toEqual(before.leadIntegrations);
    expect(saved.tasks).toEqual(before.tasks);
  }, 60_000);

  it('adopts a lead commit at an exhausted checkpoint while still requiring fresh verification and review authorization', async () => {
    await settle([task('a')], { ...options, maxReviewPasses: 1 });
    await verifyWorkflow(fixture.cwd, name);
    await reviewWorkflow(fixture.cwd, name);
    const change = commit();
    const integrated = await integrateWorkflowLeadCommit(fixture.cwd, name, intent(change));
    expect(integrated.integrationHead).toBe(change.head);
    await expect(finishWorkflow(fixture.cwd, name)).rejects.toThrow('workflow_current_verification_required');
    await extendWorkflowReviewBudget(fixture.cwd, name, { requestId: 'post-lead-integration-review',
      expectedHead: change.head, expectedCeiling: 1, increment: 1, actor: { id: 'unknown', model: 'unknown' },
      authorityRef: 'lead-review-decision', reason: 'Authorize review of the adopted lead commit.' });
    await verifyWorkflow(fixture.cwd, name);
    await expect(finishWorkflow(fixture.cwd, name)).rejects.toThrow('workflow_current_review_required');
    await reviewWorkflow(fixture.cwd, name);
    expect((await finishWorkflow(fixture.cwd, name)).stage).toBe('complete');
  }, 60_000);

  it('refuses to adopt a lead commit while an interrupted review remains unsettled', async () => {
    await settle([task('a')], { ...options, maxReviewPasses: 1 });
    const stateFile = join(fixture.cwd, '.omc', 'state', 'team', name, 'workflow.json');
    const raw = JSON.parse(readFileSync(stateFile, 'utf8'));
    raw.reviewPasses = 1;
    raw.reviewAttempts = [{ orchestrationHost: 'claude', pass: 1, head: raw.integrationHead,
      startedAt: new Date().toISOString(), outcome: 'failed', error: 'workflow_invocation_incomplete', artifacts: [],
      telemetry: { provider: 'codex', durationMs: 0, status: 'unknown', scope: 'unknown' } }];
    writeFileSync(stateFile, JSON.stringify(raw));
    const change = commit();

    await expect(integrateWorkflowLeadCommit(fixture.cwd, name, intent(change)))
      .rejects.toThrow('workflow_interrupted_review_requires_inspection');

    const saved = readWorkflow(fixture.cwd, name);
    expect(saved.integrationHead).toBe(change.parent);
    expect(saved.leadIntegrations).toBeUndefined();
    expect(saved.reviewAttempts?.at(-1)?.error).toBe('workflow_invocation_incomplete');
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
