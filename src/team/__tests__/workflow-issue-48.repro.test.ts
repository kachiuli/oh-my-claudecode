import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import type { WorkflowProcessResult } from '../workflow-process.js';

const observed = vi.hoisted(() => ({
  processRuns: [] as Array<{ timeoutMs: number | null; worker?: string; result: WorkflowProcessResult }>,
  providerFault: undefined as undefined | 'incomplete-output' | 'nonzero-parent' | 'unverified-descendants',
  revokeFailure: false,
}));

vi.mock('../workflow-process.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../workflow-process.js')>();
  return {
    ...actual,
    runWorkflowProcess: vi.fn(async (input: Parameters<typeof actual.runWorkflowProcess>[0]) => {
      let result = await actual.runWorkflowProcess(input);
      if (input.timeoutMs === null && input.worker === 'task-a' && observed.providerFault && result.settlement) {
        const settlement = result.settlement;
        if (observed.providerFault === 'incomplete-output') result = { ...result, passed: false, error: 'output_incomplete',
          settlement: { ...settlement, outputComplete: false, descendants: 'unverified' } };
        if (observed.providerFault === 'nonzero-parent') result = { ...result, passed: false, error: 'process_failed',
          parentExitedSuccessfully: false, settlement: { ...settlement, parentExitCode: 17, descendants: 'unverified' } };
        if (observed.providerFault === 'unverified-descendants') result = { ...result, passed: false, error: 'interrupted',
          settlement: { ...settlement, termination: 'attempted', descendants: 'unverified' } };
      }
      observed.processRuns.push({ timeoutMs: input.timeoutMs, worker: input.worker, result });
      return result;
    }),
  };
});

vi.mock('../workflow-publication.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../workflow-publication.js')>();
  return {
    ...actual,
    issueWorkflowPublication: (input: Parameters<typeof actual.issueWorkflowPublication>[0]) => {
      const issued = actual.issueWorkflowPublication(input);
      if (!observed.revokeFailure) return issued;
      return Object.freeze({ environment: issued.environment, revoke() {
        issued.revoke();
        throw new Error('workflow_publication_revoke_failed');
      } });
    },
  };
});

import { acceptWorkflowTask, initWorkflow, initWorkflowV2, readWorkflow, reviewWorkflow, runWorkflow, verifyWorkflow } from '../workflow.js';
import { parseWorkflowState, validateWorkflowStateTransition } from '../workflow-contracts.js';
import { binding, runtimeFixture } from './helpers/workflow-v2-fixture.js';
import { createWorkflowFixture } from './helpers/workflow-fixture.js';

const legacyProvider = fileURLToPath(new URL('./helpers/workflow-provider.cjs', import.meta.url));

