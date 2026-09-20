import { parseWorkflowState } from './workflow-contracts.js';
const tokenFields = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'];
function summarize(attempts, totalInvocations = attempts.length) {
    return {
        invocations: totalInvocations,
        measured: attempts.filter(attempt => attempt.status === 'measured').length,
        partial: attempts.filter(attempt => attempt.status === 'partial').length,
        unknown: totalInvocations - attempts.length + attempts.filter(attempt => attempt.status === 'unknown').length,
        knownTokens: Object.fromEntries(tokenFields.map(field => {
            const values = attempts.map(attempt => attempt[field]).filter((value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
            const sum = values.reduce((total, value) => total + value, 0);
            return [field, { tokens: values.length && Number.isSafeInteger(sum) ? sum : null,
                    reportedInvocations: values.length, totalInvocations,
                    ...(values.length && !Number.isSafeInteger(sum) ? { overflow: true } : {}) }];
        })),
    };
}
/** Report known observations and their coverage; absent measurements never become zero cost. */
export function workflowUsage(input) {
    // V2 requires a complete bound history. Do not infer missing attempts from today's selected route.
    const state = input.schemaVersion === 2 ? parseWorkflowState(input) : input;
    const invocations = state.tasks.flatMap(task => task.invocations ?? []);
    const reviews = state.reviewAttempts ?? [];
    const observations = [...invocations, ...reviews].map(attempt => attempt.telemetry);
    const bound = state.schemaVersion === 2
        ? [...state.tasks.flatMap(task => task.invocations ?? []), ...(state.reviewAttempts ?? [])] : undefined;
    const routes = bound ? ['glm', 'codex', 'claude'] : ['glm', 'codex'];
    return {
        name: state.plan.name,
        mode: state.options.mode ?? 'v1',
        accounting: 'CLI-reported tokens; input includes cached input. Partial totals are observations, not billing or savings estimates.',
        providers: routes.map(provider => {
            const attempts = bound ? bound.filter(attempt => attempt.binding.providerRoute === provider).map(attempt => attempt.telemetry)
                : observations.filter(attempt => attempt.provider === provider);
            const totalInvocations = bound ? attempts.length : Math.max(attempts.length, provider === 'glm'
                ? state.tasks.reduce((sum, task) => sum + task.attempts, 0) : state.reviewPasses);
            return { provider, ...summarize(attempts, totalInvocations) };
        }),
        ...(state.schemaVersion === 2 && bound ? {
            schemaVersion: 2, profile: state.profile,
            // Summarize only bindings actually reserved for an invocation, never an unused selected lead/route.
            bindings: [...new Map(bound.map(attempt => [attempt.binding.id, attempt.binding])).values()].map(binding => ({
                bindingId: binding.id, role: binding.role, provider: binding.providerRoute, model: binding.model,
                ...(binding.effort === undefined ? {} : { effort: binding.effort }),
                ...summarize(bound.filter(attempt => attempt.binding.id === binding.id).map(attempt => attempt.telemetry)),
            })),
            reviewAttemptRelations: Object.fromEntries(['independent', 'self-review', 'unknown']
                .map(relation => [relation, (state.reviewAttempts ?? []).filter(attempt => attempt.provenance.relation === relation).length])),
        } : {}),
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
//# sourceMappingURL=workflow-report.js.map