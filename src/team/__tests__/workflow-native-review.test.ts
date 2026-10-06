import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildWorkflowReviewSourceBundle, iterateWorkflowReviewManifestEntries, readWorkflowReviewSource,
  workflowReviewSourceReceipt, WorkflowReviewOwnedFile } from '../workflow-review-source.js';
import { qualifyWorkflowNativeReviewClientFactory, requireWorkflowNativeReviewClientFactory,
  verifyWorkflowNativeReviewTrace, WORKFLOW_REVIEW_READER_TOOLS } from '../workflow-review-source-server.js';
import { WorkflowNativeReviewSession } from '../workflow-review-source-server.js';
import { prepareWorkflowBinding, requirePreparedWorkflowBinding, type PreparedWorkflowBinding } from '../workflow-adapters.js';
import { createWorkflowFixture } from './helpers/workflow-fixture.js';
import { runtimeFixture } from './helpers/workflow-v2-fixture.js';

const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const wire = (value: unknown) => Buffer.from(JSON.stringify(value) + '\n');
const roots: string[] = [];
const requiredMaterials = () => (['inventory', 'diff', 'objective', 'shared-context', 'contracts'] as const)
  .map(kind => ({ kind, path: kind, content: Buffer.alloc(0) }));
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('native reader authority and exact response fitting', () => {
  it('requires the exact prepared object and refuses an arbitrary executable with an authenticated JSON declaration', async () => {
    const runtimeRoot = createWorkflowFixture(); roots.push(runtimeRoot.root);
    const configured = runtimeFixture(runtimeRoot); const selected = configured.selectedBinding('reviewer', 'codex', 'fixture-reviewer');
    const path = configured.runtime.resolveBinding(selected).capabilityEvidencePath;
    const evidence = JSON.parse(readFileSync(path, 'utf8')); evidence.validation = 'authenticated';
    writeFileSync(path, JSON.stringify(evidence));
    const prepared = prepareWorkflowBinding({ ...selected, capabilityEvidenceSha256: sha(readFileSync(path)) }, configured.runtime);
    expect(() => requirePreparedWorkflowBinding(prepared)).not.toThrow();
    expect(() => requirePreparedWorkflowBinding(structuredClone(prepared))).toThrow('workflow_prepared_binding_required');
    await expect(qualifyWorkflowNativeReviewClientFactory({ prepared, cwd: runtimeRoot.cwd, directory: join(runtimeRoot.root, 'bootstrap'),
      catalogSource: 'unused', expected: undefined!, schema: {} })).rejects.toThrow('workflow_review_reader_qualification_required');
    expect(existsSync(join(runtimeRoot.root, 'bootstrap'))).toBe(false);
    prepared.environment.NODE_OPTIONS = '--require malicious.cjs';
    expect(() => requirePreparedWorkflowBinding(prepared)).toThrow('workflow_prepared_binding_required');
  });
  it('refuses native mode labels and copied authenticated launch declarations before bootstrap effects', async () => {
    expect(() => requireWorkflowNativeReviewClientFactory({ mode: 'native' })).toThrow('workflow_review_reader_observation_required');
    const root = mkdtempSync(join(tmpdir(), 'omc-native-unbranded-')); roots.push(root);
    await expect(qualifyWorkflowNativeReviewClientFactory({ prepared: { validation: 'authenticated' } as PreparedWorkflowBinding,
      cwd: root, directory: join(root, 'bootstrap'), catalogSource: 'unused', expected: undefined!, schema: {} }))
      .rejects.toThrow('workflow_prepared_binding_required');
    expect(existsSync(join(root, 'bootstrap'))).toBe(false);
    const fake = Object.assign(Object.create(WorkflowNativeReviewSession.prototype), { finished: true, settled: true, sealed: {}, assertHealthy() {} });
    expect(() => fake.completion()).toThrow('workflow_review_transport_completion_required');
  });

  it('fits near-bound Unicode, escaped, binary and empty pages against the actual native envelope', () => {
    const root = mkdtempSync(join(tmpdir(), 'omc-native-envelope-')); roots.push(root);
    const originals = [Buffer.from('界🙂"\\\n'.repeat(5000)), Buffer.from(Array.from({ length: 20000 }, (_, index) => index % 256)), Buffer.alloc(0)];
    const bundle = buildWorkflowReviewSourceBundle({ repository: root, baseCommit: '0'.repeat(40), head: '1'.repeat(40), directory: join(root, 'source'),
      materials: [...originals.map((content, index) => ({ kind: 'source' as const, path: `source-${index}.bin`, content })), ...requiredMaterials()] });
    let index = 0; let pages = 0; let largest = 0;
    for (const entry of iterateWorkflowReviewManifestEntries(bundle)) {
      if (entry.kind !== 'source') continue;
      const buffers: Buffer[] = []; let cursor: string | undefined;
      do {
        const envelope = (page: Parameters<typeof workflowReviewSourceReceipt>[0]) => ({ id: 'native\\"identifier',
          result: { contentItems: [{ type: 'inputText', text: JSON.stringify(page) }], success: true } });
        const page = readWorkflowReviewSource(bundle, { kind: 'entry', id: entry.id, cursor, responseEnvelope: envelope });
        const encoded = wire(envelope(page)); largest = Math.max(largest, encoded.length);
        expect(encoded.length).toBeLessThanOrEqual(8192);
        buffers.push(Buffer.from(page.content, page.encoding === 'base64' ? 'base64' : 'utf8'));
        cursor = page.cursor ?? undefined; pages++;
      } while (cursor);
      expect(Buffer.concat(buffers)).toEqual(originals[index++]);
    }
    expect(pages).toBeGreaterThan(10);
    expect(largest).toBeGreaterThan(8000);
  });
});

