import { realpathSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { iterateWorkflowReviewNativeItems, WorkflowReviewOwnedFile, workflowReviewResourceUsage,
  writeWorkflowReviewArtifact, readWorkflowReviewNativeRequestControls, workflowReviewNativeTextContentSha256, type WorkflowReviewNativeItemFingerprint } from '../workflow-review-source.js';
import { WorkflowNativeCompactionChain, WorkflowNativeResponseReceipts, type WorkflowNativeHistoryInput } from '../workflow-native-compaction.js';

const roots: string[] = [];
const dispose: (() => void)[] = [];
const scratch = () => { const root = realpathSync(mkdtempSync(join(tmpdir(), 'omc-native-items-'))); roots.push(root); return root; };
afterEach(() => {
  for (const close of dispose.splice(0)) close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function compactionFixture(fault?: string) {
  const root = scratch(); const files: WorkflowReviewOwnedFile[] = []; let ordinal = 0;
  const threadId = 'thread'; const turnId = 'turn';
  const write = (value: unknown, arrayKey: string, publicCompactionMetadata = false): WorkflowNativeHistoryInput => {
    const name = `input-${++ordinal}.json`; writeFileSync(join(root, name), JSON.stringify(value));
    const file = new WorkflowReviewOwnedFile(root, name); files.push(file); return { file, arrayKey, publicCompactionMetadata };
  };
  const tools = { type: 'additional_tools', id: 'at_inventory', role: 'developer', tools: [{ type: 'namespace', name: 'functions', tools: [
    { type: 'function', name: 'reader_manifest', parameters: { type: 'object', additionalProperties: false } },
    { type: 'function', name: 'reader_source', parameters: { type: 'object', additionalProperties: false } },
  ] }] };
  const instructions = { type: 'message', id: 'msg_instructions', role: 'developer', content: [{ type: 'input_text', text: 'base instructions' }],
    internal_chat_message_metadata_passthrough: { content_item_kinds: ['model.base_instructions'] } };
  const context = [{ ...message('host instructions', 'msg_host'), role: 'developer', internal_chat_message_metadata_passthrough: {
    turn_id: turnId, create_time: 1, content_item_kinds: ['host_skills.instructions', 'permissions.instructions', 'collaboration_mode.instructions'] } },
  { ...message('environment', 'msg_environment'), internal_chat_message_metadata_passthrough: {
    turn_id: turnId, create_time: 2, content_item_kinds: ['environments.environment_context'] } }];
  const prompt = { ...message('controller reader request', 'msg_prompt'), internal_chat_message_metadata_passthrough: {
    turn_id: turnId, create_time: 3, content_item_kinds: ['user.text'] } };
  const commentary = { type: 'message', id: 'msg_commentary', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'reading' }],
    internal_chat_message_metadata_passthrough: { turn_id: turnId, create_time: 4 } };
  const call = { type: 'function_call', id: 'fc_reader', call_id: 'call_reader', name: 'reader_manifest', arguments: '{}' };
  const output = { type: 'function_call_output', id: 'fco_reader', call_id: 'call_reader', output: 'exact original reader bytes 🙂' };
  const before = [...context, prompt]; const history = [...before, { ...commentary,
    internal_chat_message_metadata_passthrough: { ...commentary.internal_chat_message_metadata_passthrough, content_item_kinds: ['unknown'] } }, call, output];
  const wireRequest = (input: unknown[], kind = 'turn', prior?: string) => ({ model: 'gpt-6.1-sol', input, tool_choice: 'auto',
    parallel_tool_calls: false, reasoning: { effort: fault === 'effort' && kind === 'compaction' ? 'medium' : 'xhigh', context: 'all_turns' },
    store: false, stream: true, client_metadata: { thread_id: threadId, session_id: threadId, turn_id: turnId,
      'x-codex-turn-metadata': JSON.stringify({ thread_id: threadId, session_id: threadId, turn_id: turnId, request_kind: kind }) },
    ...(prior ? { previous_response_id: prior } : {}) });
  const first = write(wireRequest([tools, instructions, ...before]), 'input');
  const toolsHash = [...iterateWorkflowReviewNativeItems(write({ input: [tools] }, 'input'))][0]!.fields.tools!;
  const promptHash = [...iterateWorkflowReviewNativeItems(write({ input: [prompt] }, 'input'))][0]!.fields.content!;
  const chain = new WorkflowNativeCompactionChain({ directory: join(root, 'proof'), artifactsDirectory: root, threadId, turnId,
    toolsSha256: toolsHash, toolNames: ['reader_manifest', 'reader_source'], controllerPromptContentSha256: promptHash });
  dispose.push(() => { chain.dispose(); for (const file of files) file.close(); });
  const initialResponse = write({ output_items: [commentary, call] }, 'output_items'); const toolOutput = write({ input: [output] }, 'input');
  const injected = context.map(item => {
    const { id: _id, ...value } = item; const { create_time: _time, ...metadata } = value.internal_chat_message_metadata_passthrough;
    return { ...value, internal_chat_message_metadata_passthrough: metadata };
  });
  const compacted = { type: 'compaction', id: 'cmp_compacted', encrypted_content: 'opaque \ud800🙂 payload', internal_chat_message_metadata_passthrough: { turn_id: turnId } };
  const replacement = [...injected, prompt, compacted];
  const compactHistory = fault === 'source-drop' ? history.slice(0, -1) : history;
  const trigger = { type: 'compaction_trigger' };
  const compactTools = fault === 'extra-tool' ? { ...tools, tools: [...tools.tools, { type: 'namespace', name: 'shell', tools: [] }] } : tools;
  const compactRequest = write(wireRequest([compactTools, instructions, ...compactHistory, ...(fault === 'trigger' ? [] : [trigger])], 'compaction'), 'input');
  const trace = write({ model: 'gpt-6.1-sol', instructions: 'base instructions', input: [...history, trigger], parallel_tool_calls: fault !== 'trace-parallel' }, 'input');
  const publicItem = { ...compacted, metadata: { turn_id: fault === 'public-metadata' ? 'foreign' : turnId } };
  const done = write({ output: [publicItem] }, 'output', true);
  const completed = write({ output: [fault === 'opaque' ? { ...publicItem, encrypted_content: 'changed' } : publicItem] }, 'output', true);
  const nativeResult = write({ output_items: [compacted] }, 'output_items');
  const checkpointReplacement = fault === 'injection' ? [{ ...injected[0]!, content: [{ type: 'input_text', text: 'new instructions' }] }, ...replacement.slice(1)]
    : fault === 'injection-time' ? [{ ...injected[0]!, internal_chat_message_metadata_passthrough: { ...injected[0]!.internal_chat_message_metadata_passthrough, create_time: 1 } }, ...replacement.slice(1)]
      : fault === 'retained-drop' ? [...injected, compacted] : replacement;
  const checkpoint = write({ input_history: fault === 'checkpoint-input' ? history.slice(1) : history, replacement_history: checkpointReplacement }, 'replacement_history');
  const baselineItems = replacement.map((item, index) => {
    if ('id' in item) return fault === 'existing-id' && item.id === 'msg_prompt' ? { ...item, id: 'msg_changed' } : item;
    return { ...item, id: fault === 'generated-id' ? 'fc_00000000-0000-7000-8000-000000000001'
      : fault === 'duplicate-id' ? 'msg_00000000-0000-7000-8000-000000000001' : `msg_00000000-0000-7000-8000-${String(index + 1).padStart(12, '0')}` };
  });
  const baseline = write(wireRequest([tools, instructions, ...baselineItems], 'turn', fault === 'old-ancestor' ? 'response_initial' : undefined), 'input');
  const final = write({ output_items: [{ type: 'message', id: 'msg_final', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'review completed' }] }] }, 'output_items');
  const prepare = async () => {
    await chain.startGeneration('inference_initial', first); chain.completeGeneration('inference_initial', 'response_initial', initialResponse); chain.recordToolOutputs(toolOutput);
  };
  const compact = async () => {
    await chain.startCompaction('compact_id', 'compaction_request:1', compactRequest, trace);
    chain.completeCompaction('compact_id', 'compaction_request:1', 'response_compact', done, completed, nativeResult);
    await chain.installCompaction('compact_id', checkpoint.file);
  };
  const finish = async () => {
    await chain.startGeneration('inference_post', baseline); chain.completeGeneration('inference_post', 'response_post', final); return chain.finish();
  };
  return { root, chain, files, write, wireRequest, tools, instructions, context, history, replacement, baselineItems, prompt, rootTurn: turnId,
    first, compactRequest, trace, done, completed, nativeResult, checkpoint, baseline, initialResponse, toolOutput, final, prepare, compact, finish };
}