describe('issue #48 supervised process evidence persistence', () => {
  let fixture: ReturnType<typeof createWorkflowFixture>;

  beforeEach(() => {
    fixture = createWorkflowFixture();
    observed.processRuns.length = 0;
    observed.providerFault = undefined;
    observed.revokeFailure = false;
    vi.stubEnv('OMC_STATE_DIR', '');
    vi.stubEnv('OMC_WORKFLOW_TEST_CONFIG', fixture.configPath);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fixture.dispose();
  });

  function plan(name: string) {
    return {
      name,
      objective: 'Persist supervised process settlement evidence',
      baseCommit: fixture.baseCommit,
      integrationBranch: `integration/${name}`,
      verification: [{ command: process.execPath, args: ['-e', 'process.exit(0)'] }],
      tasks: [{
        id: 'a',
        objective: 'Implement the synthetic component',
        baseCommit: fixture.baseCommit,
        writeScope: ['feature/a.txt'],
        readScope: ['README.md'],
        prohibitedScope: [],
        dependencies: [],
        contracts: ['Commit one complete synthetic component'],
        acceptanceCriteria: ['The component is committed'],
        tests: [],
      }],
    };
  }

  function snapshot(result: WorkflowProcessResult) {
    return {
      passed: result.passed,
      ...(result.error === undefined ? {} : { error: result.error }),
      parentExitedSuccessfully: result.parentExitedSuccessfully,
      stdoutTruncated: result.stdoutTruncated,
      ...(result.settlement === undefined ? {} : { settlement: result.settlement }),
    };
  }

  async function initVersioned(name = 'issue-48', reviewerRoute: 'codex' | 'claude' = 'codex') {
    const configured = runtimeFixture(fixture);
    const implementer = configured.selectedBinding('implementer', 'claude', 'issue-48-author');
    const reviewer = configured.selectedBinding('reviewer', reviewerRoute, 'issue-48-reviewer');
    await initWorkflowV2(fixture.cwd, plan(name), { lead: binding('lead', 'codex'), implementer, reviewer }, {
      maxAttempts: 1,
      backoffMs: 0,
      providerPolicy: 'unbounded-provider-timeout',
    });
    return configured;
  }

  it('persists the observed process-result snapshot on the exact implementer and reviewer invocations', async () => {
    const configured = await initVersioned();

    const completed = await runWorkflow(fixture.cwd, 'issue-48', configured.runtime);
    if (completed.schemaVersion !== 2) throw new Error('Expected V2 workflow');
    const invocationId = completed.tasks[0]!.invocations![0]!.invocationId;
    await acceptWorkflowTask(fixture.cwd, 'issue-48', 'a');
    await verifyWorkflow(fixture.cwd, 'issue-48');
    const reviewed = await reviewWorkflow(fixture.cwd, 'issue-48', configured.runtime);
    if (reviewed.schemaVersion !== 2) throw new Error('Expected V2 workflow');
    const reviewInvocationId = reviewed.reviewAttempts![0]!.invocationId;
    const providerRuns = observed.processRuns.filter(run => run.timeoutMs === null);
    expect(providerRuns).toHaveLength(2);
    expect(providerRuns.every(run => run.result.settlement !== undefined)).toBe(true);

    const reloaded = readWorkflow(fixture.cwd, 'issue-48');
    if (reloaded.schemaVersion !== 2) throw new Error('Expected V2 workflow');
    const persisted = reloaded.tasks[0]!.invocations!.find(invocation => invocation.invocationId === invocationId);
    const persistedReview = reloaded.reviewAttempts!.find(attempt => attempt.invocationId === reviewInvocationId);

    expect(persisted!.processResult).toEqual(snapshot(providerRuns[0]!.result));
    expect(persistedReview!.processResult).toEqual(snapshot(providerRuns[1]!.result));
    const rewrittenReview = structuredClone(reloaded);
    const mutableReview = rewrittenReview.reviewAttempts![0]!.processResult as { stdoutTruncated: boolean };
    mutableReview.stdoutTruncated = !mutableReview.stdoutTruncated;
    expect(() => validateWorkflowStateTransition(reloaded, rewrittenReview))
      .toThrow('workflow_process_result_history_rewritten');
  }, 30_000);

  it.each([
    ['incomplete-output', { error: 'output_incomplete', outputComplete: false }],
    ['nonzero-parent', { error: 'process_failed', parentExitCode: 17 }],
    ['unverified-descendants', { error: 'interrupted', descendants: 'unverified' }],
  ] as const)('persists the actual %s process failure before downstream validation', async (fault, expected) => {
    const evidence = expected as { error: string; outputComplete?: boolean; parentExitCode?: number; descendants?: string };
    observed.providerFault = fault;
    const configured = await initVersioned();
    const failed = await runWorkflow(fixture.cwd, 'issue-48', configured.runtime);
    if (failed.schemaVersion !== 2) throw new Error('Expected V2 workflow');
    const providerRun = observed.processRuns.find(run => run.timeoutMs === null && run.worker === 'task-a')!;
    const persisted = readWorkflow(fixture.cwd, 'issue-48');
    if (persisted.schemaVersion !== 2) throw new Error('Expected V2 workflow');

    expect(failed.tasks[0]!.status).toBe('failed');
    expect(persisted.tasks[0]!.invocations![0]!.processResult).toEqual(snapshot(providerRun.result));
    expect(persisted.tasks[0]!.invocations![0]!.processResult).toMatchObject({
      error: evidence.error,
      settlement: {
        ...(evidence.outputComplete === undefined ? {} : { outputComplete: evidence.outputComplete }),
        ...(evidence.parentExitCode === undefined ? {} : { parentExitCode: evidence.parentExitCode }),
        ...(evidence.descendants === undefined ? {} : { descendants: evidence.descendants }),
      },
    });
  }, 20_000);

  it('preserves historical absence and permits only one durable observation on a trailing incomplete invocation', async () => {
    const configured = await initVersioned();
    const completed = await runWorkflow(fixture.cwd, 'issue-48', configured.runtime);
    if (completed.schemaVersion !== 2) throw new Error('Expected V2 workflow');
    const currentResult = completed.tasks[0]!.invocations![0]!.processResult!;

    const historical = structuredClone(completed);
    Reflect.deleteProperty(historical.tasks[0]!.invocations![0]!, 'processResult');
    const parsedHistorical = parseWorkflowState(historical);
    expect(parsedHistorical.tasks[0]!.invocations![0]!.processResult).toBeUndefined();

    const retrocertified = structuredClone(historical);
    Object.assign(retrocertified.tasks[0]!.invocations![0]!, { processResult: currentResult });
    expect(() => validateWorkflowStateTransition(historical, retrocertified))
      .toThrow('workflow_process_result_history_rewritten');

    const reserved = structuredClone(historical);
    Object.assign(reserved.tasks[0]!.invocations![0]!, { outcome: 'failed', error: 'workflow_invocation_incomplete' });
    const observedState = structuredClone(reserved);
    Object.assign(observedState.tasks[0]!.invocations![0]!, { processResult: currentResult });
    expect(() => validateWorkflowStateTransition(reserved, observedState)).not.toThrow();

    const rewritten = structuredClone(observedState);
    const mutable = rewritten.tasks[0]!.invocations![0]!.processResult as { stdoutTruncated: boolean };
    mutable.stdoutTruncated = !mutable.stdoutTruncated;
    expect(() => validateWorkflowStateTransition(observedState, rewritten))
      .toThrow('workflow_process_result_history_rewritten');

    const malformed = structuredClone(completed) as unknown as { tasks: Array<{ invocations: Array<{ processResult: Record<string, unknown> }> }> };
    malformed.tasks[0]!.invocations[0]!.processResult.output = 'must never persist';
    expect(() => parseWorkflowState(malformed)).toThrow('workflow_unknown_field');
    for (const mutate of [
      (processResult: Record<string, unknown>) => { processResult.error = 'unknown_failure'; },
      (processResult: Record<string, unknown>) => { processResult.parentExitedSuccessfully = false; },
      (processResult: Record<string, unknown>) => {
        (processResult.settlement as Record<string, unknown>).descendants = 'escaped';
      },
      (processResult: Record<string, unknown>) => {
        (processResult.settlement as Record<string, unknown>).outputComplete = false;
      },
      (processResult: Record<string, unknown>) => {
        processResult.passed = false;
        processResult.error = 'protocol_failed';
        processResult.parentExitedSuccessfully = false;
        const settlement = processResult.settlement as Record<string, unknown>;
        settlement.directChild = 'unconfirmed';
        settlement.descendants = 'cleaned';
      },
      (processResult: Record<string, unknown>) => {
        processResult.passed = false;
        processResult.error = 'launch_failed';
        processResult.parentExitedSuccessfully = false;
        const settlement = processResult.settlement as Record<string, unknown>;
        settlement.parentExitCode = null;
        settlement.directChild = 'not-started';
        settlement.descendants = 'unverified';
      },
      (processResult: Record<string, unknown>) => {
        processResult.passed = false;
        processResult.error = 'process_failed';
        processResult.parentExitedSuccessfully = false;
        const settlement = processResult.settlement as Record<string, unknown>;
        settlement.parentExitCode = 17;
        settlement.descendants = 'cleaned';
      },
    ]) {
      const invalid = structuredClone(completed) as unknown as { tasks: Array<{ invocations: Array<{ processResult: Record<string, unknown> }> }> };
      mutate(invalid.tasks[0]!.invocations[0]!.processResult);
      expect(() => parseWorkflowState(invalid)).toThrow('workflow_invalid_process_result');
    }
  }, 20_000);

  it('keeps implementer process evidence when downstream handoff parsing fails', async () => {
    fixture.configure({ tasks: { a: { malformedHandoff: true } } });
    const configured = await initVersioned();
    const failed = await runWorkflow(fixture.cwd, 'issue-48', configured.runtime);
    if (failed.schemaVersion !== 2) throw new Error('Expected V2 workflow');
    const providerRun = observed.processRuns.find(run => run.timeoutMs === null && run.worker === 'task-a')!;
    const persisted = readWorkflow(fixture.cwd, 'issue-48');
    if (persisted.schemaVersion !== 2) throw new Error('Expected V2 workflow');

    expect(providerRun.result).toMatchObject({ passed: true, settlement: { outputComplete: true } });
    expect(failed.tasks[0]).toMatchObject({ status: 'failed' });
    expect(persisted.tasks[0]!.invocations![0]!.processResult).toEqual(snapshot(providerRun.result));
  }, 20_000);

  it('keeps implementer process evidence when post-run publication cleanup fails', async () => {
    observed.revokeFailure = true;
    const configured = await initVersioned();
    const failed = await runWorkflow(fixture.cwd, 'issue-48', configured.runtime);
    const providerRun = observed.processRuns.find(run => run.timeoutMs === null && run.worker === 'task-a')!;
    const persisted = readWorkflow(fixture.cwd, 'issue-48');
    if (persisted.schemaVersion !== 2) throw new Error('Expected V2 workflow');

    expect(providerRun.result).toMatchObject({ passed: true, settlement: { outputComplete: true } });
    expect(failed.tasks[0]).toMatchObject({ status: 'failed', error: 'workflow_publication_revoke_failed' });
    expect(persisted.tasks[0]!.invocations![0]!.processResult).toEqual(snapshot(providerRun.result));
  }, 20_000);

  it('keeps reviewer process evidence when downstream structured findings parsing fails', async () => {
    const configured = await initVersioned('issue-48', 'claude');
    await runWorkflow(fixture.cwd, 'issue-48', configured.runtime);
    await acceptWorkflowTask(fixture.cwd, 'issue-48', 'a');
    await verifyWorkflow(fixture.cwd, 'issue-48');
    fixture.configure({ tasks: { review: { omitStructuredResult: true } } });

    await expect(reviewWorkflow(fixture.cwd, 'issue-48', configured.runtime)).rejects.toThrow(/workflow_/);
    const reviewerRun = observed.processRuns.filter(run => run.timeoutMs === null && run.worker === undefined).at(-1)!;
    const persisted = readWorkflow(fixture.cwd, 'issue-48');
    if (persisted.schemaVersion !== 2) throw new Error('Expected V2 workflow');

    expect(reviewerRun.result).toMatchObject({ passed: true, settlement: { outputComplete: true } });
    expect(persisted.reviewAttempts![0]!.outcome).toBe('failed');
    expect(persisted.reviewAttempts![0]!.processResult).toEqual(snapshot(reviewerRun.result));
  }, 30_000);

  it('strictly parses the same process-result evidence in a legacy workflow without migrating absent history', async () => {
    await initWorkflow(fixture.cwd, plan('issue-48-legacy'), {
      mode: 'balanced', maxAttempts: 1, backoffMs: 0,
      glmCommand: legacyProvider, glmModel: 'glm-test', codexCommand: legacyProvider, codexModel: 'codex-test',
      providerPolicy: 'unbounded-provider-timeout',
    });
    await runWorkflow(fixture.cwd, 'issue-48-legacy');
    const providerRun = observed.processRuns.find(run => run.timeoutMs === null && run.worker === 'task-a')!;
    const persisted = readWorkflow(fixture.cwd, 'issue-48-legacy');
    expect(persisted.schemaVersion).toBe(1);
    expect(persisted.tasks[0]!.invocations![0]!.processResult).toEqual(snapshot(providerRun.result));

    const historical = structuredClone(persisted);
    Reflect.deleteProperty(historical.tasks[0]!.invocations![0]!, 'processResult');
    expect(parseWorkflowState(historical).tasks[0]!.invocations![0]!.processResult).toBeUndefined();
  }, 20_000);
});
