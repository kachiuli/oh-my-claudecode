import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as workflow from '../workflow.js';
import { createWorkflowFixture } from './helpers/workflow-fixture.js';
import { binding, hash, runtimeFixture } from './helpers/workflow-v2-fixture.js';
import type { WorkflowOptions, WorkflowProviderRoute, WorkflowPlan } from '../workflow-contracts.js';
import { parseWorkflowBinding } from '../workflow-contracts.js';
import * as security from '../../lib/security-config.js';

describe('versioned workflow adapters', () => {
  let fixture: ReturnType<typeof createWorkflowFixture>;
  beforeEach(() => { fixture = createWorkflowFixture(); vi.stubEnv('OMC_STATE_DIR', ''); });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); console.info(`V2 fixture retained: ${fixture.root}`); });
  function plan(): WorkflowPlan {
    const check = { command: process.execPath, args: ['-e', 'process.exit(0)'] };
    return { name: 'roles', objective: 'Exercise explicit roles', baseCommit: fixture.baseCommit, integrationBranch: 'integration/roles',
      verification: [check], sharedContext: 'Complete shared fixture context', tasks: [{ id: 'a', objective: 'Implement the owned component',
        baseCommit: fixture.baseCommit, writeScope: ['feature/a.txt'], readScope: ['README.md'], prohibitedScope: [], dependencies: [],
        contracts: ['One complete owned component'], acceptanceCriteria: ['One committed component passes its declared check'], tests: [check] }] };
  }
  async function init(worker: WorkflowProviderRoute = 'claude', reviewer: WorkflowProviderRoute = 'codex', options: WorkflowOptions = {}) {
    const configured = runtimeFixture(fixture);
    const bindings = { lead: binding('lead', 'codex'), implementer: configured.selectedBinding('implementer', worker, 'actor-author'),
      reviewer: configured.selectedBinding('reviewer', reviewer, 'actor-reviewer') };
    await workflow.initWorkflowV2(fixture.cwd, plan(), bindings, { maxAttempts: 2, maxReviewPasses: 2, backoffMs: 0, ...options });
    return { ...configured, bindings };
  }
  async function integrate(configured: Awaited<ReturnType<typeof init>>) {
    await workflow.runWorkflow(fixture.cwd, 'roles', configured.runtime);
    await workflow.acceptWorkflowTask(fixture.cwd, 'roles', 'a');
    await workflow.verifyWorkflow(fixture.cwd, 'roles');
  }
  const artifact = (file: string) => join(fixture.cwd, '.omc/state/team/roles/artifacts', file);

  it('creates V2 with explicit bindings and leaves inspection byte-preserving', async () => {
    const check = { command: process.execPath, args: ['-e', 'process.exit(0)'] };
    const state = await workflow.initWorkflowV2(fixture.cwd, {
      name: 'roles', objective: 'Exercise explicit workflow roles', baseCommit: fixture.baseCommit,
      integrationBranch: 'integration/roles', verification: [check], tasks: [{
        id: 'a', objective: 'Implement one owned synthetic file', baseCommit: fixture.baseCommit,
        writeScope: ['feature/a.txt'], readScope: ['README.md'], prohibitedScope: [], dependencies: [],
        contracts: ['One complete synthetic file'], acceptanceCriteria: ['File is committed'], tests: [check],
      }],
    }, { lead: binding('lead', 'codex'), implementer: binding('implementer', 'claude'), reviewer: binding('reviewer', 'codex') });
    expect(state).toMatchObject({ schemaVersion: 2, profile: 'role-substitution', reviewPasses: 0 });
    const path = join(fixture.cwd, '.omc/state/team/roles/workflow.json');
    const before = readFileSync(path);
    expect(workflow.readWorkflow(fixture.cwd, 'roles')).toEqual(state);
    expect(readFileSync(path)).toEqual(before);
  });

  it.each([['glm', 'codex'], ['claude', 'codex'], ['glm', 'claude'], ['claude', 'claude']] as const)(
    'runs %s implementation and %s fresh review through real children and shared acceptance', async (worker, reviewer) => {
      const configured = await init(worker, reviewer);
      const produced = await workflow.runWorkflow(fixture.cwd, 'roles', configured.runtime);
      expect(produced.tasks[0].status).toBe('completed');
      expect(produced.tasks[0].invocations?.[0]).toMatchObject({ binding: configured.bindings.implementer, outcome: 'completed', telemetry: { provider: worker } });
      expect(fixture.git('rev-parse', 'HEAD')).toBe(fixture.baseCommit);
      await workflow.acceptWorkflowTask(fixture.cwd, 'roles', 'a');
      await workflow.verifyWorkflow(fixture.cwd, 'roles');
      const reviewed = await workflow.reviewWorkflow(fixture.cwd, 'roles', configured.runtime);
      expect(reviewed.reviewAttempts?.[0]).toMatchObject({ binding: configured.bindings.reviewer, outcome: 'completed', provenance: { relation: 'unknown', context: 'fresh' }, telemetry: { provider: reviewer } });
      expect(reviewed.reviews[0].findings).toEqual([]);
      const events = readFileSync(fixture.eventsPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const implementation = events.find(event => event.role === 'implementer');
      const review = events.find(event => event.role === 'reviewer');
      expect(implementation.args).toContain(configured.bindings.implementer.model);
      expect(implementation.cwd).toBe(produced.tasks[0].worktree);
      expect(review.args).toContain(configured.bindings.reviewer.model);
      expect(review.args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
      expect(review.request.instructions).toContain('Self-review is permitted');
      expect(review.request.sharedContext).toBe('Complete shared fixture context');
      if (reviewer === 'claude') {
        expect(review.args).toEqual(expect.arrayContaining(['--safe-mode', '--restricted', '--tools', 'Read,Glob,Grep', '--permission-mode', 'dontAsk', '--no-session-persistence']));
        expect(review.args).not.toContain('--dangerously-skip-permissions');
        expect(review.args).not.toContain('--resume');
      }
      expect((await workflow.finishWorkflow(fixture.cwd, 'roles')).stage).toBe('complete');
    });

  it('retains failed GLM work and charges a fresh Claude invocation only after explicit substitution', async () => {
    fixture.configure({ tasks: { a: { failBeforeWork: true } } });
    const configured = await init('glm');
    const failed = await workflow.runWorkflow(fixture.cwd, 'roles', configured.runtime);
    expect(failed.tasks[0]).toMatchObject({ status: 'failed', attempts: 1 });
    const old = JSON.stringify(failed.tasks[0].invocations?.[0]);
    const replacement = configured.selectedBinding('implementer', 'claude');
    await workflow.substituteWorkflowBinding(fixture.cwd, 'roles', { role: 'implementer', binding: replacement, expectedHead: fixture.baseCommit,
      reason: 'Inspected synthetic availability failure', authorityRef: 'fixture-decision', taskId: 'a' });
    fixture.configure({});
    const next = await workflow.runWorkflow(fixture.cwd, 'roles', configured.runtime);
    expect(next.tasks[0]).toMatchObject({ status: 'completed', attempts: 2 });
    expect(JSON.stringify(next.tasks[0].invocations?.[0])).toBe(old);
    expect(next.tasks[0].invocations?.[1]).toMatchObject({ mode: 'fresh', binding: replacement });
    expect(readFileSync(artifact('task-a-1.stderr.log'), 'utf8')).toContain('synthetic provider unavailable');
    expect(fixture.git('rev-parse', 'HEAD')).toBe(fixture.baseCommit);
  });

  it('retains a failed Codex review and uses the next pass for explicitly selected Claude', async () => {
    const configured = await init(); await integrate(configured);
    fixture.configure({ tasks: { review: { failBeforeWork: true } } });
    await expect(workflow.reviewWorkflow(fixture.cwd, 'roles', configured.runtime)).rejects.toThrow('workflow_review_process_failed');
    const before = workflow.readWorkflow(fixture.cwd, 'roles');
    const old = JSON.stringify(before.reviewAttempts?.[0]);
    await workflow.substituteWorkflowBinding(fixture.cwd, 'roles', { role: 'reviewer', binding: configured.selectedBinding('reviewer', 'claude'),
      expectedHead: before.integrationHead, reason: 'Inspected failed synthetic reviewer', authorityRef: 'fixture-decision' });
    fixture.configure({ findings: [{ severity: 'P2', message: 'Synthetic guard finding', file: 'feature/a.txt', line: 1 }] });
    const next = await workflow.reviewWorkflow(fixture.cwd, 'roles', configured.runtime);
    expect(next.reviewPasses).toBe(2);
    expect(JSON.stringify(next.reviewAttempts?.[0])).toBe(old);
    expect(next.reviews[0].findings).toHaveLength(1);
    await workflow.adjudicateWorkflow(fixture.cwd, 'roles', [{ findingId: 'review-2-1', disposition: 'dismiss', reason: 'Synthetic finding only' }]);
    await expect(workflow.reviewWorkflow(fixture.cwd, 'roles', configured.runtime)).rejects.toThrow('workflow_review_limit_reached');
    expect(workflow.readWorkflow(fixture.cwd, 'roles').reviewPasses).toBe(2);
  });

  it('records a missing runtime diagnostic without reserving a task or inventing a provider call', async () => {
    await init();
    await expect(workflow.runWorkflow(fixture.cwd, 'roles')).rejects.toThrow('workflow_runtime_required');
    expect(workflow.readWorkflow(fixture.cwd, 'roles').tasks[0]).toMatchObject({ attempts: 0, status: 'pending' });
    expect(readFileSync(fixture.eventsPath, 'utf8')).toBe('');
    const diagnostics = readdirSync(artifact('')).filter(file => file.startsWith('preflight-'));
    expect(diagnostics).toHaveLength(1);
    expect(JSON.parse(readFileSync(artifact(diagnostics[0]), 'utf8'))).toMatchObject({ reserved: false, error: 'workflow_runtime_required' });
  });

  it('isolates actual child routing and redacts private profile secrets without inheriting controller secrets', async () => {
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://synthetic-glm.invalid');
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'parent-glm-private-sentinel');
    vi.stubEnv('CONTROLLER_REDACTION_SECRET', 'parent-only-private-sentinel');
    const configured = await init(); fixture.configure({ tasks: { a: { echoSecret: true } } });
    const state = await workflow.runWorkflow(fixture.cwd, 'roles', configured.runtime);
    expect(state.tasks[0].status).toBe('completed');
    const event = JSON.parse(readFileSync(fixture.eventsPath, 'utf8').split('\n')[0]);
    expect(event.route).toBe('claude');
    expect(event.environmentKeys).not.toEqual(expect.arrayContaining(['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'CONTROLLER_REDACTION_SECRET']));
    expect(readFileSync(artifact('task-a-1.stderr.log'), 'utf8')).toBe('[REDACTED]');
    expect(readFileSync(artifact('task-a-1.result.json'), 'utf8')).not.toContain('synthetic-private-claude-sentinel');
    expect(JSON.stringify(state)).not.toContain('synthetic-private-claude-sentinel');
  });

  it.each(['glm', 'codex'] as const)('blocks external %s under policy while normal Claude remains eligible', async route => {
    const configured = await init(route === 'glm' ? 'glm' : 'claude', route === 'codex' ? 'codex' : 'claude');
    vi.spyOn(security, 'isExternalLLMDisabled').mockReturnValue(true);
    if (route === 'glm') await expect(workflow.runWorkflow(fixture.cwd, 'roles', configured.runtime)).rejects.toThrow('workflow_external_llm_disabled');
    else {
      await integrate(configured);
      await expect(workflow.reviewWorkflow(fixture.cwd, 'roles', configured.runtime)).rejects.toThrow('workflow_external_llm_disabled');
    }
  });

  it.each(['omitStructuredResult', 'conflictingTerminal', 'deepStructured', 'mutateSource', 'mutateRef'])(
    'preserves a failed Claude review and its pass for %s', async defect => {
      const configured = await init('claude', 'claude'); await integrate(configured);
      fixture.configure({ tasks: { review: { [defect]: true } } });
      await expect(workflow.reviewWorkflow(fixture.cwd, 'roles', configured.runtime)).rejects.toThrow(/workflow_/);
      const state = workflow.readWorkflow(fixture.cwd, 'roles');
      expect(state.reviewPasses).toBe(1); expect(state.reviews).toEqual([]);
      expect(state.reviewAttempts?.[0]).toMatchObject({ outcome: 'failed', binding: configured.bindings.reviewer });
      expect(existsSync(artifact('review-1.stdout.log'))).toBe(true);
    });

  it.each(['malformedHandoff', 'omitHandoff', 'omitTests', 'extraCommit', 'mutateRef'])(
    'keeps shared commit and protocol guards for a Claude worker with %s', async defect => {
      const configured = await init(); fixture.configure({ tasks: { a: { [defect]: true } } });
      if (defect === 'mutateRef') await expect(workflow.runWorkflow(fixture.cwd, 'roles', configured.runtime)).rejects.toThrow('workflow_worker_modified_protected_refs');
      else await workflow.runWorkflow(fixture.cwd, 'roles', configured.runtime);
      const state = workflow.readWorkflow(fixture.cwd, 'roles');
      expect(state.tasks[0]).toMatchObject({ status: 'failed', attempts: 1 });
      expect(state.tasks[0].invocations?.[0]).toMatchObject({ outcome: 'failed', binding: configured.bindings.implementer });
      await expect(workflow.acceptWorkflowTask(fixture.cwd, 'roles', 'a')).rejects.toThrow('workflow_task_not_awaiting_acceptance');
    });

  it('allows fresh self-review only when exact-head complete runner authorship identifies the same actor', async () => {
    const configured = await init('claude', 'claude'); await integrate(configured);
    const head = workflow.readWorkflow(fixture.cwd, 'roles').integrationHead;
    const path = join(fixture.root, 'authorship.json');
    const bytes = JSON.stringify({ head, complete: true, authorIds: ['actor-reviewer'] });
    writeFileSync(path, bytes); configured.runtime.reviewAuthorship = { path, sha256: hash(bytes) };
    const state = await workflow.reviewWorkflow(fixture.cwd, 'roles', configured.runtime);
    expect(state.reviewAttempts?.[0]).toMatchObject({ outcome: 'completed', provenance: { relation: 'self-review', context: 'fresh' } });
  });

  it.each(['empty', 'stale', 'incomplete'])('keeps %s authorship evidence unknown despite a known reviewer identity', async defect => {
    const configured = await init('claude', 'claude'); await integrate(configured);
    const head = workflow.readWorkflow(fixture.cwd, 'roles').integrationHead;
    const path = join(fixture.root, 'authorship.json');
    const bytes = JSON.stringify({ head: defect === 'stale' ? fixture.baseCommit : head, complete: defect !== 'incomplete', authorIds: defect === 'empty' ? [] : ['actor-author'] });
    writeFileSync(path, bytes); configured.runtime.reviewAuthorship = { path, sha256: hash(bytes) };
    const state = await workflow.reviewWorkflow(fixture.cwd, 'roles', configured.runtime);
    expect(state.reviewAttempts?.[0]).toMatchObject({ outcome: 'completed', provenance: { relation: 'unknown' } });
  });

  it.each(['model', 'auth', 'evidence', 'route'])('fails %s preflight without consuming an attempt or falling back', async defect => {
    const configured = runtimeFixture(fixture);
    let implementer = configured.selectedBinding('implementer', 'claude');
    const selected = configured.profiles.get(implementer.id)!;
    if (defect === 'model') implementer = parseWorkflowBinding({ ...implementer, model: 'unsupported-selected-model' });
    if (defect === 'auth') selected.authProfile.environment.PRIVATE_TEST_SECRET = 'changed-synthetic-secret';
    if (defect === 'evidence') writeFileSync(selected.capabilityEvidencePath, '{}');
    if (defect === 'route') selected.authProfile.providerRoute = 'glm';
    await workflow.initWorkflowV2(fixture.cwd, plan(), { lead: binding('lead', 'codex'), implementer, reviewer: configured.selectedBinding('reviewer', 'codex') });
    await expect(workflow.runWorkflow(fixture.cwd, 'roles', configured.runtime)).rejects.toThrow(/workflow_/);
    expect(workflow.readWorkflow(fixture.cwd, 'roles').tasks[0].attempts).toBe(0);
    expect(readFileSync(fixture.eventsPath, 'utf8')).toBe('');
  });

  it('redacts an OAuth-file-only secret without adding it to the child environment', async () => {
    const configured = runtimeFixture(fixture); const auth = join(fixture.root, 'private-auth.json');
    const sentinel = 'synthetic-oauth-file-only-value'; writeFileSync(auth, JSON.stringify({ accessToken: sentinel }));
    const implementer = configured.selectedBinding('implementer', 'claude', undefined, '', { files: [auth], environment: { FIXTURE_AUTH_FILE: auth } });
    await workflow.initWorkflowV2(fixture.cwd, plan(), { lead: binding('lead', 'codex'), implementer, reviewer: configured.selectedBinding('reviewer', 'codex') });
    fixture.configure({ tasks: { a: { authFileSecret: true } } });
    await workflow.runWorkflow(fixture.cwd, 'roles', configured.runtime);
    expect(readFileSync(artifact('task-a-1.stderr.log'), 'utf8')).toBe('[REDACTED]');
    const event = JSON.parse(readFileSync(fixture.eventsPath, 'utf8').split('\n')[0]);
    expect(event.environmentKeys.some((key: string) => key.startsWith('PRIVATE_AUTH_SECRET_'))).toBe(false);
  });

  it('rejects profile-file routing that would send normal Claude through GLM', async () => {
    const configured = runtimeFixture(fixture); const auth = join(fixture.root, 'private-routing.json');
    writeFileSync(auth, JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://synthetic-glm.invalid' } }));
    expect(() => configured.selectedBinding('implementer', 'claude', undefined, '', { files: [auth] })).toThrow('workflow_auth_route_mismatch');
    expect(readFileSync(fixture.eventsPath, 'utf8')).toBe('');
  });

  it('keeps exhausted task budgets after a new binding selection', async () => {
    const configured = await init('glm', 'codex', { maxAttempts: 1 });
    fixture.configure({ tasks: { a: { failBeforeWork: true } } });
    await workflow.runWorkflow(fixture.cwd, 'roles', configured.runtime);
    await workflow.substituteWorkflowBinding(fixture.cwd, 'roles', { role: 'implementer', binding: configured.selectedBinding('implementer', 'claude'),
      expectedHead: fixture.baseCommit, reason: 'Inspected availability failure', authorityRef: 'fixture-decision' });
    await expect(workflow.runWorkflow(fixture.cwd, 'roles', configured.runtime)).rejects.toThrow('workflow_attempt_limit_reached');
    expect(workflow.readWorkflow(fixture.cwd, 'roles').tasks[0].attempts).toBe(1);
  });

  it('holds the same lock through dispatch and refuses concurrent role substitution', async () => {
    const configured = await init(); fixture.configure({ tasks: { a: { delayMs: 1200 } } });
    const running = workflow.runWorkflow(fixture.cwd, 'roles', configured.runtime);
    try {
      const deadline = Date.now() + 10000;
      while (!readFileSync(fixture.eventsPath, 'utf8').includes('"event":"start"')) {
        if (Date.now() > deadline) throw new Error('Synthetic child never started');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      await expect(workflow.substituteWorkflowBinding(fixture.cwd, 'roles', { role: 'implementer', binding: configured.selectedBinding('implementer', 'glm'),
        expectedHead: fixture.baseCommit, reason: 'Concurrent selection must not run', authorityRef: 'fixture-decision' })).rejects.toThrow();
    } finally { await running; }
    const state = workflow.readWorkflow(fixture.cwd, 'roles');
    expect(state.tasks[0].status).toBe('completed');
    if (state.schemaVersion !== 2) throw new Error('Expected V2 fixture');
    expect(state.bindings.implementer).toEqual(configured.bindings.implementer); expect(state.substitutions).toEqual([]);
  });

  it.each(['delayMs', 'partialHang', 'commitHang'])('retains a timed-out %s worker and refuses implicit continuation', async phase => {
    const configured = await init('claude', 'codex', { timeoutMs: 1500 });
    fixture.configure({ tasks: { a: { [phase]: phase === 'delayMs' ? 30000 : true } } });
    await workflow.runWorkflow(fixture.cwd, 'roles', configured.runtime);
    const state = workflow.readWorkflow(fixture.cwd, 'roles');
    expect(state.tasks[0]).toMatchObject({ status: 'failed', error: 'workflow_timeout', attempts: 1 });
    expect(state.tasks[0].invocations?.[0]).toMatchObject({ outcome: 'failed', error: 'workflow_timeout' });
    if (phase !== 'delayMs') expect(existsSync(join(state.tasks[0].worktree!, 'feature/a.txt'))).toBe(true);
    await workflow.runWorkflow(fixture.cwd, 'roles', configured.runtime);
    expect(workflow.readWorkflow(fixture.cwd, 'roles').tasks[0].attempts).toBe(1);
  });

  it('never rewrites a settled peer when another worker changes a protected ref', async () => {
    const configured = runtimeFixture(fixture); const input = plan();
    input.tasks.push({ ...input.tasks[0], id: 'b', writeScope: ['feature/b.txt'] });
    await workflow.initWorkflowV2(fixture.cwd, input, { lead: binding('lead', 'codex'), implementer: configured.selectedBinding('implementer', 'claude'),
      reviewer: configured.selectedBinding('reviewer', 'codex') }, { workers: 2, maxAttempts: 1 });
    fixture.configure({ tasks: { b: { delayMs: 1200, mutateRef: true } } });
    await expect(workflow.runWorkflow(fixture.cwd, 'roles', configured.runtime)).rejects.toThrow('workflow_worker_modified_protected_refs');
    const state = workflow.readWorkflow(fixture.cwd, 'roles');
    expect(state.tasks.every(task => task.status === 'failed' && task.error === 'workflow_worker_modified_protected_refs')).toBe(true);
    expect(state.tasks.every(task => task.invocations?.[0].outcome === 'failed')).toBe(true);
    expect(fixture.git('rev-parse', 'main')).not.toBe(fixture.baseCommit);
  });

  it('preserves a previous settled attempt when preflight prevents its next reservation and a peer changes refs', async () => {
    const configured = runtimeFixture(fixture); const input = plan();
    input.tasks.push({ ...input.tasks[0], id: 'b', writeScope: ['feature/b.txt'] });
    await workflow.initWorkflowV2(fixture.cwd, input, { lead: binding('lead', 'codex'), implementer: configured.selectedBinding('implementer', 'claude'),
      reviewer: configured.selectedBinding('reviewer', 'codex') }, { workers: 2, maxAttempts: 2 });
    fixture.configure({ tasks: { a: { failBeforeWork: true }, b: { failBeforeWork: true } } });
    const failed = await workflow.runWorkflow(fixture.cwd, 'roles', configured.runtime);
    const previous = JSON.stringify(failed.tasks[1].invocations?.[0]);
    const originalResolver = configured.runtime.resolveBinding; let calls = 0;
    configured.runtime.resolveBinding = selected => { if (++calls === 2) throw new Error('Synthetic next-route preflight failure'); return originalResolver(selected); };
    fixture.configure({ tasks: { a: { mutateRef: true } } });
    await expect(workflow.runWorkflow(fixture.cwd, 'roles', configured.runtime)).rejects.toThrow('workflow_worker_modified_protected_refs');
    const state = workflow.readWorkflow(fixture.cwd, 'roles');
    expect(state.tasks[1].attempts).toBe(1);
    expect(JSON.stringify(state.tasks[1].invocations?.[0])).toBe(previous);
    expect(state.tasks[0].invocations?.[1].error).toBe('workflow_worker_modified_protected_refs');
  });

  it('resumes only a confirmed same-binding session and reserves a new invocation identity', async () => {
    const configured = await init(); fixture.configure({ tasks: { a: { failBeforeWork: true } } });
    const failed = await workflow.runWorkflow(fixture.cwd, 'roles', configured.runtime);
    expect(failed.tasks[0].session?.confirmed).toBe(true);
    const sessionId = failed.tasks[0].session!.id;
    fixture.configure({});
    const resumed = await workflow.resumeWorkflowTask(fixture.cwd, 'roles', 'a', fixture.baseCommit, 'Inspected pristine synthetic failure', configured.runtime);
    expect(resumed.tasks[0]).toMatchObject({ attempts: 2, status: 'completed', session: { id: sessionId, confirmed: true } });
    expect(resumed.tasks[0].invocations?.[1]).toMatchObject({ mode: 'resume', outcome: 'completed' });
    const events = readFileSync(fixture.eventsPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(events.find(event => event.args.includes('--resume')).args).toContain(sessionId);
  });

  it('refuses a cross-provider resume without charging another attempt', async () => {
    const configured = await init('glm'); fixture.configure({ tasks: { a: { failBeforeWork: true } } });
    await workflow.runWorkflow(fixture.cwd, 'roles', configured.runtime);
    await workflow.substituteWorkflowBinding(fixture.cwd, 'roles', { role: 'implementer', binding: configured.selectedBinding('implementer', 'claude'),
      expectedHead: fixture.baseCommit, reason: 'Explicit new route', authorityRef: 'fixture-decision' });
    await expect(workflow.resumeWorkflowTask(fixture.cwd, 'roles', 'a', fixture.baseCommit, 'Must not reuse another provider session', configured.runtime))
      .rejects.toThrow('workflow_resume_binding_mismatch');
    expect(workflow.readWorkflow(fixture.cwd, 'roles').tasks[0].attempts).toBe(1);
  });

  it.each(['../escape.ts', '.git/config', 'Z:/foreign/a.ts'])(
    'applies the shared authoritative review path guard to Claude result %s', async file => {
      const configured = await init('claude', 'claude'); await integrate(configured);
      fixture.configure({ findings: [{ severity: 'P2', message: 'Synthetic path guard', file, line: 1 }] });
      await expect(workflow.reviewWorkflow(fixture.cwd, 'roles', configured.runtime)).rejects.toThrow('workflow_invalid_scope');
      expect(JSON.parse(readFileSync(artifact('review-1.result.json'), 'utf8')).findings[0].file).toBe(file);
      expect(workflow.readWorkflow(fixture.cwd, 'roles').reviews).toEqual([]);
    });

  it('replays checks and rejects out-of-scope owned commits instead of trusting the substitute', async () => {
    const configured = await init(); fixture.configure({ tasks: { a: { file: 'outside.txt' } } });
    const state = await workflow.runWorkflow(fixture.cwd, 'roles', configured.runtime);
    expect(state.tasks[0]).toMatchObject({ status: 'failed', error: 'workflow_out_of_scope_changes' });
    expect(existsSync(join(state.tasks[0].worktree!, 'outside.txt'))).toBe(true);
  });

  it('keeps dependency tasks pending until explicit acceptance and includes complete accepted criteria', async () => {
    const configured = runtimeFixture(fixture); const input = plan();
    input.tasks.push({ ...input.tasks[0], id: 'b', writeScope: ['feature/b.txt'], dependencies: ['a'] });
    await workflow.initWorkflowV2(fixture.cwd, input, { lead: binding('lead', 'codex'), implementer: configured.selectedBinding('implementer', 'claude'),
      reviewer: configured.selectedBinding('reviewer', 'codex') });
    const first = await workflow.runWorkflow(fixture.cwd, 'roles', configured.runtime);
    expect(first.tasks.map(task => task.status)).toEqual(['completed', 'pending']);
    await workflow.acceptWorkflowTask(fixture.cwd, 'roles', 'a');
    const next = await workflow.runWorkflow(fixture.cwd, 'roles', configured.runtime);
    expect(next.tasks[1].status).toBe('completed');
    const events = readFileSync(fixture.eventsPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const dependent = events.find(event => event.request.task?.id === 'b');
    expect(dependent.request.acceptedDependencies[0].taskId).toBe('a');
    expect(dependent.request.task.acceptanceCriteria).toEqual(input.tasks[1].acceptanceCriteria);
  });

  it('reports historical Claude work separately from a later selected GLM binding', async () => {
    const configured = await init(); await workflow.runWorkflow(fixture.cwd, 'roles', configured.runtime);
    await workflow.substituteWorkflowBinding(fixture.cwd, 'roles', { role: 'implementer', binding: configured.selectedBinding('implementer', 'glm'),
      expectedHead: fixture.baseCommit, reason: 'Select a route for future work', authorityRef: 'fixture-decision' });
    expect(workflow.workflowStatus(fixture.cwd, 'roles')).toMatchObject({ schemaVersion: 2, substitutionCount: 1,
      tasks: [{ provider: 'claude', model: configured.bindings.implementer.model, selectedBinding: { provider: 'glm' } }] });
  });

  it.each(['codex', 'claude'] as const)('collects six findings through %s and retains the raw metadata for lead adjudication', async reviewer => {
    const configured = await init('claude', reviewer); await integrate(configured);
    const findings = Array.from({ length: 6 }, (_, index) => ({ severity: index < 4 ? 'P2' : 'P3', message: `Synthetic finding ${index + 1}`,
      file: join(fixture.cwd, 'feature/a.txt').replaceAll('\\', '/'), line: index + 1 }));
    fixture.configure({ findings });
    const reviewed = await workflow.reviewWorkflow(fixture.cwd, 'roles', configured.runtime);
    expect(reviewed.reviews[0].findings.map(finding => finding.file)).toEqual(Array(6).fill('feature/a.txt'));
    expect(JSON.parse(readFileSync(artifact('review-1.result.json'), 'utf8'))).toEqual({ findings });
    const adjudicated = await workflow.adjudicateWorkflow(fixture.cwd, 'roles', reviewed.reviews[0].findings.map(finding => ({
      findingId: finding.id, disposition: 'dismiss', reason: 'Synthetic metadata collection' })));
    expect(adjudicated.reviews[0].findings.every(finding => finding.disposition === 'dismiss')).toBe(true);
  });

  it('refuses unsupported same-session review capability before reserving a pass', async () => {
    const configured = await init(); await integrate(configured);
    const replacement = parseWorkflowBinding({ ...configured.selectedBinding('reviewer', 'claude'), capabilities: ['structured-findings', 'read-only', 'review-permission-transition'] });
    await workflow.substituteWorkflowBinding(fixture.cwd, 'roles', { role: 'reviewer', binding: replacement,
      expectedHead: workflow.readWorkflow(fixture.cwd, 'roles').integrationHead, reason: 'Synthetic unsupported capability check', authorityRef: 'fixture-decision' });
    await expect(workflow.reviewWorkflow(fixture.cwd, 'roles', configured.runtime)).rejects.toThrow('workflow_review_transition_unsupported');
    expect(workflow.readWorkflow(fixture.cwd, 'roles').reviewPasses).toBe(0);
  });

  it('fails a claimed successful worker when the declared local check actually fails', async () => {
    const configured = runtimeFixture(fixture); const input = plan(); input.tasks[0].tests[0].args = ['-e', 'process.exit(4)'];
    await workflow.initWorkflowV2(fixture.cwd, input, { lead: binding('lead', 'codex'), implementer: configured.selectedBinding('implementer', 'claude'),
      reviewer: configured.selectedBinding('reviewer', 'codex') });
    const state = await workflow.runWorkflow(fixture.cwd, 'roles', configured.runtime);
    expect(state.tasks[0]).toMatchObject({ status: 'failed', error: 'workflow_worker_test_failed' });
    await expect(workflow.acceptWorkflowTask(fixture.cwd, 'roles', 'a')).rejects.toThrow('workflow_task_not_awaiting_acceptance');
  });

  it('supplies removed source and ignored root instructions to a restricted Claude reviewer', async () => {
    writeFileSync(join(fixture.cwd, '.git/info/exclude'), 'AGENTS.md\n');
    writeFileSync(join(fixture.cwd, 'AGENTS.md'), 'Keep the complete synthetic source guard contract.\n');
    const configured = runtimeFixture(fixture); const input = plan(); input.tasks[0].writeScope = ['README.md'];
    await workflow.initWorkflowV2(fixture.cwd, input, { lead: binding('lead', 'codex'), implementer: configured.selectedBinding('implementer', 'claude'),
      reviewer: configured.selectedBinding('reviewer', 'claude') });
    await workflow.runWorkflow(fixture.cwd, 'roles', configured.runtime);
    await workflow.acceptWorkflowTask(fixture.cwd, 'roles', 'a'); await workflow.verifyWorkflow(fixture.cwd, 'roles');
    await workflow.reviewWorkflow(fixture.cwd, 'roles', configured.runtime);
    const events = readFileSync(fixture.eventsPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const request = events.find(event => event.role === 'reviewer').request;
    expect(request.changes).toContain('-# Workflow fixture');
    expect(request.changes).toContain('+complete synthetic component');
    expect(request.projectInstructions).toContainEqual({ path: 'AGENTS.md', content: 'Keep the complete synthetic source guard contract.\n' });
  });
});
