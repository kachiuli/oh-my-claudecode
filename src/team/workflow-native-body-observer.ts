import http, { type IncomingMessage, type ServerResponse, type ClientRequest } from 'node:http';
import https from 'node:https';
import tls, { type SecureContext } from 'node:tls';
import { type Socket } from 'node:net';
import { type Readable, type Writable, type Transform } from 'node:stream';
import zlib from 'node:zlib';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { once } from 'node:events';
import { WorkflowReviewOwnedFile } from './workflow-review-source.js';
import { createWorkflowNativeModelEventParser, createWorkflowNativeSseParser, type WorkflowNativeModelEventParser } from './workflow-native-model-events.js';
import type { WorkflowReviewOwnedReference } from './workflow-review-source.js';
import type { WorkflowNativeModelEventReceipt } from './workflow-native-model-events.js';

export interface WorkflowNativeBodyObserverStats {
  readonly accepted: number;
  readonly requests: number;
  readonly responseEvents: number;
  readonly failures: number;
  readonly peakWorkingChunk: number;
  readonly bodySizeCeiling: null;
  readonly corpusSizeCeiling: null;
}
interface RecordIdentity { readonly seq: number; readonly at: string; readonly invocationId: string }
interface ModelTransportIdentity { readonly channelId: number; readonly transaction: number; readonly transport: 'wss' | 'https-http1'; readonly path: string }
interface FailureState {
  readonly upgrading: boolean; readonly partialHeader: boolean; readonly activeHttp: number; readonly pending: number;
  readonly acceptedRequests: number; readonly requests: number; readonly completions: number; readonly parserIdle: boolean;
  readonly clientShutdownDeclared: boolean; readonly wsSocketAssigned: boolean; readonly wsTcpConnected: boolean;
  readonly wsTlsReady: boolean; readonly wsRequestFinished: boolean; readonly wsResponseStatus: number | null;
}
type RouteCategory = 'ACCOUNTS_CHECK' | 'USER_SETTINGS' | 'CONFIG_BUNDLE' | 'WORKSPACE_MESSAGES' | 'PROFILE_ME' | 'MODEL_CATALOG_01591' | 'ANALYTICS_EVENTS' | 'OTHER';
export type WorkflowNativeBodyObserverRecord =
  | (RecordIdentity & ModelTransportIdentity & { readonly type: 'body'; readonly id: number; readonly direction: 'request'; readonly encoding: string; readonly wire: WorkflowReviewOwnedReference; readonly decoded: WorkflowReviewOwnedReference; readonly complete: true })
  | (RecordIdentity & ModelTransportIdentity & WorkflowNativeModelEventReceipt & { readonly type: 'response-receipt'; readonly kind: 'model-event' })
  | (RecordIdentity & { readonly type: 'native-control-discarded'; readonly channelId: number; readonly transaction: number; readonly transport: 'wss' | 'https-http1'; readonly category: 'metadata-discarded' | 'native-ignored-event-discarded'; readonly knownControlType?: string; readonly modelSourceCredit: false })
  | (RecordIdentity & { readonly type: 'channel-close'; readonly channelId: number; readonly peer: string; readonly classification: string; readonly modelSourceCredit: false })
  | (RecordIdentity & { readonly type: 'failure'; readonly code: string; readonly channelId?: number; readonly transaction?: number; readonly state?: FailureState })
  | (RecordIdentity & { readonly type: 'denied'; readonly reason: string; readonly category: RouteCategory; readonly channelId?: number; readonly modelSourceCredit: false })
  | (RecordIdentity & { readonly type: 'metadata-request'; readonly channelId: number; readonly transaction: number; readonly category: 'ACCOUNTS_CHECK' | 'USER_SETTINGS' | 'CONFIG_BUNDLE'; readonly modelSourceCredit: false })
  | (RecordIdentity & { readonly type: 'metadata-completed'; readonly channelId: number; readonly transaction: number; readonly category: 'ACCOUNTS_CHECK' | 'USER_SETTINGS' | 'CONFIG_BUNDLE'; readonly requestConsumed: true; readonly responseComplete: true; readonly responseDelivered: true; readonly modelSourceCredit: false })
  | (RecordIdentity & { readonly type: 'client-shutdown-begin'; readonly modelSourceCredit: false })
  | (RecordIdentity & { readonly type: 'websocket-negotiated'; readonly channelId: number; readonly transaction: number; readonly compression: NegotiatedCompression | null; readonly modelSourceCredit: false })
  | (RecordIdentity & { readonly type: 'request-incomplete' | 'response-incomplete'; readonly channelId: number; readonly transaction: number; readonly id?: number; readonly modelSourceCredit: false })
  | (RecordIdentity & { readonly type: 'closed'; readonly status: 'healthy' | 'failed'; readonly stats: WorkflowNativeBodyObserverStats });
export interface WorkflowNativeBodyObserverSettlement { readonly journal: WorkflowReviewOwnedReference; readonly stats: WorkflowNativeBodyObserverStats }
export interface WorkflowNativeBodyObserverInvocation {
  beginClientShutdown(): void;
  settle(): Promise<WorkflowNativeBodyObserverSettlement>;
  assertHealthy(): void;
}
export interface WorkflowNativeBodyObserverHandle {
  readonly port: number;
  readonly proxyUrl: string;
  readonly redactionEnvironment: Readonly<Record<string, string>>;
  beginInvocation(options: { readonly directory: string; readonly invocationId: string; readonly onFirstFailure: (failure: { readonly code: string }) => void | Promise<void> }): WorkflowNativeBodyObserverInvocation;
  close(): Promise<void>;
}