describe('ordered native response receipt folds', () => {
  const created = { kind: 'model-event' as const, eventType: 'response.created', responseId: 'resp_fold' };
  const receipt = (sha256: string, type = 'message') => ({ kind: 'model-event' as const, eventType: 'response.output_item.done', item: { id: 'item', type, sha256 } });
  const completed = (digests: string[]) => ({ kind: 'model-event' as const, eventType: 'response.completed', responseId: 'resp_fold',
    output: { count: String(digests.length), mask: 0, sha256: createHash('sha256').update('array\n').update(digests.map(value => value + '\n').join('')).digest('hex') } });
  it('joins each selected done item, terminal aggregate and held native output in order', () => {
    const fixture = compactionFixture(); const selected = [...iterateWorkflowReviewNativeItems(fixture.initialResponse)];
    const fold = new WorkflowNativeResponseReceipts(); fold.record(created);
    for (const item of selected) fold.record(receipt(item.sha256, item.type));
    fold.record(completed(selected.map(item => item.sha256)));
    expect(fold.finish(fixture.initialResponse)).toMatchObject({ authority: false, responseId: 'resp_fold', count: '2' });
    expect(() => fold.record(created)).toThrow(/workflow_review_/);
  });
  it('accepts an explicit-empty terminal only with the exact ordered done/native output proof', () => {
    const fixture = compactionFixture(); const selected = [...iterateWorkflowReviewNativeItems(fixture.initialResponse)];
    const fold = new WorkflowNativeResponseReceipts(); fold.record(created);
    for (const item of selected) fold.record(receipt(item.sha256, item.type));
    fold.record(completed([]));
    expect(fold.finish(fixture.initialResponse)).toEqual({ authority: false, responseId: 'resp_fold', count: '2',
      sha256: completed(selected.map(item => item.sha256)).output.sha256, completedOutput: completed([]).output });
    expect(Object.isFrozen(fold.finish().completedOutput)).toBe(true);
  });
  it.each(['no-done', 'missing-done', 'reordered-done', 'duplicate-done', 'changed-done', 'altered-native',
    'missing-completion', 'duplicate-completion', 'foreign-completion', 'late-done', 'bad-empty-hash', 'empty-mask', 'nonempty-mismatch'])(
    'refuses %s when a terminal response has an explicit-empty output', fault => {
      const fixture = compactionFixture(); const selected = [...iterateWorkflowReviewNativeItems(fixture.initialResponse)];
      const fold = new WorkflowNativeResponseReceipts();
      const run = () => {
        fold.record(created);
        const ordered = fault === 'no-done' ? [] : fault === 'missing-done' ? selected.slice(0, -1)
          : fault === 'reordered-done' ? [...selected].reverse() : fault === 'duplicate-done' ? [...selected, selected[0]!] : selected;
        for (const item of ordered) fold.record(receipt(fault === 'changed-done' ? 'f'.repeat(64) : item.sha256, item.type));
        const terminal = completed([]);
        if (fault === 'foreign-completion') terminal.responseId = 'resp_foreign';
        if (fault === 'bad-empty-hash') terminal.output.sha256 = 'f'.repeat(64);
        if (fault === 'empty-mask') terminal.output.mask = 1;
        if (fault === 'nonempty-mismatch') terminal.output = { ...completed(selected.map(item => item.sha256)).output, sha256: 'f'.repeat(64) };
        if (fault !== 'missing-completion') fold.record(terminal);
        if (fault === 'duplicate-completion') fold.record(terminal);
        if (fault === 'late-done') fold.record(receipt(selected[0]!.sha256, selected[0]!.type));
        let native = fixture.initialResponse;
        if (fault === 'altered-native') {
          const changed = JSON.parse(readFileSync(join(fixture.root, native.file.name), 'utf8'));
          changed.output_items[0].content[0].text = 'altered native response'; native = fixture.write(changed, 'output_items');
        }
        return fold.finish(native);
      };
      expect(run).toThrow(/workflow_review_/);
    });
  it.each(['missing-done', 'changed-done', 'reordered-done', 'foreign-response', 'missing-completion', 'control-credit', 'failed-event'])(
    'refuses %s before response proof', fault => {
      const first = '1'.repeat(64); const second = '2'.repeat(64); const fold = new WorkflowNativeResponseReceipts();
      const run = () => {
        fold.record(created);
        if (fault === 'control-credit') fold.record({ kind: 'metadata-discarded' });
        if (fault === 'failed-event') fold.record({ ...created, eventType: 'response.failed' });
        if (fault !== 'missing-done') fold.record(receipt(fault === 'changed-done' ? '3'.repeat(64) : fault === 'reordered-done' ? second : first));
        fold.record(receipt(fault === 'reordered-done' ? first : second));
        if (fault !== 'missing-completion') fold.record({ ...completed([first, second]), ...(fault === 'foreign-response' ? { responseId: 'resp_foreign' } : {}) });
        return fold.finish();
      };
      expect(run).toThrow(/workflow_review_/);
    });
  it('accepts zero-output warmup without a source or compaction item', () => {
    const fold = new WorkflowNativeResponseReceipts(); fold.record(created); fold.record(completed([]));
    expect(fold.finish()).toEqual({ authority: false, responseId: 'resp_fold', count: '0', sha256: completed([]).output.sha256,
      completedOutput: completed([]).output });
  });
  it('never substitutes a history projection for the exact incoming native response receipt', () => {
    const fixture = compactionFixture(); const selected = [...iterateWorkflowReviewNativeItems(fixture.initialResponse)];
    const fold = new WorkflowNativeResponseReceipts(); fold.record(created);
    for (const item of selected) fold.record(receipt(item.sha256, item.type));
    fold.record(completed(selected.map(item => item.sha256)));
    const changed = JSON.parse(readFileSync(join(fixture.root, fixture.initialResponse.file.name), 'utf8'));
    changed.output_items[0].internal_chat_message_metadata_passthrough.content_item_kinds = ['unknown'];
    expect(() => fold.finish(fixture.write(changed, 'output_items'))).toThrow(/workflow_review_/);
  });
  it.each(['full', 'empty'])('joins %s terminal compact receipts to the exact native compact result', async aggregate => {
    const fixture = compactionFixture(); await fixture.prepare();
    await fixture.chain.startCompaction('compact_id', 'compaction_request:1', fixture.compactRequest, fixture.trace);
    const compacted = [...iterateWorkflowReviewNativeItems(fixture.nativeResult)][0]!;
    const fold = new WorkflowNativeResponseReceipts(); fold.record(created);
    fold.record({ ...receipt(compacted.sha256, 'compaction'), item: { type: 'compaction', id: compacted.id, sha256: compacted.sha256 } });
    fold.record(completed(aggregate === 'empty' ? [] : [compacted.sha256]));
    fixture.chain.completeCompactionReceipt('compact_id', 'compaction_request:1', fold.finish(fixture.nativeResult), fixture.nativeResult);
    await fixture.chain.installCompaction('compact_id', fixture.checkpoint.file);
    expect(await fixture.finish()).toMatchObject({ authority: false, compactions: 1 });
  });
});

