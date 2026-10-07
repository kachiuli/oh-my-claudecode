/**
 * Controller-owned immutable, disk-backed source delivery for review.
 *
 * A review of a large change cannot inline the complete logical source (every
 * authorized file plus the governing instructions, inventory, diff, objective,
 * shared context and task contracts) into the reviewer prompt: the serialized
 * request has an explicit ceiling. Instead the controller freezes the complete
 * material onto disk as one hash-bound bundle directory and serves it to the
 * reviewer through a read-only, non-command reader.
 *
 * The bundle is a *constant descriptor* plus disk records. It carries no entry
 * array and no material array: its public shape is an immutable manifest path, an
 * append-only index path, a numbered record directory, an entry directory, the
 * manifest and index digests and the entry count and byte total. Every consumer
 * walks the manifest and the index through one-record-at-a-time iterators, and the
 * reader resolves any single entry from its bounded on-disk record file, so
 * neither side ever collects the entry set into an array or a Map. There is
 * deliberately no aggregate review/source/request ceiling anywhere in this module:
 * the only bound is the complete encoded MCP response size, which is a buffer
 * policy on a single reply, and the per-stream buffer used while spooling. Every
 * byte above any such buffer is delivered on a later page, never dropped,
 * summarized or replaced.
 *
 * Complete delivery is proven from the append-only ledger and, above all, from the
 * bytes the client actually received over the transport: each receipt carries the
 * exact decoded bytes of its served page, and the coverage machine spools every
 * object back from those returned bytes — never from the current source disk — and
 * compares the reconstruction's whole hash and size against the frozen manifest.
 * The immutable on-disk objects are re-hashed only as a separate, independent
 * guard, so a transport that corrupts content while leaving counts, metadata and
 * the source ledger plausible is a failed review rather than a shortened success.
 */
import { createHash } from 'node:crypto';
import { closeSync, constants, createReadStream, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, opendirSync, readFileSync,
  readSync, realpathSync, renameSync, rmSync, rmdirSync, unlinkSync, writeFileSync, writeSync, type Stats } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';

import { WORKFLOW_REVIEW_BUFFER_LIMIT_BYTES, WORKFLOW_REVIEW_READ_LIMIT_BYTES,
  type WorkflowReviewSourceManifestDescriptor } from './workflow-contracts.js';
import type { ArtifactDescriptor, ArtifactProducer, ArtifactRetention } from '../shared/artifact-descriptor.js';

/** The per-response encoded bound, re-exported so a reader shares one definition. */
export { WORKFLOW_REVIEW_READ_LIMIT_BYTES, WORKFLOW_REVIEW_BUFFER_LIMIT_BYTES };
export const WORKFLOW_REVIEW_BUNDLE_SCHEMA_VERSION = 1;
export const WORKFLOW_REVIEW_MANIFEST_FILE = 'manifest.json';
export const WORKFLOW_REVIEW_INDEX_FILE = 'index.jsonl';
export const WORKFLOW_REVIEW_ENTRIES_DIRECTORY = 'entries';
/** Bounded per-entry metadata records, named by the entry's deterministic id. */
export const WORKFLOW_REVIEW_RECORDS_DIRECTORY = 'records';
const MEMBER_PATH_LIMIT = 400;
const CURSOR_VERSION = 1;
/**
 * The complete, closed header of one canonical bundle manifest: the exact keys the writer emits, each
 * exactly once, and their JSON value kinds. The reader admits this shape and no other, so a manifest
 * carrying an unknown, repeated or re-typed top-level key is refused as corruption rather than having
 * the extra field copied into the header.
 */
const WORKFLOW_REVIEW_MANIFEST_HEADER: Readonly<Record<string, 'integer' | 'string'>> = Object.freeze({
  schemaVersion: 'integer', repository: 'string', baseCommit: 'string', head: 'string', totalBytes: 'integer' });
/**
 * Order two repository paths exactly as Git does. Git orders tracked paths by the raw bytes of the
 * path, while JavaScript's `<` orders strings by UTF-16 code units: the two disagree for a non-BMP
 * character against a character in `U+E000..U+FFFF`, so a lockstep membership walk driven by JS
 * ordering can skip or mis-pair a member that Git's own listing orders the other way. Comparing the
 * UTF-8 encoding restores Git's order for every path, ASCII or not.
 */
function compareWorkflowReviewGitPaths(left: string, right: string): number {
  if (left === right) return 0;
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

/**
 * The material kinds one complete authorized review must carry. The first five
 * are singletons the controller always freezes; instructions and authorized
 * source files are delivered as they exist and are equally coverage-required.
 */
export type WorkflowReviewMaterialKind = 'instruction' | 'source' | 'inventory' | 'diff' | 'objective' | 'shared-context' | 'contracts';
export const WORKFLOW_REVIEW_REQUIRED_MATERIAL_KINDS: readonly WorkflowReviewMaterialKind[] =
  ['inventory', 'diff', 'objective', 'shared-context', 'contracts'];
const SINGLETON_KINDS: readonly WorkflowReviewMaterialKind[] = ['inventory', 'diff', 'objective', 'shared-context', 'contracts'];
const ALL_KINDS: readonly WorkflowReviewMaterialKind[] = [...SINGLETON_KINDS, 'instruction', 'source'];
const ID_PATTERN = /^(?:(?:instr|src)-[0-9]+|inventory|diff|objective|shared-context|contracts)$/;

/** Fixed scalar instrumentation at resource acquisition/release boundaries; never a heap census. */
const reviewResources = { records: 0, peakRecords: 0, descriptors: 0, peakDescriptors: 0,
  bufferBytes: 0, peakBufferBytes: 0, largestBuffer: 0, positionedReads: 0, recordLookups: 0,
  pageRequests: 0, fullVerifications: 0 };
export function workflowReviewResourceUsage(): Readonly<typeof reviewResources> { return Object.freeze({ ...reviewResources }); }
export function resetWorkflowReviewResourceUsage(): void {
  if (reviewResources.records || reviewResources.descriptors || reviewResources.bufferBytes) throw new Error('workflow_review_resources_live');
  for (const key of Object.keys(reviewResources) as (keyof typeof reviewResources)[]) reviewResources[key] = 0;
}
function holdReviewResource(kind: 'records' | 'descriptors' | 'bufferBytes', count = 1): () => void {
  reviewResources[kind] += count;
  const peak = kind === 'records' ? 'peakRecords' : kind === 'descriptors' ? 'peakDescriptors' : 'peakBufferBytes';
  reviewResources[peak] = Math.max(reviewResources[peak], reviewResources[kind]);
  if (kind === 'bufferBytes') reviewResources.largestBuffer = Math.max(reviewResources.largestBuffer, count);
  return () => { reviewResources[kind] -= count; };
}
function* retainedReviewRecord<T>(value: T): Generator<T> {
  const release = holdReviewResource('records');
  try { yield value; } finally { release(); }
}

/**
 * A constant-heap uniqueness ledger for the deterministic entry identifiers. Instruction and source
 * ids are dense ascending ordinals, so one expected counter per ordinal kind proves uniqueness and
 * canonical order without remembering a single id; the five fixed singleton kinds are tracked in one
 * small set. A repeated ordinal, an out-of-order ordinal and a non-canonical numeral are corruption.
 */
class WorkflowReviewIdLedger {
  private readonly expected = new Map<string, number>();
  private readonly singletons = new Set<string>();
  accept(id: string): void {
    const ordinal = /^(instr|src)-([0-9]+)$/.exec(id);
    if (!ordinal) {
      if (this.singletons.has(id)) throw new Error('workflow_review_source_corrupt');
      this.singletons.add(id);
      return;
    }
    const value = Number(ordinal[2]);
    if (!Number.isSafeInteger(value) || String(value) !== ordinal[2] || value !== (this.expected.get(ordinal[1]) ?? 0)) {
      throw new Error('workflow_review_source_corrupt');
    }
    this.expected.set(ordinal[1], value + 1);
  }
}

const digest = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');
const isContinuation = (byte: number): boolean => (byte & 0xc0) === 0x80;

/**
 * One material as it enters the bundle. Exactly one of `file` (stream from disk), `content` (a small
 * in-memory value) or `chunks` (an ordered lazy sequence of bounded pieces) is supplied, so no large
 * material is ever held as one buffer by the caller and a composed material can be emitted piece by
 * piece rather than assembled.
 */
export interface WorkflowReviewMaterialInput {
  readonly kind: WorkflowReviewMaterialKind;
  readonly path: string;
  readonly file?: string;
  readonly content?: Buffer;
  readonly chunks?: Iterable<Buffer | string>;
}
export interface WorkflowReviewSourceBundleInput {
  readonly repository: string;
  readonly baseCommit: string;
  readonly head: string;
  /** The bundle directory to create; it must not already exist. */
  readonly directory: string;
  /** A lazy material stream: the builder consumes one bounded material at a time. */
  readonly materials: Iterable<WorkflowReviewMaterialInput>;
}
/** One bounded entry record: its identity, digest and the immutable file that holds its bytes. */
export interface WorkflowReviewSourceEntry {
  readonly id: string;
  readonly kind: WorkflowReviewMaterialKind;
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  /** The immutable on-disk file that holds exactly these bytes. */
  readonly file: string;
}
/** The bounded metadata record of one entry, as persisted in the record directory. */
export interface WorkflowReviewSourceRecord {
  readonly id: string;
  readonly kind: WorkflowReviewMaterialKind;
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}
/**
 * The constant bundle descriptor. It names immutable on-disk paths and their digests plus
 * the entry count and byte total; it holds no entry list and no material, so nothing about
 * it grows with the size of the source and nothing in it can act as an aggregate ceiling.
 */
export interface WorkflowReviewSourceBundle {
  readonly schemaVersion: typeof WORKFLOW_REVIEW_BUNDLE_SCHEMA_VERSION;
  readonly repositoryIdentity: string;
  readonly baseCommit: string;
  readonly head: string;
  readonly directory: string;
  readonly manifestPath: string;
  readonly indexPath: string;
  readonly entriesDirectory: string;
  readonly recordsDirectory: string;
  readonly manifestBytes: number;
  /** Digest of the canonical manifest; binds every entry by id, kind, path, size and hash. */
  readonly digest: string;
  readonly indexBytes: number;
  readonly indexDigest: string;
  readonly entryCount: number;
  readonly totalBytes: number;
}

/**
 * A logical source path is metadata only, but it is still validated so a saved
 * bundle can never describe an absolute, traversal or alias-escaping referent.
 */
export function assertWorkflowReviewSourcePath(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > MEMBER_PATH_LIMIT || value.includes('\0')
    || value.includes('\\') || isAbsolute(value) || posix.isAbsolute(value) || /^[A-Za-z]:/.test(value)) {
    throw new Error('workflow_review_source_invalid_path');
  }
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || part === '.git')) {
    throw new Error('workflow_review_source_invalid_path');
  }
  return value;
}

/**
 * Resolve one controller-chosen logical source file to its absolute path without
 * reading a single byte of it. The file must be an ordinary, tracked-representable
 * file inside the repository; a symlink (or a symlink ancestor) is refused so an
 * alias cannot escape the reviewed checkout. Streaming the returned path keeps a
 * large authorized source out of memory entirely.
 */