const HOST = 'chatgpt.com';
const BYTES = 65536;
const MODEL_PATHS = new Set(['/backend-api/codex/responses', '/backend-api/codex/responses/compact']);
const METADATA_PATHS = new Set(['/backend-api/wham/accounts/check', '/backend-api/wham/settings/user', '/backend-api/wham/config/bundle']);
const CHANNEL = Symbol('workflow-native-authenticated-channel');
type NativeSocket = Socket & { [CHANNEL]?: Channel };
type Fields = Record<string, unknown>;
type FirstFailure = (failure: { readonly code: string }) => void | Promise<void>;
interface Channel {
  id: number; pending: number; tail: Promise<unknown>; acceptedRequests: number; activeHttp: number;
  requests: number; completions: number; httpExchanges: number; localRefusals: number;
  partialHeader: boolean; upgrading: boolean; websocket: boolean; incomplete: boolean;
  requestClose: boolean; responseClose: boolean; parsers: WsParser[];
  wsSocketAssigned: boolean; wsTcpConnected: boolean; wsTlsReady: boolean; wsRequestFinished: boolean; wsResponseStatus: number | null;
}
interface WsParser { push(bytes: Buffer): Promise<void>; isIdle(): boolean; end(): void; abort(): void }
interface Recorder { write(bytes: Buffer): Promise<void>; plain(bytes: Buffer): void; compressed(bytes: Buffer): void; decoded(bytes: Buffer): void; finish(): Promise<void>; finishMessage(): void; abort(): void }
interface MessageIdentity { channel: Channel; transaction: number; direction: 'request' | 'response'; transport: 'wss' | 'https-http1'; path: string }
interface Compression { noContextTakeover: boolean; windowBits: number }
interface NegotiatedCompression { clientNoContextTakeover: boolean; serverNoContextTakeover: boolean; clientWindowBits: number; serverWindowBits: number }
const invocationBrands = new WeakSet<object>();
const factoryBrands = new WeakSet<object>();
function fault(code: string): Error & { code: string } { return Object.assign(new Error(code), { code }); }
function errorCode(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  return typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code) ? code : 'NATIVE_OBSERVER_PROTOCOL_FAILURE';
}
function routeCategory(req: IncomingMessage): RouteCategory {
  if (req.headers.host !== HOST) return 'OTHER';
  if (req.method === 'POST' && req.url === '/backend-api/codex/analytics-events/events') return 'ANALYTICS_EVENTS';
  if (req.method !== 'GET') return 'OTHER';
  switch (req.url) {
    case '/backend-api/wham/accounts/check': return 'ACCOUNTS_CHECK';
    case '/backend-api/wham/settings/user': return 'USER_SETTINGS';
    case '/backend-api/wham/config/bundle': return 'CONFIG_BUNDLE';
    case '/backend-api/wham/workspace-messages': return 'WORKSPACE_MESSAGES';
    case '/backend-api/wham/profiles/me': return 'PROFILE_ME';
    case '/backend-api/codex/models?client_version=0.159.1': return 'MODEL_CATALOG_01591';
    default: return 'OTHER';
  }
}
function drain(stream: Writable): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { stream.off('drain', ready); stream.off('error', failed); stream.off('close', closed); };
    const ready = () => { cleanup(); resolve(); }; const failed = (error: Error) => { cleanup(); reject(error); };
    const closed = () => { cleanup(); reject(fault('NATIVE_OBSERVER_STREAM_CLOSED')); };
    if (stream.destroyed) { closed(); return; } stream.once('drain', ready); stream.once('error', failed); stream.once('close', closed);
  });
}
function parseExtension(value: string | string[] | undefined, response = false): NegotiatedCompression | null {
  if (!value) return null;
  if (typeof value !== 'string' || value.length > 1024 || value.includes(',')) throw fault('NATIVE_OBSERVER_WS_EXTENSION');
  const fields = value.split(';').map(part => part.trim()); if (fields.shift() !== 'permessage-deflate') throw fault('NATIVE_OBSERVER_WS_EXTENSION');
  const result: NegotiatedCompression = { clientNoContextTakeover: false, serverNoContextTakeover: false, clientWindowBits: 15, serverWindowBits: 15 };
  const seen = new Set<string>();
  for (const field of fields) {
    const [key, raw] = field.split('='); if (seen.has(key!)) throw fault('NATIVE_OBSERVER_WS_EXTENSION_DUPLICATE'); seen.add(key!);
    if (key === 'client_no_context_takeover' && raw === undefined) result.clientNoContextTakeover = true;
    else if (key === 'server_no_context_takeover' && raw === undefined) result.serverNoContextTakeover = true;
    else if (key === 'client_max_window_bits' || key === 'server_max_window_bits') {
      if (raw === undefined && key === 'client_max_window_bits' && !response) continue;
      if (!/^(?:8|9|1[0-5])$/.test(raw ?? '')) throw fault('NATIVE_OBSERVER_WS_WINDOW_BITS');
      if (key === 'client_max_window_bits') result.clientWindowBits = Number(raw); else result.serverWindowBits = Number(raw);
    } else throw fault('NATIVE_OBSERVER_WS_EXTENSION_PARAMETER');
  }
  return result;
}
interface InvocationTransport { readonly handle: WorkflowNativeBodyObserverInvocation; ownSocket(socket: Socket): void; accept(socket: Socket, head: Buffer): void; dispose(): Promise<void> }

