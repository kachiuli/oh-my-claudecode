import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:net';
import tls from 'node:tls';
import zlib from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { createNativeBodyTlsFixture } from './helpers/native-body-tls-fixture.js';
import { WorkflowReviewOwnedFile, workflowReviewResourceUsage } from '../workflow-review-source.js';
import { beginWorkflowNativeReviewObservation, beginWorkflowNativeReviewClientShutdown, consumeWorkflowNativeReviewObservationCompletion,
  createWorkflowNativeReviewObserver, disposeWorkflowNativeReviewObserver, iterateWorkflowNativeObservedTransactions,
  settleWorkflowNativeReviewObservation, workflowNativeReviewObserverConfiguration } from '../workflow-native-review-observer.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const nativeRuntime = typeof tls.getCACertificates === 'function' && typeof zlib.createZstdDecompress === 'function';

describe('native observer private lifetime', () => {
  it.skipIf(!nativeRuntime).each(['throw', 'reject'])('closes listener and held keys when the active failure callback fails: %s', async mode => {
    const certificates = createNativeBodyTlsFixture(); const before = workflowReviewResourceUsage().descriptors;
    const observer = await createWorkflowNativeReviewObserver({ certificates: certificates.directory });
    const { port } = workflowNativeReviewObserverConfiguration(observer).descriptor;
    try {
      beginWorkflowNativeReviewObservation(observer, { directory: join(certificates.directory, 'invocation'), invocationId: 'dispose-test',
        onFirstFailure() { if (mode === 'reject') return Promise.reject(new Error('controller_callback_failure')); throw new Error('controller_callback_failure'); } });
      await expect(disposeWorkflowNativeReviewObserver(observer)).rejects.toThrow('controller_callback_failure');
      await expect(disposeWorkflowNativeReviewObserver(observer)).resolves.toBeUndefined();
      expect(workflowReviewResourceUsage().descriptors).toBe(before);
      const code = await new Promise<string>(resolve => {
        const socket = connect({ host: '127.0.0.1', port });
        socket.once('error', error => { socket.destroy(); resolve((error as NodeJS.ErrnoException).code ?? 'unknown'); });
        socket.once('connect', () => { socket.destroy(); resolve('unexpected-listener'); });
      });
      expect(code).toBe('ECONNREFUSED');
    } finally { await disposeWorkflowNativeReviewObserver(observer); certificates.close(); }
  });
  it.skipIf(!nativeRuntime)('keeps a stable listener across serialized invocations and consumes only original completions once', async () => {
    const certificates = createNativeBodyTlsFixture(); const observer = await createWorkflowNativeReviewObserver({ certificates: certificates.directory });
    try {
      const initial = workflowNativeReviewObserverConfiguration(observer);
      const first = beginWorkflowNativeReviewObservation(observer, { directory: join(certificates.directory, 'first'), invocationId: 'first', onFirstFailure() {} });
      expect(() => beginWorkflowNativeReviewObservation(observer, { directory: join(certificates.directory, 'busy'), invocationId: 'busy', onFirstFailure() {} }))
        .toThrow('workflow_review_native_observer_busy');
      beginWorkflowNativeReviewClientShutdown(first);
      const completion = await settleWorkflowNativeReviewObservation(first);
      expect(() => consumeWorkflowNativeReviewObservationCompletion(first, { ...completion })).toThrow('workflow_review_native_observer_completion_required');
      expect(consumeWorkflowNativeReviewObservationCompletion(first, completion).stats.requests).toBe(0);
      expect(() => consumeWorkflowNativeReviewObservationCompletion(first, completion)).toThrow('workflow_review_native_observer_completion_required');
      const second = beginWorkflowNativeReviewObservation(observer, { directory: join(certificates.directory, 'second'), invocationId: 'second', onFirstFailure() {} });
      expect(workflowNativeReviewObserverConfiguration(observer)).toEqual(initial);
      beginWorkflowNativeReviewClientShutdown(second); await settleWorkflowNativeReviewObservation(second);
    } finally { await disposeWorkflowNativeReviewObserver(observer); certificates.close(); }
  });
});

function metadataJournal(fault?: string) {
  const directory = mkdtempSync(join(tmpdir(), 'omc-native-metadata-')); roots.push(directory);
  const journal = new WorkflowReviewOwnedFile(directory, 'journal.jsonl', true); let seq = 0;
  const append = (value: object) => journal.append(Buffer.from(JSON.stringify({ seq: ++seq, at: '2026-10-06T00:00:00.000Z', invocationId: 'metadata', ...value }) + '\n'));
  const identity = { channelId: 1, transaction: ['out-of-order', 'missing-transaction'].includes(fault ?? '') ? 2 : 1, category: 'ACCOUNTS_CHECK', modelSourceCredit: false };
  if (fault === 'request-after-shutdown') append({ type: 'client-shutdown-begin', modelSourceCredit: false });
  append({ type: 'metadata-request', ...identity });
  if (fault === 'out-of-order') append({ type: 'websocket-negotiated', channelId: 2, transaction: 1, compression: null, modelSourceCredit: false });
  if (fault === 'duplicate-transaction') append({ type: 'metadata-request', ...identity });
  if (fault !== 'missing-completion') append({ type: 'metadata-completed', ...identity, category: fault === 'foreign-category' ? 'USER_SETTINGS' : identity.category,
    requestConsumed: true, responseComplete: true, responseDelivered: fault !== 'undelivered' });
  if (fault === 'denial') append({ type: 'denied', reason: 'FIXED_MODEL_ROUTE_ONLY', category: 'OTHER', channelId: 1, modelSourceCredit: false });
  if (fault === 'unknown-control') append({ type: 'unknown-control', modelSourceCredit: false });
  append({ type: 'client-shutdown-begin', modelSourceCredit: false });
  if (fault !== 'missing-completion') append({ type: 'channel-close', channelId: 1, peer: 'native-tls', classification: 'NORMAL_COMPLETE_HTTP_EOF', modelSourceCredit: false });
  const stats = { accepted: fault === 'out-of-order' ? 2 : 1, requests: 0, responseEvents: 0, failures: 0, peakWorkingChunk: 0, bodySizeCeiling: null, corpusSizeCeiling: null } as const;
  append({ type: 'closed', status: 'healthy', stats });
  const settlement = { journal: journal.seal(), stats }; journal.close();
  return { directory, invocationId: 'metadata', settlement };
}
describe('zero-credit native metadata lifecycle', () => {
  it.each([undefined, 'out-of-order'])('requires completed metadata without assuming upgrade completion follows allocation order: %s', async order => {
    let transactions = 0; for await (const _transaction of iterateWorkflowNativeObservedTransactions(metadataJournal(order))) transactions++;
    expect(transactions).toBe(0);
  });
  it.each(['missing-completion', 'foreign-category', 'undelivered', 'denial', 'unknown-control', 'request-after-shutdown', 'duplicate-transaction', 'missing-transaction'])(
    'refuses %s even with a claimed healthy terminal record', async fault => {
      await expect((async () => { for await (const _transaction of iterateWorkflowNativeObservedTransactions(metadataJournal(fault))) { /* No model credit. */ } })())
        .rejects.toThrow('workflow_review_native_observer_trace_incomplete');
    });
});
