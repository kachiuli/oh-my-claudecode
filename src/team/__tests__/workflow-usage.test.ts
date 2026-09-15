import { describe, expect, it } from 'vitest';
import { createWorkflowUsageCollector } from '../workflow-usage.js';

const sessionId = '12345678-1234-4123-8123-123456789abc';
const modelUsage = { glm: { inputTokens: 100, outputTokens: 30, cacheReadInputTokens: 80, cacheCreationInputTokens: 20 } };
const result = { type: 'result', subtype: 'success', session_id: sessionId, modelUsage };
function collect(events: unknown[], provider: 'glm' | 'codex' | 'claude' = 'glm', passed = true) {
  const collector = createWorkflowUsageCollector(provider);
  collector.write(Buffer.from(events.map(value => JSON.stringify(value)).join('\n')));
  return collector.finish({ durationMs: 12.3, passed });
}

describe('workflow terminal usage accounting', () => {
  it('preserves the normal Claude route while reading Claude Code all-model terminal usage', () => {
    const telemetry = collect([{ type: 'system', subtype: 'init', session_id: sessionId },
      { ...result, modelUsage: { 'claude-fable-5-1[1m]': modelUsage.glm } }], 'claude');
    expect(telemetry).toEqual({ provider: 'claude', durationMs: 12, status: 'measured', scope: 'all-models',
      inputTokens: 200, outputTokens: 30, cacheReadTokens: 80, cacheWriteTokens: 20, sessionId, terminal: 'success' });
  });
  const claudeResult = { ...result, modelUsage: { 'claude-fable-5-1[1m]': modelUsage.glm } };
  const claudeZero = { ...result, modelUsage: { 'claude-fable-5-1[1m]': {
    inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } } };
  it.each([
    { name: 'absent usage', events: [{ type: 'result', subtype: 'success', session_id: sessionId }], passed: true,
      expected: { status: 'unknown', terminal: 'success', diagnostics: ['missing_usage'] }, absent: ['inputTokens'] },
    { name: 'missing cache counters', events: [{ ...result, modelUsage: { claude: { inputTokens: 5, outputTokens: 2 } } }], passed: true,
      expected: { status: 'partial', outputTokens: 2, diagnostics: ['missing_usage_fields'] }, absent: ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens'] },
    { name: 'main-loop fallback', events: [{ type: 'result', subtype: 'success', session_id: sessionId,
      usage: { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 1 } }], passed: true,
      expected: { status: 'partial', scope: 'main-loop', inputTokens: 9, diagnostics: ['main_loop_usage_only'] }, absent: [] },
    { name: 'measured successful zero', events: [claudeZero], passed: true,
      expected: { status: 'measured', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, absent: ['diagnostics'] },
    { name: 'unavailable zero-filled failure', events: [{ ...claudeZero, subtype: 'error_during_execution' }], passed: false,
      expected: { status: 'unknown', terminal: 'failure', diagnostics: ['process_failed', 'unavailable_failure_usage'] }, absent: ['inputTokens', 'outputTokens'] },
    { name: 'partial nonzero provider failure', events: [{ ...claudeResult, is_error: true }], passed: true,
      expected: { status: 'partial', inputTokens: 200, terminal: 'failure' }, absent: [] },
    { name: 'process failure after successful result', events: [claudeResult], passed: false,
      expected: { status: 'partial', inputTokens: 200, terminal: 'success', diagnostics: ['process_failed'] }, absent: [] },
    { name: 'conflicting terminal totals', events: [claudeResult, claudeZero], passed: true,
      expected: { status: 'unknown', scope: 'unknown', diagnostics: ['conflicting_terminal_events'] }, absent: ['inputTokens'] },
    { name: 'counter overflow', events: [{ ...result, modelUsage: { claude: { ...modelUsage.glm, inputTokens: Number.MAX_SAFE_INTEGER } } }], passed: true,
      expected: { status: 'partial', outputTokens: 30, diagnostics: ['usage_overflow'] }, absent: ['inputTokens'] },
  ])('keeps normal Claude $name truthful', ({ events, passed, expected, absent }) => {
    const telemetry = collect(events, 'claude', passed);
    expect(telemetry).toMatchObject({ provider: 'claude', ...expected });
    for (const field of absent) expect(JSON.parse(JSON.stringify(telemetry))).not.toHaveProperty(field);
  });

  it('preserves an interrupted normal Claude session and refuses conflicting identities without transcript leakage', () => {
    const init = { type: 'system', subtype: 'init', session_id: sessionId };
    expect(collect([init], 'claude', false)).toMatchObject({ provider: 'claude', status: 'unknown', sessionId });
    const telemetry = collect([init, { ...claudeResult, session_id: '87654321-1234-4123-8123-123456789abc',
      result: 'synthetic private transcript', errors: ['synthetic private error'] }], 'claude');
    expect(telemetry).toMatchObject({ provider: 'claude', status: 'partial', diagnostics: ['session_identity_conflict'] });
    expect(telemetry.sessionId).toBeUndefined();
    expect(JSON.stringify(telemetry)).not.toContain('synthetic private');
  });

  it('prefers all-model totals, includes cache in total input, and never adds assistant usage', () => {
    const telemetry = collect([
      { type: 'system', subtype: 'init', session_id: sessionId },
      { type: 'assistant', message: { usage: { input_tokens: 9000, output_tokens: 9000 } } },
      { ...result, usage: { input_tokens: 9000, output_tokens: 9000 }, modelUsage: {
        ...modelUsage, subagent: { inputTokens: 50, outputTokens: 10, cacheReadInputTokens: 20, cacheCreationInputTokens: 0 },
      } },
    ]);
    expect(telemetry).toEqual({ provider: 'glm', durationMs: 12, status: 'measured', scope: 'all-models',
      inputTokens: 270, outputTokens: 40, cacheReadTokens: 100, cacheWriteTokens: 20, sessionId, terminal: 'success' });
  });

  it('counts identical terminal events once', () => {
    expect(collect([result, result])).toMatchObject({ status: 'measured', inputTokens: 200, outputTokens: 30 });
  });

  it('does not subtract usage from previous invocations of a resumed session', () => {
    expect(collect([result]).inputTokens).toBe(200);
    expect(collect([result]).inputTokens).toBe(200);
  });

  it('marks main-loop fallback partial even when every counter is reported', () => {
    expect(collect([{ type: 'result', subtype: 'success', session_id: sessionId,
      usage: { input_tokens: 100, output_tokens: 30, cache_read_input_tokens: 80, cache_creation_input_tokens: 20 },
    }])).toMatchObject({ status: 'partial', scope: 'main-loop', inputTokens: 200, outputTokens: 30,
      diagnostics: ['main_loop_usage_only'] });
  });

  it('keeps missing counters unknown instead of using zero', () => {
    const telemetry = collect([{ ...result, modelUsage: { glm: { inputTokens: 100, outputTokens: 30 } } }]);
    expect(telemetry).toMatchObject({ status: 'partial', outputTokens: 30, diagnostics: ['missing_usage_fields'] });
    expect(telemetry.inputTokens).toBeUndefined();
    expect(telemetry.cacheReadTokens).toBeUndefined();
    expect(telemetry.cacheWriteTokens).toBeUndefined();
  });

  it.each([-1, 0.5, '120', Number.MAX_SAFE_INTEGER + 1, null])('rejects invalid counts %s without inventing totals', value => {
    const telemetry = collect([{ ...result, modelUsage: { glm: { ...modelUsage.glm, inputTokens: value } } }]);
    expect(telemetry.status).toBe('partial');
    expect(telemetry.inputTokens).toBeUndefined();
    expect(telemetry.diagnostics).toContain('invalid_usage_counts');
  });

  it('detects arithmetic overflow even when individual counts are valid', () => {
    const telemetry = collect([{ ...result, modelUsage: { glm: { ...modelUsage.glm, inputTokens: Number.MAX_SAFE_INTEGER } } }]);
    expect(telemetry.inputTokens).toBeUndefined();
    expect(telemetry.diagnostics).toContain('usage_overflow');
  });

  it('does not disguise invalid all-model data with a main-loop fallback', () => {
    const telemetry = collect([{ ...result, modelUsage: { glm: 'invalid' }, usage: { input_tokens: 100, output_tokens: 30 } }]);
    expect(telemetry.status).toBe('unknown');
    expect(telemetry.diagnostics).toContain('invalid_model_usage');
  });

  it('retains partial nonzero failure usage but treats zero-filled errors as unknown', () => {
    expect(collect([{ ...result, subtype: 'error_during_execution' }])).toMatchObject({ status: 'partial', inputTokens: 200, terminal: 'failure' });
    const failed = collect([{ ...result, subtype: 'error_during_execution', modelUsage: { glm: {
      inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
    } } }]);
    expect(failed).toMatchObject({ status: 'unknown', scope: 'unknown', terminal: 'failure' });
    expect(failed.inputTokens).toBeUndefined();
    expect(failed.diagnostics).toContain('unavailable_failure_usage');
  });

  it('preserves explicit zero counts on successful invocations', () => {
    expect(collect([{ ...result, modelUsage: { glm: {
      inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
    } } }])).toMatchObject({ status: 'measured', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
  });

  it('marks process failure partial even if a success result was emitted first', () => {
    expect(collect([result], 'glm', false)).toMatchObject({ status: 'partial', inputTokens: 200, diagnostics: ['process_failed'] });
  });

  it('invalidates conflicting terminal totals rather than summing or choosing one', () => {
    const telemetry = collect([result, { ...result, modelUsage: { glm: { ...modelUsage.glm, inputTokens: 101 } } }]);
    expect(telemetry.status).toBe('unknown');
    expect(telemetry.inputTokens).toBeUndefined();
    expect(telemetry.diagnostics).toContain('conflicting_terminal_events');
  });

  it('accepts an init-only UUID for an interrupted session but invalidates conflicting IDs', () => {
    const init = { type: 'system', subtype: 'init', session_id: sessionId };
    expect(collect([init], 'glm', false)).toMatchObject({ status: 'unknown', sessionId });
    const conflict = collect([init, { ...result, session_id: '87654321-1234-4123-8123-123456789abc' }]);
    expect(conflict.sessionId).toBeUndefined();
    expect(conflict.diagnostics).toContain('session_identity_conflict');
  });

  it('distinguishes missing session metadata from an invalid supplied identity', () => {
    const telemetry = collect([{ type: 'system', subtype: 'init' }, { ...result, session_id: undefined }]);
    expect(telemetry.sessionId).toBeUndefined();
    expect(telemetry.terminal).toBe('success');
    expect(telemetry.diagnostics).toContain('missing_session_id');
    expect(telemetry.diagnostics).not.toContain('session_identity_invalid');
  });

  it('does not retain arbitrary provider strings or error content', () => {
    const telemetry = collect([{ ...result, session_id: 'Bearer secret-credential', result: 'private transcript',
      errors: ['api_key=private-key'], modelUsage: { 'secret-model-name': modelUsage.glm } }]);
    expect(telemetry.sessionId).toBeUndefined();
    expect(telemetry.diagnostics).toContain('session_identity_invalid');
    for (const secret of ['secret-credential', 'private transcript', 'private-key', 'secret-model-name']) {
      expect(JSON.stringify(telemetry)).not.toContain(secret);
    }
  });

  it('parses UTF-8 characters and JSON across arbitrary byte boundaries', () => {
    const collector = createWorkflowUsageCollector('glm');
    const bytes = Buffer.from(JSON.stringify({ ...result, result: '你好🙂' }));
    for (const byte of bytes) collector.write(Buffer.from([byte]));
    expect(collector.finish({ durationMs: 1, passed: true })).toMatchObject({ status: 'measured', inputTokens: 200 });
  });

  it('recovers after malformed and oversized events without retaining their contents', () => {
    const collector = createWorkflowUsageCollector('glm');
    collector.write(Buffer.from('invalid private content\n'));
    collector.write(Buffer.from('x'.repeat(300000)));
    collector.write(Buffer.from(`\n${JSON.stringify(result)}\n`));
    const telemetry = collector.finish({ durationMs: 1, passed: true });
    expect(telemetry).toMatchObject({ status: 'partial', inputTokens: 200, diagnostics: ['malformed_event', 'oversized_event'] });
    expect(JSON.stringify(telemetry)).not.toContain('private content');
  });

  it('reports absent usage as unknown without treating a successful result as failure', () => {
    expect(collect([{ type: 'result', subtype: 'success', session_id: sessionId }])).toMatchObject({ status: 'unknown', terminal: 'success' });
  });

  it('uses Codex total input without adding its cached subset or reasoning output again', () => {
    expect(collect([{ type: 'thread.started', thread_id: sessionId }, { type: 'turn.completed', usage: {
      input_tokens: 150, cached_input_tokens: 100, output_tokens: 25, reasoning_output_tokens: 20,
    } }], 'codex')).toEqual({ provider: 'codex', durationMs: 12, status: 'measured', scope: 'turn',
      inputTokens: 150, outputTokens: 25, cacheReadTokens: 100, sessionId, terminal: 'success' });
  });

  it('rejects impossible Codex cache subsets', () => {
    const telemetry = collect([{ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 20, output_tokens: 5 } }], 'codex');
    expect(telemetry.inputTokens).toBeUndefined();
    expect(telemetry.cacheReadTokens).toBeUndefined();
    expect(telemetry.diagnostics).toContain('invalid_cache_subset');
  });

  it.each([0, 40])('retains optional Codex cache writes (%s) without adding them to total input', cacheWrite => {
    const telemetry = collect([{ type: 'thread.started', thread_id: sessionId }, { type: 'turn.completed', usage: {
      input_tokens: 150, cached_input_tokens: 100, cache_write_input_tokens: cacheWrite, output_tokens: 25,
    } }], 'codex');
    expect(telemetry).toMatchObject({ status: 'measured', inputTokens: 150, cacheReadTokens: 100, cacheWriteTokens: cacheWrite });
  });

  it.each([-1, 0.5, '40', Number.MAX_SAFE_INTEGER + 1, null])('rejects malformed optional Codex cache writes %s', cacheWrite => {
    const telemetry = collect([{ type: 'thread.started', thread_id: sessionId }, { type: 'turn.completed', usage: {
      input_tokens: 150, cached_input_tokens: 100, cache_write_input_tokens: cacheWrite, output_tokens: 25,
    } }], 'codex');
    expect(telemetry).toMatchObject({ status: 'partial', inputTokens: 150, cacheReadTokens: 100 });
    expect(telemetry.cacheWriteTokens).toBeUndefined();
    expect(telemetry.diagnostics).toContain('invalid_usage_counts');
  });

  it('rejects Codex cache writes larger than input while retaining independently valid output', () => {
    const telemetry = collect([{ type: 'thread.started', thread_id: sessionId }, { type: 'turn.completed', usage: {
      input_tokens: 150, cached_input_tokens: 100, cache_write_input_tokens: 151, output_tokens: 25,
    } }], 'codex');
    expect(telemetry).toMatchObject({ status: 'partial', outputTokens: 25 });
    expect(telemetry.inputTokens).toBeUndefined();
    expect(telemetry.cacheWriteTokens).toBeUndefined();
    expect(telemetry.diagnostics).toContain('invalid_cache_subset');
  });

  it.each(['turn.failed', 'error'])('recognizes Codex %s as failure even after a completed event', type => {
    const telemetry = collect([{ type: 'thread.started', thread_id: sessionId },
      { type: 'turn.completed', usage: { input_tokens: 150, cached_input_tokens: 100, output_tokens: 25 } },
      { type, error: { message: 'private error' } }], 'codex');
    expect(telemetry).toMatchObject({ status: 'partial', terminal: 'failure', inputTokens: 150 });
    expect(JSON.stringify(telemetry)).not.toContain('private error');
  });

  it('recognizes a completed Codex turn after transient top-level errors', () => {
    const telemetry = collect([{ type: 'thread.started', thread_id: sessionId },
      { type: 'error', message: 'Reconnecting 1/5; private details' },
      { type: 'error', message: 'Reconnecting 2/5; private details' },
      { type: 'turn.completed', usage: { input_tokens: 150, cached_input_tokens: 100, output_tokens: 25 } }], 'codex');
    expect(telemetry).toMatchObject({ status: 'partial', terminal: 'success', inputTokens: 150, diagnostics: ['recovered_provider_error'] });
    expect(JSON.stringify(telemetry)).not.toContain('private details');
  });

  it('never recovers a definitive failed Codex turn from a contradictory completion', () => {
    const telemetry = collect([{ type: 'thread.started', thread_id: sessionId },
      { type: 'turn.failed', error: { message: 'Turn failed' } },
      { type: 'turn.completed', usage: { input_tokens: 150, cached_input_tokens: 100, output_tokens: 25 } }], 'codex');
    expect(telemetry).toMatchObject({ status: 'partial', terminal: 'failure', inputTokens: 150 });
  });

  it('does not let duplicate completion events erase an error after completion', () => {
    const completed = { type: 'turn.completed', usage: { input_tokens: 150, cached_input_tokens: 100, output_tokens: 25 } };
    const telemetry = collect([{ type: 'thread.started', thread_id: sessionId }, completed,
      { type: 'error', message: 'Post-completion failure' }, completed], 'codex');
    expect(telemetry).toMatchObject({ status: 'partial', terminal: 'failure', inputTokens: 150 });
  });
});
