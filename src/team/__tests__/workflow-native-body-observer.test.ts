import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import zlib from 'node:zlib';
import { realpathSync, mkdtempSync, readFileSync, rmSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve, relative, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { connect, type Socket } from 'node:net';
import { once } from 'node:events';
import { startWorkflowNativeBodyObserver, type WorkflowNativeBodyObserverHandle } from '../workflow-native-body-observer.js';
import { WorkflowReviewOwnedFile } from '../workflow-review-source.js';
import { createNativeBodyTlsFixture } from './helpers/native-body-tls-fixture.js';
import { iterateWorkflowNativeObservedTransactions } from '../workflow-native-review-observer.js';

const nativeApis = typeof tls.getCACertificates === 'function' && typeof zlib.createZstdDecompress === 'function';
const originalRequest = https.request.bind(https);
let fixture: ReturnType<typeof createNativeBodyTlsFixture>;
const owned: string[] = [], handles: WorkflowNativeBodyObserverHandle[] = [], servers: https.Server[] = [], socketOwners = new Set<Socket>();
const directory = () => { const value = realpathSync(mkdtempSync(join(tmpdir(), 'native-body-test-'))); owned.push(value); return value; };
const delay = () => new Promise(resolve => setTimeout(resolve, 5));
async function upstream(handler?: Parameters<typeof https.createServer>[1]) {
  const server = https.createServer({ key: fixture.key, cert: fixture.cert }, handler); server.on('connection', stream => { const socket = stream as Socket; socketOwners.add(socket); socket.once('close', () => socketOwners.delete(socket)); });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); return server;
}
function route(server: https.Server) {
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('fixture_listener');
  vi.spyOn(https, 'request').mockImplementation((...args: unknown[]) => {
    const options = args[0] as https.RequestOptions; const callback = typeof args[1] === 'function' ? args[1] as (response: http.IncomingMessage) => void : undefined;
    expect(options.host).toBe('chatgpt.com'); expect(options.port).toBe(443); expect(options.servername).toBe('chatgpt.com'); expect(options.rejectUnauthorized).toBe(true);
    expect(options.headers).not.toHaveProperty('proxy-authorization'); expect(options.headers).not.toHaveProperty('proxy-connection');
    return originalRequest({ ...options, host: '127.0.0.1', port: address.port }, callback);
  });
}
async function factory() { const value = await startWorkflowNativeBodyObserver({ secureContext: fixture.context, upstreamCertificates: [fixture.ca.toString()] }); handles.push(value); return value; }
async function tunnel(value: WorkflowNativeBodyObserverHandle, authenticated = true, target = 'chatgpt.com:443'): Promise<{ status: number; raw: Socket; secure?: tls.TLSSocket }> {
  const url = new URL(value.proxyUrl); const authorization = 'Basic ' + Buffer.from(`${url.username}:${url.password}`).toString('base64');
  return new Promise((resolve, reject) => { const request = http.request({ host: '127.0.0.1', port: value.port, method: 'CONNECT', path: target, headers: { 'proxy-authorization': authenticated ? authorization : 'Basic wrong' }, agent: false });
    request.once('connect', (response, raw) => { socketOwners.add(raw); raw.once('close', () => socketOwners.delete(raw)); if (response.statusCode !== 200) { raw.destroy(); resolve({ status: response.statusCode!, raw }); return; }
      const secure = tls.connect({ socket: raw, servername: 'chatgpt.com', ca: fixture.ca }); secure.once('secureConnect', () => resolve({ status: 200, raw, secure })); secure.once('error', reject); }); request.once('error', reject); request.end(); });
}
async function request(value: WorkflowNativeBodyObserverHandle, path: string, body: Buffer, method = 'POST', headers: http.OutgoingHttpHeaders = {}): Promise<{ status: number; bytes: Buffer }> {
  const connection = await tunnel(value), agent = new http.Agent(); agent.createConnection = () => connection.secure!;
  return new Promise((resolve, reject) => { const req = http.request({ host: 'chatgpt.com', path, method, agent, headers: { 'content-length': body.length, 'proxy-authorization': 'fake-inner-header-must-strip', ...headers } }, async res => { const chunks: Buffer[] = []; try { for await (const chunk of res) chunks.push(chunk); agent.destroy(); resolve({ status: res.statusCode!, bytes: Buffer.concat(chunks) }); } catch (error) { agent.destroy(); reject(error); } }); req.once('error', error => { agent.destroy(); reject(error); }); req.end(body); });
}
const completion = () => 'data: ' + JSON.stringify({ type: 'response.completed', response: { id: 'resp_fixture-01', status: 'completed', output: [] }, headers: { authorization: 'PRIVATE_HEADER_SENTINEL' } }) + '\n\n';
function journal(root: string, name: string) { return readFileSync(join(root, name), 'utf8').trim().split('\n').map(line => JSON.parse(line)); }
function wsFrame(body: Buffer, masked: boolean, compressed = false) { const header = body.length < 126 ? Buffer.from([129 | (compressed ? 64 : 0), (masked ? 128 : 0) | body.length]) : Buffer.alloc(4); if (header.length === 4) { header[0] = 129 | (compressed ? 64 : 0); header[1] = (masked ? 128 : 0) | 126; header.writeUInt16BE(body.length, 2); } const key = masked ? randomBytes(4) : Buffer.alloc(0), bytes = Buffer.from(body); if (masked) for (let index = 0; index < bytes.length; index++) bytes[index] ^= key[index % 4]!; return Buffer.concat([header, key, bytes]); }
async function deflateMessage(codec: zlib.DeflateRaw, body: Buffer): Promise<Buffer> { const chunks: Buffer[] = [], collect = (bytes: Buffer) => chunks.push(bytes); codec.on('data', collect); codec.write(body); await new Promise<void>(resolve => codec.flush(zlib.constants.Z_SYNC_FLUSH, resolve)); codec.off('data', collect); const bytes = Buffer.concat(chunks); return bytes.subarray(0, bytes.length - 4); }
function queuedResponseEnd(value: WorkflowNativeBodyObserverHandle) {
  const original = http.ServerResponse.prototype.end; let end: (() => void) | undefined, finished = () => false, reached: (() => void) | undefined;
  const queued = new Promise<void>(resolve => { reached = resolve; });
  vi.spyOn(http.ServerResponse.prototype, 'end').mockImplementation(function (this: http.ServerResponse, ...args: Parameters<typeof original>) { if (this.socket?.localPort === value.port) { end = () => { original.apply(this, args); }; finished = () => this.writableFinished; reached!(); return this; } return original.apply(this, args); });
  return { queued, finished: () => finished(), release: () => { if (!end) throw new Error('fixture_response_not_queued'); end(); } };
}

