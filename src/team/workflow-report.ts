import type { WorkflowState } from './workflow-contracts.js';
import type { WorkflowTelemetry } from './workflow-usage.js';

const tokenFields = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const;

/** Report known observations and their coverage; absent measurements never become zero cost. */
export function workflowUsage(state: WorkflowState) {
  const invocations = state.tasks.flatMap(task => task.invocations ?? []);
  const reviews = state.reviewAttempts ?? [];
  const observations: WorkflowTelemetry[] = [...invocations, ...reviews].map(attempt => attempt.telemetry);
  return {
    name: state.plan.name,
    mode: state.options.mode ?? 'v1',
    accounting: 'CLI-reported tokens; input includes cached input. Partial totals are observations, not billing or savings estimates.',
    providers: (['glm', 'codex'] as const).map(provider => {
      const attempts = observations.filter(attempt => attempt.provider === provider);
      const totalInvocations = Math.max(attempts.length, provider === 'glm'
        ? state.tasks.reduce((sum, task) => sum + task.attempts, 0) : state.reviewPasses);
      return {
        provider, invocations: totalInvocations,
        measured: attempts.filter(attempt => attempt.status === 'measured').length,
        partial: attempts.filter(attempt => attempt.status === 'partial').length,
        unknown: totalInvocations - attempts.length + attempts.filter(attempt => attempt.status === 'unknown').length,
        knownTokens: Object.fromEntries(tokenFields.map(field => {
          const values = attempts.map(attempt => attempt[field]).filter((value): value is number =>
            typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
          const sum = values.reduce((total, value) => total + value, 0);
          return [field, { tokens: values.length && Number.isSafeInteger(sum) ? sum : null,
            reportedInvocations: values.length, totalInvocations,
            ...(values.length && !Number.isSafeInteger(sum) ? { overflow: true } : {}) }];
        })),
      };
    }),
    quality: {
      tasks: state.tasks.length,
      accepted: state.tasks.filter(task => task.status === 'accepted').length,
      failed: state.tasks.filter(task => task.status === 'failed').length,
      rejected: state.tasks.filter(task => task.status === 'rejected').length,
      retries: state.tasks.reduce((sum, task) => sum + Math.max(0, task.attempts - 1), 0),
      resumedInvocations: invocations.filter(attempt => attempt.mode === 'resume').length,
      verificationPassed: state.verification?.passed ?? null,
      verificationCurrent: state.verification ? state.verification.head === state.integrationHead : null,
      reviewPasses: state.reviewPasses,
      failedReviewAttempts: reviews.filter(review => review.outcome === 'failed').length,
      unresolvedFindings: state.reviews.flatMap(review => review.findings)
        .filter(finding => !finding.disposition || finding.disposition === 'fix' && !finding.fixedBy).length,
      complete: state.stage === 'complete',
    },
  };
}
