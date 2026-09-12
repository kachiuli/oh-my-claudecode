import { describe, expect, it } from 'vitest';
import { workflowUsage } from '../workflow-report.js';
import type { WorkflowState, WorkflowInvocation } from '../workflow-contracts.js';

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

describe('workflow usage report', () => {
  it('leaves unmeasured V1 usage unknown and never reports free work', () => {
    const report = workflowUsage(state());
    expect(report.mode).toBe('v1');
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
