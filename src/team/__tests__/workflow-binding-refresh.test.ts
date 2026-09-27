import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseWorkflowBinding, type WorkflowPlan, type WorkflowRoleBinding } from '../workflow-contracts.js';
import { initWorkflowV2, probeWorkflowBinding, readWorkflow, refreshWorkflowBinding, runWorkflow,
  workflowRouting, workflowStatus } from '../workflow.js';
import { binding, hash, runtimeFixture } from './helpers/workflow-v2-fixture.js';
import { createWorkflowFixture } from './helpers/workflow-fixture.js';
import { workflowCommand } from '../../cli/commands/team-workflow.js';

describe('workflow binding refresh and effective routing', () => {
  let fixture: ReturnType<typeof createWorkflowFixture>;
  beforeEach(() => { fixture = createWorkflowFixture(); vi.stubEnv('OMC_STATE_DIR', ''); });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); fixture.dispose(); });

  function plan(): WorkflowPlan {
    const check = { command: process.execPath, args: ['-e', 'process.exit(0)'] };
    return { name: 'binding-refresh', objective: 'Exercise receipt-covered routing changes',
      baseCommit: fixture.baseCommit, integrationBranch: 'integration/binding-refresh', verification: [check],
      tasks: [{ id: 'a', objective: 'Write the synthetic component', baseCommit: fixture.baseCommit,
        writeScope: ['feature/a.txt'], readScope: ['README.md'], prohibitedScope: [], dependencies: [],
        contracts: ['Keep the route explicit'], acceptanceCriteria: ['The component is committed'], tests: [check] }] };
  }

  function addCoveredModel(selected: WorkflowRoleBinding, path: string, model: string, effort: string): WorkflowRoleBinding {
    const evidence = JSON.parse(readFileSync(path, 'utf8')) as { models: Array<{ model: string; efforts: Array<string | null> }> };
    evidence.models.push({ model, efforts: [effort] });
    const bytes = JSON.stringify(evidence);
    writeFileSync(path, bytes);
    return parseWorkflowBinding({ ...selected, capabilityEvidenceSha256: hash(bytes) });
  }

  it('previews, probes and refreshes a covered route without exposing evidence or calling a provider', async () => {
    const configured = runtimeFixture(fixture);
    let implementer = configured.selectedBinding('implementer', 'claude', 'actor-author');
    implementer = addCoveredModel(implementer, configured.profiles.get(implementer.id)!.capabilityEvidencePath,
      'claude-covered-model', 'high');
    await initWorkflowV2(fixture.cwd, plan(), { lead: binding('lead', 'codex'), implementer,
      reviewer: configured.selectedBinding('reviewer', 'codex') });
    const intent = { role: 'implementer', sourceBindingId: implementer.id, newBindingId: 'implementer-claude-covered',
      model: 'claude-covered-model', effort: 'high', expectedHead: fixture.baseCommit,
      reason: 'Use a model already covered by authenticated capability evidence', authorityRef: 'release-v1.6', taskId: 'a' };

    const initial = workflowRouting(fixture.cwd, 'binding-refresh');
    expect(initial).toMatchObject({ schemaVersion: 2, roles: [
      { role: 'lead', selectionSource: { kind: 'initial-binding' } },
      { role: 'implementer', id: implementer.id, provider: 'claude', selectionSource: { kind: 'initial-binding' } },
      { role: 'reviewer', selectionSource: { kind: 'initial-binding' } },
    ] });
    const initialText = JSON.stringify(initial);
    expect(initialText).not.toContain(implementer.authFingerprint);
    expect(initialText).not.toContain(implementer.capabilityEvidenceSha256);
    expect(initialText).not.toContain(implementer.executableIdentity!.path);

    const before = JSON.stringify(readWorkflow(fixture.cwd, 'binding-refresh'));
    expect(probeWorkflowBinding(fixture.cwd, 'binding-refresh', intent, configured.runtime)).toMatchObject({
      ready: true, validation: 'synthetic', providerCalled: false, sourceBindingId: implementer.id,
      candidate: { id: 'implementer-claude-covered', provider: 'claude', model: 'claude-covered-model', effort: 'high' },
    });
    expect(JSON.stringify(readWorkflow(fixture.cwd, 'binding-refresh'))).toBe(before);
    expect(readFileSync(fixture.eventsPath, 'utf8')).toBe('');

    await refreshWorkflowBinding(fixture.cwd, 'binding-refresh', intent, configured.runtime);
    const refreshed = workflowRouting(fixture.cwd, 'binding-refresh');
    expect(refreshed).toMatchObject({ roles: expect.arrayContaining([
      expect.objectContaining({ role: 'implementer', id: 'implementer-claude-covered', model: 'claude-covered-model',
        selectionSource: { kind: 'substitution', sequence: 1 } }),
    ]) });
    const completed = await runWorkflow(fixture.cwd, 'binding-refresh', configured.runtime);
    expect(completed.tasks[0]).toMatchObject({ status: 'completed', invocations: [expect.objectContaining({
      binding: expect.objectContaining({ id: 'implementer-claude-covered', model: 'claude-covered-model', effort: 'high' }),
    })] });
  });

  it('chains A to B to C through the one unchanged runtime receipt keyed only by A, then dispatches C', async () => {
    const configured = runtimeFixture(fixture);
    let implementer = configured.selectedBinding('implementer', 'claude', 'actor-author');
    const evidencePath = configured.profiles.get(implementer.id)!.capabilityEvidencePath;
    implementer = addCoveredModel(implementer, evidencePath, 'claude-covered-b', 'high');
    implementer = addCoveredModel(implementer, evidencePath, 'claude-covered-c', 'max');
    await initWorkflowV2(fixture.cwd, plan(), { lead: binding('lead', 'codex'), implementer,
      reviewer: configured.selectedBinding('reviewer', 'codex') });
    const evidenceBefore = readFileSync(evidencePath, 'utf8');
    const runtimeIdsBefore = [...configured.profiles.keys()];
    await refreshWorkflowBinding(fixture.cwd, 'binding-refresh', {
      role: 'implementer', sourceBindingId: implementer.id, newBindingId: 'implementer-covered-b',
      model: 'claude-covered-b', effort: 'high', expectedHead: fixture.baseCommit,
      reason: 'Select the first covered model', authorityRef: 'release-v1.6', taskId: 'a',
    }, configured.runtime);
    await refreshWorkflowBinding(fixture.cwd, 'binding-refresh', {
      role: 'implementer', sourceBindingId: 'implementer-covered-b', newBindingId: 'implementer-covered-c',
      model: 'claude-covered-c', effort: 'max', expectedHead: fixture.baseCommit,
      reason: 'Select the second covered model', authorityRef: 'release-v1.6', taskId: 'a',
    }, configured.runtime);
    expect([...configured.profiles.keys()]).toEqual(runtimeIdsBefore);
    expect(configured.profiles.has('implementer-covered-b')).toBe(false);
    expect(configured.profiles.has('implementer-covered-c')).toBe(false);
    expect(readFileSync(evidencePath, 'utf8')).toBe(evidenceBefore);
    const completed = await runWorkflow(fixture.cwd, 'binding-refresh', configured.runtime);
    expect(completed).toMatchObject({ substitutions: [{ to: { id: 'implementer-covered-b' } },
      { from: { id: 'implementer-covered-b' }, to: { id: 'implementer-covered-c' } }],
    tasks: [{ status: 'completed', invocations: [{ binding: { id: 'implementer-covered-c', model: 'claude-covered-c', effort: 'max' } }] }] });
  });

  it.each([
    ['dirty worktree', 'workflow_integration_worktree_dirty', (fixture: ReturnType<typeof createWorkflowFixture>) => {
      writeFileSync(join(fixture.cwd, 'dirty.txt'), 'dirty\n');
    }],
    ['wrong branch', 'workflow_integration_branch_mismatch', (fixture: ReturnType<typeof createWorkflowFixture>) => {
      fixture.git('switch', '-c', 'unrelated/probe');
    }],
    ['diverged head', 'workflow_integration_head_changed', (fixture: ReturnType<typeof createWorkflowFixture>) => {
      writeFileSync(join(fixture.cwd, 'diverged.txt'), 'diverged\n');
      fixture.git('add', 'diverged.txt'); fixture.git('commit', '-m', 'Diverge probe head');
    }],
  ] as const)('refuses a binding probe from a %s', async (_case, expected, mutateRepository) => {
    const configured = runtimeFixture(fixture);
    let implementer = configured.selectedBinding('implementer', 'claude');
    implementer = addCoveredModel(implementer, configured.profiles.get(implementer.id)!.capabilityEvidencePath,
      'claude-covered-model', 'high');
    await initWorkflowV2(fixture.cwd, plan(), { lead: binding('lead', 'codex'), implementer,
      reviewer: configured.selectedBinding('reviewer', 'codex') });
    mutateRepository(fixture);
    expect(() => probeWorkflowBinding(fixture.cwd, 'binding-refresh', {
      role: 'implementer', sourceBindingId: implementer.id, newBindingId: 'implementer-covered',
      model: 'claude-covered-model', effort: 'high', expectedHead: fixture.baseCommit,
      reason: 'Probe only from the saved integration point', authorityRef: 'release-v1.6',
    }, configured.runtime)).toThrow(expected);
    const saved = readWorkflow(fixture.cwd, 'binding-refresh');
    if (saved.schemaVersion !== 2) throw new Error('Expected V2');
    expect(saved.substitutions).toEqual([]);
  });

  it('accepts a genuinely authenticated receipt through the private CLI runtime loader', async () => {
    const configured = runtimeFixture(fixture);
    let implementer = configured.selectedBinding('implementer', 'claude', 'actor-author');
    const selected = configured.profiles.get(implementer.id)!;
    implementer = addCoveredModel(implementer, selected.capabilityEvidencePath, 'claude-authenticated-model', 'high');
    const evidence = JSON.parse(readFileSync(selected.capabilityEvidencePath, 'utf8')) as Record<string, unknown>;
    evidence.validation = 'authenticated';
    const evidenceBytes = JSON.stringify(evidence); writeFileSync(selected.capabilityEvidencePath, evidenceBytes);
    implementer = parseWorkflowBinding({ ...implementer, capabilityEvidenceSha256: hash(evidenceBytes) });
    await initWorkflowV2(fixture.cwd, plan(), { lead: binding('lead', 'codex'), implementer,
      reviewer: configured.selectedBinding('reviewer', 'codex') });
    const runtimePath = join(fixture.root, 'authenticated-runtime.json');
    writeFileSync(runtimePath, JSON.stringify({ schemaVersion: 1, profiles: {
      [selected.authProfile.ref]: { providerRoute: selected.authProfile.providerRoute,
        environment: selected.authProfile.environment, files: selected.authProfile.files },
    }, capabilityEvidence: { [implementer.id]: selected.capabilityEvidencePath } }));
    const intentPath = join(fixture.root, 'authenticated-refresh.json');
    writeFileSync(intentPath, JSON.stringify({ role: 'implementer', sourceBindingId: implementer.id,
      newBindingId: 'implementer-authenticated', model: 'claude-authenticated-model', effort: 'high',
      expectedHead: fixture.baseCommit, reason: 'Use receipt-covered authenticated route', authorityRef: 'release-v1.6' }));
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await workflowCommand(['probe-binding', 'binding-refresh', '--file', intentPath, '--runtime', runtimePath], fixture.cwd);
    const printed = String(output.mock.calls.at(-1)?.[0]);
    expect(JSON.parse(printed)).toMatchObject({
      ready: true, validation: 'authenticated', providerCalled: false,
      candidate: { id: 'implementer-authenticated', model: 'claude-authenticated-model', effort: 'high' },
    });
    expect(printed).not.toContain('synthetic-private-claude-sentinel');
    expect(printed).not.toContain(implementer.authFingerprint);
    expect(printed).not.toContain(implementer.capabilityEvidenceSha256);
    expect(printed).not.toContain(implementer.executableIdentity!.path);
    expect(readFileSync(fixture.eventsPath, 'utf8')).toBe('');
  });

  it('requires new authenticated evidence when the requested model is not receipt-covered', async () => {
    const configured = runtimeFixture(fixture);
    const implementer = configured.selectedBinding('implementer', 'claude');
    await initWorkflowV2(fixture.cwd, plan(), { lead: binding('lead', 'codex'), implementer,
      reviewer: configured.selectedBinding('reviewer', 'codex') });
    const intent = { role: 'implementer', sourceBindingId: implementer.id, newBindingId: 'implementer-uncovered',
      model: 'uncovered-model', expectedHead: fixture.baseCommit, reason: 'Probe unsupported route',
      authorityRef: 'release-v1.6' };
    await expect(refreshWorkflowBinding(fixture.cwd, 'binding-refresh', intent, configured.runtime))
      .rejects.toThrow('workflow_authenticated_receipt_refresh_required');
    expect(readWorkflow(fixture.cwd, 'binding-refresh')).toMatchObject({ substitutions: [], bindings: { implementer } });
    expect(readFileSync(fixture.eventsPath, 'utf8')).toBe('');
  });

  it('saves new policy inputs canonically while status exposes raw and effective meanings', async () => {
    const configured = runtimeFixture(fixture);
    await initWorkflowV2(fixture.cwd, plan(), { lead: binding('lead', 'codex'),
      implementer: configured.selectedBinding('implementer', 'claude'),
      reviewer: configured.selectedBinding('reviewer', 'codex') }, { providerPolicy: 'supervised' });
    expect(readWorkflow(fixture.cwd, 'binding-refresh').options.providerPolicy).toBe('unbounded-provider-timeout');
    expect(workflowStatus(fixture.cwd, 'binding-refresh')).toMatchObject({
      providerPolicy: 'unbounded-provider-timeout', effectiveProviderPolicy: 'unbounded-provider-timeout',
    });
  });

  it('keeps the legacy status spelling when the saved provider policy is omitted', async () => {
    const configured = runtimeFixture(fixture);
    await initWorkflowV2(fixture.cwd, plan(), { lead: binding('lead', 'codex'),
      implementer: configured.selectedBinding('implementer', 'claude'),
      reviewer: configured.selectedBinding('reviewer', 'codex') });
    expect(readWorkflow(fixture.cwd, 'binding-refresh').options).not.toHaveProperty('providerPolicy');
    expect(workflowStatus(fixture.cwd, 'binding-refresh')).toMatchObject({
      providerPolicy: 'legacy', effectiveProviderPolicy: 'finite-provider-timeout',
    });
  });

  it('reads the historical supervised spelling byte-for-byte and reports its effective meaning', async () => {
    const configured = runtimeFixture(fixture);
    await initWorkflowV2(fixture.cwd, plan(), { lead: binding('lead', 'codex'),
      implementer: configured.selectedBinding('implementer', 'claude'),
      reviewer: configured.selectedBinding('reviewer', 'codex') });
    const path = join(fixture.cwd, '.omc/state/team/binding-refresh/workflow.json');
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { options: Record<string, unknown> };
    raw.options.providerPolicy = 'supervised';
    writeFileSync(path, JSON.stringify(raw));
    const before = readFileSync(path, 'utf8');
    expect(readWorkflow(fixture.cwd, 'binding-refresh').options.providerPolicy).toBe('supervised');
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(workflowStatus(fixture.cwd, 'binding-refresh')).toMatchObject({
      providerPolicy: 'supervised', effectiveProviderPolicy: 'unbounded-provider-timeout',
    });
  });
});
