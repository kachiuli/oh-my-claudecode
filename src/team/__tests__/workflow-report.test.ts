import { describe, expect, it } from 'vitest';
import { workflowUsage } from '../workflow-report.js';
import { parseWorkflowBinding, type WorkflowState, type WorkflowInvocation, type WorkflowStateV2,
  type WorkflowRole, type WorkflowProviderRoute } from '../workflow-contracts.js';

function state(): WorkflowState {
  return {
    schemaVersion: 1, profile: 'claude-glm-codex', cwd: '/project', integrationHead: 'a'.repeat(40),
    plan: { name: 'report', objective: 'Implement feature', baseCommit: 'a'.repeat(40),
      integrationBranch: 'integration/report', tasks: [], verification: [] },
    options: { workers: 4, maxWorkers: 6, maxAttempts: 2, maxReviewPasses: 2,
      timeoutMs: 1000, backoffMs: 0, glmCommand: 'claude-glm', codexCommand: 'codex' },
    tasks: [], stage: 'implementation', reviews: [], reviewPasses: 0, createdAt: '', updatedAt: '',
  };
}
function invocation(inputTokens?: number): WorkflowInvocation {
  return { attempt: 1, mode: 'fresh', startedAt: '', outcome: 'failed', artifacts: [],
    telemetry: { provider: 'glm', durationMs: 10, status: inputTokens === undefined ? 'unknown' : 'partial',
      scope: 'main-loop', ...(inputTokens === undefined ? {} : { inputTokens }) } };
}
function task(invocations: WorkflowInvocation[]): WorkflowState['tasks'][number] {
  return { task: { id: 'backend', objective: 'Implement backend', baseCommit: 'a'.repeat(40),
    writeScope: ['src/backend'], readScope: [], prohibitedScope: [], dependencies: [],
    contracts: [], acceptanceCriteria: ['Works'], tests: [] },
    canonicalId: '1', status: 'accepted', attempts: invocations.length, worker: 'task-backend', updatedAt: '', invocations };
}

function binding(role: WorkflowRole, providerRoute: WorkflowProviderRoute) {
  return parseWorkflowBinding({ id: `${role}-${providerRoute}`, role, providerRoute,
    cliFamily: role === 'lead' ? 'external' : providerRoute === 'codex' ? 'codex-exec' : 'claude-code',
    model: providerRoute === 'codex' ? 'gpt-6-astra' : providerRoute === 'glm' ? 'glm-5.3' : 'claude-fable-5-1[1m]',
    authProfileRef: `profile-${providerRoute}`, authFingerprint: 'a'.repeat(64),
    ...(role === 'lead' ? {} : { executableIdentity: { path: 'C:/tools/provider.exe', sha256: 'b'.repeat(64), version: '1.0' } }),
    capabilities: role === 'lead' ? ['external-lead'] : role === 'reviewer' ? ['structured-findings', 'read-only'] : ['structured-handoff', 'session-resume'],
    capabilityEvidenceSha256: 'c'.repeat(64) });
}
function mixedState(): WorkflowStateV2 {
  const legacy = state();
  const startedAt = '2026-09-15T00:00:00.000Z';
  const glm = binding('implementer', 'glm'); const claude = binding('implementer', 'claude');
  const codex = binding('reviewer', 'codex'); const reviewer = binding('reviewer', 'claude');
  const worker = { ...task([]), session: undefined, attempts: 2, invocations: [
    { ...invocation(100), startedAt, invocationId: '11111111-1111-4111-8111-111111111111', binding: glm },
    { ...invocation(0), attempt: 2, mode: 'fresh' as const, outcome: 'completed' as const, startedAt,
      invocationId: '22222222-2222-4222-8222-222222222222', binding: claude,
      telemetry: { provider: 'claude' as const, durationMs: 10, status: 'measured' as const, scope: 'all-models' as const,
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } },
  ] };
  return { ...legacy, schemaVersion: 2, profile: 'role-substitution',
    plan: { ...legacy.plan, tasks: [worker.task], verification: [{ command: 'node', args: ['check.mjs'] }] },
    options: { ...legacy.options, mode: 'balanced', maxReviewPasses: 3 }, tasks: [worker],
    bindings: { lead: binding('lead', 'codex'), implementer: claude, reviewer },
    substitutions: [
      { sequence: 1, role: 'implementer', from: glm, to: claude, reason: 'Selected available Claude', authorityRef: 'decision-one',
        head: legacy.integrationHead, at: startedAt, taskId: worker.task.id, afterAttempt: 1 },
      { sequence: 2, role: 'reviewer', from: codex, to: reviewer, reason: 'Selected available Claude', authorityRef: 'decision-two',
        head: legacy.integrationHead, at: startedAt, afterReviewPass: 1 },
    ], reviewPasses: 3, reviewAttempts: [
      { pass: 1, head: legacy.integrationHead, startedAt, outcome: 'failed', artifacts: [],
        invocationId: '33333333-3333-4333-8333-333333333333', binding: codex,
        provenance: { relation: 'independent', authorIds: ['author-a'], reviewerId: 'reviewer-b', context: 'fresh' },
        telemetry: { provider: 'codex', durationMs: 10, status: 'unknown', scope: 'unknown' } },
      { pass: 2, head: legacy.integrationHead, startedAt, outcome: 'completed', artifacts: [],
        invocationId: '44444444-4444-4444-8444-444444444444', binding: reviewer,
        provenance: { relation: 'self-review', authorIds: ['author-a'], reviewerId: 'author-a', context: 'fresh' },
        telemetry: { provider: 'claude', durationMs: 10, status: 'partial', scope: 'main-loop', inputTokens: 200 } },
      { pass: 3, head: legacy.integrationHead, startedAt, outcome: 'failed', artifacts: [], error: 'workflow_invocation_incomplete',
        invocationId: '55555555-5555-4555-8555-555555555555', binding: reviewer,
        provenance: { relation: 'unknown', authorIds: [], reviewerId: 'unconfirmed', context: 'unknown' },
        telemetry: { provider: 'claude', durationMs: 0, status: 'unknown', scope: 'unknown' } },
    ] };
}