beforeAll(() => { if (nativeApis) fixture = createNativeBodyTlsFixture(); });
afterEach(async () => { for (const socket of socketOwners) socket.destroy(); socketOwners.clear(); for (const handle of handles.splice(0)) await handle.close(); for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve())); vi.restoreAllMocks(); for (const root of owned.splice(0)) { const target = resolve(root), within = relative(realpathSync(tmpdir()), target); if (!within || within.startsWith('..') || !basename(target).startsWith('native-body-test-')) throw new Error('native_body_test_cleanup_target'); rmSync(target, { recursive: true, force: true }); } });
afterAll(() => fixture?.close());

describe('native-only body observer capability', () => {
  it('ordinary imports are safe and missing APIs refuse before listening', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(tls, 'getCACertificates'); let refused = false;
    try { Object.defineProperty(tls, 'getCACertificates', { value: undefined, configurable: true }); try { const unexpected = await startWorkflowNativeBodyObserver({ secureContext: tls.createSecureContext(), upstreamCertificates: ['untrusted fixture'] }); await unexpected.close(); } catch (error) { refused = error instanceof Error && error.message === 'workflow_native_body_observer_unavailable'; } }
    finally { if (descriptor) Object.defineProperty(tls, 'getCACertificates', descriptor); else Reflect.deleteProperty(tls, 'getCACertificates'); }
    expect(refused).toBe(true);
  });
});
describe.skipIf(!nativeApis)('owned native transport', () => {
  it('requires current invocation authentication and exact official CONNECT destination', async () => {
    const value = await factory(), root = directory(); const invocation = value.beginInvocation({ directory: root, invocationId: 'auth', onFirstFailure() {} });
    expect((await tunnel(value, false)).status).toBe(403); expect((await tunnel(value, true, 'example.org:443')).status).toBe(403); invocation.beginClientShutdown(); const settled = await invocation.settle(); expect(settled.stats.requests).toBe(0);
  });
  it('captures uncapped outgoing bytes and selected SSE receipts without incoming headers', async () => {
    const server = await upstream((req, res) => { req.resume(); req.once('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(completion()); }); }); route(server);
    const value = await factory(), root = directory(), invocation = value.beginInvocation({ directory: root, invocationId: 'http', onFirstFailure() {} });
    const body = Buffer.from('model source fake Authorization: Bearer fixture\n'.repeat(400000)); expect(body.length).toBeGreaterThan(16777216); expect((await request(value, '/backend-api/codex/responses', body)).status).toBe(200);
    invocation.beginClientShutdown(); const settled = await invocation.settle(), rows = journal(root, settled.journal.name), captured = rows.find(row => row.type === 'body');
    expect(captured.decoded.bytes).toBe(body.length); expect(captured.decoded.sha256).toBe(createHash('sha256').update(body).digest('hex')); expect(rows.some(row => row.type === 'response-receipt' && row.eventType === 'response.completed')).toBe(true); expect(readFileSync(join(root, settled.journal.name), 'utf8')).not.toContain('PRIVATE_HEADER_SENTINEL'); expect(settled.stats.peakWorkingChunk).toBeLessThanOrEqual(65536);
  }, 30000);
  it('joins a queued HTTP writer finish before healthy completion', async () => {
    const server = await upstream((req, res) => { req.resume(); req.once('end', () => res.end(completion())); }); route(server); const value = await factory(), root = directory(), invocation = value.beginInvocation({ directory: root, invocationId: 'queued-finish', onFirstFailure() {} }), writer = queuedResponseEnd(value);
    const operation = request(value, '/backend-api/codex/responses', Buffer.from('{}')); await writer.queued; expect(writer.finished()).toBe(false); writer.release(); expect((await operation).status).toBe(200); expect(writer.finished()).toBe(true); invocation.beginClientShutdown(); const done = await invocation.settle(); expect(done.stats.failures).toBe(0);
  });
  it('writer close before queued HTTP finish refuses completion and joins cleanup', async () => {
    const server = await upstream((req, res) => { req.resume(); req.once('end', () => res.end(completion())); }); route(server); const value = await factory(), root = directory(); let failures = 0; const invocation = value.beginInvocation({ directory: root, invocationId: 'queued-close', onFirstFailure() { failures++; } }), writer = queuedResponseEnd(value);
    const operation = request(value, '/backend-api/codex/responses', Buffer.from('{}')).catch(() => null); await writer.queued; await new Promise<void>(resolve => setImmediate(resolve)); const done = await invocation.settle(); await operation; expect(writer.finished()).toBe(false); expect(done.stats.failures).toBeGreaterThan(0); expect(failures).toBe(1); expect(journal(root, done.journal.name).at(-1).status).toBe('failed');
  });
  it('forwards only exact source-backed metadata and records completed zero-credit control', async () => {
    const server = await upstream((req, res) => { req.resume(); res.writeHead(200); res.end('{"commit_attribution_enabled":true,"private_route_token":"DO_NOT_ARCHIVE"}'); }); route(server);
    const value = await factory(), root = directory(), invocation = value.beginInvocation({ directory: root, invocationId: 'metadata', onFirstFailure() {} }); expect((await request(value, '/backend-api/wham/settings/user', Buffer.alloc(0), 'GET')).status).toBe(200);
    invocation.beginClientShutdown(); const settled = await invocation.settle(), rows = journal(root, settled.journal.name); expect(rows.some(row => row.type === 'metadata-completed' && row.category === 'USER_SETTINGS')).toBe(true); expect(rows.every(row => row.type !== 'body')).toBe(true); expect(readFileSync(join(root, settled.journal.name), 'utf8')).not.toContain('DO_NOT_ARCHIVE');
    let transactions = 0; for await (const _transaction of iterateWorkflowNativeObservedTransactions({ directory: root, invocationId: 'metadata', settlement: settled })) transactions++; expect(transactions).toBe(0);
  });
  it('closes pre-header upstream work and joins a throwing failure callback', async () => {
    let reached: (() => void) | undefined; const received = new Promise<void>(resolve => { reached = resolve; }); const server = await upstream((_req, _res) => { reached!(); }); route(server); const value = await factory(), root = directory(); let callbacks = 0;
    const invocation = value.beginInvocation({ directory: root, invocationId: 'pending', onFirstFailure() { callbacks++; throw new Error('PRIVATE_CALLBACK_DETAIL'); } }); const operation = request(value, '/backend-api/codex/responses', Buffer.from('{}')).catch(() => null);
    await received; const settled = await invocation.settle(); await operation; expect(settled.stats.failures).toBeGreaterThan(0); expect(callbacks).toBe(1); const text = readFileSync(join(root, settled.journal.name), 'utf8'); expect(text).not.toContain('PRIVATE_CALLBACK_DETAIL'); expect(journal(root, settled.journal.name).at(-1).type).toBe('closed');
  });
  it('stable factory permits sequential invocations with isolated journals', async () => {
    const value = await factory(), first = directory(), second = directory(); const a = value.beginInvocation({ directory: first, invocationId: 'first', onFirstFailure() {} }); expect(() => value.beginInvocation({ directory: second, invocationId: 'overlap', onFirstFailure() {} })).toThrow('INVOCATION_STATE'); a.beginClientShutdown(); const once = await a.settle(); expect(await a.settle()).toEqual(once);
    const b = value.beginInvocation({ directory: second, invocationId: 'second', onFirstFailure() {} }); b.beginClientShutdown(); const done = await b.settle(); expect(journal(first, once.journal.name).every(row => row.invocationId === 'first')).toBe(true); expect(journal(second, done.journal.name).every(row => row.invocationId === 'second')).toBe(true);
  });
  it('journal seal failure still closes the stable listener and owned sockets', async () => {
    const value = await factory(), root = directory(), invocation = value.beginInvocation({ directory: root, invocationId: 'seal-failure', onFirstFailure() {} }); invocation.beginClientShutdown();
    vi.spyOn(WorkflowReviewOwnedFile.prototype, 'seal').mockImplementation(() => { throw new Error('owned_journal_seal_fixture'); });
    let failed = false; try { await value.close(); } catch (error) { failed = error instanceof Error && error.message === 'owned_journal_seal_fixture'; } expect(failed).toBe(true);
    let refused = false; try { await tunnel(value); } catch { refused = true; } expect(refused).toBe(true);
  });
  it('journal append failure joins pre-header upstream closure and a rejecting callback', async () => {
    let reached: (() => void) | undefined, closed: (() => void) | undefined; const received = new Promise<void>(resolve => { reached = resolve; }), remoteClosed = new Promise<void>(resolve => { closed = resolve; });
    const server = await upstream((req, _res) => { req.socket.once('close', () => closed!()); reached!(); }); route(server);
    const value = await factory(), root = directory(); let callbacks = 0; const invocation = value.beginInvocation({ directory: root, invocationId: 'append-failure', onFirstFailure() { callbacks++; return Promise.reject(new Error('PRIVATE_CALLBACK_DETAIL')); } });
    const operation = request(value, '/backend-api/codex/responses', Buffer.from('{}')).catch(() => null); await received;
    const original = WorkflowReviewOwnedFile.prototype.append; vi.spyOn(WorkflowReviewOwnedFile.prototype, 'append').mockImplementation(function (this: WorkflowReviewOwnedFile, bytes) { if (this.name === 'native-body-journal.jsonl') throw new Error('owned_journal_append_fixture'); return original.call(this, bytes); });
    invocation.beginClientShutdown(); let failed = false; try { await value.close(); } catch (error) { failed = error instanceof Error && error.message === 'owned_journal_append_fixture'; }
    await operation; await remoteClosed; expect(failed).toBe(true); expect(callbacks).toBe(1); let refused = false; try { await tunnel(value); } catch { refused = true; } expect(refused).toBe(true);
  });
  it('request construction refuses unsupported encoding before opening capture files', async () => {
    const value = await factory(), root = directory(), invocation = value.beginInvocation({ directory: root, invocationId: 'encoding', onFirstFailure() {} }); expect((await request(value, '/backend-api/codex/responses', Buffer.from('{}'), 'POST', { 'content-encoding': 'unsupported' })).status).toBe(502);
    const done = await invocation.settle(); expect(done.stats.requests).toBe(0); expect(done.stats.failures).toBeGreaterThan(0); expect(readdirSync(root).filter(name => name.startsWith('native-request-')).length).toBe(0);
  });
  it('second capture-file creation failure closes the first owned descriptor', async () => {
    const value = await factory(), root = directory(), invocation = value.beginInvocation({ directory: root, invocationId: 'construction', onFirstFailure() {} }); writeFileSync(join(root, 'native-request-00000001.decoded'), 'existing fixture', { flag: 'wx' });
    const closed: string[] = [], original = WorkflowReviewOwnedFile.prototype.close; vi.spyOn(WorkflowReviewOwnedFile.prototype, 'close').mockImplementation(function (this: WorkflowReviewOwnedFile) { closed.push(this.name); original.call(this); });
    expect((await request(value, '/backend-api/codex/responses', Buffer.from('{}'))).status).toBe(502); const done = await invocation.settle(); expect(closed).toContain('native-request-00000001.wire'); expect(done.stats.failures).toBeGreaterThan(0); expect(readFileSync(join(root, 'native-request-00000001.decoded'), 'utf8')).toBe('existing fixture');
  });
  it('unsupported route refuses without capturing its body or query', async () => {
    const value = await factory(), root = directory(); let callbacks = 0; const invocation = value.beginInvocation({ directory: root, invocationId: 'route', onFirstFailure() { callbacks++; } }); expect((await request(value, '/oauth/token?credential=PRIVATE_QUERY', Buffer.from('PRIVATE_BODY'))).status).toBe(403); const done = await invocation.settle(); expect(callbacks).toBe(1); expect(() => invocation.assertHealthy()).toThrow(); const text = readFileSync(join(root, done.journal.name), 'utf8'); expect(text).not.toContain('PRIVATE_QUERY'); expect(text).not.toContain('PRIVATE_BODY'); expect(journal(root, done.journal.name).every(row => row.type !== 'body')).toBe(true);
  });
  it('denials expose only fixed source-backed route categories without widening forwarding', async () => {
    for (const [path, method, category] of [['/backend-api/codex/analytics-events/events', 'POST', 'ANALYTICS_EVENTS'], ['/backend-api/codex/models?client_version=0.159.1', 'GET', 'MODEL_CATALOG_01591'], ['/backend-api/wham/workspace-messages', 'GET', 'WORKSPACE_MESSAGES'], ['/backend-api/wham/profiles/me', 'GET', 'PROFILE_ME'], ['/backend-api/wham/settings/user?private=PRIVATE_QUERY', 'GET', 'OTHER']]) {
      const value = await factory(), root = directory(), invocation = value.beginInvocation({ directory: root, invocationId: 'category', onFirstFailure() {} }); expect((await request(value, path!, Buffer.alloc(0), method)).status).toBe(403); const done = await invocation.settle(), text = readFileSync(join(root, done.journal.name), 'utf8'); expect(journal(root, done.journal.name).find(row => row.type === 'denied')?.category).toBe(category); expect(text).not.toContain(path); expect(text).not.toContain('PRIVATE_QUERY'); expect(done.stats.requests).toBe(0); expect(done.stats.failures).toBeGreaterThan(0);
    }
  });
  it('stock compressed WS preserves dictionary context, owned requests and typed response receipts', async () => {
    const server = await upstream(); const serverCodec = zlib.createDeflateRaw(); let receivedRequests = 0;
    server.on('upgrade', (req, stream) => { const socket = stream as Socket; socket.resume(); const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64'); socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Extensions: permessage-deflate\r\n\r\n`);
      socket.on('data', () => { const index = ++receivedRequests; const event = Buffer.from(JSON.stringify({ type: 'response.completed', response: { id: 'resp_fixture-' + index, status: 'completed', output: [] }, headers: { authorization: 'PRIVATE_HEADER_SENTINEL' } })); void deflateMessage(serverCodec, event).then(bytes => socket.write(wsFrame(bytes, false, true))); }); socket.on('end', () => socket.end()); }); route(server);
    const value = await factory(), root = directory(), invocation = value.beginInvocation({ directory: root, invocationId: 'wss', onFirstFailure() {} }), connection = await tunnel(value), secure = connection.secure!; secure.on('error', () => {}); secure.resume();
    secure.write(`GET /backend-api/codex/responses HTTP/1.1\r\nHost: chatgpt.com\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nSec-WebSocket-Extensions: permessage-deflate\r\n\r\n`);
    const journalPath = join(root, 'native-body-journal.jsonl'); while (!readFileSync(journalPath, 'utf8').includes('websocket-negotiated')) await delay(); const clientCodec = zlib.createDeflateRaw(); const requests = [Buffer.from('{"type":"response.create","input":[]}'), Buffer.from('{"type":"response.create","input":[],"previous_response_id":"resp_fixture-1"}')];
    for (let index = 0; index < requests.length; index++) { secure.write(wsFrame(await deflateMessage(clientCodec, requests[index]!), true, true)); while (journal(root, 'native-body-journal.jsonl').filter(row => row.eventType === 'response.completed').length !== index + 1) await delay(); }
    invocation.beginClientShutdown(); connection.raw.resetAndDestroy(); const done = await invocation.settle(); const rows = journal(root, done.journal.name), bodies = rows.filter(row => row.type === 'body'); expect(done.stats.failures).toBe(0); expect(bodies.length).toBe(2); for (let index = 0; index < 2; index++) expect(bodies[index].decoded.sha256).toBe(createHash('sha256').update(requests[index]!).digest('hex')); expect(readFileSync(journalPath, 'utf8')).not.toContain('PRIVATE_HEADER_SENTINEL'); clientCodec.destroy(); serverCodec.destroy();
  });
  it('holds a late header-bearing WS error before completion and archives no inbound body', async () => {
    const server = await upstream(); const payload = Buffer.from(JSON.stringify({ response: { id: 'resp_fixture-1', status: 'completed', output: [] }, headers: { authorization: 'PRIVATE_HEADER_SENTINEL' }, type: 'response.completed', error: { message: 'PRIVATE_HEADER_SENTINEL' } }));
    server.on('upgrade', (req, stream) => { const socket = stream as Socket; const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64'); socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`); socket.resume(); socket.once('data', () => socket.write(wsFrame(payload, false))); }); route(server);
    const value = await factory(), root = directory(); let callbacks = 0; const invocation = value.beginInvocation({ directory: root, invocationId: 'error', onFirstFailure() { callbacks++; } }), connection = await tunnel(value), secure = connection.secure!; secure.on('error', () => {}); const received: Buffer[] = []; secure.on('data', bytes => received.push(bytes));
    secure.write(`GET /backend-api/codex/responses HTTP/1.1\r\nHost: chatgpt.com\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\n\r\n`); while (!readFileSync(join(root, 'native-body-journal.jsonl'), 'utf8').includes('websocket-negotiated')) await delay(); secure.write(wsFrame(Buffer.from('{"type":"response.create","input":[]}'), true)); while (!callbacks) await delay(); const done = await invocation.settle();
    expect(done.stats.failures).toBeGreaterThan(0); expect(callbacks).toBe(1); expect(journal(root, done.journal.name).some(row => row.type === 'response-receipt')).toBe(false); expect(readFileSync(join(root, done.journal.name), 'utf8')).not.toContain('PRIVATE_HEADER_SENTINEL'); expect(Buffer.concat(received).includes(payload)).toBe(false);
  });
  it('rejects unsupported WS extensions before opening model files', async () => {
    const value = await factory(), root = directory(); let callbacks = 0; const invocation = value.beginInvocation({ directory: root, invocationId: 'extension', onFirstFailure() { callbacks++; } }), connection = await tunnel(value); connection.secure!.on('error', () => {}); connection.secure!.resume();
    connection.secure!.write('GET /backend-api/codex/responses HTTP/1.1\r\nHost: chatgpt.com\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Extensions: unsupported-extension\r\n\r\n'); while (!callbacks) await delay(); const done = await invocation.settle(); expect(done.stats.requests).toBe(0); expect(done.stats.failures).toBeGreaterThan(0); expect(journal(root, done.journal.name).some(row => row.type === 'body')).toBe(false);
  });
  it('old channel cannot write into a new invocation after settlement', async () => {
    const value = await factory(), first = directory(), second = directory(), a = value.beginInvocation({ directory: first, invocationId: 'old', onFirstFailure() {} }), connection = await tunnel(value); connection.secure!.on('error', () => {}); a.beginClientShutdown(); const closed = await a.settle(); const old = readFileSync(join(first, closed.journal.name));
    const b = value.beginInvocation({ directory: second, invocationId: 'new', onFirstFailure() {} }); connection.secure!.write('GET /backend-api/codex/responses HTTP/1.1\r\nHost: chatgpt.com\r\n\r\n'); await delay(); b.beginClientShutdown(); const settled = await b.settle(); expect(readFileSync(join(first, closed.journal.name)).equals(old)).toBe(true); expect(journal(second, settled.journal.name).every(row => row.invocationId === 'new')).toBe(true); expect(settled.stats.requests).toBe(0);
  });
  it('joins unauthenticated invocation-A TCP closure and refuses delayed CONNECT in B', async () => {
    const created = vi.spyOn(http, 'createServer'), value = await factory(), proxy = created.mock.results[0]!.value as http.Server, first = directory(), second = directory();
    const a = value.beginInvocation({ directory: first, invocationId: 'raw-old', onFirstFailure() {} }), accepted = once(proxy, 'connection'), raw = connect(value.port, '127.0.0.1'); socketOwners.add(raw); raw.once('close', () => socketOwners.delete(raw));
    const [, [serverSocket]] = await Promise.all([once(raw, 'connect'), accepted]);
    const admitted = new Promise<boolean>(resolve => { raw.once('data', bytes => resolve(bytes.toString('ascii').startsWith('HTTP/1.1 200'))); raw.once('close', () => resolve(false)); raw.on('error', () => resolve(false)); });
    a.beginClientShutdown(); const closed = await a.settle(); expect(serverSocket.closed).toBe(true); const old = readFileSync(join(first, closed.journal.name));
    const b = value.beginInvocation({ directory: second, invocationId: 'raw-new', onFirstFailure() {} }), url = new URL(value.proxyUrl), authorization = Buffer.from(`${url.username}:${url.password}`).toString('base64');
    raw.write(`CONNECT chatgpt.com:443 HTTP/1.1\r\nHost: chatgpt.com:443\r\nProxy-Authorization: Basic ${authorization}\r\n\r\n`); expect(await admitted).toBe(false); b.beginClientShutdown(); const done = await b.settle(); expect(done.stats.accepted).toBe(0); expect(readFileSync(join(first, closed.journal.name)).equals(old)).toBe(true);
  });
  it('a TCP connection accepted without an invocation cannot authenticate under a later owner', async () => {
    const created = vi.spyOn(http, 'createServer'), value = await factory(), proxy = created.mock.results[0]!.value as http.Server, accepted = once(proxy, 'connection'), raw = connect(value.port, '127.0.0.1'); socketOwners.add(raw); raw.once('close', () => socketOwners.delete(raw)); await Promise.all([once(raw, 'connect'), accepted]);
    const invocation = value.beginInvocation({ directory: directory(), invocationId: 'late-owner', onFirstFailure() {} }), url = new URL(value.proxyUrl), authorization = Buffer.from(`${url.username}:${url.password}`).toString('base64');
    const admitted = new Promise<boolean>(resolve => { raw.once('data', bytes => resolve(bytes.toString('ascii').startsWith('HTTP/1.1 200'))); raw.once('close', () => resolve(false)); raw.on('error', () => resolve(false)); }); raw.write(`CONNECT chatgpt.com:443 HTTP/1.1\r\nHost: chatgpt.com:443\r\nProxy-Authorization: Basic ${authorization}\r\n\r\n`);
    expect(await admitted).toBe(false); invocation.beginClientShutdown(); const done = await invocation.settle(); expect(done.stats.accepted).toBe(0); expect(done.stats.requests).toBe(0);
  });
  it('failure snapshots distinguish a pending verified-TLS WS upgrade with no response', async () => {
    let reached: (() => void) | undefined, failed: (() => void) | undefined; const received = new Promise<void>(resolve => { reached = resolve; }), failure = new Promise<void>(resolve => { failed = resolve; });
    const server = await upstream(); server.on('upgrade', (_req, _stream) => reached!()); route(server);
    const value = await factory(), root = directory(), invocation = value.beginInvocation({ directory: root, invocationId: 'held-upgrade', onFirstFailure() { failed!(); } }), connection = await tunnel(value); connection.secure!.on('error', () => {}); connection.secure!.resume();
    connection.secure!.write(`GET /backend-api/codex/responses HTTP/1.1\r\nHost: chatgpt.com\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nX-Private-Diagnostic: PRIVATE_HEADER_SENTINEL\r\n\r\n`); await received; connection.secure!.end(); await failure;
    const done = await invocation.settle(), rows = journal(root, done.journal.name), state = rows.find(row => row.type === 'failure' && row.code === 'EOF')?.state;
    expect(state).toMatchObject({ upgrading: true, partialHeader: false, activeHttp: 0, requests: 0, completions: 0, parserIdle: true, wsSocketAssigned: true, wsTcpConnected: true, wsTlsReady: true, wsRequestFinished: true, wsResponseStatus: null });
    expect(done.stats.failures).toBeGreaterThan(0); expect(rows.some(row => row.type === 'body' || row.type === 'response-receipt')).toBe(false); expect(readFileSync(join(root, done.journal.name), 'utf8')).not.toContain('PRIVATE_HEADER_SENTINEL');
  });
  it('failure snapshots distinguish incomplete native HTTP headers from an upgrade', async () => {
    let failed: (() => void) | undefined; const failure = new Promise<void>(resolve => { failed = resolve; }); const value = await factory(), root = directory(), invocation = value.beginInvocation({ directory: root, invocationId: 'partial-header', onFirstFailure() { failed!(); } }), connection = await tunnel(value); connection.secure!.on('error', () => {}); connection.secure!.resume();
    connection.secure!.end('GET /backend-api/codex/responses HTTP/1.1\r\nHost: chatgpt.com\r\nX-Private-Diagnostic: PRIVATE_PARTIAL_SENTINEL'); await failure; const done = await invocation.settle(), rows = journal(root, done.journal.name);
    expect(rows.filter(row => row.type === 'failure').map(row => ({ code: row.code, peer: row.peer, state: row.state }))).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'HPE_INVALID_EOF_STATE', peer: 'native-http-parser', state: expect.objectContaining({ acceptedRequests: 0, upgrading: false, wsSocketAssigned: false }) })])); expect(done.stats.requests).toBe(0); expect(done.stats.failures).toBeGreaterThan(0); expect(readFileSync(join(root, done.journal.name), 'utf8')).not.toContain('PRIVATE_PARTIAL_SENTINEL');
  });
  it('native header overflow retains the fixed parser code and no raw header diagnostics', async () => {
    let failed: (() => void) | undefined; const failure = new Promise<void>(resolve => { failed = resolve; }); const value = await factory(), root = directory(), invocation = value.beginInvocation({ directory: root, invocationId: 'header-overflow', onFirstFailure() { failed!(); } }), connection = await tunnel(value); connection.secure!.on('error', () => {}); connection.secure!.resume();
    connection.secure!.write('GET /backend-api/codex/responses HTTP/1.1\r\nHost: chatgpt.com\r\nX-Private-Diagnostic: PRIVATE_OVERFLOW_SENTINEL' + 'x'.repeat(17000) + '\r\n\r\n'); await failure; const done = await invocation.settle(), rows = journal(root, done.journal.name);
    expect(rows.some(row => row.type === 'failure' && row.code === 'HPE_HEADER_OVERFLOW' && row.peer === 'native-http-parser' && row.state?.upgrading === false)).toBe(true); expect(done.stats.requests).toBe(0); expect(done.stats.failures).toBeGreaterThan(0); const text = readFileSync(join(root, done.journal.name), 'utf8'); expect(text).not.toContain('PRIVATE_OVERFLOW_SENTINEL'); expect(text).not.toContain('rawPacket');
  });
});