function createInvocation(options: { directory: string; invocationId: string; onFirstFailure: FirstFailure }, security: { context: SecureContext; certificates: readonly string[] }): InvocationTransport {
  if (!/^[A-Za-z0-9_.:-]{1,256}$/.test(options.invocationId)) throw fault('NATIVE_OBSERVER_INVOCATION_ID');
  mkdirSync(options.directory, { recursive: true }); const journal = new WorkflowReviewOwnedFile(options.directory, 'native-body-journal.jsonl', true);
  const pending = new Set<Promise<unknown>>(), sockets = new Set<Socket>(), requestsInFlight = new Set<ClientRequest>(), responsesInFlight = new Set<IncomingMessage>(), closes = new Set<Promise<void>>(), channels = new Set<Channel>();
  let seq = 0, channelId = 0, transaction = 0, bodyId = 0, accepted = 0, requests = 0, responseEvents = 0, failures = 0, peakWorkingChunk = 0;
  let closing = false, settled: WorkflowNativeBodyObserverSettlement | null = null, settling: Promise<WorkflowNativeBodyObserverSettlement> | null = null, journalFailure: unknown = null, failureNotified = false;
  const stats = (): WorkflowNativeBodyObserverStats => Object.freeze({ accepted, requests, responseEvents, failures, peakWorkingChunk, bodySizeCeiling: null, corpusSizeCeiling: null });
  function event(type: string, fields: Fields = {}): void {
    if (settled) throw fault('NATIVE_OBSERVER_EVENT_AFTER_SETTLEMENT');
    if (journalFailure) return;
    const bytes = Buffer.from(JSON.stringify({ seq: ++seq, at: new Date().toISOString(), invocationId: options.invocationId, type, ...fields }) + '\n');
    try { if (bytes.length > BYTES) throw fault('NATIVE_OBSERVER_CONTROL_RECORD_LIMIT'); journal.append(bytes); }
    catch (error) { journalFailure = error; failures++; notifyFailure('NATIVE_OBSERVER_JOURNAL_WRITE_FAILED'); }
  }
  function track<T>(work: Promise<T>): Promise<T> { const joined = work.finally(() => pending.delete(joined)); pending.add(joined); joined.catch(() => {}); return joined; }
  function trackChannel<T>(channel: Channel, work: Promise<T>): Promise<T> { channel.pending++; const joined = track(work.finally(() => { channel.pending--; })); channel.tail = Promise.allSettled([channel.tail, joined]); return joined; }
  function notifyFailure(code: string): void { if (failureNotified) return; failureNotified = true; try { const work = options.onFirstFailure({ code }); if (work) track(Promise.resolve(work).catch(() => { failures++; event('failure', { code: 'NATIVE_OBSERVER_FAILURE_CALLBACK_REJECTED' }); })); } catch { failures++; event('failure', { code: 'NATIVE_OBSERVER_FAILURE_CALLBACK_THROWN' }); } }
  function fail(error: unknown, fields: Fields = {}): void { failures++; const code = errorCode(error); event('failure', { code, ...fields }); notifyFailure(code); }
  function ownClose<T extends Socket | ClientRequest | IncomingMessage>(value: T, owners: Set<T>): void { if (owners.has(value) || ('closed' in value && value.closed === true)) return; owners.add(value); const ended = new Promise<void>(resolve => value.once('close', () => { owners.delete(value); resolve(); })); closes.add(ended); ended.finally(() => closes.delete(ended)).catch(() => {}); }
  function ownRequest(request: ClientRequest): ClientRequest { ownClose(request, requestsInFlight); request.once('socket', socket => ownClose(socket, sockets)); return request; }
  function idle(channel: Channel): boolean { return channel.pending === 0 && channel.activeHttp === 0 && !channel.partialHeader && !channel.upgrading && !channel.incomplete && channel.requests === channel.completions && channel.parsers.every(parser => parser.isIdle()); }
  function failureState(channel: Channel): FailureState { return { upgrading: channel.upgrading, partialHeader: channel.partialHeader, activeHttp: channel.activeHttp, pending: channel.pending, acceptedRequests: channel.acceptedRequests, requests: channel.requests, completions: channel.completions, parserIdle: channel.parsers.every(parser => parser.isIdle()), clientShutdownDeclared: closing, wsSocketAssigned: channel.wsSocketAssigned, wsTcpConnected: channel.wsTcpConnected, wsTlsReady: channel.wsTlsReady, wsRequestFinished: channel.wsRequestFinished, wsResponseStatus: channel.wsResponseStatus }; }
  async function joinedChannel(channel: Channel): Promise<void> { for (;;) { const tail = channel.tail; await tail; if (tail === channel.tail) return; } }
  async function channelError(error: unknown, channel: Channel, peer: string): Promise<void> {
    await joinedChannel(channel); const code = errorCode(error); let classification: string | null = null;
    if (code === 'EOF' && idle(channel) && channel.httpExchanges && !channel.websocket) classification = channel.localRefusals ? 'LOCAL_POLICY_REFUSAL_COMPLETE' : 'NORMAL_COMPLETE_HTTP_EOF';
    else if (code === 'EOF' && idle(channel) && channel.websocket && channel.requestClose && channel.responseClose) classification = 'NORMAL_COMPLETE_WS_CLOSE_HANDSHAKE';
    else if ((code === 'EOF' || code === 'ECONNRESET') && closing && idle(channel)) classification = channel.acceptedRequests ? 'NORMAL_IDLE_CLOSE_AFTER_DECLARED_SHUTDOWN' : 'NORMAL_UNUSED_CLOSE_AFTER_DECLARED_SHUTDOWN';
    if (classification) event('channel-close', { channelId: channel.id, peer, classification, modelSourceCredit: false }); else fail(error, { channelId: channel.id, peer, state: failureState(channel) });
  }
  function pieces(bytes: Buffer, consume: (piece: Buffer) => void): void { for (let offset = 0; offset < bytes.length; offset += BYTES) { const piece = bytes.subarray(offset, offset + BYTES); peakWorkingChunk = Math.max(peakWorkingChunk, piece.length); consume(piece); } }
  function decoderFor(encoding: string): Transform | null {
    const codecOptions = { chunkSize: BYTES, highWaterMark: BYTES };
    if (encoding === 'gzip') return zlib.createGunzip(codecOptions);
    if (encoding === 'deflate') return zlib.createInflate(codecOptions);
    if (encoding === 'zstd') return zlib.createZstdDecompress(codecOptions);
    if (['identity', '', 'permessage-deflate'].includes(encoding)) return null; throw fault('NATIVE_OBSERVER_BODY_ENCODING');
  }
  function requestRecorder(identity: MessageIdentity, encoding: string): Recorder {
    const id = ++bodyId, stem = `native-request-${String(id).padStart(8, '0')}`;
    const decoder = decoderFor(encoding); let wire!: WorkflowReviewOwnedFile, decoded!: WorkflowReviewOwnedFile;
    try { wire = new WorkflowReviewOwnedFile(options.directory, stem + '.wire', true); decoded = new WorkflowReviewOwnedFile(options.directory, stem + '.decoded', true); }
    catch (error) { try { wire?.close(); } finally { decoder?.destroy(); } throw error; }
    let done = false, decodeError: unknown = null;
    const plain = (bytes: Buffer) => pieces(bytes, piece => decoded.append(piece));
    decoder?.on('data', plain); decoder?.on('error', error => { decodeError = error; });
    function seal(): void { if (done || decodeError) throw decodeError ?? fault('NATIVE_OBSERVER_REQUEST_SETTLED'); done = true; try { const wireRef = wire.seal(), decodedRef = decoded.seal(); requests++; identity.channel.requests++; event('body', { id, channelId: identity.channel.id, transaction: identity.transaction, direction: 'request', transport: identity.transport, path: identity.path, encoding, wire: wireRef, decoded: decodedRef, complete: true }); } finally { try { wire.close(); } finally { decoded.close(); } } }
    return {
      async write(bytes) { if (done || decodeError) throw decodeError ?? fault('NATIVE_OBSERVER_REQUEST_SETTLED'); pieces(bytes, piece => wire.append(piece)); if (decoder) await new Promise<void>((resolve, reject) => decoder.write(bytes, error => error ? reject(error) : resolve())); else plain(bytes); if (decodeError) throw decodeError; },
      plain(bytes) { pieces(bytes, piece => wire.append(piece)); plain(bytes); }, compressed(bytes) { pieces(bytes, piece => wire.append(piece)); }, decoded: plain,
      async finish() { if (decoder) { const ended = once(decoder, 'end'); decoder.end(); await ended; } seal(); }, finishMessage: seal,
      abort() { if (done) return; done = true; decoder?.destroy(); identity.channel.incomplete = true; wire.close(); decoded.close(); event('request-incomplete', { id, channelId: identity.channel.id, transaction: identity.transaction, modelSourceCredit: false }); },
    };
  }
  function responseRecorder(identity: MessageIdentity, encoding: string): Recorder {
    let done = false, completions = 0, decodeError: unknown = null;
    const emit = (receipt: WorkflowNativeModelEventReceipt) => { if (receipt.kind === 'model-event') { responseEvents++; if (receipt.eventType === 'response.completed') { completions++; identity.channel.completions++; } event('response-receipt', { channelId: identity.channel.id, transaction: identity.transaction, transport: identity.transport, path: identity.path, ...receipt }); } else event('native-control-discarded', { channelId: identity.channel.id, transaction: identity.transaction, transport: identity.transport, category: receipt.kind, ...(receipt.controlType ? { knownControlType: receipt.controlType } : {}), modelSourceCredit: false }); };
    const parser: WorkflowNativeModelEventParser = identity.transport === 'wss' ? createWorkflowNativeModelEventParser({ emit }) : createWorkflowNativeSseParser({ emit });
    const decoded = (bytes: Buffer) => pieces(bytes, piece => parser.feed(piece)); const decoder = decoderFor(encoding);
    decoder?.on('data', bytes => { try { decoded(bytes); } catch (error) { decodeError = error; } }); decoder?.on('error', error => { decodeError = error; });
    const finish = () => { if (done || decodeError) throw decodeError ?? fault('NATIVE_OBSERVER_RESPONSE_SETTLED'); parser.finish(); if (identity.transport === 'https-http1' && completions !== 1) throw fault('NATIVE_OBSERVER_HTTP_COMPLETION_REQUIRED'); done = true; };
    return {
      async write(bytes) { if (done || decodeError) throw decodeError ?? fault('NATIVE_OBSERVER_RESPONSE_SETTLED'); if (decoder) await new Promise<void>((resolve, reject) => decoder.write(bytes, error => error ? reject(error) : resolve())); else decoded(bytes); if (decodeError) throw decodeError; },
      plain: decoded, compressed() {}, decoded,
      async finish() { if (decoder) { const ended = once(decoder, 'end'); decoder.end(); await ended; } finish(); }, finishMessage: finish,
      abort() { if (done) return; done = true; decoder?.destroy(); parser.abort(); identity.channel.incomplete = true; event('response-incomplete', { channelId: identity.channel.id, transaction: identity.transaction, modelSourceCredit: false }); },
    };
  }
  async function forward(source: Readable, target: Writable, recorder: Recorder, identity: MessageIdentity): Promise<boolean> {
    try { for await (const bytes of source) { if (!Buffer.isBuffer(bytes)) throw fault('NATIVE_OBSERVER_BINARY_STREAM_REQUIRED'); for (let offset = 0; offset < bytes.length; offset += BYTES) { const piece = bytes.subarray(offset, offset + BYTES); await recorder.write(piece); if (!target.write(piece)) await drain(target); } } await recorder.finish(); await new Promise<void>((resolve, reject) => {
      const cleanup = () => { target.off('finish', ready); target.off('error', failed); target.off('close', closed); };
      const ready = () => { cleanup(); resolve(); }, failed = (error: Error) => { cleanup(); reject(error); }, closed = () => { if (target.writableFinished) ready(); else failed(fault('NATIVE_OBSERVER_STREAM_CLOSED_BEFORE_FINISH')); };
      if (target.destroyed) { closed(); return; } target.once('finish', ready); target.once('error', failed); target.once('close', closed); try { target.end(); } catch (error) { cleanup(); reject(error); }
    }); return true; }
    catch (error) { identity.channel.incomplete = true; recorder.abort(); fail(error, { channelId: identity.channel.id, transaction: identity.transaction }); source.destroy(); target.destroy(); return false; }
  }
  function upstreamOptions(req: IncomingMessage): https.RequestOptions { const { 'proxy-authorization': _proxyAuthorization, 'proxy-connection': _proxyConnection, ...headers } = req.headers; return { host: HOST, port: 443, servername: HOST, rejectUnauthorized: true, ca: [...security.certificates], method: req.method, path: req.url, headers, agent: false }; }
  function admitted(req: IncomingMessage): boolean { return req.headers.host === HOST && MODEL_PATHS.has(req.url ?? '') && ['GET', 'POST'].includes(req.method ?? ''); }
  function bodyless(req: IncomingMessage): boolean { return req.method === 'GET' && !req.headers.upgrade && !req.headers['transfer-encoding'] && (!req.headers['content-length'] || req.headers['content-length'] === '0'); }
  function metadata(req: IncomingMessage, res: ServerResponse, channel: Channel): void {
    const id = ++transaction, category = req.url === '/backend-api/wham/accounts/check' ? 'ACCOUNTS_CHECK' : req.url === '/backend-api/wham/settings/user' ? 'USER_SETTINGS' : 'CONFIG_BUNDLE'; channel.activeHttp++;
    const consumed = new Promise<void>((resolve, reject) => { const cleanup = () => { req.off('end', ended); req.off('close', closed); req.off('error', failed); }; const ended = () => { cleanup(); resolve(); }; const failed = () => { cleanup(); reject(fault('NATIVE_OBSERVER_METADATA_REQUEST_INCOMPLETE')); }; const closed = () => { if (req.readableEnded) ended(); else failed(); }; if (req.readableEnded) resolve(); else { req.once('end', ended); req.once('close', closed); req.once('error', failed); } }); consumed.catch(() => {}); event('metadata-request', { channelId: channel.id, transaction: id, category, modelSourceCredit: false });
    const request = ownRequest(https.request(upstreamOptions(req), response => { ownClose(response, responsesInFlight); if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) { fail(fault('NATIVE_OBSERVER_METADATA_STATUS'), { channelId: channel.id, transaction: id }); response.destroy(); res.writeHead(502); res.end(); return; }
      let complete = false; response.once('end', () => { complete = true; }); const sent = new Promise<boolean>(resolve => { res.once('finish', () => resolve(true)); res.once('close', () => resolve(res.writableFinished)); }); res.writeHead(response.statusCode, response.headers); response.pipe(res); trackChannel(channel, Promise.all([consumed, sent]).then(([, finished]) => { if (finished && complete) { channel.httpExchanges++; event('metadata-completed', { channelId: channel.id, transaction: id, category, requestConsumed: true, responseComplete: true, responseDelivered: true, modelSourceCredit: false }); } else channel.incomplete = true; channel.activeHttp--; }).catch(error => { channel.incomplete = true; fail(error); })); response.once('error', error => { channel.incomplete = true; fail(error, { channelId: channel.id, transaction: id }); res.destroy(); }); }));
    request.once('error', error => { channel.incomplete = true; fail(error, { channelId: channel.id, transaction: id }); if (!res.headersSent) res.writeHead(502); res.end(); }); req.resume(); request.end();
  }
  const inner = http.createServer({ maxHeaderSize: 16384, highWaterMark: BYTES }, (req, res) => {
    const channel = (req.socket as NativeSocket)[CHANNEL]; if (!channel) { res.writeHead(403); res.end(); return; } channel.partialHeader = false; channel.acceptedRequests++;
    if (closing || settled || failures) { fail(fault('NATIVE_OBSERVER_REQUEST_AFTER_END'), { channelId: channel.id }); req.resume(); res.writeHead(503); res.end(); return; }
    if (req.headers.host === HOST && METADATA_PATHS.has(req.url ?? '') && bodyless(req)) { metadata(req, res, channel); return; }
    if (!admitted(req)) { event('denied', { reason: 'FIXED_MODEL_ROUTE_ONLY', category: routeCategory(req), channelId: channel.id, modelSourceCredit: false }); fail(fault('NATIVE_OBSERVER_ROUTE_REFUSED'), { channelId: channel.id }); req.resume(); res.writeHead(403); res.end(); return; }
    const id = ++transaction; channel.activeHttp++; const identity: MessageIdentity = { channel, transaction: id, direction: 'request', transport: 'https-http1', path: req.url! }; let requestBody: Recorder;
    try { requestBody = requestRecorder(identity, String(req.headers['content-encoding'] ?? 'identity')); } catch (error) { fail(error); req.resume(); res.writeHead(502); res.end(); return; }
    const request = ownRequest(https.request(upstreamOptions(req), response => { ownClose(response, responsesInFlight); if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) { fail(fault('NATIVE_OBSERVER_MODEL_STATUS'), { channelId: channel.id, transaction: id }); response.destroy(); res.writeHead(502); res.end(); return; }
      const responseIdentity: MessageIdentity = { ...identity, direction: 'response' }; let body: Recorder; try { body = responseRecorder(responseIdentity, String(response.headers['content-encoding'] ?? 'identity')); } catch (error) { fail(error); response.destroy(); res.writeHead(502); res.end(); return; }
      res.writeHead(response.statusCode, response.headers); trackChannel(channel, forward(response, res, body, responseIdentity).then(complete => { if (complete) channel.httpExchanges++; channel.activeHttp--; })); }));
    request.once('error', error => { requestBody.abort(); fail(error, { channelId: channel.id, transaction: id }); req.destroy(); if (!res.headersSent) res.writeHead(502); res.end(); }); trackChannel(channel, forward(req, request, requestBody, identity));
  });
  inner.on('clientError', (error, socket) => { const channel = (socket as NativeSocket)[CHANNEL]; if (channel) track(channelError(error, channel, 'native-http-parser')); else fail(error); socket.destroy(); });
  function wsParser(masked: boolean, identity: MessageIdentity, compression: Compression | null): WsParser {
    let header = Buffer.alloc(0), headerBytes = 2, remaining = 0n, mask: Buffer | null = null, maskOffset = 0, final = false, opcode = 0;
    let message: Recorder | null = null, frameOpen = false, compressed = false, inflater: zlib.InflateRaw | null = null, inflateError: unknown = null, control = Buffer.alloc(0);
    function inflaterForMessage(): void { if (inflater) return; const codec = { chunkSize: BYTES, highWaterMark: BYTES, windowBits: compression!.windowBits }; inflater = zlib.createInflateRaw(codec);
      inflater.on('data', bytes => { try { if (!message) throw fault('NATIVE_OBSERVER_WS_DECODE_STATE'); message.decoded(bytes); } catch (error) { inflateError = error; } }); inflater.on('error', error => { inflateError = error; }); }
    function frameHeader(): void {
      final = !!(header[0]! & 128); opcode = header[0]! & 15;
      if ((header[0]! & 0x30) || !!(header[1]! & 128) !== masked) throw fault('NATIVE_OBSERVER_WS_FLAGS');
      const rsv1 = !!(header[0]! & 0x40); if (rsv1 && (!compression || opcode === 0 || opcode >= 8)) throw fault('NATIVE_OBSERVER_WS_COMPRESSION_FLAG');
      const marker = header[1]! & 127; remaining = marker === 127 ? header.readBigUInt64BE(2) : BigInt(marker === 126 ? header.readUInt16BE(2) : marker);
      const lengthBytes = marker === 127 ? 10 : marker === 126 ? 4 : 2; mask = masked ? header.subarray(lengthBytes, lengthBytes + 4) : null; maskOffset = 0;
      if (opcode >= 8) { if (!final || remaining > 125n || ![8, 9, 10].includes(opcode)) throw fault('NATIVE_OBSERVER_WS_CONTROL'); control = Buffer.alloc(0); }
      else if (opcode === 0) { if (!message) throw fault('NATIVE_OBSERVER_WS_CONTINUATION'); }
      else if (opcode === 1 && !message) { if (identity.direction === 'request' && closing) throw fault('NATIVE_OBSERVER_MODEL_AFTER_SHUTDOWN'); compressed = rsv1; message = identity.direction === 'request' ? requestRecorder(identity, compressed ? 'permessage-deflate' : 'identity') : responseRecorder(identity, compressed ? 'permessage-deflate' : 'identity'); if (compressed) inflaterForMessage(); }
      else throw fault('NATIVE_OBSERVER_WS_MESSAGE_ORDER'); frameOpen = true;
    }
    async function endFrame(): Promise<void> {
      if (opcode < 8 && final) {
        if (compressed) { if (inflateError) throw inflateError; const target = inflater!; await new Promise<void>((resolve, reject) => { const failed = (error: Error) => { target.off('error', failed); reject(error); }; target.once('error', failed); target.write(Buffer.from([0, 0, 255, 255])); target.flush(zlib.constants.Z_SYNC_FLUSH, () => { target.off('error', failed); if (inflateError) reject(inflateError); else resolve(); }); }); if (inflateError) throw inflateError; if (compression!.noContextTakeover) { target.destroy(); inflater = null; } }
        message!.finishMessage(); message = null;
      }
      if (opcode === 8) { if (control.length === 1) throw fault('NATIVE_OBSERVER_WS_CLOSE_PAYLOAD'); if (control.length >= 2) { const status = control.readUInt16BE(0); if (status < 1000 || status >= 5000 || [1004, 1005, 1006, 1015].includes(status)) throw fault('NATIVE_OBSERVER_WS_CLOSE_STATUS'); new TextDecoder('utf8', { fatal: true }).decode(control.subarray(2)); } const key = identity.direction === 'request' ? 'requestClose' : 'responseClose'; if (identity.channel[key]) throw fault('NATIVE_OBSERVER_WS_DUPLICATE_CLOSE'); identity.channel[key] = true; }
      frameOpen = false; header = Buffer.alloc(0); headerBytes = 2;
    }
    return {
      async push(bytes) { let offset = 0; while (offset < bytes.length || (frameOpen && remaining === 0n)) {
        if (!frameOpen) { const take = Math.min(headerBytes - header.length, bytes.length - offset); if (take) { header = Buffer.concat([header, bytes.subarray(offset, offset + take)]); offset += take; } if (header.length < headerBytes) return;
          if (headerBytes === 2) { const marker = header[1]! & 127; headerBytes = (marker === 127 ? 10 : marker === 126 ? 4 : 2) + (masked ? 4 : 0); if (header.length < headerBytes) continue; } frameHeader(); }
        if (remaining === 0n) { await endFrame(); continue; } const available = Math.min(bytes.length - offset, BYTES); if (!available) return; const take = Number(remaining < BigInt(available) ? remaining : BigInt(available));
        const piece = mask ? Buffer.from(bytes.subarray(offset, offset + take)) : bytes.subarray(offset, offset + take); if (mask) for (let at = 0; at < piece.length; at++) piece[at] = piece[at]! ^ mask[(maskOffset + at) % 4]!;
        if (opcode < 8) { if (compressed) { message!.compressed(piece); if (inflateError) throw inflateError; if (!inflater!.write(piece)) await drain(inflater!); } else message!.plain(piece); } else if (opcode === 8) control = Buffer.concat([control, piece]);
        maskOffset = (maskOffset + take) % 4; offset += take; remaining -= BigInt(take); if (remaining === 0n) await endFrame();
      } }, isIdle: () => !message && !frameOpen && header.length === 0,
      end() { if (message || frameOpen || header.length) { identity.channel.incomplete = true; throw fault('NATIVE_OBSERVER_WS_TRUNCATED'); } inflater?.destroy(); },
      abort() { if (message || frameOpen || header.length) identity.channel.incomplete = true; inflater?.destroy(); message?.abort(); message = null; },
    };
  }
  inner.on('upgrade', (req, clientStream, head) => {
    const client = clientStream as Socket, channel = (req.socket as NativeSocket)[CHANNEL]; if (!channel) { client.destroy(); return; } channel.partialHeader = false; channel.acceptedRequests++; channel.upgrading = true;
    if (closing || settled || failures || !admitted(req) || req.method !== 'GET') { event('denied', { reason: 'FIXED_MODEL_ROUTE_ONLY', category: routeCategory(req), channelId: channel.id, modelSourceCredit: false }); fail(fault('NATIVE_OBSERVER_WS_ROUTE'), { channelId: channel.id }); client.destroy(); return; }
    let offered: NegotiatedCompression | null; try { offered = parseExtension(req.headers['sec-websocket-extensions']); } catch (error) { fail(error); client.destroy(); return; }
    const id = ++transaction, request = ownRequest(https.request(upstreamOptions(req)));
    request.once('socket', socket => { channel.wsSocketAssigned = true; socket.once('connect', () => { channel.wsTcpConnected = true; }); socket.once('secureConnect', () => { channel.wsTlsReady = true; }); });
    request.once('finish', () => { channel.wsRequestFinished = true; });
    request.on('upgrade', (response, remoteStream, remoteHead) => {
      channel.wsResponseStatus = response.statusCode ?? null;
      const remote = remoteStream as Socket; let negotiated: NegotiatedCompression | null;
      try { negotiated = parseExtension(response.headers['sec-websocket-extensions'], true); if (negotiated && !offered) throw fault('NATIVE_OBSERVER_WS_UNSOLICITED_COMPRESSION'); if (response.statusCode !== 101) throw fault('NATIVE_OBSERVER_WS_UPGRADE'); } catch (error) { fail(error); client.destroy(); remote.destroy(); return; }
      channel.websocket = true; channel.upgrading = false; event('websocket-negotiated', { channelId: channel.id, transaction: id, compression: negotiated, modelSourceCredit: false });
      const lines: string[] = []; for (let at = 0; at < response.rawHeaders.length; at += 2) lines.push(`${response.rawHeaders[at]}: ${response.rawHeaders[at + 1]}\r\n`); client.write(`HTTP/1.1 101 Switching Protocols\r\n${lines.join('')}\r\n`);
      const base: MessageIdentity = { channel, transaction: id, direction: 'request', transport: 'wss', path: req.url! };
      const parsers = [wsParser(true, base, negotiated ? { noContextTakeover: negotiated.clientNoContextTakeover, windowBits: negotiated.clientWindowBits } : null), wsParser(false, { ...base, direction: 'response' }, negotiated ? { noContextTakeover: negotiated.serverNoContextTakeover, windowBits: negotiated.serverWindowBits } : null)]; channel.parsers = parsers;
      const relay = (source: Socket, target: Socket, parser: WsParser, initial: Buffer, peer: string): void => {
        let work = Promise.resolve(); const feed = (bytes: Buffer) => { source.pause(); work = trackChannel(channel, work.then(async () => { await parser.push(bytes); if (!target.write(bytes)) await drain(target); source.resume(); }).catch(error => { channel.incomplete = true; parser.abort(); fail(error, { channelId: channel.id, transaction: id }); source.destroy(); target.destroy(); })); };
        if (initial.length) feed(initial); source.on('data', feed); source.once('end', () => track(work.then(() => { try { parser.end(); target.end(); } catch (error) { fail(error); target.destroy(); } }))); source.once('close', () => track(work.then(() => parser.abort()))); source.on('error', error => { target.destroy(); track(channelError(error, channel, peer)); });
      };
      ownClose(remote, sockets); relay(client, remote, parsers[0]!, head, 'native-ws'); relay(remote, client, parsers[1]!, remoteHead, 'upstream-ws');
    }); request.once('response', response => { channel.wsResponseStatus = response.statusCode ?? null; ownClose(response, responsesInFlight); response.resume(); fail(fault('NATIVE_OBSERVER_WS_UPGRADE_REFUSED'), { channelId: channel.id, transaction: id, state: failureState(channel) }); client.destroy(); }); request.once('error', error => { fail(error, { channelId: channel.id, transaction: id, state: failureState(channel) }); client.destroy(); }); request.end();
  });
  const handle: WorkflowNativeBodyObserverInvocation = Object.freeze({
    beginClientShutdown() { if (!invocationBrands.has(handle) || closing || settled) throw fault('NATIVE_OBSERVER_SHUTDOWN_STATE'); closing = true; event('client-shutdown-begin', { modelSourceCredit: false }); },
    settle() { if (settled) return Promise.resolve(settled); if (settling) return settling; settling = (async () => { let firstFailure: unknown = journalFailure; const remember = (error: unknown) => { firstFailure ??= error; };
      try { for (const channel of channels) if (channel.activeHttp || channel.upgrading || channel.partialHeader || channel.requests !== channel.completions || channel.parsers.some(parser => !parser.isIdle())) { channel.incomplete = true; fail(fault('NATIVE_OBSERVER_INCOMPLETE_SETTLEMENT'), { channelId: channel.id, state: failureState(channel) }); } } catch (error) { remember(error); }
      for (const request of requestsInFlight) { try { request.destroy(); } catch (error) { remember(error); } } for (const response of responsesInFlight) { try { response.destroy(); } catch (error) { remember(error); } } for (const socket of sockets) { try { socket.destroy(); } catch (error) { remember(error); } }
      while (closes.size || pending.size) { await Promise.allSettled([...closes, ...pending]); await new Promise<void>(resolve => setImmediate(resolve)); }
      let reference: WorkflowReviewOwnedReference | undefined; try { event('closed', { status: failures ? 'failed' : 'healthy', stats: stats() }); reference = journal.seal(); } catch (error) { remember(error); } finally { try { journal.close(); } catch (error) { remember(error); } }
      firstFailure ??= journalFailure; if (firstFailure) throw firstFailure; if (!reference) throw fault('NATIVE_OBSERVER_JOURNAL_UNSEALED'); settled = Object.freeze({ journal: reference, stats: stats() }); return settled;
    })(); return settling; },
    assertHealthy() { if (!invocationBrands.has(handle) || failures) throw fault('NATIVE_OBSERVER_FAILED'); },
  }); invocationBrands.add(handle);
  return { handle, ownSocket(socket) { ownClose(socket, sockets); if (closing || settling || settled || failures) socket.destroy(); }, accept(socket, head) { if (closing || settling || settled || failures) { socket.destroy(); return; } const channel: Channel = { id: ++channelId, pending: 0, tail: Promise.resolve(), acceptedRequests: 0, activeHttp: 0, requests: 0, completions: 0, httpExchanges: 0, localRefusals: 0, partialHeader: false, upgrading: false, websocket: false, incomplete: false, requestClose: false, responseClose: false, parsers: [], wsSocketAssigned: false, wsTcpConnected: false, wsTlsReady: false, wsRequestFinished: false, wsResponseStatus: null };
      accepted++; channels.add(channel); ownClose(socket, sockets); socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) socket.unshift(head); const secured = new tls.TLSSocket(socket, { isServer: true, secureContext: security.context, ALPNProtocols: ['http/1.1'] }); ownClose<Socket>(secured, sockets); (secured as NativeSocket)[CHANNEL] = channel;
      secured.on('data', () => { if (!channel.websocket && !channel.upgrading && channel.activeHttp === 0) channel.partialHeader = true; }); secured.on('error', error => track(channelError(error, channel, 'native-tls'))); secured.once('end', () => track(channelError(fault('EOF'), channel, 'native-tls'))); inner.emit('connection', secured);
      secured.once('close', () => { track(joinedChannel(channel).then(() => { if (!idle(channel) && !failures) fail(fault('NATIVE_OBSERVER_INCOMPLETE_CHANNEL'), { channelId: channel.id }); channels.delete(channel); })); });
    }, async dispose() { try { await handle.settle(); } finally { inner.close(); } } };
}

