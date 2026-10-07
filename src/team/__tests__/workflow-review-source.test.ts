/**
 * The disk-backed, lossless review source bundle: its canonical manifest, its bounded-page
 * read-only reader, its streaming/spooling capture helpers and the on-disk complete-coverage
 * predicate.
 *
 * The bundle is a *constant descriptor* plus disk records: a manifest path, an append-only index
 * path, one numbered metadata record per entry and one immutable file per material. It carries no
 * entry array and no material array at all — every consumer walks the manifest and the index through
 * one-record-at-a-time iterators and resolves a single entry from its bounded record file — so the
 * controller never holds a large payload in memory, in an array or in a saved state. The public
 * boundary exercised here is therefore two-sided: the reader must serve every byte of a material far
 * above any buffer, and the *complete encoded MCP response* — not the inner text — must stay inside
 * the per-response policy for every page, including the manifest pages.
 *
 * A page is also a delivery receipt, and the receipt carries the exact returned bytes. Coverage is
 * therefore reconstructed from what the transport actually delivered, never from the current source
 * disk; the immutable on-disk objects are re-hashed only as a separate, independent guard, so a
 * transport that corrupts content while keeping counts and metadata plausible is a failed review.
 *
 * The reader transport is exercised over a real MCP client/server connection in process; the
 * controller's process-level wiring is exercised in workflow-review-compatibility.test.ts.
 * Symlink-escape refusal is enforced by an lstat check that an environment unable to create
 * symbolic links (as here) can only exercise through its path-validation siblings.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer, type Socket } from 'node:net';
import * as net from 'node:net';
import { build } from 'esbuild';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorkflowFixture } from './helpers/workflow-fixture.js';
import { WORKFLOW_REVIEW_SOURCE_MANIFEST_SCHEMA_VERSION } from '../workflow-contracts.js';
import {
  assertWorkflowReviewSourceHead, assertWorkflowReviewSourcePath, buildWorkflowReviewSourceBundle,
  createWorkflowReviewArtifactDescriptor, hashWorkflowReviewArtifact, iterateWorkflowReviewAuthorizedPaths,
  iterateWorkflowReviewIndexEntries, iterateWorkflowReviewJsonFields, iterateWorkflowReviewJsonRecords,
  iterateWorkflowReviewManifestEntries, iterateWorkflowReviewNulRecords,
  openWorkflowReviewSourceBundle, publishWorkflowReviewBundle, readWorkflowReviewFileChunks, readWorkflowReviewGitText,
  readWorkflowReviewSource, readWorkflowReviewSourceMember, resolveWorkflowReviewSourceFile, spoolWorkflowReviewGit,
  streamWorkflowReviewLines, validateWorkflowReviewCoverage, validateWorkflowReviewCoverageLedger,
  verifyWorkflowReviewAuthorizedMembership, verifyWorkflowReviewCoverageArtifactSync,
  verifyWorkflowReviewSourceBundle, verifyWorkflowReviewSourceManifestDescriptor, workflowReviewResponse,
  workflowReviewResponseBytes, workflowReviewSourceReceipt,
  WORKFLOW_REVIEW_BUFFER_LIMIT_BYTES, WORKFLOW_REVIEW_ENTRIES_DIRECTORY, WORKFLOW_REVIEW_INDEX_FILE,
  WORKFLOW_REVIEW_MANIFEST_FILE,
  WORKFLOW_REVIEW_RECORDS_DIRECTORY, WORKFLOW_REVIEW_READ_LIMIT_BYTES, WORKFLOW_REVIEW_RESPONSE_ID_RESERVE_BYTES,
  workflowReviewResponseIdBytes, writeWorkflowReviewArtifact,
  WorkflowReviewOwnedFile, WorkflowReviewCoverageMachine, workflowReviewResourceUsage, resetWorkflowReviewResourceUsage,
  type WorkflowReviewMaterialInput, type WorkflowReviewSourceBundle, type WorkflowReviewSourceEntry,
  type WorkflowReviewSourceReceipt,
} from '../workflow-review-source.js';
import {
  appendWorkflowReviewSourceReceipt, BoundedWorkflowReviewTransport, createWorkflowReviewSourceServer,
  parseWorkflowReviewReaderQualification,
  projectWorkflowReviewCodexCatalog, resolveWorkflowReviewReaderQualification, verifyWorkflowReviewQualificationEvidence,
  workflowReviewCodexReaderOverrides,
  workflowReviewEffectiveInvocation, workflowReviewReaderBuildIdentity, workflowReviewReaderDependencies,
  workflowReviewSourceReaderConfig, workflowReviewSourceServerPath,
  WORKFLOW_REVIEW_CODEX_COMMAND_TOOL_FEATURES, WORKFLOW_REVIEW_CODEX_EXCLUDED_FEATURES,
  WORKFLOW_REVIEW_CODEX_READER_NAMESPACE, WORKFLOW_REVIEW_EPHEMERAL_PLACEHOLDERS,
  WORKFLOW_REVIEW_READER_TOOLS,
  WORKFLOW_REVIEW_READER_TOOL_MANIFEST, WORKFLOW_REVIEW_READER_TOOL_READ,
  WORKFLOW_REVIEW_SOURCE_SERVER_NAME,
  WorkflowReviewFrameDecoder, requireWorkflowSyntheticReviewClientFactory, verifyWorkflowReviewReaderQualification,
  connectWorkflowSyntheticReviewBridge, buildWorkflowSyntheticReviewCapsule, WorkflowSyntheticReviewSession, workflowSyntheticRuntimeClosure,
} from '../workflow-review-source-server.js';

vi.mock('node:fs', async importOriginal => ({ ...await importOriginal<typeof import('node:fs')>() }));
vi.mock('node:crypto', async importOriginal => ({ ...await importOriginal<typeof import('node:crypto')>() }));
vi.mock('node:net', async importOriginal => ({ ...await importOriginal<typeof import('node:net')>() }));

const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const IDENTITY = { repository: 'synthetic/review-repository', baseCommit: 'a'.repeat(40), head: 'b'.repeat(40) };
/** The retired scaffold's aggregate source ceiling; the new transport must exceed it losslessly. */
const RETIRED_BUNDLE_CEILING_BYTES = 16 * 1024 * 1024;
/** Arbitrary, mostly non-UTF-8 bytes so the reader must preserve every byte it serves. */
function patternBytes(size: number, seed: number): Buffer {
  const bytes = Buffer.alloc(size);
  for (let index = 0; index < size; index++) bytes[index] = (index * 31 + seed * 17) % 256;
  return bytes;
}
/** Governing instructions are real UTF-8 text: 11389 * 2 + 1 = 22779 and 2000 * 3 + 1 = 6001 bytes. */
const INSTRUCTION_AGENTS = Buffer.from(`${'§'.repeat(11389)}x`, 'utf8');
const INSTRUCTION_CLAUDE = Buffer.from(`${'—'.repeat(2000)}y`, 'utf8');
const SINGLETON_BYTES: Record<string, Buffer> = {
  inventory: Buffer.from('AGENTS.md\ndocs/CLAUDE.md\nsrc/complete/unit-00.ts\n', 'utf8'),
  diff: Buffer.from('diff --git a/src/complete/unit-00.ts b/src/complete/unit-00.ts\n+complete synthetic component\n', 'utf8'),
  objective: Buffer.from('Deliver one complete synthetic component\n', 'utf8'),
  'shared-context': Buffer.from('{ "shared": "context" }\n', 'utf8'),
  contracts: Buffer.from('[{"id":"a","acceptanceCriteria":["One committed component passes its declared check"]}]\n', 'utf8'),
};
/** The five required singleton materials: one frozen instance of each, in a fixed order. */
function singletons(): WorkflowReviewMaterialInput[] {
  return Object.entries(SINGLETON_BYTES).map(([kind, content]) =>
    ({ kind: kind as WorkflowReviewMaterialInput['kind'], path: kind, content }));
}
/** Two governing instructions plus 64 authorized sources plus the five required singleton kinds. */
function syntheticMaterials(): WorkflowReviewMaterialInput[] {
  const sizes = Array.from({ length: 64 }, (_, index) => (index === 0 ? 23337 : 23354));
  return [
    { kind: 'instruction', path: 'AGENTS.md', content: INSTRUCTION_AGENTS },
    { kind: 'instruction', path: 'docs/CLAUDE.md', content: INSTRUCTION_CLAUDE },
    ...sizes.map((size, index) => ({ kind: 'source' as const,
      path: `src/complete/unit-${String(index).padStart(2, '0')}.ts`, content: patternBytes(size, index + 1) })),
    ...singletons(),
  ];
}
const scratchRoots: string[] = [];
/** A fresh, unique parent directory; the bundle itself is created inside it and must not pre-exist. */
function scratch(): string {
  const root = fs.realpathSync(mkdtempSync(join(tmpdir(), 'omc-review-test-')));
  scratchRoots.push(root);
  return root;
}
/** Freeze one bundle into its own private parent directory. */
function freeze(materials: ReadonlyArray<WorkflowReviewMaterialInput> | Iterable<WorkflowReviewMaterialInput>,
  identity = IDENTITY): WorkflowReviewSourceBundle {
  return buildWorkflowReviewSourceBundle({ ...identity, directory: join(scratch(), 'bundle'), materials });
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const root of scratchRoots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('trusted live reader boundaries', () => {
  it.each(['append', 'seal', 'revisit', 'empty-revisit'] as const)('preserves a falsy %s failure when the owned reconstruction close also fails', operation => {
    const bundle = freeze(singletons().map(material => material.kind === 'shared-context' ? { ...material, content: Buffer.alloc(0) } : material));
    const machine = new WorkflowReviewCoverageMachine(bundle);
    const { receipts } = pageEveryRange(bundle);
    const receipt = operation === 'empty-revisit'
      ? workflowReviewSourceReceipt(readWorkflowReviewSource(bundle, { kind: 'entry', id: 'shared-context' })) : receipts[0]!;
    if (operation === 'revisit' || operation === 'empty-revisit') for (const item of receipts) machine.record(item);
    const method = operation === 'append' ? 'append' : operation === 'revisit' ? 'read' : 'seal';
    const close = WorkflowReviewOwnedFile.prototype.close;
    const targets = new WeakSet<WorkflowReviewOwnedFile>(); let closed = false;
    const fault = vi.spyOn(WorkflowReviewOwnedFile.prototype, method).mockImplementation(function (this: WorkflowReviewOwnedFile) {
      targets.add(this); throw undefined;
    });
    const closing = vi.spyOn(WorkflowReviewOwnedFile.prototype, 'close').mockImplementation(function (this: WorkflowReviewOwnedFile) {
      close.call(this); if (targets.has(this)) { closed = true; throw new Error('secondary owned close'); }
    });
    let failure: { value: unknown } | undefined;
    try { machine.record(receipt); } catch (value) { failure = { value }; }
    finally { fault.mockRestore(); closing.mockRestore(); machine.dispose(); }
    expect(closed).toBe(true); expect(failure).toEqual({ value: undefined });
  });

  it.each(['write', 'hash'] as const)('preserves a falsy artifact %s error across close and cleans a claimed partial write', operation => {
    const path = join(scratch(), 'artifact'); if (operation === 'hash') writeFileSync(path, 'original');
    const close = fs.closeSync; let injected = false; let closed = false;
    const fault = operation === 'write'
      ? vi.spyOn(fs, 'writeSync').mockImplementation(() => { injected = true; throw undefined; })
      : vi.spyOn(fs, 'readSync').mockImplementation(() => { injected = true; throw undefined; });
    const closing = vi.spyOn(fs, 'closeSync').mockImplementation(fd => { close(fd); closed = true; throw new Error('secondary artifact close'); });
    let failure: { value: unknown } | undefined;
    try { if (operation === 'write') writeWorkflowReviewArtifact({ path, chunks: ['value'] }); else hashWorkflowReviewArtifact(path); }
    catch (value) { failure = { value }; }
    finally { fault.mockRestore(); closing.mockRestore(); }
    expect(injected).toBe(true); expect(closed).toBe(true); expect(failure).toEqual({ value: undefined });
    expect(existsSync(path)).toBe(operation === 'hash');
  });

  it('retains an empty reconstruction proof and accepts a fresh acknowledged empty revisit', () => {
    const bundle = freeze(singletons().map(material => material.kind === 'shared-context' ? { ...material, content: Buffer.alloc(0) } : material));
    const directory = join(scratch(), 'proof');
    const machine = new WorkflowReviewCoverageMachine(bundle, { directory, invocationId: 'invocation', reviewerId: 'synthetic-reviewer', effectiveInvocationDigest: digest('launch') });
    const { receipts, ranges } = pageEveryRange(bundle);
    try {
      for (let index = 0; index < receipts.length; index++) machine.record(receipts[index], index + 1);
      const empty = workflowReviewSourceReceipt(readWorkflowReviewSource(bundle, { kind: 'entry', id: 'shared-context' }));
      expect(machine.record(empty, receipts.length + 1)).toBe(false);
      machine.finish(attestationFor(bundle, ranges));
      const proof = readFileSync(join(directory, machine.retainedProof.name), 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const record = proof.find(value => value.id === 'shared-context');
      expect(record).toMatchObject({ bytes: 0, sha256: digest(''), invocationId: 'invocation' });
      expect(statSync(join(directory, record.name)).size).toBe(0);
    } finally { machine.dispose(); }
  });

  it('validates a real async coverage ledger with a multibyte codepoint split at byte 65536', async () => {
    const bundle = freeze([{ kind: 'instruction', path: 'AGENTS.md', content: Buffer.from('é😀'.repeat(20_000)) }, ...singletons()]);
    const { receipts, ranges } = pageEveryRange(bundle); const path = join(scratch(), 'ledger.jsonl');
    let written = 0; let aligned = false;
    writeWorkflowReviewArtifact({ path, chunks: (function* () {
      for (const receipt of receipts) {
        const line = JSON.stringify(receipt) + '\n'; const bytes = Buffer.from(line); const at = bytes.indexOf(Buffer.from('é'));
        if (!aligned && at >= 0) {
          const padding = (65535 - ((written + at) % 65536) + 65536) % 65536;
          yield ' '.repeat(padding); written += padding; aligned = true;
        }
        yield bytes; written += bytes.length;
      }
    })() });
    expect(aligned).toBe(true);
    const proof = await validateWorkflowReviewCoverageLedger(bundle, { ledger: streamWorkflowReviewLines(path), attestation: attestationFor(bundle, ranges), reviewerId: 'synthetic-reviewer' });
    expect(proof.ranges).toBe(ranges);
    const invalid = join(scratch(), 'invalid.jsonl'); writeFileSync(invalid, Buffer.from([0x22, 0xe2, 0x82]));
    await expect((async () => { for await (const _line of streamWorkflowReviewLines(invalid)) { /* consume the actual EOF */ } })()).rejects.toThrow();
  });

  it('canonicalizes a positive temporary root created through an alias while refusing raw aliases and hardlinks', () => {
    const owner = scratch(), actual = join(owner, 'actual'), alias = join(owner, 'alias');
    mkdirSync(actual); symlinkSync(actual, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const raw = mkdtempSync(join(alias, 'positive-')), canonical = fs.realpathSync(raw);
    const owned = new WorkflowReviewOwnedFile(canonical, 'receipt', true); owned.append(Buffer.from('held')); owned.close();
    expect(() => new WorkflowReviewOwnedFile(raw, 'receipt')).toThrow('workflow_review_evidence_custody');
    linkSync(join(canonical, 'receipt'), join(canonical, 'linked'));
    expect(() => new WorkflowReviewOwnedFile(canonical, 'receipt')).toThrow('workflow_review_evidence_custody');
  });

  it('holds intended ledger custody across asynchronous line iteration and sealing', async () => {
    const root = scratch(); const path = join(root, 'intended.jsonl');
    const original = '"first"\n' + ' '.repeat(65536) + '"é😀"\n';
    writeFileSync(path, original);
    const owned = new WorkflowReviewOwnedFile(root, 'intended.jsonl');
    const lines = streamWorkflowReviewLines(owned);
    try {
      expect(await lines.next()).toEqual({ done: false, value: '"first"\n' });
      writeFileSync(path, original.replace('first', 'other'));
      await expect(lines.next()).rejects.toThrow('workflow_review_evidence_custody');
      expect(() => owned.seal()).toThrow('workflow_review_evidence_custody');
    } finally { await lines.return(undefined); owned.close(); }
  });

  it.each(['-r', '-r./unsealed.cjs', '-e', '--eval=import("./unsealed.mjs")', '-p', '--print', '--import', '--loader=./outside.mjs', '--experimental-loader'])('refuses unsealed Node bootstrap %s before creating a synthetic capsule', async flag => {
    const directory = join(scratch(), 'capsule'); const length = process.execArgv.length;
    process.execArgv.push(flag, './unsealed-preload.cjs');
    try {
      await expect(buildWorkflowSyntheticReviewCapsule(directory)).rejects.toThrow('workflow_review_runtime_closure_unavailable');
      expect(existsSync(directory)).toBe(false);
    } finally { process.execArgv.splice(length); }
  });

  it('seals only an absolute closed diagnostic preload and refuses extra executable syntax', () => {
    const path = fs.realpathSync(scratch()) + (process.platform === 'win32' ? '\\' : '/') + 'diagnostics.cjs';
    const source = `const ignored = new Set(['a warning']); const { emit } = process;
      process.emit = function (kind, detail) { if (kind === 'warning' && ignored.has(detail.message)) { return; }
        return Reflect.apply(emit, this, arguments); };`;
    const length = process.execArgv.length;
    writeFileSync(path, source); process.execArgv.push('--require', path);
    try {
      const initial = workflowSyntheticRuntimeClosure();
      writeFileSync(path, source.replace('a warning', 'another warning'));
      expect(workflowSyntheticRuntimeClosure().sha256).not.toBe(initial.sha256);
      writeFileSync(path, source + '\nprocess.emit.constructor("return require")();');
      expect(() => workflowSyntheticRuntimeClosure()).toThrow('workflow_review_runtime_closure_unavailable');
      process.execArgv[length + 1] = './diagnostics.cjs';
      expect(() => workflowSyntheticRuntimeClosure()).toThrow('workflow_review_runtime_closure_unavailable');
    } finally { process.execArgv.splice(length); }
  }, 240_000);

  it('distinguishes full-key collisions from duplicate members', () => {
    const original = crypto.createHash;
    vi.spyOn(crypto, 'createHash').mockImplementation((algorithm, options) => {
      const hash = original(algorithm, options); const update = hash.update.bind(hash); let key = false;
      hash.update = ((data: string | Buffer, encoding?: BufferEncoding) => {
        if (typeof data === 'string' && data.startsWith('source\0')) key = true;
        return typeof data === 'string' ? update(data, encoding ?? 'utf8') : update(data);
      }) as typeof hash.update;
      const finish = hash.digest.bind(hash);
      hash.digest = ((encoding?: 'hex') => key && encoding === 'hex' ? 'a'.repeat(64) : encoding ? finish(encoding) : finish()) as typeof hash.digest;
      return hash;
    });
    expect(() => freeze([{ kind: 'source', path: 'one.txt', content: Buffer.from('one') },
      { kind: 'source', path: 'two.txt', content: Buffer.from('two') }, ...singletons()])).toThrow('workflow_review_source_key_collision');
  });

  it('cleans only claimed bundle directories after mkdir and index failures and preserves a racing winner', () => {
    const originalMkdir = fs.mkdirSync; const originalOpen = fs.openSync;
    for (const point of ['entries', 'records', 'index', 'race', 'initial']) {
      const root = scratch(); const directory = join(root, 'bundle'); const primary = Object.assign(new Error(`failure_${point}`), { code: 'EACCES' });
      const mkdir = vi.spyOn(fs, 'mkdirSync').mockImplementation(((path: fs.PathLike, options: fs.MakeDirectoryOptions) => {
        if (String(path) === directory && point === 'race') {
          originalMkdir(directory); writeFileSync(join(directory, 'winner'), 'preserved');
          throw Object.assign(new Error('race'), { code: 'EEXIST' });
        }
        if (String(path) === directory && point === 'initial' || String(path) === join(directory, point) && ['entries', 'records'].includes(point)) throw primary;
        return originalMkdir(path, options);
      }) as typeof fs.mkdirSync);
      const open = vi.spyOn(fs, 'openSync').mockImplementation((path, flags, mode) => {
        if (point === 'index' && String(path) === join(directory, WORKFLOW_REVIEW_INDEX_FILE)) throw primary;
        return originalOpen(path, flags, mode);
      });
      try {
        expect(() => buildWorkflowReviewSourceBundle({ ...IDENTITY, directory, materials: singletons() }))
          .toThrow(point === 'race' ? 'workflow_review_source_bundle_exists' : primary.message);
        if (point === 'race') expect(readFileSync(join(directory, 'winner'), 'utf8')).toBe('preserved');
        else expect(existsSync(directory)).toBe(false);
      } finally { open.mockRestore(); mkdir.mockRestore(); }
    }
  });

  it('settles owned fallback listing handles before cleanup and preserves primary and falsy failures', () => {
    for (const point of ['open', 'first', 'later', 'close', 'primary-and-close', 'race']) {
      const bundle = freeze(singletons()); const target = join(scratch(), 'published');
      const originalRename = fs.renameSync; const originalOpen = fs.opendirSync; const originalMkdir = fs.mkdirSync;
      let opened = false; let closed = false; let reads = 0;
      const primary = point === 'primary-and-close' ? undefined : new Error(`fallback_${point}`);
      const rename = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
        if (String(from) === bundle.directory) throw Object.assign(new Error('transient'), { code: 'EACCES' });
        return originalRename(from, to);
      });
      const mkdir = vi.spyOn(fs, 'mkdirSync').mockImplementation(((path: fs.PathLike, options: fs.MakeDirectoryOptions) => {
        if (point === 'race' && String(path) === target) {
          originalMkdir(target); writeFileSync(join(target, 'winner'), 'retained');
          throw Object.assign(new Error('winner'), { code: 'EEXIST' });
        }
        return originalMkdir(path, options);
      }) as typeof fs.mkdirSync);
      const open = vi.spyOn(fs, 'opendirSync').mockImplementation((path, options) => {
        if (String(path) !== bundle.directory) return originalOpen(path, options);
        if (point === 'open') throw primary;
        const directory = originalOpen(path, options); opened = true;
        const read = directory.readSync.bind(directory); const close = directory.closeSync.bind(directory);
        directory.readSync = () => {
          reads++;
          if (point === 'first' || point === 'primary-and-close' || point === 'later' && reads === 2) throw primary;
          return read();
        };
        directory.closeSync = () => { close(); closed = true; if (point === 'close' || point === 'primary-and-close') throw new Error('fallback_close'); };
        return directory;
      });
      const originalRemove = fs.rmSync;
      const remove = vi.spyOn(fs, 'rmSync').mockImplementation((path, options) => {
        if (String(path) === target && opened) expect(closed).toBe(true);
        return originalRemove(path, options);
      });
      try {
        let caught = false; let error: unknown;
        try { publishWorkflowReviewBundle(bundle, target); } catch (value) { caught = true; error = value; }
        expect(caught).toBe(true);
        if (point === 'primary-and-close') expect(error).toBeUndefined();
        else expect((error as Error).message).toBe(point === 'race' ? 'winner' : point === 'close' ? 'fallback_close' : `fallback_${point}`);
        expect(existsSync(bundle.directory)).toBe(true);
        if (point === 'race') expect(readFileSync(join(target, 'winner'), 'utf8')).toBe('retained');
        else expect(existsSync(target)).toBe(false);
        if (opened) expect(closed).toBe(true);
      } finally { remove.mockRestore(); open.mockRestore(); mkdir.mockRestore(); rename.mockRestore(); }
    }
  });

  it('captures original malformed and trailing bytes before refusing UTF-8, EOF and future frames', () => {
    const captured: Buffer[] = [];
    const decoder = new WorkflowReviewFrameDecoder(() => { throw new Error('must not parse invalid UTF-8'); }, 8192,
      bytes => captured.push(Buffer.from(bytes)));
    const invalid = Buffer.from([0x22, 0xc3, 0x22, 10]);
    expect(() => decoder.write(invalid)).toThrow('workflow_review_transport_invalid_utf8');
    expect(captured).toEqual([invalid]);
    const trailing: Buffer[] = [];
    const eof = new WorkflowReviewFrameDecoder(() => {}, 8192, bytes => trailing.push(Buffer.from(bytes)));
    eof.write(Buffer.from([0xe2, 0x82]));
    expect(() => eof.end()).toThrow();
    expect(trailing).toEqual([Buffer.from([0xe2, 0x82])]);
    expect(() => eof.write(Buffer.from('{}\n'))).toThrow();
    let received = '';
    const split = new WorkflowReviewFrameDecoder(bytes => { received = bytes.toString('utf8'); });
    for (const byte of Buffer.from('{"value":"😀é"}\n')) split.write(Buffer.from([byte]));
    split.end(); expect(received).toBe('{"value":"😀é"}\n');
    const falsy = new WorkflowReviewFrameDecoder(() => { throw undefined; });
    for (const operation of [() => falsy.write(Buffer.from('{}\n')), () => falsy.write(Buffer.from('{}\n')), () => falsy.end()]) {
      let caught = false; let error: unknown = 'unset'; try { operation(); } catch (value) { caught = true; error = value; }
      expect(caught).toBe(true); expect(error).toBeUndefined();
    }
  });

  it('binds bridge ACKs to original frames and rejects ID aliases, malformed EOF and late failures for future calls', async () => {
    for (const mode of ['ack', 'alias', 'truncated', 'invalid', 'missing', 'late']) {
      const invocation = `bridge-${mode}-${Date.now()}`;
      const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\${invocation}` : join(scratch(), 'bridge.sock');
      vi.stubEnv('OMC_REVIEW_RELAY', endpoint); vi.stubEnv('OMC_REVIEW_RELAY_TOKEN', 'secret'); vi.stubEnv('OMC_REVIEW_INVOCATION', invocation);
      let peer: Socket | undefined; let peerClosed = Promise.resolve();
      let resolveAck!: (value: unknown) => void;
      const acknowledged = new Promise<unknown>(resolve => { resolveAck = resolve; });
      const original = Buffer.from('{ "jsonrpc":"2.0", "id":1, "result":{"note":"é😀"} }\r\n');
      const server = createServer(socket => {
        peer = socket; peerClosed = new Promise(resolve => socket.once('close', resolve));
        socket.on('error', () => {});
        const decoder = new WorkflowReviewFrameDecoder(bytes => {
          const message = JSON.parse(bytes.toString('utf8'));
          if (message.token) { socket.write(JSON.stringify({ ready: invocation }) + '\n'); return; }
          if (message.ack) { resolveAck(message); if (mode === 'late') socket.end(Buffer.from([0xe2, 0x82])); return; }
          if (message.complete) { socket.end(JSON.stringify({ settled: invocation }) + '\n'); return; }
          if (mode === 'missing') { socket.end(); return; }
          if (mode === 'truncated') { socket.end('{"jsonrpc":'); return; }
          if (mode === 'invalid') { socket.end(Buffer.from([0x22, 0xc3, 0x22, 10])); return; }
          const response = mode === 'alias' ? Buffer.from('{"jsonrpc":"2.0","id":"1","result":{}}\n') : original;
          for (const byte of response) socket.write(Buffer.from([byte]));
        });
        socket.on('data', bytes => decoder.write(bytes));
      });
      const serverClosed = new Promise(resolve => server.once('close', resolve));
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(endpoint, resolve); });
      const connect = net.createConnection; let clientClosed = false;
      const connectSpy = vi.spyOn(net, 'createConnection').mockImplementation((...args) => {
        const socket = Reflect.apply(connect, undefined, args) as Socket;
        socket.once('close', () => { clientClosed = true; }); return socket;
      });
      const bridge = await connectWorkflowSyntheticReviewBridge();
      try {
        if (mode === 'ack' || mode === 'late') {
          expect(await bridge.call('initialize', {})).toMatchObject({ id: 1, result: { note: 'é😀' } });
          expect(await acknowledged).toEqual({ ack: 1, requestId: 1, sha256: digest(original) });
          if (mode === 'ack') await bridge.close();
          else { await peerClosed; await expect(bridge.close()).rejects.toThrow('workflow_review_transport_truncated'); }
        } else {
          await expect(bridge.call('initialize', {})).rejects.toThrow();
          await expect(bridge.close()).rejects.toThrow();
        }
        expect(clientClosed).toBe(true);
        await expect(bridge.call('tools/list', {})).rejects.toThrow();
      } finally {
        connectSpy.mockRestore();
        peer?.destroy(); await peerClosed;
        server.close(); await serverClosed;
      }
    }
  }, 30_000);

  it.each(['eof', 'truncated', 'wrong'] as const)('joins the actual client close after a %s readiness failure', async mode => {
    const invocation = `ready-${mode}-${Date.now()}`;
    const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\${invocation}` : join(scratch(), 'ready.sock');
    vi.stubEnv('OMC_REVIEW_RELAY', endpoint); vi.stubEnv('OMC_REVIEW_RELAY_TOKEN', 'secret'); vi.stubEnv('OMC_REVIEW_INVOCATION', invocation);
    let peer: Socket | undefined; let peerClosed = Promise.resolve();
    const server = createServer(socket => {
      peer = socket; peerClosed = new Promise(resolve => socket.once('close', resolve)); socket.on('error', () => {});
      socket.once('data', () => socket.end(mode === 'wrong' ? '{"ready":"another"}\n' : mode === 'truncated' ? '{"ready":' : ''));
    });
    const serverClosed = new Promise(resolve => server.once('close', resolve));
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(endpoint, resolve); });
    const connect = net.createConnection; let clientClosed = false;
    const connectSpy = vi.spyOn(net, 'createConnection').mockImplementation((...args) => {
      const socket = Reflect.apply(connect, undefined, args) as Socket;
      socket.once('close', () => { clientClosed = true; }); return socket;
    });
    try {
      await expect(connectWorkflowSyntheticReviewBridge()).rejects.toThrow(mode === 'truncated'
        ? 'workflow_review_transport_truncated' : mode === 'wrong' ? 'workflow_review_transport_response_mismatch' : 'workflow_review_transport_eof');
      expect(clientClosed).toBe(true);
    } finally { connectSpy.mockRestore(); peer?.destroy(); await peerClosed; server.close(); await serverClosed; }
  });

  it('refuses native direct verification and factory lookalikes without artifact effects', () => {
    expect(() => requireWorkflowSyntheticReviewClientFactory({ mode: 'synthetic' })).toThrow('workflow_review_reader_observation_required');
    expect(() => Reflect.construct(WorkflowSyntheticReviewSession, [{}, {}, {}, () => undefined, [], []]))
      .toThrow('workflow_review_reader_observation_required');
    expect(() => verifyWorkflowReviewReaderQualification({ validation: 'native' } as never, {} as never, true))
      .toThrow('workflow_review_reader_qualification_required');
  });

  it('pins opened evidence for its entire read lifetime and refuses aliases, replacements and escapes', () => {
    const root = scratch(); const path = join(root, 'frames.bin');
    const created = new WorkflowReviewOwnedFile(root, 'frames.bin', true);
    created.append(Buffer.from('first')); const reference = created.seal(); created.close();
    const opened = new WorkflowReviewOwnedFile(root, 'frames.bin');
    expect(opened.read(0, 5).toString()).toBe('first');
    writeFileSync(path, 'other');
    expect(() => opened.read(0, 5)).toThrow('workflow_review_evidence_custody'); opened.close();
    expect(reference.bytes).toBe(5);
    linkSync(path, join(root, 'alias.bin'));
    expect(() => new WorkflowReviewOwnedFile(root, 'frames.bin')).toThrow('workflow_review_evidence_custody');
    expect(() => new WorkflowReviewOwnedFile(root, '../escape')).toThrow('workflow_review_evidence_escape');
  });

  it('serves actual SDK stdio frames with exact long escaped multibyte IDs, bounded errors and actual close', async () => {
    const bundle = freeze([{ kind: 'source', path: 'binary.bin', content: patternBytes(24_000, 4) }, ...singletons()]);
    const entry = join(scratch(), 'reader.mjs');
    await build({ stdin: { contents: `import { runWorkflowReviewSourceServer } from ${JSON.stringify(fileURLToPath(new URL('../workflow-review-source-server.ts', import.meta.url)))}; await runWorkflowReviewSourceServer();`,
      resolveDir: process.cwd(), loader: 'js' }, define: { OMC_SYNTHETIC_LIBRARY: 'true' }, external: ['esbuild', '@ast-grep/napi'],
      bundle: true, platform: 'node', format: 'esm', target: 'node24', outfile: entry, logLevel: 'silent' });
    const child = spawn(process.execPath, [entry], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      env: { ...process.env, OMC_REVIEW_SOURCE_BUNDLE: bundle.directory } });
    const closed = new Promise<{ code: number | null; signal: string | null }>(resolveClose => child.once('close', (code, signal) => resolveClose({ code, signal })));
    let pending: { id: unknown; resolve: (value: Record<string, unknown>) => void; reject: (error: unknown) => void } | undefined;
    let failure: { value: unknown } | undefined;
    const fail = (error: unknown) => { failure ??= { value: error }; pending?.reject(failure.value); pending = undefined; };
    const decoder = new WorkflowReviewFrameDecoder(frame => {
      expect(frame.length).toBeLessThanOrEqual(WORKFLOW_REVIEW_READ_LIMIT_BYTES);
      const value = JSON.parse(frame.toString('utf8'));
      if (!pending || value.id !== pending.id || typeof value.id !== typeof pending.id) throw new Error('strict response ID mismatch');
      const current = pending; pending = undefined; current.resolve(value);
    });
    child.stdout.on('data', bytes => {
      try { for (const byte of bytes as Buffer) decoder.write(Buffer.from([byte])); } catch (error) { fail(error); }
    });
    child.stdout.on('end', () => { try { decoder.end(); } catch (error) { fail(error); } fail(new Error('actual stdout EOF')); });
    child.on('error', fail); child.stdin.on('error', fail); child.stderr.resume();
    const send = (id: unknown, method: string, params: unknown) => new Promise<Record<string, unknown>>((resolveResponse, reject) => {
      if (failure) { reject(failure.value); return; }
      pending = { id, resolve: resolveResponse, reject };
      const request = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      // Deliberately partition every inbound UTF-8 codepoint before the actual SDK transport sees it.
      for (const byte of request) child.stdin.write(Buffer.from([byte]));
    });
    try {
      await send(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'strict-stdio', version: '1' } });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      const listed = await send('1', 'tools/list', {});
      expect((listed.result as { tools: unknown[] }).tools).toHaveLength(2);
      const id = '\\"😀é'.repeat(250);
      const response = await send(id, 'tools/call', { name: WORKFLOW_REVIEW_READER_TOOL_READ, arguments: { id: 'src-0' } });
      const page = JSON.parse((response.result as { content: { text: string }[] }).content[0]!.text);
      expect(page.encoding).toBe('base64'); expect(page.complete).toBe(false);
      expect(Buffer.from(page.content, 'base64')).toEqual(patternBytes(24_000, 4).subarray(0, page.bytes));
      const refusal = await send('refusalé', 'tools/call', { name: 'not_a_reader_tool', arguments: {} });
      expect(refusal.result).toMatchObject({ isError: true });
      const error = await send('error\\"', 'not_a_method', {}); expect(error).toHaveProperty('error');
      const oversized = send('x'.repeat(8192), 'tools/list', {});
      child.stdin.end(); await expect(oversized).rejects.toThrow('actual stdout EOF');
      expect(await closed).toEqual({ code: 0, signal: null });
      await expect(send(2, 'tools/list', {})).rejects.toThrow('actual stdout EOF');
    } finally { child.stdin.end(); if (child.exitCode === null) child.kill(); await closed; }
  }, 120_000);

  it('keeps positioned read and retained lifetime costs fixed for one tiny page', () => {
    const bundle = freeze([{ kind: 'source', path: 'tiny.txt', content: Buffer.from('tiny') }, ...singletons()]);
    resetWorkflowReviewResourceUsage();
    readWorkflowReviewSource(bundle, { kind: 'entry', id: 'src-0' });
    expect(workflowReviewResourceUsage()).toMatchObject({ records: 0, descriptors: 0, bufferBytes: 0,
      recordLookups: 1, pageRequests: 1, positionedReads: 1, fullVerifications: 0 });
  });
});
/**
 * Walk the constant descriptor's records. The bundle itself exposes no entry array, so a test that
 * needs the entry set iterates it exactly as any other consumer must — one bounded record at a time.
 */
