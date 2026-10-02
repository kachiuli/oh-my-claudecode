import { describe, expect, it } from 'vitest';
import { parseWorkflowState } from '../workflow-contracts.js';
import { createWorkflowUsageCollector } from '../workflow-usage.js';

const sessionId = '12345678-1234-4123-8123-123456789abc';
const otherSessionId = '87654321-1234-4123-8123-123456789abc';
const init = { type: 'system', subtype: 'init', session_id: sessionId, model: 'glm-5.3' };
const started = { type: 'system', subtype: 'task_started', task_id: 'shell-1', tool_use_id: 'toolu-shell-1',
  task_type: 'local_bash', is_backgrounded: false, session_id: sessionId };
const notification = { type: 'system', subtype: 'task_notification', task_id: 'shell-1',
  tool_use_id: 'toolu-shell-1', status: 'completed', session_id: sessionId };
const result = { type: 'result', subtype: 'success', session_id: sessionId, modelUsage: {
  'glm-5.3': { inputTokens: 100, outputTokens: 30, cacheReadInputTokens: 80, cacheCreationInputTokens: 20 },
} };
function collect(events: unknown[], provider: 'glm' | 'claude' = 'glm', passed = true) {
  const collector = createWorkflowUsageCollector(provider);
  collector.write(Buffer.from(events.map(event => JSON.stringify(event)).join('\n')));
  return collector.finish({ durationMs: 12, passed });
}