export function resolveWorkflowReviewSourceFile(cwd: string, relative: unknown): string {
  const path = assertWorkflowReviewSourcePath(relative);
  const root = resolve(cwd);
  let current = root;
  const parts = path.split('/');
  for (const part of parts.slice(0, -1)) {
    current = resolve(current, part);
    if (!current.startsWith(root + sep)) throw new Error('workflow_review_source_path_escape');
    if (lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('workflow_review_source_symlink_escape');
  }
  const absolute = resolve(root, ...parts);
  if (!absolute.startsWith(root + sep) || absolute === root) throw new Error('workflow_review_source_path_escape');
  const stat = lstatSync(absolute, { throwIfNoEntry: false });
  if (!stat || stat.isSymbolicLink() || !stat.isFile()) throw new Error('workflow_review_source_invalid_path');
  return absolute;
}

/**
 * Read one controller-chosen logical source file completely. The read is a
 * streaming read with no size ceiling: the complete bytes are returned and no
 * per-instruction bound truncates or rejects a large governed instruction.
 */
export function readWorkflowReviewSourceMember(cwd: string, relative: unknown): { path: string; bytes: Buffer } {
  const path = assertWorkflowReviewSourcePath(relative);
  const absolute = resolveWorkflowReviewSourceFile(cwd, path);
  const bytes = readWorkflowReviewFileStreaming(absolute);
  if (bytes.length !== lstatSync(absolute).size) throw new Error('workflow_review_source_corrupt');
  return { path, bytes };
}

/** Read a whole file through a bounded streaming buffer; never a single unbounded read. */
export function readWorkflowReviewFileStreaming(absolute: string): Buffer {
  const chunks: Buffer[] = [];
  for (const chunk of readWorkflowReviewFileChunks(absolute)) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/** Stream one file as bounded chunks; the caller decides whether to collect or spool them. */
export function* readWorkflowReviewFileChunks(absolute: string,
  chunkBytes = WORKFLOW_REVIEW_BUFFER_LIMIT_BYTES): Generator<Buffer> {
  const descriptor = openSync(absolute, 'r');
  const releaseDescriptor = holdReviewResource('descriptors');
  let releaseBuffer = () => {};
  try {
    const capacity = Math.max(1, Math.min(chunkBytes, WORKFLOW_REVIEW_BUFFER_LIMIT_BYTES, fstatSync(descriptor).size));
    releaseBuffer = holdReviewResource('bufferBytes', capacity);
    const buffer = Buffer.allocUnsafe(capacity);
    for (;;) {
      const read = readSync(descriptor, buffer, 0, buffer.length, null);
      if (read <= 0) break;
      yield Buffer.from(buffer.subarray(0, read));
    }
  } finally { try { closeSync(descriptor); } finally { releaseBuffer(); releaseDescriptor(); } }
}

/** Same bounded streaming read as UTF-8 text, decoding multi-byte sequences across chunk seams. */
function* readWorkflowReviewTextChunks(absolute: string | WorkflowReviewOwnedFile, chunkBytes = WORKFLOW_REVIEW_BUFFER_LIMIT_BYTES): Generator<string> {
  if (typeof absolute !== 'string') {
    const before = absolute.seal(); const capacity = Math.max(1, Math.min(chunkBytes, WORKFLOW_REVIEW_BUFFER_LIMIT_BYTES));
    const decoder = new TextDecoder('utf-8', { fatal: true });
    for (let offset = 0; offset < before.bytes; offset += capacity) {
      const bytes = absolute.read(offset, Math.min(capacity, before.bytes - offset)); const release = holdReviewResource('bufferBytes', bytes.length);
      try { const text = decoder.decode(bytes, { stream: true }); if (text) yield text; } finally { release(); }
    }
    const tail = decoder.decode(); if (tail) yield tail;
    const after = absolute.seal();
    if (before.bytes !== after.bytes || before.sha256 !== after.sha256) throw new Error('workflow_review_evidence_corrupt');
    return;
  }
  const descriptor = openSync(absolute, 'r');
  const releaseDescriptor = holdReviewResource('descriptors');
  const releaseBuffer = holdReviewResource('bufferBytes', Math.max(1, Math.min(chunkBytes, WORKFLOW_REVIEW_BUFFER_LIMIT_BYTES)));
  const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    const buffer = Buffer.allocUnsafe(Math.max(1, Math.min(chunkBytes, WORKFLOW_REVIEW_BUFFER_LIMIT_BYTES)));
    for (;;) {
      const read = readSync(descriptor, buffer, 0, buffer.length, null);
      if (read <= 0) break;
      const text = decoder.decode(buffer.subarray(0, read), { stream: true });
      if (text) yield text;
    }
    const tail = decoder.decode();
    if (tail) yield tail;
  } finally { try { closeSync(descriptor); } finally { releaseBuffer(); releaseDescriptor(); } }
}

/** The largest single manifest/envelope scalar the incremental parser will hold, in bytes. */
const REVIEW_STRUCTURE_FIELD_LIMIT = 4 * 1024;
/** The largest single manifest record (one entry object) the incremental parser will hold. */
const REVIEW_STRUCTURE_RECORD_LIMIT = 64 * 1024;
/** The largest integer token the incremental parser will accumulate before it fails as corruption. */
const REVIEW_STRUCTURE_INTEGER_LIMIT = 32;
/** The four separator bytes JSON allows between two tokens, and nothing else. */
const REVIEW_STRUCTURE_WHITESPACE = /[ \t\r\n]/;
/**
 * The width, in serialized UTF-8 bytes, reserved for the JSON-RPC identifier when a page is measured
 * without knowing the request that will carry it — the conservative envelope a caller uses to check
 * that *some* page of an object fits, before any request exists. It is a reservation and not a
 * ceiling on identifiers: a served page is always fitted against the identifier the request actually
 * carried, so a request with a longer identifier receives a correspondingly smaller page rather than
 * being refused for exceeding a fixed width.
 */
export const WORKFLOW_REVIEW_RESPONSE_ID_RESERVE_BYTES = 64;
/** The serialized UTF-8 bytes of one JSON-RPC identifier, or of `null` when none was supplied. */
export function workflowReviewResponseIdBytes(id: unknown): number {
  return Buffer.byteLength(JSON.stringify(id === undefined ? null : id), 'utf8');
}

/**
 * A pull cursor over a bounded chunk stream. It keeps at most one chunk plus the token it is
 * currently reading, so a manifest far larger than memory is walked without ever being buffered
 * whole, and every individual token is bounded so a malformed structure fails instead of growing.
 */
class WorkflowReviewStructureCursor {
  private readonly source: Iterator<string>;
  /** Whether separator whitespace between tokens is legal in this document at all. */
  private readonly whitespace: boolean;
  private buffer = '';
  private ended = false;
  private closed = false;
  constructor(source: Iterator<string>, options: { whitespace?: boolean } = {}) {
    this.source = source;
    this.whitespace = options.whitespace === true;
  }
  /**
   * Close the underlying chunk generator. A parse that fails mid-document, or a caller that stops
   * early, must return the generator so its open file descriptor is released deterministically
   * rather than surviving until the descriptor table is reclaimed.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try { this.source.return?.(undefined as never); } catch { /* the stream is being discarded */ }
  }
  private fill(minimum: number): void {
    while (this.buffer.length < minimum && !this.ended) {
      const next = this.source.next();
      if (next.done) { this.ended = true; break; }
      this.buffer += next.value;
    }
  }
  /**
   * Discard any run of separator whitespace between two tokens.
   *
   * Only the readers of somebody else's document enable this. The canonical manifest this module
   * writes carries not one redundant byte, so a manifest that separates its records with formatting
   * whitespace is corruption and is still refused exactly as before. A host catalog, by contrast, is
   * an external JSON document and may be laid out in any legal formatting — compact, indented, or
   * wrapped — so its readers must position on the next token rather than insist the next byte be it.
   *
   * The run is discarded as it is read and never accumulated, so its length is bounded by nothing at
   * all and does not need to be: the buffer only ever holds the unconsumed tail of the chunk being
   * read, and the cursor never advances past the next token. A cumulative total would therefore be a
   * ceiling on *formatting*, which is legal in any amount, rather than on structure, which is bounded
   * token by token above. Progress is guaranteed by the source: every iteration pulls one more chunk,
   * so the walk ends as soon as a real token byte is positioned or the document itself has ended.
   */
  private space(): void {
    if (!this.whitespace) return;
    for (;;) {
      this.fill(1);
      if (!this.buffer.length) return;
      let at = 0;
      while (at < this.buffer.length && REVIEW_STRUCTURE_WHITESPACE.test(this.buffer[at]!)) at++;
      if (at) this.buffer = this.buffer.slice(at);
      // A run that filled the buffer may continue in the next chunk, so this only stops once a real
      // token byte is positioned or the document itself has ended.
      if (this.buffer.length || this.ended) return;
    }
  }
  /** Consume one exact literal; anything else is corruption. */
  take(literal: string): void {
    this.space();
    this.fill(literal.length);
    if (!this.buffer.startsWith(literal)) throw new Error('workflow_review_source_corrupt');
    this.buffer = this.buffer.slice(literal.length);
  }
  /** Whether the stream is positioned on `literal`; never consumes. */
  peek(literal: string): boolean {
    this.space();
    this.fill(literal.length);
    return this.buffer.startsWith(literal);
  }
  /** Require the stream to end here; trailing bytes are corruption rather than content. */
  end(): void {
    this.space();
    this.fill(1);
    if (this.buffer.length || !this.ended) throw new Error('workflow_review_source_corrupt');
  }
  /** Read one JSON string token, unescaping it, bounded by `limit` characters. */
  readString(limit: number): string {
    this.space();
    this.take('"');
    let raw = '';
    for (;;) {
      this.fill(1);
      if (!this.buffer.length) throw new Error('workflow_review_source_corrupt');
      // The delimiter is the first quote or backslash anywhere in the buffer, so an ordinary prefix
      // of any length (odd or even) is consumed before the delimiter is interpreted.
      const at = this.buffer.search(/["\\]/);
      if (at < 0) { raw += this.buffer; this.buffer = ''; }
      else if (this.buffer[at] === '"') { raw += this.buffer.slice(0, at); this.buffer = this.buffer.slice(at + 1); break; }
      else {
        // Consume the prefix and then the escape pair verbatim: the character a backslash introduces
        // is always taken with its backslash, never re-scanned as a delimiter, whatever the prefix.
        this.fill(at + 2);
        if (this.buffer.length < at + 2) throw new Error('workflow_review_source_corrupt');
        raw += this.buffer.slice(0, at + 2); this.buffer = this.buffer.slice(at + 2);
      }
      if (raw.length > limit) throw new Error('workflow_review_source_corrupt');
    }
    // The bound is re-checked on the closing quote, not only on the accumulate branches: a token that
    // ends exactly on a chunk boundary takes the `break` above and would otherwise escape the limit
    // entirely, so an oversized string would be accepted whole instead of refused.
    if (raw.length > limit) throw new Error('workflow_review_source_corrupt');
    try { return JSON.parse(`"${raw}"`) as string; } catch { throw new Error('workflow_review_source_corrupt'); }
  }
  /** Read one bounded integer token with strict JSON integer grammar. */
  readInteger(): number {
    this.fill(1);
    let raw = '';
    for (;;) {
      this.fill(raw.length + 1);
      const byte = this.buffer[raw.length];
      if (byte === undefined || !/[0-9-]/.test(byte)) break;
      raw += byte;
      // The token is bounded as it accumulates, so a malformed structure fails rather than grows.
      if (raw.length > REVIEW_STRUCTURE_INTEGER_LIMIT) throw new Error('workflow_review_source_corrupt');
    }
    // Strict JSON integer syntax: a lone zero or a nonzero digit followed by digits, optionally
    // signed. A leading zero, an empty token or a stray sign is corruption, not a number.
    if (!/^-?(?:0|[1-9][0-9]*)$/.test(raw)) throw new Error('workflow_review_source_corrupt');
    const value = Number(raw);
    if (!Number.isSafeInteger(value)) throw new Error('workflow_review_source_corrupt');
    this.buffer = this.buffer.slice(raw.length);
    return value;
  }
  /** Read one bounded JSON scalar token (`true`, `false`, `null`, a number or a string) verbatim. */
  readScalar(limit: number): string {
    this.space();
    this.fill(1);
    if (this.buffer[0] === '"') return JSON.stringify(this.readString(limit));
    let raw = '';
    for (;;) {
      this.fill(raw.length + 1);
      const byte = this.buffer[raw.length];
      // In a host document a scalar may also be followed by formatting whitespace rather than one of
      // the structural bytes, so the token ends there; the whitespace is left for the next `space()`.
      if (byte === undefined || byte === ',' || byte === '}' || byte === ']'
        || (this.whitespace && REVIEW_STRUCTURE_WHITESPACE.test(byte))) break;
      raw += byte;
      // The scalar is bounded while it accumulates, so an unterminated or oversized token fails.
      if (raw.length > limit) throw new Error('workflow_review_source_corrupt');
    }
    // Strict JSON number syntax: no leading zeros, no bare sign or dot, no trailing exponent.
    if (raw.length > limit
      || !/^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][-+]?[0-9]+)?)$/.test(raw)) {
      throw new Error('workflow_review_source_corrupt');
    }
    this.buffer = this.buffer.slice(raw.length);
    return raw;
  }
  /** Validate and discard a JSON string without retaining its contents or imposing a length cap. */
  skipString(): void {
    this.take('"');
    for (;;) {
      this.fill(1);
      if (!this.buffer.length) throw new Error('workflow_review_source_corrupt');
      const at = this.buffer.search(/["\\\u0000-\u001f]/);
      if (at < 0) { this.buffer = ''; continue; }
      this.buffer = this.buffer.slice(at);
      if (this.buffer[0] === '"') { this.buffer = this.buffer.slice(1); return; }
      if (this.buffer[0] !== '\\') throw new Error('workflow_review_source_corrupt');
      this.fill(2);
      if (this.buffer[1] === 'u') {
        this.fill(6);
        if (!/^\\u[0-9a-fA-F]{4}/.test(this.buffer)) throw new Error('workflow_review_source_corrupt');
        this.buffer = this.buffer.slice(6);
      } else {
        if (!/^\\["\\/bfnrt]/.test(this.buffer)) throw new Error('workflow_review_source_corrupt');
        this.buffer = this.buffer.slice(2);
      }
    }
  }
  /** Decode one arbitrarily long JSON string in bounded pieces, preserving UTF-16 code units. */
  streamString(consume: (piece: string) => void): void {
    this.take('"');
    for (;;) {
      this.fill(1);
      if (!this.buffer.length) throw new Error('workflow_review_source_corrupt');
      const at = this.buffer.search(/["\\\u0000-\u001f]/);
      const length = at < 0 ? this.buffer.length : at;
      for (let offset = 0; offset < length; offset += 16384) consume(this.buffer.slice(offset, Math.min(length, offset + 16384)));
      this.buffer = this.buffer.slice(length);
      if (at < 0) continue;
      if (this.buffer[0] === '"') { this.buffer = this.buffer.slice(1); return; }
      if (this.buffer[0] !== '\\') throw new Error('workflow_review_source_corrupt');
      this.fill(2);
      if (this.buffer[1] === 'u') {
        this.fill(6);
        if (!/^\\u[0-9a-fA-F]{4}/.test(this.buffer)) throw new Error('workflow_review_source_corrupt');
        consume(String.fromCharCode(parseInt(this.buffer.slice(2, 6), 16))); this.buffer = this.buffer.slice(6);
      } else {
        if (!/^\\["\\/bfnrt]/.test(this.buffer)) throw new Error('workflow_review_source_corrupt');
        consume(JSON.parse(`"${this.buffer.slice(0, 2)}"`) as string); this.buffer = this.buffer.slice(2);
      }
    }
  }
  /** Discard scalars in irrelevant native metadata through a finite JSON-number state machine. */
  skipScalar(): void {
    if (this.peek('"')) { this.skipString(); return; }
    for (const literal of ['true', 'false', 'null']) if (this.peek(literal)) { this.take(literal); return; }
    let state = 'start';
    for (;;) {
      this.fill(1); let at = 0;
      for (; at < this.buffer.length; at++) {
        const byte = this.buffer[at]!;
        if (/[,}\]\s]/.test(byte)) break;
        if (state === 'start') state = byte === '-' ? 'sign' : byte === '0' ? 'zero' : /[1-9]/.test(byte) ? 'integer' : 'invalid';
        else if (state === 'sign') state = byte === '0' ? 'zero' : /[1-9]/.test(byte) ? 'integer' : 'invalid';
        else if (state === 'zero' || state === 'integer') state = byte === '.' ? 'fraction-start' : /[eE]/.test(byte) ? 'exponent-start'
          : state === 'integer' && /[0-9]/.test(byte) ? 'integer' : 'invalid';
        else if (state === 'fraction-start') state = /[0-9]/.test(byte) ? 'fraction' : 'invalid';
        else if (state === 'fraction') state = /[0-9]/.test(byte) ? 'fraction' : /[eE]/.test(byte) ? 'exponent-start' : 'invalid';
        else if (state === 'exponent-start') state = /[+-]/.test(byte) ? 'exponent-sign' : /[0-9]/.test(byte) ? 'exponent' : 'invalid';
        else if (state === 'exponent-sign') state = /[0-9]/.test(byte) ? 'exponent' : 'invalid';
        else if (state === 'exponent') state = /[0-9]/.test(byte) ? 'exponent' : 'invalid';
        if (state === 'invalid') throw new Error('workflow_review_source_corrupt');
      }
      this.buffer = this.buffer.slice(at);
      if (this.buffer.length || this.ended) {
        if (!['zero', 'integer', 'fraction', 'exponent'].includes(state)) throw new Error('workflow_review_source_corrupt');
        return;
      }
    }
  }
  /** Reintroduce a bounded selected record prefix; skipped records never use this path. */
  restoreRecordType(type: string): void { this.buffer = `{"type":${JSON.stringify(type)}` + this.buffer; }
  /** Read one complete nested JSON object or array verbatim, bounded by `limit` characters. */
  readStructured(limit: number): string {
    // A record in a host document may be positioned after formatting whitespace — the newline that
    // follows the array's opening bracket, for instance — so the token starts where the value does.
    // The bytes inside the structure are carried verbatim, whitespace included, because the raw text
    // of a host field is re-emitted as the host wrote it.
    this.space();
    this.fill(1);
    const opening = this.buffer[0];
    if (opening !== '{' && opening !== '[') throw new Error('workflow_review_source_corrupt');
    const closing = opening === '{' ? '}' : ']';
    let depth = 0; let inString = false; let escaped = false; let out = '';
    for (;;) {
      this.fill(1);
      if (!this.buffer.length) throw new Error('workflow_review_source_corrupt');
      const chunk = this.buffer; this.buffer = '';
      for (let index = 0; index < chunk.length; index++) {
        const byte = chunk[index]!;
        out += byte;
        if (inString) {
          if (escaped) escaped = false;
          else if (byte === '\\') escaped = true;
          else if (byte === '"') inString = false;
          continue;
        }
        if (byte === '"') { inString = true; continue; }
        if (byte === opening) depth++;
        else if (byte === closing) {
          depth--;
          // The bound is enforced on the closing byte, before the object is handed back: a structure
          // that closes inside this chunk returns straight out of the loop and would otherwise never
          // reach the accumulate-time check below, so a nested object larger than its limit would be
          // accepted whole rather than refused.
          if (depth === 0) {
            if (out.length > limit) throw new Error('workflow_review_source_corrupt');
            this.buffer = chunk.slice(index + 1) + this.buffer; return out;
          }
        }
      }
      if (out.length > limit) throw new Error('workflow_review_source_corrupt');
    }
  }
}

/** One bounded entry record, validated. */
function entryRecordFromUnknown(value: unknown): WorkflowReviewSourceRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('workflow_review_source_corrupt');
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== 'string' || !ID_PATTERN.test(raw.id)
    || !ALL_KINDS.includes(raw.kind as WorkflowReviewMaterialKind)
    || typeof raw.path !== 'string' || typeof raw.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(raw.sha256)
    || typeof raw.bytes !== 'number' || !Number.isSafeInteger(raw.bytes) || raw.bytes < 0) {
    throw new Error('workflow_review_source_corrupt');
  }
  return Object.freeze({ id: raw.id, kind: raw.kind as WorkflowReviewMaterialKind, path: raw.path,
    sha256: raw.sha256, bytes: raw.bytes });
}
/** A record as a full entry, resolving the immutable on-disk file that holds its exact bytes. */
function entryFromRecord(record: WorkflowReviewSourceRecord, entriesDirectory: string): WorkflowReviewSourceEntry {
  return Object.freeze({ ...record, file: join(entriesDirectory, record.id) });
}

/**
 * Stream one canonical manifest record-by-record. The header scalars and each entry record are the
 * only things ever held, so parsing a bundle of any size is bounded IO: the `header` object is
 * populated as its fields are met and is complete only once the iterator is exhausted, and every
 * scalar is validated inside its own finite field bound so a malformed token fails rather than grows.
 */
function* streamWorkflowReviewManifest(path: string, header: Record<string, unknown>,
  seen: { entries: boolean }): Generator<WorkflowReviewSourceRecord> {
  const cursor = new WorkflowReviewStructureCursor(readWorkflowReviewTextChunks(path));
  try {
    cursor.take('{');
    let firstField = true;
    for (;;) {
      if (cursor.peek('}')) break;
      if (!firstField) cursor.take(',');
      firstField = false;
      const key = cursor.readString(REVIEW_STRUCTURE_FIELD_LIMIT);
      cursor.take(':');
      if (key === 'entries') {
        // The entry array appears exactly once. A second one is not a longer manifest, it is a
        // manifest with two disagreeing entry sets, so it is refused rather than re-read.
        if (seen.entries) throw new Error('workflow_review_source_corrupt');
        seen.entries = true;
        cursor.take('[');
        let firstEntry = true;
        for (;;) {
          if (cursor.peek(']')) break;
          if (!firstEntry) cursor.take(',');
          firstEntry = false;
          yield* retainedReviewRecord(entryRecordFromUnknown(JSON.parse(cursor.readStructured(REVIEW_STRUCTURE_RECORD_LIMIT))));
        }
        cursor.take(']');
        continue;
      }
      // The canonical manifest has a finite, fixed header: these exact keys, each exactly once, and
      // nothing else. An unknown, repeated or misplaced key is corruption — the header is a closed
      // shape, not an open bag, so a manifest cannot smuggle arbitrary retained state past the reader
      // by adding keys this reader would otherwise copy into the header unbounded.
      const scalar = WORKFLOW_REVIEW_MANIFEST_HEADER[key];
      if (scalar === undefined || key in header) throw new Error('workflow_review_source_corrupt');
      header[key] = scalar === 'integer' ? cursor.readInteger() : cursor.readString(REVIEW_STRUCTURE_FIELD_LIMIT);
    }
    cursor.take('}');
    cursor.end();
    if (!seen.entries) throw new Error('workflow_review_source_corrupt');
  } finally { cursor.close(); }
}

/**
 * Walk one authorized-source manifest as bounded canonical records, in deterministic order, one path
 * at a time. The manifest is a host file of JSONL path records sorted strictly ascending: the walk
 * holds one line at a time, refuses a record that is not a bounded repository-relative POSIX path,
 * and refuses a repeat or a step backwards, so a duplicate, a reordered or an alias-escaping member
 * fails instead of being silently accepted. `verify` additionally binds the walk to the descriptor
 * (exact byte count, record count and content digest), so a dropped, added or rewritten member
 * cannot be read as the authorized set.
 */
function* walkWorkflowReviewAuthorizedPaths(descriptor: WorkflowReviewSourceManifestDescriptor,
  verify: boolean): Generator<string> {
  const stat = lstatSync(descriptor.path, { throwIfNoEntry: false });
  if (!stat || stat.isSymbolicLink() || !stat.isFile()) throw new Error('workflow_review_compatibility_source_unavailable');
  if (verify && stat.size !== descriptor.bytes) throw new Error('workflow_review_compatibility_source_mismatch');
  const hash = createHash('sha256');
  // The manifest is decoded through one stateful UTF-8 decoder, so a multi-byte scalar split across
  // a chunk seam is reassembled rather than corrupted into two replacement characters.
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = ''; let consumed = 0; let records = 0; let previous: string | undefined;
  for (const chunk of readWorkflowReviewFileChunks(descriptor.path)) {
    if (verify) hash.update(chunk);
    consumed += chunk.length;
    pending += decoder.decode(chunk, { stream: true });
    for (;;) {
      const index = pending.indexOf('\n');
      if (index < 0) break;
      const line = pending.slice(0, index); pending = pending.slice(index + 1);
      const path = authorizedManifestRecord(line);
      if (previous !== undefined && compareWorkflowReviewGitPaths(path, previous) <= 0) {
        throw new Error('workflow_review_compatibility_invalid_paths');
      }
      previous = path; records++;
      yield* retainedReviewRecord(path);
    }
    if (pending.length > MEMBER_PATH_LIMIT * 16) throw new Error('workflow_review_compatibility_invalid_paths');
  }
  pending += decoder.decode();
  if (pending.trim()) {
    const path = authorizedManifestRecord(pending);
    if (previous !== undefined && compareWorkflowReviewGitPaths(path, previous) <= 0) {
      throw new Error('workflow_review_compatibility_invalid_paths');
    }
    records++;
    yield* retainedReviewRecord(path);
  }
  if (!verify) return;
  if (records !== descriptor.records || consumed !== descriptor.bytes || hash.digest('hex') !== descriptor.sha256) {
    throw new Error('workflow_review_compatibility_source_mismatch');
  }
}
function authorizedManifestRecord(line: string): string {
  let parsed: unknown;
  try { parsed = JSON.parse(line); } catch { throw new Error('workflow_review_compatibility_invalid_paths'); }
  if (typeof parsed !== 'string') throw new Error('workflow_review_compatibility_invalid_paths');
  return assertWorkflowReviewSourcePath(parsed);
}
/** Stream the authorized path set of one manifest descriptor, verifying it against the descriptor. */
export function iterateWorkflowReviewAuthorizedPaths(descriptor: WorkflowReviewSourceManifestDescriptor): Generator<string> {
  return walkWorkflowReviewAuthorizedPaths(descriptor, true);
}
/**
 * Verify one authorized-source manifest against its descriptor without materializing it, and return
 * the derived identity. A manifest that is missing, a symlink, a different length, a different
 * record count or a different content digest is refused here, before any reservation.
 */
export function verifyWorkflowReviewSourceManifestDescriptor(descriptor: WorkflowReviewSourceManifestDescriptor):
  { path: string; bytes: number; records: number; sha256: string } {
  let records = 0;
  for (const _path of walkWorkflowReviewAuthorizedPaths(descriptor, true)) records++;
  return { path: descriptor.path, bytes: descriptor.bytes, records, sha256: descriptor.sha256 };
}
/**
 * Prove each authorized member is a tracked file of the reviewed checkout. Both the manifest and the
 * index listing are sorted ascending, so the two are walked in lockstep — one bounded record from
 * each at a time — and a member that is untracked, ignored, private to the worktree or an alias of
 * another member is refused. The listing is spooled to a private artifact rather than buffered.
 */
export function verifyWorkflowReviewAuthorizedMembership(input: { cwd: string; descriptor: WorkflowReviewSourceManifestDescriptor }): number {
  const directory = mkdtempSync(join(tmpdir(), 'omc-review-authorized-'));
  const listing = join(directory, 'tracked');
  try {
    // `-z` emits every tracked path as one literal NUL-delimited record and disables Git's quoting,
    // so a path with spaces, a quote or a non-ASCII character is compared exactly as the manifest
    // names it rather than through a quoted, escaped or trimmed line representation.
    spoolWorkflowReviewGit({ cwd: input.cwd, args: ['ls-files', '--cached', '--full-name', '-z'], path: listing });
    const tracked = iterateWorkflowReviewNulRecords(listing);
    const authorized = iterateWorkflowReviewAuthorizedPaths(input.descriptor);
    let members = 0;
    let current = tracked.next();
    try {
      for (const path of authorized) {
        // The advance is driven by Git's own byte order, the same order the listing arrives in, so a
        // path whose UTF-16 order differs from its byte order cannot make this walk skip its member.
        while (!current.done && compareWorkflowReviewGitPaths(current.value, path) < 0) current = tracked.next();
        if (current.done || current.value !== path) throw new Error('workflow_review_compatibility_source_mismatch');
        members++;
      }
    } finally {
      // Both walks own an open descriptor: returning them on any early exit releases it deterministically.
      tracked.return?.(undefined as never);
      authorized.return?.(undefined as never);
    }
    return members;
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

/** Walk one file as raw NUL-delimited records through a bounded buffer, never reading it whole. */
/**
 * Walk a NUL-delimited record file — a `git ... -z` listing — one exact path at a time. NUL is the
 * only separator Git does not escape, so a path holding spaces, quotes, backslashes or non-ASCII
 * bytes survives verbatim; decoding is stateful across chunk seams so a multi-byte character split
 * between two reads is never replaced.
 */
export function* iterateWorkflowReviewNulRecords(path: string): Generator<string> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '';
  for (const chunk of readWorkflowReviewFileChunks(path)) {
    pending += decoder.decode(chunk, { stream: true });
    for (;;) {
      const index = pending.indexOf('\0');
      if (index < 0) break;
      const record = pending.slice(0, index); pending = pending.slice(index + 1);
      if (record) yield* retainedReviewRecord(record);
    }
    if (pending.length > MEMBER_PATH_LIMIT * 16) throw new Error('workflow_review_compatibility_invalid_paths');
  }
  pending += decoder.decode();
  if (pending) yield* retainedReviewRecord(pending);
}

/** One top-level field of a bounded JSON document, as the raw JSON text of its value. */
export interface WorkflowReviewJsonField { readonly key: string; readonly raw: string }
/**
 * Read the top-level fields of one JSON document other than a named record array, one bounded field
 * at a time. The named array is skipped without being collected, and no field list is retained, so a
 * catalog carrying many models or many top-level fields is walked in constant memory. Used to project
 * the host's own catalog without buffering it.
 *
 * This is somebody else's document, so its readers tolerate separator whitespace: a host catalog that
 * is indented, wrapped or otherwise reformatted is still the host's own catalog and must project.
 */
export function* iterateWorkflowReviewJsonFields(input: { path: string; arrayKey: string | readonly string[]; fields?: readonly string[] }): Generator<WorkflowReviewJsonField> {
  const cursor = new WorkflowReviewStructureCursor(readWorkflowReviewTextChunks(input.path), { whitespace: true });
  try {
    cursor.take('{');
    let first = true;
    for (;;) {
      if (cursor.peek('}')) break;
      if (!first) cursor.take(',');
      first = false;
      const key = cursor.readString(REVIEW_STRUCTURE_FIELD_LIMIT);
      cursor.take(':');
      if (typeof input.arrayKey === 'string' ? key === input.arrayKey : input.arrayKey.includes(key)) {
        if (!cursor.peek('[')) throw new Error('workflow_review_codex_catalog_unavailable');
        skipStructured(cursor, '[', true);
        continue;
      }
      if (input.fields && !input.fields.includes(key)) {
        if (cursor.peek('{') || cursor.peek('[')) skipStructured(cursor, cursor.peek('{') ? '{' : '[', true);
        else cursor.skipScalar();
        continue;
      }
      yield Object.freeze({ key, raw: cursor.peek('{') || cursor.peek('[')
        ? cursor.readStructured(REVIEW_STRUCTURE_RECORD_LIMIT) : cursor.readScalar(REVIEW_STRUCTURE_FIELD_LIMIT) });
    }
    cursor.take('}');
    cursor.end();
  } finally { cursor.close(); }
}
/** Walk one named top-level array of a JSON document, yielding one bounded element record at a time. */
export function* iterateWorkflowReviewJsonRecords(input: { path: string; arrayKey: string; found: { value: boolean }; streamScalars?: boolean; skipTypes?: readonly string[] }): Generator<string> {
  const cursor = new WorkflowReviewStructureCursor(readWorkflowReviewTextChunks(input.path), { whitespace: true });
  try {
    cursor.take('{');
    let first = true;
    for (;;) {
      if (cursor.peek('}')) break;
      if (!first) cursor.take(',');
      first = false;
      const key = cursor.readString(REVIEW_STRUCTURE_FIELD_LIMIT);
      cursor.take(':');
      if (key !== input.arrayKey) {
        if (cursor.peek('{') || cursor.peek('[')) skipStructured(cursor, cursor.peek('{') ? '{' : '[',
          input.streamScalars === true);
        else if (input.streamScalars) cursor.skipScalar();
        else cursor.readScalar(REVIEW_STRUCTURE_FIELD_LIMIT);
        continue;
      }
      if (!cursor.peek('[')) throw new Error('workflow_review_codex_catalog_unavailable');
      input.found.value = true;
      cursor.take('[');
      let firstRecord = true;
      for (;;) {
        if (cursor.peek(']')) break;
        if (!firstRecord) cursor.take(',');
        firstRecord = false;
        if (input.skipTypes) {
          cursor.take('{');
          if (cursor.readString(REVIEW_STRUCTURE_FIELD_LIMIT) !== 'type') throw new Error('workflow_review_source_corrupt');
          cursor.take(':'); const type = cursor.readString(REVIEW_STRUCTURE_FIELD_LIMIT);
          if (input.skipTypes.includes(type)) { skipStructured(cursor, '{', true, true); continue; }
          cursor.restoreRecordType(type);
        }
        yield cursor.readStructured(REVIEW_STRUCTURE_RECORD_LIMIT);
      }
      cursor.take(']');
    }
    cursor.take('}');
    cursor.end();
  } finally { cursor.close(); }
}
/** Discard one complete nested JSON value without collecting it. */
function skipStructured(cursor: WorkflowReviewStructureCursor, opening: '{' | '[', streamScalars = false, started = false): void {
  const closing = opening === '{' ? '}' : ']';
  if (!started) cursor.take(opening);
  let first = !started;
  for (;;) {
    if (cursor.peek(closing)) break;
    if (!first) cursor.take(',');
    first = false;
    if (opening === '{') {
      if (streamScalars) cursor.skipString();
      else cursor.readString(REVIEW_STRUCTURE_FIELD_LIMIT);
      cursor.take(':');
    }
    if (cursor.peek('{') || cursor.peek('[')) skipStructured(cursor, cursor.peek('{') ? '{' : '[', streamScalars);
    else if (streamScalars) cursor.skipScalar();
    else cursor.readScalar(REVIEW_STRUCTURE_FIELD_LIMIT);
  }
  cursor.take(closing);
}

export interface WorkflowReviewNativeItemFingerprint {
  readonly type: string;
  readonly id?: string;
  readonly role?: string;
  readonly phase?: string;
  readonly callId?: string;
  readonly name?: string;
  readonly sha256: string;
  readonly withoutIdSha256: string;
  /** Context reconstruction is checked separately; this digest is never ordinary item equality. */
  readonly contextSha256?: string;
  readonly metadata?: { readonly turnId?: string; readonly createTime: boolean; readonly kindsSha256?: string };
  readonly fields: Readonly<Record<string, string>>;
  /** Pinned serialization candidate; only completed model-output ancestry may adopt it. */
  readonly historySerialization?: { readonly sha256: string; readonly fields: Readonly<Record<string, string>> };
}
interface NativeFingerprintField {
  sha256: string; value?: string; mask?: number; null?: boolean; count?: bigint;
  metadata?: { turnId?: string; createTime: boolean; kindsSha256?: string; withoutCreateTimeSha256: string; fields: Readonly<Record<string, string>> };
}
type NativeFieldReader = () => NativeFingerprintField;
function nativeFingerprintObject(fields: Readonly<Record<string, string>>): string {
  const hash = createHash('sha256').update('object\n');
  for (const key of Object.keys(fields).sort()) hash.update(JSON.stringify([key, fields[key]]) + '\n');
  return hash.digest('hex');
}
function nativeFingerprintString(cursor: WorkflowReviewStructureCursor): NativeFingerprintField {
  const hash = createHash('sha256').update('string\n'); let units = 0n;
  cursor.streamString(piece => {
    // UTF-16 code units make literal/escaped pairs equal without replacing a lone surrogate or a
    // pair split across pieces. Each temporary buffer stays below the existing working-buffer bound.
    const bytes = Buffer.from(piece, 'utf16le'); const release = holdReviewResource('bufferBytes', bytes.length);
    try { hash.update(bytes); units += BigInt(piece.length); } finally { release(); }
  });
  hash.update(`\n${units}`); return { sha256: hash.digest('hex') };
}
function nativeFingerprintControl(cursor: WorkflowReviewStructureCursor): NativeFingerprintField {
  const value = cursor.readString(REVIEW_STRUCTURE_FIELD_LIMIT);
  return { sha256: digest(Buffer.from(JSON.stringify(value))), value };
}
function nativeFingerprintScalar(cursor: WorkflowReviewStructureCursor): NativeFingerprintField {
  const value: unknown = JSON.parse(cursor.readScalar(REVIEW_STRUCTURE_FIELD_LIMIT));
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('workflow_review_source_corrupt');
  return { sha256: digest(Buffer.from(JSON.stringify(value))), ...(value === null ? { null: true } : {}) };
}
function nativeFingerprintFields(cursor: WorkflowReviewStructureCursor, readers: Readonly<Record<string, NativeFieldReader>>): Record<string, NativeFingerprintField> {
  cursor.take('{'); const fields: Record<string, NativeFingerprintField> = {}; let first = true;
  while (!cursor.peek('}')) {
    if (!first) cursor.take(','); first = false;
    const key = cursor.readString(REVIEW_STRUCTURE_FIELD_LIMIT); cursor.take(':');
    if (!Object.hasOwn(readers, key) || Object.hasOwn(fields, key)) throw new Error('workflow_review_source_corrupt');
    fields[key] = readers[key]!();
  }
  cursor.take('}'); return fields;
}
function nativeFingerprintArray(cursor: WorkflowReviewStructureCursor, item: NativeFieldReader): NativeFingerprintField {
  cursor.take('['); const hash = createHash('sha256').update('array\n'); let first = true; let mask = 0; let count = 0n;
  while (!cursor.peek(']')) {
    if (!first) cursor.take(','); first = false;
    const field = item(); hash.update(field.sha256 + '\n'); mask |= field.mask ?? 0; count++;
  }
  cursor.take(']'); return { sha256: hash.digest('hex'), mask, count };
}
function nativeFingerprintText(cursor: WorkflowReviewStructureCursor): NativeFingerprintField {
  const fields = nativeFingerprintFields(cursor, { type: () => nativeFingerprintControl(cursor), text: () => nativeFingerprintString(cursor) });
  const types = ['input_text', 'output_text', 'summary_text', 'reasoning_text']; const at = types.indexOf(fields.type?.value ?? '');
  if (at < 0 || !fields.text) throw new Error('workflow_review_source_corrupt');
  return { sha256: nativeFingerprintObject(Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field.sha256]))), mask: 1 << at };
}
function nativeFingerprintMetadata(cursor: WorkflowReviewStructureCursor): NativeFingerprintField {
  const fields = nativeFingerprintFields(cursor, { turn_id: () => nativeFingerprintControl(cursor),
    create_time: () => {
      const raw = cursor.readScalar(REVIEW_STRUCTURE_FIELD_LIMIT); const value: unknown = JSON.parse(raw);
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('workflow_review_source_corrupt');
      return { sha256: digest(Buffer.from(JSON.stringify(value))) };
    }, content_item_kinds: () => nativeFingerprintArray(cursor, () => nativeFingerprintControl(cursor)) });
  const hashes = Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field.sha256]));
  const { create_time: _time, ...withoutTime } = hashes;
  return { sha256: nativeFingerprintObject(hashes), metadata: { turnId: fields.turn_id?.value, createTime: !!fields.create_time,
    kindsSha256: fields.content_item_kinds?.sha256, withoutCreateTimeSha256: nativeFingerprintObject(withoutTime), fields: hashes } };
}
/** Only bounded inventory/schema controls use a generic JSON value; source/history never does. */
function nativeFingerprintControlJson(raw: string): NativeFingerprintField {
  const bounded = new WorkflowReviewStructureCursor((function* () { yield raw; })(), { whitespace: true });
  const walk = (): NativeFingerprintField => {
    if (bounded.peek('[')) return nativeFingerprintArray(bounded, walk);
    if (bounded.peek('{')) {
      bounded.take('{'); const fields: Record<string, string> = Object.create(null); let first = true;
      while (!bounded.peek('}')) {
        if (!first) bounded.take(','); first = false;
        const key = bounded.readString(REVIEW_STRUCTURE_FIELD_LIMIT); bounded.take(':');
        if (Object.hasOwn(fields, key)) throw new Error('workflow_review_source_corrupt');
        fields[key] = walk().sha256;
      }
      bounded.take('}'); return { sha256: nativeFingerprintObject(fields) };
    }
    return bounded.peek('"') ? nativeFingerprintControl(bounded) : nativeFingerprintScalar(bounded);
  };
  try { const field = walk(); bounded.end(); return field; } finally { bounded.close(); }
}
function nativeFingerprintInventory(cursor: WorkflowReviewStructureCursor): NativeFingerprintField {
  if (!cursor.peek('[')) throw new Error('workflow_review_source_corrupt');
  return nativeFingerprintControlJson(cursor.readStructured(REVIEW_STRUCTURE_RECORD_LIMIT));
}
function nativeFingerprintItem(cursor: WorkflowReviewStructureCursor, publicCompactionMetadata: boolean): WorkflowReviewNativeItemFingerprint {
  const control = () => nativeFingerprintControl(cursor); const string = () => nativeFingerprintString(cursor);
  const optionalString = () => cursor.peek('null') ? nativeFingerprintScalar(cursor) : string();
  const fields = nativeFingerprintFields(cursor, { type: control, id: control, role: control, phase: control, name: control,
    namespace: () => cursor.peek('null') ? nativeFingerprintScalar(cursor) : control(), call_id: control,
    arguments: string, output: string, encrypted_content: optionalString,
    content: () => cursor.peek('null') ? nativeFingerprintScalar(cursor) : nativeFingerprintArray(cursor, () => nativeFingerprintText(cursor)),
    summary: () => nativeFingerprintArray(cursor, () => nativeFingerprintText(cursor)),
    tools: () => nativeFingerprintInventory(cursor),
    internal_chat_message_metadata_passthrough: () => nativeFingerprintMetadata(cursor),
    metadata: () => {
      const values = nativeFingerprintFields(cursor, { turn_id: control });
      if (!values.turn_id) throw new Error('workflow_review_source_corrupt');
      return values.turn_id;
    } });
  const type = fields.type?.value ?? '';
  if (type === 'reasoning' && !fields.encrypted_content) fields.encrypted_content = { sha256: digest(Buffer.from('null')), null: true };
  const schemas: Record<string, { required: readonly string[]; optional: readonly string[] }> = {
    message: { required: ['role', 'content'], optional: ['id', 'phase', 'internal_chat_message_metadata_passthrough'] },
    reasoning: { required: ['summary', 'encrypted_content'], optional: ['id', 'content', 'internal_chat_message_metadata_passthrough'] },
    function_call: { required: ['name', 'arguments', 'call_id'], optional: ['id', 'namespace', 'internal_chat_message_metadata_passthrough'] },
    function_call_output: { required: ['call_id', 'output'], optional: ['id', 'name', 'namespace', 'internal_chat_message_metadata_passthrough'] },
    compaction: { required: ['encrypted_content'], optional: ['id', 'internal_chat_message_metadata_passthrough', ...(publicCompactionMetadata ? ['metadata'] : [])] },
    compaction_trigger: { required: [], optional: [] },
    additional_tools: { required: ['role', 'tools'], optional: ['id'] },
  };
  const schema = Object.hasOwn(schemas, type) ? schemas[type] : undefined;
  if (!schema || schema.required.some(key => !fields[key])
    || Object.keys(fields).some(key => key !== 'type' && !schema.required.includes(key) && !schema.optional.includes(key))
    || type === 'message' && (fields.content!.null || !['developer', 'user', 'assistant', 'system'].includes(fields.role!.value ?? '') || ((fields.content!.mask ?? 0) & ~3))
    || type === 'message' && fields.phase && !['commentary', 'final_answer'].includes(fields.phase.value ?? '')
    || type === 'reasoning' && (((fields.summary!.mask ?? 0) & ~4) || ((fields.content?.mask ?? 0) & ~8))
    || type === 'additional_tools' && fields.role!.value !== 'developer'
    || type === 'compaction' && fields.encrypted_content!.null) throw new Error('workflow_review_source_corrupt');
  if (fields.metadata && (type !== 'compaction' || !publicCompactionMetadata
    || fields.metadata.value !== fields.internal_chat_message_metadata_passthrough?.metadata?.turnId)) throw new Error('workflow_review_source_corrupt');
  const hashes = Object.fromEntries(Object.entries(fields).filter(([key]) => key !== 'metadata').map(([key, field]) => [key, field.sha256]));
  const { id: _id, ...withoutId } = hashes;
  const metadata = fields.internal_chat_message_metadata_passthrough?.metadata;
  const context = metadata ? { ...withoutId, internal_chat_message_metadata_passthrough: metadata.withoutCreateTimeSha256 } : withoutId;
  let history: Record<string, string> | undefined;
  // Codex 0.159.1 unsupported-audio normalization writes positional unknown kinds for
  // unchanged text when kinds were absent (annotated_content.rs:52–98). Existing kinds stay exact.
  if (type === 'message' && fields.role?.value === 'assistant' && !metadata?.kindsSha256) {
    const kinds = createHash('sha256').update('array\n'); const unknown = digest(Buffer.from(JSON.stringify('unknown')));
    for (let count = fields.content!.count!; count > 0n; count--) kinds.update(unknown + '\n');
    history = { ...hashes, internal_chat_message_metadata_passthrough: nativeFingerprintObject({
      ...metadata?.fields, content_item_kinds: kinds.digest('hex') }) };
  } else if (type === 'reasoning' && fields.content?.count === 0n) {
    // protocol/models.rs should_serialize_reasoning_content omits Some([]), never nonempty text.
    const { content: _content, ...withoutEmptyContent } = hashes; history = withoutEmptyContent;
  }
  return Object.freeze({ type, id: fields.id?.value, role: fields.role?.value, phase: fields.phase?.value,
    callId: fields.call_id?.value, name: fields.name?.value, fields: Object.freeze(hashes),
    sha256: nativeFingerprintObject(hashes), withoutIdSha256: nativeFingerprintObject(withoutId),
    ...(history ? { historySerialization: Object.freeze({ sha256: nativeFingerprintObject(history), fields: Object.freeze(history) }) } : {}),
    ...(type === 'message' ? { contextSha256: nativeFingerprintObject(context) } : {}),
    ...(metadata ? { metadata: Object.freeze({ turnId: metadata.turnId, createTime: metadata.createTime, kindsSha256: metadata.kindsSha256 }) } : {}) });
}
/** Stream typed text-only native history items from an owned JSON file, with no item/history size cap. */
export function* iterateWorkflowReviewNativeItems(input: { file: WorkflowReviewOwnedFile; arrayKey: string;
  publicCompactionMetadata?: boolean; chunkBytes?: number }): Generator<WorkflowReviewNativeItemFingerprint> {
  const cursor = new WorkflowReviewStructureCursor(readWorkflowReviewTextChunks(input.file,
    Math.max(1, Math.min(input.chunkBytes ?? 16384, 16384))), { whitespace: true }); let found = false;
  try {
    cursor.take('{'); let first = true;
    while (!cursor.peek('}')) {
      if (!first) cursor.take(','); first = false;
      const key = cursor.readString(REVIEW_STRUCTURE_FIELD_LIMIT); cursor.take(':');
      if (key !== input.arrayKey) {
        if (cursor.peek('{') || cursor.peek('[')) skipStructured(cursor, cursor.peek('{') ? '{' : '[', true);
        else cursor.skipScalar();
        continue;
      }
      if (found) throw new Error('workflow_review_source_corrupt'); found = true;
      cursor.take('['); let firstItem = true;
      while (!cursor.peek(']')) {
        if (!firstItem) cursor.take(','); firstItem = false;
        yield nativeFingerprintItem(cursor, input.publicCompactionMetadata === true);
      }
      cursor.take(']');
    }
    cursor.take('}'); cursor.end();
    if (!found) throw new Error('workflow_review_evidence_corrupt');
  } finally { cursor.close(); }
}