describe('workflow usage report', () => {
  it('attributes V2 mixed worker and review attempts to each saved binding, including unmeasured failures', () => {
    const input = mixedState(); const before = JSON.stringify(input);
    const report = workflowUsage(input);
    expect(report).toMatchObject({ schemaVersion: 2, profile: 'role-substitution',
      reviewAttemptRelations: { independent: 1, 'self-review': 1, unknown: 1 } });
    expect(report.providers).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'glm', invocations: 1, partial: 1, unknown: 0 }),
      expect.objectContaining({ provider: 'claude', invocations: 3, measured: 1, partial: 1, unknown: 1,
        knownTokens: expect.objectContaining({ inputTokens: { tokens: 200, reportedInvocations: 2, totalInvocations: 3 } }) }),
      expect.objectContaining({ provider: 'codex', invocations: 1, unknown: 1 }),
    ]));
    expect(report.bindings).toMatchObject([
      { bindingId: 'implementer-glm', role: 'implementer', provider: 'glm', model: 'glm-5.3', invocations: 1 },
      { bindingId: 'implementer-claude', role: 'implementer', provider: 'claude', model: 'claude-fable-5-1[1m]', invocations: 1,
        knownTokens: { inputTokens: { tokens: 0, reportedInvocations: 1, totalInvocations: 1 } } },
      { bindingId: 'reviewer-codex', role: 'reviewer', provider: 'codex', model: 'gpt-6-astra', invocations: 1 },
      { bindingId: 'reviewer-claude', role: 'reviewer', provider: 'claude', model: 'claude-fable-5-1[1m]', invocations: 2,
        knownTokens: { inputTokens: { tokens: 200, reportedInvocations: 1, totalInvocations: 2 } } },
    ]);
    expect(report.quality).toMatchObject({ retries: 1, resumedInvocations: 0, reviewPasses: 3, failedReviewAttempts: 2 });
    expect(JSON.stringify(report)).not.toMatch(/authFingerprint|authProfileRef|executableIdentity|author-a/);
    expect(JSON.stringify(input)).toBe(before);
  });

  it('does not rewrite historical totals when the selected V2 binding changes without another invocation', () => {
    const input = mixedState(); const before = workflowUsage(input);
    const next = parseWorkflowBinding({ ...input.bindings.implementer, id: 'implementer-next', model: 'opus[1m]' });
    input.substitutions = [...input.substitutions, { sequence: 3, role: 'implementer', from: input.bindings.implementer, to: next,
      reason: 'Explicit next model', authorityRef: 'decision-three', head: input.integrationHead,
      at: '2026-09-15T00:01:00.000Z', taskId: 'backend', afterAttempt: 2 }];
    input.bindings = { ...input.bindings, implementer: next };
    expect(workflowUsage(input)).toEqual(before);
  });

  it('refuses missing V2 histories and contradictory route metadata rather than inferring provider work', () => {
    const missingWorker = mixedState(); missingWorker.tasks[0].invocations = [];
    const missingReview = mixedState(); missingReview.reviewAttempts = [];
    const wrongRoute = mixedState(); wrongRoute.tasks[0].invocations![0].telemetry.provider = 'claude';
    for (const input of [missingWorker, missingReview, wrongRoute]) {
      expect(() => workflowUsage(input)).toThrow(/workflow_(attempt_history_mismatch|review_history_mismatch|telemetry_route_mismatch)/);
    }
  });

  it('retains V2 field coverage and refuses aggregate overflow across saved bindings', () => {
    const input = mixedState(); input.tasks[0].invocations![1].telemetry.inputTokens = Number.MAX_SAFE_INTEGER;
    const report = workflowUsage(input);
    expect(report.providers.find(entry => entry.provider === 'claude')?.knownTokens.inputTokens).toEqual({
      tokens: null, reportedInvocations: 2, totalInvocations: 3, overflow: true });
    expect(report.bindings?.find(entry => entry.bindingId === 'implementer-claude')?.knownTokens.inputTokens.tokens).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('leaves unmeasured V1 usage unknown and never reports free work', () => {
    const report = workflowUsage(state());
    expect(report.mode).toBe('v1');
    expect(report).not.toHaveProperty('bindings');
    expect(report).not.toHaveProperty('reviewAttemptRelations');
    expect(report.providers.map(entry => entry.provider)).toEqual(['glm', 'codex']);
    expect(report.providers[0].knownTokens.inputTokens).toEqual({ tokens: null, reportedInvocations: 0, totalInvocations: 0 });
    expect(report.quality.verificationPassed).toBeNull();
    const old = state();
    old.tasks.push({ ...task([]), attempts: 2 });
    old.reviewPasses = 1;
    expect(workflowUsage(old).providers[0]).toMatchObject({ invocations: 2, unknown: 2,
      knownTokens: { inputTokens: { tokens: null, totalInvocations: 2 } } });
    expect(workflowUsage(old).providers[1]).toMatchObject({ invocations: 1, unknown: 1 });
  });

  it('includes failed and resumed work once with field-level coverage and quality outcomes', () => {
    const input = state();
    const failed = invocation(100);
    const resumed = { ...invocation(200), attempt: 2, mode: 'resume' as const, outcome: 'completed' as const };
    input.options.mode = 'balanced';
    input.tasks.push(task([failed, resumed, invocation()]));
    input.verification = { head: 'b'.repeat(40), passed: true, checks: [] };
    input.reviewPasses = 1;
    input.reviewAttempts = [{ pass: 1, head: input.integrationHead, startedAt: '', outcome: 'failed', artifacts: [],
      telemetry: { provider: 'codex', durationMs: 20, status: 'measured', scope: 'turn', inputTokens: 1000, cacheReadTokens: 800, outputTokens: 100 } }];
    input.reviews = [{ pass: 1, head: input.integrationHead, artifacts: [], findings: [
      { id: 'review-1-1', severity: 'P1', message: 'Needs fixing', disposition: 'fix' },
      { id: 'review-1-2', severity: 'P3', message: 'Dismissed', disposition: 'dismiss', reason: 'Not applicable' },
    ] }];
    const report = workflowUsage(input);
    expect(report.providers[0]).toMatchObject({ invocations: 3, partial: 2, unknown: 1,
      knownTokens: { inputTokens: { tokens: 300, reportedInvocations: 2, totalInvocations: 3 } } });
    expect(report.providers[1].knownTokens).toMatchObject({ inputTokens: { tokens: 1000 }, cacheReadTokens: { tokens: 800 }, cacheWriteTokens: { tokens: null } });
    expect(report.quality).toMatchObject({ accepted: 1, retries: 2, resumedInvocations: 1,
      verificationPassed: true, verificationCurrent: false, failedReviewAttempts: 1, unresolvedFindings: 1, complete: false });
  });

  it('preserves explicitly measured zero and refuses unsafe aggregate totals', () => {
    const input = state();
    input.tasks.push(task([invocation(0)]));
    expect(workflowUsage(input).providers[0].knownTokens.inputTokens.tokens).toBe(0);
    input.tasks[0].invocations = [invocation(Number.MAX_SAFE_INTEGER), invocation(1)];
    expect(workflowUsage(input).providers[0].knownTokens.inputTokens).toMatchObject({ tokens: null, overflow: true, reportedInvocations: 2 });
  });
});
