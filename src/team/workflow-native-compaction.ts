/** Offline structural checking only. These records cannot construct native runtime authority. */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { iterateWorkflowReviewNativeItems, readWorkflowReviewNativeRequestControls, streamWorkflowReviewLines,
  WorkflowReviewOwnedFile, type WorkflowReviewNativeItemFingerprint, type WorkflowReviewOwnedReference } from './workflow-review-source.js';
import { verifyWorkflowReviewOwnedReference } from './workflow-review-source.js';
import { WORKFLOW_NATIVE_MODEL_EVENT_TYPES, type WorkflowNativeModelEventReceipt } from './workflow-native-model-events.js';

type Item = WorkflowReviewNativeItemFingerprint & { readonly expectedHistorySha256?: string };
export interface WorkflowNativeHistoryInput { readonly file: WorkflowReviewOwnedFile; readonly arrayKey: string; readonly publicCompactionMetadata?: boolean;
  readonly representation?: 'wire' | 'wire-wss' }
type Phase = 'ready' | 'generation' | 'compaction' | 'install' | 'baseline' | 'closed';
const code = 'workflow_review_native_compaction_incomplete';
const hash = (value: string) => createHash('sha256').update(value, 'utf16le').digest('hex');
const wire = (value: unknown) => Buffer.from(JSON.stringify(value) + '\n');
async function* journalItems(file: WorkflowReviewOwnedFile): AsyncGenerator<Item> {
  for await (const line of streamWorkflowReviewLines(file)) yield JSON.parse(line) as Item;
}
function items(input: WorkflowNativeHistoryInput): Generator<Item> { return iterateWorkflowReviewNativeItems(input); }
export interface WorkflowNativeResponseReceiptProof {
  readonly authority: false; readonly responseId: string; readonly count: string; readonly sha256: string;
  readonly completedOutput: { readonly count: string; readonly sha256: string; readonly mask: number };
  readonly compaction?: { readonly id: string; readonly sha256: string };
}
/** Constant-space done-item fold with the observed terminal aggregate retained separately. */
export class WorkflowNativeResponseReceipts {
  private readonly done = createHash('sha256').update('array\n');
  private count = 0n;
  private responseId?: string;
  private compaction?: { readonly id: string; readonly sha256: string };
  private completion?: WorkflowNativeResponseReceiptProof;
  private failed = false;
  record(receipt: WorkflowNativeModelEventReceipt): void {
    if (this.failed || this.completion || receipt.kind !== 'model-event' || !WORKFLOW_NATIVE_MODEL_EVENT_TYPES.includes(receipt.eventType ?? '')) {
      this.failed = true; throw new Error(code);
    }
    try {
      if (receipt.responseId !== undefined) {
        if (!/^resp_[A-Za-z0-9-]{1,240}$/.test(receipt.responseId) || this.responseId && this.responseId !== receipt.responseId) throw new Error(code);
        this.responseId = receipt.responseId;
      }
      if (receipt.eventType === 'response.output_item.done') {
        if (!this.responseId || !receipt.item || !/^[a-f0-9]{64}$/.test(receipt.item.sha256)) throw new Error(code);
        this.done.update(receipt.item.sha256 + '\n'); this.count++;
        if (receipt.item.type === 'compaction') {
          if (this.compaction || this.count !== 1n || !receipt.item.id) throw new Error(code);
          this.compaction = Object.freeze({ id: receipt.item.id, sha256: receipt.item.sha256 });
        } else if (this.compaction) throw new Error(code);
      } else if (receipt.eventType === 'response.completed') {
        const sha256 = this.done.digest('hex');
        // Pinned Codex traces OutputItemDone items; Completed closes their response and may
        // carry an explicit empty output array. A repeated nonempty aggregate must still agree.
        if (!this.responseId || !receipt.responseId || !receipt.output || receipt.output.mask !== 0
          || !(receipt.output.count === String(this.count) && receipt.output.sha256 === sha256
            || receipt.output.count === '0' && receipt.output.sha256 === createHash('sha256').update('array\n').digest('hex'))) throw new Error(code);
        this.completion = Object.freeze({ authority: false, responseId: this.responseId, count: String(this.count), sha256,
          completedOutput: Object.freeze({ count: receipt.output.count, sha256: receipt.output.sha256, mask: receipt.output.mask }),
          ...(this.compaction ? { compaction: this.compaction } : {}) });
      } else if (receipt.item || receipt.output) throw new Error(code);
    } catch (error) { this.failed = true; throw error; }
  }
  finish(nativeResult?: WorkflowNativeHistoryInput): WorkflowNativeResponseReceiptProof {
    if (this.failed || !this.completion) throw new Error(code);
    if (nativeResult) {
      const aggregate = createHash('sha256').update('array\n'); let count = 0n;
      for (const item of items(nativeResult)) { aggregate.update(item.sha256 + '\n'); count++; }
      if (String(count) !== this.completion.count || aggregate.digest('hex') !== this.completion.sha256) {
        this.failed = true; throw new Error(code);
      }
    }
    return this.completion;
  }
}
async function sameItems(left: AsyncIterable<Item> | Iterable<Item>, right: AsyncIterable<Item> | Iterable<Item>): Promise<void> {
  const rightIterator = Symbol.asyncIterator in right ? right[Symbol.asyncIterator]() : right[Symbol.iterator]();
  try {
    for await (const item of left) {
      const next = await rightIterator.next(); if (next.done || next.value.sha256 !== (item.expectedHistorySha256 ?? item.sha256)) throw new Error(code);
    }
    if (!(await rightIterator.next()).done) throw new Error(code);
  } finally { await rightIterator.return?.(undefined); }
}