describe('offline native compaction chain', () => {
  it.each(['kind', 'count', 'turn', 'time', 'content', 'raw-unprojected', 'checkpoint'])(
    'refuses a %s change to the proven directional model history', async fault => {
      const fixture = compactionFixture(); await fixture.prepare();
      const history = structuredClone(fixture.history);
      const item = history.find(item => 'id' in item && item.id === 'msg_commentary')!;
      if (!('internal_chat_message_metadata_passthrough' in item) || !('content' in item)) throw new Error('fixture');
      const metadata = item.internal_chat_message_metadata_passthrough;
      if (fault === 'kind') metadata.content_item_kinds = ['user.text'];
      if (fault === 'count') metadata.content_item_kinds = ['unknown', 'unknown'];
      if (fault === 'turn') metadata.turn_id = 'foreign';
      if (fault === 'time') metadata.create_time = 5;
      if (fault === 'content') item.content[0]!.text = 'changed';
      if (fault === 'raw-unprojected') Reflect.deleteProperty(metadata, 'content_item_kinds');
      if (fault === 'checkpoint') {
        await fixture.chain.startCompaction('compact_id', 'compaction_request:1', fixture.compactRequest, fixture.trace);
        fixture.chain.completeCompaction('compact_id', 'compaction_request:1', 'response_compact', fixture.done, fixture.completed, fixture.nativeResult);
        metadata.create_time = 5;
        await expect(fixture.chain.installCompaction('compact_id', fixture.write({ input_history: history, replacement_history: fixture.replacement }, 'replacement_history').file))
          .rejects.toThrow(/workflow_review_/);
      } else {
        const trigger = { type: 'compaction_trigger' };
        await expect(fixture.chain.startCompaction('compact_id', 'compaction_request:1',
          fixture.write(fixture.wireRequest([fixture.tools, fixture.instructions, ...history, trigger], 'compaction'), 'input'),
          fixture.write({ model: 'gpt-6.1-sol', instructions: 'base instructions', input: [...history, trigger], parallel_tool_calls: true }, 'input')))
          .rejects.toThrow(/workflow_review_/);
      }
    });
  it.each(['valid', 'injected-manual-checkpoint', 'reordered-post-context', 'changed-context', 'stale-context-turn', 'changed-new-prompt'])(
    'checks observed manual DoNotInject and post-turn context reinjection: %s', async fault => {
      const fixture = compactionFixture(); const manualTurn = 'manual-turn'; const postTurn = 'post-turn'; await fixture.prepare();
      const firstFinal = { type: 'message', id: 'msg_first_final', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'partial' }] };
      await fixture.chain.startGeneration('first-final', fixture.write(fixture.wireRequest([fixture.tools, fixture.instructions, ...fixture.history]), 'input'));
      fixture.chain.completeGeneration('first-final', 'resp_first_final', fixture.write({ output_items: [firstFinal] }, 'output_items'));
      fixture.chain.beginManualCompaction(manualTurn);
      const oldHistory = [...fixture.history, { ...firstFinal, internal_chat_message_metadata_passthrough: { content_item_kinds: ['unknown'] } }];
      const manualRequest = fixture.wireRequest([fixture.tools, fixture.instructions, ...oldHistory, { type: 'compaction_trigger' }], 'compaction');
      manualRequest.client_metadata.turn_id = manualTurn;
      manualRequest.client_metadata['x-codex-turn-metadata'] = JSON.stringify({ thread_id: 'thread', session_id: 'thread', turn_id: manualTurn, request_kind: 'compaction' });
      await fixture.chain.startCompaction('manual-id', 'manual-request', fixture.write(manualRequest, 'input'),
        fixture.write({ model: 'gpt-6.1-sol', instructions: 'base instructions', input: [...oldHistory, { type: 'compaction_trigger' }], parallel_tool_calls: true }, 'input'));
      const compacted = { type: 'compaction', id: 'cmp_manual', encrypted_content: 'opaque manual history', internal_chat_message_metadata_passthrough: { turn_id: manualTurn } };
      const output = fixture.write({ output_items: [compacted] }, 'output_items');
      fixture.chain.completeCompaction('manual-id', 'manual-request', 'resp_manual', output, output, output);
      const replacement = [fixture.prompt, compacted];
      const finish = async () => {
        await fixture.chain.installCompaction('manual-id', fixture.write({ input_history: oldHistory,
          replacement_history: fault === 'injected-manual-checkpoint' ? [...fixture.context, ...replacement] : replacement }, 'replacement_history').file);
        const promptText = 'Continue reading original source';
        fixture.chain.beginPostCompactionTurn(postTurn, workflowReviewNativeTextContentSha256(promptText));
        const contexts = fixture.context.map((item, index) => ({ ...item, id: `msg_00000000-0000-7000-8000-${String(index + 1).padStart(12, '0')}`,
          ...(fault === 'changed-context' ? { content: [{ type: 'input_text', text: 'unrelated context' }] } : {}),
          internal_chat_message_metadata_passthrough: { ...item.internal_chat_message_metadata_passthrough, turn_id: fault === 'stale-context-turn' ? 'turn' : postTurn, create_time: 10 + index } }));
        const prompt = { ...message(fault === 'changed-new-prompt' ? 'other prompt' : promptText, 'msg_post_prompt'),
          internal_chat_message_metadata_passthrough: { turn_id: postTurn, create_time: 12, content_item_kinds: ['user.text'] } };
        const post = fixture.wireRequest([fixture.tools, fixture.instructions, ...replacement,
          ...(fault === 'reordered-post-context' ? contexts.reverse() : contexts), prompt]);
        post.client_metadata.turn_id = postTurn; post.client_metadata['x-codex-turn-metadata'] = JSON.stringify({ thread_id: 'thread', session_id: 'thread', turn_id: postTurn, request_kind: 'turn' });
        await fixture.chain.startGeneration('post', fixture.write(post, 'input'));
        fixture.chain.completeGeneration('post', 'resp_post', fixture.final); return fixture.chain.finish();
      };
      if (fault === 'valid') expect(await finish()).toMatchObject({ authority: false, compactions: 1 });
      else await expect(finish()).rejects.toThrow(/workflow_review_/);
    });
  const websocket = (fixture: ReturnType<typeof compactionFixture>, value: Record<string, unknown>) => {
    const metadata = value.client_metadata as Record<string, unknown>;
    return { ...fixture.write({ type: 'response.create', ...value,
      client_metadata: { ...metadata, ws_request_header_x_openai_internal_codex_responses_lite: 'true' } }, 'input'), representation: 'wire-wss' as const };
  };
  const warmup = (fixture: ReturnType<typeof compactionFixture>) => {
    const value = fixture.wireRequest([fixture.tools, fixture.instructions]);
    return websocket(fixture, { ...value, generate: false, client_metadata: { ...value.client_metadata, turn_id: '',
      'x-codex-turn-metadata': JSON.stringify({ thread_id: 'thread', session_id: 'thread', turn_id: '', request_kind: 'prewarm' }) } });
  };
  it.each([false, true])('keeps zero-credit warmup separate from the first full/cached request (cached=%s)', async cached => {
    const fixture = compactionFixture();
    fixture.chain.registerWarmup(warmup(fixture), { kind: 'model-event', eventType: 'response.completed', responseId: 'resp_warmup',
      output: { count: '0', mask: 0, sha256: createHash('sha256').update('array\n').digest('hex') } });
    const first = JSON.parse(readFileSync(join(fixture.root, fixture.first.file.name), 'utf8'));
    if (cached) { first.input = first.input.slice(2); first.previous_response_id = 'resp_warmup'; }
    await fixture.chain.startGeneration('first', websocket(fixture, first));
    fixture.chain.completeGeneration('first', 'resp_first', fixture.initialResponse); fixture.chain.recordToolOutputs(fixture.toolOutput);
    await fixture.compact(); expect(await fixture.finish()).toMatchObject({ authority: false, compactions: 1 });
  });
  it('reconstructs a normal delta only through the exact preceding successful response', async () => {
    const fixture = compactionFixture(); await fixture.prepare();
    const output = JSON.parse(readFileSync(join(fixture.root, fixture.toolOutput.file.name), 'utf8')).input;
    const delta = websocket(fixture, fixture.wireRequest(output, 'turn', 'response_initial'));
    await fixture.chain.startGeneration('delta', delta);
    fixture.chain.completeGeneration('delta', 'response_delta', fixture.write({ output_items: [] }, 'output_items'));
    await fixture.compact(); expect(await fixture.finish()).toMatchObject({ authority: false, compactions: 1 });
  });
  it.each(['foreign', 'older'])('refuses a %s delta ancestry before generating a proof', async fault => {
    const fixture = compactionFixture(); await fixture.prepare();
    const output = JSON.parse(readFileSync(join(fixture.root, fixture.toolOutput.file.name), 'utf8')).input;
    if (fault === 'older') {
      await fixture.chain.startGeneration('first-delta', websocket(fixture, fixture.wireRequest(output, 'turn', 'response_initial')));
      fixture.chain.completeGeneration('first-delta', 'response_current', fixture.write({ output_items: [] }, 'output_items'));
    }
    await expect(fixture.chain.startGeneration('bad-delta', websocket(fixture, fixture.wireRequest(output, 'turn', fault === 'foreign' ? 'foreign' : 'response_initial')))).rejects.toThrow(/workflow_review_/);
  });
  it('does not award warmup source credit or admit it as an ordinary inference', async () => {
    const fixture = compactionFixture();
    expect(() => fixture.chain.registerWarmup(warmup(fixture), { kind: 'model-event', eventType: 'response.completed', responseId: 'resp_bad',
      output: { count: '1', mask: 0, sha256: createHash('sha256').update('array\n').digest('hex') } })).toThrow(/workflow_review_/);
    const other = compactionFixture(); await expect(other.chain.startGeneration('fake-reader', warmup(other))).rejects.toThrow(/workflow_review_/);
  });
  it('links exact compact input, typed response, checkpoint and full baseline without granting authority', async () => {
    const fixture = compactionFixture(); await fixture.prepare(); await fixture.compact();
    const proof = await fixture.finish(); expect(proof).toMatchObject({ authority: false, compactions: 1 });
    expect(proof.history.bytes).toBeGreaterThan(0);
    await expect(fixture.chain.startGeneration('after-final', fixture.baseline)).rejects.toThrow(/workflow_review_/);
    await expect(fixture.chain.finish()).rejects.toThrow(/workflow_review_/);
  });
  for (const fault of ['effort', 'extra-tool', 'source-drop', 'trigger', 'trace-parallel', 'public-metadata', 'opaque', 'checkpoint-input',
    'injection', 'injection-time', 'retained-drop', 'existing-id', 'generated-id', 'duplicate-id', 'old-ancestor']) {
    it(`refuses ${fault} compaction alteration before a terminal proof`, async () => {
      const fixture = compactionFixture(fault); await fixture.prepare();
      await expect((async () => { await fixture.compact(); return fixture.finish(); })()).rejects.toThrow(/workflow_review_/);
      await expect(fixture.chain.finish()).rejects.toThrow(/workflow_review_/);
    }, process.platform === 'win32' && (fault === 'existing-id' || fault === 'old-ancestor') ? 120_000 : 30_000);
  }
  it('refuses overlap, an uncompleted request, missing install and a missing subsequent baseline', async () => {
    const first = compactionFixture(); await first.chain.startGeneration('pending', first.first);
    await expect(first.chain.startCompaction('compact_id', 'compaction_request:1', first.compactRequest, first.trace)).rejects.toThrow(/workflow_review_/);
    const second = compactionFixture(); await second.prepare(); await second.chain.startCompaction('compact_id', 'compaction_request:1', second.compactRequest, second.trace);
    await expect(second.chain.installCompaction('compact_id', second.checkpoint.file)).rejects.toThrow(/workflow_review_/);
    const third = compactionFixture(); await third.prepare(); await third.compact(); await expect(third.chain.finish()).rejects.toThrow(/workflow_review_/);
  });
  it('requires output-item-done, response-completed and native result to agree', async () => {
    const fixture = compactionFixture(); await fixture.prepare();
    await fixture.chain.startCompaction('compact_id', 'compaction_request:1', fixture.compactRequest, fixture.trace);
    expect(() => fixture.chain.completeCompaction('compact_id', 'wrong-request', 'response_compact', fixture.done, fixture.completed, fixture.nativeResult)).toThrow(/workflow_review_/);
    expect(() => fixture.chain.completeCompaction('compact_id', 'compaction_request:1', 'response_compact', fixture.done, fixture.completed, fixture.nativeResult)).toThrow(/workflow_review_/);
    await expect(fixture.chain.finish()).rejects.toThrow(/workflow_review_/);
  });
  it('supports serial successful compactions with bounded open journals and fresh baselines', async () => {
    const fixture = compactionFixture(); await fixture.prepare(); await fixture.compact();
    await fixture.chain.startGeneration('post_first', fixture.baseline);
    const commentary = { type: 'message', id: 'msg_between', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'continue' }] };
    fixture.chain.completeGeneration('post_first', 'response_between', fixture.write({ output_items: [commentary] }, 'output_items'));
    const history = [...fixture.baselineItems, { ...commentary, internal_chat_message_metadata_passthrough: { content_item_kinds: ['unknown'] } }]; const trigger = { type: 'compaction_trigger' };
    const request = fixture.write(fixture.wireRequest([fixture.tools, fixture.instructions, ...history, trigger], 'compaction'), 'input');
    const trace = fixture.write({ model: 'gpt-6.1-sol', instructions: 'base instructions', input: [...history, trigger], parallel_tool_calls: true }, 'input');
    await fixture.chain.startCompaction('compact_second', 'compaction_request:2', request, trace);
    const opaque = { type: 'compaction', id: 'cmp_second', encrypted_content: 'second opaque item', internal_chat_message_metadata_passthrough: { turn_id: fixture.rootTurn } };
    const output = fixture.write({ output_items: [opaque] }, 'output_items');
    fixture.chain.completeCompaction('compact_second', 'compaction_request:2', 'response_compact_second', output, output, output);
    const replacement = [...fixture.replacement.slice(0, -1), opaque];
    const checkpoint = fixture.write({ input_history: history, replacement_history: replacement }, 'replacement_history');
    await fixture.chain.installCompaction('compact_second', checkpoint.file);
    const baseline = replacement.map((item, index) => 'id' in item ? item : { ...item, id: `msg_00000000-0000-7000-8000-${String(index + 11).padStart(12, '0')}` });
    await fixture.chain.startGeneration('post_second', fixture.write(fixture.wireRequest([fixture.tools, fixture.instructions, ...baseline]), 'input'));
    fixture.chain.completeGeneration('post_second', 'response_final', fixture.final);
    expect(await fixture.chain.finish()).toMatchObject({ authority: false, compactions: 2 });
    // Input handles are no longer needed; each fixed journal owns its original and anonymous snapshot.
    for (const file of fixture.files) file.close();
    expect(workflowReviewResourceUsage().descriptors).toBeLessThanOrEqual(10);
    fixture.chain.dispose();
    expect(workflowReviewResourceUsage().descriptors).toBe(0);
  });
  it('refuses duplicate compaction identities and newly invented calibration turns', async () => {
    const fixture = compactionFixture(); await fixture.prepare();
    await expect(fixture.chain.startCompaction('same', 'same', fixture.compactRequest, fixture.trace)).rejects.toThrow(/workflow_review_/);
    await expect(fixture.chain.finish()).rejects.toThrow(/workflow_review_/);
    const manual = compactionFixture(); await manual.prepare();
    const invalid = manual.write({ model: 'gpt-6.1-sol', input: [], tool_choice: 'auto', parallel_tool_calls: false,
      reasoning: { effort: 'xhigh', context: 'all_turns' }, store: false, stream: true,
      client_metadata: { thread_id: 'thread', session_id: 'thread', turn_id: 'unobserved-manual-turn',
        'x-codex-turn-metadata': JSON.stringify({ thread_id: 'thread', session_id: 'thread', turn_id: 'unobserved-manual-turn', request_kind: 'compaction' }) } }, 'input');
    await expect(manual.chain.startCompaction('manual', 'compaction_request:1', invalid, manual.trace)).rejects.toThrow(/workflow_review_/);
  });
  it('revalidates all retained raw files before finishing', async () => {
    const fixture = compactionFixture(); await fixture.prepare(); await fixture.compact();
    writeFileSync(join(fixture.root, fixture.compactRequest.file.name), '{}');
    await expect(fixture.finish()).rejects.toThrow(/workflow_review_/);
  });
  it('rejects unproved WebSocket envelope/control fields and duplicate controls', () => {
    const fixture = compactionFixture(); const root = scratch();
    for (const raw of ['{"type":"response.create","model":"gpt-6.1-sol","input":[]}',
      '{"model":"gpt-6.1-sol","model":"other","input":[],"parallel_tool_calls":false}']) {
      writeFileSync(join(root, 'controls.json'), raw); const file = new WorkflowReviewOwnedFile(root, 'controls.json');
      try { expect(() => readWorkflowReviewNativeRequestControls(file)).toThrow(/workflow_review_/); } finally { file.close(); }
    }
    expect(readWorkflowReviewNativeRequestControls(fixture.compactRequest.file)).toMatchObject({ effort: 'xhigh', context: 'all_turns', requestKind: 'compaction' });
  });
});
function fingerprint(raw: string, options: { chunkBytes?: number; publicCompactionMetadata?: boolean } = {}): WorkflowReviewNativeItemFingerprint[] {
  const root = scratch(); writeFileSync(join(root, 'items.json'), raw);
  const file = new WorkflowReviewOwnedFile(root, 'items.json');
  try { return [...iterateWorkflowReviewNativeItems({ file, arrayKey: 'input', ...options })]; } finally { file.close(); }
}
const message = (text: string, id = 'msg_original') => ({ type: 'message', id, role: 'user', content: [{ type: 'input_text', text }] });