/** Compare every request field while streaming the only unbounded field: model input history. */
export function fingerprintWorkflowReviewNativeRequest(file: WorkflowReviewOwnedFile): string {
  const cursor = new WorkflowReviewStructureCursor(readWorkflowReviewTextChunks(file, 16384), { whitespace: true });
  const fields: Record<string, string> = Object.create(null);
  try {
    cursor.take('{'); let first = true;
    while (!cursor.peek('}')) {
      if (!first) cursor.take(','); first = false;
      const key = cursor.readString(REVIEW_STRUCTURE_FIELD_LIMIT); cursor.take(':');
      if (Object.hasOwn(fields, key)) throw new Error('workflow_review_source_corrupt');
      if (key === 'input') fields[key] = nativeFingerprintArray(cursor, () => ({ sha256: nativeFingerprintItem(cursor, false).sha256 })).sha256;
      else {
        const raw = cursor.peek('{') || cursor.peek('[') ? cursor.readStructured(REVIEW_STRUCTURE_RECORD_LIMIT)
          : cursor.peek('"') ? JSON.stringify(cursor.readString(REVIEW_STRUCTURE_FIELD_LIMIT)) : cursor.readScalar(REVIEW_STRUCTURE_FIELD_LIMIT);
        fields[key] = nativeFingerprintControlJson(raw).sha256;
      }
    }
    cursor.take('}'); cursor.end();
    if (!fields.input) throw new Error('workflow_review_evidence_corrupt');
    return nativeFingerprintObject(fields);
  } finally { cursor.close(); }
}
export function workflowReviewNativeTextContentSha256(text: string): string {
  const value = createHash('sha256').update('string\n').update(Buffer.from(text, 'utf16le')).update(`\n${BigInt(text.length)}`).digest('hex');
  const item = nativeFingerprintObject({ type: digest(Buffer.from(JSON.stringify('input_text'))), text: value });
  return createHash('sha256').update('array\n').update(item + '\n').digest('hex');
}
export interface WorkflowReviewNativeRequestControls {
  readonly model: string;
  readonly parallel: boolean;
  readonly effort?: string;
  readonly context?: string;
  readonly previousResponseId?: string;
  readonly threadId?: string;
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly requestKind?: string;
  readonly instructionsContentSha256?: string;
  readonly generate?: false;
  readonly text?: { readonly verbosity?: string; readonly format?: unknown };
}
/** Observed HTTP/stock WebSocket Responses Lite controls; no inference from omitted wire fields. */
export function readWorkflowReviewNativeRequestControls(file: WorkflowReviewOwnedFile,
  representation: 'wire' | 'wire-wss' | 'compact-trace' = 'wire'): WorkflowReviewNativeRequestControls {
  const cursor = new WorkflowReviewStructureCursor(readWorkflowReviewTextChunks(file, 16384), { whitespace: true });
  const controls: { model?: string; parallel?: boolean; effort?: string; context?: string; previousResponseId?: string;
    threadId?: string; sessionId?: string; turnId?: string; requestKind?: string; instructionsContentSha256?: string; generate?: false;
    text?: { verbosity?: string; format?: unknown } } = {};
  const allowed = representation === 'compact-trace' ? ['model', 'instructions', 'input', 'parallel_tool_calls']
    : ['model', 'input', 'tool_choice', 'parallel_tool_calls', 'reasoning', 'store', 'stream', 'include', 'prompt_cache_key', 'text', 'client_metadata', 'previous_response_id'];
  if (representation === 'wire-wss') allowed.push('type', 'generate');
  const seen = new Set<string>();
  const boundedJson = (): unknown => {
    const raw = cursor.readStructured(REVIEW_STRUCTURE_RECORD_LIMIT); nativeFingerprintControlJson(raw); return JSON.parse(raw) as unknown;
  };
  try {
    cursor.take('{'); let first = true;
    while (!cursor.peek('}')) {
      if (!first) cursor.take(','); first = false;
      const key = cursor.readString(REVIEW_STRUCTURE_FIELD_LIMIT); cursor.take(':');
      if (!allowed.includes(key) || seen.has(key)) throw new Error('workflow_review_native_controls_unsupported'); seen.add(key);
      if (key === 'type') { if (cursor.readString(REVIEW_STRUCTURE_FIELD_LIMIT) !== 'response.create') throw new Error('workflow_review_native_controls_unsupported'); continue; }
      if (key === 'generate') { if (cursor.readScalar(REVIEW_STRUCTURE_FIELD_LIMIT) !== 'false') throw new Error('workflow_review_native_controls_unsupported'); controls.generate = false; continue; }
      if (key === 'input') { skipStructured(cursor, '[', true); continue; }
      if (key === 'instructions') {
        const text = nativeFingerprintString(cursor);
        const content = nativeFingerprintObject({ type: digest(Buffer.from(JSON.stringify('input_text'))), text: text.sha256 });
        controls.instructionsContentSha256 = createHash('sha256').update('array\n').update(content + '\n').digest('hex'); continue;
      }
      if (key === 'model') { controls.model = cursor.readString(REVIEW_STRUCTURE_FIELD_LIMIT); continue; }
      if (key === 'previous_response_id') { controls.previousResponseId = cursor.readString(REVIEW_STRUCTURE_FIELD_LIMIT); continue; }
      if (key === 'parallel_tool_calls') {
        const raw = cursor.readScalar(REVIEW_STRUCTURE_FIELD_LIMIT);
        if (raw !== 'true' && raw !== 'false') throw new Error('workflow_review_native_controls_unsupported'); controls.parallel = raw === 'true'; continue;
      }
      if (key === 'reasoning') {
        const value = boundedJson() as { effort?: unknown; context?: unknown };
        if (!value || Array.isArray(value) || Object.keys(value).some(field => !['effort', 'context', 'summary'].includes(field))
          || typeof value.effort !== 'string' || typeof value.context !== 'string') throw new Error('workflow_review_native_controls_unsupported');
        controls.effort = value.effort; controls.context = value.context; continue;
      }
      if (key === 'text') {
        const value = boundedJson() as { verbosity?: string; format?: unknown };
        if (!value || Array.isArray(value) || Object.keys(value).some(field => !['verbosity', 'format'].includes(field))
          || value.verbosity !== undefined && !['low', 'medium', 'high'].includes(value.verbosity)) throw new Error('workflow_review_native_controls_unsupported');
        controls.text = value; continue;
      }
      if (key === 'client_metadata') {
        const value = boundedJson() as Record<string, unknown>;
        if (!value || Array.isArray(value) || Object.values(value).some(field => typeof field !== 'string')) throw new Error('workflow_review_native_controls_unsupported');
        for (const field of ['thread_id', 'session_id', 'turn_id']) if (typeof value[field] !== 'string') throw new Error('workflow_review_native_controls_unsupported');
        controls.threadId = value.thread_id as string; controls.sessionId = value.session_id as string; controls.turnId = value.turn_id as string;
        if (representation === 'wire-wss' && value.ws_request_header_x_openai_internal_codex_responses_lite !== 'true') throw new Error('workflow_review_native_controls_unsupported');
        if (typeof value['x-codex-turn-metadata'] !== 'string') throw new Error('workflow_review_native_controls_unsupported');
        nativeFingerprintControlJson(value['x-codex-turn-metadata']);
        const metadata = JSON.parse(value['x-codex-turn-metadata']) as Record<string, unknown>;
        if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)
          || metadata.thread_id !== controls.threadId || metadata.session_id !== controls.sessionId || metadata.turn_id !== controls.turnId
          || typeof metadata.request_kind !== 'string') throw new Error('workflow_review_native_controls_unsupported');
        controls.requestKind = metadata.request_kind; continue;
      }
      if (key === 'tool_choice') { if (cursor.readString(REVIEW_STRUCTURE_FIELD_LIMIT) !== 'auto') throw new Error('workflow_review_native_controls_unsupported'); continue; }
      if (key === 'store' || key === 'stream') {
        if (cursor.readScalar(REVIEW_STRUCTURE_FIELD_LIMIT) !== (key === 'store' ? 'false' : 'true')) throw new Error('workflow_review_native_controls_unsupported'); continue;
      }
      if (cursor.peek('{') || cursor.peek('[')) skipStructured(cursor, cursor.peek('{') ? '{' : '[', true);
      else cursor.skipScalar();
    }
    cursor.take('}'); cursor.end();
    const required = representation === 'compact-trace' ? allowed : ['model', 'input', 'parallel_tool_calls', 'reasoning', 'client_metadata', 'tool_choice', 'store', 'stream'];
    if (required.some(key => !seen.has(key)) || !controls.model || controls.parallel === undefined) throw new Error('workflow_review_native_controls_unsupported');
    if (representation === 'wire-wss' && (!seen.has('type') || controls.generate === false
      && (controls.requestKind !== 'prewarm' || controls.turnId !== '' || controls.previousResponseId !== undefined))) throw new Error('workflow_review_native_controls_unsupported');
    return Object.freeze(controls as WorkflowReviewNativeRequestControls);
  } finally { cursor.close(); }
}