/** Native-only APIs are checked at construction; importing ordinary workflows stays safe on Node20. */
export async function startWorkflowNativeBodyObserver(options: { readonly secureContext: SecureContext; readonly upstreamCertificates: readonly string[] }): Promise<WorkflowNativeBodyObserverHandle> {
  if (typeof tls.getCACertificates !== 'function' || typeof zlib.createZstdDecompress !== 'function' || !options.upstreamCertificates.length) throw fault('workflow_native_body_observer_unavailable');
  const secret = randomBytes(32).toString('hex'), basic = Buffer.from(`native:${secret}`).toString('base64'), expected = Buffer.from(`Basic ${basic}`), sockets = new Set<Socket>(), socketOwners = new WeakMap<Socket, InvocationTransport | null>(); let active: InvocationTransport | null = null, closed = false;
  const proxy = http.createServer({ maxHeaderSize: 16384 }, (req, res) => { req.resume(); res.writeHead(403); res.end(); });
  proxy.on('connection', socket => { sockets.add(socket); socketOwners.set(socket, active); active?.ownSocket(socket); socket.once('close', () => sockets.delete(socket)); if (sockets.size > 8) socket.destroy(); });
  proxy.on('connect', (req, socket, head) => { const owner = socketOwners.get(socket as Socket), received = Buffer.from(req.headers['proxy-authorization'] ?? ''); if (closed || !active || owner !== active || req.url !== `${HOST}:443` || received.length !== expected.length || !timingSafeEqual(received, expected)) { socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'); return; } owner.accept(socket as Socket, head); });
  proxy.on('clientError', (_error, socket) => socket.destroy()); await new Promise<void>((resolve, reject) => { proxy.once('error', reject); proxy.listen(0, '127.0.0.1', resolve); }); const address = proxy.address(); if (!address || typeof address === 'string') throw fault('NATIVE_OBSERVER_LISTENER'); const port = address.port, proxyUrl = `http://native:${secret}@127.0.0.1:${port}`;
  const handle: WorkflowNativeBodyObserverHandle = Object.freeze({ port, proxyUrl, redactionEnvironment: Object.freeze({ WORKFLOW_PRIVATE_PROXY_SECRET: secret, WORKFLOW_PRIVATE_PROXY_URL: proxyUrl, WORKFLOW_PRIVATE_PROXY_BASIC: basic }),
    beginInvocation(invocationOptions: Parameters<WorkflowNativeBodyObserverHandle['beginInvocation']>[0]) { if (!factoryBrands.has(handle) || closed || active) throw fault('NATIVE_OBSERVER_INVOCATION_STATE'); active = createInvocation(invocationOptions, { context: options.secureContext, certificates: options.upstreamCertificates }); const original = active; const invocation = original.handle; return Object.freeze({ beginClientShutdown: () => invocation.beginClientShutdown(), assertHealthy: () => invocation.assertHealthy(), async settle() { const result = await invocation.settle(); if (active === original) active = null; return result; } }); },
    async close() { if (closed) return; closed = true; let firstFailure: unknown; try { await active?.dispose(); } catch (error) { firstFailure = error; } for (const socket of sockets) { try { socket.destroy(); } catch (error) { firstFailure ??= error; } } try { await new Promise<void>((resolve, reject) => proxy.close(error => error ? reject(error) : resolve())); } catch (error) { firstFailure ??= error; } if (firstFailure) throw firstFailure; },
  }); factoryBrands.add(handle); return handle;
}