function entriesOf(bundle: WorkflowReviewSourceBundle): WorkflowReviewSourceEntry[] {
  return [...iterateWorkflowReviewManifestEntries(bundle)];
}
/** The bundle id each supply position receives, matching the builder's own ordering. */
function idsFor(materials: readonly WorkflowReviewMaterialInput[]): string[] {
  const counters = new Map<string, number>();
  return materials.map(material => {
    const index = counters.get(material.kind) ?? 0; counters.set(material.kind, index + 1);
    if (material.kind === 'instruction') return `instr-${index}`;
    if (material.kind === 'source') return `src-${index}`;
    return material.kind;
  });
}
function bytesOf(material: WorkflowReviewMaterialInput): Buffer {
  return material.content ?? material.chunks === undefined ? material.content! : readFileSync(material.file!);
}
/**
 * The actual wire length of one response: the encoded JSON-RPC message plus the single newline the
 * stdio transport frames it with. The policy bound applies to these bytes, so the two measurements
 * below must agree exactly — a page that fits only when the newline is ignored does not fit.
 */
const encodedBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value)) + 1;
/** Page one object by following opaque cursors, exactly as a reviewing model must. */
function pageObject(bundle: WorkflowReviewSourceBundle, kind: 'manifest' | 'entry', id?: string): {
  pages: ReturnType<typeof readWorkflowReviewSource>[]; content: Buffer; encoding: 'utf8' | 'base64';
} {
  const pages: ReturnType<typeof readWorkflowReviewSource>[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = readWorkflowReviewSource(bundle, { kind, ...(id === undefined ? {} : { id }), ...(cursor ? { cursor } : {}) });
    pages.push(page);
    // The bound is on the whole JSON-RPC response, not just the JSON text inside it.
    expect(workflowReviewResponseBytes(page)).toBeLessThanOrEqual(WORKFLOW_REVIEW_READ_LIMIT_BYTES);
    expect(encodedBytes(workflowReviewResponse(page))).toBe(workflowReviewResponseBytes(page));
    expect(page.cursor === null).toBe(page.complete);
    if (page.complete) break;
    cursor = page.cursor!;
  }
  // Each page declares its own encoding: a text region followed by a short non-UTF-8 tail can
  // legitimately switch, so decoding is per page rather than by the first page's encoding.
  const content = Buffer.concat(pages.map(page => page.encoding === 'utf8'
    ? Buffer.from(page.content, 'utf8') : Buffer.from(page.content, 'base64')));
  return { pages, content, encoding: pages[0]!.encoding };
}
/**
 * Page a whole frozen bundle exactly as a client would — the manifest first, then every entry by its
 * opaque continuation cursor — and return the receipts of the ranges that were actually delivered. An
 * empty material is served as one complete zero-byte page and is never a delivered range, exactly as
 * the coverage machine counts them.
 */
