import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { assertWorkflowResumeBinding, parseWorkflowBinding, parseWorkflowDispatchSupplementIntent,
  parseWorkflowLeadIntegrationIntent, parseWorkflowReviewBudgetExtensionIntent, parseWorkflowState,
  validateWorkflowStateTransition, workflowReviewBudgetUsed, workflowReviewCeiling } from '../workflow-contracts.js';
import type { WorkflowSetupAttempt, WorkflowTask } from '../workflow-contracts.js';

const hash = 'a'.repeat(64);
function binding(role = 'implementer', providerRoute = 'claude') {
  return { id: `${role}-${providerRoute}`, role, providerRoute,
    cliFamily: role === 'lead' ? 'external' : providerRoute === 'codex' ? 'codex-exec' : 'claude-code',
    model: providerRoute === 'codex' ? 'gpt-6-astra' : providerRoute === 'glm' ? 'glm-5.3'
      : providerRoute === 'mimo' ? 'mimo-v2.6-flash' : 'claude-fable-5',
    authProfileRef: `profile-${providerRoute}`, authFingerprint: hash,
    ...(role === 'lead' ? {} : { executableIdentity: { path: 'C:/tools/provider.exe', sha256: hash, version: '1.0' } }),
    capabilities: role === 'lead' ? ['external-lead'] : role === 'reviewer' ? ['structured-findings', 'read-only'] : ['structured-handoff', 'session-resume'],
    capabilityEvidenceSha256: hash };
}
function legacyState(policy?: unknown) {
  const task: WorkflowTask = { id: 'one', objective: 'Update owned source', baseCommit: 'b'.repeat(40), writeScope: ['src/one.ts'],
    readScope: [], prohibitedScope: [], dependencies: [], contracts: [], acceptanceCriteria: ['Owned source works'], tests: [] };
  return { schemaVersion: 1, profile: 'claude-glm-codex', cwd: 'C:/project', integrationHead: 'b'.repeat(40),
    plan: { name: 'example', objective: 'Implement example', baseCommit: 'b'.repeat(40), integrationBranch: 'integration/example', tasks: [task], verification: [{ command: 'node', args: ['check.mjs'] }] },
    options: { mode: 'balanced', workers: 1, maxWorkers: 3, maxAttempts: 2, maxReviewPasses: 2, timeoutMs: 1000, backoffMs: 0, glmCommand: 'glm', codexCommand: 'codex',
      ...(policy === undefined ? {} : { providerPolicy: policy }) },
    tasks: [{ task, canonicalId: '1', status: 'pending', attempts: 0, worker: 'task-one', updatedAt: '2026-09-15T00:00:00.000Z' }],
    stage: 'implementation', reviewPasses: 0, reviews: [], createdAt: '2026-09-15T00:00:00.000Z', updatedAt: '2026-09-15T00:00:00.000Z' };
}
function state(policy?: unknown) {
  return { ...legacyState(policy), schemaVersion: 2, profile: 'role-substitution',
    bindings: { lead: binding('lead', 'codex'), implementer: binding(), reviewer: binding('reviewer', 'codex') }, substitutions: [] };
}
function completedState(policy?: unknown) {
  const worker = binding();
  const reviewer = binding('reviewer');
  const invocation = { invocationId: '11111111-1111-4111-8111-111111111111', binding: worker,
    attempt: 1, mode: 'fresh', model: worker.model, startedAt: '2026-09-15T00:00:01.000Z', outcome: 'completed', artifacts: [],
    telemetry: { provider: 'claude', durationMs: 1, status: 'unknown', scope: 'unknown' } };
  const review = { invocationId: '22222222-2222-4222-8222-222222222222', binding: reviewer,
    pass: 1, head: 'b'.repeat(40), model: reviewer.model, startedAt: '2026-09-15T00:00:02.000Z', outcome: 'completed', artifacts: [],
    provenance: { relation: 'self-review', authorIds: ['agent-a'], reviewerId: 'agent-a', context: 'fresh' },
    telemetry: { provider: 'claude', durationMs: 1, status: 'unknown', scope: 'unknown' } };
  const base = state(policy);
  return { ...base, bindings: { ...base.bindings, reviewer }, tasks: [{ ...base.tasks[0], status: 'completed', attempts: 1, invocations: [invocation] }],
    reviewPasses: 1, reviewAttempts: [review] };
}
function substitutedState() {
  const before = completedState();
  const replacement = binding('implementer', 'glm');
  return { ...before, bindings: { ...before.bindings, implementer: replacement }, substitutions: [
    { sequence: 1, role: 'implementer', from: before.bindings.implementer, to: replacement, reason: 'Explicit route selection', authorityRef: 'decision-one',
      head: before.integrationHead, at: '2026-09-15T00:00:03.000Z', taskId: 'one', afterAttempt: 1 },
  ] };
}
function leadIntegration(parent = 'b'.repeat(40), head = 'c'.repeat(40), sequence = 1) {
  return { sequence, parent, head, changedFiles: ['src/registry.ts'], orchestrationHost: 'codex',
    actor: { id: 'unknown', model: 'unknown' }, authorityRef: 'issue-39', reason: 'Pin the integrated registry',
    checks: [{ command: { command: 'node', args: ['check.mjs'] }, passed: true, artifacts: [] }], at: '2026-09-15T00:00:04.000Z' };
}
const supplementContent = 'Use the accepted dependency parser without changing the frozen task scope.';
function dispatchSupplement(taskId = 'two', expectedInputHead = 'c'.repeat(40), sequence = 1) {
  return { sequence, taskId, expectedInputHead, orchestrationHost: 'codex', actor: { id: 'unknown', model: 'unknown' },
    authorityRef: 'issue-41', reason: 'Clarify the accepted dependency contract', content: supplementContent,
    contentSha256: createHash('sha256').update(supplementContent).digest('hex'), at: '2026-09-15T00:00:04.000Z' };
}
function reviewBudgetExtension(sequence = 1, oldCeiling = 1, newCeiling = 2, requestId = `review-budget-${sequence}`) {
  return { sequence, requestId, oldCeiling, newCeiling, head: 'b'.repeat(40), orchestrationHost: 'codex',
    actor: { id: 'unknown', model: 'unknown' }, authorityRef: 'issue-44', reason: 'Authorize one more correction cycle',
    at: '2026-09-15T00:00:04.000Z' };
}
function exhaustedState(build: typeof legacyState | typeof completedState) {
  const result = build();
  result.options.maxReviewPasses = 1;
  result.reviewPasses = 1;
  return result;
}
function dependentState(build: typeof legacyState | typeof state = legacyState) {
  const result = build();
  const dependency = { ...result.tasks[0]!.task };
  const dependent: WorkflowTask = { ...dependency, id: 'two', objective: 'Use accepted source', writeScope: ['src/two.ts'],
    dependencies: ['one'] };
  result.integrationHead = 'c'.repeat(40);
  result.plan = { ...result.plan, tasks: [dependency, dependent] };
  result.tasks = [{ ...result.tasks[0]!, task: dependency, status: 'accepted' },
    { task: dependent, canonicalId: '2', status: 'pending', attempts: 0, worker: 'task-two', updatedAt: result.updatedAt }];
  return result;
}
function setupAttempt(sequence = 1, outcome: 'failed' | 'completed' = 'failed'): WorkflowSetupAttempt {
  return { sequence, startedAt: '2026-09-15T00:00:05.000Z', outcome,
    ...(outcome === 'failed' ? { error: 'workflow_worktree_setup_failed', artifact: { kind: 'workflow-worktree-setup',
      path: 'C:/project/.omc/setup.stderr.txt', contentHash: hash, createdAt: '2026-09-15T00:00:05.000Z',
      producer: { system: 'omc', component: 'team-workflow', worker: 'task-one' }, sizeBytes: 20, retention: 'until-completion' } } : {}) };
}
type SetupTestTask = ReturnType<typeof legacyState>['tasks'][number] & {
  setupAttempts?: WorkflowSetupAttempt[]; error?: string; invocations?: unknown[];
};
type SetupTestState = Omit<ReturnType<typeof legacyState>, 'tasks'> & { tasks: SetupTestTask[] };
const sessionId = '12345678-1234-4123-8123-123456789abc';
function telemetry(provider: 'glm' | 'claude' | 'codex' = 'glm') {
  const codex = provider === 'codex';
  const model = provider === 'glm' ? 'glm-5.3' : 'claude-fable-5';
  return { provider, durationMs: 12, status: 'measured', scope: codex ? 'turn' : 'all-models',
    inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, ...(codex ? {} : { cacheWriteTokens: 1 }),
    sessionId, terminal: 'success', diagnostics: [], evidence: { version: 1,
      diagnosticLogComplete: true, eventStreamComplete: true, identityEvidenceComplete: true,
      identityConsistent: true, accountingEvidenceComplete: true, terminalEventCount: 1,
      sessions: [{ value: sessionId, ...(codex ? { threadEvents: 1 } : { initEvents: 1, terminalEvents: 1 }) }],
      models: codex ? [] : [{ value: model, initEvents: 1, terminalUsageBuckets: 1 }],
      terminalUsageBuckets: codex ? [] : [{ model, inputTokens: 7, outputTokens: 5,
        cacheReadInputTokens: 2, cacheCreationInputTokens: 1, observations: 1 }] } };
}
function legacyStateWithTelemetry() {
  const base = legacyState();
  const invocation = { attempt: 1, mode: 'fresh', model: 'glm-5.3', startedAt: '2026-09-15T00:00:01.000Z',
    outcome: 'completed', artifacts: [], telemetry: telemetry() };
  const reviewAttempt = { pass: 1, head: base.integrationHead, model: 'gpt-6-astra',
    startedAt: '2026-09-15T00:00:02.000Z', outcome: 'completed', artifacts: [], telemetry: telemetry('codex') };
  return { ...base, tasks: [{ ...base.tasks[0]!, status: 'completed', attempts: 1, invocations: [invocation] }],
    reviewPasses: 1, reviewAttempts: [reviewAttempt] };
}