/**
 * Text-only Responses Lite ancestry with automatic and completed manual-turn compaction.
 * Live verification additionally correlates held bodies with authenticated transport and native
 * events. No saved proof, constructor argument, or successful offline check grants authority.
 */
export class WorkflowNativeCompactionChain {
  private readonly input: { readonly directory: string; readonly artifactsDirectory: string; readonly threadId: string; readonly turnId: string;
    readonly toolsSha256: string; readonly toolNames: readonly [string, string]; readonly controllerPromptContentSha256: string };
  private phase: Phase = 'ready';
  private readonly seals: WorkflowReviewOwnedFile;
  private templates: WorkflowReviewOwnedFile;
  private pendingOutputs: WorkflowReviewOwnedFile;
  private history?: WorkflowReviewOwnedFile;
  private prefix?: readonly [Item, Item];
  private previousResponse?: string;
  private warmup?: { responseId: string; prefix: readonly [Item, Item] };
  private pending?: { id: string; history: WorkflowReviewOwnedFile; prefix: readonly [Item, Item] };
  private compact?: { id: string; requestId: string; output?: Item; checkpoint?: WorkflowReviewOwnedFile; manual?: true };
  private currentTurnId: string;
  private manual?: { readonly turnId: string; phase: 'compacting' | 'installed' | 'post'; postPrompt?: string };
  private ordinal = 0;
  private compactions = 0;
  private baselineRequired = false;
  private outstandingCalls = 0;
  private pendingDelivery = 0;
  private finalSeen = false;
  constructor(input: { directory: string; artifactsDirectory: string; threadId: string; turnId: string;
    toolsSha256: string; toolNames: readonly [string, string]; controllerPromptContentSha256: string }) {
    this.input = Object.freeze({ ...input, toolNames: Object.freeze([input.toolNames[0], input.toolNames[1]] as const) });
    this.currentTurnId = input.turnId;
    mkdirSync(input.directory);
    for (const name of ['ids', 'calls', 'outputs', 'compactions', 'responses', 'contexts']) mkdirSync(join(input.directory, name));
    this.seals = this.open('seals.jsonl');
    try { this.templates = this.open('contexts.jsonl'); }
    catch (error) { try { this.seals.close(); } catch { /* Preserve the original ownership failure. */ } throw error; }
    try { this.pendingOutputs = this.open('pending-outputs-0.jsonl'); }
    catch (error) {
      for (const file of [this.templates, this.seals]) { try { file.close(); } catch { /* Preserve the original journal failure. */ } }
      throw error;
    }
  }
  private open(name: string): WorkflowReviewOwnedFile {
    return new WorkflowReviewOwnedFile(this.input.directory, name, true);
  }
  private refuse(): never { this.phase = 'closed'; throw new Error(code); }
  private marker(directory: string, id: string, value: unknown): void {
    if (!id || id.length > 4096 || existsSync(join(this.input.directory, directory, hash(id)))) this.refuse();
    const file = this.open(`${directory}/${hash(id)}`);
    try { file.append(wire(value)); } finally { file.close(); }
  }
  private retain(input: WorkflowNativeHistoryInput): void {
    const seal = input.file.seal(); verifyWorkflowReviewOwnedReference(this.input.artifactsDirectory, seal); this.seals.append(wire(seal));
  }
  private append(file: WorkflowReviewOwnedFile, item: Item, fresh = true): void {
    if (fresh && item.id) this.marker('ids', item.id, { id: item.id, sha256: item.sha256 });
    file.append(wire(item));
  }
  private controls(request: WorkflowNativeHistoryInput, kind: 'turn' | 'compaction') {
    const control = readWorkflowReviewNativeRequestControls(request.file, request.representation);
    if (control.model !== 'gpt-6.1-sol' || control.effort !== 'xhigh' || control.context !== 'all_turns' || control.parallel !== false
      || control.threadId !== this.input.threadId || control.sessionId !== this.input.threadId || control.turnId !== this.currentTurnId
      || control.requestKind !== kind || control.generate !== undefined || kind === 'compaction' && control.text?.format !== undefined) throw new Error(code);
    return control;
  }
  private prefixItems(iterator: Iterator<Item>): readonly [Item, Item] {
    const tools = iterator.next(); const instructions = iterator.next();
    if (tools.done || instructions.done || tools.value.type !== 'additional_tools' || tools.value.role !== 'developer'
      || tools.value.fields.tools !== this.input.toolsSha256 || instructions.value.type !== 'message' || instructions.value.role !== 'developer') throw new Error(code);
    const prefix = [tools.value, instructions.value] as const;
    if (this.prefix && (prefix[0].sha256 !== this.prefix[0].sha256 || prefix[1].sha256 !== this.prefix[1].sha256)) throw new Error(code);
    return prefix;
  }
  registerWarmup(request: WorkflowNativeHistoryInput, completion: WorkflowNativeModelEventReceipt): void {
    if (this.phase !== 'ready' || this.history || this.pending || this.warmup || request.representation !== 'wire-wss') this.refuse();
    const control = readWorkflowReviewNativeRequestControls(request.file, 'wire-wss');
    if (control.generate !== false || control.requestKind !== 'prewarm' || control.turnId !== '' || control.previousResponseId !== undefined
      || control.threadId !== this.input.threadId || control.sessionId !== this.input.threadId || control.model !== 'gpt-6.1-sol'
      || control.effort !== 'xhigh' || control.context !== 'all_turns' || control.parallel !== false
      || control.text?.format !== undefined || completion.kind !== 'model-event' || completion.eventType !== 'response.completed' || !completion.responseId
      || completion.output?.count !== '0' || completion.output.sha256 !== createHash('sha256').update('array\n').digest('hex')) this.refuse();
    const iterator = items(request);
    try {
      const prefix = this.prefixItems(iterator); if (!iterator.next().done) this.refuse(); this.retain(request);
      this.marker('responses', completion.responseId, { id: completion.responseId }); this.warmup = { responseId: completion.responseId, prefix };
    } finally { iterator.return(undefined); }
  }
  /** Calibration-only transition, after the first real reader turn and its final inference complete. */
  beginManualCompaction(turnId: string): void {
    if (this.phase !== 'ready' || !this.finalSeen || this.manual || !turnId || turnId === this.currentTurnId
      || this.pending || this.outstandingCalls || this.pendingDelivery || !this.history) this.refuse();
    this.manual = { turnId, phase: 'compacting' }; this.currentTurnId = turnId; this.finalSeen = false;
  }
  beginPostCompactionTurn(turnId: string, controllerPromptContentSha256: string): void {
    if (this.phase !== 'baseline' || this.manual?.phase !== 'installed' || !this.compact?.manual || !turnId
      || turnId === this.currentTurnId || turnId === this.input.turnId || !/^[a-f0-9]{64}$/.test(controllerPromptContentSha256)) this.refuse();
    this.currentTurnId = turnId; this.manual.phase = 'post'; this.manual.postPrompt = controllerPromptContentSha256;
  }
  async startGeneration(id: string, request: WorkflowNativeHistoryInput): Promise<void> {
    if ((this.phase !== 'ready' && this.phase !== 'baseline') || this.pending || !id || this.finalSeen || this.outstandingCalls) this.refuse();
    this.phase = 'generation';
    const control = this.controls(request, 'turn');
    if (control.previousResponseId !== undefined && (this.baselineRequired || request.representation !== 'wire-wss'
      || control.previousResponseId !== (this.history ? this.previousResponse : this.warmup?.responseId))) this.refuse();
    const iterator = items(request); const initial = !this.history; const staged = this.open(`history-${++this.ordinal}.jsonl`);
    let prefix: readonly [Item, Item];
    try {
      prefix = control.previousResponseId !== undefined ? (this.history ? this.prefix! : this.warmup!.prefix) : this.prefixItems(iterator);
      if (this.warmup && (prefix[0].sha256 !== this.warmup.prefix[0].sha256 || prefix[1].sha256 !== this.warmup.prefix[1].sha256)) this.refuse();
      this.pending = { id, history: staged, prefix };
      if (initial) {
        for (const item of prefix) if (item.id) this.marker('ids', item.id, { id: item.id, sha256: item.sha256 });
        let prompt = false;
        for (const item of iterator) {
          if (item.type !== 'message' || !['developer', 'user'].includes(item.role ?? '') || item.metadata?.turnId !== this.input.turnId) throw new Error(code);
          if (item.role === 'user' && item.fields.content === this.input.controllerPromptContentSha256) {
            if (prompt) throw new Error(code); prompt = true;
          } else if (!prompt) {
            if (!item.contextSha256 || !item.metadata.kindsSha256 || !item.metadata.createTime || !item.id) throw new Error(code);
            this.templates.append(wire(item)); this.marker('contexts', item.contextSha256, { sha256: item.contextSha256 });
          } else throw new Error(code);
          this.append(staged, item);
        }
        if (!prompt) throw new Error(code);
      } else if (this.baselineRequired) {
        if (!this.compact?.checkpoint) throw new Error(code);
        const expected = journalItems(this.compact.checkpoint);
        try {
          for await (const checkpointItem of expected) {
            const next = iterator.next(); if (next.done) throw new Error(code); const actual = next.value;
            if (checkpointItem.id) {
              if (actual.sha256 !== checkpointItem.sha256) throw new Error(code);
            } else {
              const prefixName: Record<string, string> = { message: 'msg', compaction: 'cmp' };
              const wanted = prefixName[checkpointItem.type];
              if (!wanted || !actual.id || !new RegExp(`^${wanted}_[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$`).test(actual.id)
                || actual.withoutIdSha256 !== checkpointItem.withoutIdSha256) throw new Error(code);
              this.marker('ids', actual.id, { id: actual.id, sha256: actual.sha256 });
            }
            this.append(staged, actual, false);
          }
          if (this.compact.manual) {
            if (this.manual?.phase !== 'post') throw new Error(code);
            const fresh = this.open(`contexts-${++this.ordinal}.jsonl`);
            try {
              const fields = (item: Item) => JSON.stringify(Object.keys(item.fields).filter(key => !['id', 'internal_chat_message_metadata_passthrough'].includes(key))
                .sort().map(key => [key, item.fields[key]]));
              for await (const template of journalItems(this.templates)) {
                const next = iterator.next(); if (next.done) throw new Error(code); const actual = next.value;
                if (actual.type !== 'message' || fields(template) !== fields(actual) || actual.metadata?.kindsSha256 !== template.metadata?.kindsSha256
                  || !actual.metadata?.createTime || actual.metadata.turnId !== this.currentTurnId || !actual.id
                  || !/^msg_[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(actual.id)) throw new Error(code);
                this.append(staged, actual); fresh.append(wire(actual));
                this.marker('contexts', actual.contextSha256!, { sha256: actual.contextSha256 });
              }
              const prompt = iterator.next();
              if (prompt.done || prompt.value.type !== 'message' || prompt.value.role !== 'user' || !prompt.value.id
                || prompt.value.metadata?.turnId !== this.currentTurnId || !prompt.value.metadata.createTime
                || prompt.value.fields.content !== this.manual.postPrompt) throw new Error(code);
              this.append(staged, prompt.value); this.templates.close(); this.templates = fresh;
            } catch (error) { fresh.close(); throw error; }
          }
          if (!iterator.next().done) throw new Error(code);
        } finally { await expected.return(undefined); }
      } else if (control.previousResponseId !== undefined) {
        await sameItems(journalItems(this.pendingOutputs), iterator);
        for await (const item of journalItems(this.history!)) staged.append(wire(item));
      } else {
        await sameItems(journalItems(this.history!), (function* () {
          for (const item of iterator) { staged.append(wire(item)); yield item; }
        })());
      }
      this.retain(request);
    } catch (error) {
      this.phase = 'closed';
      if (!this.pending) { try { staged.close(); } catch { /* Preserve the failed input proof. */ } }
      throw error;
    } finally { iterator.return(undefined); }
  }
  completeGeneration(id: string, responseId: string, response: WorkflowNativeHistoryInput): void {
    if (this.phase !== 'generation' || !this.pending || this.pending.id !== id) this.refuse();
    this.phase = 'closed';
    this.marker('responses', responseId, { id: responseId });
    this.pendingDelivery = 0;
    for (const item of items(response)) {
      if (this.finalSeen) throw new Error(code);
      if (item.type === 'function_call') {
        if (!item.callId || !item.name || !this.input.toolNames.includes(item.name)) throw new Error(code);
        this.marker('calls', item.callId, { callId: item.callId, name: item.name }); this.outstandingCalls++;
      } else if (item.type !== 'reasoning' && (item.type !== 'message' || item.role !== 'assistant')) throw new Error(code);
      if (item.type === 'message' && item.phase === 'final_answer') {
        if (this.outstandingCalls) throw new Error(code); this.finalSeen = true;
      }
      // Only accepted completed model outputs establish this directional history expectation.
      // Raw fingerprints remain in the journal and in the retained response receipt proof.
      this.append(this.pending.history, { ...item, ...(item.historySerialization ? { expectedHistorySha256: item.historySerialization.sha256 } : {}) });
    }
    this.retain(response); this.history?.close(); this.compact?.checkpoint?.close(); this.history = this.pending.history; this.prefix = this.pending.prefix;
    this.pendingOutputs.close(); this.pendingOutputs = this.open(`pending-outputs-${++this.ordinal}.jsonl`);
    this.previousResponse = responseId; this.pending = undefined; this.baselineRequired = false; this.compact = undefined; this.phase = 'ready';
  }
  recordToolOutputs(response: WorkflowNativeHistoryInput): void {
    if (this.phase !== 'ready' || !this.history || this.finalSeen) this.refuse();
    this.phase = 'closed';
    for (const item of items(response)) {
      if (item.type !== 'function_call_output' || !item.callId || !existsSync(join(this.input.directory, 'calls', hash(item.callId)))) throw new Error(code);
      this.marker('outputs', item.callId, { callId: item.callId, sha256: item.sha256 }); this.append(this.history, item);
      this.pendingOutputs.append(wire(item));
      this.outstandingCalls--; this.pendingDelivery++;
    }
    this.retain(response); this.phase = 'ready';
  }
  async startCompaction(id: string, requestId: string, request: WorkflowNativeHistoryInput, traceRequest: WorkflowNativeHistoryInput): Promise<void> {
    if (this.phase !== 'ready' || !this.history || !this.prefix || this.pending || this.baselineRequired || this.finalSeen || this.outstandingCalls) this.refuse();
    this.phase = 'compaction';
    const control = this.controls(request, 'compaction');
    if (control.previousResponseId !== undefined) throw new Error(code);
    const traceControl = readWorkflowReviewNativeRequestControls(traceRequest.file, 'compact-trace');
    if (traceControl.model !== 'gpt-6.1-sol' || traceControl.parallel !== true || traceControl.instructionsContentSha256 !== this.prefix[1].fields.content) throw new Error(code);
    this.marker('compactions', id, { id, requestId }); this.marker('compactions', requestId, { id, requestId });
    const wireIterator = items(request); const traceIterator = items(traceRequest);
    try {
      this.prefixItems(wireIterator);
      for await (const previous of journalItems(this.history)) {
        const actual = wireIterator.next(); const traced = traceIterator.next();
        const expected = previous.expectedHistorySha256 ?? previous.sha256;
        if (actual.done || traced.done || actual.value.sha256 !== expected || traced.value.sha256 !== expected) throw new Error(code);
      }
      for (const iterator of [wireIterator, traceIterator]) {
        const trigger = iterator.next(); if (trigger.done || trigger.value.type !== 'compaction_trigger' || !iterator.next().done) throw new Error(code);
      }
      this.retain(request); this.retain(traceRequest);
    } finally { wireIterator.return(undefined); traceIterator.return(undefined); }
    this.compact = { id, requestId, ...(this.manual?.phase === 'compacting' ? { manual: true as const } : {}) };
  }
  completeCompaction(id: string, requestId: string, responseId: string,
    outputDone: WorkflowNativeHistoryInput, responseCompleted: WorkflowNativeHistoryInput, nativeResult: WorkflowNativeHistoryInput): void {
    if (this.phase !== 'compaction' || this.compact?.id !== id || this.compact.requestId !== requestId) this.refuse();
    this.phase = 'closed';
    const one = (input: WorkflowNativeHistoryInput): Item => {
      const iterator = items(input);
      try {
        const item = iterator.next(); if (item.done || item.value.type !== 'compaction' || !item.value.id
          || item.value.metadata?.turnId !== this.currentTurnId || !iterator.next().done) throw new Error(code);
        this.retain(input); return item.value;
      } finally { iterator.return(undefined); }
    };
    const completed = one(responseCompleted); const done = one(outputDone); const native = one(nativeResult);
    if (completed.sha256 !== done.sha256 || completed.sha256 !== native.sha256) throw new Error(code);
    this.marker('responses', responseId, { id: responseId }); this.compact.output = native;
    this.previousResponse = undefined; this.pendingDelivery = 0; this.pendingOutputs.close();
    this.pendingOutputs = this.open(`pending-outputs-${++this.ordinal}.jsonl`); this.phase = 'install';
  }
  /** Typed incoming receipts replace raw incoming response retention on the production observer. */
  completeCompactionReceipt(id: string, requestId: string, receipt: WorkflowNativeResponseReceiptProof, nativeResult: WorkflowNativeHistoryInput): void {
    if (this.phase !== 'compaction' || this.compact?.id !== id || this.compact.requestId !== requestId) this.refuse();
    this.phase = 'closed';
    const iterator = items(nativeResult);
    try {
      const result = iterator.next();
      if (!receipt.compaction || receipt.count !== '1' || result.done || result.value.type !== 'compaction'
        || result.value.id !== receipt.compaction.id || result.value.sha256 !== receipt.compaction.sha256
        || result.value.metadata?.turnId !== this.currentTurnId || !iterator.next().done
        || createHash('sha256').update('array\n').update(result.value.sha256 + '\n').digest('hex') !== receipt.sha256) throw new Error(code);
      this.retain(nativeResult); this.marker('responses', receipt.responseId, { id: receipt.responseId }); this.compact.output = result.value;
    } finally { iterator.return(undefined); }
    this.previousResponse = undefined; this.pendingDelivery = 0; this.pendingOutputs.close();
    this.pendingOutputs = this.open(`pending-outputs-${++this.ordinal}.jsonl`); this.phase = 'install';
  }
  async installCompaction(id: string, checkpoint: WorkflowReviewOwnedFile): Promise<void> {
    if (this.phase !== 'install' || this.compact?.id !== id || !this.compact.output || !this.history) this.refuse();
    this.phase = 'closed';
    await sameItems(journalItems(this.history), items({ file: checkpoint, arrayKey: 'input_history' }));
    const replacement = this.open(`checkpoint-${++this.ordinal}.jsonl`); this.compact.checkpoint = replacement;
    const iterator = items({ file: checkpoint, arrayKey: 'replacement_history' });
    try {
      for await (const context of this.compact.manual ? [] : journalItems(this.templates)) {
        const actual = iterator.next();
        if (actual.done || actual.value.type !== 'message' || actual.value.id || actual.value.metadata?.createTime
          || actual.value.contextSha256 !== context.contextSha256 || actual.value.metadata?.turnId !== this.currentTurnId) throw new Error(code);
        replacement.append(wire(actual.value));
      }
      for await (const original of journalItems(this.history)) {
        if (original.type !== 'message' || original.role !== 'user' || original.contextSha256
          && existsSync(join(this.input.directory, 'contexts', hash(original.contextSha256)))) continue;
        const retained = iterator.next(); if (retained.done || retained.value.sha256 !== original.sha256) throw new Error(code);
        replacement.append(wire(retained.value));
      }
      const compacted = iterator.next();
      if (compacted.done || compacted.value.sha256 !== this.compact.output.sha256 || !iterator.next().done) throw new Error(code);
      this.append(replacement, compacted.value); this.retain({ file: checkpoint, arrayKey: 'replacement_history' });
    } finally { iterator.return(undefined); }
    this.compact.checkpoint = replacement; this.compactions++; this.baselineRequired = true; this.phase = 'baseline';
    if (this.compact.manual) this.manual!.phase = 'installed';
  }
  async finish(requireCompaction = true): Promise<{ readonly authority: false; readonly compactions: number; readonly history: WorkflowReviewOwnedReference; readonly seals: WorkflowReviewOwnedReference }> {
    if (this.phase !== 'ready' || this.pending || this.baselineRequired || !this.history || !this.previousResponse
      || requireCompaction && !this.compactions || !this.finalSeen || this.outstandingCalls || this.pendingDelivery) this.refuse();
    this.phase = 'closed';
    for await (const line of streamWorkflowReviewLines(this.seals)) verifyWorkflowReviewOwnedReference(this.input.artifactsDirectory, JSON.parse(line) as WorkflowReviewOwnedReference);
    return Object.freeze({ authority: false, compactions: this.compactions, history: this.history.seal(), seals: this.seals.seal() });
  }
  dispose(): void {
    let failure: { value: unknown } | undefined;
    for (const file of [this.seals, this.templates, this.pendingOutputs, this.history, this.pending?.history, this.compact?.checkpoint]) {
      try { file?.close(); } catch (value) { failure ??= { value }; }
    }
    if (failure) throw failure.value;
  }
}