function observedReceipts(bundle: WorkflowReviewSourceBundle): WorkflowReviewSourceReceipt[] {
  const receipts: WorkflowReviewSourceReceipt[] = [];
  const walk = (kind: 'manifest' | 'entry', id?: string): void => {
    let cursor: string | undefined;
    for (;;) {
      const page = readWorkflowReviewSource(bundle, { kind, ...(id === undefined ? {} : { id }), ...(cursor ? { cursor } : {}) });
      if (page.bytes > 0) receipts.push(workflowReviewSourceReceipt(page));
      if (page.complete) return;
      cursor = page.cursor!;
    }
  };
  walk('manifest');
  for (const entry of entriesOf(bundle)) walk('entry', entry.id);
  return receipts;
}
/** Spool an ordered receipt sequence as one bounded JSONL evidence artifact and describe it. */
function writeLedger(path: string, receipts: readonly WorkflowReviewSourceReceipt[]) {
  const written = writeWorkflowReviewArtifact({ path, chunks: receipts.map(receipt => `${JSON.stringify(receipt)}\n`) });
  return { path, sha256: written.sha256, bytes: written.bytes, ranges: receipts.length };
}
/** Page the whole manifest and every entry through the reader, exactly as a reviewer must. */
function pageEveryRange(bundle: WorkflowReviewSourceBundle): { receipts: WorkflowReviewSourceReceipt[]; ranges: number; manifestReads: number } {
  const receipts: WorkflowReviewSourceReceipt[] = [];
  let manifestReads = 0;
  for (const page of pageObject(bundle, 'manifest').pages) {
    manifestReads += 1;
    expect(page.path).toBeNull();
    expect(page.id).toBeNull();
    // The receipt carries the exact returned bytes, so coverage is proven from the transport. A
    // zero-byte manifest page is its terminal receipt too, and is recorded like any other.
    receipts.push(workflowReviewSourceReceipt(page));
  }
  for (const entry of iterateWorkflowReviewManifestEntries(bundle)) {
    for (const read of pageObject(bundle, 'entry', entry.id).pages) {
      expect(read.id).toBe(entry.id);
      // An empty material has no range to deliver, but its one complete zero-byte page is still the
      // terminal receipt that proves it was delivered, so it is recorded rather than skipped.
      if (read.bytes === 0) expect(entry.bytes).toBe(0);
      receipts.push(workflowReviewSourceReceipt(read));
    }
  }
  // The attested range count is the number of *delivered ranges*: a terminal zero-byte page proves
  // its empty object but carries no range, so it is a receipt without being a range.
  return { receipts, ranges: receipts.filter(receipt => receipt.bytes > 0).length, manifestReads };
}
/** The receipt as it would have been returned had the transport delivered different bytes. */
function withReturnedBytes(receipt: WorkflowReviewSourceReceipt, content: string,
  override: Partial<WorkflowReviewSourceReceipt> = {}): WorkflowReviewSourceReceipt {
  const bytes = receipt.encoding === 'base64' ? Buffer.from(content, 'base64') : Buffer.from(content, 'utf8');
  return { ...receipt, ...override, bytes: bytes.length, rangeSha256: digest(bytes), content };
}
const attestationFor = (bundle: WorkflowReviewSourceBundle, ranges: number, reviewerId = 'synthetic-reviewer') =>
  ({ bundleSha256: bundle.digest, reviewerId, complete: true as const, entries: bundle.entryCount, ranges });