/**
 * Walk one bundle's manifest one bounded record at a time, in canonical order. The caller never
 * holds the entry set: each yielded record is a single bounded object and the file is never buffered.
 */
export function* iterateWorkflowReviewManifestEntries(bundle: WorkflowReviewSourceBundle): Generator<WorkflowReviewSourceEntry> {
  for (const record of streamWorkflowReviewManifest(bundle.manifestPath, {}, { entries: false })) {
    yield* retainedReviewRecord(entryFromRecord(record, bundle.entriesDirectory));
  }
}

/** Walk one bundle's append-only index one bounded line at a time, in canonical order. */
export function* iterateWorkflowReviewIndexEntries(bundle: WorkflowReviewSourceBundle): Generator<WorkflowReviewSourceEntry> {
  yield* iterateWorkflowReviewIndexAt(bundle.indexPath, bundle.entriesDirectory);
}
function* iterateWorkflowReviewIndexAt(indexPath: string, entriesDirectory: string): Generator<WorkflowReviewSourceEntry> {
  let pending = '';
  for (const chunk of readWorkflowReviewTextChunks(indexPath)) {
    pending += chunk;
    for (;;) {
      const index = pending.indexOf('\n');
      if (index < 0) break;
      const line = pending.slice(0, index); pending = pending.slice(index + 1);
      if (line.trim()) {
        let parsed: unknown;
        try { parsed = JSON.parse(line); } catch { throw new Error('workflow_review_source_corrupt'); }
        yield* retainedReviewRecord(entryFromRecord(entryRecordFromUnknown(parsed), entriesDirectory));
      }
    }
    if (pending.length > REVIEW_STRUCTURE_RECORD_LIMIT) throw new Error('workflow_review_source_corrupt');
  }
  if (pending.trim()) {
    let parsed: unknown;
    try { parsed = JSON.parse(pending); } catch { throw new Error('workflow_review_source_corrupt'); }
    yield* retainedReviewRecord(entryFromRecord(entryRecordFromUnknown(parsed), entriesDirectory));
  }
}

/**
 * Compare the index and the manifest in lockstep, one bounded record from each at a time. A dropped,
 * reordered, duplicated or rewritten index line is corruption: the two streams must tile exactly.
 */
function verifyWorkflowReviewIndexLockstep(bundle: Pick<WorkflowReviewSourceBundle, 'manifestPath' | 'indexPath' | 'entriesDirectory'>): void {
  const index = iterateWorkflowReviewIndexAt(bundle.indexPath, bundle.entriesDirectory);
  const manifest = streamWorkflowReviewManifest(bundle.manifestPath, {}, { entries: false });
  try {
    for (const record of manifest) {
      const indexed = index.next();
      if (indexed.done) throw new Error('workflow_review_source_corrupt');
      const entry = entryFromRecord(record, bundle.entriesDirectory);
      const record2 = indexed.value;
      if (record2.id !== entry.id || record2.kind !== entry.kind || record2.path !== entry.path
        || record2.bytes !== entry.bytes || record2.sha256 !== entry.sha256) throw new Error('workflow_review_source_corrupt');
    }
    if (!index.next().done) throw new Error('workflow_review_source_corrupt');
  } finally {
    // Both walks hold open file streams; a mismatch throws out of the loop and must not leak them.
    try { manifest.return?.(undefined as never); } catch { /* the stream is being discarded */ }
    try { index.return?.(undefined as never); } catch { /* the stream is being discarded */ }
  }
}

/** Read and validate exactly one bounded entry record from disk. */
function readWorkflowReviewRecord(recordPath: string): WorkflowReviewSourceRecord {
  reviewResources.recordLookups++;
  const stat = lstatSync(recordPath, { throwIfNoEntry: false });
  if (!stat || !stat.isFile() || stat.size > REVIEW_STRUCTURE_RECORD_LIMIT) throw new Error('workflow_review_source_corrupt');
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(recordPath, 'utf8')); } catch { throw new Error('workflow_review_source_corrupt'); }
  return entryRecordFromUnknown(parsed);
}

function materialId(kind: WorkflowReviewMaterialKind, index: number): string {
  if (kind === 'instruction') return `instr-${index}`;
  if (kind === 'source') return `src-${index}`;
  return kind;
}

/** The canonical manifest, emitted as ordered fragments while the append-only index is re-walked. */
function* manifestFragments(input: { repository: string; baseCommit: string; head: string }, indexPath: string,
  entriesDirectory: string, totalBytes: number): Generator<string> {
  yield `{"schemaVersion":${WORKFLOW_REVIEW_BUNDLE_SCHEMA_VERSION},"repository":${JSON.stringify(input.repository)}`
    + `,"baseCommit":${JSON.stringify(input.baseCommit)},"head":${JSON.stringify(input.head)},"totalBytes":${totalBytes},"entries":[`;
  let first = true;
  for (const entry of iterateWorkflowReviewIndexAt(indexPath, entriesDirectory)) {
    yield `${first ? '' : ','}${JSON.stringify({ id: entry.id, kind: entry.kind, path: entry.path,
      bytes: entry.bytes, sha256: entry.sha256 })}`;
    first = false;
  }
  yield ']}';
}

/**
 * Freeze one complete logical-source bundle onto disk. There is no aggregate byte,
 * file, page or read ceiling: the bundle holds every supplied byte exactly, any
 * material above a buffer is streamed in and re-delivered on later pages, and every
 * required material kind must be present or the freeze itself fails. Each entry's
 * bounded metadata record is written to its own record file and appended to the
 * append-only index as it is streamed in, so no entry set is ever collected; the
 * canonical manifest is generated by re-walking that index, never a frozen array.
 */