describe('versioned workflow contracts', () => {
  it.each(['claude-fable-5-1[1m]', 'opus[1m]', 'glm-5.3', 'glm-5.3-flash', 'glm-5.3-flash[1m]', 'mimo-v2.6-pro', 'mimo-v2.6-flash', 'gpt-6-astra'])('preserves the selected model %s without rewriting its context alias', model => {
    expect(parseWorkflowBinding({ ...binding(), model }).model).toBe(model);
  });
  it.each(['opus[1m]\n', 'opus[[1m]]', 'opus[]', 'opus[1m];run', 'opus token=example'])('rejects a malformed model literal %s', model => {
    expect(() => parseWorkflowBinding({ ...binding(), model })).toThrow(/workflow_/);
  });
  it('separates supported roles, provider routes and CLI families without changing model identity', () => {
    for (const [role, provider] of [['lead', 'claude'], ['lead', 'codex'], ['implementer', 'claude'], ['implementer', 'glm'], ['implementer', 'mimo'], ['reviewer', 'claude'], ['reviewer', 'codex']]) {
      expect(parseWorkflowBinding(binding(role, provider))).toEqual(binding(role, provider));
    }
    for (const value of [binding('implementer', 'codex'), binding('reviewer', 'glm'), binding('reviewer', 'mimo'),
      { ...binding(), cliFamily: 'codex-exec' }, { ...binding(), capabilities: [] },
      { ...binding(), password: 'synthetic-only' }]) {
      expect(() => parseWorkflowBinding(value)).toThrow(/workflow_/);
    }
  });
  it('loads both legacy modes unchanged and separately validates the new profile without migrating', () => {
    for (const mode of ['v1', 'balanced']) {
      const legacy = legacyState(); legacy.options.mode = mode;
      const bytes = JSON.stringify(legacy);
      expect(parseWorkflowState(legacy)).toBe(legacy);
      expect(JSON.stringify(legacy)).toBe(bytes);
    }
    const mimo = { ...legacyState(), profile: 'claude-mimo-codex' };
    expect(parseWorkflowState(mimo)).toBe(mimo);
    const sparseLegacy = legacyState();
    sparseLegacy.options = { mode: 'v1' } as typeof sparseLegacy.options;
    expect(parseWorkflowState(sparseLegacy)).toBe(sparseLegacy);
    expect(() => parseWorkflowState({ ...sparseLegacy, reviewBudgetExtensions: [reviewBudgetExtension()] }))
      .toThrow('workflow_invalid_counter');
    expect(parseWorkflowState(state())).toMatchObject({ schemaVersion: 2, profile: 'role-substitution', reviewPasses: 0 });
    for (const value of [{ ...state(), schemaVersion: 3 }, { ...state(), profile: 'claude-glm-codex' },
      { ...legacyState(), profile: 'role-substitution' }, { ...state(), reviewPasses: 3 },
      { ...state(), tasks: [{ ...state().tasks[0], attempts: -1 }] }]) {
      expect(() => parseWorkflowState(value)).toThrow(/workflow_/);
    }
  });
  it('loads immutable detached invocation bindings and truthful self-review without requiring independence', () => {
    const raw = completedState();
    const parsed = parseWorkflowState(raw);
    if (parsed.schemaVersion !== 2) throw Error('Expected V2');
    const snapshot = parsed.tasks[0]!.invocations![0]!.binding;
    expect(() => Object.assign(snapshot, { model: 'changed' })).toThrow();
    raw.tasks[0]!.invocations[0]!.binding.capabilities.push('untrusted');
    expect(snapshot.capabilities).not.toContain('untrusted');
    expect(parsed.reviewAttempts![0]!.provenance.relation).toBe('self-review');
    for (const mutate of [
      (value: ReturnType<typeof completedState>) => { value.reviewAttempts[0]!.provenance.relation = 'independent'; },
      (value: ReturnType<typeof completedState>) => { value.tasks[0]!.invocations[0]!.telemetry.provider = 'glm'; },
      (value: ReturnType<typeof completedState>) => { value.reviewAttempts[0]!.binding = binding(); },
      (value: ReturnType<typeof completedState>) => { value.tasks[0]!.attempts = 2; },
    ]) {
      const malformed = completedState(); mutate(malformed);
      expect(() => parseWorkflowState(malformed)).toThrow(/workflow_/);
    }
  });
  it('validates the complete substitution chain and retains the earlier invocation identity', () => {
    const parsed = parseWorkflowState(substitutedState());
    if (parsed.schemaVersion !== 2) throw Error('Expected V2');
    expect(parsed.tasks[0]!.invocations![0]!.binding.providerRoute).toBe('claude');
    expect(parsed.bindings.implementer.providerRoute).toBe('glm');
    expect(() => Object.assign(parsed.substitutions[0]!, { reason: 'rewritten' })).toThrow();
    for (const mutate of [
      (value: ReturnType<typeof substitutedState>) => { value.substitutions[0]!.sequence = 2; },
      (value: ReturnType<typeof substitutedState>) => { value.substitutions[0]!.afterAttempt = 2; },
      (value: ReturnType<typeof substitutedState>) => { value.substitutions[0]!.role = 'reviewer'; },
      (value: ReturnType<typeof substitutedState>) => { value.substitutions[0]!.from = binding('implementer', 'glm'); },
      (value: ReturnType<typeof substitutedState>) => { value.substitutions = []; },
    ]) {
      const malformed = substitutedState(); mutate(malformed);
      expect(() => parseWorkflowState(malformed)).toThrow(/workflow_/);
    }
  });
  it('permits an explicit selection without inventing an invocation and rejects history or budget rewrites', () => {
    expect(() => validateWorkflowStateTransition(completedState(), substitutedState())).not.toThrow();
    for (const mutate of [
      (value: ReturnType<typeof completedState>) => { value.tasks[0]!.attempts = 0; value.tasks[0]!.invocations = []; },
      (value: ReturnType<typeof completedState>) => { value.reviewPasses = 0; value.reviewAttempts = []; },
      (value: ReturnType<typeof completedState>) => { value.options.maxAttempts = 3; },
      (value: ReturnType<typeof completedState>) => { Object.assign(value.tasks[0]!.invocations[0]!, { error: 'replaced-original-result' }); },
      (value: ReturnType<typeof completedState>) => { value.tasks = []; },
    ]) {
      const after = completedState(); mutate(after);
      expect(() => validateWorkflowStateTransition(completedState(), after)).toThrow(/workflow_/);
    }
    const rewritten = substitutedState(); rewritten.substitutions[0]!.reason = 'Different reason';
    expect(() => validateWorkflowStateTransition(substitutedState(), rewritten)).toThrow(/workflow_/);
    expect(() => validateWorkflowStateTransition(legacyState(), state())).toThrow(/workflow_/);
  });
  it('allows only the same complete resume binding and never treats a cross-provider launch as continuation', () => {
    expect(() => assertWorkflowResumeBinding(binding(), structuredClone(binding()))).not.toThrow();
    for (const next of [binding('implementer', 'glm'), { ...binding(), model: 'claude-other' },
      { ...binding(), authFingerprint: 'c'.repeat(64) }, { ...binding(), executableIdentity: { path: 'C:/tools/new.exe', sha256: hash, version: '1.0' } },
      { ...binding(), capabilities: ['structured-handoff'] }]) {
      expect(() => assertWorkflowResumeBinding(binding(), next)).toThrow(/workflow_/);
    }
  });
  it('protects review snapshot properties and validates persisted session bindings rather than trusting their shape', () => {
    const raw = { ...completedState(), tasks: [{ ...completedState().tasks[0]!, session: {
      id: '33333333-3333-4333-8333-333333333333', confirmed: true, fingerprint: hash, worktree: 'C:/project/task', branch: 'worker/one', binding: binding(),
    } }] };
    const parsed = parseWorkflowState(raw);
    if (parsed.schemaVersion !== 2) throw Error('Expected V2');
    expect(() => Object.assign(parsed.reviewAttempts![0]!, { binding: binding() })).toThrow();
    expect(() => Object.assign(parsed.tasks[0]!.session!.binding, { authFingerprint: 'd'.repeat(64) })).toThrow();
    const bad = structuredClone(raw); bad.tasks[0]!.session.binding = binding('reviewer');
    expect(() => parseWorkflowState(bad)).toThrow(/workflow_/);
  });
  it('rejects missing task ownership and duplicate invocation identities in V2 saved state', () => {
    const missing = completedState(); missing.tasks = [];
    expect(() => parseWorkflowState(missing)).toThrow(/workflow_/);
    const duplicate = completedState(); duplicate.reviewAttempts[0]!.invocationId = duplicate.tasks[0]!.invocations[0]!.invocationId;
    expect(() => parseWorkflowState(duplicate)).toThrow(/workflow_/);
  });
  it('allows a reserved attempt to settle but never lets its identity or mode change', () => {
    const reserved = completedState();
    Object.assign(reserved.tasks[0]!.invocations[0]!, { outcome: 'failed', error: 'workflow_invocation_incomplete' });
    expect(() => validateWorkflowStateTransition(reserved, completedState())).not.toThrow();
    const changed = completedState(); changed.tasks[0]!.invocations[0]!.mode = 'resume';
    expect(() => validateWorkflowStateTransition(reserved, changed)).toThrow(/workflow_/);
  });
  it('retains host history through selection changes and refuses relabelling reserved or legacy attempts', () => {
    for (const schemaVersion of [1, 2]) {
      const raw = { ...completedState(), schemaVersion, profile: schemaVersion === 1 ? 'claude-glm-codex' : 'role-substitution' };
      Object.assign(raw.tasks[0]!.invocations[0]!, { orchestrationHost: 'claude', error: 'workflow_invocation_incomplete', outcome: 'failed' });
      Object.assign(raw.reviewAttempts[0]!, { orchestrationHost: 'codex' });
      const bytes = JSON.stringify(raw);
      expect(parseWorkflowState(raw)).toEqual(raw);
      expect(JSON.stringify(raw)).toBe(bytes);
      expect(() => validateWorkflowStateTransition(raw, structuredClone(raw))).not.toThrow();
      for (const field of ['worker', 'review']) {
        const changed = structuredClone(raw);
        Object.assign(field === 'worker' ? changed.tasks[0]!.invocations[0]! : changed.reviewAttempts[0]!, { orchestrationHost: field === 'worker' ? 'codex' : 'claude' });
        expect(() => validateWorkflowStateTransition(raw, changed)).toThrow('workflow_orchestration_history_rewritten');
      }
    }
    const legacy = completedState();
    const backfilled = structuredClone(legacy);
    Object.assign(backfilled.tasks[0]!.invocations[0]!, { orchestrationHost: 'claude' });
    expect(() => validateWorkflowStateTransition(legacy, backfilled)).toThrow('workflow_orchestration_history_rewritten');
  });
  it('rejects unknown host provenance without deriving the provider from a model name', () => {
    const raw = completedState();
    Object.assign(raw.tasks[0]!.invocations[0]!, { orchestrationHost: 'glm' });
    expect(() => parseWorkflowState(raw)).toThrow('workflow_invalid_orchestration_host');
    const selected = parseWorkflowBinding({ ...binding('implementer', 'glm'), model: 'glm-5.3-flash[1m]' });
    expect(selected.providerRoute).toBe('glm');
    expect(selected.model).toBe('glm-5.3-flash[1m]');
    expect(parseWorkflowBinding({ ...binding('implementer', 'claude'), model: 'glm-5.3-flash[1m]' }).providerRoute).toBe('claude');
  });
  it('keeps the optional provider policy absent when omitted and unchanged when present in both schemas', () => {
    for (const policy of [undefined, 'supervised', 'unbounded-provider-timeout'] as const) {
      for (const build of [() => legacyState(policy), () => state(policy)]) {
        const raw = build();
        const bytes = JSON.stringify(raw);
        const parsed = parseWorkflowState(raw);
        expect(parsed.options.providerPolicy).toBe(policy);
        expect('providerPolicy' in parsed.options).toBe(policy !== undefined);
        expect(JSON.stringify(parsed)).toBe(bytes);
      }
    }
    // Reading an old omitted state neither adds nor migrates the field.
    expect(JSON.stringify(parseWorkflowState(legacyState()))).not.toContain('providerPolicy');
    expect(JSON.stringify(parseWorkflowState(state()))).not.toContain('providerPolicy');
  });
  it.each([null, true, false, 0, 1, [], {}, 'Supervised', 'legacy', 'unsupervised', 'supervised '])(
    'refuses the unsupported saved provider policy %j for both schemas', policy => {
      for (const build of [legacyState, state]) {
        const raw = build() as { options: Record<string, unknown> };
        raw.options.providerPolicy = policy;
        expect(() => parseWorkflowState(raw)).toThrow('workflow_invalid_policy');
      }
    });
  it('refuses a provider policy change after initialization while permitting an unchanged value', () => {
    expect(() => validateWorkflowStateTransition(completedState('supervised'), completedState('supervised'))).not.toThrow();
    expect(() => validateWorkflowStateTransition(completedState('unbounded-provider-timeout'), completedState('unbounded-provider-timeout'))).not.toThrow();
    expect(() => validateWorkflowStateTransition(completedState(), completedState())).not.toThrow();
    expect(() => validateWorkflowStateTransition(completedState(), completedState('supervised'))).toThrow('workflow_policy_change_forbidden');
    expect(() => validateWorkflowStateTransition(completedState('supervised'), completedState())).toThrow('workflow_policy_change_forbidden');
    expect(() => validateWorkflowStateTransition(completedState('supervised'), completedState('unbounded-provider-timeout')))
      .toThrow('workflow_policy_change_forbidden');
  });
  it('parses a strict frozen lead-integration intent and append-only evidence in both schemas', () => {
    const mutableCheck = { command: 'node', args: ['check.mjs'] };
    const parsedIntent = parseWorkflowLeadIntegrationIntent({ expectedParent: 'b'.repeat(40), expectedHead: 'c'.repeat(40),
      actor: { id: 'unknown', model: 'unknown' }, authorityRef: 'issue-39', reason: 'Authorized registry pin',
      paths: ['src/registry.ts'], checks: [mutableCheck] });
    expect(parsedIntent).toMatchObject({
      expectedParent: 'b'.repeat(40), paths: ['src/registry.ts'] });
    expect(Object.isFrozen(parsedIntent.checks[0])).toBe(true);
    expect(Object.isFrozen(parsedIntent.checks[0]!.args)).toBe(true);
    mutableCheck.args[0] = 'mutated.mjs';
    expect(parsedIntent.checks[0]!.args).toEqual(['check.mjs']);
    for (const build of [legacyState, state]) {
      const artifact = setupAttempt().artifact!;
      const record = leadIntegration();
      const raw = { ...build(), leadIntegrations: [{ ...record,
        checks: [{ ...record.checks[0]!, artifacts: [artifact] }] }] };
      const parsed = parseWorkflowState(raw);
      expect(parsed.leadIntegrations?.[0]).toMatchObject({ sequence: 1, parent: 'b'.repeat(40), head: 'c'.repeat(40) });
      expect(() => Object.assign(parsed.leadIntegrations![0]!, { reason: 'rewritten' })).toThrow();
      expect(Object.isFrozen(parsed.leadIntegrations![0]!.checks[0]!.command)).toBe(true);
      expect(Object.isFrozen(parsed.leadIntegrations![0]!.checks[0]!.command.args)).toBe(true);
      record.checks[0]!.command.args[0] = 'mutated.mjs';
      expect(parsed.leadIntegrations![0]!.checks[0]!.command.args).toEqual(['check.mjs']);
      expect(() => Object.assign(parsed.leadIntegrations![0]!.checks[0]!.artifacts[0]!.producer,
        { component: 'rewritten' })).toThrow();
      const malformedArtifact = structuredClone(raw);
      malformedArtifact.leadIntegrations[0]!.checks[0]!.artifacts[0]!.contentHash = 'invalid';
      expect(() => parseWorkflowState(malformedArtifact)).toThrow(/workflow_/);
      expect(() => parseWorkflowState({ ...build(), leadIntegrations: [leadIntegration(undefined, undefined, 2)] }))
        .toThrow('workflow_lead_integration_sequence_mismatch');
    }
    for (const malformed of [
      { expectedParent: 'b'.repeat(40), expectedHead: 'c'.repeat(40), actor: { id: 'unknown', model: 'gpt-6' }, authorityRef: 'x', reason: 'x', paths: ['src/a.ts'], checks: [{ command: 'node', args: [] }] },
      { expectedParent: 'b'.repeat(40), expectedHead: 'c'.repeat(40), actor: { id: 'unknown', model: 'unknown' }, authorityRef: 'x', reason: 'x', paths: [], checks: [{ command: 'node', args: [] }] },
      { expectedParent: 'b'.repeat(40), expectedHead: 'c'.repeat(40), actor: { id: 'unknown', model: 'unknown' }, authorityRef: 'x', reason: 'x', paths: ['src/a.ts'], checks: [], extra: true },
    ]) expect(() => parseWorkflowLeadIntegrationIntent(malformed)).toThrow(/workflow_/);
    expect(() => parseWorkflowLeadIntegrationIntent({ expectedParent: 'b'.repeat(40), expectedHead: 'c'.repeat(40),
      actor: { id: 'unknown', model: 'unknown' }, authorityRef: 'issue-39', reason: 'Oversized checks', paths: ['src/a.ts'],
      checks: Array.from({ length: 30 }, () => ({ command: 'node', args: Array.from({ length: 10 }, () => 'x'.repeat(500)) })) }))
      .toThrow('workflow_lead_integration_too_large');
    expect(() => parseWorkflowState({ ...legacyState(),
      leadIntegrations: Array.from({ length: 33 }, (_, index) => leadIntegration(undefined, undefined, index + 1)) }))
      .toThrow('workflow_invalid_lead_integrations');
    expect(() => parseWorkflowState({ ...legacyState(), leadIntegrations: [{ ...leadIntegration(),
      checks: Array.from({ length: 30 }, () => ({
        command: { command: 'node', args: Array.from({ length: 10 }, () => 'x'.repeat(500)) },
        passed: true, artifacts: [],
      })) }] })).toThrow('workflow_lead_integration_too_large');
  });
  it('allows one exact lead-integration append and refuses origin, ledger, or workflow-history rewrites', () => {
    for (const build of [legacyState, state]) {
      const before = build();
      const after = { ...structuredClone(before), integrationHead: 'c'.repeat(40), stage: 'integration', leadIntegrations: [leadIntegration()] };
      expect(() => validateWorkflowStateTransition(before, after)).not.toThrow();

      const wrongOrigin = structuredClone(after); wrongOrigin.leadIntegrations[0]!.parent = 'a'.repeat(40);
      expect(() => validateWorkflowStateTransition(before, wrongOrigin)).toThrow('workflow_lead_integration_origin_mismatch');
      const wrongStage = structuredClone(after); wrongStage.stage = 'verification';
      expect(() => validateWorkflowStateTransition(before, wrongStage)).toThrow('workflow_lead_integration_transition_invalid');
      const retainedVerification = { ...structuredClone(after), verification: {
        head: before.integrationHead, passed: true, checks: [{ command: { command: 'node', args: ['check.mjs'] }, passed: true, artifacts: [] }],
      } };
      expect(() => validateWorkflowStateTransition(before, retainedVerification)).toThrow('workflow_lead_integration_transition_invalid');
      const changedTask = structuredClone(after); changedTask.tasks[0]!.status = 'rejected';
      expect(() => validateWorkflowStateTransition(before, changedTask)).toThrow('workflow_lead_integration_history_rewritten');
      const changedCwd = structuredClone(after); changedCwd.cwd = 'C:/other-project';
      expect(() => validateWorkflowStateTransition(before, changedCwd)).toThrow('workflow_lead_integration_history_rewritten');

      const recorded = structuredClone(after);
      const rewritten = structuredClone(recorded); rewritten.leadIntegrations[0]!.reason = 'Different reason';
      expect(() => validateWorkflowStateTransition(recorded, rewritten)).toThrow('workflow_lead_integration_history_rewritten');
      const deleted = structuredClone(recorded); deleted.leadIntegrations = [];
      expect(() => validateWorkflowStateTransition(recorded, deleted)).toThrow('workflow_lead_integration_history_rewritten');
    }
    const legacyBefore = legacyState();
    const changedProfile = { ...structuredClone(legacyBefore), profile: 'claude-mimo-codex',
      integrationHead: 'c'.repeat(40), stage: 'integration', leadIntegrations: [leadIntegration()] };
    expect(() => validateWorkflowStateTransition(legacyBefore, changedProfile)).toThrow('workflow_lead_integration_history_rewritten');
  });
  it('strictly parses and freezes attributed review-budget extensions in both schemas', () => {
    const parsedIntent = parseWorkflowReviewBudgetExtensionIntent({ requestId: 'review-budget-1', expectedHead: 'b'.repeat(40),
      expectedCeiling: 1, increment: 1, actor: { id: 'unknown', model: 'unknown' }, authorityRef: 'issue-44',
      reason: 'Authorize one more correction cycle' });
    expect(parsedIntent).toMatchObject({ requestId: 'review-budget-1', expectedCeiling: 1, increment: 1 });
    expect(Object.isFrozen(parsedIntent)).toBe(true);
    expect(Object.isFrozen(parsedIntent.actor)).toBe(true);
    expect(parseWorkflowReviewBudgetExtensionIntent({ ...parsedIntent, expectedCeiling: 10, increment: 10 }))
      .toMatchObject({ expectedCeiling: 10, increment: 10 });
    expect(() => parseWorkflowReviewBudgetExtensionIntent({ ...parsedIntent, increment: 11 }))
      .toThrow('workflow_invalid_counter');
    expect(() => parseWorkflowReviewBudgetExtensionIntent({ ...parsedIntent, extra: true })).toThrow('workflow_unknown_field');

    for (const build of [legacyState, completedState]) {
      const raw = { ...exhaustedState(build), reviewBudgetExtensions: [reviewBudgetExtension()] };
      const parsed = parseWorkflowState(raw);
      expect(parsed.reviewBudgetExtensions).toEqual([expect.objectContaining({ sequence: 1, oldCeiling: 1, newCeiling: 2 })]);
      expect(workflowReviewCeiling(parsed)).toBe(2);
      expect(Object.isFrozen(parsed.reviewBudgetExtensions)).toBe(true);
      expect(Object.isFrozen(parsed.reviewBudgetExtensions![0])).toBe(true);
      expect(Object.isFrozen(parsed.reviewBudgetExtensions![0]!.actor)).toBe(true);
      expect(() => Object.assign(parsed.reviewBudgetExtensions![0]!, { reason: 'rewritten' })).toThrow();
    }

    const wrongChain = { ...exhaustedState(legacyState), reviewBudgetExtensions: [reviewBudgetExtension(1, 2, 3)] };
    expect(() => parseWorkflowState(wrongChain)).toThrow('workflow_review_budget_extension_chain_mismatch');
    const duplicate = { ...exhaustedState(legacyState), reviewBudgetExtensions: [reviewBudgetExtension(),
      reviewBudgetExtension(2, 2, 3, 'review-budget-1')] };
    expect(() => parseWorkflowState(duplicate)).toThrow('workflow_review_budget_extension_chain_mismatch');
    const beyondOldLifetimeLimit = { ...exhaustedState(legacyState), reviewBudgetExtensions: [
      reviewBudgetExtension(), reviewBudgetExtension(2, 2, 12),
    ] };
    expect(workflowReviewCeiling(parseWorkflowState(beyondOldLifetimeLimit))).toBe(12);
    const attributedLegacy = parseWorkflowState({ ...exhaustedState(legacyState), reviewBudgetExtensions: [{ ...reviewBudgetExtension(),
      actor: { id: 'claude-lead', model: 'claude-fable-5' } }] });
    expect(attributedLegacy.reviewBudgetExtensions?.[0]?.actor).toEqual({ id: 'claude-lead', model: 'claude-fable-5' });
    expect(() => parseWorkflowState({ ...exhaustedState(completedState), reviewBudgetExtensions: [{ ...reviewBudgetExtension(),
      actor: { id: 'other-lead', model: 'gpt-6-astra' } }] })).toThrow('workflow_review_budget_extension_actor_mismatch');
  });
  it('opts new states into completed-review accounting without reinterpreting v1.5 attempt counters', () => {
    const historical = completedState();
    historical.reviewAttempts[0]!.outcome = 'failed';
    expect(workflowReviewBudgetUsed(parseWorkflowState(historical))).toBe(1);

    const current = { ...structuredClone(historical), reviewBudgetBasis: 'completed-reviews' as const };
    const parsed = parseWorkflowState(current);
    expect(parsed.reviewPasses).toBe(1);
    expect(parsed.reviewAttempts).toHaveLength(1);
    expect(workflowReviewBudgetUsed(parsed)).toBe(0);
    expect(() => validateWorkflowStateTransition(historical, current)).toThrow('workflow_budget_reset_forbidden');

    const completed = { ...structuredClone(current),
      reviews: [{ pass: 1, head: current.integrationHead, findings: [], artifacts: [] }] };
    completed.reviewAttempts[0]!.outcome = 'completed';
    expect(workflowReviewBudgetUsed(parseWorkflowState(completed))).toBe(1);
  });
  it('allows only one pure review-budget append and keeps the initial ceiling immutable in both schemas', () => {
    for (const build of [legacyState, completedState]) {
      const before = exhaustedState(build);
      const recorded = { ...structuredClone(before), reviewBudgetExtensions: [reviewBudgetExtension()],
        updatedAt: '2026-09-15T00:00:05.000Z' };
      expect(() => validateWorkflowStateTransition(before, recorded)).not.toThrow();

      const changedTask = structuredClone(recorded); changedTask.tasks[0]!.task.objective = 'Rewritten objective';
      expect(() => validateWorkflowStateTransition(before, changedTask))
        .toThrow('workflow_review_budget_extension_transition_invalid');
      const rewritten = structuredClone(recorded); rewritten.reviewBudgetExtensions[0]!.reason = 'Rewritten reason';
      expect(() => validateWorkflowStateTransition(recorded, rewritten))
        .toThrow('workflow_review_budget_extension_history_rewritten');
      const notExhausted = structuredClone(before); notExhausted.reviewPasses = 0;
      if ('reviewAttempts' in notExhausted) notExhausted.reviewAttempts = [];
      const unavailable = { ...structuredClone(notExhausted), reviewBudgetExtensions: [reviewBudgetExtension()] };
      expect(() => validateWorkflowStateTransition(notExhausted, unavailable))
        .toThrow('workflow_review_budget_extension_origin_mismatch');
    }

    const legacyBefore = legacyState();
    const changedInitialBudget = structuredClone(legacyBefore); changedInitialBudget.options.maxReviewPasses = 3;
    expect(() => validateWorkflowStateTransition(legacyBefore, changedInitialBudget)).toThrow('workflow_budget_reset_forbidden');

    const attributedBefore = exhaustedState(legacyState);
    const attributedAfter = { ...structuredClone(attributedBefore), reviewBudgetExtensions: [{ ...reviewBudgetExtension(),
      actor: { id: 'claude-lead', model: 'claude-fable-5' } }] };
    expect(() => validateWorkflowStateTransition(attributedBefore, attributedAfter)).not.toThrow();

    const reviewedLegacy = legacyState(); reviewedLegacy.reviewPasses = 1;
    const rolledBackLegacy = structuredClone(reviewedLegacy); rolledBackLegacy.reviewPasses = 0;
    expect(() => validateWorkflowStateTransition(reviewedLegacy, rolledBackLegacy)).toThrow('workflow_budget_reset_forbidden');
    const extendedLegacy = { ...exhaustedState(legacyState), reviewBudgetExtensions: [reviewBudgetExtension()] };
    const rolledBackExtended = structuredClone(extendedLegacy); rolledBackExtended.reviewPasses = 0;
    expect(() => validateWorkflowStateTransition(extendedLegacy, rolledBackExtended)).toThrow('workflow_budget_reset_forbidden');
  });
  it('strictly parses and freezes dispatch supplements in both schemas', () => {
    const intent = dispatchSupplement();
    const parsedIntent = parseWorkflowDispatchSupplementIntent({ taskId: intent.taskId,
      expectedInputHead: intent.expectedInputHead, actor: intent.actor, authorityRef: intent.authorityRef,
      reason: intent.reason, content: intent.content, contentSha256: intent.contentSha256 });
    expect(parsedIntent.content).toBe(supplementContent);
    expect(Object.isFrozen(parsedIntent)).toBe(true);
    expect(Object.isFrozen(parsedIntent.actor)).toBe(true);
    for (const build of [legacyState, state]) {
      const raw = { ...dependentState(build), dispatchSupplements: [dispatchSupplement()] };
      const parsed = parseWorkflowState(raw);
      expect(parsed.dispatchSupplements).toEqual([expect.objectContaining({ sequence: 1, taskId: 'two',
        expectedInputHead: 'c'.repeat(40), contentSha256: intent.contentSha256 })]);
      expect(Object.isFrozen(parsed.dispatchSupplements)).toBe(true);
      expect(Object.isFrozen(parsed.dispatchSupplements![0])).toBe(true);
      expect(Object.isFrozen(parsed.dispatchSupplements![0]!.actor)).toBe(true);
      expect(() => Object.assign(parsed.dispatchSupplements![0]!, { reason: 'rewritten' })).toThrow();
    }
    expect(() => parseWorkflowDispatchSupplementIntent({ ...parsedIntent, contentSha256: 'b'.repeat(64) }))
      .toThrow('workflow_dispatch_supplement_digest_mismatch');
    const multibyte = '界'.repeat(2731);
    expect(() => parseWorkflowDispatchSupplementIntent({ ...parsedIntent, content: multibyte,
      contentSha256: createHash('sha256').update(multibyte).digest('hex') }))
      .toThrow('workflow_dispatch_supplement_too_large');
    expect(() => parseWorkflowDispatchSupplementIntent({ ...parsedIntent, extra: true })).toThrow('workflow_unknown_field');
    expect(() => parseWorkflowState({ ...dependentState(), dispatchSupplements: [dispatchSupplement(), dispatchSupplement('two', 'c'.repeat(40), 2)] }))
      .toThrow('workflow_duplicate_dispatch_supplement');
    expect(() => parseWorkflowState({ ...dependentState(), dispatchSupplements: [dispatchSupplement('two', 'c'.repeat(40), 2)] }))
      .toThrow('workflow_dispatch_supplement_sequence_mismatch');
    const unbalanced = dependentState(); unbalanced.options.mode = 'v1';
    expect(() => parseWorkflowState({ ...unbalanced, dispatchSupplements: [dispatchSupplement()] }))
      .toThrow('workflow_balanced_mode_required');
  });
  it('allows only one pure supplement append and pins first setup to its recorded head', () => {
    for (const build of [legacyState, state]) {
      const before = dependentState(build);
      const recorded = { ...structuredClone(before), dispatchSupplements: [dispatchSupplement()],
        updatedAt: '2026-09-15T00:00:01.000Z' };
      expect(() => validateWorkflowStateTransition(before, recorded)).not.toThrow();

      const changedTask = structuredClone(recorded); changedTask.tasks[1]!.task.objective = 'Rewritten objective';
      expect(() => validateWorkflowStateTransition(before, changedTask)).toThrow('workflow_dispatch_supplement_transition_invalid');
      const unavailable = structuredClone(before); unavailable.tasks[0]!.status = 'running';
      expect(() => validateWorkflowStateTransition(unavailable, { ...structuredClone(unavailable),
        dispatchSupplements: [dispatchSupplement()] })).toThrow('workflow_dispatch_supplement_origin_mismatch');
      const rewritten = structuredClone(recorded); rewritten.dispatchSupplements[0]!.reason = 'Rewritten reason';
      expect(() => validateWorkflowStateTransition(recorded, rewritten)).toThrow('workflow_dispatch_supplement_history_rewritten');

      const laterHead = structuredClone(recorded); laterHead.integrationHead = 'd'.repeat(40);
      const setup = structuredClone(laterHead);
      setup.tasks[1]!.task.baseCommit = 'c'.repeat(40);
      Object.assign(setup.tasks[1]!, { setupAttempts: [setupAttempt(1, 'completed')] });
      expect(() => validateWorkflowStateTransition(laterHead, setup)).not.toThrow();
      const wrongBase = structuredClone(setup); wrongBase.tasks[1]!.task.baseCommit = laterHead.integrationHead;
      expect(() => validateWorkflowStateTransition(laterHead, wrongBase)).toThrow('workflow_setup_history_origin_mismatch');
    }
  });
  it('keeps worktree setup history separate, sequence-validated, and append-only in both schemas', () => {
    for (const build of [legacyState, state]) {
      const failed = build() as unknown as SetupTestState;
      Object.assign(failed.tasks[0]!, { status: 'failed', error: 'workflow_worktree_setup_failed', setupAttempts: [setupAttempt()] });
      const parsed = parseWorkflowState(failed);
      expect(parsed.tasks[0]!.attempts).toBe(0);
      expect(parsed.tasks[0]!.setupAttempts).toEqual([expect.objectContaining({ sequence: 1, outcome: 'failed' })]);
      expect(() => parsed.tasks[0]!.setupAttempts!.push(setupAttempt(2))).toThrow();
      expect(() => Object.assign(parsed.tasks[0]!.setupAttempts![0]!.artifact!.producer,
        { component: 'rewritten' })).toThrow();
      expect(() => parseWorkflowState({ ...build(), tasks: [{ ...build().tasks[0], setupAttempts: [setupAttempt(2)] }] }))
        .toThrow('workflow_invalid_setup_history');
      for (const invalid of [
        { contentHash: 'invalid' }, { sizeBytes: -1 }, { kind: 'wrong-kind' }, { retention: 'forever' },
        { createdAt: 'not-a-time' }, { path: 'C:/bad\npath' },
        { producer: { system: 'other', component: 'team-workflow' } },
      ]) {
        const malformed = structuredClone(failed);
        Object.assign(malformed.tasks[0]!.setupAttempts![0]!.artifact!, invalid);
        expect(() => parseWorkflowState(malformed)).toThrow(/workflow_/);
      }

      expect(() => validateWorkflowStateTransition(build(), failed)).not.toThrow();
      const completed = structuredClone(failed);
      completed.tasks[0]!.setupAttempts!.push(setupAttempt(2, 'completed'));
      completed.tasks[0]!.status = 'pending'; delete completed.tasks[0]!.error;
      expect(() => validateWorkflowStateTransition(failed, completed)).not.toThrow();

      const rewritten = structuredClone(failed); rewritten.tasks[0]!.setupAttempts![0] = {
        ...rewritten.tasks[0]!.setupAttempts![0]!, startedAt: '2026-09-15T00:00:06.000Z' };
      expect(() => validateWorkflowStateTransition(failed, rewritten)).toThrow('workflow_setup_history_rewritten');
      const spent = structuredClone(failed); spent.tasks[0]!.attempts = 1; spent.tasks[0]!.invocations = [];
      spent.tasks[0]!.setupAttempts!.push(setupAttempt(2, 'completed')); spent.tasks[0]!.status = 'pending'; delete spent.tasks[0]!.error;
      expect(() => validateWorkflowStateTransition(failed, spent)).toThrow(/workflow_(?:setup_history_origin_mismatch|attempt_history_mismatch)/);
    }
  });
  it('allows only the first dependent setup to bind its task to the current integration head', () => {
    for (const build of [legacyState, state]) {
      const before = build();
      const targetTask: WorkflowTask = { ...before.plan.tasks[0]!, dependencies: ['dependency'] };
      const dependencyTask: WorkflowTask = { ...before.plan.tasks[0]!, id: 'dependency', dependencies: [] };
      before.integrationHead = 'c'.repeat(40);
      before.plan = { ...before.plan, tasks: [dependencyTask, targetTask] };
      before.tasks = [{ ...before.tasks[0]!, task: dependencyTask, canonicalId: '2', status: 'accepted' },
        { ...before.tasks[0]!, task: targetTask }];

      const first = structuredClone(before) as unknown as SetupTestState;
      Object.assign(first.tasks[1]!.task, { baseCommit: before.integrationHead });
      Object.assign(first.tasks[1]!, { status: 'failed', error: 'workflow_worktree_setup_failed',
        setupAttempts: [setupAttempt()] });
      expect(() => validateWorkflowStateTransition(before, first)).not.toThrow();

      const rewrittenScope = structuredClone(first);
      rewrittenScope.tasks[1]!.task.writeScope = ['src/rewritten.ts'];
      expect(() => validateWorkflowStateTransition(before, rewrittenScope)).toThrow('workflow_setup_history_origin_mismatch');

      const second = structuredClone(first);
      second.tasks[1]!.setupAttempts!.push(setupAttempt(2, 'completed'));
      second.tasks[1]!.status = 'pending'; delete second.tasks[1]!.error;
      second.tasks[1]!.task.baseCommit = 'd'.repeat(40);
      expect(() => validateWorkflowStateTransition(first, second)).toThrow('workflow_setup_history_origin_mismatch');
    }
  });
  it('preserves an upgraded dependent task base when its provider attempt predates setup history', () => {
    for (const build of [legacyState, state]) {
      const before = build();
      const targetTask: WorkflowTask = { ...before.plan.tasks[0]!, dependencies: ['dependency'] };
      const dependencyTask: WorkflowTask = { ...before.plan.tasks[0]!, id: 'dependency', dependencies: [] };
      const invocation = structuredClone(completedState().tasks[0]!.invocations[0]!);
      before.integrationHead = 'c'.repeat(40);
      before.plan = { ...before.plan, tasks: [dependencyTask, targetTask] };
      const targetState = { ...before.tasks[0]!, task: targetTask };
      Object.assign(targetState, { attempts: 1, status: 'failed', error: 'workflow_worker_failed', invocations: [invocation] });
      before.tasks = [{ ...before.tasks[0]!, task: dependencyTask, canonicalId: '2', status: 'accepted' }, targetState];

      const retried = structuredClone(before) as unknown as SetupTestState;
      Object.assign(retried.tasks[1]!, { status: 'failed', error: 'workflow_worktree_setup_failed',
        setupAttempts: [setupAttempt()] });
      expect(retried.tasks[1]!.task.baseCommit).toBe('b'.repeat(40));
      expect(() => validateWorkflowStateTransition(before, retried)).not.toThrow();
    }
  });
  it('strictly parses and freezes bounded telemetry evidence in legacy and role-substitution histories', () => {
    const legacy = parseWorkflowState(legacyStateWithTelemetry());
    const legacyTelemetry = legacy.tasks[0]!.invocations![0]!.telemetry;
    expect(legacyTelemetry.evidence).toMatchObject({ terminalEventCount: 1,
      sessions: [{ value: sessionId, initEvents: 1, terminalEvents: 1 }] });
    expect(() => Object.assign(legacyTelemetry, { status: 'unknown' })).toThrow();
    expect(() => legacyTelemetry.evidence!.sessions.push({ value: sessionId, initEvents: 1 })).toThrow();
    expect(() => Object.assign(legacyTelemetry.evidence!.sessions[0]!, { initEvents: 2 })).toThrow();
    expect(() => Object.assign(legacy.reviewAttempts![0]!.telemetry.evidence!, { terminalEventCount: 2 })).toThrow();

    const versioned = completedState();
    versioned.tasks[0]!.invocations[0]!.telemetry = telemetry('claude');
    const parsed = parseWorkflowState(versioned);
    if (parsed.schemaVersion !== 2) throw new Error('Expected V2');
    expect(parsed.tasks[0]!.invocations![0]!.telemetry.evidence?.accountingEvidenceComplete).toBe(true);
    expect(() => Object.assign(parsed.tasks[0]!.invocations![0]!.telemetry.evidence!.models[0]!,
      { value: 'rewritten' })).toThrow();
  });
  it('parses coherent repeated result evidence without multiplying cumulative usage', () => {
    const repeated = legacyStateWithTelemetry();
    const evidence = repeated.tasks[0]!.invocations[0]!.telemetry.evidence;
    evidence.terminalEventCount = 4;
    Object.assign(evidence.sessions[0]!, { terminalEvents: 4 });
    evidence.models[0]!.terminalUsageBuckets = 4;
    evidence.terminalUsageBuckets[0]!.observations = 4;

    const parsed = parseWorkflowState(repeated);
    const telemetry = parsed.tasks[0]!.invocations![0]!.telemetry;
    expect(telemetry).toMatchObject({ status: 'measured', inputTokens: 10, outputTokens: 5 });
    expect(telemetry.evidence).toMatchObject({ terminalEventCount: 4,
      sessions: [{ initEvents: 1, terminalEvents: 4 }],
      models: [{ terminalUsageBuckets: 4 }], terminalUsageBuckets: [{ observations: 4 }] });

    const inconsistent = structuredClone(repeated);
    inconsistent.tasks[0]!.invocations[0]!.telemetry.evidence.terminalUsageBuckets[0]!.observations = 3;
    expect(() => parseWorkflowState(inconsistent)).toThrow('workflow_telemetry_evidence_mismatch');
  });
  it('rejects malformed or contradictory telemetry evidence and settled legacy rewrites', () => {
    const unknown = legacyStateWithTelemetry();
    Object.assign(unknown.tasks[0]!.invocations[0]!.telemetry.evidence, { transcript: 'private' });
    expect(() => parseWorkflowState(unknown)).toThrow('workflow_invalid_telemetry_evidence');

    const overflow = legacyStateWithTelemetry();
    overflow.tasks[0]!.invocations[0]!.telemetry.evidence.sessions = Array.from({ length: 9 }, (_, index) => ({
      value: `${String(index).padStart(8, '0')}-1234-4123-8123-123456789abc`, initEvents: 1, terminalEvents: 1,
    }));
    expect(() => parseWorkflowState(overflow)).toThrow('workflow_invalid_telemetry_evidence');

    const contradiction = legacyStateWithTelemetry();
    contradiction.tasks[0]!.invocations[0]!.telemetry.terminal = 'failure';
    expect(() => parseWorkflowState(contradiction)).toThrow('workflow_telemetry_evidence_mismatch');

    const forgedEvidence = [
      (value: ReturnType<typeof legacyStateWithTelemetry>) => { value.tasks[0]!.invocations[0]!.telemetry.inputTokens = 11; },
      (value: ReturnType<typeof legacyStateWithTelemetry>) => { value.tasks[0]!.invocations[0]!.telemetry.scope = 'turn'; },
      (value: ReturnType<typeof legacyStateWithTelemetry>) => { value.tasks[0]!.invocations[0]!.telemetry.evidence.terminalUsageBuckets = []; },
      (value: ReturnType<typeof legacyStateWithTelemetry>) => {
        value.tasks[0]!.invocations[0]!.telemetry.evidence.models[0]!.terminalUsageBuckets = 2;
      },
      (value: ReturnType<typeof legacyStateWithTelemetry>) => {
        Object.assign(value.tasks[0]!.invocations[0]!.telemetry.evidence.sessions[0]!, { terminalEvents: 2 });
      },
      (value: ReturnType<typeof legacyStateWithTelemetry>) => {
        value.tasks[0]!.invocations[0]!.telemetry.evidence.accountingEvidenceComplete = false;
      },
      (value: ReturnType<typeof legacyStateWithTelemetry>) => {
        value.tasks[0]!.invocations[0]!.telemetry.evidence.terminalUsageBuckets.push({
          ...value.tasks[0]!.invocations[0]!.telemetry.evidence.terminalUsageBuckets[0]!, observations: 2,
        });
      },
      (value: ReturnType<typeof legacyStateWithTelemetry>) => {
        Object.assign(value.tasks[0]!.invocations[0]!.telemetry.evidence, { sessions: [
          ...value.tasks[0]!.invocations[0]!.telemetry.evidence.sessions,
          { value: '87654321-1234-4123-8123-123456789abc', assistantEvents: 1 },
        ] });
        value.tasks[0]!.invocations[0]!.telemetry.evidence.identityConsistent = false;
      },
    ];
    for (const forge of forgedEvidence) {
      const forged = legacyStateWithTelemetry(); forge(forged);
      expect(() => parseWorkflowState(forged)).toThrow(/workflow_(?:invalid_telemetry_evidence|telemetry_evidence_mismatch)/);
    }

    const invalidCodexCache = legacyStateWithTelemetry();
    invalidCodexCache.reviewAttempts[0]!.telemetry.cacheReadTokens = 11;
    expect(() => parseWorkflowState(invalidCodexCache)).toThrow('workflow_telemetry_evidence_mismatch');

    const nonCodexSource = legacyStateWithTelemetry();
    Object.assign(nonCodexSource.tasks[0]!.invocations[0]!.telemetry.evidence.sessions[0]!, { threadEvents: 1 });
    expect(() => parseWorkflowState(nonCodexSource)).toThrow('workflow_telemetry_evidence_mismatch');
    const codexSource = legacyStateWithTelemetry();
    Object.assign(codexSource.reviewAttempts[0]!.telemetry.evidence.sessions[0]!, { initEvents: 1 });
    expect(() => parseWorkflowState(codexSource)).toThrow('workflow_telemetry_evidence_mismatch');
    const codexModels = legacyStateWithTelemetry();
    Object.assign(codexModels.reviewAttempts[0]!.telemetry.evidence, {
      models: [{ value: 'gpt-6-astra', terminalUsageBuckets: 1 }],
    });
    expect(() => parseWorkflowState(codexModels)).toThrow('workflow_telemetry_evidence_mismatch');

    const impossibleSource = legacyStateWithTelemetry();
    Object.assign(impossibleSource.tasks[0]!.invocations[0]!.telemetry.evidence.models[0]!, { threadEvents: 1 });
    expect(() => parseWorkflowState(impossibleSource)).toThrow('workflow_invalid_telemetry_evidence');

    const before = legacyStateWithTelemetry();
    const rewritten = structuredClone(before);
    rewritten.tasks[0]!.invocations[0]!.telemetry.durationMs++;
    expect(() => validateWorkflowStateTransition(before, rewritten)).toThrow('workflow_invocation_history_rewritten');
  });
  it('freezes durable telemetry evidence before incomplete invocations settle in both schemas', () => {
    const legacyBefore = legacyStateWithTelemetry();
    Object.assign(legacyBefore.tasks[0]!.invocations[0]!, {
      outcome: 'failed', error: 'workflow_invocation_incomplete',
    });
    const legacyAfter = structuredClone(legacyBefore);
    legacyAfter.tasks[0]!.invocations[0]!.telemetry.durationMs++;
    expect(() => validateWorkflowStateTransition(legacyBefore, legacyAfter))
      .toThrow('workflow_invocation_history_rewritten');

    const versionedBefore = completedState();
    versionedBefore.tasks[0]!.invocations[0]!.telemetry = telemetry('claude');
    Object.assign(versionedBefore.tasks[0]!.invocations[0]!, {
      outcome: 'failed', error: 'workflow_invocation_incomplete',
    });
    const versionedAfter = structuredClone(versionedBefore);
    versionedAfter.tasks[0]!.invocations[0]!.telemetry.durationMs++;
    expect(() => validateWorkflowStateTransition(versionedBefore, versionedAfter))
      .toThrow('workflow_invocation_history_rewritten');
  });
});