describe('lossless complete review source delivery', () => {
  let fixture: ReturnType<typeof createWorkflowFixture> | undefined;
  afterEach(() => { vi.unstubAllEnvs(); fixture?.dispose(); fixture = undefined; });

  it('freezes one hash-bound on-disk bundle exposed as a constant descriptor plus disk records', () => {
    const materials = syntheticMaterials();
    const bundle = freeze(materials);
    const entries = entriesOf(bundle);
    expect(entries.map(entry => entry.id)).toEqual(idsFor(materials));
    expect(entries).toHaveLength(71);
    expect(bundle.entryCount).toBe(71);
    // The descriptor holds no entry list at all — only paths, digests and counts — so nothing about
    // it can grow with the size of the source or act as an aggregate ceiling.
    expect(Object.keys(bundle).sort()).toEqual(['baseCommit', 'digest', 'directory', 'entriesDirectory', 'entryCount',
      'head', 'indexBytes', 'indexDigest', 'indexPath', 'manifestBytes', 'manifestPath', 'recordsDirectory',
      'repositoryIdentity', 'schemaVersion', 'totalBytes']);
    expect(entries.filter(entry => entry.kind === 'instruction').map(entry => entry.id)).toEqual(['instr-0', 'instr-1']);
    expect(entries.filter(entry => entry.kind === 'source')).toHaveLength(64);
    expect(entries.filter(entry => entry.kind === 'source').reduce((total, entry) => total + entry.bytes, 0)).toBe(1494639);
    expect(bundle.totalBytes).toBe(1494639 + 22779 + 6001 + Object.values(SINGLETON_BYTES).reduce((t, b) => t + b.length, 0));
    // Every entry is an immutable on-disk file whose digest and length the manifest already bound.
    for (const entry of entries) {
      const hashed = hashWorkflowReviewArtifact(join(bundle.directory, WORKFLOW_REVIEW_ENTRIES_DIRECTORY, entry.id));
      expect(hashed).toEqual({ bytes: entry.bytes, sha256: entry.sha256 });
      // The bounded metadata record is a disk record too, and the index agrees with it exactly.
      expect(JSON.parse(readFileSync(join(bundle.directory, WORKFLOW_REVIEW_RECORDS_DIRECTORY, entry.id), 'utf8')))
        .toEqual({ id: entry.id, kind: entry.kind, path: entry.path, bytes: entry.bytes, sha256: entry.sha256 });
    }
    // The index and the manifest tile each other exactly, one bounded record at a time.
    expect([...iterateWorkflowReviewIndexEntries(bundle)].map(entry => [entry.id, entry.sha256, entry.bytes]))
      .toEqual(entries.map(entry => [entry.id, entry.sha256, entry.bytes]));
    const manifestBytes = readFileSync(join(bundle.directory, WORKFLOW_REVIEW_MANIFEST_FILE));
    expect(bundle.digest).toBe(digest(manifestBytes));
    expect(bundle.indexDigest).toBe(digest(readFileSync(join(bundle.directory, WORKFLOW_REVIEW_INDEX_FILE))));
    expect(JSON.parse(manifestBytes.toString('utf8'))).toMatchObject({ schemaVersion: 1, repository: IDENTITY.repository,
      baseCommit: IDENTITY.baseCommit, head: IDENTITY.head, totalBytes: bundle.totalBytes });
    expect(readFileSync(join(bundle.directory, WORKFLOW_REVIEW_INDEX_FILE), 'utf8').split('\n').filter(Boolean)).toHaveLength(71);
    expect(() => verifyWorkflowReviewSourceBundle(bundle)).not.toThrow();
    // Reopening the directory re-hashes every entry and re-digests the manifest to the same bundle.
    const reopened = openWorkflowReviewSourceBundle(bundle.directory);
    expect(reopened.digest).toBe(bundle.digest);
    expect(entriesOf(reopened).map(entry => [entry.id, entry.sha256, entry.bytes]))
      .toEqual(entries.map(entry => [entry.id, entry.sha256, entry.bytes]));
    // A material edited after the freeze is corruption, never a silently shorter read.
    const victim = entries[2]!;
    const original = readFileSync(victim.file);
    writeFileSync(victim.file, Buffer.concat([original, Buffer.from('tampered')]));
    expect(() => openWorkflowReviewSourceBundle(bundle.directory)).toThrow('workflow_review_source_corrupt');
    writeFileSync(victim.file, original);
    // A required material kind that never arrived fails the freeze itself, and leaves nothing behind.
    for (const omitted of ['inventory', 'diff', 'objective', 'shared-context', 'contracts']) {
      const directory = join(scratch(), 'partial');
      expect(() => buildWorkflowReviewSourceBundle({ ...IDENTITY, directory,
        materials: materials.filter(material => material.kind !== omitted) }))
        .toThrow('workflow_review_source_incomplete_material');
      expect(() => readFileSync(join(directory, WORKFLOW_REVIEW_MANIFEST_FILE))).toThrow();
    }
  });

  it('consumes a lazy material stream one bounded material at a time, without collecting it', () => {
    const materials = syntheticMaterials();
    // The builder must pull the stream itself: a generator that is never iterated would freeze an
    // empty bundle, so a bundle that comes out complete proves the stream was consumed lazily.
    let pulled = 0;
    function* counted(): Generator<WorkflowReviewMaterialInput> {
      for (const material of materials) { pulled += 1; yield material; }
    }
    const bundle = freeze(counted());
    expect(pulled).toBe(materials.length);
    expect(bundle.entryCount).toBe(materials.length);
    // A high-water material above any stream buffer is still frozen exactly, chunk by chunk.
    const oversized = patternBytes(RETIRED_BUNDLE_CEILING_BYTES + 1, 11);
    const sliced = freeze([{ kind: 'source', path: 'src/sliced.bin', chunks: (function* () {
      for (let offset = 0; offset < oversized.length; offset += 64 * 1024) yield oversized.subarray(offset, offset + 64 * 1024);
    })() }, ...singletons()]);
    const slicedEntry = entriesOf(sliced).find(entry => entry.id === 'src-0')!;
    expect(slicedEntry.bytes).toBe(oversized.length);
    expect(slicedEntry.sha256).toBe(digest(oversized));
    expect(hashWorkflowReviewArtifact(slicedEntry.file)).toEqual({ bytes: oversized.length, sha256: digest(oversized) });
  }, 120_000);

  it('accepts and delivers a source above the retired 16 MiB ceiling at its exact bytes', () => {
    // The staged bounded scaffold refused this exact shape with workflow_review_source_bundle_too_large.
    const oversized = patternBytes(RETIRED_BUNDLE_CEILING_BYTES + 1, 7);
    const bundle = freeze([{ kind: 'source', path: 'src/huge.bin', content: oversized }, ...singletons()]);
    expect(bundle.totalBytes).toBeGreaterThan(RETIRED_BUNDLE_CEILING_BYTES);
    expect(() => verifyWorkflowReviewSourceBundle(bundle)).not.toThrow();
    const { pages, content, encoding } = pageObject(bundle, 'entry', 'src-0');
    expect(pages.length).toBeGreaterThan(1);
    expect(encoding).toBe('base64');
    // Every byte of material above the retired ceiling survives the JSON round trip exactly.
    expect(content.length).toBe(oversized.length);
    expect(digest(content)).toBe(digest(oversized));
    expect(content.equals(oversized)).toBe(true);
    // The frozen aggregate is the true sum, not a clamped ceiling.
    expect(bundle.totalBytes).toBe(oversized.length + singletons().reduce((total, material) => total + bytesOf(material).length, 0));
  }, 120_000);

  it('serves bounded pages with opaque cursors, explicit offsets, completion and digests', () => {
    const materials = syntheticMaterials();
    const bundle = freeze(materials);
    const entry = entriesOf(bundle).find(candidate => candidate.id === 'src-0')!;
    const source = bytesOf(materials[2]!);
    const { pages, content, encoding } = pageObject(bundle, 'entry', 'src-0');
    expect(pages[0]!.offset).toBe(0);
    expect(pages[0]!.totalBytes).toBe(entry.bytes);
    expect(pages[0]!.complete).toBe(false);
    expect(encoding).toBe('base64');
    expect(pages[0]!.sha256).toBe(entry.sha256);
    expect(pages[0]!.bundleSha256).toBe(bundle.digest);
    expect(content.equals(source)).toBe(true);
    // Offsets tile the object exactly, and the recorded range digest matches the frozen bytes.
    let cursor = 0;
    for (const page of pages) {
      expect(page.offset).toBe(cursor);
      expect(page.rangeSha256).toBe(digest(source.subarray(page.offset, page.offset + page.bytes)));
      // The receipt of a served page carries the very bytes those two digests describe.
      const receipt = workflowReviewSourceReceipt(page);
      expect(receipt.content).toBe(page.content);
      expect(rangeBytes(receipt).length).toBe(page.bytes);
      expect(digest(rangeBytes(receipt))).toBe(page.rangeSha256);
      cursor += page.bytes;
    }
    expect(cursor).toBe(entry.bytes);
    // A UTF-8 instruction is served as text and truncation never splits a codepoint.
    const instruction = entriesOf(bundle).find(candidate => candidate.id === 'instr-0')!;
    expect(instruction.bytes).toBe(22779);
    const instructionPages = pageObject(bundle, 'entry', 'instr-0');
    expect(instructionPages.encoding).toBe('utf8');
    expect(instructionPages.content.toString('utf8').startsWith('§')).toBe(true);
    expect(instructionPages.content.equals(INSTRUCTION_AGENTS)).toBe(true);
    for (const page of instructionPages.pages) {
      expect(Buffer.from(page.content, 'utf8').equals(INSTRUCTION_AGENTS.subarray(page.offset, page.offset + page.bytes))).toBe(true);
    }
    const manifestPages = pageObject(bundle, 'manifest');
    expect(manifestPages.pages.length).toBeGreaterThan(1);
    expect(manifestPages.content.toString('utf8')).toBe(readFileSync(bundle.manifestPath, 'utf8'));
    const page = manifestPages.pages[0]!;
    expect(page.kind).toBe('manifest');
    expect(page.sha256).toBe(bundle.digest);
    // Unknown ids, forged cursors, cross-bundle cursors and malformed ranges fail closed.
    expect(() => readWorkflowReviewSource(bundle, { kind: 'entry', id: 'src-99' })).toThrow('workflow_review_source_unknown_id');
    expect(() => readWorkflowReviewSource(bundle, { kind: 'entry', id: '../src-0' })).toThrow('workflow_review_source_invalid_id');
    const other = freeze(syntheticMaterials().map(material => material.kind === 'objective'
      ? { ...material, content: Buffer.from('another objective\n') } : material));
    expect(other.digest).not.toBe(bundle.digest);
    const forged = pageObject(bundle, 'manifest').pages[0]!.cursor!;
    expect(() => readWorkflowReviewSource(other, { kind: 'manifest', cursor: forged })).toThrow('workflow_review_source_invalid_cursor');
    expect(() => readWorkflowReviewSource(bundle, { kind: 'entry', id: 'src-1', cursor: forged })).toThrow('workflow_review_source_invalid_cursor');
    expect(() => readWorkflowReviewSource(bundle, { kind: 'manifest', cursor: 'not base64 !!' })).toThrow('workflow_review_source_invalid_cursor');
    expect(() => readWorkflowReviewSource(bundle, { kind: 'manifest', cursor: Buffer.from('{"v":9}').toString('base64url') }))
      .toThrow('workflow_review_source_invalid_cursor');
  });

  it('delivers an empty material as one complete zero-byte page and requires its terminal receipt', () => {
    const materials = syntheticMaterials().map(material => material.kind === 'shared-context'
      ? { ...material, content: Buffer.alloc(0) } : material);
    const bundle = freeze(materials);
    const empty = entriesOf(bundle).find(entry => entry.id === 'shared-context')!;
    expect(empty.bytes).toBe(0);
    const { pages } = pageObject(bundle, 'entry', 'shared-context');
    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatchObject({ offset: 0, bytes: 0, complete: true, cursor: null, content: '' });
    // The empty material is delivered as exactly one complete zero-byte page, and that page is a
    // receipt: a transport that silently dropped it would leave the walk short of the frozen manifest.
    const { receipts, ranges } = pageEveryRange(bundle);
    const terminal = receipts.filter(receipt => receipt.id === 'shared-context');
    expect(terminal).toHaveLength(1);
    expect(terminal[0]).toMatchObject({ kind: 'entry', offset: 0, bytes: 0 });
    expect(() => validateWorkflowReviewCoverage(bundle, { receipts, attestation: attestationFor(bundle, ranges),
      reviewerId: 'synthetic-reviewer' })).not.toThrow();
    // Dropping the empty material's terminal receipt fails coverage: nothing else can stand in for it,
    // and its own zero length no longer closes the gap the frozen manifest still expects.
    const dropped = receipts.filter(receipt => receipt.id !== 'shared-context');
    expect(() => validateWorkflowReviewCoverage(bundle, { receipts: dropped,
      attestation: attestationFor(bundle, ranges), reviewerId: 'synthetic-reviewer' }))
      .toThrow('workflow_review_coverage_incomplete');
    // A zero-byte receipt is only ever the terminal page of an empty object at its own start, so a
    // rangeless delivery aimed at some other object is refused rather than counted.
    const misdirected = receipts.map(receipt => receipt.id === 'shared-context' ? { ...receipt, id: 'src-0' } : receipt);
    expect(() => validateWorkflowReviewCoverage(bundle, { receipts: misdirected,
      attestation: attestationFor(bundle, ranges), reviewerId: 'synthetic-reviewer' }))
      .toThrow('workflow_review_source_invalid_receipt');
  });

  it('moves a frozen bundle to its content-addressed name without changing a byte', () => {
    const bundle = freeze(syntheticMaterials());
    // A published bundle no longer exists at its frozen path, so the source entry set is walked to
    // completion before the move and only the published directory is read afterwards: the constant
    // descriptor carries no entry array, so nothing but the ids can be carried across the move.
    const ids = entriesOf(bundle).map(entry => entry.id);
    const published = join(scratch(), `review-source-bundle-${bundle.digest}`);
    const moved = publishWorkflowReviewBundle(bundle, published);
    expect(moved.directory).toBe(published);
    expect(moved.digest).toBe(bundle.digest);
    expect(entriesOf(moved).map(entry => entry.file))
      .toEqual(ids.map(id => join(published, WORKFLOW_REVIEW_ENTRIES_DIRECTORY, id)));
    expect(() => readFileSync(join(bundle.directory, WORKFLOW_REVIEW_MANIFEST_FILE))).toThrow();
    // A second freeze of the same material converges on the same immutable directory unchanged.
    const again = freeze(syntheticMaterials());
    expect(again.digest).toBe(bundle.digest);
    const converged = publishWorkflowReviewBundle(again, published);
    expect(converged.digest).toBe(bundle.digest);
    expect(() => readFileSync(join(again.directory, WORKFLOW_REVIEW_MANIFEST_FILE))).toThrow();
    expect(() => verifyWorkflowReviewSourceBundle(converged)).not.toThrow();
  });

  it('refuses a content-addressed destination that holds a different, internally consistent bundle', () => {
    // Two different authorized sets produce two different, equally valid freezes. Occupying one
    // bundle's content-addressed name with the other is a substitution rather than a convergence:
    // the destination is a well-formed bundle whose own digests verify, so nothing but a field-by-
    // field comparison against the fresh freeze can refuse it.
    const first = freeze(syntheticMaterials());
    const occupied = join(scratch(), `review-source-bundle-${first.digest}`);
    expect(publishWorkflowReviewBundle(first, occupied).digest).toBe(first.digest);
    const second = freeze([{ kind: 'source', path: 'src/other/unit.ts', content: Buffer.from('other\n') }, ...singletons()]);
    expect(second.digest).not.toBe(first.digest);
    expect(() => verifyWorkflowReviewSourceBundle(openWorkflowReviewSourceBundle(occupied))).not.toThrow();
    // The refusal keeps the fresh staging directory: the only copy of the bundle this caller was
    // handed must not be deleted because a different bundle was already sitting under the name.
    expect(() => publishWorkflowReviewBundle(second, occupied)).toThrow('workflow_review_source_corrupt');
    expect(statSync(join(second.directory, WORKFLOW_REVIEW_MANIFEST_FILE)).size).toBe(second.manifestBytes);
    expect(openWorkflowReviewSourceBundle(occupied).digest).toBe(first.digest);
  });

  it('parses escaped multibyte paths on the chunk seam with an exact trailer and header integer', () => {
    // Every authorized path carries a quote and a non-ASCII character, so the manifest's own string
    // escaping and byte-length accounting are exercised on every record. The filler below is then
    // solved so the entry array's closing bracket lands on the last byte of the first 64 KiB chunk and
    // the outer brace closes on the next one: the position at which a scanner that stops the moment it
    // has seen `]` drops the trailer without validating it, and at which a chunk boundary can split a
    // multi-byte character in the middle. What is delivered must be what was frozen, byte for byte.
    const seamPath = (index: number, filler = 0) =>
      `src/seam/"ünit"-${String(index).padStart(4, '0')}${'x'.repeat(filler)}.ts`;
    const seamMaterials = (count: number, filler: number): WorkflowReviewMaterialInput[] => [
      ...Array.from({ length: count }, (_, index) => ({ kind: 'source' as const,
        path: seamPath(index, index === count - 1 ? filler : 0), content: Buffer.from('unit\n') })),
      ...singletons(),
    ];
    const measureSeam = (count: number, filler: number) => {
      const bundle = freeze(seamMaterials(count, filler));
      const manifest = readFileSync(bundle.manifestPath);
      return { bundle, bytes: manifest.length, bracket: manifest.lastIndexOf(']}') };
    };
    // The record shape is uniform, so the number of records and the filler that put the close exactly
    // on the seam are solved from two measurements rather than searched for: each record adds its own
    // length plus one separator, and the filler adds one manifest byte per character to the last one.
    const probe = measureSeam(520, 0);
    const perRecord = probe.bracket - measureSeam(519, 0).bracket;
    expect(perRecord).toBeGreaterThan(60);
    expect(probe.bracket).toBeGreaterThan(65535);
    const count = 520 - Math.ceil((probe.bracket - 65535) / perRecord);
    const filler = 65535 - measureSeam(count, 0).bracket;
    expect(count).toBeGreaterThan(400);
    expect(filler).toBeGreaterThanOrEqual(0);
    expect(filler).toBeLessThan(perRecord);
    const seam = measureSeam(count, filler);
    expect(seam.bracket).toBe(65535);
    // ']' is the last byte of the first 64 KiB chunk and the outer trailer '}' closes the document on
    // the first byte of the next one, so the trailer is only ever read by a scanner that carries its
    // state across the seam rather than one that stops the moment the entry array has closed.
    expect(readFileSync(seam.bundle.manifestPath).subarray(65535, 65537).toString('utf8')).toBe(']}');
    const reopened = openWorkflowReviewSourceBundle(seam.bundle.directory);
    expect(reopened.entryCount).toBe(seam.bundle.entryCount);
    const records = entriesOf(reopened);
    expect(records).toHaveLength(count + 5);
    for (const entry of records.filter(candidate => candidate.kind === 'source')) {
      expect(readFileSync(entry.file, 'utf8')).toBe('unit\n');
      expect(entry.bytes).toBe(Buffer.byteLength('unit\n'));
      expect(entry.sha256).toBe(digest('unit\n'));
    }
    // The escaped, multi-byte path survives byte for byte — including the one the filler extended
    // across the seam — and every path is distinct.
    const paths = records.map(entry => entry.path);
    expect(paths.slice(0, count)).toEqual(Array.from({ length: count }, (_, index) => seamPath(index, index === count - 1 ? filler : 0)));
    expect(new Set(paths).size).toBe(records.length);
    // Numeric scalars are bounded before they are accumulated: a token beyond the exact safe range, a
    // fractional one and a negative one are all corruption rather than an approximation.
    const pristine = readFileSync(seam.bundle.manifestPath, 'utf8');
    const refuse = (transform: (text: string) => string) => {
      writeFileSync(seam.bundle.manifestPath, transform(pristine));
      expect(() => openWorkflowReviewSourceBundle(seam.bundle.directory)).toThrow(/workflow_review_source_corrupt/);
      writeFileSync(seam.bundle.manifestPath, pristine);
    };
    refuse(text => text.replace(/"totalBytes":\d+/, '"totalBytes":99999999999999999999999'));
    refuse(text => text.replace(/"totalBytes":\d+/, '"totalBytes":1.5'));
    refuse(text => text.replace(/"totalBytes":\d+/, '"totalBytes":-1'));
    // A bounded scalar is bounded on the branch that ends it as well as while it accumulates: a value
    // longer than the field limit whose closing quote lands inside one chunk is corruption, not a value
    // this reader carries on with, so the limit is not one an oversized token can escape by ending.
    refuse(text => text.replace(/"head":"[a-f0-9]+"/, `"head":"${'a'.repeat(5000)}"`));
    // The header is a closed shape rather than an open bag: an unknown top-level key, a repeated one
    // and one carrying the wrong JSON kind are each corruption instead of extra retained state.
    refuse(text => text.replace(/"head":/, '"unknownHeaderField":"x","head":'));
    refuse(text => text.replace(/"totalBytes":/, '"totalBytes":0,"totalBytes":'));
    refuse(text => text.replace(/"head":"[a-f0-9]+"/, '"head":1'));
    // The trailer and the EOF are part of the document: a missing outer brace, a byte after it, an
    // array that never closes and a field after it are all refusals, never a silently accepted
    // truncated manifest.
    refuse(text => text.replace(/\]\}$/, ''));
    refuse(text => `${text}x`);
    refuse(text => text.replace(/\]\}$/, '}'));
    refuse(text => text.replace(/\]\}$/, ',"extra":1]}'));
    expect(() => verifyWorkflowReviewSourceBundle(openWorkflowReviewSourceBundle(seam.bundle.directory))).not.toThrow();
  }, 240_000);

  it('refuses traversal, absolute, alias and duplicate source material', () => {
    for (const path of ['../outside.txt', '/etc/passwd', 'C:/windows/system32/config', 'src\\..\\escape.ts',
      'src//empty.ts', './src/alias.ts', '.git/config', 'src/../.git/config', '']) {
      expect(() => assertWorkflowReviewSourcePath(path)).toThrow(/workflow_review_source_invalid_path/);
    }
    expect(assertWorkflowReviewSourcePath('src/complete/unit-00.ts')).toBe('src/complete/unit-00.ts');
    expect(() => freeze([{ kind: 'source', path: 'src/same.ts', content: Buffer.from('a') },
      { kind: 'source', path: 'src/same.ts', content: Buffer.from('b') }])).toThrow('workflow_review_source_duplicate_path');
    expect(() => freeze([])).toThrow('workflow_review_source_invalid_bundle');
    // A singleton kind is refused outright the second time it appears, wherever in the stream it sits.
    expect(() => freeze([...syntheticMaterials(), { kind: 'objective', path: 'objective-x', content: Buffer.from('again\n') }]))
      .toThrow('workflow_review_source_duplicate_path');
    // A singleton label is a fixed name for a controller-composed material, not a repository file,
    // so an authorized file that happens to share the label is still delivered under its own id and
    // at its own bytes: the two never collide, and the sort the builder enforces is per kind.
    const materials = syntheticMaterials();
    const trackedDiff = { kind: 'source' as const, path: 'diff', content: Buffer.from('a tracked file named diff\n') };
    const labelled = freeze([
      ...materials.filter(material => material.kind === 'instruction'),
      trackedDiff,
      ...materials.filter(material => material.kind === 'source'),
      ...singletons(),
    ]);
    const sharing = entriesOf(labelled).filter(entry => entry.path === 'diff');
    expect(sharing.map(entry => entry.id).sort()).toEqual(['diff', 'src-0']);
    expect(readFileSync(sharing.find(entry => entry.id === 'src-0')!.file, 'utf8')).toBe('a tracked file named diff\n');
    expect(readFileSync(sharing.find(entry => entry.id === 'diff')!.file).toString('utf8'))
      .toBe(SINGLETON_BYTES.diff!.toString('utf8'));
    // The frozen identity, base and head are re-checked before any delivery is trusted.
    const bundle = freeze(syntheticMaterials());
    expect(() => assertWorkflowReviewSourceHead(bundle, IDENTITY)).not.toThrow();
    expect(() => assertWorkflowReviewSourceHead(bundle, { ...IDENTITY, head: 'c'.repeat(40) })).toThrow('workflow_review_source_stale_head');
    expect(() => assertWorkflowReviewSourceHead(bundle, { ...IDENTITY, repository: 'other/repository' })).toThrow('workflow_review_source_stale_head');
  });

  it('resolves and reads controller-chosen repository members above the retired 64 KiB bound', () => {
    fixture = createWorkflowFixture();
    const cwd = fixture.cwd;
    writeFileSync(join(cwd, 'tracked.txt'), 'complete synthetic source\n');
    expect(resolveWorkflowReviewSourceFile(cwd, 'tracked.txt')).toBe(join(cwd, 'tracked.txt'));
    const member = readWorkflowReviewSourceMember(cwd, 'tracked.txt');
    expect(member.path).toBe('tracked.txt');
    expect(member.bytes.toString('utf8')).toBe('complete synthetic source\n');
    expect(() => resolveWorkflowReviewSourceFile(cwd, '../escape.txt')).toThrow(/workflow_review_source_invalid_path/);
    expect(() => resolveWorkflowReviewSourceFile(cwd, 'C:/escape.txt')).toThrow(/workflow_review_source_invalid_path/);
    expect(() => resolveWorkflowReviewSourceFile(cwd, 'missing.txt')).toThrow('workflow_review_source_invalid_path');
    expect(() => resolveWorkflowReviewSourceFile(cwd, '.git/config')).toThrow(/workflow_review_source_invalid_path/);
    // A governed instruction above the retired 64 KiB ceiling is read in full, never rejected.
    const large = `${'# governed\n'}${'y'.repeat(64 * 1024 + 4096)}`;
    writeFileSync(join(cwd, 'BIG-INSTRUCTION.md'), large);
    expect(readWorkflowReviewSourceMember(cwd, 'BIG-INSTRUCTION.md').bytes.length).toBeGreaterThan(64 * 1024);
    expect(readWorkflowReviewSourceMember(cwd, 'BIG-INSTRUCTION.md').bytes.toString('utf8')).toBe(large);
    // The resolution never reads the file: the caller streams it straight into its bundle entry.
    expect(readFileSync(resolveWorkflowReviewSourceFile(cwd, 'BIG-INSTRUCTION.md'), 'utf8')).toBe(large);
    // A symlink ancestor or member must not resolve outside the reviewed checkout.
    try {
      symlinkSync(join(cwd, 'tracked.txt'), join(cwd, 'alias.txt'), 'file');
      expect(() => resolveWorkflowReviewSourceFile(cwd, 'alias.txt')).toThrow('workflow_review_source_invalid_path');
    } catch (error) {
      // Symbolic link creation requires a privilege this environment does not hold.
      expect((error as NodeJS.ErrnoException).code).toBe('EPERM');
    }
  });

  it('serves the reader over a real MCP connection inside the complete response bound', async () => {
    const bundle = freeze(syntheticMaterials());
    const receipts: WorkflowReviewSourceReceipt[] = [];
    const server = createWorkflowReviewSourceServer({ bundle, onReceipt: receipt => receipts.push(receipt) });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'synthetic-reviewer', version: '1.0.0' }, { capabilities: {} });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map(tool => tool.name).sort()).toEqual([WORKFLOW_REVIEW_READER_TOOL_MANIFEST, WORKFLOW_REVIEW_READER_TOOL_READ].sort());
      /**
       * The bytes a reply occupies on the wire when the request carries the *reserved* width of
       * identifier: the conservative envelope a caller can measure before any request exists. It is a
       * reservation, not a cap — a page served to a longer identifier is fitted to that identifier.
       */
      const envelopeBytes = (result: unknown) =>
        Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id: 'i'.repeat(WORKFLOW_REVIEW_RESPONSE_ID_RESERVE_BYTES - 2), result }));
      let cursor: string | undefined; const ids: string[] = []; let manifestText = ''; let ranges = 0;
      for (;;) {
        const call = await client.callTool({ name: WORKFLOW_REVIEW_READER_TOOL_MANIFEST, arguments: cursor ? { cursor } : {} });
        expect(call.isError).toBeFalsy();
        expect(envelopeBytes(call)).toBeLessThanOrEqual(WORKFLOW_REVIEW_READ_LIMIT_BYTES);
        const page = JSON.parse((call.content as Array<{ text: string }>)[0]!.text) as { content: string; bytes: number;
          complete: boolean; bundleSha256: string; cursor: string | null; kind: string; id: string | null };
        expect(page.bundleSha256).toBe(bundle.digest);
        expect(page.kind).toBe('manifest');
        expect(page.id).toBeNull();
        manifestText += page.content;
        ranges += 1;
        if (page.complete) break;
        cursor = page.cursor!;
      }
      expect(manifestText).toBe(readFileSync(bundle.manifestPath, 'utf8'));
      const manifest = JSON.parse(manifestText) as { entries: Array<{ id: string }> };
      ids.push(...manifest.entries.map(entry => entry.id));
      expect(ids).toEqual(entriesOf(bundle).map(entry => entry.id));
      for (const id of ids) {
        const entry = entriesOf(bundle).find(candidate => candidate.id === id)!;
        let entryCursor: string | undefined;
        for (;;) {
          const call = await client.callTool({ name: WORKFLOW_REVIEW_READER_TOOL_READ, arguments: { id, ...(entryCursor ? { cursor: entryCursor } : {}) } });
          expect(call.isError).toBeFalsy();
          expect(envelopeBytes(call)).toBeLessThanOrEqual(WORKFLOW_REVIEW_READ_LIMIT_BYTES);
          const read = JSON.parse((call.content as Array<{ text: string }>)[0]!.text) as { bytes: number; complete: boolean;
            bundleSha256: string; cursor: string | null; id: string; sha256: string };
          expect(read.bundleSha256).toBe(bundle.digest);
          expect(read.id).toBe(id);
          expect(read.sha256).toBe(entry.sha256);
          ranges += 1;
          if (read.complete) break;
          entryCursor = read.cursor!;
        }
      }
      expect(receipts).toHaveLength(ranges);
      expect(receipts.every(receipt => receipt.bytes > 0 && receipt.bytes <= WORKFLOW_REVIEW_READ_LIMIT_BYTES)).toBe(true);
      expect(receipts.filter(receipt => receipt.kind === 'manifest').length).toBeGreaterThanOrEqual(1);
      // The receipts the server wrote carry the returned bytes, and coverage follows from them alone.
      expect(receipts.every(receipt => rangeBytes(receipt).length === receipt.bytes)).toBe(true);
      expect(() => validateWorkflowReviewCoverage(bundle, { receipts, attestation: attestationFor(bundle, ranges), reviewerId: 'synthetic-reviewer' })).not.toThrow();
      const unknown = await client.callTool({ name: WORKFLOW_REVIEW_READER_TOOL_READ, arguments: { id: 'src-999' } });
      expect(unknown.isError).toBe(true);
      const outside = await client.callTool({ name: WORKFLOW_REVIEW_READER_TOOL_READ, arguments: { id: '../etc/passwd' } });
      expect(outside.isError).toBe(true);
      const forged = await client.callTool({ name: WORKFLOW_REVIEW_READER_TOOL_READ, arguments: { id: 'src-0', cursor: Buffer.from('{"v":1,"b":"deadbeef"}').toString('base64url') } });
      expect(forged.isError).toBe(true);
      expect((await client.callTool({ name: 'review_source_write', arguments: {} })).isError).toBe(true);
      // The declared argument shape is the whole shape: an unknown key, a numeric id, an absent
      // required id, a numeric cursor or an entry-shaped call for the manifest tool is refused rather
      // than coerced into a page request.
      for (const args of [{ id: 'src-0', extra: 1 }, { id: 0 }, {}, { cursor: 7 }, { id: 'src-0', cursor: 7 }]) {
        expect((await client.callTool({ name: WORKFLOW_REVIEW_READER_TOOL_READ, arguments: args })).isError).toBe(true);
      }
      expect((await client.callTool({ name: WORKFLOW_REVIEW_READER_TOOL_MANIFEST,
        arguments: { id: 'src-0' } })).isError).toBe(true);
      // The bound is over the encoded JSON-RPC envelope for the identifier the request itself carried,
      // so the reader fits each page to the frame it will truly receive instead of refusing any
      // identifier above a fixed width. The raw exchange below drives the protocol identifier
      // directly, which the SDK client cannot express.
      const servedId = '"'.repeat(20) + 'x'.repeat(20);
      // An identifier that serializes far above the reserved width: every one of its characters
      // escapes to two bytes, so it is exactly the shape a fixed cap used to refuse outright.
      const heavyId = '\\"'.repeat(WORKFLOW_REVIEW_RESPONSE_ID_RESERVE_BYTES);
      expect(workflowReviewResponseIdBytes(servedId)).toBeLessThanOrEqual(WORKFLOW_REVIEW_RESPONSE_ID_RESERVE_BYTES);
      expect(workflowReviewResponseIdBytes(heavyId)).toBeGreaterThan(WORKFLOW_REVIEW_RESPONSE_ID_RESERVE_BYTES);
      const [rawClientTransport, rawServerTransport] = InMemoryTransport.createLinkedPair();
      const rawServer = createWorkflowReviewSourceServer({ bundle });
      await rawServer.connect(rawServerTransport);
      try {
        const exchange = async (id: string, args: Record<string, unknown>): Promise<{ wire: number; message: Record<string, unknown> }> => {
          const received = new Promise<Record<string, unknown>>(resolve => {
            rawClientTransport.onmessage = message => resolve(message as unknown as Record<string, unknown>);
          });
          await rawClientTransport.send({ jsonrpc: '2.0', id, method: 'tools/call',
            params: { name: WORKFLOW_REVIEW_READER_TOOL_MANIFEST, arguments: args } });
          const message = await received;
          return { wire: Buffer.byteLength(JSON.stringify(message)), message };
        };
        /** Page the whole manifest to completion under one identifier, reporting every frame's bytes. */
        const walk = async (id: string): Promise<{ text: string; ranges: number; widest: number }> => {
          let text = ''; let cursor: string | undefined; let ranges = 0; let widest = 0;
          for (;;) {
            const { wire, message } = await exchange(id, cursor === undefined ? {} : { cursor });
            expect(message.error).toBeUndefined();
            widest = Math.max(widest, wire);
            const page = JSON.parse(((message.result as { content: Array<{ text: string }> }).content)[0]!.text) as {
              content: string; bytes: number; complete: boolean; cursor: string | null };
            expect(page.bytes).toBeGreaterThan(0);
            text += page.content; ranges += 1;
            if (page.complete) break;
            cursor = page.cursor!;
          }
          return { text, ranges, widest };
        };
        // A long, escape-heavy but bounded identifier still receives a complete page inside the bound.
        const served = await exchange(servedId, {});
        expect(served.wire).toBeLessThanOrEqual(WORKFLOW_REVIEW_READ_LIMIT_BYTES);
        expect(served.message.error).toBeUndefined();
        // An identifier fully twice the retired fixed width is *served*, not refused: the page is
        // fitted to the frame it will truly receive, so the identifier leaves less room for material
        // and the same manifest is still delivered completely, every frame within the policy.
        const heavy = await walk(heavyId);
        expect(heavy.widest).toBeLessThanOrEqual(WORKFLOW_REVIEW_READ_LIMIT_BYTES);
        expect(heavy.text).toBe(readFileSync(bundle.manifestPath, 'utf8'));
        expect(heavy.ranges).toBeGreaterThanOrEqual(1);
        // Only an identifier that leaves no room for a single byte of material is refused, and the
        // refusal names the bound rather than repeating the identifier that could not be carried.
        const impossibleId = 'x'.repeat(WORKFLOW_REVIEW_READ_LIMIT_BYTES);
        const refused = await exchange(impossibleId, {});
        const refusal = JSON.stringify(refused.message.result);
        expect(refusal).toContain('workflow_review_source_response_unbounded');
        expect(refusal).not.toContain(impossibleId);
      } finally { await rawServer.close(); }
    } finally { await client.close(); }
  }, 120000);

  it('measures the exact outbound frame and refuses only a genuinely oversized response', async () => {
    // The transport's guard must measure exactly the bytes the transport writes. The SDK frames every
    // message as its serialization *with its own terminating newline*; a guard that appended a second
    // newline would count a byte that never reaches the wire and close the connection on a response that
    // satisfies the policy exactly at the bound — the one page per object that lands on the limit.
    const written: Buffer[] = [];
    const sink = new Writable({ write: (chunk: Buffer, _encoding, callback) => { written.push(Buffer.from(chunk)); callback(); } });
    const transport = new BoundedWorkflowReviewTransport(new PassThrough(), sink);
    const frame = (textBytes: number): JSONRPCMessage => {
      const skeleton = { jsonrpc: '2.0' as const, id: 'i', result: { content: [{ type: 'text', text: '' }] } };
      const overhead = Buffer.byteLength(serializeMessage(skeleton));
      return { ...skeleton, result: { content: [{ type: 'text' as const, text: 'x'.repeat(textBytes - overhead) }] } };
    };
    const exact = frame(WORKFLOW_REVIEW_READ_LIMIT_BYTES);
    // The message is exactly one policy's worth of bytes *including* the single framing newline.
    expect(Buffer.byteLength(serializeMessage(exact))).toBe(WORKFLOW_REVIEW_READ_LIMIT_BYTES);
    expect(serializeMessage(exact).endsWith('\n')).toBe(true);
    await transport.send(exact);
    expect(Buffer.concat(written).toString('utf8')).toBe(serializeMessage(exact));
    expect(written).toHaveLength(1);
    // One byte more is genuinely unrepresentable and closes the connection instead of being written.
    const over = frame(WORKFLOW_REVIEW_READ_LIMIT_BYTES + 1);
    expect(Buffer.byteLength(serializeMessage(over))).toBe(WORKFLOW_REVIEW_READ_LIMIT_BYTES + 1);
    await expect(transport.send(over)).rejects.toThrow('workflow_review_source_response_unbounded');
    expect(written).toHaveLength(1);
    // A frame that *repeats* an oversized identifier — exactly the shape an SDK synthesizes when it
    // wraps a refusal around the request it could not answer — is refused as well, so a long
    // identifier is never echoed onto the wire by the response that refuses it.
    const echoWritten: Buffer[] = [];
    const echoSink = new Writable({ write: (chunk: Buffer, _encoding, callback) => { echoWritten.push(Buffer.from(chunk)); callback(); } });
    const echoTransport = new BoundedWorkflowReviewTransport(new PassThrough(), echoSink);
    const echoedId = 'x'.repeat(WORKFLOW_REVIEW_READ_LIMIT_BYTES);
    const echoed: JSONRPCMessage = { jsonrpc: '2.0', id: echoedId,
      result: { content: [{ type: 'text', text: 'Error: workflow_review_source_response_unbounded' }] } };
    expect(Buffer.byteLength(serializeMessage(echoed))).toBeGreaterThan(WORKFLOW_REVIEW_READ_LIMIT_BYTES);
    await expect(echoTransport.send(echoed)).rejects.toThrow('workflow_review_source_response_unbounded');
    expect(echoWritten).toHaveLength(0);
  }, 60_000);

  it('decodes a multibyte character split across a chunk seam exactly as the source bytes read', async () => {
    // The streamed line walk reads with one buffer-sized chunk, so a character that straddles that
    // offset arrives as two halves. Decoding each chunk on its own replaces both halves with U+FFFD and
    // yields a different text than the synchronous walk over the same file, so a receipt whose text is
    // not ASCII would read as one text here and another there — and a delivered object could be called
    // altered purely by where the seam happened to fall.
    const directory = scratch();
    const seamPath = join(directory, 'seam.jsonl');
    const line = `${'a'.repeat(WORKFLOW_REVIEW_BUFFER_LIMIT_BYTES - 1)}€ß—end\n`;
    writeFileSync(seamPath, Buffer.from(line, 'utf8'));
    const bytes = readFileSync(seamPath);
    // The three-byte character begins on the last byte of the first chunk and continues into the next.
    expect(bytes[WORKFLOW_REVIEW_BUFFER_LIMIT_BYTES - 1]).toBe(0xe2);
    expect(bytes[WORKFLOW_REVIEW_BUFFER_LIMIT_BYTES]).toBe(0x82);
    const streamed: string[] = [];
    for await (const part of streamWorkflowReviewLines(seamPath)) streamed.push(part);
    expect(streamed).toEqual([line]);
    expect(streamed.join('')).toBe(line);
    expect(streamed.join('')).not.toContain('�');
    // A final line with no newline, an empty sequence file and an absent one are each handled without
    // inventing a byte, a line or a replacement character.
    const tailPath = join(directory, 'tail.jsonl');
    writeFileSync(tailPath, Buffer.from('no trailing newline — §', 'utf8'));
    const tailed: string[] = [];
    for await (const part of streamWorkflowReviewLines(tailPath)) tailed.push(part);
    expect(tailed.join('')).toBe('no trailing newline — §');
    const emptyPath = join(directory, 'empty.jsonl');
    writeFileSync(emptyPath, '');
    const none: string[] = [];
    for await (const part of streamWorkflowReviewLines(emptyPath)) none.push(part);
    expect(none).toEqual([]);
    const missing: string[] = [];
    for await (const part of streamWorkflowReviewLines(join(directory, 'absent.jsonl'))) missing.push(part);
    expect(missing).toEqual([]);
  }, 120_000);

  it('walks an authorized manifest in Git byte order and refuses a reordered or repeated member', () => {
    // Git orders tracked paths by the raw bytes of the path, while JavaScript's `<` orders strings by
    // UTF-16 code units, and the two disagree exactly where a non-BMP character meets a character in
    // `U+E000..U+FFFF`. These two names are such a pair: Git records the private-use path first and an
    // astral path second, while JavaScript compares them the other way round. A walk driven by JS order
    // therefore refuses a manifest that is exactly Git's own listing — and, in lockstep, stops on a
    // tracked path that precedes the member it is looking for and reports a tracked member missing.
    fixture = createWorkflowFixture();
    const folder = join(fixture.cwd, 'src', 'order');
    mkdirSync(folder, { recursive: true });
    const privateUse = 'src/order/.ts';
    const astral = 'src/order/\u{1F600}.ts';
    expect('\u{1F600}' < '').toBe(true);
    expect(Buffer.compare(Buffer.from('', 'utf8'), Buffer.from('\u{1F600}', 'utf8'))).toBeLessThan(0);
    writeFileSync(join(folder, '.ts'), 'private use\n');
    writeFileSync(join(folder, '\u{1F600}.ts'), 'astral\n');
    fixture.git('add', '--', 'src/order');
    fixture.git('commit', '-m', 'Track the two ordering witnesses');
    // Git's own listing, read with quoting disabled, is the byte order the walk must follow.
    expect(fixture.git('-c', 'core.quotePath=false', 'ls-files', '--cached', '--full-name', 'src/order').split('\n'))
      .toEqual([privateUse, astral]);
    const authorize = (paths: readonly string[]) => {
      const content = paths.map(path => `${JSON.stringify(path)}\n`).join('');
      const path = join(scratch(), `authorized-${paths.length}-${paths.join('-').length}.jsonl`);
      writeFileSync(path, content);
      return { schemaVersion: WORKFLOW_REVIEW_SOURCE_MANIFEST_SCHEMA_VERSION, path, bytes: Buffer.byteLength(content),
        records: paths.length, sha256: digest(content) };
    };
    const cwd = fixture.cwd;
    const both = authorize([privateUse, astral]);
    expect([...iterateWorkflowReviewAuthorizedPaths(both)]).toEqual([privateUse, astral]);
    expect(verifyWorkflowReviewSourceManifestDescriptor(both)).toMatchObject({ path: both.path, bytes: both.bytes, records: 2 });
    // Both members are tracked, and so is the single member the lockstep walk has to step past.
    expect(verifyWorkflowReviewAuthorizedMembership({ cwd, descriptor: both })).toBe(2);
    expect(verifyWorkflowReviewAuthorizedMembership({ cwd, descriptor: authorize([astral]) })).toBe(1);
    expect(verifyWorkflowReviewAuthorizedMembership({ cwd, descriptor: authorize([privateUse]) })).toBe(1);
    // Order and repetition are still refusals: the manifest is Git's own listing, not an arbitrary set.
    expect(() => [...iterateWorkflowReviewAuthorizedPaths(authorize([astral, privateUse]))])
      .toThrow('workflow_review_compatibility_invalid_paths');
    expect(() => [...iterateWorkflowReviewAuthorizedPaths(authorize([privateUse, privateUse]))])
      .toThrow('workflow_review_compatibility_invalid_paths');
    // A member the checkout does not track is refused on the same walk, at any ordering.
    writeFileSync(join(folder, 'untracked.ts'), 'x\n');
    expect(() => verifyWorkflowReviewAuthorizedMembership({ cwd,
      descriptor: authorize(['src/order/untracked.ts']) })).toThrow('workflow_review_compatibility_source_mismatch');
    expect(() => verifyWorkflowReviewAuthorizedMembership({ cwd,
      descriptor: authorize(['src/order/untracked.ts', astral]) }))
      .toThrow('workflow_review_compatibility_source_mismatch');
  }, 120_000);

  it('freezes an unsorted material stream and refuses a repeat wherever it appears', () => {
    // Uniqueness is proven on disk, one exclusive-create key per member, so the stream does not have to
    // arrive in ascending authorized order: a member offered out of order is frozen under its own id,
    // and a repeat is refused wherever it sits — adjacent to the member it repeats, or not.
    const shuffled = [...syntheticMaterials()].reverse();
    const bundle = freeze(shuffled);
    const entries = entriesOf(bundle);
    expect(bundle.entryCount).toBe(2 + 64 + 5);
    expect(entries).toHaveLength(bundle.entryCount);
    expect(entries.filter(entry => entry.kind === 'source')).toHaveLength(64);
    expect(new Set(entries.map(entry => entry.path)).size).toBe(entries.length);
    // The ids still follow supply order, so each kind is numbered exactly as it was offered.
    expect(entries.filter(entry => entry.kind === 'source').map(entry => entry.id))
      .toEqual(Array.from({ length: 64 }, (_, index) => `src-${index}`));
    expect(entries[0]!.path).toBe('contracts');
    // A repeat is refused at any position, and the ids of the members already written do not survive it.
    const materials = syntheticMaterials();
    const farApart = [...materials, materials[0]!];
    expect(() => freeze(farApart)).toThrow('workflow_review_source_duplicate_path');
    const partial = join(scratch(), 'bundle');
    expect(() => buildWorkflowReviewSourceBundle({ ...IDENTITY, directory: partial, materials: farApart }))
      .toThrow('workflow_review_source_duplicate_path');
    expect(existsSync(partial)).toBe(false);
    // A destination that already exists is never written over, and what was there is left untouched.
    const occupied = join(scratch(), 'occupied');
    writeFileSync(occupied, 'not a directory\n');
    expect(() => buildWorkflowReviewSourceBundle({ ...IDENTITY, directory: occupied, materials: syntheticMaterials() }))
      .toThrow('workflow_review_source_bundle_exists');
    expect(readFileSync(occupied, 'utf8')).toBe('not a directory\n');
    // A stream that is not a material stream at all fails as an invalid bundle before anything is frozen.
    const invalid = join(scratch(), 'invalid');
    expect(() => buildWorkflowReviewSourceBundle({ ...IDENTITY, directory: invalid,
      materials: [{ kind: 'source', path: 'src/complete/unit-00.ts' } as WorkflowReviewMaterialInput] }))
      .toThrow('workflow_review_source_invalid_content');
    expect(existsSync(invalid)).toBe(false);
    // A supplier that fails the instant it is walked is the earliest failure a caller can reach: the
    // destination is claimed, the index is open, and both child directories exist — so the cleanup runs
    // against an open descriptor. The index is released before the directory holding it is removed, the
    // only directory removed is this invocation's own, and the original failure is what surfaces.
    const claimed = join(scratch(), 'claimed');
    expect(() => buildWorkflowReviewSourceBundle({ ...IDENTITY, directory: claimed,
      materials: { [Symbol.iterator](): Iterator<WorkflowReviewMaterialInput> { throw new Error('synthetic_supplier_failure'); } } }))
      .toThrow('synthetic_supplier_failure');
    expect(existsSync(claimed)).toBe(false);
    expect(existsSync(scratch())).toBe(true);
    // The destination is claimed by creating *it* exclusively, so a build never fabricates the
    // directories above the one it was given: a destination whose parent does not exist is refused
    // and leaves nothing on disk, rather than being silently created along with every missing
    // ancestor. The parent below is the witness — it must not appear.
    const absentParent = join(scratch(), 'absent-parent');
    expect(() => buildWorkflowReviewSourceBundle({ ...IDENTITY, directory: join(absentParent, 'bundle'),
      materials: syntheticMaterials() })).toThrow();
    expect(existsSync(absentParent)).toBe(false);
    // A destination that is already a directory belongs to whoever created it: the refusal preserves
    // it and everything inside it, because a build that never claimed a destination removes nothing.
    const competing = join(scratch(), 'competing');
    mkdirSync(competing);
    writeFileSync(join(competing, 'keep.txt'), 'competing\n');
    expect(() => buildWorkflowReviewSourceBundle({ ...IDENTITY, directory: competing, materials: syntheticMaterials() }))
      .toThrow('workflow_review_source_bundle_exists');
    expect(existsSync(join(competing, 'keep.txt'))).toBe(true);
    expect(readFileSync(join(competing, 'keep.txt'), 'utf8')).toBe('competing\n');
  }, 300_000);

  it('reconstructs delivery from the returned bytes and rehashes the source only as a second guard', () => {
    const bundle = freeze(syntheticMaterials());
    const { receipts, ranges } = pageEveryRange(bundle);
    const attestation = attestationFor(bundle, ranges);
    expect(() => validateWorkflowReviewCoverage(bundle, { receipts, attestation, reviewerId: 'synthetic-reviewer' })).not.toThrow();
    // A transport that corrupts the returned bytes while leaving every declared count, offset, id and
    // length plausible is a failed review: the reconstruction hashes the returned bytes, not source disk.
    const entryStart = receipts.findIndex(receipt => receipt.kind === 'entry');
    const corrupted = receipts.map((receipt, index) => index === entryStart
      ? withReturnedBytes(receipt, receipt.encoding === 'base64'
        ? Buffer.alloc(receipt.bytes, 0x5a).toString('base64') : 'z'.repeat(receipt.bytes)) : receipt);
    expect(corrupted[entryStart]!.bytes).toBe(receipts[entryStart]!.bytes);
    expect(() => validateWorkflowReviewCoverage(bundle, { receipts: corrupted, attestation, reviewerId: 'synthetic-reviewer' }))
      .toThrow('workflow_review_source_corrupt');
    // ...and so is a receipt whose declared length no longer matches the bytes it claims to have returned.
    const mismatched = receipts.map((receipt, index) => index === entryStart ? { ...receipt, bytes: receipt.bytes + 1 } : receipt);
    expect(() => validateWorkflowReviewCoverage(bundle, { receipts: mismatched, attestation,
      reviewerId: 'synthetic-reviewer' })).toThrow('workflow_review_source_corrupt');
    // The immutable on-disk objects are an independent guard: editing the source after delivery fails
    // the review even though the transport delivered every byte it was given.
    const victimReceipt = receipts[entryStart]!;
    const victimFile = join(bundle.entriesDirectory, victimReceipt.id!);
    const original = readFileSync(victimFile);
    writeFileSync(victimFile, Buffer.concat([original, Buffer.from('tampered')]));
    expect(() => validateWorkflowReviewCoverage(bundle, { receipts, attestation, reviewerId: 'synthetic-reviewer' }))
      .toThrow('workflow_review_source_corrupt');
    writeFileSync(victimFile, original);
    expect(() => validateWorkflowReviewCoverage(bundle, { receipts, attestation, reviewerId: 'synthetic-reviewer' })).not.toThrow();
  }, 120000);

  it('proves complete manifest and entry coverage and refuses any shortening', () => {
    const bundle = freeze(syntheticMaterials());
    const { receipts, ranges, manifestReads } = pageEveryRange(bundle);
    expect(manifestReads).toBeGreaterThan(1);
    const attestation = attestationFor(bundle, ranges);
    expect(() => validateWorkflowReviewCoverage(bundle, { receipts, attestation, reviewerId: 'synthetic-reviewer' })).not.toThrow();
    // An undelivered manifest page is an incomplete review, never a shortened successful one.
    const noManifest = receipts.filter(receipt => receipt.kind === 'entry');
    expect(() => validateWorkflowReviewCoverage(bundle, { receipts: noManifest,
      attestation: attestationFor(bundle, noManifest.length), reviewerId: 'synthetic-reviewer' })).toThrow('workflow_review_coverage_incomplete');
    expect(() => validateWorkflowReviewCoverage(bundle, { receipts: [receipts[0]!, ...receipts.slice(2)],
      attestation: attestationFor(bundle, ranges - 1), reviewerId: 'synthetic-reviewer' })).toThrow('workflow_review_coverage_incomplete');
    // A single omitted range is an incomplete review, never a shortened successful one.
    const omitted = receipts.filter((_, index) => index !== 3);
    expect(() => validateWorkflowReviewCoverage(bundle, { receipts: omitted, attestation, reviewerId: 'synthetic-reviewer' })).toThrow('workflow_review_coverage_incomplete');
    // A pure re-read of already-delivered bytes is a bounded revisit, not a shortcut: it is
    // accepted, and the attested range count still has to match the ledger exactly.
    const revisited = [...receipts, receipts[0]!];
    expect(() => validateWorkflowReviewCoverage(bundle, { receipts: revisited, attestation: { ...attestation, ranges: revisited.length }, reviewerId: 'synthetic-reviewer' })).not.toThrow();
    // A revisit that returns different bytes for an already-reconstructed range is refused, because
    // the revisited range is compared against the bytes actually reconstructed for that object.
    const drifted = [...receipts, withReturnedBytes(receipts[0]!, 'different bytes entirely')];
    expect(() => validateWorkflowReviewCoverage(bundle, { receipts: drifted,
      attestation: { ...attestation, ranges: drifted.length }, reviewerId: 'synthetic-reviewer' }))
      .toThrow('workflow_review_coverage_incomplete');
    // A one-byte gap at the head of an entry is a mis-tiling, never a shortened success, and so is
    // a range that reaches past the end of the object it claims to have delivered.
    const firstEntryIndex = receipts.findIndex(receipt => receipt.kind === 'entry');
    const firstEntry = receipts[firstEntryIndex]!;
    const entryFile = join(bundle.entriesDirectory, firstEntry.id!);
    const entryBytes = readFileSync(entryFile);
    expect(firstEntry.offset).toBe(0);
    const gapped = receipts.map((receipt, index) => index === firstEntryIndex
      ? withReturnedBytes(receipt, entryBytes.subarray(1, receipt.bytes).toString('base64'), { offset: 1 })
      : receipt);
    expect(() => validateWorkflowReviewCoverage(bundle, { receipts: gapped, attestation: attestationFor(bundle, ranges),
      reviewerId: 'synthetic-reviewer' })).toThrow('workflow_review_coverage_incomplete');
    const entryPages = receipts.filter(receipt => receipt.kind === 'entry' && receipt.id === firstEntry.id);
    const lastIndex = receipts.indexOf(entryPages.at(-1)!);
    const overrun = receipts.map((receipt, index) => index === lastIndex
      ? withReturnedBytes(receipt, Buffer.concat([rangeBytes(receipt), Buffer.from('x')]).toString('base64')) : receipt);
    expect(overrun[lastIndex]!.offset + overrun[lastIndex]!.bytes).toBeGreaterThan(firstEntry.bytes);
    expect(() => validateWorkflowReviewCoverage(bundle, { receipts: overrun, attestation, reviewerId: 'synthetic-reviewer' }))
      .toThrow('workflow_review_coverage_incomplete');
    // A ledger read in the wrong order delivers a late range first, which is a gap at the start.
    const reversed = [...receipts].reverse();
    expect(() => validateWorkflowReviewCoverage(bundle, { receipts: reversed, attestation, reviewerId: 'synthetic-reviewer' }))
      .toThrow('workflow_review_coverage_incomplete');
    // A drifted range digest, an unknown id and a foreign bundle are corruption or invalid receipts.
    const driftedDigest = receipts.map((receipt, index) => index === 5 ? { ...receipt, rangeSha256: digest('drift') } : receipt);
    expect(() => validateWorkflowReviewCoverage(bundle, { receipts: driftedDigest, attestation, reviewerId: 'synthetic-reviewer' })).toThrow('workflow_review_source_corrupt');
    const unknown = receipts.map((receipt, index) => index === 7 ? { ...receipt, id: 'src-999' } : receipt);
    expect(() => validateWorkflowReviewCoverage(bundle, { receipts: unknown, attestation, reviewerId: 'synthetic-reviewer' })).toThrow('workflow_review_source_unknown_id');
    const foreign = receipts.map((receipt, index) => index === 2 ? { ...receipt, bundleSha256: digest('other-bundle') } : receipt);
    expect(() => validateWorkflowReviewCoverage(bundle, { receipts: foreign, attestation, reviewerId: 'synthetic-reviewer' })).toThrow('workflow_review_source_invalid_receipt');
    // A receipt for the manifest that names an entry id, or an entry receipt with no id, is not a
    // delivery at all: the shape is refused before any offset is trusted.
    expect(() => validateWorkflowReviewCoverage(bundle, { receipts: receipts.map((receipt, index) => index === 0
      ? { ...receipt, kind: 'entry' as const } : receipt), attestation, reviewerId: 'synthetic-reviewer' }))
      .toThrow('workflow_review_source_invalid_receipt');
    expect(() => validateWorkflowReviewCoverage(bundle, { receipts: receipts.map((receipt, index) => index === firstEntryIndex
      ? { ...receipt, id: null } : receipt), attestation, reviewerId: 'synthetic-reviewer' }))
      .toThrow('workflow_review_source_invalid_receipt');
    // A receipt that declares no returned bytes is only ever the terminal page of an empty object it
    // is addressed to; appended after the walk has already closed, it is refused rather than counted.
    const malformed = [...receipts, { ...receipts[0]!, bytes: 0 }];
    expect(() => validateWorkflowReviewCoverage(bundle, { receipts: malformed, attestation: { ...attestation, ranges: malformed.length }, reviewerId: 'synthetic-reviewer' })).toThrow('workflow_review_source_invalid_receipt');
    // The attributed attestation itself must name this exact bundle, reviewer and entry set.
    expect(() => validateWorkflowReviewCoverage(bundle, { receipts, attestation: undefined, reviewerId: 'synthetic-reviewer' })).toThrow('workflow_review_coverage_attestation_invalid');
    expect(() => validateWorkflowReviewCoverage(bundle, { receipts, attestation: { ...attestation, complete: false }, reviewerId: 'synthetic-reviewer' })).toThrow('workflow_review_coverage_attestation_invalid');
    expect(() => validateWorkflowReviewCoverage(bundle, { receipts, attestation: attestationFor(bundle, ranges, 'another-reviewer'), reviewerId: 'synthetic-reviewer' })).toThrow('workflow_review_coverage_attestation_mismatch');
    expect(() => validateWorkflowReviewCoverage(bundle, { receipts, attestation: { ...attestation, bundleSha256: digest('other') }, reviewerId: 'synthetic-reviewer' })).toThrow('workflow_review_coverage_attestation_mismatch');
    expect(() => validateWorkflowReviewCoverage(bundle, { receipts, attestation: { ...attestation, entries: 70 }, reviewerId: 'synthetic-reviewer' })).toThrow('workflow_review_coverage_incomplete');
    expect(() => validateWorkflowReviewCoverage(bundle, { receipts, attestation: { ...attestation, ranges: ranges + 1 }, reviewerId: 'synthetic-reviewer' })).toThrow('workflow_review_coverage_incomplete');
  }, 120000);

  it('validates complete coverage straight from the append-only on-disk ledger', async () => {
    const bundle = freeze(syntheticMaterials());
    const { receipts, ranges } = pageEveryRange(bundle);
    const directory = scratch();
    const path = join(directory, 'receipts.jsonl');
    for (const receipt of receipts) appendWorkflowReviewSourceReceipt(path, receipt);
    const attestation = attestationFor(bundle, ranges);
    const proof = await validateWorkflowReviewCoverageLedger(bundle, {
      ledger: streamWorkflowReviewLines(path), attestation, reviewerId: 'synthetic-reviewer' });
    // The proof is the same reconstruction the in-memory route produces: the range count the ledger
    // actually delivered and the single digest of the delivered reconstruction.
    expect(proof).toMatchObject({ ranges, reconstructionSha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    // The manifest receipts are read from the same ledger, so a ledger that delivered only entries
    // cannot satisfy the predicate even though it holds every entry range exactly once.
    const entriesOnly = join(directory, 'entries-only.jsonl');
    writeFileSync(entriesOnly, receipts.filter(receipt => receipt.kind === 'entry').map(receipt => `${JSON.stringify(receipt)}\n`).join(''));
    await expect(validateWorkflowReviewCoverageLedger(bundle, {
      ledger: streamWorkflowReviewLines(entriesOnly), attestation, reviewerId: 'synthetic-reviewer' }))
      .rejects.toThrow('workflow_review_coverage_incomplete');
    // A hidden gap anywhere in the ledger is an incomplete review, never a shortened success.
    const gapped = join(directory, 'gapped.jsonl');
    writeFileSync(gapped, receipts.filter((_, index) => index !== 9).map(receipt => `${JSON.stringify(receipt)}\n`).join(''));
    await expect(validateWorkflowReviewCoverageLedger(bundle, {
      ledger: streamWorkflowReviewLines(gapped), attestation, reviewerId: 'synthetic-reviewer' }))
      .rejects.toThrow('workflow_review_coverage_incomplete');
    // A corrupted line, an unknown id and a foreign bundle are refused from the ledger too.
    const corrupt = join(directory, 'corrupt.jsonl');
    writeFileSync(corrupt, `${JSON.stringify(receipts[0])}\n{"broken"\n`);
    await expect(validateWorkflowReviewCoverageLedger(bundle, {
      ledger: streamWorkflowReviewLines(corrupt), attestation, reviewerId: 'synthetic-reviewer' }))
      .rejects.toThrow('workflow_review_source_invalid_receipt');
    const foreign = join(directory, 'foreign.jsonl');
    writeFileSync(foreign, `${JSON.stringify(receipts[0])}\n${JSON.stringify({ ...receipts[1], bundleSha256: digest('other') })}\n`);
    await expect(validateWorkflowReviewCoverageLedger(bundle, {
      ledger: streamWorkflowReviewLines(foreign), attestation, reviewerId: 'synthetic-reviewer' }))
      .rejects.toThrow('workflow_review_source_invalid_receipt');
    // A ledger line whose returned bytes do not match its declared range is corruption as well.
    const drifted = join(directory, 'drifted.jsonl');
    const entryStart = receipts.findIndex(receipt => receipt.kind === 'entry');
    writeFileSync(drifted, receipts.map((receipt, index) => `${JSON.stringify(index === entryStart
      ? withReturnedBytes(receipt, receipt.encoding === 'base64' ? Buffer.alloc(receipt.bytes, 7).toString('base64') : 'q'.repeat(receipt.bytes))
      : receipt)}\n`).join(''));
    await expect(validateWorkflowReviewCoverageLedger(bundle, {
      ledger: streamWorkflowReviewLines(drifted), attestation, reviewerId: 'synthetic-reviewer' }))
      .rejects.toThrow('workflow_review_source_corrupt');
    // A missing attestation fails before a single ledger line is trusted.
    await expect(validateWorkflowReviewCoverageLedger(bundle, {
      ledger: streamWorkflowReviewLines(path), attestation: undefined, reviewerId: 'synthetic-reviewer' }))
      .rejects.toThrow('workflow_review_coverage_attestation_invalid');
  }, 120000);

  it('spools Git stdout far above the default maxBuffer without a shell or a trim', () => {
    fixture = createWorkflowFixture();
    const cwd = fixture.cwd;
    const body = `${'z'.repeat(3 * 1024 * 1024)}\n`;
    writeFileSync(join(cwd, 'big.txt'), body);
    fixture.git('add', '--', 'big.txt');
    fixture.git('commit', '-m', 'Track an oversized synthetic source');
    const directory = scratch();
    const path = join(directory, 'stdout.bin');
    const spooled = spoolWorkflowReviewGit({ cwd, args: ['cat-file', 'blob', 'HEAD:big.txt'], path });
    expect(spooled.bytes).toBe(Buffer.byteLength(body));
    // The capture is byte-exact: no default maxBuffer truncation and no trailing trim.
    expect(readFileSync(path).toString('utf8')).toBe(body);
    expect(readWorkflowReviewGitText(cwd, ['cat-file', 'blob', 'HEAD:big.txt'])).toBe(body);
    const hashed = hashWorkflowReviewArtifact(path);
    expect(hashed).toEqual(spooled);
    expect(hashed.sha256).toBe(digest(readFileSync(path)));
    // The descriptor is built from the streaming hash, never a read-whole descriptor path.
    const descriptor = createWorkflowReviewArtifactDescriptor({ path, kind: 'workflow-review-source',
      producer: { system: 'omc', component: 'team-workflow' }, retention: 'until-completion' });
    expect(descriptor).toMatchObject({ path, sizeBytes: spooled.bytes, contentHash: spooled.sha256 });
    // A failing Git invocation removes its partial artifact instead of leaving a short one.
    expect(() => spoolWorkflowReviewGit({ cwd, args: ['cat-file', 'blob', 'HEAD:absent.txt'], path: join(directory, 'failed.bin') }))
      .toThrow('workflow_review_git_failed');
    expect(() => readFileSync(join(directory, 'failed.bin'))).toThrow();
    // Material is written through the exclusive streaming artifact writer.
    const written = writeWorkflowReviewArtifact({ path: join(directory, 'written.bin'), chunks: ['alpha', Buffer.from('beta')] });
    expect(written).toEqual({ bytes: 9, sha256: digest('alphabeta') });
    expect(() => writeWorkflowReviewArtifact({ path: join(directory, 'written.bin'), chunks: ['again'] })).toThrow();
  }, 120000);

  it('walks a tracked path set far above the retired aggregate ceiling one bounded record at a time', () => {
    // The retired route materialized every instruction and bounded the whole context (256 KiB) and the
    // whole request (384 KiB). The prospective route has no aggregate ceiling of any kind, so it is
    // exercised here against a tracked path set whose own listing is larger than both of them and larger
    // than the default child-process buffer: 10000 real files, written to the reviewed checkout and
    // committed, then listed by Git and walked record by record. The walk is instrumented at a fixed,
    // deterministic granularity — a deliberately tiny chunk — so an implementation that buffered the
    // listing, held one record per path or imposed any aggregate byte, file or read quota cannot pass
    // it. Paths are literal: spacing, non-ASCII characters and the order Git records them included.
    const created = createWorkflowFixture();
    fixture = created;
    const cwd = created.cwd;
    // 10000 real files whose names carry a fixed filler, so the listing itself is a fixture: it exceeds
    // the retired whole-context (256 KiB) and whole-request (384 KiB) ceilings *and* the default
    // one-mebibyte child-process buffer, and its record length is uniform without any one path coming
    // near the platform's path limit.
    const total = 10_000;
    const filler = 'bounded-record-'.repeat(8);
    const tracked = (index: number) => {
      if (index === 0) return '00 spaced naïve — #1.txt';
      if (index === total - 1) return 'last — done.txt';
      return `unit-${String(index).padStart(5, '0')}-${filler}.txt`;
    };
    const bulk = join(cwd, 'src', 'bulk');
    mkdirSync(bulk, { recursive: true });
    // The fixture's own Git driver buffers stdout, which is exactly the one-mebibyte ceiling this test
    // is about, so the two plumbing commands that must not be buffered are run with the child's output
    // discarded: this test's Git output goes to the spooled file below, not through a pipe.
    const plumbing = (...args: string[]): void => {
      const outcome = spawnSync('git', args, { cwd, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, shell: false });
      if (outcome.status !== 0) throw new Error(`git ${args[0]} failed: ${outcome.stderr?.toString() ?? ''}`);
    };
    try {
      for (let index = 0; index < total; index++) writeFileSync(join(bulk, tracked(index)), 'x');
      plumbing('add', '--', 'src/bulk');
      plumbing('commit', '-m', 'Track a path set far above the retired aggregate ceiling');
      const listing = join(scratch(), 'listing');
      const spooled = spoolWorkflowReviewGit({ cwd, args: ['ls-files', '-z'], path: listing });
      expect(spooled.bytes).toBe(statSync(listing).size);
      expect(spooled.bytes).toBeGreaterThan(1024 * 1024);
      // The production walk is compared against the literal path set it was handed: every record exactly
      // once, in the order Git recorded them, never a concatenation and never a dropped or duplicated one.
      const expected = Array.from({ length: total }, (_, index) => `src/bulk/${tracked(index)}`).sort();
      const walked = [...iterateWorkflowReviewNulRecords(listing)].filter(path => path.startsWith('src/bulk/'));
      expect(walked).toEqual(expected);
      expect(new Set(expected).size).toBe(total);
      expect(expected).toContain(`src/bulk/${tracked(0)}`);
      expect(expected).toContain(`src/bulk/${tracked(total - 1)}`);
      // The same listing read through a seven-byte chunk stream: every read is bounded at exactly that
      // size — the chunk count is the ceiling of the file over the chunk size, so the walk is driven at
      // the requested granularity rather than at a buffer or a record — and the records reassembled from
      // those reads hash to the file byte for byte. No step of the walk requires the whole listing, or
      // even a whole record, to be in memory at once.
      const pristine = readFileSync(listing);
      let pending = Buffer.alloc(0); let chunks = 0; let largest = 0;
      const collected = createHash('sha256');
      for (const chunk of readWorkflowReviewFileChunks(listing, 7)) {
        chunks += 1;
        if (chunk.length > largest) largest = chunk.length;
        pending = Buffer.concat([pending, chunk]);
        for (;;) {
          const at = pending.indexOf(0);
          if (at < 0) break;
          collected.update(pending.subarray(0, at)).update('\0');
          pending = pending.subarray(at + 1);
        }
      }
      expect(largest).toBe(7);
      expect(pending.length).toBe(0);
      expect(chunks).toBe(Math.ceil(spooled.bytes / 7));
      expect(collected.digest('hex')).toBe(digest(pristine));
      expect(pristine.includes(Buffer.from(`src/bulk/${tracked(0)}\0`, 'utf8'))).toBe(true);
      // A spaced and non-ASCII path is authorized like any other and is read at its own bytes.
      expect(resolveWorkflowReviewSourceFile(cwd, `src/bulk/${tracked(0)}`)).toBe(join(bulk, tracked(0)));
      expect(readWorkflowReviewSourceMember(cwd, `src/bulk/${tracked(0)}`).bytes.toString('utf8')).toBe('x');
      expect(readWorkflowReviewSourceMember(cwd, `src/bulk/${tracked(total - 1)}`).bytes.toString('utf8')).toBe('x');
      // A missing, private or traversal path is still refused on the very same checkout: the boundary is
      // about the size of the set, never about relaxing what may be authorized within it.
      expect(() => resolveWorkflowReviewSourceFile(cwd, 'src/bulk/absent.txt')).toThrow('workflow_review_source_invalid_path');
      expect(() => resolveWorkflowReviewSourceFile(cwd, 'src/bulk/../escape.txt')).toThrow('workflow_review_source_invalid_path');
      expect(() => resolveWorkflowReviewSourceFile(cwd, '.git/config')).toThrow('workflow_review_source_invalid_path');
    } finally {
      // Removing ten thousand files is the slow half of this test, and the shared per-test hook that
      // disposes the fixture would otherwise pay it inside its own short budget.
      rmSync(bulk, { recursive: true, force: true, maxRetries: 3 });
    }
  }, 600_000);

  it('describes one ephemeral non-command reader for each supported provider route', () => {
    const paths = { serverPath: workflowReviewSourceServerPath(), bundlePath: '/private/bundle', receiptsPath: '/private/receipts.jsonl' };
    const config = JSON.parse(workflowReviewSourceReaderConfig(paths)) as { mcpServers: Record<string,
      { command: string; args: string[]; env: Record<string, string> }> };
    expect(Object.keys(config.mcpServers)).toEqual([WORKFLOW_REVIEW_SOURCE_SERVER_NAME]);
    const server = config.mcpServers[WORKFLOW_REVIEW_SOURCE_SERVER_NAME]!;
    expect(server.command).toBe(process.execPath);
    expect(server.args).toEqual([workflowReviewSourceServerPath()]);
    expect(server.env).toEqual({ OMC_REVIEW_SOURCE_BUNDLE: '/private/bundle', OMC_REVIEW_SOURCE_RECEIPTS: '/private/receipts.jsonl' });
    expect(workflowReviewSourceServerPath().endsWith('workflow-review-source-server.js')).toBe(true);
    // Codex receives the same reader as repeated dotted-TOML overrides scoped to this invocation,
    // with the two command-executing tool features disabled and no global config rewritten.
    const overrides = workflowReviewCodexReaderOverrides(paths);
    expect(overrides.filter((entry, index) => index % 2 === 0).every(entry => entry === '--config')).toBe(true);
    const values = overrides.filter((entry, index) => index % 2 === 1);
    expect(values).toContain(`mcp_servers.${WORKFLOW_REVIEW_SOURCE_SERVER_NAME}.command=${JSON.stringify(process.execPath)}`);
    expect(values).toContain(`mcp_servers.${WORKFLOW_REVIEW_SOURCE_SERVER_NAME}.args=${JSON.stringify([workflowReviewSourceServerPath()])}`);
    expect(values).toContain(`mcp_servers.${WORKFLOW_REVIEW_SOURCE_SERVER_NAME}.env.OMC_REVIEW_SOURCE_BUNDLE=${JSON.stringify('/private/bundle')}`);
    expect(values).toContain(`mcp_servers.${WORKFLOW_REVIEW_SOURCE_SERVER_NAME}.env.OMC_REVIEW_SOURCE_RECEIPTS=${JSON.stringify('/private/receipts.jsonl')}`);
    for (const feature of WORKFLOW_REVIEW_CODEX_EXCLUDED_FEATURES) {
      expect(values).toContain(`features.${feature}=false`);
    }
    // Each command-executing tool feature is disabled on its own, so a host that only knows one of
    // them still receives a reader-only invocation.
    for (const feature of WORKFLOW_REVIEW_CODEX_COMMAND_TOOL_FEATURES) {
      expect(values).toContain(`features.${feature}=false`);
    }
    // No delegated agent may widen the reviewer's tools behind the reader's back, and the reader
    // namespace is projected top-level so it survives a code-mode-only session.
    expect(values).toContain('agents.enabled=false');
    expect(values).toContain('features.multi_agent_v2=false');
    expect(values).toContain(`features.code_mode.direct_only_tool_namespaces=${JSON.stringify([WORKFLOW_REVIEW_CODEX_READER_NAMESPACE])}`);
    // The namespace is derived from the server name exactly as Codex derives it.
    expect(WORKFLOW_REVIEW_CODEX_READER_NAMESPACE).toBe('mcp__omc_review_source');
    // No catalog was projected, so no model catalog path is passed.
    expect(values.some(value => value.startsWith('model_catalog_json='))).toBe(false);
    expect(overrides).toHaveLength((4 + WORKFLOW_REVIEW_CODEX_EXCLUDED_FEATURES.length + 3) * 2);
    // A projected catalog is appended as this invocation's own path and nothing else changes.
    const projected = workflowReviewCodexReaderOverrides({ ...paths, catalogPath: '/private/catalog.json' });
    expect(projected).toHaveLength(overrides.length + 2);
    expect(projected.slice(0, overrides.length)).toEqual(overrides);
    expect(projected[overrides.length]).toBe('--config');
    expect(projected[overrides.length + 1]).toBe(`model_catalog_json=${JSON.stringify('/private/catalog.json')}`);
    for (const bad of ['', 'has\nnewline', 'has\rcarriage', 'has\0nul']) {
      expect(() => workflowReviewSourceReaderConfig({ serverPath: bad, bundlePath: '/b', receiptsPath: '/r' })).toThrow('workflow_review_source_invalid_reader_config');
      expect(() => workflowReviewSourceReaderConfig({ serverPath: '/s', bundlePath: bad, receiptsPath: '/r' })).toThrow('workflow_review_source_invalid_reader_config');
      expect(() => workflowReviewSourceReaderConfig({ serverPath: '/s', bundlePath: '/b', receiptsPath: bad })).toThrow('workflow_review_source_invalid_reader_config');
      expect(() => workflowReviewCodexReaderOverrides({ serverPath: '/s', bundlePath: bad, receiptsPath: '/r' })).toThrow('workflow_review_source_invalid_reader_config');
      expect(() => workflowReviewCodexReaderOverrides({ serverPath: '/s', bundlePath: '/b', receiptsPath: bad })).toThrow('workflow_review_source_invalid_reader_config');
    }
    const identity = workflowReviewReaderBuildIdentity();
    expect(identity.id).toBe(WORKFLOW_REVIEW_SOURCE_SERVER_NAME);
    expect(identity.sha256).toBe(digest(readFileSync(new URL('../workflow-review-source-server.ts', import.meta.url))));
    // The reader's imported dependencies are bound by their own digests, not just by its own hash.
    const dependencies = workflowReviewReaderDependencies();
    expect(dependencies.map(entry => entry.path)).toEqual(['./workflow-review-source-server.js',
      './workflow-review-source.js', './workflow-contracts.js']);
    for (const [index, specifier] of ['../workflow-review-source-server.ts', '../workflow-review-source.ts', '../workflow-contracts.ts'].entries()) {
      expect(dependencies[index]!.sha256).toBe(digest(readFileSync(new URL(specifier, import.meta.url))));
    }
  });

  it('projects the host model catalog record-for-record and refuses an unusable one', () => {
    const directory = scratch();
    const catalogPath = join(directory, 'host-catalog.json');
    // A complete host catalog: every record and every unrelated field must survive exactly.
    const host = {
      version: 3,
      models: [
        { slug: 'gpt-6.1-sol', display_name: 'Sol', tool_mode: 'code_mode_only', context_window: 128000, nested: { keep: [1, 2] } },
        { slug: 'gpt-6-astra', display_name: 'Astra', tool_mode: 'code_mode', context_window: 400000 },
      ],
      notes: ['keep', { nested: [1, 2, 3] }],
    };
    writeFileSync(catalogPath, JSON.stringify(host));
    const projected = projectWorkflowReviewCodexCatalog({ source: catalogPath, path: join(directory, 'projected.json'),
      model: 'gpt-6.1-sol' });
    expect(projected).toMatchObject({ model: 'gpt-6.1-sol', models: 2 });
    expect(projected.input).toEqual({ path: catalogPath, sha256: digest(readFileSync(catalogPath)) });
    const written = readFileSync(projected.path);
    expect(projected.bytes).toBe(written.length);
    expect(projected.sha256).toBe(digest(written));
    // Exactly one field of exactly one record changed; every other record and field is preserved.
    expect(JSON.parse(written.toString('utf8'))).toEqual({ ...host,
      models: [{ ...host.models[0]!, tool_mode: 'direct' }, host.models[1]!] });
    const refused: string[] = ['refused-a.json', 'refused-b.json', 'refused-c.json'];
    for (const source of [undefined, '', relative(catalogPath), join(directory, 'absent.json')]) {
      expect(() => projectWorkflowReviewCodexCatalog({ source, path: join(directory, refused[0]!), model: 'gpt-6.1-sol' }))
        .toThrow('workflow_review_codex_catalog_unavailable');
    }
    const malformed = join(directory, 'malformed.json'); writeFileSync(malformed, '{not json');
    const emptyCatalog = join(directory, 'empty.json'); writeFileSync(emptyCatalog, JSON.stringify({ models: [] }));
    const notAnArray = join(directory, 'not-array.json'); writeFileSync(notAnArray, JSON.stringify({ models: { slug: 'gpt-6.1-sol' } }));
    const duplicate = join(directory, 'duplicate.json');
    writeFileSync(duplicate, JSON.stringify({ models: [host.models[0], host.models[0]] }));
    for (const source of [malformed, emptyCatalog, notAnArray, duplicate]) {
      expect(() => projectWorkflowReviewCodexCatalog({ source, path: join(directory, 'refused-b.json'), model: 'gpt-6.1-sol' }))
        .toThrow('workflow_review_codex_catalog_unavailable');
    }
    // A model the host does not carry refuses rather than silently running an unprojected surface.
    expect(() => projectWorkflowReviewCodexCatalog({ source: catalogPath, path: join(directory, 'refused-c.json'), model: 'gpt-6-absent' }))
      .toThrow('workflow_review_codex_catalog_unavailable');
    // A refused projection writes no artifact at all.
    for (const name of refused) {
      expect(() => readFileSync(join(directory, name))).toThrow();
    }
  });

  it('projects the host model catalog record-for-record with long discarded instruction strings', () => {
    const directory = scratch(); const source = join(directory, 'long-instructions.json');
    const messages = { persistent_instructions: 'p'.repeat(5000), instructions_template: 't'.repeat(21000),
      confirmation_policies: { browser_use: 'b'.repeat(11000), computer_use: 'c'.repeat(11000) },
      escaped: '🙂"\\\n'.repeat(800) };
    const other = { slug: 'gpt-other', tool_mode: 'code_mode', experimental_supported_tools: ['retained'], model_messages: messages };
    const selected = { ...other, slug: 'gpt-6.1-sol', context_window: 272000, tool_mode: 'code_mode_only' };
    const host = { version: 3, models: [other, selected], metadata: { preserved: ['after-models', 1] } };
    for (const model of host.models) {
      expect(Buffer.byteLength(JSON.stringify(model))).toBeLessThan(WORKFLOW_REVIEW_BUFFER_LIMIT_BYTES);
      expect(Buffer.byteLength(model.model_messages.instructions_template)).toBeGreaterThan(4096);
    }
    writeFileSync(source, JSON.stringify(host, null, 2)); const original = readFileSync(source);
    expect(original.length).toBeGreaterThan(WORKFLOW_REVIEW_BUFFER_LIMIT_BYTES);
    expect([...iterateWorkflowReviewJsonFields({ path: source, arrayKey: 'models' })].map(field => field.key))
      .toEqual(['version', 'metadata']);
    for (const native of [false, true]) {
      const output = join(directory, `projected-${native}.json`);
      const preview = projectWorkflowReviewCodexCatalog({ source, path: output, model: selected.slug, native, preview: true });
      expect(existsSync(output)).toBe(false);
      const projected = projectWorkflowReviewCodexCatalog({ source, path: output, model: selected.slug, native });
      expect(projected).toEqual(preview);
      const expected = { ...host, models: [other, { ...selected, tool_mode: 'direct', ...(native ? { experimental_supported_tools: [] } : {}) }] };
      expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual(expected);
      expect(projected.models).toBe(2); expect(projected.sha256).toBe(digest(readFileSync(output)));
    }
    expect(readFileSync(source)).toEqual(original);
  });

  it('refuses a catalog record that opens before the chunk seam and closes past its bound', () => {
    // The projection documents that only one bounded record is ever held, so the record bound has to
    // hold on the byte that ends the record too. A record whose bound is checked only while its
    // characters accumulate is handed back whole when its closing brace falls inside the next 64 KiB
    // chunk, which is exactly the shape a host catalog with one unusually long field has: the walker
    // would then carry a record past the bound it exists to enforce.
    const directory = scratch();
    const seam = WORKFLOW_REVIEW_BUFFER_LIMIT_BYTES;
    const opening = (path: string, literal: string) => {
      const bytes = readFileSync(path);
      const at = bytes.indexOf(Buffer.from(literal));
      // The record must open in the first chunk and close in the second, so the seam is the only place
      // its bound can be applied.
      expect(at).toBeGreaterThan(0);
      expect(at).toBeLessThan(seam);
      expect(bytes.length).toBeGreaterThan(seam);
      return at;
    };

    const recordsPath = join(directory, 'records-catalog.json');
    const wideRecord = JSON.stringify({ slug: 'gpt-6.1-wide', note: 'w'.repeat(70_000), tool_mode: 'code_mode' });
    writeFileSync(recordsPath, `{"version":3,"models":[${wideRecord},{"slug":"gpt-6.1-sol","tool_mode":"code_mode"}]}`, 'utf8');
    opening(recordsPath, '{"slug":"gpt-6.1-wide"');
    const found = { value: false };
    expect(() => [...iterateWorkflowReviewJsonRecords({ path: recordsPath, arrayKey: 'models', found })])
      .toThrow('workflow_review_source_corrupt');
    expect(() => projectWorkflowReviewCodexCatalog({ source: recordsPath, path: join(directory, 'wide.json'),
      model: 'gpt-6.1-sol' })).toThrow('workflow_review_codex_catalog_unavailable');
    expect(existsSync(join(directory, 'wide.json'))).toBe(false);

    // A nested top-level object is read by the same scanner and is bounded the same way, so an
    // unrelated field that spans the seam above the bound refuses instead of being carried through.
    const fieldsPath = join(directory, 'fields-catalog.json');
    writeFileSync(fieldsPath, `{"version":3,"meta":${JSON.stringify({ note: 'm'.repeat(70_000) })},`
      + '"models":[{"slug":"gpt-6.1-sol","tool_mode":"code_mode"}]}', 'utf8');
    opening(fieldsPath, '{"note":"m');
    expect(() => [...iterateWorkflowReviewJsonFields({ path: fieldsPath, arrayKey: 'models' })])
      .toThrow('workflow_review_source_corrupt');

    // The bound is the record itself and not the seam: the same two documents with short values are
    // walked whole, so the refusals above are the bound rather than a side effect of their length.
    const controlRecords = join(directory, 'records-control.json');
    writeFileSync(controlRecords, JSON.stringify({ version: 3, models: [
      { slug: 'gpt-6.1-wide', note: 'w', tool_mode: 'code_mode' }, { slug: 'gpt-6.1-sol', tool_mode: 'code_mode' }] }));
    expect([...iterateWorkflowReviewJsonRecords({ path: controlRecords, arrayKey: 'models', found })]).toHaveLength(2);
    expect(found.value).toBe(true);
    const controlFields = join(directory, 'fields-control.json');
    writeFileSync(controlFields, JSON.stringify({ version: 3, meta: { note: 'm' },
      models: [{ slug: 'gpt-6.1-sol', tool_mode: 'code_mode' }] }));
    expect([...iterateWorkflowReviewJsonFields({ path: controlFields, arrayKey: 'models' })])
      .toEqual([{ key: 'version', raw: '3' }, { key: 'meta', raw: '{"note":"m"}' }]);

    // The canonical manifest this module writes carries not one redundant byte, so its reader keeps
    // refusing a manifest that separates its records with formatting whitespace. A host catalog is
    // somebody else's document, though, so its reader positions on the next token instead: a catalog
    // the host happened to indent, wrap or reformat must still project.
    const prettyRecords = join(directory, 'records-pretty.json');
    writeFileSync(prettyRecords, `${JSON.stringify({ version: 3, models: [
      { slug: 'gpt-6.1-wide', note: 'w', tool_mode: 'code_mode' }, { slug: 'gpt-6.1-sol', tool_mode: 'code_mode' }] }, null, 2)}\n`);
    const prettyFound = { value: false };
    const prettyEntries = [...iterateWorkflowReviewJsonRecords({ path: prettyRecords, arrayKey: 'models', found: prettyFound })];
    expect(prettyFound.value).toBe(true);
    expect(prettyEntries.map(entry => (JSON.parse(entry) as { slug: string }).slug)).toEqual(['gpt-6.1-wide', 'gpt-6.1-sol']);
    const prettyFields = join(directory, 'fields-pretty.json');
    writeFileSync(prettyFields, JSON.stringify({ version: 3, meta: { note: 'm' },
      models: [{ slug: 'gpt-6.1-sol', tool_mode: 'code_mode' }] }, null, 2));
    const prettyWalked = [...iterateWorkflowReviewJsonFields({ path: prettyFields, arrayKey: 'models' })];
    expect(prettyWalked.map(field => field.key)).toEqual(['version', 'meta']);
    expect(JSON.parse(prettyWalked[1]!.raw)).toEqual({ note: 'm' });
    // The projection of a formatted catalog is that catalog with exactly one field of one record
    // changed, and it is a real artifact with a real digest the invocation can be handed.
    const prettyProjected = projectWorkflowReviewCodexCatalog({ source: prettyFields,
      path: join(directory, 'pretty-projected.json'), model: 'gpt-6.1-sol' });
    expect(prettyProjected.models).toBe(1);
    expect(prettyProjected.sha256).toBe(hashWorkflowReviewArtifact(prettyProjected.path).sha256);
    expect(JSON.parse(readFileSync(prettyProjected.path, 'utf8'))).toEqual({ version: 3, meta: { note: 'm' },
      models: [{ slug: 'gpt-6.1-sol', tool_mode: 'direct' }] });
    // Separator whitespace is discarded as it is read and carries no length of its own: the bound is
    // on what the cursor *retains* (one bounded token, one bounded record), never on a running total
    // of bytes it has already let go of, because a total ceiling would refuse a document that is
    // perfectly legal JSON merely for being formatted. A separator longer than the retired 4096-byte
    // allowance, and one that spans several read buffers, must therefore project exactly like the
    // compact spelling of the same document.
    const compactFields = join(directory, 'fields-compact.json');
    writeFileSync(compactFields, '{"version":3,"models":[{"slug":"gpt-6.1-sol","tool_mode":"code_mode"}]}');
    const compactWalk = [...iterateWorkflowReviewJsonFields({ path: compactFields, arrayKey: 'models' })];
    expect(compactWalk).toEqual([{ key: 'version', raw: '3' }]);
    for (const [name, separator] of [['over-quota', ' '.repeat(4097)],
      ['multi-buffer', '\n'.repeat(WORKFLOW_REVIEW_BUFFER_LIMIT_BYTES * 2 + 7)],
      ['four-buffer', ' \t\r\n'.repeat(WORKFLOW_REVIEW_BUFFER_LIMIT_BYTES)]] as const) {
      const spaced = join(directory, `fields-spaced-${name}.json`);
      writeFileSync(spaced, `{"version":3,${separator}"models":${separator}[${separator}`
        + `{"slug":"gpt-6.1-sol","tool_mode":"code_mode"}${separator}]${separator}}`);
      expect([...iterateWorkflowReviewJsonFields({ path: spaced, arrayKey: 'models' })]).toEqual(compactWalk);
      const spacedFound = { value: false };
      expect([...iterateWorkflowReviewJsonRecords({ path: spaced, arrayKey: 'models', found: spacedFound })]
        .map(entry => JSON.parse(entry))).toEqual([{ slug: 'gpt-6.1-sol', tool_mode: 'code_mode' }]);
      expect(spacedFound.value).toBe(true);
    }
    // A document that is separator whitespace and nothing else is not a document: dropping the total
    // byte ceiling did not turn EOF into a closing token, so the opening brace is still missing.
    const blank = join(directory, 'fields-blank.json');
    writeFileSync(blank, ' '.repeat(4097));
    expect(() => [...iterateWorkflowReviewJsonFields({ path: blank, arrayKey: 'models' })])
      .toThrow('workflow_review_source_corrupt');
    // Trailing separator whitespace after a complete document is legal formatting and is accepted,
    // while trailing junk after it is refused exactly as it was before.
    const trailed = join(directory, 'fields-trailed.json');
    writeFileSync(trailed, `${JSON.stringify({ version: 3, models: [{ slug: 'gpt-6.1-sol', tool_mode: 'code_mode' }] })}`
      + '\n'.repeat(4097));
    expect([...iterateWorkflowReviewJsonFields({ path: trailed, arrayKey: 'models' })]).toEqual([{ key: 'version', raw: '3' }]);
    writeFileSync(trailed, `${JSON.stringify({ version: 3, models: [] })}x`);
    expect(() => [...iterateWorkflowReviewJsonFields({ path: trailed, arrayKey: 'models' })])
      .toThrow('workflow_review_source_corrupt');
    // A truncated document is still refused rather than read as one that ended: the cursor never
    // accepts EOF as a closing token, so the array the walker was told to find is simply not there and
    // the catalog layer reports an unusable catalog instead of a projection of a document that stops
    // mid-record. The tolerance is a separator rule, not a licence to invent a terminator.
    const unterminated = join(directory, 'fields-unterminated.json');
    writeFileSync(unterminated, `{"version":3,"models":   ${' '.repeat(WORKFLOW_REVIEW_BUFFER_LIMIT_BYTES * 2)}`);
    expect(() => [...iterateWorkflowReviewJsonFields({ path: unterminated, arrayKey: 'models' })])
      .toThrow('workflow_review_codex_catalog_unavailable');
    expect(() => [...iterateWorkflowReviewJsonRecords({ path: unterminated, arrayKey: 'models', found: { value: false } })])
      .toThrow('workflow_review_codex_catalog_unavailable');
  });

  it('binds the reader qualification to the complete effective invocation and refuses anything else', () => {
    const directory = scratch();
    const reader = workflowReviewReaderBuildIdentity();
    const serverPath = workflowReviewSourceServerPath();
    // The prospective Codex argv the controller would run: the real provider flags, the real reader
    // overrides and only the per-attempt artifact paths named by their placeholders.
    const codexReader = workflowReviewCodexReaderOverrides({ serverPath,
      bundlePath: WORKFLOW_REVIEW_EPHEMERAL_PLACEHOLDERS.bundle,
      receiptsPath: WORKFLOW_REVIEW_EPHEMERAL_PLACEHOLDERS.receipts,
      catalogPath: WORKFLOW_REVIEW_EPHEMERAL_PLACEHOLDERS.catalog });
    const codexArgv = ['exec', '--sandbox', 'read-only', '--ephemeral', '--json', '--model', 'gpt-6.1-sol',
      '--config', 'model_reasoning_effort="high"', ...codexReader, '--output-schema', WORKFLOW_REVIEW_EPHEMERAL_PLACEHOLDERS.schema,
      '--output-last-message', WORKFLOW_REVIEW_EPHEMERAL_PLACEHOLDERS.result, '-'];
    const readerOnly = { id: reader.id, sha256: reader.sha256, dependencies: workflowReviewReaderDependencies() };
    /** Rebuild the same invocation with one effective field replaced, recomputing its projection. */
    const variant = (override: { serverPath?: string; reviewerArguments?: string[] }) => workflowReviewEffectiveInvocation({
      controller: { id: 'team-workflow', sha256: 'e'.repeat(64) }, reader: readerOnly,
      cli: { path: '/private/claude', sha256: 'f'.repeat(64), version: '1.0.0' }, route: 'codex',
      model: 'gpt-6.1-sol', effort: 'high', auth: { profile: 'codex-primary', fingerprint: 'a'.repeat(64) },
      catalog: { input: { path: '/private/host-catalog.json', sha256: 'b'.repeat(64) },
        projected: { bytes: 2048, sha256: 'c'.repeat(64) } },
      serverPath: override.serverPath ?? serverPath, carriesCatalog: true,
      reviewerArguments: override.reviewerArguments ?? codexArgv });
    const expected = variant({});
    const publish = (name: string, value: unknown): { path: string; sha256: string } => {
      const path = join(directory, name); writeFileSync(path, JSON.stringify(value));
      return { path, sha256: digest(readFileSync(path)) };
    };
    // A real frozen bundle, paged exactly as a client would, so the observed ledger and its proof are
    // genuine observations of returned bytes rather than arbitrary digests.
    const bundle = freeze(syntheticMaterials());
    const observed = writeLedger(join(directory, 'observed.jsonl'), observedReceipts(bundle));
    const proof = verifyWorkflowReviewCoverageArtifactSync(bundle, { artifact: observed,
      attestation: { bundleSha256: bundle.digest, reviewerId: 'root', complete: true,
        entries: bundle.entryCount, ranges: observed.ranges }, reviewerId: 'root' });
    const intended = writeLedger(join(directory, 'intended.jsonl'), observedReceipts(bundle));
    const evidence = { bundleSha256: bundle.digest, proof: { ranges: proof.ranges, reconstructionSha256: proof.reconstructionSha256 },
      observed, intended };
    const record = (override: Record<string, unknown> = {}) => ({ schemaVersion: 2, validation: 'synthetic',
      invocation: expected, evidence, routes: ['codex'], delivered: true, actorId: 'root', ...override });
    // The one observer this build implements: a runner that declares itself synthetic is admitted, in a
    // runner that allows synthetic qualification, on a matching invocation and on nothing else.
    const admitted = publish('admitted-synthetic.json', record());
    const resolved = resolveWorkflowReviewReaderQualification({ source: admitted, allowSynthetic: true, expected });
    expect(resolved.validation).toBe('synthetic');
    expect(resolved.actorId).toBe('root');
    expect(parseWorkflowReviewReaderQualification(resolved).invocation.tools).toEqual(WORKFLOW_REVIEW_READER_TOOLS);
    // The projection fingerprint names only stable, effective facts: two invocations that differ
    // only in their ephemeral bundle/ledger paths project identically.
    expect(expected.projection).toMatch(/^[a-f0-9]{64}$/);
    // ...and a synthetic declaration is still refused by a runner that does not allow one.
    expect(() => resolveWorkflowReviewReaderQualification({ source: admitted, allowSynthetic: false, expected }))
      .toThrow('workflow_review_reader_qualification_required');
    // A synthetic record is precisely the statement that no trusted observer produced it, so it makes no
    // delivered-bytes claim: there is nothing to bind to this frozen bundle, and the offline predicate
    // passes it through rather than pretending a delivery was re-derived from evidence that never was.
    expect(() => verifyWorkflowReviewQualificationEvidence(resolved, bundle)).not.toThrow();
    // The very same record relabelled `native` — a matching invocation, `delivered: true`, a genuine
    // observed ledger, a genuine intended ledger, and a proof re-derived from those exact returned
    // bytes — is refused. No trusted native observer is implemented here, so completeness and internal
    // consistency cannot make the claim true: the label asserts an observation no runner in this build
    // can make, and it buys nothing even where an honest synthetic declaration would have been admitted.
    const native = publish('native.json', record({ validation: 'native' }));
    const nativeRecord = parseWorkflowReviewReaderQualification(JSON.parse(readFileSync(native.path, 'utf8')));
    expect(nativeRecord.validation).toBe('native');
    expect(nativeRecord.delivered).toBe(true);
    expect(nativeRecord.invocation).toEqual(expected);
    expect(nativeRecord.routes).toEqual(['codex']);
    expect(nativeRecord.evidence.bundleSha256).toBe(bundle.digest);
    expect(nativeRecord.evidence.observed).toEqual(observed);
    expect(nativeRecord.evidence.intended).toEqual(intended);
    expect(nativeRecord.evidence.proof).toEqual({ ranges: proof.ranges, reconstructionSha256: proof.reconstructionSha256 });
    for (const allowSynthetic of [false, true]) {
      expect(() => resolveWorkflowReviewReaderQualification({ source: native, allowSynthetic, expected }))
        .toThrow('workflow_review_reader_qualification_required');
      expect(() => verifyWorkflowReviewReaderQualification(nativeRecord, expected, allowSynthetic))
        .toThrow('workflow_review_reader_qualification_required');
    }
    // The offline predicate refuses it as well, even when handed the exact bundle its evidence names, so
    // a caller that reaches that path directly cannot admit one either. Historical native fields stay
    // parseable; parsing them confers nothing.
    expect(() => verifyWorkflowReviewQualificationEvidence(nativeRecord, bundle))
      .toThrow('workflow_review_reader_qualification_required');
    // None of that evidence is discarded just because the record that carried it is unsupported: the
    // re-derivation it described is exactly what the controller applies to the delivery ledger it
    // retains itself, before any finding. Replaying the saved ledger re-derives the proof from the
    // returned bytes rather than trusting the recorded value, and every way of lying about a delivery
    // is still a refusal rather than an accepted review of material the client never received.
    const attribution = (target: WorkflowReviewSourceBundle) => ({ bundleSha256: target.digest, reviewerId: 'root',
      complete: true as const, entries: target.entryCount, ranges: observed.ranges });
    const replay = (artifact: unknown, target: WorkflowReviewSourceBundle = bundle) =>
      verifyWorkflowReviewCoverageArtifactSync(target, { artifact, attestation: attribution(target), reviewerId: 'root' });
    expect(replay(observed)).toEqual({ ranges: proof.ranges, reconstructionSha256: proof.reconstructionSha256,
      artifact: observed });
    // The reconstruction identity is re-derived, never read out of the record: the value a ledger yields
    // is the digest of what it actually returned, and it matches the recorded claim only when the claim
    // is true.
    expect(replay(observed).reconstructionSha256).toBe(proof.reconstructionSha256);
    expect(proof.reconstructionSha256).toMatch(/^[a-f0-9]{64}$/);
    // A fabricated reference over a delivery that never happened is refused before anything is read.
    expect(() => replay({ path: join(directory, 'absent-observed.jsonl'), sha256: '1'.repeat(64), bytes: 4096, ranges: 71 }))
      .toThrow('workflow_review_reader_qualification_required');
    // A ledger whose declared byte count is not the file's own is a changed artifact, not a ledger.
    expect(() => replay({ ...observed, bytes: observed.bytes + 1 }))
      .toThrow('workflow_review_reader_qualification_changed');
    // An observed ledger whose first range is internally consistent — the same length, a digest of its
    // own bytes — but records different bytes than the frozen source: every declared count and digest
    // stays plausible and only the whole-object reconstruction exposes the corrupted delivery.
    const genuine = observedReceipts(bundle);
    const first = genuine[0]!;
    const alteredBytes = Buffer.from(first.content, first.encoding === 'base64' ? 'base64' : 'utf8');
    const copy = Buffer.from(alteredBytes);
    const at = copy.findIndex(byte => (byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122));
    copy[at] ^= 0x20;
    expect(() => replay(writeLedger(join(directory, 'altered.jsonl'), [{ ...first,
      content: first.encoding === 'base64' ? copy.toString('base64') : copy.toString('utf8'),
      rangeSha256: digest(copy) }, ...genuine.slice(1)])))
      .toThrow('workflow_review_source_corrupt');
    // Evidence bound to a different frozen source is a qualification for another delivery: the
    // bundle identity is content-addressed, so any distinct repository, base, head or entry set is
    // a different source rather than a second name for the same one.
    expect(() => verifyWorkflowReviewCoverageArtifactSync(freeze(syntheticMaterials(), { ...IDENTITY, head: 'c'.repeat(40) }),
      { artifact: observed, attestation: attribution(bundle), reviewerId: 'root' }))
      .toThrow('workflow_review_coverage_attestation_mismatch');
    // A source that is missing, relative, not bound by a digest or absent entirely never qualifies.
    for (const source of [undefined, { path: 'relative.json', sha256: native.sha256 }, { path: native.path, sha256: 'nope' },
      { path: join(directory, 'absent.json'), sha256: native.sha256 }]) {
      expect(() => resolveWorkflowReviewReaderQualification({ source, allowSynthetic: false, expected }))
        .toThrow('workflow_review_reader_qualification_required');
    }
    // A same-size edit after qualification is a changed record, never a silently accepted one.
    const mutated = publish('mutated.json', record());
    writeFileSync(mutated.path, readFileSync(mutated.path).toString('utf8').replace('root', 'evil'));
    expect(() => resolveWorkflowReviewReaderQualification({ source: mutated, allowSynthetic: false, expected }))
      .toThrow('workflow_review_reader_qualification_changed');
    // Every field of the effective invocation is compared, not merely the reader build: a record that
    // describes another controller, model, effort, route, CLI, auth profile, catalog, dependency set,
    // reader module, prospective argv, tool projection or inventory is a qualification for some other
    // invocation.
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['reader.json', record({ invocation: { ...expected, reader: { ...readerOnly, sha256: '9'.repeat(64) } } }),
        'workflow_review_reader_qualification_mismatch'],
      ['dependency.json', record({ invocation: { ...expected,
        reader: { ...readerOnly, dependencies: [{ path: './workflow-contracts.js', sha256: '8'.repeat(64) }] } } }),
        'workflow_review_reader_qualification_mismatch'],
      ['controller.json', record({ invocation: { ...expected, controller: { id: 'team-workflow', sha256: '7'.repeat(64) } } }),
        'workflow_review_reader_qualification_mismatch'],
      ['model.json', record({ invocation: { ...expected, model: 'gpt-6-astra' } }),
        'workflow_review_reader_qualification_mismatch'],
      ['effort.json', record({ invocation: { ...expected, effort: 'max' } }),
        'workflow_review_reader_qualification_mismatch'],
      ['route.json', record({ invocation: { ...expected, route: 'claude' }, routes: ['claude'] }),
        'workflow_review_reader_qualification_mismatch'],
      ['cli.json', record({ invocation: { ...expected, cli: { path: '/private/other', sha256: '6'.repeat(64), version: '1.0.0' } } }),
        'workflow_review_reader_qualification_mismatch'],
      ['auth.json', record({ invocation: { ...expected, auth: { profile: 'codex-primary', fingerprint: '5'.repeat(64) } } }),
        'workflow_review_reader_qualification_mismatch'],
      ['catalog-input.json', record({ invocation: { ...expected,
        catalog: { input: { path: '/private/host-catalog.json', sha256: '4'.repeat(64) }, projected: expected.catalog.projected } } }),
        'workflow_review_reader_qualification_mismatch'],
      ['catalog-projected.json', record({ invocation: { ...expected,
        catalog: { input: expected.catalog.input, projected: { bytes: 2048, sha256: '3'.repeat(64) } } } }),
        'workflow_review_reader_qualification_mismatch'],
      ['projection.json', record({ invocation: { ...expected, projection: '0'.repeat(64) } }),
        'workflow_review_reader_qualification_mismatch'],
      ['tools.json', record({ invocation: { ...expected, tools: [WORKFLOW_REVIEW_READER_TOOL_MANIFEST] } }),
        'workflow_review_reader_qualification_mismatch'],
      // The effective controls the argv names are part of the fingerprint, not decoration: another
      // reader module or another provider argv is another invocation entirely.
      ['server-module.json', record({ invocation: variant({ serverPath: '/private/other-reader.js' }) }),
        'workflow_review_reader_qualification_mismatch'],
      ['argv.json', record({ invocation: variant({
        reviewerArguments: [...codexArgv, '--config', 'features.shell_tool=true'] }) }),
        'workflow_review_reader_qualification_mismatch'],
      ['undelivered.json', record({ delivered: false }), 'workflow_review_reader_qualification_incomplete'],
      ['claude-only.json', record({ routes: ['claude'] }), 'workflow_review_reader_qualification_incomplete'],
      ['no-evidence.json', record({ evidence: { bundleSha256: bundle.digest, proof: { ranges: 0, reconstructionSha256: '2'.repeat(64) },
        observed, intended } }), 'workflow_review_reader_qualification_invalid'],
      ['same-evidence.json', record({ evidence: { ...evidence, intended: { ...intended, path: observed.path } } }),
        'workflow_review_reader_qualification_invalid'],
      ['extra-key.json', record({ extra: 1 }), 'workflow_review_reader_qualification_invalid'],
      ['old-schema.json', record({ schemaVersion: 1 }), 'workflow_review_reader_qualification_invalid'],
      ['old-shape.json', { schemaVersion: 2, validation: 'native', reader, routes: ['codex'], delivered: true },
        'workflow_review_reader_qualification_invalid'],
    ];
    for (const [name, value, expectedError] of cases) {
      const source = publish(name, value);
      expect(() => resolveWorkflowReviewReaderQualification({ source, allowSynthetic: true, expected })).toThrow(expectedError);
    }
    // A `native` label and `delivered: true` alone prove nothing: without a complete identity match
    // the record is refused, and a synthetic one is accepted only inside a declared synthetic runner.
    const synthetic = publish('synthetic.json', record({ validation: 'synthetic', routes: ['codex', 'claude'] }));
    expect(() => resolveWorkflowReviewReaderQualification({ source: synthetic, allowSynthetic: false, expected }))
      .toThrow('workflow_review_reader_qualification_required');
    expect(resolveWorkflowReviewReaderQualification({ source: synthetic, allowSynthetic: true, expected }).validation).toBe('synthetic');
    // A Claude invocation carries no projected catalog, so the projection and catalog fields follow.
    const claude = workflowReviewEffectiveInvocation({ controller: expected.controller, reader: readerOnly,
      cli: expected.cli, route: 'claude', model: expected.model, effort: expected.effort, auth: expected.auth,
      catalog: { input: null, projected: null }, serverPath,
      carriesCatalog: false,
      reviewerArguments: ['--print', '--model', expected.model, '--effort', expected.effort, '--strict-mcp-config',
        '--mcp-config', workflowReviewSourceReaderConfig({ serverPath, bundlePath: WORKFLOW_REVIEW_EPHEMERAL_PLACEHOLDERS.bundle,
          receiptsPath: WORKFLOW_REVIEW_EPHEMERAL_PLACEHOLDERS.receipts }), '--json-schema', '{}'] });
    expect(claude.projection).not.toBe(expected.projection);
    expect(claude.catalog.projected).toBeNull();
  });

  it('reopens a bundle through bounded structural streaming and refuses a mis-indexed one', () => {
    const bundle = freeze(syntheticMaterials());
    expect(() => openWorkflowReviewSourceBundle(bundle.directory)).not.toThrow();
    const indexPath = join(bundle.directory, WORKFLOW_REVIEW_INDEX_FILE);
    const manifestPath = join(bundle.directory, WORKFLOW_REVIEW_MANIFEST_FILE);
    const index = readFileSync(indexPath, 'utf8');
    const manifest = readFileSync(manifestPath, 'utf8');
    // A duplicated index line is corruption: the ledger must tile the manifest exactly once.
    writeFileSync(indexPath, `${index}${index.split('\n').filter(Boolean)[0]!}\n`);
    expect(() => openWorkflowReviewSourceBundle(bundle.directory)).toThrow('workflow_review_source_corrupt');
    writeFileSync(indexPath, index);
    // A dropped index line is a gap, not a shorter bundle.
    const lines = index.split('\n').filter(Boolean);
    writeFileSync(indexPath, `${lines.slice(0, -1).join('\n')}\n`);
    expect(() => openWorkflowReviewSourceBundle(bundle.directory)).toThrow('workflow_review_source_corrupt');
    writeFileSync(indexPath, index);
    // A truncated manifest fails structurally instead of yielding a partial entry list.
    writeFileSync(manifestPath, manifest.slice(0, Math.floor(manifest.length / 2)));
    expect(() => openWorkflowReviewSourceBundle(bundle.directory)).toThrow('workflow_review_source_corrupt');
    writeFileSync(manifestPath, manifest);
    // A manifest record edited in place is corruption: the parser bounds every scalar it reads.
    writeFileSync(manifestPath, manifest.replace('"bytes":23337', '"bytes":-23337'));
    expect(() => openWorkflowReviewSourceBundle(bundle.directory)).toThrow('workflow_review_source_corrupt');
    writeFileSync(manifestPath, manifest);
    // An entry record rewritten to the same length is still corruption.
    const victim = entriesOf(bundle)[4]!;
    const original = readFileSync(victim.file);
    const sameSize = Buffer.from(original); sameSize[sameSize.length - 1] = (sameSize[sameSize.length - 1]! + 1) % 256;
    writeFileSync(victim.file, sameSize);
    expect(sameSize.length).toBe(original.length);
    expect(() => openWorkflowReviewSourceBundle(bundle.directory)).toThrow('workflow_review_source_corrupt');
    writeFileSync(victim.file, original);
    // A bounded metadata record that disagrees with the manifest is corruption, not a lookup miss.
    const recordPath = join(bundle.directory, WORKFLOW_REVIEW_RECORDS_DIRECTORY, victim.id);
    const record = readFileSync(recordPath, 'utf8');
    writeFileSync(recordPath, record.replace(`"bytes":${victim.bytes}`, `"bytes":${victim.bytes + 1}`));
    expect(() => openWorkflowReviewSourceBundle(bundle.directory)).toThrow('workflow_review_source_corrupt');
    writeFileSync(recordPath, record);
    expect(() => verifyWorkflowReviewSourceBundle(openWorkflowReviewSourceBundle(bundle.directory))).not.toThrow();
  });

  it('appends one delivery receipt line per served range', () => {
    fixture = createWorkflowFixture();
    const path = join(fixture.root, 'receipts.jsonl');
    const receipt = { bundleSha256: digest('bundle'), kind: 'entry' as const, id: 'src-0', offset: 0, bytes: 4,
      rangeSha256: digest('ably'), encoding: 'utf8' as const, content: 'ably' };
    appendWorkflowReviewSourceReceipt(path, receipt);
    appendWorkflowReviewSourceReceipt(path, { ...receipt, offset: 4, content: 'cdef', rangeSha256: digest('cdef') });
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
    expect(lines).toEqual([receipt, { ...receipt, offset: 4, content: 'cdef', rangeSha256: digest('cdef') }]);
  });
});

/** Decode exactly the bytes one receipt declares it returned. */
function rangeBytes(receipt: WorkflowReviewSourceReceipt): Buffer {
  return receipt.encoding === 'base64' ? Buffer.from(receipt.content, 'base64') : Buffer.from(receipt.content, 'utf8');
}
/** One absolute path turned into a relative spelling, used to prove a relative catalog is refused. */
function relative(path: string): string {
  return path.split(/[\\/]/).slice(-1)[0]!;
}
