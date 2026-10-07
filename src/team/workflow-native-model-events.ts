import { createHash } from 'node:crypto';

/** EOF-selected native model receipts. Incoming body/header/control data is never archived. */

interface ParsedValue {
  sha256?: string; value?: string; null?: boolean; nonnull?: boolean; mask?: number; count?: string;
  type?: string; id?: string; turnId?: string; status?: string; responseId?: string; itemId?: string;
  item?: ParsedValue; response?: ParsedValue; output?: ParsedValue; nonNullError?: boolean;
  nativeString?: boolean; nativeIndex?: boolean; nativeControlArray?: boolean; nativeUsageControl?: boolean;
  nativeUInt?: boolean; nativeFloat?: boolean; nativeBool?: boolean; nativeBudget?: boolean; nativeNumber?: boolean; nativeNull?: boolean;
}
interface ParseFrame {
  kind: 'object' | 'array'; mode: string; state: string; key: string | null; fieldMode?: string;
  fields: Record<string, ParsedValue>; seen: Set<string>; invalid: boolean; count: bigint; mask: number;
  hash: import('node:crypto').Hash | null; errorSentinel?: boolean; nonNullError?: boolean;
}
interface StringLex {
  kind: 'string' | 'key'; mode: string; value: string; piece: string; units: bigint;
  hash: import('node:crypto').Hash | null; escape: boolean; unicode: string | null; highSurrogate?: string;
}
interface ScalarLex { kind: 'scalar'; mode: string; raw: string }
export interface WorkflowNativeModelEventReceipt {
  kind: 'model-event' | 'metadata-discarded' | 'native-ignored-event-discarded';
  eventType?: string; controlType?: string; responseId?: string;
  item?: { type: string; id?: string; sha256: string };
  output?: { sha256: string; count: string; mask: number };
}
export interface WorkflowNativeModelEventParser { feed(bytes: Buffer): void; finish(): void; abort(): void }

