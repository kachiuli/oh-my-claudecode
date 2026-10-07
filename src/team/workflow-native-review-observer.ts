import { createHash, createPrivateKey, X509Certificate } from 'node:crypto';
import { mkdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import * as tls from 'node:tls';
import * as zlib from 'node:zlib';
import { isDeepStrictEqual } from 'node:util';
import { WorkflowReviewOwnedFile, streamWorkflowReviewLines, type WorkflowReviewOwnedReference } from './workflow-review-source.js';
import { verifyWorkflowReviewOwnedReference } from './workflow-review-source.js';
import { startWorkflowNativeBodyObserver, type WorkflowNativeBodyObserverHandle,
  type WorkflowNativeBodyObserverInvocation, type WorkflowNativeBodyObserverSettlement } from './workflow-native-body-observer.js';
import { WorkflowNativeResponseReceipts, type WorkflowNativeResponseReceiptProof, type WorkflowNativeHistoryInput } from './workflow-native-compaction.js';

const HOST = 'chatgpt.com';
export interface WorkflowNativeReviewTransportBootstrap { readonly certificates: string }
export interface WorkflowNativeCertificateDescriptor {
  readonly host: 'chatgpt.com';
  readonly ca: WorkflowReviewOwnedReference;
  readonly leaf: WorkflowReviewOwnedReference;
  readonly key: WorkflowReviewOwnedReference;
  readonly directory: string;
  readonly trustSha256: string;
}
/** These APIs are native-only. Loading the module preserves older ordinary provider runtimes. */
export function requireWorkflowNativeObserverRuntime(): void {
  if (typeof tls.getCACertificates !== 'function' || typeof zlib.createZstdDecompress !== 'function') {
    throw new Error('workflow_review_native_observer_runtime_unsupported');
  }
}
/** Held root-supplied transport keys are configuration; they grant no model receiving authority. */
export class WorkflowNativeCertificatePins {
  readonly descriptor: WorkflowNativeCertificateDescriptor;
  readonly roots: readonly string[];
  readonly #files: readonly WorkflowReviewOwnedFile[];
  readonly #ca: X509Certificate;
  readonly #leaf: X509Certificate;
  readonly #key: ReturnType<typeof createPrivateKey>;
  private closed = false;
  constructor(input: WorkflowNativeReviewTransportBootstrap) {
    requireWorkflowNativeObserverRuntime();
    if (!isAbsolute(input.certificates)) throw new Error('workflow_review_native_certificate_invalid');
    const directory = realpathSync(input.certificates); const held: WorkflowReviewOwnedFile[] = [];
    try {
      for (const name of ['ca.cert.pem', 'leaf.cert.pem', 'leaf.key.pem']) held.push(new WorkflowReviewOwnedFile(directory, name));
      const references = held.map(file => file.seal());
      const bytes = (index: number) => {
        const reference = references[index]!;
        if (reference.bytes < 1 || reference.bytes > 65536) throw new Error('workflow_review_native_certificate_invalid');
        return held[index]!.read(0, reference.bytes);
      };
      this.#ca = new X509Certificate(bytes(0)); this.#leaf = new X509Certificate(bytes(1));
      this.#key = createPrivateKey(bytes(2)); this.#files = Object.freeze(held);
      this.roots = Object.freeze([...new Set([...tls.getCACertificates('default'), ...tls.getCACertificates('system')])].sort());
      const trust = createHash('sha256'); for (const certificate of this.roots) trust.update(certificate).update('\n');
      this.descriptor = Object.freeze({ host: HOST, directory, ca: references[0]!, leaf: references[1]!, key: references[2]!, trustSha256: trust.digest('hex') });
      this.revalidate();
    } catch (error) {
      for (const file of held) { try { file.close(); } catch { /* Preserve the original certificate failure. */ } }
      throw error;
    }
  }
  revalidate(): void {
    if (this.closed || realpathSync(this.descriptor.directory) !== this.descriptor.directory) throw new Error('workflow_review_native_certificate_changed');
    for (const [index, reference] of [this.descriptor.ca, this.descriptor.leaf, this.descriptor.key].entries()) {
      const current = this.#files[index]!.seal();
      if (current.bytes !== reference.bytes || current.sha256 !== reference.sha256) throw new Error('workflow_review_native_certificate_changed');
    }
    const now = Date.now();
    for (const certificate of [this.#ca, this.#leaf]) {
      if (!(Date.parse(certificate.validFrom) <= now && now < Date.parse(certificate.validTo))) throw new Error('workflow_review_native_certificate_invalid');
    }
    if (!this.#ca.ca || this.#leaf.ca || this.#leaf.checkHost(HOST) !== HOST || !this.#ca.verify(this.#ca.publicKey)
      || !this.#leaf.verify(this.#ca.publicKey) || !this.#leaf.checkPrivateKey(this.#key)) throw new Error('workflow_review_native_certificate_invalid');
  }
  context(): tls.SecureContext {
    this.revalidate();
    return tls.createSecureContext({ key: this.#key.export({ format: 'pem', type: 'pkcs8' }), cert: this.#leaf.toString() });
  }
  get publicCaPath(): string { this.revalidate(); return join(this.descriptor.directory, this.descriptor.ca.name); }
  close(): void {
    if (this.closed) return; this.closed = true; let failure: { value: unknown } | undefined;
    for (const file of this.#files) { try { file.close(); } catch (value) { failure ??= { value }; } }
    if (failure) throw failure.value;
  }
}

export interface WorkflowNativeReviewObserver { readonly kind: 'workflow-native-review-observer' }
export interface WorkflowNativeReviewObservation { readonly kind: 'workflow-native-review-observation' }
export interface WorkflowNativeReviewObservationCompletion { readonly kind: 'workflow-native-review-observation-completion' }
interface ObserverPins {
  readonly certificates: WorkflowNativeCertificatePins;
  readonly transport: WorkflowNativeBodyObserverHandle;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly redactionEnvironment: Readonly<NodeJS.ProcessEnv>;
  closed: boolean;
  active?: WorkflowNativeReviewObservation;
}
interface ObservationPins {
  readonly owner: WorkflowNativeReviewObserver;
  readonly invocation: WorkflowNativeBodyObserverInvocation;
  readonly directory: string;
  readonly onFirstFailure: () => void | Promise<void>;
  settled?: Promise<WorkflowNativeReviewObservationCompletion>;
}
const observers = new WeakMap<WorkflowNativeReviewObserver, ObserverPins>();
const observations = new WeakMap<WorkflowNativeReviewObservation, ObservationPins>();
const completions = new WeakMap<WorkflowNativeReviewObservationCompletion,
  { readonly observation: WorkflowNativeReviewObservation; readonly settlement: WorkflowNativeBodyObserverSettlement }>();
function observerPins(observer: WorkflowNativeReviewObserver): ObserverPins {
  const pins = observers.get(observer);
  if (!pins || pins.closed) throw new Error('workflow_review_native_observer_required');
  pins.certificates.revalidate(); return pins;
}
/** Factory-stable listener, CA, upstream roots and private proxy credentials. */
export async function createWorkflowNativeReviewObserver(input: WorkflowNativeReviewTransportBootstrap): Promise<WorkflowNativeReviewObserver> {
  const certificates = new WorkflowNativeCertificatePins(input);
  let transport: WorkflowNativeBodyObserverHandle | undefined;
  try {
    transport = await startWorkflowNativeBodyObserver({ secureContext: certificates.context(), upstreamCertificates: certificates.roots });
    certificates.revalidate();
    const observer = Object.freeze({ kind: 'workflow-native-review-observer' as const });
    const environment = Object.freeze({ HTTPS_PROXY: transport.proxyUrl, HTTP_PROXY: transport.proxyUrl, ALL_PROXY: transport.proxyUrl,
      NO_PROXY: '', CODEX_CA_CERTIFICATE: certificates.publicCaPath });
    const redactionEnvironment = Object.freeze(Object.fromEntries(Object.values(transport.redactionEnvironment)
      .map((value, index) => [`WORKFLOW_PRIVATE_SECRET_PROXY_${index}`, value])));
    observers.set(observer, { certificates, transport, environment, redactionEnvironment, closed: false }); return observer;
  } catch (error) {
    try { await transport?.close(); } catch { /* Preserve the original bootstrap failure. */ }
    try { certificates.close(); } catch { /* Preserve the original bootstrap failure. */ }
    throw error;
  }
}
export function workflowNativeReviewObserverConfiguration(observer: WorkflowNativeReviewObserver): {
  readonly descriptor: WorkflowNativeCertificateDescriptor & { readonly port: number };
  readonly environment: Readonly<NodeJS.ProcessEnv>; readonly redactionEnvironment: Readonly<NodeJS.ProcessEnv>;
} {
  const pins = observerPins(observer);
  return Object.freeze({ descriptor: Object.freeze({ ...pins.certificates.descriptor, port: pins.transport.port }),
    environment: pins.environment, redactionEnvironment: pins.redactionEnvironment });
}
export function beginWorkflowNativeReviewObservation(observer: WorkflowNativeReviewObserver, input: {
  readonly directory: string; readonly invocationId: string; readonly onFirstFailure: () => void | Promise<void>;
}): WorkflowNativeReviewObservation {
  const pins = observerPins(observer);
  if (pins.active) throw new Error('workflow_review_native_observer_busy');
  const invocation = pins.transport.beginInvocation(input);
  const observation = Object.freeze({ kind: 'workflow-native-review-observation' as const });
  observations.set(observation, { owner: observer, invocation, directory: realpathSync(input.directory), onFirstFailure: input.onFirstFailure });
  pins.active = observation; return observation;
}
function observationPins(observation: WorkflowNativeReviewObservation): ObservationPins {
  const pins = observations.get(observation);
  if (!pins) throw new Error('workflow_review_native_observation_required');
  observerPins(pins.owner); pins.invocation.assertHealthy(); return pins;
}
export function beginWorkflowNativeReviewClientShutdown(observation: WorkflowNativeReviewObservation): void {
  observationPins(observation).invocation.beginClientShutdown();
}
export function assertWorkflowNativeReviewObservationHealthy(observation: WorkflowNativeReviewObservation): void { observationPins(observation); }
export function settleWorkflowNativeReviewObservation(observation: WorkflowNativeReviewObservation): Promise<WorkflowNativeReviewObservationCompletion> {
  const pins = observations.get(observation);
  if (!pins) return Promise.reject(new Error('workflow_review_native_observation_required'));
  pins.settled ??= (async () => {
    try {
      const settlement = await pins.invocation.settle();
      observationPins(observation); verifyWorkflowReviewOwnedReference(pins.directory, settlement.journal);
      const completion = Object.freeze({ kind: 'workflow-native-review-observation-completion' as const });
      completions.set(completion, { observation, settlement }); return completion;
    } finally {
      const owner = observers.get(pins.owner); if (owner?.active === observation) owner.active = undefined;
    }
  })();
  return pins.settled;
}
/** Live completion is consumed once; the returned sealed data alone grants no runtime authority. */
export function consumeWorkflowNativeReviewObservationCompletion(observation: WorkflowNativeReviewObservation,
  completion: WorkflowNativeReviewObservationCompletion): WorkflowNativeBodyObserverSettlement {
  const pins = observationPins(observation); const completed = completions.get(completion);
  if (!completed || completed.observation !== observation) throw new Error('workflow_review_native_observer_completion_required');
  completions.delete(completion); verifyWorkflowReviewOwnedReference(pins.directory, completed.settlement.journal);
  return completed.settlement;
}
export async function disposeWorkflowNativeReviewObserver(observer: WorkflowNativeReviewObserver): Promise<void> {
  const pins = observers.get(observer);
  if (!pins || pins.closed) return;
  pins.closed = true;
  let failure: { value: unknown } | undefined;
  try { if (pins.active) await observations.get(pins.active)?.onFirstFailure(); } catch (value) { failure = { value }; }
  try { await pins.transport.close(); } catch (value) { failure ??= { value }; }
  try { pins.certificates.close(); } catch (value) { failure ??= { value }; }
  if (failure) throw failure.value;
}

interface WorkflowNativeObservedRequest {
  readonly request: WorkflowNativeHistoryInput;
  readonly channelId: number; readonly transaction: number; readonly id: number;
  readonly wire: WorkflowReviewOwnedReference; readonly decoded: WorkflowReviewOwnedReference;
}
export type WorkflowNativeObservedTransaction = WorkflowNativeObservedRequest & (
  | { readonly outcome: 'completed'; readonly response: WorkflowNativeResponseReceiptProof }
  | { readonly outcome: 'abandoned'; readonly classification: 'UPSTREAM_SERVER_CLOSE_BEFORE_RESPONSE_COMPLETED'; readonly modelSourceCredit: false });
/** Offline streamed correlation only. Live authority also requires the privately branded completion. */
export async function* iterateWorkflowNativeObservedTransactions(input: {
  readonly directory: string; readonly invocationId: string; readonly settlement: WorkflowNativeBodyObserverSettlement;
  readonly artifactsDirectory?: string;
}): AsyncGenerator<WorkflowNativeObservedTransaction> {
  const code = 'workflow_review_native_observer_trace_incomplete';
  verifyWorkflowReviewOwnedReference(input.directory, input.settlement.journal);
  if (input.settlement.stats.failures !== 0 || input.settlement.stats.bodySizeCeiling !== null || input.settlement.stats.corpusSizeCeiling !== null
    || input.settlement.stats.peakWorkingChunk > 65536 || Object.entries(input.settlement.stats).some(([key, value]) =>
      !['bodySizeCeiling', 'corpusSizeCeiling'].includes(key) && (!Number.isSafeInteger(value) || Number(value) < 0))) throw new Error(code);
  const journal = new WorkflowReviewOwnedFile(input.directory, input.settlement.journal.name);
  let sequence = 0; let requestCount = 0; let responseEvents = 0; let websocket = false; let closed = false; let shutdown = false;
  let transactionCount = 0; let lastTransaction = 0; let completedCount = 0; let abandonedCount = 0;
  const metadata = new Map<number, { channelId: number; category: string }>();
  const websockets = new Map<number, number>();
  const channel = (event: Record<string, unknown>): number => {
    if (!Number.isSafeInteger(event.channelId) || Number(event.channelId) < 1 || Number(event.channelId) > input.settlement.stats.accepted) throw new Error(code);
    return Number(event.channelId);
  };
  // An upstream WS upgrade may finish after a later metadata request starts. Keep unique allocation
  // identities on disk, without assuming asynchronous journal emission follows allocation order.
  const nextTransaction = (event: Record<string, unknown>): number => {
    const id = Number(event.transaction);
    if (!Number.isSafeInteger(event.transaction) || id < 1) throw new Error(code);
    let marker: WorkflowReviewOwnedFile;
    try { marker = new WorkflowReviewOwnedFile(input.directory, `verified-transactions/${id}.json`, true); }
    catch { throw new Error(code); }
    try { marker.append(Buffer.from(JSON.stringify({ channelId: event.channelId, transaction: id, type: event.type }))); }
    finally { marker.close(); }
    transactionCount++; lastTransaction = Math.max(lastTransaction, id); return id;
  };
  const noCredit = (event: Record<string, unknown>): void => { if (event.modelSourceCredit !== false) throw new Error(code); };
  let pending: { file: WorkflowReviewOwnedFile; wire: WorkflowReviewOwnedReference; decoded: WorkflowReviewOwnedReference;
    channelId: number; transaction: number; id: number; path: string; transport: 'wss' | 'https-http1'; response: WorkflowNativeResponseReceipts;
    responseEvents: number; outputItems: number; abandoned: boolean } | undefined;
  try {
    mkdirSync(join(input.directory, 'verified-transactions'));
    for await (const line of streamWorkflowReviewLines(journal)) {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (closed || event.seq !== ++sequence || event.invocationId !== input.invocationId) throw new Error(code);
      if (pending?.abandoned && event.type !== 'channel-close') throw new Error(code);
      if (event.type === 'body') {
        if (shutdown || pending || event.id !== ++requestCount || !Number.isSafeInteger(event.channelId) || Number(event.channelId) < 1
          || !Number.isSafeInteger(event.transaction) || Number(event.transaction) < 1 || event.direction !== 'request' || event.complete !== true
          || !['wss', 'https-http1'].includes(String(event.transport))
          || !['/backend-api/codex/responses', '/backend-api/codex/responses/compact'].includes(String(event.path))
          || websocket && event.transport !== 'wss') throw new Error(code);
        const channelId = channel(event);
        if (event.transport === 'wss') { if (websockets.get(channelId) !== event.transaction) throw new Error(code); }
        else nextTransaction(event);
        websocket ||= event.transport === 'wss';
        const raw = event.wire as WorkflowReviewOwnedReference; const decoded = event.decoded as WorkflowReviewOwnedReference;
        verifyWorkflowReviewOwnedReference(input.directory, raw); verifyWorkflowReviewOwnedReference(input.directory, decoded);
        const root = input.artifactsDirectory ?? input.directory;
        pending = { file: new WorkflowReviewOwnedFile(root, relative(root, join(input.directory, decoded.name)).replaceAll('\\', '/')), wire: raw, decoded,
          channelId: Number(event.channelId), transaction: Number(event.transaction), id: requestCount,
          path: String(event.path), transport: event.transport as 'wss' | 'https-http1', response: new WorkflowNativeResponseReceipts(),
          responseEvents: 0, outputItems: 0, abandoned: false };
      } else if (event.type === 'response-receipt') {
        if (!pending || event.channelId !== pending.channelId || event.transaction !== pending.transaction || event.transport !== pending.transport
          || event.path !== pending.path || event.kind !== 'model-event') throw new Error(code);
        responseEvents++; pending.responseEvents++;
        if (event.eventType === 'response.output_item.done') pending.outputItems++;
        pending.response.record(event as unknown as import('./workflow-native-model-events.js').WorkflowNativeModelEventReceipt);
        if (event.eventType === 'response.completed') {
          completedCount++;
          yield Object.freeze({ outcome: 'completed' as const, request: { file: pending.file, arrayKey: 'input', representation: pending.transport === 'wss' ? 'wire-wss' as const : 'wire' as const },
            response: pending.response.finish(), channelId: pending.channelId, transaction: pending.transaction, id: pending.id,
            wire: pending.wire, decoded: pending.decoded });
          verifyWorkflowReviewOwnedReference(input.directory, pending.wire); verifyWorkflowReviewOwnedReference(input.directory, pending.decoded);
          pending.file.close(); pending = undefined;
        }
      } else if (event.type === 'response-abandoned') {
        if (!pending || shutdown || pending.transport !== 'wss' || pending.path !== '/backend-api/codex/responses'
          || pending.outputItems !== 0 || !isDeepStrictEqual(event, { seq: sequence, at: event.at, invocationId: input.invocationId,
            type: 'response-abandoned', channelId: pending.channelId, transaction: pending.transaction, transport: 'wss', path: pending.path,
            id: pending.id, wire: pending.wire, decoded: pending.decoded, responseEvents: pending.responseEvents,
            classification: 'UPSTREAM_SERVER_CLOSE_BEFORE_RESPONSE_COMPLETED', parserIdle: true, upstreamClose: true, outputItems: 0, modelSourceCredit: false })) throw new Error(code);
        pending.abandoned = true;
      } else if (event.type === 'closed') {
        if (!shutdown || pending || metadata.size || transactionCount !== lastTransaction || event.status !== 'healthy'
          || !isDeepStrictEqual(event.stats, input.settlement.stats)) throw new Error(code);
        closed = true;
      } else if (event.type === 'metadata-request') {
        noCredit(event); const channelId = channel(event); const transaction = nextTransaction(event);
        if (shutdown || !['ACCOUNTS_CHECK', 'USER_SETTINGS', 'CONFIG_BUNDLE'].includes(String(event.category))) throw new Error(code);
        metadata.set(transaction, { channelId, category: String(event.category) });
      } else if (event.type === 'metadata-completed') {
        noCredit(event); const channelId = channel(event); const expected = metadata.get(Number(event.transaction));
        if (!expected || expected.channelId !== channelId || expected.category !== event.category || event.requestConsumed !== true
          || event.responseComplete !== true || event.responseDelivered !== true) throw new Error(code);
        metadata.delete(Number(event.transaction));
      } else if (event.type === 'websocket-negotiated') {
        noCredit(event); const channelId = channel(event); const transaction = nextTransaction(event);
        if (shutdown || websockets.has(channelId)) throw new Error(code);
        const compression = event.compression as Record<string, unknown> | null;
        if (compression !== null && (!compression || Object.keys(compression).sort().join(',') !== 'clientNoContextTakeover,clientWindowBits,serverNoContextTakeover,serverWindowBits'
          || typeof compression.clientNoContextTakeover !== 'boolean' || typeof compression.serverNoContextTakeover !== 'boolean'
          || ![compression.clientWindowBits, compression.serverWindowBits].every(bits => Number.isSafeInteger(bits) && Number(bits) >= 8 && Number(bits) <= 15))) throw new Error(code);
        const marker = new WorkflowReviewOwnedFile(input.directory, `verified-transactions/channel-${channelId}.json`, true);
        try { marker.append(Buffer.from(JSON.stringify({ channelId, transaction }))); } finally { marker.close(); }
        websockets.set(channelId, transaction);
      } else if (event.type === 'client-shutdown-begin') {
        noCredit(event); if (shutdown || pending) throw new Error(code); shutdown = true;
      } else if (event.type === 'native-control-discarded') {
        noCredit(event); const channelId = channel(event);
        if (event.transport === 'wss' ? websockets.get(channelId) !== event.transaction
          : event.transport !== 'https-http1' || pending?.channelId !== channelId || pending.transaction !== event.transaction) throw new Error(code);
        if (event.category === 'metadata-discarded') {
          if (!['codex.response.metadata', 'codex.rate_limits', 'response.metadata', 'responsesapi.websocket_timing', 'response.compaction.compacting', 'keepalive']
            .includes(String(event.knownControlType))) throw new Error(code);
        } else if (event.category !== 'native-ignored-event-discarded' || event.knownControlType !== undefined) throw new Error(code);
      } else if (event.type === 'channel-close') {
        noCredit(event); const channelId = channel(event);
        if (event.classification === 'ABANDONED_WS_SERVER_CLOSE') {
          if (!pending?.abandoned || pending.channelId !== channelId || event.peer !== 'upstream-ws'
            || websockets.get(channelId) !== pending.transaction || [...metadata.values()].some(value => value.channelId === channelId)) throw new Error(code);
          websockets.delete(channelId); abandonedCount++;
          yield Object.freeze({ outcome: 'abandoned' as const, classification: 'UPSTREAM_SERVER_CLOSE_BEFORE_RESPONSE_COMPLETED' as const,
            modelSourceCredit: false as const, request: { file: pending.file, arrayKey: 'input', representation: 'wire-wss' as const },
            channelId, transaction: pending.transaction, id: pending.id, wire: pending.wire, decoded: pending.decoded });
          verifyWorkflowReviewOwnedReference(input.directory, pending.wire); verifyWorkflowReviewOwnedReference(input.directory, pending.decoded);
          pending.file.close(); pending = undefined; continue;
        }
        if (pending?.channelId === channelId || [...metadata.values()].some(value => value.channelId === channelId)
          || !['native-tls', 'native-http-parser', 'native-ws', 'upstream-ws'].includes(String(event.peer))
          || !['NORMAL_COMPLETE_HTTP_EOF', 'NORMAL_COMPLETE_WS_CLOSE_HANDSHAKE', 'NORMAL_IDLE_CLOSE_AFTER_DECLARED_SHUTDOWN', 'NORMAL_UNUSED_CLOSE_AFTER_DECLARED_SHUTDOWN'].includes(String(event.classification))
          || String(event.classification).endsWith('AFTER_DECLARED_SHUTDOWN') && !shutdown) throw new Error(code);
        websockets.delete(channelId);
      } else throw new Error(code);
    }
    if (!closed || pending || requestCount !== input.settlement.stats.requests || responseEvents !== input.settlement.stats.responseEvents
      || abandonedCount !== (input.settlement.stats.abandoned ?? 0) || requestCount !== completedCount + abandonedCount) throw new Error(code);
    verifyWorkflowReviewOwnedReference(input.directory, input.settlement.journal);
  } finally { try { pending?.file.close(); } finally { journal.close(); } }
}
