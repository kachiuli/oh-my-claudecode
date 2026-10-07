import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createWorkflowNativeModelEventParser, createWorkflowNativeSseParser, type WorkflowNativeModelEventReceipt } from '../workflow-native-model-events.js';
import { iterateWorkflowReviewNativeItems, WorkflowReviewOwnedFile } from '../workflow-review-source.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const secret = 'PRIVATE_HEADER_SENTINEL_DO_NOT_ARCHIVE';
const metadata = { turn_id: 'turn-native' };
const item = { type: 'compaction', id: 'cmp_native', encrypted_content: '界🙂"\\\n', metadata,
  internal_chat_message_metadata_passthrough: metadata };
const completed = (output: unknown[]) => ({ response: { headers: { authorization: secret }, status: 'completed', id: 'resp_native', output },
  headers: { authorization: secret }, type: 'response.completed' });
function read(raw: unknown, chunkBytes = 65536, sse = false): WorkflowNativeModelEventReceipt[] {
  const receipts: WorkflowNativeModelEventReceipt[] = [];
  const parser = (sse ? createWorkflowNativeSseParser : createWorkflowNativeModelEventParser)({ emit(receipt) { receipts.push(receipt); } });
  const bytes = Buffer.from(typeof raw === 'string' ? raw : JSON.stringify(raw));
  for (let offset = 0; offset < bytes.length; offset += chunkBytes) parser.feed(bytes.subarray(offset, offset + chunkBytes));
  parser.finish(); expect(JSON.stringify(receipts)).not.toContain(secret); return receipts;
}
function diskDigest(value: unknown): string {
  const root = mkdtempSync(join(tmpdir(), 'omc-native-receipt-')); roots.push(root); writeFileSync(join(root, 'items.json'), JSON.stringify({ output: [value] }));
  const file = new WorkflowReviewOwnedFile(root, 'items.json');
  try { return [...iterateWorkflowReviewNativeItems({ file, arrayKey: 'output', publicCompactionMetadata: true })][0]!.sha256; } finally { file.close(); }
}
const fold = (digest: string) => createHash('sha256').update('array\n').update(digest + '\n').digest('hex');