function fail(code = 'MODEL_EVENT_SCHEMA_REFUSED'): never { throw Object.assign(new Error(code), { code }); }
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const objectDigest = (fields: Record<string, ParsedValue>) => {
  const hash = createHash('sha256').update('object\n');
  for (const key of Object.keys(fields).sort()) hash.update(JSON.stringify([key, fields[key].sha256]) + '\n');
  return hash.digest('hex');
};
const ITEM_FIELDS = new Set(['type', 'id', 'role', 'phase', 'name', 'namespace', 'call_id', 'arguments', 'output', 'encrypted_content', 'content', 'summary', 'internal_chat_message_metadata_passthrough', 'metadata', 'status']);
const METADATA_TYPES = new Set(['codex.response.metadata', 'codex.rate_limits', 'response.metadata', 'responsesapi.websocket_timing', 'response.compaction.compacting', 'keepalive']);
const UNSUPPORTED_CONSUMED_TYPES = new Set(['error', 'response.failed', 'response.incomplete', 'response.custom_tool_call_input.delta']);
const HASH_ARRAY_MODES = new Set(['items', 'texts', 'controls']);
const ARRAY_MODES = new Set([...HASH_ARRAY_MODES, 'attribution-content']);
const NULLABLE_OBJECT_MODES = new Set(['usage', 'usage-input', 'usage-output', 'usage-metadata']);
const OBJECT_MODES = new Set(['event', 'response', 'item', 'text', 'metadata', 'public-metadata', ...NULLABLE_OBJECT_MODES, 'attribution', 'attribution-items', 'attribution-counters', 'attribution-request-fields']);
const ATTRIBUTION_COUNTERS = ['input_tokens', 'cached_tokens', 'cache_write_tokens', 'output_tokens'];
export const WORKFLOW_NATIVE_MODEL_EVENT_TYPES: readonly string[] = Object.freeze(['response.created', 'response.in_progress', 'response.output_item.added', 'response.output_item.done', 'response.content_part.added', 'response.content_part.done', 'response.output_text.delta', 'response.output_text.done', 'response.function_call_arguments.delta', 'response.function_call_arguments.done', 'response.reasoning_summary_part.added', 'response.reasoning_summary_part.done', 'response.reasoning_summary_text.delta', 'response.reasoning_summary_text.done', 'response.reasoning_text.delta', 'response.reasoning_text.done', 'response.completed']);
const EVENT_TYPES = new Set(WORKFLOW_NATIVE_MODEL_EVENT_TYPES);
const SCHEMAS: Record<string, { required: readonly string[]; optional: readonly string[] }> = {
  message: { required: ['role', 'content'], optional: ['id', 'phase', 'internal_chat_message_metadata_passthrough'] },
  reasoning: { required: ['summary', 'encrypted_content'], optional: ['id', 'content', 'internal_chat_message_metadata_passthrough'] },
  function_call: { required: ['name', 'arguments', 'call_id'], optional: ['id', 'namespace', 'internal_chat_message_metadata_passthrough'] },
  function_call_output: { required: ['call_id', 'output'], optional: ['id', 'name', 'namespace', 'internal_chat_message_metadata_passthrough'] },
  compaction: { required: ['encrypted_content'], optional: ['id', 'internal_chat_message_metadata_passthrough'] },
};
const modeFor = (parent: ParseFrame | undefined, key = ''): string => {
  if (!parent || parent.mode === 'skip') return 'skip';
  if (parent.kind === 'array') return parent.mode === 'items' ? 'item' : parent.mode === 'texts' ? 'text' : parent.mode === 'controls' ? 'control' : parent.mode === 'attribution-content' ? 'attribution-counters' : 'skip';
  switch (parent.mode) {
    case 'event': return key === 'error' ? 'skip-error' : key === 'type' ? 'enum-control' : key === 'item' ? 'item' : key === 'response' ? 'response' : key === 'response_id' ? 'control' : ['item_id', 'call_id', 'delta', 'text'].includes(key) ? 'native-string' : ['summary_index', 'content_index'].includes(key) ? 'native-index' : 'skip';
    case 'response': return key === 'error' ? 'skip-error' : key === 'output' ? 'items' : key === 'usage' ? 'usage' : key === 'usage_metadata' ? 'usage-metadata' : key === 'end_turn' ? 'native-bool' : ['id', 'status'].includes(key) ? 'control' : 'skip';
    case 'item':
      if (!ITEM_FIELDS.has(key)) { parent.invalid = true; return 'skip'; }
      if (['arguments', 'output', 'encrypted_content'].includes(key)) return 'text-string';
      if (['content', 'summary'].includes(key)) return 'texts';
      if (key === 'internal_chat_message_metadata_passthrough') return 'metadata';
      if (key === 'metadata') return 'public-metadata';
      if (key === 'status') return 'ignored-status';
      return 'control';
    case 'text': return key === 'text' ? 'text-string' : key === 'type' ? 'control' : ['annotations', 'logprobs'].includes(key) ? 'skip' : (parent.invalid = true, 'skip');
    case 'metadata': return key === 'turn_id' ? 'control' : key === 'create_time' ? 'number' : key === 'content_item_kinds' ? 'controls' : (parent.invalid = true, 'skip');
    case 'public-metadata': return key === 'turn_id' ? 'control' : (parent.invalid = true, 'skip');
    case 'usage': return ['input_tokens', 'output_tokens', 'total_tokens'].includes(key) ? 'native-required-index' : key === 'input_tokens_details' ? 'usage-input' : key === 'output_tokens_details' ? 'usage-output' : key === 'codex_rollout_budget_units' ? 'native-number' : key === 'attribution' ? 'attribution' : (parent.invalid = true, 'skip');
    case 'usage-input': return ['cached_tokens', 'cache_write_tokens'].includes(key) ? 'native-required-index' : (parent.invalid = true, 'skip');
    case 'usage-output': return key === 'reasoning_tokens' ? 'native-required-index' : (parent.invalid = true, 'skip');
    case 'usage-metadata': return key === 'amount' ? 'native-string' : key === 'metadata' ? 'null-only' : (parent.invalid = true, 'skip');
    case 'attribution': return key === 'items' ? 'attribution-items' : key === 'request_fields' ? 'attribution-request-fields' : (parent.invalid = true, 'skip');
    case 'attribution-items': return /^(?:at|fc|msg|cmp|fco|rs)_[A-Za-z0-9-]{1,240}$/.test(key) ? 'attribution-counters' : (parent.invalid = true, 'skip');
    case 'attribution-counters': return ATTRIBUTION_COUNTERS.includes(key) ? 'native-required-index' : key === 'content' ? 'attribution-content' : (parent.invalid = true, 'skip');
    case 'attribution-request-fields': return key === 'text.format' ? 'attribution-counters' : (parent.invalid = true, 'skip');
    default: return 'skip';
  }
};