export function buildWorkflowReviewSourceBundle(input: WorkflowReviewSourceBundleInput): WorkflowReviewSourceBundle {
  if (!input || typeof input !== 'object') throw new Error('workflow_review_source_invalid_bundle');
  if (typeof input.repository !== 'string' || !input.repository.trim() || input.repository.length > MEMBER_PATH_LIMIT
    || input.repository.includes('\0') || typeof input.directory !== 'string' || !input.directory
    || input.materials === undefined || input.materials === null) {
    throw new Error('workflow_review_source_invalid_bundle');
  }
  const directory = input.directory;
  if (existsSync(directory)) throw new Error('workflow_review_source_bundle_exists');
  const entriesDirectory = join(directory, WORKFLOW_REVIEW_ENTRIES_DIRECTORY);
  const recordsDirectory = join(directory, WORKFLOW_REVIEW_RECORDS_DIRECTORY);
  const indexPath = join(directory, WORKFLOW_REVIEW_INDEX_FILE);
  const counters = new Map<WorkflowReviewMaterialKind, number>();
  const present = new Set<WorkflowReviewMaterialKind>();
  // Uniqueness is proven on disk, one exclusive-create key file per distinct member, exactly as the
  // governed instruction walk proves it: the key set is never retained in heap, and the check does not
  // assume the stream arrives sorted, so a member offered twice is refused wherever it appears — a
  // non-adjacent repeat and a repeat that arrives before the stream is ordered are both refusals.
  const keys = mkdtempSync(join(tmpdir(), 'omc-review-source-bundle-keys-'));
  let entryCount = 0;
  let totalBytes = 0;
  let indexDescriptor: number | undefined;
  // Ownership of the destination is the destination directory itself, and it is taken the instant that
  // directory exists — before the index is opened, and long before any material is written. `mkdir`
  // without `recursive` is the exclusive claim: it fails on a path that already exists, so exactly one
  // build ever holds one destination and no ancestor directory this invocation did not name is created
  // as a side effect. A build that loses that race refuses with the duplicate-destination error and
  // removes nothing — neither the winner's in-progress bundle nor any directory it did not create.
  let owned = false;
  try {
    try { mkdirSync(directory, { mode: 0o700 }); }
    catch (error) {
      // The destination was claimed between the existence check and this exclusive create.
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('workflow_review_source_bundle_exists');
      throw error;
    }
    owned = true;
    try { indexDescriptor = openSync(indexPath, 'wx', 0o600); }
    catch (error) {
      // Another build claimed this destination between the existence check and this exclusive create,
      // so this invocation owns nothing here and reports the same duplicate-destination diagnostic the
      // check itself would have raised.
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('workflow_review_source_bundle_exists');
      throw error;
    }
    mkdirSync(entriesDirectory);
    mkdirSync(recordsDirectory);
    for (const material of input.materials as Iterable<WorkflowReviewMaterialInput>) {
        const path = assertWorkflowReviewSourcePath(material.path);
        if (SINGLETON_KINDS.includes(material.kind)) {
          // A singleton's path is a fixed label for a controller-composed material, not a repository
          // file, so it is keyed by kind alone and refused the second time it is seen, at any position.
          if (present.has(material.kind)) throw new Error('workflow_review_source_duplicate_path');
        } else {
          const memberKey = `${material.kind}\0${path}`;
          const keyPath = join(keys, createHash('sha256').update(memberKey, 'utf8').digest('hex'));
          try {
            // The member itself, not an empty marker, is what the key file stores: the digest names the
            // key, and the stored bytes are what a repeat is compared against.
            writeFileSync(keyPath, memberKey, { flag: 'wx' });
          } catch (error) {
            // Only an existing key is a duplicate member; any other failure is a real IO failure and is
            // propagated as itself rather than being reported as a duplicate authorized path.
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            // A key file named by a digest is read back before the repeat is reported: a digest that
            // named two different members would otherwise refuse a member that was never offered twice,
            // which is a different failure from a genuine duplicate and must not be reported as one.
            if (readFileSync(keyPath, 'utf8') !== memberKey) throw new Error('workflow_review_source_key_collision');
            throw new Error('workflow_review_source_duplicate_path');
          }
        }
        const index = counters.get(material.kind) ?? 0;
        counters.set(material.kind, index + 1);
        const id = materialId(material.kind, index);
        const sources = [material.file === undefined ? undefined : 'file',
          material.content === undefined ? undefined : 'content',
          material.chunks === undefined ? undefined : 'chunks'].filter(source => source !== undefined);
        if (sources.length !== 1) throw new Error('workflow_review_source_invalid_content');
        const file = join(entriesDirectory, id);
        const hashed = writeWorkflowReviewArtifact({ path: file, chunks: material.file === undefined
          ? material.content === undefined ? (material.chunks as Iterable<Buffer | string>) : [material.content]
          : readWorkflowReviewFileChunks(material.file) });
        const record: WorkflowReviewSourceRecord = Object.freeze({ id, kind: material.kind, path, sha256: hashed.sha256, bytes: hashed.bytes });
        writeWorkflowReviewArtifact({ path: join(recordsDirectory, id), chunks: [JSON.stringify(record)] });
        const line = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8');
        let written = 0;
        while (written < line.length) written += writeSync(indexDescriptor, line, written, line.length - written, null);
        present.add(material.kind);
        entryCount++;
        totalBytes += hashed.bytes;
    }
    closeSync(indexDescriptor); indexDescriptor = undefined;
    // An empty supplier is an invalid bundle rather than an incomplete one: nothing was offered at
    // all, so there is no partial material set to report. This is checked after the stream is
    // consumed, so a lazy supplier is still walked exactly once and never collected.
    if (entryCount === 0) throw new Error('workflow_review_source_invalid_bundle');
    for (const kind of WORKFLOW_REVIEW_REQUIRED_MATERIAL_KINDS) {
      if (!present.has(kind)) throw new Error('workflow_review_source_incomplete_material');
    }
    const manifestPath = join(directory, WORKFLOW_REVIEW_MANIFEST_FILE);
    const manifest = writeWorkflowReviewArtifact({ path: manifestPath,
      chunks: manifestFragments(input, indexPath, entriesDirectory, totalBytes) });
    const indexHash = hashWorkflowReviewArtifact(indexPath);
    return Object.freeze({ schemaVersion: WORKFLOW_REVIEW_BUNDLE_SCHEMA_VERSION, repositoryIdentity: input.repository,
      baseCommit: input.baseCommit, head: input.head, directory, manifestPath, indexPath, entriesDirectory, recordsDirectory,
      manifestBytes: manifest.bytes, digest: manifest.sha256, indexBytes: indexHash.bytes, indexDigest: indexHash.sha256,
      entryCount, totalBytes });
  } catch (error) {
    // One cleanup boundary for the whole build, and only for a build that owns the destination: a
    // failure anywhere after the destination was claimed — opening the index, streaming materials in,
    // a missing required kind, or writing the manifest — removes the partial directory this invocation
    // created, so a half-written bundle is never left behind for a later open to find. A build that
    // never claimed the destination created no part of it and removes nothing at all, and because the
    // claim is the directory creation itself there is no window in which a directory this invocation
    // created exists without being owned.
    //
    // Every descriptor this invocation acquired is released before the directory that holds it is
    // removed. The removal is the only repair a failed build performs, so it has to happen on top of a
    // closed handle: a directory whose index is still open cannot be deleted on every platform, and a
    // removal that raced an open descriptor would leave the failure half-repaired and could replace the
    // original error with the removal's own.
    if (indexDescriptor !== undefined) { try { closeSync(indexDescriptor); } catch { /* already released */ } indexDescriptor = undefined; }
    // The removal is itself best effort: this build is already unwinding an error that names the real
    // defect, and a deletion that fails must not replace it with a filesystem error of its own.
    if (owned) { try { rmSync(directory, { recursive: true, force: true }); } catch { /* the original failure stands */ } }
    throw error;
  } finally {
    // The index descriptor and the private key index are released on every exit path, including one
    // that fails before the material stream is reached at all. This is the second chance for the
    // success path, not the first for the failure path, which already released the descriptor above.
    if (indexDescriptor !== undefined) { try { closeSync(indexDescriptor); } catch { /* already released */ } }
    try { rmSync(keys, { recursive: true, force: true }); } catch { /* the private key index is scratch */ }
  }
}

/**
 * Reopen one on-disk bundle from its present bytes. The canonical manifest and the index are walked
 * incrementally, one bounded scalar or record at a time, every entry file is re-hashed and every
 * bounded record file is checked against its manifest entry through a bounded streaming buffer, so
 * reopening is bounded IO rather than a whole-file buffer and an entry edited or truncated after the
 * freeze is corruption rather than a silently shorter read.
 */
export function openWorkflowReviewSourceBundle(directory: string): WorkflowReviewSourceBundle {
  if (typeof directory !== 'string' || !directory || !existsSync(join(directory, WORKFLOW_REVIEW_MANIFEST_FILE))) {
    throw new Error('workflow_review_source_corrupt');
  }
  const manifestPath = join(directory, WORKFLOW_REVIEW_MANIFEST_FILE);
  const indexPath = join(directory, WORKFLOW_REVIEW_INDEX_FILE);
  const entriesDirectory = join(directory, WORKFLOW_REVIEW_ENTRIES_DIRECTORY);
  const recordsDirectory = join(directory, WORKFLOW_REVIEW_RECORDS_DIRECTORY);
  const header: Record<string, unknown> = {};
  const seen = { entries: false };
  let entryCount = 0;
  let totalBytes = 0;
  const ledger = new WorkflowReviewIdLedger();
  try {
    for (const record of streamWorkflowReviewManifest(manifestPath, header, seen)) {
      ledger.accept(record.id);
      const entry = entryFromRecord(record, entriesDirectory);
      const hashed = hashWorkflowReviewArtifact(entry.file);
      if (hashed.sha256 !== entry.sha256 || hashed.bytes !== entry.bytes) throw new Error('workflow_review_source_corrupt');
      const persisted = readWorkflowReviewRecord(join(recordsDirectory, record.id));
      if (persisted.kind !== record.kind || persisted.path !== record.path
        || persisted.sha256 !== record.sha256 || persisted.bytes !== record.bytes) {
        throw new Error('workflow_review_source_corrupt');
      }
      entryCount++;
      totalBytes += entry.bytes;
    }
  } catch { throw new Error('workflow_review_source_corrupt'); }
  if (header.schemaVersion !== WORKFLOW_REVIEW_BUNDLE_SCHEMA_VERSION || typeof header.repository !== 'string'
    || typeof header.baseCommit !== 'string' || typeof header.head !== 'string') throw new Error('workflow_review_source_corrupt');
  if (header.totalBytes !== totalBytes) throw new Error('workflow_review_source_corrupt');
  verifyWorkflowReviewIndexLockstep({ manifestPath, indexPath, entriesDirectory });
  const manifestHash = hashWorkflowReviewArtifact(manifestPath);
  const indexHash = hashWorkflowReviewArtifact(indexPath);
  return Object.freeze({ schemaVersion: WORKFLOW_REVIEW_BUNDLE_SCHEMA_VERSION, repositoryIdentity: header.repository as string,
    baseCommit: header.baseCommit as string, head: header.head as string, directory, manifestPath, indexPath, entriesDirectory,
    recordsDirectory, manifestBytes: manifestHash.bytes, digest: manifestHash.sha256, indexBytes: indexHash.bytes,
    indexDigest: indexHash.sha256, entryCount, totalBytes });
}

/**
 * Re-derive the whole bundle from its present on-disk bytes: every entry file's full content hash,
 * every bounded record file and the canonical manifest and index digests are recomputed and compared
 * against the frozen values, so an object edited, truncated or swapped after the freeze — including an
 * edit that keeps its size — is corruption rather than a silently shorter or altered read. Every
 * check streams through one bounded buffer; no entry, manifest or bundle is ever held whole.
 */
export function verifyWorkflowReviewSourceBundle(bundle: WorkflowReviewSourceBundle): void {
  reviewResources.fullVerifications++;
  if (!bundle || bundle.schemaVersion !== WORKFLOW_REVIEW_BUNDLE_SCHEMA_VERSION || !Number.isSafeInteger(bundle.entryCount)
    || bundle.entryCount < 0) throw new Error('workflow_review_source_corrupt');
  let entryCount = 0;
  let totalBytes = 0;
  const ledger = new WorkflowReviewIdLedger();
  for (const entry of iterateWorkflowReviewManifestEntries(bundle)) {
    ledger.accept(entry.id);
    const stat = lstatSync(entry.file, { throwIfNoEntry: false });
    if (!stat || !stat.isFile() || stat.size !== entry.bytes) throw new Error('workflow_review_source_corrupt');
    if (hashWorkflowReviewArtifact(entry.file).sha256 !== entry.sha256) throw new Error('workflow_review_source_corrupt');
    const persisted = readWorkflowReviewRecord(join(bundle.recordsDirectory, entry.id));
    if (persisted.kind !== entry.kind || persisted.path !== entry.path
      || persisted.sha256 !== entry.sha256 || persisted.bytes !== entry.bytes) throw new Error('workflow_review_source_corrupt');
    entryCount++;
    totalBytes += entry.bytes;
  }
  if (entryCount !== bundle.entryCount || totalBytes !== bundle.totalBytes) throw new Error('workflow_review_source_corrupt');
  verifyWorkflowReviewIndexLockstep(bundle);
  if (hashWorkflowReviewArtifact(bundle.indexPath).sha256 !== bundle.indexDigest) throw new Error('workflow_review_source_corrupt');
  if (hashWorkflowReviewArtifact(bundle.manifestPath).sha256 !== bundle.digest) throw new Error('workflow_review_source_corrupt');
}

/** Refuse a bundle whose frozen repository identity, base or head is not the reviewed one. */
export function assertWorkflowReviewSourceHead(bundle: WorkflowReviewSourceBundle,
  expected: { repository: string; baseCommit: string; head: string }): void {
  if (bundle.repositoryIdentity !== expected.repository || bundle.baseCommit !== expected.baseCommit || bundle.head !== expected.head) {
    throw new Error('workflow_review_source_stale_head');
  }
}

export interface WorkflowReviewSourceReadRequest {
  readonly kind: 'manifest' | 'entry';
  readonly id?: string;
  /** Opaque continuation cursor from a previous page; absent starts at offset 0. */
  readonly cursor?: string;
  /**
   * The JSON-RPC identifier of the request this page answers. The page is fitted against the exact
   * frame that identifier produces, so a long or escape-heavy identifier shrinks the page instead of
   * being refused for exceeding a fixed width. Absent means the caller knows no request — the page is
   * then fitted against the conservative reserved identifier.
   */
  readonly requestId?: unknown;
  /** Trusted controller envelope used by a native dynamic tool. Never accepted from reader JSON. */
  readonly responseEnvelope?: (read: WorkflowReviewSourceReadResult) => unknown;
}
export interface WorkflowReviewSourceReadResult {
  readonly bundleSha256: string;
  readonly kind: 'manifest' | 'entry';
  readonly id: string | null;
  readonly path: string | null;
  readonly offset: number;
  readonly bytes: number;
  readonly totalBytes: number;
  readonly complete: boolean;
  readonly encoding: 'utf8' | 'base64';
  readonly content: string;
  /** Digest of the complete addressed object. */
  readonly sha256: string;
  /** Digest of exactly the served byte range; the receipt records this. */
  readonly rangeSha256: string;
  /** Opaque continuation for the next page; null once the object is complete. */
  readonly cursor: string | null;
}

/**
 * The complete JSON-RPC response an MCP client receives for one page: the tool
 * result is nested inside `content[].text`, so the text is string-escaped and the
 * protocol metadata rides alongside it. The adopted bound applies to these bytes,
 * not merely to the inner text, so an escaped, multibyte or binary page cannot
 * creep past the policy through encoding overhead.
 *
 * A page is fitted against the identifier of the request that will carry it, so the
 * bound holds for every identifier the reader is actually asked to answer — whatever
 * characters it contains and however they escape. The identifier below is the
 * conservative reservation used when no request exists yet; it is not a limit on the
 * identifiers the reader serves.
 */
const RESPONSE_ENVELOPE_ID: string = 'i'.repeat(WORKFLOW_REVIEW_RESPONSE_ID_RESERVE_BYTES - 2);
export function workflowReviewResponse(read: WorkflowReviewSourceReadResult): Record<string, unknown> {
  return workflowReviewResponseFor(read, RESPONSE_ENVELOPE_ID);
}
/** The exact response one request carrying `requestId` receives for this page. */
export function workflowReviewResponseFor(read: WorkflowReviewSourceReadResult, requestId: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: requestId === undefined ? null : requestId,
    result: { content: [{ type: 'text', text: JSON.stringify(read) }] } };
}
export function workflowReviewResponseBytes(read: WorkflowReviewSourceReadResult): number {
  return workflowReviewEnvelopeBytes(read, RESPONSE_ENVELOPE_ID);
}
/** The exact wire bytes of one page's frame: identifier, envelope and framing newline included. */
export function workflowReviewEnvelopeBytes(read: WorkflowReviewSourceReadResult, requestId: unknown): number {
  return Buffer.byteLength(JSON.stringify(workflowReviewResponseFor(read, requestId))) + 1;
}

/** Read one bounded range from a material file with a positioned read; never the whole file. */
function readWorkflowReviewRange(file: string, offset: number, length: number): Buffer {
  if (length <= 0) return Buffer.alloc(0);
  const descriptor = openSync(file, 'r');
  const releaseDescriptor = holdReviewResource('descriptors'); const releaseBuffer = holdReviewResource('bufferBytes', length);
  try {
    const buffer = Buffer.allocUnsafe(length);
    let filled = 0;
    while (filled < length) {
      const read = readSync(descriptor, buffer, filled, length - filled, offset + filled);
      reviewResources.positionedReads++;
      if (read <= 0) break;
      filled += read;
    }
    return buffer.subarray(0, filled);
  } finally { try { closeSync(descriptor); } finally { releaseBuffer(); releaseDescriptor(); } }
}

interface WorkflowReviewSourceTarget {
  readonly id: string | null;
  readonly path: string | null;
  readonly file: string;
  readonly bytes: number;
  readonly sha256: string;
}

/**
 * Serve one bounded page. The complete encoded response, including every metadata
 * field, the JSON text escaping and the JSON-RPC envelope, is held at or below the
 * per-response buffer policy; the remaining bytes are reachable only through the
 * continuation cursor, so a large object is delivered completely across pages
 * rather than truncated. An entry is resolved from its own bounded record file, so
 * a single entry is served without ever loading the entry set.
 */
export function readWorkflowReviewSource(bundle: WorkflowReviewSourceBundle,
  request: WorkflowReviewSourceReadRequest): WorkflowReviewSourceReadResult {
  reviewResources.pageRequests++;
  const release = holdReviewResource('records');
  try { return readWorkflowReviewSourcePage(bundle, request); } finally { release(); }
}
export function workflowReviewSourceObjectBytes(bundle: WorkflowReviewSourceBundle, kind: unknown, id: unknown): number {
  if (kind === 'manifest' && id === null) return bundle.manifestBytes;
  if (kind !== 'entry' || typeof id !== 'string' || !ID_PATTERN.test(id)) throw new Error('workflow_review_source_invalid_id');
  const record = readWorkflowReviewRecord(join(bundle.recordsDirectory, id));
  if (record.id !== id) throw new Error('workflow_review_source_unknown_id');
  return record.bytes;
}
function readWorkflowReviewSourcePage(bundle: WorkflowReviewSourceBundle,
  request: WorkflowReviewSourceReadRequest): WorkflowReviewSourceReadResult {
  if (!request || (request.kind !== 'manifest' && request.kind !== 'entry')) throw new Error('workflow_review_source_invalid_request');
  const target: WorkflowReviewSourceTarget = request.kind === 'manifest'
    ? { id: null, path: null, file: bundle.manifestPath, bytes: bundle.manifestBytes, sha256: bundle.digest }
    : (() => {
        const id = request.id;
        if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw new Error('workflow_review_source_invalid_id');
        const recordPath = join(bundle.recordsDirectory, id);
        if (!existsSync(recordPath)) throw new Error('workflow_review_source_unknown_id');
        const record = readWorkflowReviewRecord(recordPath);
        if (record.id !== id) throw new Error('workflow_review_source_unknown_id');
        const file = join(bundle.entriesDirectory, id);
        const stat = lstatSync(file, { throwIfNoEntry: false });
        if (!stat || !stat.isFile() || stat.size !== record.bytes) throw new Error('workflow_review_source_corrupt');
        return { id: record.id, path: record.path, file, bytes: record.bytes, sha256: record.sha256 };
      })();
  const offset = resolveWorkflowReviewCursor(bundle, request.kind, target.id, request.cursor, target.bytes);
  // Read at most one response policy's worth of bytes at this offset: the page cost is
  // proportional to the page, never to the size of the object it came from.
  const available = Math.min(WORKFLOW_REVIEW_READ_LIMIT_BYTES, Math.max(0, target.bytes - offset));
  const raw = readWorkflowReviewRange(target.file, offset, available);
  // The page is fitted against the frame the *requesting* invocation will actually receive, so the
  // response bound is a property of the delivered frame rather than of an assumed identifier width.
  return Object.freeze(fitWorkflowReviewSlice(raw, offset, target, bundle.digest, request.kind,
    'requestId' in request ? request.requestId : undefined, request.responseEnvelope));
}