describe('streamed typed native item fingerprints', () => {
  it.each([false, true])('derives missing positional kinds with existing metadata=%s while keeping raw fields exact', present => {
    const raw = { ...message('first'), role: 'assistant', phase: 'commentary',
      content: [{ type: 'output_text', text: 'first' }, { type: 'output_text', text: 'second' }],
      ...(present ? { internal_chat_message_metadata_passthrough: { turn_id: 'turn', create_time: 12.25 } } : {}) };
    const expected = { ...raw, internal_chat_message_metadata_passthrough: {
      ...raw.internal_chat_message_metadata_passthrough, content_item_kinds: ['unknown', 'unknown'] } };
    const before = fingerprint(JSON.stringify({ input: [raw] }), { chunkBytes: 1 })[0]!;
    const after = fingerprint(JSON.stringify({ input: [expected] }))[0]!;
    expect(before.sha256).not.toBe(after.sha256); expect(before.fields).not.toEqual(after.fields);
    expect(before.historySerialization).toEqual({ sha256: after.sha256, fields: after.fields });
    expect(after.historySerialization).toBeUndefined();
    for (const content_item_kinds of [[], ['unknown'], ['unknown', 'user.text']]) {
      const classified = fingerprint(JSON.stringify({ input: [{ ...expected, internal_chat_message_metadata_passthrough: {
        ...expected.internal_chat_message_metadata_passthrough, content_item_kinds } }] }))[0]!;
      expect(classified.historySerialization).toBeUndefined(); expect(classified.sha256).not.toBe(before.historySerialization!.sha256);
    }
  });
  it('omits only an empty reasoning content array in the derived history, preserving every other field', () => {
    const raw = { type: 'reasoning', id: 'rs_original', content: [], summary: [{ type: 'summary_text', text: 'summary' }],
      encrypted_content: 'opaque', internal_chat_message_metadata_passthrough: { turn_id: 'turn', create_time: 12.25 } };
    const { content: _content, ...expected } = raw;
    const before = fingerprint(JSON.stringify({ input: [raw] }))[0]!;
    const after = fingerprint(JSON.stringify({ input: [expected] }))[0]!;
    expect(before.sha256).not.toBe(after.sha256);
    expect(before.historySerialization).toEqual({ sha256: after.sha256, fields: after.fields });
    for (const content of [null, [{ type: 'reasoning_text', text: 'retained reasoning' }]]) {
      const nonempty = fingerprint(JSON.stringify({ input: [{ ...raw, content }] }))[0]!;
      expect(nonempty.historySerialization).toBeUndefined(); expect(nonempty.sha256).not.toBe(after.sha256);
    }
    for (const changed of [{ ...expected, encrypted_content: 'other' }, { ...expected, summary: [] }, { ...expected, id: 'rs_other' },
      { ...expected, internal_chat_message_metadata_passthrough: { turn_id: 'other', create_time: 12.25 } }]) {
      expect(fingerprint(JSON.stringify({ input: [changed] }))[0]!.sha256).not.toBe(before.historySerialization!.sha256);
    }
  });
  it('refuses history-authority markers supplied by a request item', () => {
    for (const field of ['expectedHistorySha256', 'historySerialization']) {
      expect(() => fingerprint(JSON.stringify({ input: [{ ...message('request'), [field]: 'a'.repeat(64) }] }))).toThrow(/workflow_review_/);
    }
    expect(fingerprint(JSON.stringify({ input: [message('request')] }))[0]!.historySerialization).toBeUndefined();
  });
  it('compares field order and JSON escapes while preserving content/history order and every ID', () => {
    const left = fingerprint(JSON.stringify({ input: [message('é🙂/\n'), message('second', 'msg_second')] }));
    const right = fingerprint('{ "input": [{"content":[{"text":"\\u00e9\\ud83d\\ude42\\/\\n","type":"input_text"}],"role":"user","id":"msg_original","type":"message"},'
      + JSON.stringify(message('second', 'msg_second')) + '] }');
    expect(right).toEqual(left);
    expect(fingerprint(JSON.stringify({ input: [message('second', 'msg_second'), message('é🙂/\n')] })).map(item => item.sha256))
      .not.toEqual(left.map(item => item.sha256));
    const changed = fingerprint(JSON.stringify({ input: [message('é🙂/\n', 'msg_changed')] }))[0]!;
    expect(changed.sha256).not.toBe(left[0]!.sha256); expect(changed.withoutIdSha256).toBe(left[0]!.withoutIdSha256);
    const content = [{ type: 'input_text', text: 'one' }, { type: 'input_text', text: 'two' }];
    expect(fingerprint(JSON.stringify({ input: [{ ...message(''), content }] }))[0]!.sha256)
      .not.toBe(fingerprint(JSON.stringify({ input: [{ ...message(''), content: content.reverse() }] }))[0]!.sha256);
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 16384])('preserves escape, UTF-8 and surrogate seams with %s-byte input chunks', chunkBytes => {
    const text = 'é🙂"\\/\b\f\n\r\t\ud800a\ud801';
    const literal = fingerprint(JSON.stringify({ input: [message(text)] }), { chunkBytes })[0]!;
    const escaped = fingerprint('{"input":[{"type":"message","id":"msg_original","role":"user","content":[{"type":"input_text",'
      + '"text":"\\u00e9\\ud83d\\ude42\\\"\\\\\\/\\b\\f\\n\\r\\t\\ud800a\\ud801"}]}]}', { chunkBytes })[0]!;
    expect(escaped.sha256).toBe(literal.sha256);
    expect(fingerprint(JSON.stringify({ input: [message(text.replace('\ud800', '\ud802'))] }), { chunkBytes })[0]!.sha256)
      .not.toBe(literal.sha256);
  });

  it('streams opaque records and ignored history above 16 MiB, detecting trailing tampering without a size cap', () => {
    const root = scratch(); const part = 'x'.repeat(16384); const chunks = 1025;
    const write = (name: string, tail: string) => writeWorkflowReviewArtifact({ path: join(root, name), chunks: (function* () {
      yield '{"unrelated":{"text":"'; for (let i = 0; i < chunks; i++) yield part;
      yield '"},"input":[{"type":"compaction","id":"cmp_original","encrypted_content":"';
      for (let i = 0; i < chunks; i++) yield part;
      yield tail + '"}]}';
    })() });
    write('original.json', '🙂'); write('tampered.json', '🙃');
    const read = (name: string) => {
      const file = new WorkflowReviewOwnedFile(root, name);
      try { return [...iterateWorkflowReviewNativeItems({ file, arrayKey: 'input' })][0]!; } finally { file.close(); }
    };
    const original = read('original.json'); expect(read('original.json')).toEqual(original);
    expect(read('tampered.json').sha256).not.toBe(original.sha256);
    expect(workflowReviewResourceUsage()).toMatchObject({ descriptors: 0, bufferBytes: 0 });
  });

  it('streams content arrays beyond the bounded-record size without retaining the array', () => {
    const root = scratch(); const path = join(root, 'items.json');
    writeWorkflowReviewArtifact({ path, chunks: (function* () {
      yield '{"input":[{"type":"message","role":"developer","content":[';
      for (let i = 0; i < 20000; i++) yield `${i ? ',' : ''}{"type":"input_text","text":"${i}"}`;
      yield ']}]}';
    })() });
    const file = new WorkflowReviewOwnedFile(root, 'items.json');
    try { expect([...iterateWorkflowReviewNativeItems({ file, arrayKey: 'input' })]).toHaveLength(1); } finally { file.close(); }
  });

  it.each([
    '{"input":[{"type":"compaction","type":"compaction","encrypted_content":"x"}]}',
    '{"input":[{"type":"compaction","encrypted_content":"x","unknown":"discard me"}]}',
    '{"input":[{"type":"shell_call"}]}',
    '{"input":[{"type":"constructor"}]}',
    '{"input":[{"type":"compaction","encrypted_content":null}]}',
    '{"input":[{"type":"message","role":"user","content":null}]}',
    '{"input":[{"type":"compaction","encrypted_content":"\\u12xx"}]}',
    '{"input":[{"type":"compaction","encrypted_content":"\\u123',
    '{"input":[],"input":[]}',
    '{"input":[{"type":"additional_tools","role":"developer","tools":[{"name":"a","name":"b"}]}]}',
    '{"input":[{"type":"additional_tools","role":"developer","tools":[{"__proto__":"a","__proto__":"b"}]}]}',
  ])('rejects malformed, duplicate and unsupported native structure %s', raw => {
    expect(() => fingerprint(raw)).toThrow(/workflow_review_/);
    expect(workflowReviewResourceUsage()).toMatchObject({ descriptors: 0, bufferBytes: 0 });
  });

  it('normalizes only matching public compaction turn metadata and preserves all internal fields', () => {
    const item = { type: 'compaction', id: 'cmp_original', encrypted_content: 'opaque', internal_chat_message_metadata_passthrough: { turn_id: 'turn' } };
    const native = fingerprint(JSON.stringify({ input: [item] }))[0]!;
    const publicItem = { ...item, metadata: { turn_id: 'turn' } };
    expect(fingerprint(JSON.stringify({ input: [publicItem] }), { publicCompactionMetadata: true })[0]).toEqual(native);
    expect(() => fingerprint(JSON.stringify({ input: [publicItem] }))).toThrow(/workflow_review_/);
    for (const metadata of [{ turn_id: 'foreign' }, { turn_id: 'turn', unknown: 'extra' }]) {
      expect(() => fingerprint(JSON.stringify({ input: [{ ...item, metadata }] }), { publicCompactionMetadata: true })).toThrow(/workflow_review_/);
    }
    expect(fingerprint(JSON.stringify({ input: [{ ...item, internal_chat_message_metadata_passthrough: { turn_id: 'foreign' } }] }))[0]!.sha256)
      .not.toBe(native.sha256);
  });

  it('retains ordinary creation time while exposing a separate context reconstruction digest', () => {
    const original = { ...message('context'), internal_chat_message_metadata_passthrough: { turn_id: 'turn', create_time: 123.25, content_item_kinds: ['environments.environment_context'] } };
    const { id: _id, ...injected } = original; const { create_time: _time, ...metadata } = original.internal_chat_message_metadata_passthrough;
    const before = fingerprint(JSON.stringify({ input: [original] }))[0]!;
    const after = fingerprint(JSON.stringify({ input: [{ ...injected, internal_chat_message_metadata_passthrough: metadata }] }))[0]!;
    expect(after.sha256).not.toBe(before.sha256); expect(after.contextSha256).toBe(before.contextSha256);
    expect(after.metadata).toMatchObject({ createTime: false, turnId: 'turn' });
  });

  it('holds custody during yielded item iteration and refuses later same-size mutation', () => {
    const root = scratch(); mkdirSync(join(root, 'held')); const path = join(root, 'held', 'items.json');
    const raw = JSON.stringify({ input: [message('first'), message('second', 'msg_second')] }); writeFileSync(path, raw);
    const file = new WorkflowReviewOwnedFile(join(root, 'held'), 'items.json'); const items = iterateWorkflowReviewNativeItems({ file, arrayKey: 'input', chunkBytes: 1 });
    try {
      expect(items.next().value).toMatchObject({ id: 'msg_original' }); writeFileSync(path, raw.replace('second', 'alterd'));
      expect(() => items.next()).toThrow('workflow_review_evidence_custody');
    } finally { items.return(undefined); file.close(); }
  });
});