export function createWorkflowNativeModelEventParser({ emit, hintedType = null }: { emit(receipt: WorkflowNativeModelEventReceipt): void; hintedType?: string | null }): WorkflowNativeModelEventParser {
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const frames: ParseFrame[] = []; let root: ParsedValue | null = null; let lex: StringLex | ScalarLex | null = null; let complete = false, aborted = false;
  const top = () => frames.at(-1);
  function add(value: ParsedValue): void {
    const parent = top();
    if (!parent) { if (root) fail('MODEL_EVENT_MULTIPLE_ROOTS'); root = value; complete = true; return; }
    if (parent.kind === 'array') {
      if (HASH_ARRAY_MODES.has(parent.mode)) { parent.hash!.update(value.sha256 + '\n'); parent.count++; parent.mask |= value.mask ?? 0; }
      parent.state = 'comma';
    } else {
      if (parent.fieldMode === 'skip-error') parent.nonNullError ||= value.nonnull;
      else if (parent.mode !== 'skip' && parent.mode !== 'attribution-items' && parent.fieldMode !== 'skip') parent.fields[parent.key!] = value;
      parent.state = 'comma'; parent.key = null;
    }
  }
  function appendStringUnit(char: string): void {
    if (!lex || lex.kind === 'scalar') fail();
    if (lex.kind === 'key' || ['control', 'enum-control', 'ignored-status'].includes(lex.mode)) {
      if (lex.value.length >= 512) fail('MODEL_EVENT_CONTROL_LIMIT'); lex.value += char;
    } else if (lex.mode === 'text-string') {
      lex.piece += char; lex.units++;
      if (lex.piece.length >= 16384) { lex.hash!.update(Buffer.from(lex.piece, 'utf16le')); lex.piece = ''; }
    }
  }
  function stringUnit(char: string): void {
    if (!lex || lex.kind === 'scalar') fail();
    const unit = char.charCodeAt(0);
    if (lex.highSurrogate) { if (unit < 0xDC00 || unit > 0xDFFF) fail('MODEL_EVENT_JSON_SURROGATE'); appendStringUnit(lex.highSurrogate); appendStringUnit(char); lex.highSurrogate = ''; return; }
    if (unit >= 0xD800 && unit <= 0xDBFF) { lex.highSurrogate = char; return; }
    if (unit >= 0xDC00 && unit <= 0xDFFF) fail('MODEL_EVENT_JSON_SURROGATE'); appendStringUnit(char);
  }
  function endString(): void {
    if (!lex || lex.kind === 'scalar') fail();
    if (lex.highSurrogate) fail('MODEL_EVENT_JSON_SURROGATE');
    const token = lex; lex = null;
    if (token.kind === 'key') {
      const frame = top()!; frame.key = token.value; frame.fieldMode = modeFor(frame, token.value);
      if (frame.mode !== 'skip' && frame.mode !== 'attribution-items') { if (frame.seen.has(token.value)) fail('MODEL_EVENT_DUPLICATE_FIELD'); if (frame.seen.size >= 64) fail('MODEL_EVENT_CONTROL_LIMIT'); frame.seen.add(token.value); }
      frame.state = 'colon'; return;
    }
    let value: ParsedValue = { sha256: '' };
    if (token.mode === 'text-string') { token.hash!.update(Buffer.from(token.piece, 'utf16le')); token.hash!.update('\n' + token.units); value = { sha256: token.hash!.digest('hex') }; }
    else if (token.mode === 'control') value = { value: token.value, sha256: digest(token.value) };
    else if (['enum-control', 'ignored-status'].includes(token.mode)) value = { value: token.value };
    else if (token.mode === 'native-string') value = { nativeString: true };
    else if (token.mode === 'skip-error') value = { nonnull: true };
    else if (token.mode !== 'skip') fail('MODEL_EVENT_VALUE_TYPE');
    add(value);
  }
  function endScalar(): void {
    if (!lex || lex.kind !== 'scalar') fail();
    const token = lex; lex = null; let value;
    try { value = JSON.parse(token.raw); } catch { fail('MODEL_EVENT_JSON_SCALAR'); }
    if (typeof value === 'number' && !Number.isFinite(value)) fail('MODEL_EVENT_JSON_SCALAR');
    if (token.mode === 'number' && typeof value !== 'number') fail('MODEL_EVENT_VALUE_TYPE');
    if (token.mode === 'native-index' || token.mode === 'native-required-index') { if (value === null ? token.mode === 'native-required-index' : !/^-?(?:0|[1-9][0-9]*)$/.test(token.raw) || BigInt(token.raw) < -(1n << 63n) || BigInt(token.raw) > (1n << 63n) - 1n) fail('MODEL_EVENT_NATIVE_INDEX_TYPE'); add({ nativeIndex: true }); return; }
    if (token.mode === 'native-string') { if (value !== null) fail('MODEL_EVENT_NATIVE_STRING_TYPE'); add({ nativeString: true }); return; }
    if (token.mode === 'native-bool') { if (value !== null && typeof value !== 'boolean') fail('MODEL_EVENT_NATIVE_BOOL_TYPE'); add({ nativeBool: true }); return; }
    if (token.mode === 'native-number') { if (value !== null && typeof value !== 'number') fail('MODEL_EVENT_NATIVE_NUMBER_TYPE'); add({ nativeNumber: true }); return; }
    if (NULLABLE_OBJECT_MODES.has(token.mode) || token.mode === 'null-only') { if (value !== null) fail('MODEL_EVENT_NATIVE_NULL_TYPE'); add({ nativeNull: true }); return; }
    if (token.mode !== 'skip' && token.mode !== 'skip-error' && token.mode !== 'number' && !(value === null && ['text-string', 'texts', 'control'].includes(token.mode))) fail('MODEL_EVENT_VALUE_TYPE');
    add(token.mode === 'skip-error' ? { nonnull: value !== null } : { sha256: token.mode === 'skip' ? '' : digest(value), null: value === null });
  }
  function endFrame(): void {
    const frame = frames.pop()!; let value: ParsedValue = { sha256: '' };
    if (frame.mode === 'skip') { add(frame.errorSentinel ? { nonnull: true } : value); return; }
    if (frame.kind === 'array') { value = HASH_ARRAY_MODES.has(frame.mode) ? { sha256: frame.hash!.digest('hex'), count: frame.count.toString(), mask: frame.mask } : { nativeControlArray: true }; add(value); return; }
    const fields = frame.fields;
    if (frame.invalid) fail('MODEL_EVENT_ITEM_SCHEMA');
    if (frame.mode === 'text') {
      const index = ['input_text', 'output_text', 'summary_text', 'reasoning_text'].indexOf(fields.type?.value ?? '');
      if (index < 0 || !fields.text) fail('MODEL_EVENT_ITEM_SCHEMA'); value = { sha256: objectDigest(fields), mask: 1 << index };
    } else if (frame.mode === 'metadata' || frame.mode === 'public-metadata') {
      if (frame.mode === 'public-metadata' && (!fields.turn_id || frame.seen.size !== 1)) fail('MODEL_EVENT_PUBLIC_METADATA');
      value = { sha256: objectDigest(fields), turnId: fields.turn_id?.value };
    } else if (frame.mode === 'item') {
      const type = fields.type?.value;
      if (typeof type !== 'string') fail('MODEL_EVENT_ITEM_SCHEMA');
      // The pinned native Reasoning Option<String> serializes absent encrypted content as null.
      if (type === 'reasoning' && !fields.encrypted_content) fields.encrypted_content = { sha256: digest(null), null: true };
      const schema = Object.hasOwn(SCHEMAS, type) ? SCHEMAS[type] : undefined;
      if (!schema || schema.required.some((key) => !fields[key])) fail('MODEL_EVENT_ITEM_SCHEMA');
      const { metadata, status, ...native } = fields;
      if (Object.keys(native).some((key) => key !== 'type' && !schema.required.includes(key) && !schema.optional.includes(key))) fail('MODEL_EVENT_ITEM_SCHEMA');
      if (metadata && metadata.turnId !== native.internal_chat_message_metadata_passthrough?.turnId) fail('MODEL_EVENT_PUBLIC_METADATA');
      if (status && !['in_progress', 'completed', 'incomplete'].includes(status.value ?? '')) fail('MODEL_EVENT_ITEM_STATUS');
      if (type === 'message' && (native.content.null || !['developer', 'user', 'assistant', 'system'].includes(native.role.value ?? '') || ((native.content.mask ?? 0) & ~3))) fail('MODEL_EVENT_ITEM_SCHEMA');
      if (type === 'message' && native.phase && !['commentary', 'final_answer'].includes(native.phase.value ?? '')) fail('MODEL_EVENT_ITEM_SCHEMA');
      if (type === 'reasoning' && (((native.summary.mask ?? 0) & ~4) || ((native.content?.mask ?? 0) & ~8))) fail('MODEL_EVENT_ITEM_SCHEMA');
      if (type === 'compaction' && native.encrypted_content.null) fail('MODEL_EVENT_ITEM_SCHEMA');
      const id = native.id?.value; const prefix = ({ message: 'msg', reasoning: 'rs', function_call: 'fc', function_call_output: 'fco', compaction: 'cmp' } as Record<string, string>)[type];
      if (id !== undefined && !new RegExp('^' + prefix + '_[A-Za-z0-9-]{1,240}$').test(id)) fail('MODEL_EVENT_ITEM_ID');
      value = { sha256: objectDigest(native), type, id };
    } else if (['usage', 'usage-input', 'usage-output', 'usage-metadata', 'attribution', 'attribution-items', 'attribution-counters', 'attribution-request-fields'].includes(frame.mode)) {
      const required = frame.mode === 'usage' ? ['input_tokens', 'output_tokens', 'total_tokens'] : frame.mode === 'usage-input' ? ['cached_tokens'] : frame.mode === 'usage-output' ? ['reasoning_tokens'] : frame.mode === 'attribution' ? ['items'] : frame.mode === 'attribution-counters' ? ATTRIBUTION_COUNTERS : [];
      if (required.some((key) => !fields[key])) fail('MODEL_EVENT_USAGE_REQUIRED_FIELD'); value = { nativeUsageControl: true };
    } else if (frame.mode === 'response') value = { id: fields.id?.value, status: fields.status?.value, output: fields.output, nonNullError: !!frame.nonNullError };
    else if (frame.mode === 'event') value = { type: fields.type?.value, item: fields.item, response: fields.response, responseId: fields.response_id?.value, itemId: fields.item_id?.value, nonNullError: !!frame.nonNullError };
    else fail('MODEL_EVENT_CONTAINER_TYPE');
    add(value);
  }
  function valueStart(char: string, mode: string): void {
    if (frames.length >= 128) fail('MODEL_EVENT_DEPTH_CONTROL_LIMIT');
    if (char === '{' || char === '[') {
      const kind = char === '{' ? 'object' : 'array';
      const errorSentinel = mode === 'skip-error'; if (errorSentinel) mode = 'skip';
      if (mode !== 'skip' && !(kind === 'array' ? ARRAY_MODES.has(mode) : OBJECT_MODES.has(mode))) fail('MODEL_EVENT_VALUE_TYPE');
      frames.push({ kind, mode, errorSentinel, state: kind === 'object' ? 'key-or-end' : 'value-or-end', key: null, fields: Object.create(null), seen: new Set(), invalid: false, count: 0n, mask: 0, hash: kind === 'array' && HASH_ARRAY_MODES.has(mode) ? createHash('sha256').update('array\n') : null }); return;
    }
    if (char === '"') { lex = { kind: 'string', mode, value: '', piece: '', units: 0n, hash: mode === 'text-string' ? createHash('sha256').update('string\n') : null, escape: false, unicode: null }; return; }
    if (!/[\-0-9tfn]/.test(char)) fail('MODEL_EVENT_JSON_SYNTAX');
    lex = { kind: 'scalar', mode, raw: char };
  }
  function text(input: string): void {
    for (let index = 0; index < input.length; index++) {
      const char = input[index];
      if (lex?.kind === 'string' || lex?.kind === 'key') {
        if (lex.unicode !== null) { if (!/[0-9a-fA-F]/.test(char)) fail('MODEL_EVENT_JSON_ESCAPE'); lex.unicode += char; if (lex.unicode.length === 4) { stringUnit(String.fromCharCode(parseInt(lex.unicode, 16))); lex.unicode = null; } continue; }
        if (lex.escape) { lex.escape = false; if (char === 'u') lex.unicode = ''; else { const map: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }; if (!Object.hasOwn(map, char)) fail('MODEL_EVENT_JSON_ESCAPE'); stringUnit(map[char]); } continue; }
        if (char === '\\') { lex.escape = true; continue; }
        if (char === '"') { endString(); continue; }
        if (char.charCodeAt(0) < 32) fail('MODEL_EVENT_JSON_STRING'); stringUnit(char); continue;
      }
      if (lex?.kind === 'scalar') {
        if (/[\x20\t\r\n,}\]]/.test(char)) { endScalar(); index--; continue; }
        if (lex.raw.length >= 512) fail('MODEL_EVENT_CONTROL_LIMIT'); lex.raw += char; continue;
      }
      if (/[\x20\t\r\n]/.test(char)) continue;
      const frame = top();
      if (!frame) { if (complete) fail('MODEL_EVENT_TRAILING_DATA'); valueStart(char, 'event'); continue; }
      if (frame.state === 'key-or-end' || frame.state === 'key') {
        if (char === '}' && frame.state === 'key-or-end') { endFrame(); continue; }
        if (char !== '"') fail('MODEL_EVENT_JSON_KEY'); lex = { kind: 'key', mode: 'control', value: '', piece: '', units: 0n, hash: null, escape: false, unicode: null }; continue;
      }
      if (frame.state === 'colon') { if (char !== ':') fail('MODEL_EVENT_JSON_COLON'); frame.state = 'value'; continue; }
      if (frame.state === 'comma') {
        if (char === (frame.kind === 'array' ? ']' : '}')) { endFrame(); continue; }
        if (char !== ',') fail('MODEL_EVENT_JSON_COMMA'); frame.state = frame.kind === 'array' ? 'value' : 'key'; continue;
      }
      if (frame.state === 'value-or-end' && char === ']') { endFrame(); continue; }
      valueStart(char, frame.kind === 'array' ? modeFor(frame) : frame.fieldMode ?? 'skip');
    }
  }
  return {
    feed(bytes: Buffer) { if (aborted) fail('MODEL_EVENT_ABORTED'); if (bytes.length > 65536) fail('MODEL_EVENT_WORKING_CHUNK_LIMIT'); for (let offset = 0; offset < bytes.length; offset += 16384) text(decoder.decode(bytes.subarray(offset, offset + 16384), { stream: true })); },
    finish() {
      text(decoder.decode()); if (lex?.kind === 'scalar') endScalar();
      if (lex || frames.length || !complete || !root) fail('MODEL_EVENT_INCOMPLETE_JSON');
      if (hintedType && hintedType !== root.type) fail('MODEL_EVENT_SSE_TYPE_MISMATCH');
      if (root.nonNullError || root.response?.nonNullError) fail('MODEL_EVENT_ERROR_BRANCH_REFUSED');
      if (typeof root.type !== 'string') fail('MODEL_EVENT_NATIVE_TYPE_REQUIRED');
      if (METADATA_TYPES.has(root.type)) { emit({ kind: 'metadata-discarded', controlType: root.type }); return; }
      if (UNSUPPORTED_CONSUMED_TYPES.has(root.type)) fail('MODEL_EVENT_UNSUPPORTED_NATIVE_CONSUMED');
      if (!EVENT_TYPES.has(root.type)) { emit({ kind: 'native-ignored-event-discarded' }); return; }
      const receipt: WorkflowNativeModelEventReceipt = { kind: 'model-event', eventType: root.type };
      const id = root.response?.id ?? root.responseId;
      if (id !== undefined) { if (!/^resp_[A-Za-z0-9-]{1,240}$/.test(id)) fail('MODEL_EVENT_RESPONSE_ID'); receipt.responseId = id; }
      if (root.type === 'response.output_item.done') { if (!root.item) fail('MODEL_EVENT_REQUIRED_ITEM'); receipt.item = { type: root.item.type!, id: root.item.id, sha256: root.item.sha256! }; }
      if (root.type === 'response.completed') { if (root.response?.status !== 'completed' || !root.response.output || !id) fail('MODEL_EVENT_COMPLETED_SCHEMA'); receipt.output = { sha256: root.response.output.sha256!, count: root.response.output.count!, mask: root.response.output.mask ?? 0 }; }
      emit(receipt);
    },
    abort() { aborted = true; frames.length = 0; root = null; lex = null; },
  };
}