/**
 * An opaque continuation cursor bound to this exact bundle, object kind and id.
 * A cursor that names another bundle, another kind or another id is a forged or
 * cross-bundle cursor and is refused instead of silently resolving an offset.
 */
function encodeWorkflowReviewCursor(bundleSha256: string, kind: string, id: string | null, offset: number): string {
  return Buffer.from(JSON.stringify({ v: CURSOR_VERSION, b: bundleSha256.slice(0, 32), k: kind, i: id, o: offset }), 'utf8').toString('base64url');
}
function resolveWorkflowReviewCursor(bundle: WorkflowReviewSourceBundle, kind: string, id: string | null,
  cursor: string | undefined, total: number): number {
  if (cursor === undefined || cursor === '') return 0;
  if (typeof cursor !== 'string' || cursor.length > 512 || cursor.includes('\0') || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
    throw new Error('workflow_review_source_invalid_cursor');
  }
  let decoded: { v?: unknown; b?: unknown; k?: unknown; i?: unknown; o?: unknown };
  try { decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); }
  catch { throw new Error('workflow_review_source_invalid_cursor'); }
  if (!decoded || typeof decoded !== 'object' || decoded.v !== CURSOR_VERSION
    || decoded.b !== bundle.digest.slice(0, 32) || decoded.k !== kind || decoded.i !== id
    || !Number.isSafeInteger(decoded.o) || (decoded.o as number) < 0 || (decoded.o as number) > total) {
    throw new Error('workflow_review_source_invalid_cursor');
  }
  return decoded.o as number;
}

/**
 * Clamp one slice to a codepoint boundary, falling back to base64 for non-UTF-8 bytes. A slice that
 * would begin inside a multi-byte sequence, or that is entirely continuation bytes, cannot be served
 * as text at all: it is served base64 so the page still advances by at least one byte.
 */
function encodeSlice(bytes: Buffer, limit: number):
  { content: string; encoding: 'utf8' | 'base64'; served: Buffer } {
  const end = Math.min(bytes.length, limit);
  if (end <= 0) return { content: '', encoding: 'utf8', served: Buffer.alloc(0) };
  let utf8End = end;
  while (utf8End > 0 && utf8End < bytes.length && isContinuation(bytes[utf8End]!)) utf8End--;
  if (utf8End > 0) {
    const raw = bytes.subarray(0, utf8End);
    const text = raw.toString('utf8');
    if (Buffer.from(text, 'utf8').equals(raw)) return { content: text, encoding: 'utf8', served: raw };
  }
  // Non-UTF-8 material is served base64 so every byte survives the JSON round trip. The slice is
  // floored at one byte: a lone continuation byte in the final 1-3 bytes of an object must still
  // advance the offset, or that tail could never be delivered through any cursor.
  const slice = bytes.subarray(0, Math.max(1, Math.min(end, Math.floor((limit * 3) / 4))));
  return { content: slice.toString('base64'), encoding: 'base64', served: slice };
}

/**
 * Choose the largest slice whose complete encoded MCP response stays inside the
 * per-response buffer policy. The measured candidate is the real response object,
 * so the bound holds for text, base64 and JSON-escaped content alike.
 *
 * `requestId` is the identifier of the request being answered. The page is measured against the
 * *wider* of the reserved identifier width and the one this request actually carries. Measuring the
 * reservation whenever the real identifier is shorter keeps pages uniform: two clients paging the
 * same object with identifiers of different lengths are served the same page boundaries, and a reply
 * never depends on a client happening to use a short identifier. Measuring a longer real identifier
 * instead of refusing it is what makes the policy universal without capping identifiers at all: a
 * long or escape-heavy identifier simply leaves less room for material, and only one so large that
 * not a single byte of material fits is genuinely unrepresentable and refuses.
 */
function fitWorkflowReviewSlice(raw: Buffer, offset: number, target: WorkflowReviewSourceTarget,
  bundleSha256: string, kind: 'manifest' | 'entry', requestId?: unknown,
  responseEnvelope?: (read: WorkflowReviewSourceReadResult) => unknown): WorkflowReviewSourceReadResult {
  const measuredId: unknown = workflowReviewResponseIdBytes(requestId) > WORKFLOW_REVIEW_RESPONSE_ID_RESERVE_BYTES
    ? requestId : RESPONSE_ENVELOPE_ID;
  const envelope = (read: WorkflowReviewSourceReadResult): number =>
    responseEnvelope ? Buffer.byteLength(JSON.stringify(responseEnvelope(read))) + 1 : workflowReviewEnvelopeBytes(read, measuredId);
  const assemble = (limit: number): WorkflowReviewSourceReadResult => {
    const slice = encodeSlice(raw, limit);
    const complete = offset + slice.served.length >= target.bytes;
    return { bundleSha256, kind, id: target.id, path: target.path, offset, bytes: slice.served.length,
      totalBytes: target.bytes, complete, encoding: slice.encoding, content: slice.content, sha256: target.sha256,
      rangeSha256: digest(slice.served), cursor: complete ? null : encodeWorkflowReviewCursor(bundleSha256, kind, target.id, offset + slice.served.length) };
  };
  let low = 0; let high = raw.length; let best: WorkflowReviewSourceReadResult | undefined;
  // A material that is legitimately empty (an empty shared context, an empty authorized file) has
  // no range to serve: it is complete at offset 0 and needs no page and no receipt to be covered.
  if (target.bytes === 0) return assemble(0);
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = assemble(middle);
    if (candidate.bytes > 0 && envelope(candidate) <= WORKFLOW_REVIEW_READ_LIMIT_BYTES) {
      best = candidate; low = middle + 1;
    } else high = middle - 1;
  }
  if (best) return best;
  // Near a switch between the UTF-8 and base64 encodings the encoded size is not monotone in the
  // search bound, so the binary search above can settle on an empty slice. A single byte always
  // fits — its escaped form cannot approach the policy — so the offset still advances strictly.
  const single = assemble(1);
  if (single.bytes > 0 && envelope(single) <= WORKFLOW_REVIEW_READ_LIMIT_BYTES) return single;
  throw new Error('workflow_review_source_response_unbounded');
}

/**
 * One delivered range. Beyond its identity and range digest it carries the exact *returned* bytes —
 * the decoded page content the client actually received — so complete coverage can be reconstructed
 * from the transport rather than re-read from the source disk. An empty material has no bytes to
 * carry, but its one terminal page is still a receipt: it is what proves the empty object was
 * delivered, and it is the only record whose absence would otherwise be invisible.
 */
export interface WorkflowReviewSourceReceipt {
  readonly bundleSha256: string;
  readonly kind: 'manifest' | 'entry';
  readonly id: string | null;
  readonly offset: number;
  readonly bytes: number;
  readonly rangeSha256: string;
  readonly encoding: 'utf8' | 'base64';
  readonly content: string;
}
/** Build one receipt from a served page, including the zero-byte terminal page of an empty material. */
export function workflowReviewSourceReceipt(read: WorkflowReviewSourceReadResult): WorkflowReviewSourceReceipt {
  return { bundleSha256: read.bundleSha256, kind: read.kind, id: read.id, offset: read.offset, bytes: read.bytes,
    rangeSha256: read.rangeSha256, encoding: read.encoding, content: read.content };
}
export interface WorkflowReviewCoverageAttestation {
  readonly bundleSha256: string;
  readonly reviewerId: string;
  readonly complete: true;
  readonly entries: number;
  readonly ranges: number;
}

function attestationObject(value: unknown): WorkflowReviewCoverageAttestation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('workflow_review_coverage_attestation_invalid');
  const raw = value as Record<string, unknown>;
  const keys = Object.keys(raw);
  if (keys.some(key => !['bundleSha256', 'reviewerId', 'complete', 'entries', 'ranges'].includes(key))
    || !/^[a-f0-9]{64}$/.test(String(raw.bundleSha256)) || typeof raw.reviewerId !== 'string' || !raw.reviewerId.trim()
    || raw.reviewerId.length > 200 || raw.reviewerId.includes('\0') || raw.complete !== true
    || !Number.isSafeInteger(raw.entries) || (raw.entries as number) < 0
    || !Number.isSafeInteger(raw.ranges) || (raw.ranges as number) < 0) {
    throw new Error('workflow_review_coverage_attestation_invalid');
  }
  return Object.freeze({ bundleSha256: raw.bundleSha256 as string, reviewerId: raw.reviewerId,
    complete: true, entries: raw.entries as number, ranges: raw.ranges as number });
}

function receiptRecord(receipt: unknown, bundle: WorkflowReviewSourceBundle): WorkflowReviewSourceReceipt {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) throw new Error('workflow_review_source_invalid_receipt');
  const value = receipt as Record<string, unknown>;
  const manifest = value.kind === 'manifest';
  if (value.bundleSha256 !== bundle.digest || (value.kind !== 'manifest' && value.kind !== 'entry')
    || (manifest ? value.id !== null : !ID_PATTERN.test(String(value.id)))
    || !Number.isSafeInteger(value.offset) || (value.offset as number) < 0
    || !Number.isSafeInteger(value.bytes) || (value.bytes as number) < 0
    // A rangeless delivery is only ever the terminal page of an empty object at its own start: a
    // zero-byte receipt at any other offset names material that could never have been served there.
    || (value.bytes === 0 && value.offset !== 0)
    || !/^[a-f0-9]{64}$/.test(String(value.rangeSha256))
    || (value.encoding !== 'utf8' && value.encoding !== 'base64') || typeof value.content !== 'string') {
    throw new Error('workflow_review_source_invalid_receipt');
  }
  return Object.freeze({ bundleSha256: value.bundleSha256 as string, kind: value.kind as 'manifest' | 'entry',
    id: (value.id as string | null) ?? null, offset: value.offset as number, bytes: value.bytes as number,
    rangeSha256: value.rangeSha256 as string, encoding: value.encoding as 'utf8' | 'base64', content: value.content });
}

/** Decode exactly one receipt's returned bytes and bind them to its declared length and range digest. */
function receiptBytes(record: WorkflowReviewSourceReceipt): Buffer {
  let bytes: Buffer;
  try { bytes = record.encoding === 'base64' ? Buffer.from(record.content, 'base64') : Buffer.from(record.content, 'utf8'); }
  catch { throw new Error('workflow_review_source_corrupt'); }
  if (bytes.length !== record.bytes || digest(bytes) !== record.rangeSha256) throw new Error('workflow_review_source_corrupt');
  return bytes;
}

/** A contained file reference. Paths are relative to the controller-owned evidence directory. */
export interface WorkflowReviewOwnedReference { readonly name: string; readonly bytes: number; readonly sha256: string }