/** Synthetic protocol fixtures exercise offline checking; they cannot mint native runtime authority. */
function fixture(fault?: 'extra-tool' | 'wire-corruption' | 'ancestry' | 'missing-completion' | 'missing-empty' | 'wrong-model' | 'wrong-effort' | 'sequence') {
  const root = mkdtempSync(join(tmpdir(), 'omc-native-trace-fixture-')); roots.push(root);
  const directory = join(root, 'delivery'); mkdirSync(directory); mkdirSync(join(directory, 'calls'));
  const traceRoot = join(directory, 'trace', 'trace-1234'); mkdirSync(join(traceRoot, 'payloads'), { recursive: true });
  const threadId = 'native-thread'; const turnId = 'native-turn'; const invocationId = 'fixture-invocation';
  const reviewerId = 'fixture-reviewer'; const effectiveInvocationDigest = sha('fixture-launch');
  const bundle = buildWorkflowReviewSourceBundle({ repository: root, baseCommit: '0'.repeat(40), head: '1'.repeat(40), directory: join(root, 'source'),
    materials: [{ kind: 'source', path: 'unicode.txt', content: Buffer.from('界🙂"\\\n'.repeat(300)) },
      { kind: 'source', path: 'empty.txt', content: Buffer.alloc(0) }, ...requiredMaterials()] });
  const frames = new WorkflowReviewOwnedFile(directory, 'frames.bin', true);
  const correlations = new WorkflowReviewOwnedFile(directory, 'correlation.jsonl', true);
  const journal = new WorkflowReviewOwnedFile(directory, 'calls.jsonl', true);
  let frameSequence = 0; const calls: { callId: string; tool: string; arguments: unknown; output: string }[] = [];
  const record = (direction: string, value: unknown) => {
    const frame = frames.append(wire(value)); correlations.append(wire({ invocationId, reviewerId, effectiveInvocationDigest,
      sequence: ++frameSequence, direction, frame })); return frame;
  };
  const read = (kind: 'manifest' | 'entry', id?: string) => {
    let cursor: string | undefined;
    do {
      const requestId = calls.length; const callId = `call_${requestId}`;
      const tool = WORKFLOW_REVIEW_READER_TOOLS[kind === 'manifest' ? 0 : 1]!;
      const args = { ...(id ? { id } : {}), ...(cursor ? { cursor } : {}) };
      const page = readWorkflowReviewSource(bundle, { kind, id, cursor });
      const output = JSON.stringify(page);
      const request = record('receive', { id: requestId, method: 'item/tool/call', params: { threadId, turnId, callId, namespace: null, tool, arguments: args } });
      const response = record('request', { id: requestId, result: { contentItems: [{ type: 'inputText', text: output }], success: true } });
      const call = { callId, requestId, tool, arguments: args, request, response, receipt: workflowReviewSourceReceipt(page) };
      journal.append(wire(call)); writeFileSync(join(directory, 'calls', `${sha(callId)}.json`), wire(call));
      calls.push({ callId, tool, arguments: args, output }); cursor = page.cursor ?? undefined;
    } while (cursor);
  };
  read('manifest'); for (const entry of iterateWorkflowReviewManifestEntries(bundle)) read('entry', entry.id);
  const capture = frames.seal(); const correlation = correlations.seal(); frames.close(); correlations.close(); journal.close();
  const attestation = { bundleSha256: bundle.digest, reviewerId, complete: true, entries: bundle.entryCount,
    ranges: calls.filter(call => (JSON.parse(call.output) as { bytes: number }).bytes > 0).length };
  const resultText = JSON.stringify({ findings: [], coverage: attestation });
  const events: unknown[] = []; let ordinal = 0;
  const payload = (kind: string, value: unknown) => {
    const path = `payloads/${++ordinal}.json`; writeFileSync(join(traceRoot, path), JSON.stringify(value));
    return { raw_payload_id: `raw_payload:${ordinal}`, kind: { type: kind }, path };
  };
  const event = (value: unknown) => events.push({ schema_version: 1, seq: events.length + 1, rollout_id: threadId, thread_id: threadId,
    codex_turn_id: turnId, payload: value });
  event({ type: 'rollout_started', root_thread_id: threadId });
  event({ type: 'thread_started', thread_id: threadId, agent_path: '/root', metadata_payload: payload('session_metadata', {
    thread_id: threadId, model: 'gpt-6.1-sol', provider_name: 'openai', approval_policy: 'never' }) });
  event({ type: 'codex_turn_started', thread_id: threadId, codex_turn_id: turnId });
  const schemas = [
    { type: 'object', additionalProperties: false, properties: { cursor: { type: 'string', pattern: '^[A-Za-z0-9_-]+$' } } },
    { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', pattern: '^(?:(?:instr|src)-[0-9]+|inventory|diff|objective|shared-context|contracts)$' }, cursor: { type: 'string', pattern: '^[A-Za-z0-9_-]+$' } } },
  ];
  const tools = WORKFLOW_REVIEW_READER_TOOLS.map((name, index) => ({ type: 'function', name, parameters: schemas[index] }));
  if (fault === 'extra-tool') tools.push({ ...tools[0]!, name: 'shell' });
  const request = (id: string, input: unknown[], prior?: string) => event({ type: 'inference_started', inference_call_id: id, thread_id: threadId,
    codex_turn_id: turnId, model: 'gpt-6.1-sol', provider_name: 'OpenAI', request_payload: payload('inference_request', {
      model: fault === 'wrong-model' ? 'other-model' : 'gpt-6.1-sol', input, previous_response_id: prior,
      reasoning: { effort: fault === 'wrong-effort' ? 'medium' : 'xhigh' }, parallel_tool_calls: false,
      client_metadata: { 'x-codex-turn-metadata': JSON.stringify({ model: 'gpt-6.1-sol', reasoning_effort: 'ultra', thread_id: threadId, turn_id: turnId }) } }) });
  const response = (id: string, responseId: string, output: unknown[]) => event({ type: 'inference_completed', inference_call_id: id,
    response_id: responseId, response_payload: payload('inference_response', { output_items: output }) });
  request('inference1', [{ type: 'additional_tools', tools: [{ type: 'namespace', name: 'functions', tools }] },
    { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'unbounded ignored history '.repeat(10000) }] }]);
  response('inference1', 'response1', calls.map(call => ({ type: 'function_call', name: call.tool, arguments: JSON.stringify(call.arguments), call_id: call.callId })));
  const observedCalls = fault === 'missing-empty' ? calls.slice(0, -1) : calls;
  request('inference2', observedCalls.map((call, index) => ({ type: 'function_call_output', call_id: call.callId,
    output: fault === 'wire-corruption' && index === 1 ? `${call.output} altered` : call.output })), fault === 'ancestry' ? 'forged-response' : 'response1');
  if (fault !== 'missing-completion') response('inference2', 'response2', [{ type: 'message', phase: 'final_answer', content: [{ type: 'output_text', text: resultText }] }]);
  event({ type: 'codex_turn_ended', codex_turn_id: turnId, status: 'completed' });
  event({ type: 'thread_ended', thread_id: threadId, status: 'completed' }); event({ type: 'rollout_ended', status: 'completed' });
  if (fault === 'sequence') (events[3] as { seq: number }).seq++;
  writeFileSync(join(traceRoot, 'trace.jsonl'), events.map(value => wire(value).toString()).join(''));
  return { root, directory, bundle, threadId, turnId, invocationId, reviewerId, effectiveInvocationDigest,
    callCount: calls.length, attestation, capture, correlation, resultText };
}

describe('offline native trace verification', () => {
  it('reconstructs synthetic trace fixtures while retaining the native factory authority boundary', async () => {
    const input = fixture(); const result = await verifyWorkflowNativeReviewTrace(input);
    expect(result.ranges).toBe(input.attestation.ranges);
    expect(readFileSync(join(input.directory, 'reconstruction', result.proof.name)).length).toBe(result.proof.bytes);
    expect(() => requireWorkflowNativeReviewClientFactory(JSON.parse('{"mode":"native"}'))).toThrow('workflow_review_reader_observation_required');
  });
  it.each(['extra-tool', 'wire-corruption', 'ancestry', 'missing-completion', 'missing-empty', 'wrong-model', 'wrong-effort', 'sequence'] as const)(
    'refuses a %s trace before it can authorize findings', async fault => {
      await expect(verifyWorkflowNativeReviewTrace(fixture(fault))).rejects.toThrow(/workflow_review_/);
    });
});
