import { createHash } from 'node:crypto';
import { realpathSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildWorkflowReviewSourceBundle, iterateWorkflowReviewManifestEntries, readWorkflowReviewSource,
  workflowReviewSourceReceipt, WorkflowReviewOwnedFile, iterateWorkflowReviewNativeItems } from '../workflow-review-source.js';
import { createWorkflowReviewSourceServer, qualifyWorkflowNativeReviewClientFactory, requireWorkflowNativeReviewClientFactory,
  verifyWorkflowNativeReviewTrace, WORKFLOW_REVIEW_READER_TOOLS } from '../workflow-review-source-server.js';
import { WorkflowNativeReviewSession } from '../workflow-review-source-server.js';
import { workflowNativeReviewArguments, WORKFLOW_REVIEW_NATIVE_COMPACTION_LIMIT } from '../workflow-review-source-server.js';
import { prepareWorkflowBinding, requirePreparedWorkflowBinding, type PreparedWorkflowBinding } from '../workflow-adapters.js';
import { createWorkflowFixture } from './helpers/workflow-fixture.js';
import { runtimeFixture } from './helpers/workflow-v2-fixture.js';
import { reviewReviewerResultSchema } from '../workflow.js';

const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const wire = (value: unknown) => Buffer.from(JSON.stringify(value) + '\n');
const outputSchema = reviewReviewerResultSchema(true);
const outputFormat = { type: 'json_schema', strict: true, schema: outputSchema, name: 'codex_output_schema' };
const roots: string[] = [];
const requiredMaterials = () => (['inventory', 'diff', 'objective', 'shared-context', 'contracts'] as const)
  .map(kind => ({ kind, path: kind, content: Buffer.alloc(0) }));
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('native reader authority and exact response fitting', () => {
  it('uses a closed strict production schema with every object property required', () => {
    let objects = 0;
    const visit = (value: unknown): void => {
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value)) { value.forEach(visit); return; }
      const node = value as Record<string, unknown>;
      if (node.type === 'object') {
        objects++;
        expect(node.additionalProperties).toBe(false);
        expect(node.properties).toBeTypeOf('object');
        expect(node.required).toEqual(expect.any(Array));
        expect([...(node.required as string[])].sort()).toEqual(Object.keys(node.properties as Record<string, unknown>).sort());
      }
      Object.values(node).forEach(visit);
    };
    visit(outputSchema);
    expect(objects).toBe(3);
    expect(outputSchema.required).toEqual(['findings', 'coverage']);
  });
  it('preserves the ordinary findings-only schema and nullable finding locations', () => {
    const ordinary = reviewReviewerResultSchema(false);
    const properties = outputSchema.properties as Record<string, unknown>;
    expect(ordinary).toEqual({ type: 'object', additionalProperties: false, required: ['findings'], properties: { findings: properties.findings } });
    expect(properties.findings).toMatchObject({ items: { properties: { file: { type: ['string', 'null'] }, line: { type: ['integer', 'null'] } } } });
  });
  it('pins the intended production compaction threshold and scope in the native invocation', () => {
    const args = workflowNativeReviewArguments('catalog.json');
    expect(WORKFLOW_REVIEW_NATIVE_COMPACTION_LIMIT).toBe(98304);
    expect(args).toContain('model_auto_compact_token_limit=98304');
    expect(args).toContain('model_auto_compact_token_limit_scope="body_after_prefix"');
    expect(args).toContain('model_reasoning_effort="ultra"');
    expect(args).toContain('features.respect_system_proxy=false'); expect(args).toContain('features.system_proxy_fallback=false');
    expect(args).toContain('analytics.enabled=false');
  });
  it('disables each inherited MCP server through its exact native CLI key segment', () => {
    const names = ['cua_repl', 'node_repl', 'custom-server_1', '界 server'];
    const args = workflowNativeReviewArguments('catalog.json', names);
    const overrides = args.filter((_, index) => args[index - 1] === '--config' && args[index].startsWith('mcp_servers'));
    expect(overrides).toEqual(['mcp_servers={}', 'mcp_servers.cua_repl.enabled=false', 'mcp_servers.node_repl.enabled=false',
      'mcp_servers.custom-server_1.enabled=false', 'mcp_servers.界 server.enabled=false']);
    expect(overrides.slice(1).map(value => value.split('=')[0].split('.'))).toEqual(names.map(name => ['mcp_servers', name, 'enabled']));
  });
  it('refuses unsupported native MCP key segments before producing launch arguments', () => {
    for (const name of ['', 'nested.server', 'server=alias', 'server\0alias', 'server\ralias', 'server\nalias']) {
      expect(() => workflowNativeReviewArguments('catalog.json', ['cua_repl', name])).toThrow('workflow_review_native_mcp_name_unsupported');
    }
  });
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
      catalogSource: 'unused', expected: undefined!, schema: {}, transport: { certificates: 'unused' } })).rejects.toThrow('workflow_review_reader_qualification_required');
    expect(existsSync(join(runtimeRoot.root, 'bootstrap'))).toBe(false);
    prepared.environment.NODE_OPTIONS = '--require malicious.cjs';
    expect(() => requirePreparedWorkflowBinding(prepared)).toThrow('workflow_prepared_binding_required');
  });
  it('refuses native mode labels and copied authenticated launch declarations before bootstrap effects', async () => {
    expect(() => requireWorkflowNativeReviewClientFactory({ mode: 'native' })).toThrow('workflow_review_reader_observation_required');
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'omc-native-unbranded-'))); roots.push(root);
    await expect(qualifyWorkflowNativeReviewClientFactory({ prepared: { validation: 'authenticated' } as PreparedWorkflowBinding,
      cwd: root, directory: join(root, 'bootstrap'), catalogSource: 'unused', expected: undefined!, schema: {}, transport: { certificates: 'unused' } }))
      .rejects.toThrow('workflow_prepared_binding_required');
    expect(existsSync(join(root, 'bootstrap'))).toBe(false);
    const fake = Object.assign(Object.create(WorkflowNativeReviewSession.prototype), { finished: true, settled: true, sealed: {}, assertHealthy() {} });
    expect(() => fake.completion()).toThrow('workflow_review_transport_completion_required');
  });

  it('fits near-bound Unicode, escaped, binary and empty pages against the actual native envelope', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'omc-native-envelope-'))); roots.push(root);
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
function fixture(fault?: 'extra-tool' | 'wire-corruption' | 'ancestry' | 'missing-completion' | 'missing-empty' | 'wrong-model' | 'wrong-effort' | 'sequence'
  | 'early-final' | 'post-final-call' | 'post-final-inference' | 'post-final-dispatch', sourceRepeats = 300) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'omc-native-trace-fixture-'))); roots.push(root);
  const directory = join(root, 'delivery'); mkdirSync(directory); mkdirSync(join(directory, 'calls'));
  const traceRoot = join(directory, 'trace', 'trace-1234'); mkdirSync(join(traceRoot, 'payloads'), { recursive: true });
  const threadId = 'native-thread'; const turnId = 'native-turn'; const invocationId = 'fixture-invocation';
  const reviewerId = 'fixture-reviewer'; const effectiveInvocationDigest = sha('fixture-launch');
  const bundle = buildWorkflowReviewSourceBundle({ repository: root, baseCommit: '0'.repeat(40), head: '1'.repeat(40), directory: join(root, 'source'),
    materials: [{ kind: 'source', path: 'unicode.txt', content: Buffer.from('界🙂"\\\n'.repeat(sourceRepeats)) },
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
    // Pinned native dynamic-tool serialization observed in both warmup and normal model requests.
    { type: 'object', additionalProperties: false, properties: { cursor: { type: 'string' } } },
    { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string' }, cursor: { type: 'string' } } },
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
  const finalAnswer = { type: 'message', phase: 'final_answer', content: [{ type: 'output_text', text: resultText }] };
  response('inference1', 'response1', [...calls.map(call => ({ type: 'function_call', name: call.tool, arguments: JSON.stringify(call.arguments), call_id: call.callId })),
    ...(fault === 'early-final' ? [finalAnswer] : [])]);
  const observedCalls = fault === 'missing-empty' ? calls.slice(0, -1) : calls;
  request('inference2', observedCalls.map((call, index) => ({ type: 'function_call_output', call_id: call.callId,
    output: fault === 'wire-corruption' && index === 1 ? `${call.output} altered` : call.output })), fault === 'ancestry' ? 'forged-response' : 'response1');
  if (fault !== 'missing-completion') response('inference2', 'response2', [
    ...(fault === 'early-final' ? [] : [finalAnswer]),
    ...(fault === 'post-final-call' ? [{ type: 'function_call', name: calls[0]!.tool, arguments: JSON.stringify(calls[0]!.arguments), call_id: 'after-final-call' }] : []),
  ]);
  if (fault === 'post-final-inference') {
    request('inference3', [], 'response2'); response('inference3', 'response3', []);
  }
  if (fault === 'post-final-dispatch') event({ type: 'tool_call_started', requester: { type: 'model' },
    kind: { type: 'other', name: calls[0]!.tool }, invocation_payload: payload('tool_invocation', { tool_name: calls[0]!.tool, arguments: calls[0]!.arguments }) });
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
  it.each(['early-final', 'post-final-call', 'post-final-inference', 'post-final-dispatch'] as const)(
    'refuses %s findings at the final-answer ordering boundary', async fault => {
      await expect(verifyWorkflowNativeReviewTrace(fixture(fault))).rejects.toThrow('workflow_review_native_trace_incomplete');
    });
});

function compactionTrace(input: ReturnType<typeof fixture>, request: string, fault?: string, automatic = false) {
  const traceRoot = join(input.directory, 'trace', 'trace-1234');
  const oldEvents = readFileSync(join(traceRoot, 'trace.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const oldRequest = JSON.parse(readFileSync(join(traceRoot, oldEvents[3].payload.request_payload.path), 'utf8'));
  const frames = new WorkflowReviewOwnedFile(input.directory, 'manual-frames.bin', true);
  const correlation = new WorkflowReviewOwnedFile(input.directory, 'manual-correlation.jsonl', true);
  const oldFrames = readFileSync(join(input.directory, input.capture.name));
  const calls = readFileSync(join(input.directory, 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const positiveSource = (call: typeof calls[number]) => call.receipt.kind === 'entry' && call.receipt.id.startsWith('src-') && call.receipt.bytes > 0;
  const firstCallCount = fault === 'manual-no-post-calls' ? calls.length : fault === 'manual-no-post-positive'
    ? calls.findLastIndex(positiveSource) + 1 : calls.findIndex(positiveSource) + 1;
  const compactTurnId = automatic ? input.turnId : 'manual-compact-turn';
  const postTurnId = automatic ? input.turnId : 'manual-post-turn'; const compactionId = 'manual-compaction';
  let frameSequence = 0;
  for (const [index, call] of calls.entries()) {
    for (const [field, direction] of [['request', 'receive'], ['response', 'request']] as const) {
      const old = call[field]; const value = JSON.parse(oldFrames.subarray(old.offset, old.offset + old.bytes).toString());
      if (field === 'request' && index >= firstCallCount) value.params.turnId = postTurnId;
      call[field] = frames.append(wire(value));
      correlation.append(wire({ invocationId: input.invocationId, reviewerId: input.reviewerId,
        effectiveInvocationDigest: input.effectiveInvocationDigest, sequence: ++frameSequence, direction, frame: call[field] }));
    }
    writeFileSync(join(input.directory, 'calls', `${sha(call.callId)}.json`), wire(call));
  }
  writeFileSync(join(input.directory, 'calls.jsonl'), calls.map(call => wire(call).toString()).join(''));
  input.capture = frames.seal(); input.correlation = correlation.seal(); frames.close(); correlation.close();
  const firstResult = JSON.stringify({ findings: [], coverage: { ...input.attestation, complete: false,
    ranges: calls.slice(0, firstCallCount).filter(call => call.receipt.bytes > 0).length } });
  const postRequest = 'Resume the remaining original source and read every empty terminal page.';
  const tools = { ...oldRequest.input[0], id: 'at_inventory', role: 'developer' };
  const message = (text: string, id: string, role = 'user') => ({ type: 'message', id, role, content: [{ type: 'input_text', text }] });
  const instructions = message('base instructions', 'msg_instructions', 'developer');
  const context = ['host instructions', 'environment'].map((text, index) => ({ ...message(text, `msg_context_${index}`, index ? 'user' : 'developer'),
    internal_chat_message_metadata_passthrough: { turn_id: input.turnId, create_time: index + 1,
      content_item_kinds: [index ? 'environments.environment_context' : 'host_skills.instructions'] } }));
  const prompt = { ...message(request, 'msg_prompt'), internal_chat_message_metadata_passthrough: {
    turn_id: input.turnId, create_time: 3, content_item_kinds: ['user.text'] } };
  const modelCalls = (selected: typeof calls) => selected.map(call => ({ type: 'function_call', id: `fc_${call.callId}`, call_id: call.callId,
    name: call.tool, arguments: JSON.stringify(call.arguments) }));
  const outputs = (selected: typeof calls) => selected.map(call => {
    const response = JSON.parse(readFileSync(join(input.directory, input.capture.name)).subarray(call.response.offset, call.response.offset + call.response.bytes).toString());
    return { type: 'function_call_output', id: `fco_${call.callId}`, call_id: call.callId, output: response.result.contentItems[0].text };
  });
  const answer = (text: string, id: string) => ({ type: 'message', id, role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text }] });
  const firstCalls = modelCalls(calls.slice(0, firstCallCount)); const firstOutputs = outputs(calls.slice(0, firstCallCount));
  const firstFinal = answer(firstResult, 'msg_first_final');
  const reasoning = { type: 'reasoning', id: 'rs_first', summary: [], content: [] };
  const { content: _emptyContent, ...historyReasoning } = reasoning;
  const history = [...context, prompt, ...firstCalls, ...firstOutputs, ...(automatic ? [] : [historyReasoning,
    { ...firstFinal, internal_chat_message_metadata_passthrough: { content_item_kinds: ['unknown'] } }])];
  const compacted = { type: 'compaction', id: 'cmp_manual', encrypted_content: 'opaque original history',
    internal_chat_message_metadata_passthrough: { turn_id: compactTurnId } };
  const injected = context.map(({ id: _id, ...item }) => {
    const { create_time: _time, ...metadata } = item.internal_chat_message_metadata_passthrough;
    return { ...item, internal_chat_message_metadata_passthrough: metadata };
  });
  const replacement = [...(automatic ? injected : []), prompt, compacted];
  const fresh = context.map((item, index) => ({ ...item, id: `msg_00000000-0000-7000-8000-${String(index + 1).padStart(12, '0')}`,
    internal_chat_message_metadata_passthrough: { ...item.internal_chat_message_metadata_passthrough, turn_id: postTurnId, create_time: index + 10 } }));
  const nextPrompt = { ...message(postRequest, 'msg_post_prompt'), internal_chat_message_metadata_passthrough: {
    turn_id: postTurnId, create_time: 12, content_item_kinds: ['user.text'] } };
  const packets = new Map<string, unknown>(); const events: object[] = []; let ordinal = 100; let turnId = input.turnId;
  const payload = (kind: string, value: unknown) => {
    const path = `payloads/${++ordinal}.json`; writeFileSync(join(traceRoot, path), JSON.stringify(value));
    return { raw_payload_id: `raw_payload:${ordinal}`, kind: { type: kind }, path };
  };
  const event = (value: object) => events.push({ schema_version: 1, seq: events.length + 1, rollout_id: input.threadId,
    thread_id: input.threadId, codex_turn_id: turnId, payload: value });
  const body = (items: unknown[], prior?: string, kind = 'turn') => ({ type: 'response.create', model: 'gpt-6.1-sol', input: items,
    reasoning: { effort: 'xhigh', context: 'all_turns' }, tool_choice: 'auto', parallel_tool_calls: false, store: false, stream: true,
    text: { verbosity: 'low', ...(kind === 'turn' ? { format: fault === 'manual-changed-schema' && turnId === postTurnId ? { ...outputFormat, strict: false } : outputFormat } : {}) },
    ...(prior ? { previous_response_id: prior } : {}), client_metadata: { thread_id: input.threadId, session_id: input.threadId, turn_id: turnId,
      ws_request_header_x_openai_internal_codex_responses_lite: 'true', 'x-codex-turn-metadata': JSON.stringify({
        thread_id: input.threadId, session_id: input.threadId, turn_id: turnId, request_kind: kind }) } });
  const infer = (id: string, items: unknown[], output: unknown[], prior?: string) => {
    const request = body(items, prior); packets.set(id, request);
    event({ type: 'inference_started', inference_call_id: id, thread_id: input.threadId, codex_turn_id: turnId,
      model: 'gpt-6.1-sol', provider_name: 'OpenAI', request_payload: payload('inference_request', request) });
    event({ type: 'inference_completed', inference_call_id: id, response_id: `resp_${id}`, response_payload: payload('inference_response', { output_items: output }) });
  };
  event({ type: 'rollout_started', root_thread_id: input.threadId });
  event(oldEvents[1].payload); event({ type: 'codex_turn_started', thread_id: input.threadId, codex_turn_id: turnId });
  infer('first', [tools, instructions, ...context, prompt], firstCalls);
  if (!automatic) {
    infer('first-final', firstOutputs, [reasoning, firstFinal], 'resp_first');
    event({ type: 'codex_turn_ended', codex_turn_id: turnId, status: 'completed' });
    turnId = compactTurnId;
    event({ type: 'codex_turn_started', thread_id: input.threadId, codex_turn_id: turnId });
  }
  packets.set('compact', body([tools, instructions, ...history, { type: 'compaction_trigger' }], undefined, 'compaction'));
  event({ type: 'compaction_request_started', compaction_id: compactionId, compaction_request_id: 'compact', thread_id: input.threadId,
    codex_turn_id: turnId, model: 'gpt-6.1-sol', provider_name: 'OpenAI', request_payload: payload('compaction_request', {
      model: 'gpt-6.1-sol', instructions: 'base instructions', input: [...history, { type: 'compaction_trigger' }], parallel_tool_calls: true }) });
  event({ type: 'compaction_request_completed', compaction_id: compactionId, compaction_request_id: 'compact',
    response_payload: payload('compaction_response', { output_items: [compacted] }) });
  event({ type: 'compaction_installed', compaction_id: compactionId, checkpoint_payload: payload('compaction_checkpoint', {
    input_history: history, replacement_history: fault === 'manual-injected-checkpoint' ? [...context, ...replacement] : replacement }) });
  if (!automatic) {
    event({ type: 'codex_turn_ended', codex_turn_id: turnId, status: 'completed' });
    turnId = postTurnId;
    event({ type: 'codex_turn_started', thread_id: input.threadId, codex_turn_id: turnId });
  }
  const baseline = automatic ? replacement.map((item, index) => 'id' in item ? item
    : { ...item, id: `msg_00000000-0000-7000-8000-${String(index + 1).padStart(12, '0')}` }) : [...replacement, ...fresh, nextPrompt];
  infer('post', [tools, instructions, ...baseline], modelCalls(calls.slice(firstCallCount)),
    fault === 'manual-stale-baseline' ? 'resp_first-final' : undefined);
  infer('post-final', outputs(calls.slice(firstCallCount)), [answer(input.resultText, 'msg_final')], 'resp_post');
  event({ type: 'codex_turn_ended', codex_turn_id: turnId, status: 'completed' });
  event({ type: 'thread_ended', thread_id: input.threadId, status: 'completed' }); event({ type: 'rollout_ended', status: 'completed' });
  writeFileSync(join(traceRoot, 'trace.jsonl'), events.map(value => wire(value).toString()).join(''));
  return { packets, calibration: automatic ? undefined : { firstTurnId: input.turnId, compactTurnId, postTurnId,
    compactionId: fault === 'manual-foreign-id' ? 'foreign' : compactionId, firstResult, firstCallCount, postRequest } };
}

function observedFixture(fault?: string, cachedWarmup = false, manual: boolean | 'auto' = false) {
  const input = fixture(undefined, manual ? 1000 : 300); const traceRoot = join(input.directory, 'trace', 'trace-1234');
  const request = 'Read every source page, preserve progress and return the exact coverage result.';
  const manualProof = manual ? compactionTrace(input, request, fault, manual === 'auto') : undefined;
  const events = readFileSync(join(traceRoot, 'trace.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const bodies = join(input.directory, 'bodies'); mkdirSync(bodies);
  const journal = new WorkflowReviewOwnedFile(bodies, 'events.jsonl', true); let sequence = 0; let requestCount = 0; let responseEvents = 0;
  const append = (event: unknown) => journal.append(wire({ seq: ++sequence, at: '2026-10-06T00:00:00.000Z', invocationId: input.invocationId, ...event as object }));
  const identity = { channelId: 1, transaction: 1, transport: 'wss', path: '/backend-api/codex/responses' };
  append({ type: 'websocket-negotiated', channelId: 1, transaction: 1, compression: null, modelSourceCredit: false });
  const outgoing = (value: unknown) => {
    const id = ++requestCount; const refs = ['wire', 'decoded'].map(kind => {
      const file = new WorkflowReviewOwnedFile(bodies, `body-${id}.${kind}.json`, true);
      try { const bytes = Buffer.from(JSON.stringify(value)); for (let offset = 0; offset < bytes.length; offset += 65536) file.append(bytes.subarray(offset, offset + 65536)); return file.seal(); } finally { file.close(); }
    });
    append({ type: 'body', ...identity, id, direction: 'request', encoding: 'identity', wire: refs[0], decoded: refs[1], complete: true });
  };
  const incoming = (value: object) => { append({ type: 'response-receipt', ...identity, kind: 'model-event', ...value }); responseEvents++; };
  const empty = createHash('sha256').update('array\n').digest('hex');
  for (const event of events) {
    const payload = event.payload;
    if (manualProof && ['inference_started', 'compaction_request_started'].includes(payload.type)) {
      outgoing(manualProof.packets.get(payload.inference_call_id ?? payload.compaction_request_id));
    }
    if (payload.type === 'inference_started' && !manualProof) {
      const path = join(traceRoot, payload.request_payload.path); const original = JSON.parse(readFileSync(path, 'utf8'));
      if (payload.inference_call_id === 'inference1') {
        const tools = original.input[0].tools[0].tools;
        if (fault === 'tool-name') tools[0].name = 'other_manifest';
        if (fault === 'tool-order') tools.reverse();
        if (fault === 'cursor-type') tools[0].parameters.properties.cursor.type = 'number';
        if (fault === 'id-required') tools[1].parameters.required = [];
        if (fault === 'additional-properties') tools[1].parameters.additionalProperties = true;
        if (fault === 'extra-property') tools[0].parameters.properties.path = { type: 'string' };
        if (fault === 'unexpected-pattern') tools[1].parameters.properties.id.pattern = '.*';
        original.input[0] = { ...original.input[0], id: 'at_inventory', role: 'developer' };
        original.input[1] = { ...original.input[1], id: 'msg_instructions' };
        original.input.push({ type: 'message', id: 'msg_prompt', role: 'user', content: [{ type: 'input_text', text: request }],
          internal_chat_message_metadata_passthrough: { turn_id: input.turnId, create_time: 1, content_item_kinds: ['user.text'] } });
      } else original.input = original.input.map((item: object, index: number) => ({ ...item, id: `fco_${index}` }));
      const body = { ...original, type: 'response.create', reasoning: { effort: 'xhigh', context: 'all_turns' },
        tool_choice: 'auto', store: false, stream: true, text: { verbosity: 'low', format: outputFormat },
        ...(original.previous_response_id ? { previous_response_id: 'resp_first' } : {}),
        client_metadata: { thread_id: input.threadId, session_id: input.threadId, turn_id: input.turnId,
          ws_request_header_x_openai_internal_codex_responses_lite: 'true',
          'x-codex-turn-metadata': JSON.stringify({ thread_id: input.threadId, session_id: input.threadId, turn_id: input.turnId, request_kind: 'turn' }) } };
      if (payload.inference_call_id === 'inference1' && cachedWarmup) {
        outgoing({ ...body, text: { verbosity: 'low' }, generate: false, input: body.input.slice(0, 2), client_metadata: { ...body.client_metadata, turn_id: '',
          'x-codex-turn-metadata': JSON.stringify({ thread_id: input.threadId, session_id: input.threadId, turn_id: '', request_kind: 'prewarm' }) } });
        incoming({ eventType: 'response.created', responseId: 'resp_warmup' });
        incoming({ eventType: 'response.completed', responseId: 'resp_warmup', output: { count: '0', mask: 0, sha256: empty } });
        body.input = body.input.slice(2); body.previous_response_id = 'resp_warmup';
      }
      writeFileSync(path, JSON.stringify(body));
      outgoing(fault === 'changed-wire' ? { ...body, model: 'other' } : body);
    }
    if (payload.type === 'inference_completed' || payload.type === 'compaction_request_completed') {
      const path = join(traceRoot, payload.response_payload.path); const original = JSON.parse(readFileSync(path, 'utf8'));
      if (!manualProof) original.output_items = original.output_items.map((item: { type: string }, index: number) => ({ ...item,
        id: `${item.type === 'message' ? 'msg' : 'fc'}_${index}`, ...(item.type === 'message' ? { role: 'assistant' } : {}) }));
      writeFileSync(path, JSON.stringify(original));
      if (!manualProof) payload.response_id = payload.inference_call_id === 'inference1' ? 'resp_first' : 'resp_second';
      const responseId = payload.response_id ?? 'resp_compact';
      incoming({ eventType: 'response.created', responseId });
      const file = new WorkflowReviewOwnedFile(traceRoot, payload.response_payload.path); const aggregate = createHash('sha256').update('array\n'); let count = 0;
      try { for (const item of iterateWorkflowReviewNativeItems({ file, arrayKey: 'output_items' })) {
        incoming({ eventType: 'response.output_item.done', item: { type: item.type, id: item.id, sha256: fault === 'changed-receipt' ? '0'.repeat(64) : item.sha256 } });
        aggregate.update(item.sha256 + '\n'); count++;
      } } finally { file.close(); }
      incoming({ eventType: 'response.completed', responseId, output: fault === 'empty-completed'
        ? { count: '0', mask: 0, sha256: empty } : { count: String(count), mask: 0, sha256: aggregate.digest('hex') } });
    }
  }
  const stats = { accepted: 1, requests: requestCount, responseEvents, failures: 0, peakWorkingChunk: 65536, bodySizeCeiling: null, corpusSizeCeiling: null } as const;
  append({ type: 'client-shutdown-begin', modelSourceCredit: false });
  append({ type: 'closed', status: 'healthy', stats });
  const transport = { journal: journal.seal(), stats }; journal.close();
  writeFileSync(join(traceRoot, 'trace.jsonl'), events.map(value => wire(value).toString()).join(''));
  return { ...input, request, schema: outputSchema, transport, ...(manualProof ? { calibration: manualProof.calibration } : {}) };
}

describe('offline selected transport and native trace join', () => {
  it.each([false, true])('proves exact done/native outputs with explicit-empty completion arrays (manual=%s)', async manual => {
    const input = observedFixture('empty-completed', !manual, manual);
    const proof = await verifyWorkflowNativeReviewTrace(input);
    expect(proof.ranges).toBe(input.attestation.ranges);
    expect(proof.native.compaction).toMatchObject({ authority: false, compactions: manual ? 1 : 0 });
    if (manual) expect(proof.native.calibration).toEqual(input.calibration);
  });
  it('accepts the pinned native tool schemas in held warmup and normal requests', async () => {
    const input = observedFixture(undefined, true); const proof = await verifyWorkflowNativeReviewTrace(input);
    expect(proof.ranges).toBe(input.attestation.ranges);
    expect(proof.native.transport?.stats.requests).toBe(3);
    expect(proof.native.compaction).toMatchObject({ authority: false, compactions: 0 });
  });
  it.each(['tool-name', 'tool-order', 'cursor-type', 'id-required', 'additional-properties', 'extra-property', 'unexpected-pattern'])(
    'refuses a %s change to the pinned native tool schema', async fault => {
      await expect(verifyWorkflowNativeReviewTrace(observedFixture(fault, true))).rejects.toThrow('workflow_review_reader_observation_incomplete');
    });
  it('preserves raw MCP schemas and reader argument guards after native projection', async () => {
    const input = fixture(); const server = createWorkflowReviewSourceServer({ bundle: input.bundle });
    const client = new Client({ name: 'raw-schema-control', version: '1.0.0' }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const { tools } = await client.listTools();
      expect(tools.map(tool => tool.name)).toEqual(WORKFLOW_REVIEW_READER_TOOLS);
      expect(tools.map(tool => tool.inputSchema)).toEqual([
        { type: 'object', additionalProperties: false, properties: { cursor: { type: 'string', pattern: '^[A-Za-z0-9_-]+$' } } },
        { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', pattern: '^(?:(?:instr|src)-[0-9]+|inventory|diff|objective|shared-context|contracts)$' }, cursor: { type: 'string', pattern: '^[A-Za-z0-9_-]+$' } } },
      ]);
      for (const args of [{ id: '../source' }, { id: 'src-999999' }, { id: 'src-0', cursor: 'not a cursor' }, { id: 'src-0', path: 'source' }]) {
        expect((await client.callTool({ name: WORKFLOW_REVIEW_READER_TOOLS[1]!, arguments: args })).isError).toBe(true);
      }
    } finally { await client.close(); await server.close(); }
  });
  it('joins automatic compaction with source receipt credit across the full replacement baseline', async () => {
    const input = observedFixture(undefined, false, 'auto'); const proof = await verifyWorkflowNativeReviewTrace(input);
    expect(proof.native.compaction).toMatchObject({ authority: false, compactions: 1 });
    expect(proof.native.calibration).toBeUndefined(); expect(proof.ranges).toBe(input.attestation.ranges);
  });
  it('joins manual calibration turns with cumulative original source coverage', async () => {
    const input = observedFixture(undefined, false, true); const proof = await verifyWorkflowNativeReviewTrace(input);
    expect(proof.native.compaction).toMatchObject({ authority: false, compactions: 1 });
    expect(proof.native.calibration).toEqual(input.calibration);
    expect(proof.ranges).toBe(input.attestation.ranges);
  });
  it.each(['manual-injected-checkpoint', 'manual-stale-baseline', 'manual-foreign-id', 'manual-changed-schema',
    'manual-no-post-calls', 'manual-no-post-positive'])(
    'refuses %s in a complete manual calibration trace', async fault => {
      await expect(verifyWorkflowNativeReviewTrace(observedFixture(fault, false, true))).rejects.toThrow(/workflow_review_/);
    });
  it.each([false, true])('reconstructs complete source from held requests and selected response folds (cached warmup=%s)', async cachedWarmup => {
    const input = observedFixture(undefined, cachedWarmup); const proof = await verifyWorkflowNativeReviewTrace(input);
    expect(proof.native.transport?.stats.requests).toBe(cachedWarmup ? 3 : 2);
    expect(proof.native.compaction).toMatchObject({ authority: false, compactions: 0 });
    expect(proof.ranges).toBe(input.attestation.ranges);
    expect(() => requireWorkflowNativeReviewClientFactory({ mode: 'native' })).toThrow('workflow_review_reader_observation_required');
  });
  it.each(['changed-wire', 'changed-receipt'])('refuses %s before findings are accepted', async fault => {
    await expect(verifyWorkflowNativeReviewTrace(observedFixture(fault))).rejects.toThrow(/workflow_review_/);
  });
});