function ownedReviewPath(root: string, name: string): string {
  const path = resolve(root, name);
  if (!name || isAbsolute(name) || relative(root, path).startsWith('..') || path === resolve(root)) {
    throw new Error('workflow_review_evidence_escape');
  }
  let ancestor = dirname(path);
  for (;;) {
    const stat = lstatSync(ancestor);
    if (stat.isSymbolicLink() || !stat.isDirectory() || realpathSync(ancestor) !== resolve(ancestor)) {
      throw new Error('workflow_review_evidence_custody');
    }
    if (ancestor === resolve(root)) break;
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new Error('workflow_review_evidence_escape');
    ancestor = parent;
  }
  return path;
}
function sameOwnedReviewFile(left: Stats, right: Stats): boolean {
  return left.isFile() && right.isFile() && left.nlink === 1 && right.nlink === 1
    && left.dev === right.dev && left.ino === right.ino;
}
function checkOwnedReviewFile(root: string, name: string, path: string, descriptor: number, initial: Stats, expected: Stats): Stats {
  if (ownedReviewPath(root, name) !== path) throw new Error('workflow_review_evidence_custody');
  const current = fstatSync(descriptor); const named = lstatSync(path);
  if (named.isSymbolicLink() || !sameOwnedReviewFile(initial, current) || !sameOwnedReviewFile(current, named)
    || current.size !== named.size || current.mtimeMs !== named.mtimeMs || current.ctimeMs !== named.ctimeMs
    || current.size !== expected.size || current.mtimeMs !== expected.mtimeMs
    || current.ctimeMs !== expected.ctimeMs) throw new Error('workflow_review_evidence_custody');
  return current;
}
/** Opened-handle custody for original frames, correlation and reconstructed proof. */
export class WorkflowReviewOwnedFile {
  private readonly descriptor: number;
  private readonly initial: Stats;
  private expected: Stats;
  private readonly path: string;
  private closed = false;
  private releaseDescriptor: () => void = () => {};
  #snapshotDescriptor: number | undefined;
  #snapshotIdentity: Stats | undefined;
  #snapshotSize = 0;
  #originalHash = createHash('sha256');
  private releaseSnapshot: () => void = () => {};
  private previousRange: { offset: number; bytes: number } | undefined;
  constructor(private readonly root: string, readonly name: string, private readonly create: boolean | 'append' = false) {
    this.path = ownedReviewPath(root, name);
    const before = create === true ? undefined : lstatSync(this.path);
    if (before && (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1)) throw new Error('workflow_review_evidence_custody');
    this.descriptor = openSync(this.path, (create === true ? constants.O_CREAT | constants.O_EXCL | constants.O_RDWR
      : create === 'append' ? constants.O_RDWR : constants.O_RDONLY)
      | (constants.O_NOFOLLOW ?? 0), 0o600);
    this.releaseDescriptor = holdReviewResource('descriptors');
    try {
      this.initial = fstatSync(this.descriptor);
      this.expected = this.initial;
      if (before && !sameOwnedReviewFile(before, this.initial)) throw new Error('workflow_review_evidence_custody');
      this.check();
      const buffer = Buffer.allocUnsafe(Math.max(1, Math.min(this.initial.size, WORKFLOW_REVIEW_BUFFER_LIMIT_BYTES)));
      const release = holdReviewResource('bufferBytes', buffer.length);
      try {
        for (let offset = 0; offset < this.initial.size;) {
          const bytes = Math.min(buffer.length, this.initial.size - offset);
          this.readExact(this.descriptor, buffer, bytes, offset);
          this.#originalHash.update(buffer.subarray(0, bytes)); offset += bytes;
        }
      } finally { release(); }
      this.check();
    } catch (error) {
      try { this.close(); } catch { /* preserve the first constructor failure */ }
      throw error;
    }
  }
  /** Seal-only callers need the original digest; reads/writes additionally need private range bytes. */
  private ensureSnapshot(): void {
    if (this.#snapshotDescriptor !== undefined) return;
    const before = this.check();
    let snapshotDirectory: string | undefined; let snapshotPath: string | undefined;
    try {
      snapshotDirectory = mkdtempSync(join(realpathSync(tmpdir()), 'omc-review-custody-'));
      snapshotPath = join(snapshotDirectory, 'original');
      this.#snapshotDescriptor = openSync(snapshotPath, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0), 0o600);
      this.releaseSnapshot = holdReviewResource('descriptors');
      this.#snapshotIdentity = fstatSync(this.#snapshotDescriptor);
      if (!sameOwnedReviewFile(this.#snapshotIdentity, lstatSync(snapshotPath))) throw new Error('workflow_review_evidence_custody');
      unlinkSync(snapshotPath); snapshotPath = undefined;
      this.checkSnapshot();
      rmdirSync(snapshotDirectory); snapshotDirectory = undefined;
      const hash = createHash('sha256');
      const buffer = Buffer.allocUnsafe(Math.max(1, Math.min(before.size, WORKFLOW_REVIEW_BUFFER_LIMIT_BYTES)));
      const release = holdReviewResource('bufferBytes', buffer.length);
      try {
        for (let offset = 0; offset < before.size;) {
          const bytes = Math.min(buffer.length, before.size - offset);
          this.readExact(this.descriptor, buffer, bytes, offset);
          const chunk = buffer.subarray(0, bytes);
          this.writeSnapshot(chunk, offset); hash.update(chunk); offset += bytes;
        }
      } finally { release(); }
      this.check(); this.checkSnapshot();
      if (hash.digest('hex') !== this.#originalHash.copy().digest('hex')) throw new Error('workflow_review_evidence_custody');
    } catch (error) {
      try { this.close(); } catch { /* preserve the first constructor failure */ }
      if (snapshotPath && this.#snapshotIdentity) {
        try { if (sameOwnedReviewFile(this.#snapshotIdentity, lstatSync(snapshotPath))) unlinkSync(snapshotPath); } catch { /* only remove the claimed file */ }
      }
      if (snapshotDirectory) try { rmdirSync(snapshotDirectory); } catch { /* never recursively remove an unverified directory */ }
      throw error;
    }
  }
  private check(): Stats {
    if (this.closed) throw new Error('workflow_review_evidence_custody');
    return checkOwnedReviewFile(this.root, this.name, this.path, this.descriptor, this.initial, this.expected);
  }
  private checkSnapshot(): void {
    if (this.closed || this.#snapshotDescriptor === undefined || !this.#snapshotIdentity) throw new Error('workflow_review_evidence_custody');
    const current = fstatSync(this.#snapshotDescriptor);
    if (!current.isFile() || current.nlink !== 0 || current.dev !== this.#snapshotIdentity.dev
      || current.ino !== this.#snapshotIdentity.ino || current.size !== this.#snapshotSize) throw new Error('workflow_review_evidence_custody');
  }
  private readExact(descriptor: number, buffer: Buffer, bytes: number, offset: number): void {
    for (let filled = 0; filled < bytes;) {
      const count = readSync(descriptor, buffer, filled, bytes - filled, offset + filled);
      if (!count) throw new Error('workflow_review_evidence_custody');
      filled += count;
    }
  }
  private writeSnapshot(bytes: Buffer, offset: number): void {
    for (let written = 0; written < bytes.length;) {
      const count = writeSync(this.#snapshotDescriptor!, bytes, written, bytes.length - written, offset + written);
      if (!count) throw new Error('workflow_review_evidence_write_failed');
      written += count;
    }
    this.#snapshotSize = offset + bytes.length;
  }
  private compareSnapshot(offset: number, bytes: Buffer): void {
    this.checkSnapshot();
    const original = Buffer.allocUnsafe(bytes.length); const release = holdReviewResource('bufferBytes', original.length);
    try {
      this.readExact(this.#snapshotDescriptor!, original, original.length, offset);
      if (!original.equals(bytes)) throw new Error('workflow_review_evidence_custody');
    } finally { release(); }
  }
  /** Revalidate the last bounded buffer before a consumer resumes yielding its cached records. */
  assertUnchanged(): void {
    this.ensureSnapshot();
    if (this.check().size !== this.#snapshotSize) throw new Error('workflow_review_evidence_custody');
    this.checkSnapshot();
    if (this.previousRange) {
      const { offset, bytes } = this.previousRange; const current = Buffer.allocUnsafe(bytes);
      const release = holdReviewResource('bufferBytes', bytes);
      try { this.readExact(this.descriptor, current, bytes, offset); this.compareSnapshot(offset, current); }
      finally { release(); }
      this.check();
    }
  }
  append(bytes: Buffer): { offset: number; bytes: number; sha256: string } {
    if (!this.create) throw new Error('workflow_review_evidence_readonly');
    if (bytes.length > WORKFLOW_REVIEW_BUFFER_LIMIT_BYTES) throw new Error('workflow_review_evidence_record_unbounded');
    this.assertUnchanged(); const offset = this.check().size;
    const supplied = Buffer.from(bytes); const release = holdReviewResource('bufferBytes', supplied.length);
    try {
    let written = 0;
    while (written < supplied.length) {
      const count = writeSync(this.descriptor, supplied, written, supplied.length - written, offset + written);
      if (!count) throw new Error('workflow_review_evidence_write_failed');
      written += count;
    }
    this.writeSnapshot(supplied, offset);
    this.#originalHash.update(supplied);
    this.expected = fstatSync(this.descriptor);
    if (this.check().size !== offset + supplied.length) throw new Error('workflow_review_evidence_custody');
    this.read(offset, supplied.length);
    return { offset, bytes: supplied.length, sha256: digest(supplied) };
    } finally { release(); }
  }
  read(offset: number, bytes: number): Buffer {
    this.assertUnchanged(); const before = this.check();
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(bytes) || bytes < 0
      || bytes > WORKFLOW_REVIEW_BUFFER_LIMIT_BYTES || offset + bytes > before.size) throw new Error('workflow_review_evidence_corrupt');
    const buffer = Buffer.allocUnsafe(bytes); let filled = 0;
    while (filled < bytes) {
      const count = readSync(this.descriptor, buffer, filled, bytes - filled, offset + filled);
      if (!count) throw new Error('workflow_review_evidence_corrupt');
      filled += count;
    }
    this.compareSnapshot(offset, buffer);
    const after = this.check();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('workflow_review_evidence_custody');
    this.previousRange = { offset, bytes }; return buffer;
  }
  seal(): WorkflowReviewOwnedReference {
    if (this.#snapshotDescriptor !== undefined) this.assertUnchanged();
    const before = this.check(); const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(Math.max(1, Math.min(before.size, WORKFLOW_REVIEW_BUFFER_LIMIT_BYTES)));
    const release = holdReviewResource('bufferBytes', buffer.length);
    try {
    for (let offset = 0; offset < before.size;) {
      const count = readSync(this.descriptor, buffer, 0, Math.min(buffer.length, before.size - offset), offset);
      if (!count) throw new Error('workflow_review_evidence_corrupt');
      if (this.#snapshotDescriptor !== undefined) this.compareSnapshot(offset, buffer.subarray(0, count));
      hash.update(buffer.subarray(0, count)); offset += count;
    }
    const after = this.check();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('workflow_review_evidence_custody');
    const sha256 = hash.digest('hex');
    if (sha256 !== this.#originalHash.copy().digest('hex')) throw new Error('workflow_review_evidence_custody');
    return Object.freeze({ name: this.name, bytes: before.size, sha256 });
    } finally { release(); }
  }
  close(): void {
    if (this.closed) return;
    this.closed = true; let failure: { value: unknown } | undefined;
    try { closeSync(this.descriptor); } catch (error) { failure = { value: error }; } finally { this.releaseDescriptor(); }
    if (this.#snapshotDescriptor !== undefined) {
      try { closeSync(this.#snapshotDescriptor); } catch (error) { failure ??= { value: error }; } finally { this.releaseSnapshot(); }
    }
    if (failure) throw failure.value;
  }
}
export function verifyWorkflowReviewOwnedReference(root: string, reference: WorkflowReviewOwnedReference): void {
  const file = new WorkflowReviewOwnedFile(root, reference.name);
  let failed = false;
  try {
    const actual = file.seal();
    if (actual.bytes !== reference.bytes || actual.sha256 !== reference.sha256) throw new Error('workflow_review_evidence_corrupt');
  } catch (error) { failed = true; throw error; }
  finally { if (failed) { try { file.close(); } catch { /* preserve the integrity failure */ } } else file.close(); }
}

/** Compare one revisited range against the bytes that were actually reconstructed for that object. */
function verifyWorkflowReviewReconstruction(path: string, offset: number, bytes: Buffer): void {
  const root = dirname(path), name = relative(root, path);
  if (!Number.isSafeInteger(offset) || offset < 0 || bytes.length > WORKFLOW_REVIEW_BUFFER_LIMIT_BYTES) throw new Error('workflow_review_evidence_corrupt');
  if (ownedReviewPath(root, name) !== path) throw new Error('workflow_review_evidence_custody');
  const before = lstatSync(path);
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) throw new Error('workflow_review_evidence_custody');
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const releaseDescriptor = holdReviewResource('descriptors'); const releaseBuffer = holdReviewResource('bufferBytes', bytes.length);
  let failed = false;
  try {
    const current = checkOwnedReviewFile(root, name, path, descriptor, before, before);
    if (offset + bytes.length > current.size) throw new Error('workflow_review_evidence_corrupt');
    const actual = Buffer.allocUnsafe(bytes.length);
    for (let filled = 0; filled < actual.length;) {
      const count = readSync(descriptor, actual, filled, actual.length - filled, offset + filled);
      if (!count) throw new Error('workflow_review_evidence_corrupt');
      filled += count;
    }
    checkOwnedReviewFile(root, name, path, descriptor, before, before);
    if (!actual.equals(bytes)) throw new Error('workflow_review_coverage_incomplete');
  } catch (error) { failed = true; throw error; }
  finally {
    try { if (failed) { try { closeSync(descriptor); } catch { /* preserve the integrity failure */ } } else closeSync(descriptor); }
    finally { releaseDescriptor(); releaseBuffer(); }
  }
}

interface WorkflowReviewCoverageObject {
  readonly key: string;
  readonly kind: 'manifest' | 'entry';
  readonly id: string | null;
  readonly bytes: number;
  readonly sha256: string;
  cursor: number;
}

/**
 * The streaming, disk-backed coverage machine.
 *
 * It holds no receipt history and no per-object heap map: the expected object order is a bounded
 * iterator over the frozen manifest, the reconstruction state lives in one scratch directory of
 * per-object transport artifacts, and each delivered receipt is decoded, bound to its declared
 * length and range digest, appended in order and — once its object completes — compared whole
 * against the frozen identity. A range that names a completed object must match the bytes that were
 * actually reconstructed; a foreign bundle, an unknown id, a gap, a partial overlap, an overrun, a
 * cursor or a range-hash mismatch fails the review instead of shortening it. The immutable on-disk
 * source objects are re-hashed only as a separate, independent guard.
 */
export interface WorkflowReviewProofOwner {
  readonly directory: string;
  readonly invocationId: string;
  readonly reviewerId: string;
  readonly effectiveInvocationDigest: string;
}
export class WorkflowReviewCoverageMachine {
  private readonly scratch: string;
  private readonly objects: Iterator<WorkflowReviewSourceEntry>;
  /** Incrementally accumulated proof identity of every object reconstructed from returned bytes. */
  private readonly reconstruction = createHash('sha256');
  private reconstructionSha256 = '';
  private current: WorkflowReviewCoverageObject | undefined;
  private completed = 0;
  private ranges = 0;
  private finished = false;
  private readonly proofFile?: WorkflowReviewOwnedFile;
  private currentFile: WorkflowReviewOwnedFile | undefined;
  private sequence = 0;
  private releaseRecord: (() => void) | undefined;
  constructor(private readonly bundle: WorkflowReviewSourceBundle, private readonly owner?: WorkflowReviewProofOwner) {
    this.scratch = owner?.directory ?? mkdtempSync(join(tmpdir(), 'omc-review-coverage-'));
    if (owner) { mkdirSync(this.scratch); this.proofFile = new WorkflowReviewOwnedFile(this.scratch, 'proof.jsonl', true); }
    this.objects = iterateWorkflowReviewManifestEntries(bundle);
    this.current = { key: 'manifest', kind: 'manifest', id: null, bytes: bundle.manifestBytes, sha256: bundle.digest, cursor: 0 };
    this.releaseRecord = holdReviewResource('records');
  }
  private scratchPath(key: string): string {
    return join(this.scratch, key === 'manifest' ? 'manifest' : `entry-${key.slice('entry:'.length)}`);
  }
  /** Complete the current object and advance to the expected next one. */
  private completeObject(): void {
    const object = this.current!;
    const file = this.currentFile ?? new WorkflowReviewOwnedFile(this.scratch, relative(this.scratch, this.scratchPath(object.key)));
    this.currentFile = undefined;
    let hashed: WorkflowReviewOwnedReference;
    let failed = false;
    try { hashed = file.seal(); } catch (error) { failed = true; throw error; }
    finally { if (failed) { try { file.close(); } catch { /* preserve the integrity failure */ } } else file.close(); }
    if (hashed.bytes !== object.bytes || hashed.sha256 !== object.sha256) throw new Error('workflow_review_source_corrupt');
    if (this.owner) this.proofFile!.append(Buffer.from(JSON.stringify({ invocationId: this.owner.invocationId,
      reviewerId: this.owner.reviewerId, effectiveInvocationDigest: this.owner.effectiveInvocationDigest,
      kind: object.kind, id: object.id, ...hashed, terminalSequence: this.sequence }) + '\n'));
    // Fold the object's frozen identity into the reconstruction digest in canonical order. The result
    // is a single bounded value that names the exact object sequence the returned bytes proved, so it
    // can be recorded, re-derived and compared without carrying any receipt or object list. An empty
    // object is folded here too: its identity is part of what was proven delivered, and folding it is
    // what makes a source that silently drops empty objects disagree with the frozen manifest.
    this.reconstruction.update(`${object.kind}:${object.id ?? ''}:${object.bytes}:${object.sha256}\n`);
    this.completed++;
    this.current = this.nextObject();
  }
  /**
   * The next expected object. An empty object is expected like any other and is *not* skipped: it is
   * completed only by its own delivered terminal page, so a transport that drops it leaves the walk
   * short of the frozen manifest instead of quietly closing the gap with a zero length.
   */
  private nextObject(): WorkflowReviewCoverageObject | undefined {
    const next = this.objects.next();
    if (next.done) return undefined;
    const entry = next.value;
    return { key: `entry:${entry.id}`, kind: 'entry', id: entry.id, bytes: entry.bytes, sha256: entry.sha256, cursor: 0 };
  }
  /** Returns false when the receipt is a bounded revisit of already-reconstructed bytes. */
  record(receipt: unknown, sequence = 0): boolean {
    this.sequence = sequence;
    const record = receiptRecord(receipt, this.bundle);
    const key = record.kind === 'manifest' ? 'manifest' : `entry:${record.id}`;
    const current = this.current;
    // A receipt that delivers no bytes is only ever the terminal page of an empty expected object: it
    // completes that object's identity, and it is refused against any other object or offset. The
    // shape is settled before the bytes are decoded, so a rangeless delivery aimed at an object whose
    // own length is not zero is refused as an invalid receipt rather than as a corrupt one.
    if (record.bytes === 0 && (!current || current.key !== key || current.bytes !== 0 || record.offset !== 0)) {
      if (record.offset !== 0 || !existsSync(this.scratchPath(key))) throw new Error('workflow_review_source_invalid_receipt');
      const previous = new WorkflowReviewOwnedFile(this.scratch, relative(this.scratch, this.scratchPath(key)));
      let failed = false;
      try { if (previous.seal().bytes !== 0 || receiptBytes(record).length !== 0) throw new Error('workflow_review_source_invalid_receipt'); }
      catch (error) { failed = true; throw error; }
      finally { if (failed) { try { previous.close(); } catch { /* preserve the integrity failure */ } } else previous.close(); }
      return false;
    }
    // The bound is over the bytes the client actually received, never over a re-read of source disk.
    const bytes = receiptBytes(record);
    if (record.bytes === 0) {
      this.currentFile = new WorkflowReviewOwnedFile(this.scratch, relative(this.scratch, this.scratchPath(key)), true);
      this.completeObject();
      return true;
    }
    this.ranges++;
    if (current && current.key === key) {
      if (record.offset + record.bytes > current.bytes) throw new Error('workflow_review_coverage_incomplete');
      if (record.offset === current.cursor) {
        const file = this.currentFile ??= new WorkflowReviewOwnedFile(this.scratch, relative(this.scratch, this.scratchPath(key)), true);
        try { file.append(bytes); }
        catch (error) {
          this.currentFile = undefined;
          try { file.close(); } catch { /* preserve the write failure */ }
          throw error;
        }
        current.cursor += record.bytes;
        if (current.cursor === current.bytes) this.completeObject();
        return true;
      }
      if (record.offset < current.cursor) {
        if (record.offset + record.bytes > current.cursor) throw new Error('workflow_review_coverage_incomplete');
        if (!this.currentFile || !this.currentFile.read(record.offset, bytes.length).equals(bytes)) throw new Error('workflow_review_coverage_incomplete');
        return false;
      }
      throw new Error('workflow_review_coverage_incomplete');
    }
    // Any object other than the current one can only be a revisit of an already-reconstructed object.
    const scratch = this.scratchPath(key);
    if (!existsSync(scratch)) {
      if (key !== 'manifest' && !existsSync(join(this.bundle.recordsDirectory, record.id!))) {
        throw new Error('workflow_review_source_unknown_id');
      }
      throw new Error('workflow_review_coverage_incomplete');
    }
    const object = key === 'manifest'
      ? { bytes: this.bundle.manifestBytes, sha256: this.bundle.digest }
      : readWorkflowReviewRecord(join(this.bundle.recordsDirectory, record.id!));
    if (record.offset + record.bytes > object.bytes) throw new Error('workflow_review_coverage_incomplete');
    verifyWorkflowReviewReconstruction(scratch, record.offset, bytes);
    return false;
  }
  finish(attestation: WorkflowReviewCoverageAttestation): void {
    if (attestation.bundleSha256 !== this.bundle.digest) throw new Error('workflow_review_coverage_attestation_mismatch');
    if (attestation.entries !== this.bundle.entryCount) throw new Error('workflow_review_coverage_incomplete');
    // Every expected object — the manifest included — must have been reconstructed to its frozen end.
    if (this.current !== undefined || this.completed !== this.bundle.entryCount + 1) {
      throw new Error('workflow_review_coverage_incomplete');
    }
    if (this.ranges !== attestation.ranges) throw new Error('workflow_review_coverage_incomplete');
    // The independent guard: the immutable on-disk source objects and the frozen manifest are
    // re-derived from disk, separately from the transport reconstruction proven above.
    verifyWorkflowReviewSourceBundle(this.bundle);
    this.reconstructionSha256 = this.reconstruction.digest('hex');
    this.finished = true;
  }
  get rangeCount(): number { return this.ranges; }
  /**
   * The whole-object reconstruction digest of the returned bytes. Only meaningful once `finish` has
   * accepted the delivery; before that it names a partial object sequence.
   */
  get reconstructionDigest(): string {
    if (!this.finished) throw new Error('workflow_review_coverage_incomplete');
    return this.reconstructionSha256;
  }
  get retainedProof(): WorkflowReviewOwnedReference {
    if (!this.finished || !this.proofFile) throw new Error('workflow_review_coverage_incomplete');
    return this.proofFile.seal();
  }
  dispose(): void {
    // The expected-object iterator is closed first: it holds an open manifest file stream, and the
    // machine is discarded through early failure paths where the manifest was never walked to its end.
    let failure: { value: unknown } | undefined;
    try { this.objects.return?.(undefined as never); } catch (error) { failure = { value: error }; }
    try { this.currentFile?.close(); } catch (error) { failure ??= { value: error }; }
    this.currentFile = undefined;
    try { this.proofFile?.close(); } catch (error) { failure ??= { value: error }; }
    this.releaseRecord?.(); this.releaseRecord = undefined;
    if (!this.owner) try { rmSync(this.scratch, { recursive: true, force: true }); } catch { /* best effort */ }
    if (failure) throw failure.value;
  }
  get isFinished(): boolean { return this.finished; }
}

export function assertWorkflowReviewCoverageAttribution(bundle: WorkflowReviewSourceBundle, attestation: unknown, reviewerId: string): WorkflowReviewCoverageAttestation {
  const parsed = attestationObject(attestation);
  if (parsed.bundleSha256 !== bundle.digest || parsed.reviewerId !== reviewerId) {
    throw new Error('workflow_review_coverage_attestation_mismatch');
  }
  return parsed;
}

/**
 * Prove complete, untruncated delivery from an ordered receipt sequence, reconstructing every object
 * from the returned bytes. The manifest and every expected entry must be tiled exactly once by
 * receipts whose returned bytes match the frozen bytes, and the reviewer must return an attributed
 * attestation bound to this exact bundle. Used by the in-process reader and its public tests; the
 * controller path validates the same machine straight from the on-disk ledger.
 */
export function validateWorkflowReviewCoverage(bundle: WorkflowReviewSourceBundle, input: {
  receipts: readonly WorkflowReviewSourceReceipt[];
  attestation: unknown;
  reviewerId: string;
}): void {
  verifyWorkflowReviewSourceBundle(bundle);
  const attestation = assertWorkflowReviewCoverageAttribution(bundle, input.attestation, input.reviewerId);
  const machine = new WorkflowReviewCoverageMachine(bundle);
  try {
    for (const receipt of input.receipts) machine.record(receipt);
    machine.finish(attestation);
  } finally { machine.dispose(); }
}

/** Parse one JSONL line into a receipt or fail the review. */
function parseWorkflowReviewReceiptLine(line: string): WorkflowReviewSourceReceipt {
  try { return JSON.parse(line) as WorkflowReviewSourceReceipt; }
  catch { throw new Error('workflow_review_source_invalid_receipt'); }
}

/**
 * Prove complete delivery straight from the append-only on-disk ledger, decoding each receipt's
 * returned bytes and reconstructing every object on disk as it streams. Only one line and one open
 * scratch artifact are held at a time, so a ledger far larger than memory is validated without
 * collecting every receipt. A missing manifest page, a hidden gap, a transport corruption or an
 * absent attestation fails; the returned count is the exact number of delivered ranges.
 */
export async function validateWorkflowReviewCoverageLedger(bundle: WorkflowReviewSourceBundle, input: {
  ledger: AsyncIterable<string>;
  attestation: unknown;
  reviewerId: string;
}): Promise<WorkflowReviewCoverageProof> {
  verifyWorkflowReviewSourceBundle(bundle);
  const attestation = assertWorkflowReviewCoverageAttribution(bundle, input.attestation, input.reviewerId);
  const machine = new WorkflowReviewCoverageMachine(bundle);
  let failed = false;
  try {
    for await (const line of input.ledger) {
      const trimmed = line.endsWith('\n') ? line.slice(0, -1) : line;
      const value = trimmed.endsWith('\r') ? trimmed.slice(0, -1) : trimmed;
      if (!value.trim()) continue;
      machine.record(parseWorkflowReviewReceiptLine(value));
    }
    machine.finish(attestation);
    return Object.freeze({ ranges: machine.rangeCount, reconstructionSha256: machine.reconstructionDigest });
  } catch (error) { failed = true; throw error; }
  finally { if (failed) { try { machine.dispose(); } catch { /* preserve the first failure */ } } else machine.dispose(); }
}

/** The bounded proof one accepted delivery yields: its range count and reconstruction identity. */
export interface WorkflowReviewCoverageProof {
  readonly ranges: number;
  readonly reconstructionSha256: string;
}
/** One bounded, digest-addressed evidence artifact a reader qualification or coverage record rests on. */
export interface WorkflowReviewEvidenceArtifact {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly ranges: number;
}
/** Validate the shape of one evidence artifact reference, refusing a relative or fabricated one. */
export function parseWorkflowReviewEvidenceArtifact(value: unknown): WorkflowReviewEvidenceArtifact {
  const code = 'workflow_review_reader_qualification_invalid';
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(code);
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some(key => !['path', 'sha256', 'bytes', 'ranges'].includes(key))
    || typeof raw.path !== 'string' || !raw.path || raw.path.length > 1000 || raw.path.includes('\0') || !isAbsolute(raw.path)
    || typeof raw.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(raw.sha256)
    || !Number.isSafeInteger(raw.bytes) || (raw.bytes as number) < 1
    || !Number.isSafeInteger(raw.ranges) || (raw.ranges as number) < 1) {
    throw new Error(code);
  }
  return Object.freeze({ path: raw.path, sha256: raw.sha256, bytes: raw.bytes as number, ranges: raw.ranges as number });
}
/**
 * Verify one referenced delivery artifact and re-derive its proof: the file must be the exact declared
 * regular file at an absolute path, hold exactly its declared byte count and rehash to its declared
 * digest, and the pages it records must reconstruct every frozen object of the bundle exactly. The
 * walk streams, so a ledger larger than memory is validated without being collected, and a fabricated
 * digest, a truncated or extended ledger, a foreign bundle and an under- or over-counted range set are
 * all refusals rather than an accepted review of material the client never actually received.
 */
export async function verifyWorkflowReviewCoverageArtifact(bundle: WorkflowReviewSourceBundle, input: {
  artifact: unknown;
  attestation: unknown;
  reviewerId: string;
}): Promise<WorkflowReviewCoverageProof & { artifact: WorkflowReviewEvidenceArtifact }> {
  const artifact = parseWorkflowReviewEvidenceArtifact(input.artifact);
  const stat = lstatSync(artifact.path, { throwIfNoEntry: false });
  if (!stat || stat.isSymbolicLink() || !stat.isFile()) throw new Error('workflow_review_reader_qualification_required');
  const hashed = hashWorkflowReviewArtifact(artifact.path);
  if (hashed.bytes !== artifact.bytes || hashed.sha256 !== artifact.sha256) {
    throw new Error('workflow_review_reader_qualification_changed');
  }
  const proof = await validateWorkflowReviewCoverageLedger(bundle, {
    ledger: streamWorkflowReviewLines(artifact.path), attestation: input.attestation, reviewerId: input.reviewerId });
  if (proof.ranges !== artifact.ranges) throw new Error('workflow_review_reader_qualification_incomplete');
  return Object.freeze({ ...proof, artifact });
}

/** Stream one file as JSONL lines through a bounded buffer, never reading it whole. */
export async function* streamWorkflowReviewLines(path: string | WorkflowReviewOwnedFile): AsyncGenerator<string> {
  const owned = typeof path === 'string' ? undefined : path;
  let stream: AsyncIterable<Buffer>;
  if (typeof path === 'string') {
    if (!existsSync(path)) return;
    stream = createReadStream(path, { highWaterMark: WORKFLOW_REVIEW_BUFFER_LIMIT_BYTES });
  } else {
    const file = path; const { bytes } = file.seal();
    stream = (async function* () {
      for (let offset = 0; offset < bytes; offset += WORKFLOW_REVIEW_BUFFER_LIMIT_BYTES) {
        yield file.read(offset, Math.min(WORKFLOW_REVIEW_BUFFER_LIMIT_BYTES, bytes - offset));
      }
    })();
  }
  // One stateful decoder for the whole stream, matching the synchronous walk: decoding each chunk on
  // its own turns a multi-byte character split across two reads into two replacement characters, so a
  // receipt whose text is not ASCII would read as one text here and another text in the sync path —
  // and a delivered object could be reported as altered purely by the seam it happened to land on.
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '';
  for await (const chunk of stream) {
    pending += decoder.decode(chunk as Buffer, { stream: true });
    for (;;) {
      const index = pending.indexOf('\n');
      if (index < 0) break;
      owned?.assertUnchanged();
      yield pending.slice(0, index + 1);
      owned?.assertUnchanged();
      pending = pending.slice(index + 1);
    }
    if (pending.length > WORKFLOW_REVIEW_BUFFER_LIMIT_BYTES * 4) throw new Error('workflow_review_source_invalid_receipt');
  }
  pending += decoder.decode();
  if (pending.trim()) { owned?.assertUnchanged(); yield pending; owned?.assertUnchanged(); }
  owned?.seal();
}
/**
 * One artifact's lines, synchronously, through the same bounded buffer and the same stateful UTF-8
 * decoding. It exists so a caller that must verify an artifact inside a synchronous boundary — the
 * qualification predicate, which runs before any attempt is reserved — re-derives the proof with
 * exactly the walk the asynchronous controller path uses, rather than a second, laxer reader.
 */
function* iterateWorkflowReviewLines(path: string): Generator<string> {
  if (!existsSync(path)) return;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '';
  for (const chunk of readWorkflowReviewFileChunks(path)) {
    pending += decoder.decode(chunk, { stream: true });
    for (;;) {
      const index = pending.indexOf('\n');
      if (index < 0) break;
      const line = pending.slice(0, index);
      pending = pending.slice(index + 1);
      yield line.endsWith('\r') ? line.slice(0, -1) : line;
    }
    if (pending.length > WORKFLOW_REVIEW_BUFFER_LIMIT_BYTES * 4) throw new Error('workflow_review_source_invalid_receipt');
  }
  pending += decoder.decode();
  if (pending.trim()) yield pending.endsWith('\r') ? pending.slice(0, -1) : pending;
}

/**
 * Prove one referenced delivery artifact against a frozen bundle, synchronously: the file must be the
 * exact declared regular non-symlink file at an absolute path, hold exactly its declared byte count and
 * rehash to its declared digest, and the pages it records must tile every frozen object — the manifest
 * included — exactly once, in order, from the returned bytes alone. The re-derived reconstruction
 * identity is returned so the caller can compare it with the proof it was handed: a fabricated digest,
 * a truncated or padded ledger, a foreign bundle or an under- or over-counted range set is a refusal
 * rather than an accepted review of material the client never actually received.
 */
export function verifyWorkflowReviewCoverageArtifactSync(bundle: WorkflowReviewSourceBundle, input: {
  artifact: unknown;
  attestation: unknown;
  reviewerId: string;
}): WorkflowReviewCoverageProof & { artifact: WorkflowReviewEvidenceArtifact } {
  const artifact = parseWorkflowReviewEvidenceArtifact(input.artifact);
  const stat = lstatSync(artifact.path, { throwIfNoEntry: false });
  if (!stat || stat.isSymbolicLink() || !stat.isFile()) throw new Error('workflow_review_reader_qualification_required');
  const hashed = hashWorkflowReviewArtifact(artifact.path);
  if (hashed.bytes !== artifact.bytes || hashed.sha256 !== artifact.sha256) {
    throw new Error('workflow_review_reader_qualification_changed');
  }
  verifyWorkflowReviewSourceBundle(bundle);
  const attestation = assertWorkflowReviewCoverageAttribution(bundle, input.attestation, input.reviewerId);
  const machine = new WorkflowReviewCoverageMachine(bundle);
  try {
    for (const line of iterateWorkflowReviewLines(artifact.path)) {
      if (!line.trim()) continue;
      machine.record(parseWorkflowReviewReceiptLine(line));
    }
    machine.finish(attestation);
    if (machine.rangeCount !== artifact.ranges) throw new Error('workflow_review_reader_qualification_incomplete');
    return Object.freeze({ ranges: machine.rangeCount, reconstructionSha256: machine.reconstructionDigest, artifact });
  } finally { machine.dispose(); }
}

export interface WorkflowReviewSpoolResult {
  readonly bytes: number;
  readonly sha256: string;
}

/**
 * Spool complete Git stdout into an exclusive private artifact. stdout is bound
 * to the artifact file descriptor, so no `maxBuffer` applies and no byte is
 * trimmed; a non-zero exit or a signal removes the partial artifact and fails.
 */
export function spoolWorkflowReviewGit(input: { cwd: string; args: readonly string[]; path: string }): WorkflowReviewSpoolResult {
  if (!Array.isArray(input.args) || input.args.some(argument => typeof argument !== 'string')) {
    throw new Error('workflow_review_git_failed');
  }
  const descriptor = openSync(input.path, 'wx', 0o600);
  try {
    const outcome = spawnSync('git', input.args as string[], { cwd: input.cwd, stdio: ['ignore', descriptor, 'pipe'],
      timeout: 300_000, windowsHide: true, shell: false });
    if (outcome.error || outcome.signal || outcome.status !== 0) throw new Error('workflow_review_git_failed');
  } catch (error) {
    closeSync(descriptor);
    unlinkSync(input.path);
    throw error;
  }
  closeSync(descriptor);
  return hashWorkflowReviewArtifact(input.path);
}

/** Digest one artifact by streaming it through a bounded buffer; never a read-whole descriptor. */
export function hashWorkflowReviewArtifact(path: string): WorkflowReviewSpoolResult {
  const descriptor = openSync(path, 'r');
  let failed = false;
  try {
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(WORKFLOW_REVIEW_BUFFER_LIMIT_BYTES);
    let bytes = 0;
    for (;;) {
      const read = readSync(descriptor, buffer, 0, buffer.length, null);
      if (read <= 0) break;
      hash.update(buffer.subarray(0, read));
      bytes += read;
    }
    return { bytes, sha256: hash.digest('hex') };
  } catch (error) { failed = true; throw error; }
  finally { if (failed) { try { closeSync(descriptor); } catch { /* preserve the read failure */ } } else closeSync(descriptor); }
}

/**
 * Write an exclusive private artifact from an ordered sequence of byte chunks,
 * hashing every byte as it is written so a huge artifact is never held twice.
 * The descriptor is closed exactly once on both the success and the failure path
 * (a leaked handle keeps the file locked on Windows), and a failed write removes
 * what it wrote so no caller can read a partial file as a complete artifact.
 */
export function writeWorkflowReviewArtifact(input: { path: string; chunks: Iterable<Buffer | string> }): WorkflowReviewSpoolResult {
  const descriptor = openSync(input.path, 'wx', 0o600);
  let failure: { value: unknown } | undefined; let result: WorkflowReviewSpoolResult | undefined;
  try {
    const hash = createHash('sha256');
    let bytes = 0;
    for (const chunk of input.chunks) {
      for (let offset = 0; offset < chunk.length;) {
        // Three bytes per UTF-16 unit is the worst case. Keep pairs together before encoding;
        // arbitrary string fragments (including JSON) never allocate an oversized working buffer.
        let end = Math.min(chunk.length, offset + (typeof chunk === 'string'
          ? Math.floor(WORKFLOW_REVIEW_BUFFER_LIMIT_BYTES / 3) : WORKFLOW_REVIEW_BUFFER_LIMIT_BYTES));
        if (typeof chunk === 'string' && end < chunk.length
          && /[\ud800-\udbff]/.test(chunk[end - 1]!) && /[\udc00-\udfff]/.test(chunk[end]!)) end--;
        const buffer = typeof chunk === 'string' ? Buffer.from(chunk.slice(offset, end), 'utf8') : chunk.subarray(offset, end);
        const release = typeof chunk === 'string' ? holdReviewResource('bufferBytes', buffer.length) : () => {};
        try {
          for (let written = 0; written < buffer.length;) {
            const count = writeSync(descriptor, buffer, written, buffer.length - written, null);
            if (count <= 0) throw new Error('workflow_review_artifact_write_failed');
            written += count;
          }
          hash.update(buffer); bytes += buffer.length;
        } finally { release(); }
        offset = end;
      }
    }
    result = { bytes, sha256: hash.digest('hex') };
  } catch (value) { failure = { value }; }
  try { closeSync(descriptor); } catch (value) { failure ??= { value }; }
  if (failure) {
    try { unlinkSync(input.path); } catch { /* preserve the first failure after attempting claimed-file cleanup */ }
    throw failure.value;
  }
  return result!;
}

/**
 * A descriptor for a large artifact, built from a streaming hash rather than the
 * shared read-whole descriptor helper: the artifact is never loaded into memory.
 */
export function createWorkflowReviewArtifactDescriptor(input: {
  path: string; kind: string; producer: ArtifactProducer; retention: ArtifactRetention;
}): ArtifactDescriptor {
  const stat = lstatSync(input.path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('workflow_review_artifact_invalid');
  const hashed = hashWorkflowReviewArtifact(input.path);
  return { kind: input.kind, path: input.path, contentHash: hashed.sha256,
    createdAt: new Date(stat.mtimeMs).toISOString(), producer: input.producer, sizeBytes: hashed.bytes, retention: input.retention };
}

/** A bounded synchronous pause, used only while retrying a refused directory move. */
function waitForFileSystem(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}
/**
 * Copy one bundle directory byte-for-byte through the exclusive streaming writer. The walk pulls one
 * directory entry at a time from an open handle, so a bundle directory is copied without ever
 * collecting its listing, and the handle is closed on every exit path.
 *
 * The destination is claimed exclusively: `mkdir` without `recursive` fails on a path that already
 * exists, so this copy owns exactly the directory it created and never removes a directory a
 * concurrent winner got to first. A copy that fails removes only its own partial destination — after
 * the open handle is closed, because a directory whose descriptor is still open cannot be deleted on
 * every platform — and never touches the source it was reading. A cleanup that itself fails must not
 * replace the original error, which is the one that explains why the copy stopped.
 */
function copyWorkflowReviewDirectory(from: string, to: string): void {
  mkdirSync(to);
  // Only from here is `to` a directory this invocation created, so only from here may it be removed:
  // a destination a concurrent winner got to first fails the exclusive create above and is left alone.
  try {
    const directory = opendirSync(from);
    let failed = false;
    try {
      for (;;) {
        const entry = directory.readSync();
        if (!entry) return;
        const source = join(from, entry.name);
        const target = join(to, entry.name);
        if (entry.isDirectory()) copyWorkflowReviewDirectory(source, target);
        else writeWorkflowReviewArtifact({ path: target, chunks: readWorkflowReviewFileChunks(source) });
      }
    } catch (error) { failed = true; throw error; } finally {
      // Closing the listing handle is the last step before the destination may be removed, and a close
      // that fails must not become the reported cause: the error being unwound is the one that explains
      // why the copy stopped, and the cleanup below still runs on top of the attempt to release it.
      if (failed) { try { directory.closeSync(); } catch { /* preserve the first failure */ } }
      else directory.closeSync();
    }
  } catch (error) {
    // A failed copy removes only its own partial destination, and only after the listing handle above
    // is closed — on Windows an open descriptor keeps the directory undeletable, which would leave the
    // failure half-repaired. The source staging directory is never touched here, and a cleanup that
    // itself fails must not replace the original error, which is the one that explains the stop.
    try { rmSync(to, { recursive: true, force: true }); } catch { /* the original error stands */ }
    throw error;
  }
}
/**
 * Move a freshly frozen bundle to its content-addressed name. On Windows a directory rename is
 * sometimes refused transiently while a scanner or filter driver still holds a just-written file,
 * so the move is retried; if it stays refused the same bytes are copied recursively instead. Either
 * way the destination is re-opened and re-verified by the caller, so an inexact move cannot pass.
 */
function moveWorkflowReviewDirectory(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try { renameSync(from, to); return; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') throw error;
      if (attempt >= 5) {
        copyWorkflowReviewDirectory(from, to);
        rmSync(from, { recursive: true, force: true });
        return;
      }
      waitForFileSystem(20 * (attempt + 1));
    }
  }
}
/**
 * Move a freshly built bundle directory to its content-addressed name. The digest
 * is over the canonical manifest, so two freezes of the same material converge on
 * the same immutable directory; an existing directory is reused unchanged.
 */
export function publishWorkflowReviewBundle(bundle: WorkflowReviewSourceBundle, finalDirectory: string): WorkflowReviewSourceBundle {
  if (finalDirectory === bundle.directory) return bundle;
  if (existsSync(finalDirectory)) {
    // A directory already at the content-addressed name must hold exactly this freeze. It is re-opened
    // and matched field by field against the fresh bundle digest, so a name colliding with different
    // bytes — a pre-created, partial or foreign directory — is a refusal rather than a silent
    // substitution of one bundle for the other. Only then is the fresh staging directory discarded.
    const existing = openWorkflowReviewSourceBundle(finalDirectory);
    assertWorkflowReviewBundleIdentity(existing, bundle);
    verifyWorkflowReviewSourceBundle(existing);
    rmSync(bundle.directory, { recursive: true, force: true });
    return existing;
  }
  moveWorkflowReviewDirectory(bundle.directory, finalDirectory);
  // The moved directory is re-opened and re-verified in full against the frozen descriptor, so an
  // inexact move is a refusal rather than a different bundle quietly published under the right name.
  const published = openWorkflowReviewSourceBundle(finalDirectory);
  assertWorkflowReviewBundleIdentity(published, bundle);
  verifyWorkflowReviewSourceBundle(published);
  return published;
}
/** Refuse a published directory whose frozen identity or digests are not the freshly frozen bundle's. */
function assertWorkflowReviewBundleIdentity(found: WorkflowReviewSourceBundle, expected: WorkflowReviewSourceBundle): void {
  if (found.digest !== expected.digest || found.indexDigest !== expected.indexDigest
    || found.entryCount !== expected.entryCount || found.totalBytes !== expected.totalBytes
    || found.repositoryIdentity !== expected.repositoryIdentity || found.baseCommit !== expected.baseCommit
    || found.head !== expected.head || found.manifestBytes !== expected.manifestBytes
    || found.indexBytes !== expected.indexBytes) {
    throw new Error('workflow_review_source_corrupt');
  }
}

/**
 * Capture one complete Git stdout off the buffer path entirely: stdout is spooled
 * to a private temporary file — no shell, no `maxBuffer`, no trim — and streamed
 * back through a bounded buffer so even a change far larger than memory is read
 * losslessly without ever being held as one unbounded pipe.
 */
function captureWorkflowReviewGit(cwd: string, args: readonly string[]): Buffer {
  const directory = mkdtempSync(join(tmpdir(), 'omc-review-git-'));
  const path = join(directory, 'stdout');
  try {
    spoolWorkflowReviewGit({ cwd, args, path });
    return readWorkflowReviewFileStreaming(path);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

/** One complete Git stdout capture as UTF-8 text, spooled with a bounded buffer and no trim. */
export function readWorkflowReviewGitText(cwd: string, args: readonly string[]): string {
  return captureWorkflowReviewGit(cwd, args).toString('utf8');
}

/** Read the complete untrimmed bytes of one tracked Git object at a revision. */
export function readWorkflowReviewGitBlob(cwd: string, revision: string, path: string): Buffer {
  return captureWorkflowReviewGit(cwd, ['show', `${revision}:${path}`]);
}

/** Spool one complete Git stdout capture to an exclusive artifact and return its descriptor. */
export function spoolWorkflowReviewGitText(input: { cwd: string; args: readonly string[]; path: string }): WorkflowReviewSpoolResult {
  return spoolWorkflowReviewGit(input);
}
