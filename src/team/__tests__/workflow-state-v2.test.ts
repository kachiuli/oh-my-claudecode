import { describe, expect, it } from 'vitest';
import { assertWorkflowResumeBinding, parseWorkflowBinding, parseWorkflowState, validateWorkflowStateTransition } from '../workflow-contracts.js';

const hash = 'a'.repeat(64);
function binding(role = 'implementer', providerRoute = 'claude') {
  return { id: `${role}-${providerRoute}`, role, providerRoute,
    cliFamily: role === 'lead' ? 'external' : providerRoute === 'codex' ? 'codex-exec' : 'claude-code',
    model: providerRoute === 'codex' ? 'gpt-6-astra' : providerRoute === 'glm' ? 'glm-5.3' : 'claude-fable-5',
    authProfileRef: `profile-${providerRoute}`, authFingerprint: hash,
    ...(role === 'lead' ? {} : { executableIdentity: { path: 'C:/tools/provider.exe', sha256: hash, version: '1.0' } }),
    capabilities: role === 'lead' ? ['external-lead'] : role === 'reviewer' ? ['structured-findings', 'read-only'] : ['structured-handoff', 'session-resume'],
    capabilityEvidenceSha256: hash };
}
function legacyState() {
  const task = { id: 'one', objective: 'Update owned source', baseCommit: 'b'.repeat(40), writeScope: ['src/one.ts'],
    readScope: [], prohibitedScope: [], dependencies: [], contracts: [], acceptanceCriteria: ['Owned source works'], tests: [] };
  return { schemaVersion: 1, profile: 'claude-glm-codex', cwd: 'C:/project', integrationHead: 'b'.repeat(40),
    plan: { name: 'example', objective: 'Implement example', baseCommit: 'b'.repeat(40), integrationBranch: 'integration/example', tasks: [task], verification: [{ command: 'node', args: ['check.mjs'] }] },
    options: { mode: 'balanced', workers: 1, maxWorkers: 3, maxAttempts: 2, maxReviewPasses: 2, timeoutMs: 1000, backoffMs: 0, glmCommand: 'glm', codexCommand: 'codex' },
    tasks: [{ task, canonicalId: '1', status: 'pending', attempts: 0, worker: 'task-one', updatedAt: '2026-09-15T00:00:00.000Z' }],
    stage: 'implementation', reviewPasses: 0, reviews: [], createdAt: '2026-09-15T00:00:00.000Z', updatedAt: '2026-09-15T00:00:00.000Z' };
}
function state() {
  return { ...legacyState(), schemaVersion: 2, profile: 'role-substitution',
    bindings: { lead: binding('lead', 'codex'), implementer: binding(), reviewer: binding('reviewer', 'codex') }, substitutions: [] };
}
function completedState() {
  const worker = binding();
  const reviewer = binding('reviewer');
  const invocation = { invocationId: '11111111-1111-4111-8111-111111111111', binding: worker,
    attempt: 1, mode: 'fresh', model: worker.model, startedAt: '2026-09-15T00:00:01.000Z', outcome: 'completed', artifacts: [],
    telemetry: { provider: 'claude', durationMs: 1, status: 'unknown', scope: 'unknown' } };
  const review = { invocationId: '22222222-2222-4222-8222-222222222222', binding: reviewer,
    pass: 1, head: 'b'.repeat(40), model: reviewer.model, startedAt: '2026-09-15T00:00:02.000Z', outcome: 'completed', artifacts: [],
    provenance: { relation: 'self-review', authorIds: ['agent-a'], reviewerId: 'agent-a', context: 'fresh' },
    telemetry: { provider: 'claude', durationMs: 1, status: 'unknown', scope: 'unknown' } };
  return { ...state(), bindings: { ...state().bindings, reviewer }, tasks: [{ ...state().tasks[0], status: 'completed', attempts: 1, invocations: [invocation] }],
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

describe('versioned workflow contracts', () => {
  it.each(['claude-fable-5-1[1m]', 'opus[1m]', 'glm-5.3', 'gpt-6-astra'])('preserves the selected model %s without rewriting its context alias', model => {
    expect(parseWorkflowBinding({ ...binding(), model }).model).toBe(model);
  });
  it.each(['opus[1m]\n', 'opus[[1m]]', 'opus[]', 'opus[1m];run', 'opus token=example'])('rejects a malformed model literal %s', model => {
    expect(() => parseWorkflowBinding({ ...binding(), model })).toThrow(/workflow_/);
  });
  it('separates supported roles, provider routes and CLI families without changing model identity', () => {
    for (const [role, provider] of [['lead', 'claude'], ['lead', 'codex'], ['implementer', 'claude'], ['implementer', 'glm'], ['reviewer', 'claude'], ['reviewer', 'codex']]) {
      expect(parseWorkflowBinding(binding(role, provider))).toEqual(binding(role, provider));
    }
    for (const value of [binding('implementer', 'codex'), binding('reviewer', 'glm'),
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
});