export function createWorkflowNativeSseParser({ emit }: { emit(receipt: WorkflowNativeModelEventReceipt): void }): WorkflowNativeModelEventParser {
  let prefix = '', mode = 'prefix'; let eventName: string | null = null; let parser: WorkflowNativeModelEventParser | null = null; let sawData = false, afterCR = false;
  const data = (bytes: Buffer) => { if (!parser) parser = createWorkflowNativeModelEventParser({ emit, hintedType: eventName }); parser.feed(bytes); sawData = true; };
  function newline() {
    if (mode === 'prefix' && prefix === '') { if (parser) parser.finish(); parser = null; eventName = null; sawData = false; }
    else if (mode === 'event') eventName = prefix.replace(/^\x20/, '');
    prefix = ''; mode = 'prefix';
  }
  return {
    feed(bytes) {
      for (let offset = 0; offset < bytes.length;) {
        const byte = bytes[offset]; if (afterCR) { afterCR = false; if (byte === 10) { offset++; continue; } }
        if (byte === 10 || byte === 13) { newline(); afterCR = byte === 13; offset++; continue; }
        if (mode === 'data') { let end = offset; while (end < bytes.length && bytes[end] !== 10 && bytes[end] !== 13) end++; data(bytes.subarray(offset, end)); offset = end; continue; }
        if (mode === 'skip') { offset++; continue; }
        if (mode === 'data-space') { mode = 'data'; if (byte === 32) offset++; continue; }
        if (mode === 'event') { if (prefix.length >= 512) fail('SSE_CONTROL_LIMIT'); prefix += String.fromCharCode(byte); offset++; continue; }
        if (byte >= 128) fail('SSE_CONTROL_SYNTAX'); prefix += String.fromCharCode(byte); offset++;
        if (prefix === 'data:') { if (sawData) data(Buffer.from('\n')); mode = 'data-space'; prefix = ''; }
        else if (prefix === 'event:') { mode = 'event'; prefix = ''; }
        else if (prefix.startsWith(':') || prefix.length > 8) mode = 'skip';
      }
    },
    finish() { if (parser || sawData || mode === 'data') fail('SSE_INCOMPLETE_EVENT_EOF'); },
    abort() { parser?.abort(); parser = null; },
  };
}