describe('native privacy-selected model event receipts', () => {
  it('retains an explicit-empty terminal output as an empty receipt rather than omitted data', () => {
    expect(read(completed([]), 1)[0]!.output).toEqual({ count: '0', mask: 0,
      sha256: createHash('sha256').update('array\n').digest('hex') });
  });
  it.each(['absent', 'null', 'object', 'wrong-status', 'missing-id'])(
    'refuses %s terminal output/status despite supporting an explicit-empty array', fault => {
      const event = completed([]);
      if (fault === 'absent') Reflect.deleteProperty(event.response, 'output');
      if (fault === 'null') Object.assign(event.response, { output: null });
      if (fault === 'object') Object.assign(event.response, { output: {} });
      if (fault === 'wrong-status') event.response.status = 'incomplete';
      if (fault === 'missing-id') Reflect.deleteProperty(event.response, 'id');
      expect(() => read(event, 1)).toThrow(/MODEL_EVENT_/);
    });
  it('normalizes only source-backed missing reasoning encryption to the native null field', () => {
    const native = { type: 'reasoning', id: 'rs_native', summary: [], encrypted_content: null };
    const incoming = { type: 'reasoning', id: 'rs_native', summary: [] };
    expect(read({ type: 'response.output_item.done', item: incoming }, 1)[0]!.item?.sha256).toBe(diskDigest(native));
    expect(diskDigest(incoming)).toBe(diskDigest(native));
    expect(read({ type: 'response.output_item.done', item: { ...incoming, encrypted_content: 'opaque' } })[0]!.item?.sha256).not.toBe(diskDigest(native));
    expect(() => read({ type: 'response.output_item.done', item: { ...incoming, unknown: 'ignored' } })).toThrow('MODEL_EVENT_ITEM_SCHEMA');
  });
  it.each([1, 3, 7, 16384, 65536])('matches held typed items across %s-byte Unicode/escape seams while discarding late headers', chunkBytes => {
    const expected = diskDigest(item);
    const done = read({ item, type: 'response.output_item.done', headers: { cookie: secret } }, chunkBytes)[0]!;
    expect(done.item).toMatchObject({ type: 'compaction', id: 'cmp_native', sha256: expected });
    const complete = read(completed([item]), chunkBytes)[0]!;
    expect(complete.output).toMatchObject({ sha256: fold(expected), count: '1' });
    const escaped = JSON.stringify(completed([item])).replace('🙂', '\\ud83d\\ude42');
    expect(read(escaped, chunkBytes)[0]!.output).toEqual(complete.output);
  });
  it('emits nothing before exact event EOF and refuses late nonnull errors', () => {
    const receipts: WorkflowNativeModelEventReceipt[] = []; const parser = createWorkflowNativeModelEventParser({ emit(value) { receipts.push(value); } });
    parser.feed(Buffer.from(JSON.stringify({ ...completed([item]), error: { body: secret, headers: { authorization: secret } } })));
    expect(receipts).toEqual([]); expect(() => parser.finish()).toThrow('MODEL_EVENT_ERROR_BRANCH_REFUSED'); expect(receipts).toEqual([]);
    expect(read({ ...completed([item]), error: null })[0]!.output?.count).toBe('1');
  });
  it('keeps legitimate header-looking model text exact while omitting response headers', () => {
    const text = 'headers: {Authorization: "fake credential"} response.headers';
    const message = { type: 'message', role: 'assistant', id: 'msg_native', phase: 'final_answer',
      internal_chat_message_metadata_passthrough: metadata, content: [{ type: 'output_text', text }] };
    const incoming = { ...message, status: 'completed', metadata, content: [{ ...message.content[0]!, annotations: [], logprobs: [] }] };
    expect(read({ item: incoming, type: 'response.output_item.done' }, 13)[0]!.item?.sha256).toBe(diskDigest(message));
  });
  it('gives ignored controls no item/output proof and validates common native fields', () => {
    expect(read({ type: 'private.unhandled.event', headers: { authorization: secret }, item_id: null, call_id: null, text: null,
      delta: 'discarded', summary_index: null, content_index: null }, 1)).toEqual([{ kind: 'native-ignored-event-discarded' }]);
    expect(read({ type: 'response.metadata', headers: { authorization: secret } }, 1)).toEqual([{ kind: 'metadata-discarded', controlType: 'response.metadata' }]);
    for (const key of ['item_id', 'call_id', 'delta', 'text']) for (const value of [42, {}, []]) {
      expect(() => read({ type: 'private.unhandled.event', [key]: value })).toThrow(/MODEL_EVENT_/);
    }
    for (const value of ['9223372036854775808', '-9223372036854775809', '1.0', '1e0', 'true']) {
      expect(() => read('{"type":"private.unhandled.event","summary_index":' + value + '}')).toThrow(/MODEL_EVENT_/);
    }
    for (const type of ['error', 'response.failed', 'response.incomplete', 'response.custom_tool_call_input.delta']) {
      expect(() => read({ type, error: null, delta: 'discarded' })).toThrow('MODEL_EVENT_UNSUPPORTED_NATIVE_CONSUMED');
    }
  });
  it('streams one opaque item above 16 MiB and an output list without retaining either', () => {
    const receipts: WorkflowNativeModelEventReceipt[] = []; const parser = createWorkflowNativeModelEventParser({ emit(value) { receipts.push(value); } });
    parser.feed(Buffer.from('{"response":{"status":"completed","id":"resp_large","output":[{"type":"compaction","encrypted_content":"'));
    const part = 'x'.repeat(32768); const hash = createHash('sha256').update('string\n'); let units = 0n;
    for (let i = 0; i < 513; i++) { parser.feed(Buffer.from(part)); hash.update(Buffer.from(part, 'utf16le')); units += BigInt(part.length); }
    parser.feed(Buffer.from('"}]},"headers":{"authorization":"' + secret + '"},"type":"response.completed"}'));
    expect(receipts).toEqual([]); parser.finish(); hash.update('\n' + units);
    const fields = { type: createHash('sha256').update(JSON.stringify('compaction')).digest('hex'), encrypted_content: hash.digest('hex') };
    const native = createHash('sha256').update('object\n'); for (const key of Object.keys(fields).sort()) native.update(JSON.stringify([key, fields[key as keyof typeof fields]]) + '\n');
    expect(receipts[0]!.output).toMatchObject({ sha256: fold(native.digest('hex')), count: '1' });
    const many: WorkflowNativeModelEventReceipt[] = []; const list = createWorkflowNativeModelEventParser({ emit(value) { many.push(value); } });
    list.feed(Buffer.from('{"response":{"status":"completed","id":"resp_many","output":['));
    const expected = createHash('sha256').update('array\n'); const digest = diskDigest(item);
    for (let i = 0; i < 10000; i++) { list.feed(Buffer.from((i ? ',' : '') + JSON.stringify(item))); expected.update(digest + '\n'); }
    list.feed(Buffer.from(']},"type":"response.completed"}')); list.finish();
    expect(many).toHaveLength(1); expect(many[0]!.output).toMatchObject({ count: '10000', sha256: expected.digest('hex') });
  });
  it('checks finite native usage without giving accounting fields model authority', () => {
    const counters = { input_tokens: 1, cached_tokens: 0, cache_write_tokens: 0, output_tokens: 1 };
    const usage = { input_tokens: 3, output_tokens: 2, total_tokens: 5, input_tokens_details: { cached_tokens: 1 }, output_tokens_details: { reasoning_tokens: 0 },
      codex_rollout_budget_units: null, attribution: { items: { fco_native: { ...counters, content: [counters] } }, request_fields: { 'text.format': counters } } };
    const event = { ...completed([item]), response: { ...completed([item]).response, usage, end_turn: null, usage_metadata: { amount: '0.001', metadata: null } } };
    expect(read(event, 1)[0]!.output?.sha256).toBe(fold(diskDigest(item)));
    for (const patch of [{ input_tokens: null }, { output_tokens: '2' }, { headers: { authorization: secret } }]) {
      expect(() => read({ ...event, response: { ...event.response, usage: { ...usage, ...patch } } })).toThrow(/MODEL_EVENT_/);
    }
    expect(() => read({ ...event, response: { ...event.response, usage_metadata: { metadata: { headers: { authorization: secret } } } } })).toThrow(/MODEL_EVENT_/);
  });
  it('handles SSE CRLF/multiline boundaries and refuses missing or mismatched terminal events', () => {
    const json = JSON.stringify(completed([item])); const split = json.indexOf(',"headers"');
    const sse = 'event: response.completed\r\ndata: ' + json.slice(0, split) + '\r\ndata: ' + json.slice(split) + '\r\n\r\n';
    expect(read(sse, 1, true)[0]!.output?.sha256).toBe(fold(diskDigest(item)));
    expect(() => read('event: response.created\ndata: ' + json + '\n\n', 3, true)).toThrow('MODEL_EVENT_SSE_TYPE_MISMATCH');
    expect(() => read('data: ' + json + '\n', 7, true)).toThrow('SSE_INCOMPLETE_EVENT_EOF');
    expect(() => read('{"type":"response.completed","type":"response.completed"}')).toThrow('MODEL_EVENT_DUPLICATE_FIELD');
    for (const invalid of ['\\ud800', '\\udc00', '\\ud800x']) {
      expect(() => read('{"headers":{"hidden":"' + invalid + '"},"type":"response.metadata"}', 1)).toThrow('MODEL_EVENT_JSON_SURROGATE');
    }
  });
});