describe('foreground shell task usage accounting', () => {
  it.each(['glm', 'claude'] as const)('resolves a matching %s foreground shell notification without another model result', provider => {
    for (const events of [[init, started, notification, result], [init, started, result, notification]]) {
      const telemetry = collect(events, provider);
      expect(telemetry).toMatchObject({ provider, status: 'measured', scope: 'all-models', terminal: 'success',
        inputTokens: 200, outputTokens: 30, cacheReadTokens: 80, cacheWriteTokens: 20, sessionId });
      expect(telemetry.diagnostics).toBeUndefined();
      expect(telemetry.evidence).toEqual({ version: 1, diagnosticLogComplete: true, eventStreamComplete: true,
        identityEvidenceComplete: true, identityConsistent: true, accountingEvidenceComplete: true,
        terminalEventCount: 1, sessions: [{ value: sessionId, initEvents: 1, terminalEvents: 1 }],
        models: [{ value: 'glm-5.3', initEvents: 1, terminalUsageBuckets: 1 }],
        terminalUsageBuckets: [{ model: 'glm-5.3', ...result.modelUsage['glm-5.3'], observations: 1 }] });
    }
  });

  it('keeps foreground shell notifications separate from Agent model continuations', () => {
    const telemetry = collect([init, started,
      { ...started, task_id: 'agent-1', tool_use_id: 'toolu-agent-1', task_type: 'local_agent' }, result,
      { ...notification, task_id: 'agent-1', tool_use_id: 'toolu-agent-1' }, notification,
      { ...result, origin: { kind: 'task-notification', task_id: 'agent-1' } },
    ]);
    expect(telemetry).toMatchObject({ status: 'measured', inputTokens: 200, outputTokens: 30 });
    expect(telemetry.evidence).toMatchObject({ identityEvidenceComplete: true, accountingEvidenceComplete: true,
      terminalEventCount: 2, terminalUsageBuckets: [{ observations: 2 }] });
  });

  it.each([
    { name: 'background shell', patch: { is_backgrounded: true } },
    { name: 'missing background flag', patch: { is_backgrounded: undefined } },
    { name: 'null background flag', patch: { is_backgrounded: null } },
    { name: 'numeric background flag', patch: { is_backgrounded: 0 } },
    { name: 'string background flag', patch: { is_backgrounded: 'false' } },
    { name: 'Agent task', patch: { task_type: 'local_agent' } },
    { name: 'unknown task type', patch: { task_type: 'future_task' } },
    { name: 'missing task type', patch: { task_type: undefined } },
    { name: 'malformed task type', patch: { task_type: ['local_bash'] } },
  ])('does not waive the model result for a $name', ({ patch }) => {
    const telemetry = collect([init, { ...started, ...patch }, result, notification]);
    expect(telemetry).toMatchObject({ status: 'partial', inputTokens: 200, outputTokens: 30,
      diagnostics: expect.arrayContaining(['unresolved_task']) });
    expect(telemetry.evidence).toMatchObject({ identityEvidenceComplete: false, accountingEvidenceComplete: false });
  });

  describe.each(['patch', 'top-level'] as const)('%s classification updates', location => {
    function update(classification: Record<string, unknown>) {
      return { type: 'system', subtype: 'task_updated', task_id: started.task_id,
        ...(location === 'patch' ? { patch: classification } : classification) };
    }

    it('accepts unchanged foreground classification before and after completion', () => {
      for (const classification of [{}, { task_type: 'local_bash' }, { is_backgrounded: false },
        { task_type: 'local_bash', is_backgrounded: false }]) {
        const telemetry = collect([init, started, update(classification), result, notification, update(classification)]);
        expect(telemetry).toMatchObject({ status: 'measured', inputTokens: 200, outputTokens: 30 });
        expect(telemetry.evidence).toMatchObject({ identityEvidenceComplete: true, accountingEvidenceComplete: true });
      }
    });

    it.each([
      { name: 'background transition', classification: { is_backgrounded: true } },
      { name: 'null background flag', classification: { is_backgrounded: null } },
      { name: 'numeric background flag', classification: { is_backgrounded: 0 } },
      { name: 'string background flag', classification: { is_backgrounded: 'false' } },
      { name: 'Agent reclassification', classification: { task_type: 'local_agent' } },
      { name: 'unknown reclassification', classification: { task_type: 'future_task' } },
      { name: 'null task type', classification: { task_type: null } },
      { name: 'malformed task type', classification: { task_type: ['local_bash'] } },
    ])('rejects $name before and after completion', ({ classification }) => {
      for (const events of [[init, started, update(classification), result, notification],
        [init, started, result, notification, update(classification)]]) {
        const telemetry = collect(events);
        expect(telemetry).toMatchObject({ status: 'partial', inputTokens: 200, outputTokens: 30,
          diagnostics: expect.arrayContaining(['task_classification_conflict']) });
        expect(telemetry.evidence).toMatchObject({ identityEvidenceComplete: false, accountingEvidenceComplete: false });
      }
    });

    it('does not promote Agent, unknown, or background tasks to foreground shell accounting', () => {
      for (const original of [{ task_type: 'local_agent' }, { task_type: undefined }, { is_backgrounded: true }]) {
        const events = [init, { ...started, ...original }, update({ task_type: 'local_bash', is_backgrounded: false }),
          result, notification];
        expect(collect(events)).toMatchObject({ status: 'partial', diagnostics: expect.arrayContaining(['unresolved_task']) });
        expect(collect([...events, { ...result, origin: { kind: 'task-notification', task_id: started.task_id } }]))
          .toMatchObject({ status: 'measured', inputTokens: 200, outputTokens: 30 });
      }
    });
  });

  it('does not let consistent patch classification mask contradictory top-level classification or vice versa', () => {
    for (const fields of [{ task_type: 'local_agent', patch: { task_type: 'local_bash' } },
      { is_backgrounded: false, patch: { is_backgrounded: true } }]) {
      const telemetry = collect([init, started,
        { type: 'system', subtype: 'task_updated', task_id: started.task_id, ...fields }, result, notification]);
      expect(telemetry).toMatchObject({ status: 'partial', diagnostics: expect.arrayContaining(['task_classification_conflict']) });
    }
  });

  it.each([
    { name: 'failed shell', events: [init, started, result, { ...notification, status: 'failed' }],
      diagnostic: 'task_notification_failed' },
    { name: 'failed Agent', events: [init, { ...started, task_type: 'local_agent' }, result,
      { ...notification, status: 'failed' }], diagnostic: 'task_notification_failed' },
    { name: 'unknown task identity', events: [init, started, result, { ...notification, task_id: 'shell-other' }],
      diagnostic: 'unknown_task_notification' },
    { name: 'missing task identity', events: [init, started, result, { ...notification, task_id: undefined }],
      diagnostic: 'task_identity_invalid' },
    { name: 'mismatched tool identity', events: [init, started, result, { ...notification, tool_use_id: 'toolu-other' }],
      diagnostic: 'task_tool_use_identity_conflict' },
    { name: 'missing notification tool identity', events: [init, started, result, { ...notification, tool_use_id: undefined }],
      diagnostic: 'task_tool_use_identity_invalid' },
    { name: 'missing start tool identity', events: [init, { ...started, tool_use_id: undefined }, result, notification],
      diagnostic: 'task_tool_use_identity_invalid' },
    { name: 'malformed tool identity', events: [init, started, result, { ...notification, tool_use_id: null }],
      diagnostic: 'task_tool_use_identity_invalid' },
    { name: 'mismatched notification session', events: [init, started, result, { ...notification, session_id: otherSessionId }],
      diagnostic: 'task_session_conflict' },
    { name: 'mismatched start session', events: [init, { ...started, session_id: otherSessionId }, result, notification],
      diagnostic: 'task_session_conflict' },
    { name: 'missing notification session', events: [init, started, result, { ...notification, session_id: undefined }],
      diagnostic: 'task_session_conflict' },
    { name: 'duplicate notification', events: [init, started, result, notification, notification],
      diagnostic: 'duplicate_task_notification' },
    { name: 'duplicate task identity', events: [init, started, started, result, notification],
      diagnostic: 'duplicate_task_started' },
    { name: 'reclassification from Agent', events: [init, { ...started, task_type: 'local_agent' }, started, result, notification],
      diagnostic: 'duplicate_task_started' },
    { name: 'reclassification to Agent', events: [init, started, { ...started, task_type: 'local_agent' }, result, notification],
      diagnostic: 'duplicate_task_started' },
    { name: 'completion after failed update', events: [init, started,
      { type: 'system', subtype: 'task_updated', task_id: started.task_id, patch: { status: 'failed' } }, result, notification],
      diagnostic: 'task_status_conflict' },
    { name: 'no init', events: [started, result, notification], diagnostic: 'missing_init_event' },
    { name: 'missing init model', events: [{ ...init, model: undefined }, started, result, notification], diagnostic: 'missing_model_id' },
    { name: 'malformed init model', events: [{ ...init, model: ['glm-5.3'] }, started, result, notification],
      diagnostic: 'model_identity_invalid' },
    { name: 'conflicting assistant model', events: [init, started,
      { type: 'assistant', session_id: sessionId, message: { model: 'glm-5.3-flash' } }, result, notification],
      diagnostic: 'model_identity_conflict' },
    { name: 'duplicate main result', events: [init, started, result, notification, result], diagnostic: 'duplicate_terminal_events' },
    { name: 'task-origin result attributed to a shell', events: [init, started, result, notification,
      { ...result, origin: { kind: 'task-notification', task_id: started.task_id } }],
      diagnostic: 'unresolved_task_notification_result' },
  ])('fails closed for $name', ({ events, diagnostic }) => {
    const telemetry = collect(events);
    expect(telemetry.status).not.toBe('measured');
    expect(telemetry.diagnostics).toContain(diagnostic);
    expect(telemetry.evidence).toMatchObject({ identityEvidenceComplete: false, accountingEvidenceComplete: false });
    expect(telemetry.inputTokens).toBe(200);
  });

  it('does not resolve ambiguous Agent notifications when a shell finishes', () => {
    const telemetry = collect([init, started,
      ...[1, 2].map(index => ({ ...started, task_id: `agent-${index}`, tool_use_id: `toolu-agent-${index}`, task_type: 'local_agent' })),
      result, notification,
      ...[1, 2].map(index => ({ ...notification, task_id: `agent-${index}`, tool_use_id: `toolu-agent-${index}` })),
      { ...result, origin: { kind: 'task-notification', task_id: 'agent-1' } },
    ]);
    expect(telemetry).toMatchObject({ status: 'partial', diagnostics: expect.arrayContaining(['ambiguous_task_notification_result']) });
  });

  it('never replaces absent, incomplete, or failed model usage with shell usage', () => {
    for (const main of [{ ...result, modelUsage: undefined },
      { ...result, modelUsage: { 'glm-5.3': { outputTokens: 30 } } },
      { ...result, subtype: 'error_during_execution' }]) {
      const telemetry = collect([init, started, notification, main]);
      expect(telemetry.status).not.toBe('measured');
      expect(telemetry.evidence?.accountingEvidenceComplete).toBe(false);
      if (main.subtype === 'success') expect(telemetry.inputTokens).toBeUndefined();
      else expect(telemetry.inputTokens).toBe(200);
    }
    expect(collect([init, started, notification]).status).toBe('unknown');
    expect(collect([init, started, notification, result], 'glm', false).status).toBe('partial');
  });

  it('round-trips complete shell evidence through persisted validation without weakening aggregate checks', () => {
    const telemetry = collect([init, started, result, notification]);
    const task = { id: 'one', objective: 'Test shell accounting', baseCommit: 'b'.repeat(40), writeScope: ['src/one.ts'],
      readScope: [], prohibitedScope: [], dependencies: [], contracts: [], acceptanceCriteria: ['Correct accounting'], tests: [] };
    const saved = { schemaVersion: 1, profile: 'claude-glm-codex', cwd: '/project', integrationHead: task.baseCommit,
      plan: { name: 'example', objective: task.objective, baseCommit: task.baseCommit, integrationBranch: 'integration/example',
        tasks: [task], verification: [{ command: 'node', args: ['check.mjs'] }] },
      options: { mode: 'balanced', workers: 1, maxWorkers: 3, maxAttempts: 2, maxReviewPasses: 2,
        timeoutMs: 1000, backoffMs: 0, glmCommand: 'glm', codexCommand: 'codex' },
      tasks: [{ task, canonicalId: '1', status: 'completed', attempts: 1, worker: 'task-one', updatedAt: '2026-09-15T00:00:00.000Z',
        invocations: [{ attempt: 1, mode: 'fresh', model: 'glm-5.3', startedAt: '2026-09-15T00:00:00.000Z',
          outcome: 'completed', artifacts: [], telemetry }] }],
      stage: 'implementation', reviewPasses: 0, reviews: [], createdAt: '2026-09-15T00:00:00.000Z', updatedAt: '2026-09-15T00:00:00.000Z' };
    const persisted = JSON.parse(JSON.stringify(saved));
    expect(parseWorkflowState(persisted).tasks[0]!.invocations![0]!.telemetry).toEqual(telemetry);
    persisted.tasks[0].invocations[0].telemetry.inputTokens++;
    expect(() => parseWorkflowState(persisted)).toThrow('workflow_telemetry_evidence_mismatch');
    const duplicated = JSON.parse(JSON.stringify(saved));
    duplicated.tasks[0].invocations[0].telemetry.evidence.terminalUsageBuckets[0].observations++;
    expect(() => parseWorkflowState(duplicated)).toThrow('workflow_telemetry_evidence_mismatch');
  });
});
