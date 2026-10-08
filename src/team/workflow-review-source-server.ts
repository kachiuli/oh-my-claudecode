/**
 * Read-only, non-command MCP reader for one controller-owned review source bundle.
 *
 * The reviewer reaches the complete logical source exclusively through this
 * server. It exposes no filesystem, write, shell, Git or provider operation; the
 * two tools address material only by bundle-local id and page through opaque
 * continuation cursors. Every served range — manifest pages included — is appended
 * to a controller-owned receipt log so complete coverage can be proven before any
 * finding is accepted.
 *
 * There is no aggregate bundle ceiling: the server reads the manifest and entry
 * files on disk by bounded positioned ranges and pages them out completely,
 * however large the authorized source is.
 */
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, lstatSync, mkdirSync, opendirSync, readFileSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { createRequire, isBuiltin } from 'node:module';
import { isUtf8 } from 'node:buffer';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, createConnection, type Server as NetServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { openWorkflowReviewSourceBundle, readWorkflowReviewSource, workflowReviewSourceReceipt, hashWorkflowReviewArtifact,
  writeWorkflowReviewArtifact, iterateWorkflowReviewJsonFields, iterateWorkflowReviewJsonRecords, iterateWorkflowReviewManifestEntries,
  WORKFLOW_REVIEW_READ_LIMIT_BYTES,
  parseWorkflowReviewEvidenceArtifact, assertWorkflowReviewCoverageAttribution,
  WorkflowReviewCoverageMachine, WorkflowReviewOwnedFile, verifyWorkflowReviewOwnedReference,
  workflowReviewResourceUsage, workflowReviewSourceObjectBytes,
  iterateWorkflowReviewNativeItems, readWorkflowReviewNativeRequestControls, fingerprintWorkflowReviewNativeRequest,
  workflowReviewNativeTextContentSha256,
  type WorkflowReviewSourceBundle, type WorkflowReviewSourceEntry, type WorkflowReviewSourceReadResult, type WorkflowReviewSourceReceipt, type WorkflowReviewEvidenceArtifact,
  type WorkflowReviewCoverageProof, type WorkflowReviewOwnedReference } from './workflow-review-source.js';
import { buildWorkflowReviewSourceBundle, streamWorkflowReviewLines } from './workflow-review-source.js';
import { runWorkflowProcess, requireWorkflowProcessCompletion, type WorkflowProcessInputTransport, type WorkflowProcessResult } from './workflow-process.js';
import { workflowReviewerArguments, requirePreparedWorkflowBinding, type PreparedWorkflowBinding } from './workflow-adapters.js';
import type { WorkflowRoleBinding } from './workflow-contracts.js';
import { superviseWindowsWorkflowInvocation } from './workflow-process-supervisor.js';
import { createWorkflowNativeReviewObserver, workflowNativeReviewObserverConfiguration, disposeWorkflowNativeReviewObserver,
  beginWorkflowNativeReviewObservation, beginWorkflowNativeReviewClientShutdown, assertWorkflowNativeReviewObservationHealthy,
  settleWorkflowNativeReviewObservation, consumeWorkflowNativeReviewObservationCompletion,
  iterateWorkflowNativeObservedTransactions, type WorkflowNativeObservedTransaction,
  type WorkflowNativeReviewObserver, type WorkflowNativeReviewObservation, type WorkflowNativeReviewObservationCompletion,
  type WorkflowNativeReviewTransportBootstrap } from './workflow-native-review-observer.js';
import { WorkflowNativeCompactionChain } from './workflow-native-compaction.js';
import type { WorkflowNativeBodyObserverSettlement } from './workflow-native-body-observer.js';

export const WORKFLOW_REVIEW_SOURCE_SERVER_NAME = 'omc-review-source';
export const WORKFLOW_REVIEW_READER_TOOL_MANIFEST = 'review_source_manifest';
export const WORKFLOW_REVIEW_READER_TOOL_READ = 'review_source_entry';
/**
 * The attribution this controller uses for the completeness claim it re-derives about an observed
 * delivery. The claim carries no authority of its own: the coverage machine re-derives the entry count
 * from the frozen manifest and the range count from the pages actually recorded, so a false claim
 * fails rather than being trusted.
 */
export const WORKFLOW_REVIEW_READER_OBSERVER = 'workflow-review-reader-observation';

const TOOLS = [
  { name: WORKFLOW_REVIEW_READER_TOOL_MANIFEST,
    description: 'Read a bounded page of the frozen source-bundle manifest and its continuation cursor.',
    inputSchema: { type: 'object' as const, additionalProperties: false,
      properties: { cursor: { type: 'string', pattern: '^[A-Za-z0-9_-]+$' } } } },
  { name: WORKFLOW_REVIEW_READER_TOOL_READ,
    description: 'Read a bounded page of one frozen source entry by its bundle id. Read-only; no path or command input.',
    inputSchema: { type: 'object' as const, additionalProperties: false, required: ['id'],
      properties: { id: { type: 'string', pattern: '^(?:(?:instr|src)-[0-9]+|inventory|diff|objective|shared-context|contracts)$' },
        cursor: { type: 'string', pattern: '^[A-Za-z0-9_-]+$' } } } },
];

export interface WorkflowReviewSourceServerOptions {
  readonly bundle: WorkflowReviewSourceBundle;
  /** Records each served range — manifest pages and entries alike — as a delivery receipt. */
  readonly onReceipt?: (receipt: WorkflowReviewSourceReceipt) => void;
}

/** The declared arguments of one reader tool call, each of the declared type and nothing else. */
function readerArguments(tool: string, value: unknown): { id?: string; cursor?: string } {
  const raw = value === undefined || value === null ? {} : value;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('workflow_review_source_invalid_arguments');
  const args = raw as Record<string, unknown>;
  const allowed = tool === WORKFLOW_REVIEW_READER_TOOL_MANIFEST ? ['cursor'] : ['id', 'cursor'];
  // An unknown key is an argument this reader does not implement, and a value of the wrong type is
  // not the argument it names: both are refused at the real MCP boundary rather than being coerced
  // to `undefined`, which would silently serve offset 0 of the addressed object.
  if (Object.keys(args).some(key => !allowed.includes(key))) throw new Error('workflow_review_source_invalid_arguments');
  const id = args.id; const cursor = args.cursor;
  if (id !== undefined && (typeof id !== 'string' || !id || id.length > 200)) throw new Error('workflow_review_source_invalid_arguments');
  if (cursor !== undefined && (typeof cursor !== 'string' || cursor.length > 512 || cursor.includes('\0'))) {
    throw new Error('workflow_review_source_invalid_arguments');
  }
  return { ...(id === undefined ? {} : { id: id as string }), ...(cursor === undefined ? {} : { cursor: cursor as string }) };
}

/** Build the MCP server that serves exactly one bundle. */
export function createWorkflowReviewSourceServer(options: WorkflowReviewSourceServerOptions): Server {
  const server = new Server({ name: WORKFLOW_REVIEW_SOURCE_SERVER_NAME, version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    try {
      const args = readerArguments(request.params.name, request.params.arguments);
      // The page is fitted against the frame *this* request will receive, so its identifier needs no
      // cap of its own: a long or escape-heavy id leaves correspondingly less room for material and
      // still receives a complete, in-bound page. Only a request whose identifier leaves no room for
      // a single byte of material at all is refused, and that refusal names the bound rather than
      // echoing the identifier back, so no oversized id is ever repeated in a response.
      const read = request.params.name === WORKFLOW_REVIEW_READER_TOOL_MANIFEST
        ? readWorkflowReviewSource(options.bundle, { kind: 'manifest', requestId: extra.requestId,
            ...(args.cursor === undefined ? {} : { cursor: args.cursor }) })
        : request.params.name === WORKFLOW_REVIEW_READER_TOOL_READ
          ? readWorkflowReviewSource(options.bundle, { kind: 'entry', requestId: extra.requestId,
              ...(args.id === undefined ? {} : { id: args.id }),
              ...(args.cursor === undefined ? {} : { cursor: args.cursor }) })
          : undefined;
      if (!read) return { content: [{ type: 'text', text: 'Unknown tool' }], isError: true };
      // The manifest pages are receipts too: an undelivered final manifest page must fail coverage.
      // An empty material is served as exactly one complete page carrying no bytes, and that page is a
      // receipt like any other — the terminal record proving the empty object was actually delivered.
      // Without it a transport that silently dropped every empty object would leave no trace at all,
      // and the walked source would appear complete against a manifest it never carried. This receipt
      // still states only what the reader *intended* to serve and is retained as diagnostic evidence:
      // the admission basis is the ledger of bytes the client actually decoded, which this server
      // never writes.
      options.onReceipt?.(workflowReviewSourceReceipt(read));
      return { content: [{ type: 'text', text: JSON.stringify(read) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : 'workflow_review_source_read_failed'}` }], isError: true };
    }
  });
  return server;
}

/**
 * The reader's stdio transport with a final outbound guard. Every message the SDK writes — a served
 * page, a tools list or an error the SDK synthesizes around a rejected request — is measured exactly
 * as it will be serialized, newline included, and an oversized frame closes the connection instead of
 * being written. That guard is what makes the per-response policy universal: a client id too long to
 * carry any correlated response, or an error that echoes one, cannot reach the wire at all.
 */
export class BoundedWorkflowReviewTransport extends StdioServerTransport {
  override async send(message: JSONRPCMessage): Promise<void> {
    // The measured bytes are exactly the bytes the base transport writes. `serializeMessage` already
    // terminates the frame with its newline, so appending a second one would count a byte that is
    // never sent and refuse a response that satisfies the policy byte-for-byte at the bound.
    if (Buffer.byteLength(serializeMessage(message), 'utf8') > WORKFLOW_REVIEW_READ_LIMIT_BYTES) {
      const error = new Error('workflow_review_source_response_unbounded');
      this.onerror?.(error);
      await this.close();
      throw error;
    }
    return super.send(message);
  }
}
/** The transport every reader process is served over. */
export function createWorkflowReviewSourceTransport(): StdioServerTransport {
  return new BoundedWorkflowReviewTransport();
}

/** Append one delivery receipt line to the controller-owned receipt log. */
export function appendWorkflowReviewSourceReceipt(path: string, receipt: WorkflowReviewSourceReceipt): void {
  appendFileSync(path, `${JSON.stringify(receipt)}\n`, { flag: 'a' });
}

/** Digest of this reader module's own bytes, bound into the adoption receipt. */
export function workflowReviewReaderBuildIdentity(): { id: string; sha256: string } {
  const path = new URL(import.meta.url);
  const bytes = readFileSync(path);
  return { id: WORKFLOW_REVIEW_SOURCE_SERVER_NAME, sha256: createHash('sha256').update(bytes).digest('hex') };
}

function assertReaderConfigValue(value: unknown): string {
  if (typeof value !== 'string' || !value || value.includes('\0') || /[\r\n]/.test(value)) {
    throw new Error(`workflow_review_source_invalid_reader_config`);
  }
  return value;
}

/**
 * Ephemeral `--mcp-config` document supplying this reader to a native Claude
 * reviewer. It names one bundle directory and one receipt log; no global auth or
 * config is mutated.
 */
export function workflowReviewSourceReaderConfig(input: {
  serverPath: string; bundlePath: string; receiptsPath: string;
}): string {
  const serverPath = assertReaderConfigValue(input.serverPath);
  const bundlePath = assertReaderConfigValue(input.bundlePath);
  const receiptsPath = assertReaderConfigValue(input.receiptsPath);
  return JSON.stringify({ mcpServers: { [WORKFLOW_REVIEW_SOURCE_SERVER_NAME]: { command: process.execPath,
    args: [serverPath], env: { OMC_REVIEW_SOURCE_BUNDLE: bundlePath, OMC_REVIEW_SOURCE_RECEIPTS: receiptsPath } } } });
}

/**
 * The per-invocation Codex projection of the same reader. Codex accepts neither
 * Claude's `--mcp-config` flag nor a global config rewrite, so the reader is
 * declared with repeated dotted-TOML `--config` overrides scoped to this one
 * invocation and the reviewer's tool surface is reduced to the two read-only
 * reader tools. Nothing here touches the authenticated provider/profile settings,
 * which stay exactly as the binding selected them.
 */

/** The tool namespace Codex derives from this server's name: only `[A-Za-z0-9_]` survives. */
export const WORKFLOW_REVIEW_CODEX_READER_NAMESPACE =
  `mcp__${WORKFLOW_REVIEW_SOURCE_SERVER_NAME.replace(/[^A-Za-z0-9_]/g, '_')}`;
/** The features that execute commands or expose a tool surface beyond the reader. */
export const WORKFLOW_REVIEW_CODEX_COMMAND_TOOL_FEATURES: readonly string[] = ['shell_tool', 'unified_exec'];
const WORKFLOW_REVIEW_CODEX_EXTRA_TOOL_FEATURES: readonly string[] = ['image_generation', 'goals'];
/** Every feature disabled for one reader-only invocation. */
export const WORKFLOW_REVIEW_CODEX_EXCLUDED_FEATURES: readonly string[] =
  [...WORKFLOW_REVIEW_CODEX_COMMAND_TOOL_FEATURES, ...WORKFLOW_REVIEW_CODEX_EXTRA_TOOL_FEATURES];

export interface WorkflowReviewCodexReaderInput {
  serverPath: string; bundlePath: string; receiptsPath: string; command?: string;
  /** The already-projected model catalog for this invocation; omitted when none was projected. */
  catalogPath?: string;
}
export function workflowReviewCodexReaderOverrides(input: WorkflowReviewCodexReaderInput): string[] {
  const serverPath = assertReaderConfigValue(input.serverPath);
  const bundlePath = assertReaderConfigValue(input.bundlePath);
  const receiptsPath = assertReaderConfigValue(input.receiptsPath);
  const command = input.command ?? process.execPath;
  assertReaderConfigValue(command);
  const catalogPath = input.catalogPath === undefined ? undefined : assertReaderConfigValue(input.catalogPath);
  const key = `mcp_servers.${WORKFLOW_REVIEW_SOURCE_SERVER_NAME}`;
  return [
    '--config', `${key}.command=${JSON.stringify(command)}`,
    '--config', `${key}.args=${JSON.stringify([serverPath])}`,
    '--config', `${key}.env.OMC_REVIEW_SOURCE_BUNDLE=${JSON.stringify(bundlePath)}`,
    '--config', `${key}.env.OMC_REVIEW_SOURCE_RECEIPTS=${JSON.stringify(receiptsPath)}`,
    // Every command-executing and extra tool surface is disabled for this invocation.
    ...WORKFLOW_REVIEW_CODEX_EXCLUDED_FEATURES.flatMap(feature => ['--config', `features.${feature}=false`]),
    // The multi-agent surfaces are switched off as well, so no delegated agent can widen the
    // reviewer's tools behind the reader's back.
    '--config', 'agents.enabled=false',
    '--config', 'features.multi_agent_v2=false',
    // The reader namespace is projected top-level: it bypasses deferral, stays visible in a
    // code-mode session and is kept out of any nested code-mode tool surface, so the only tools
    // the reviewer can reach are the two read-only reader tools above.
    '--config', `features.code_mode.direct_only_tool_namespaces=${JSON.stringify([WORKFLOW_REVIEW_CODEX_READER_NAMESPACE])}`,
    // A projected catalog is applied at startup only, so it must arrive as this invocation's path.
    ...(catalogPath === undefined ? [] : ['--config', `model_catalog_json=${JSON.stringify(catalogPath)}`]),
  ];
}

/** The projected catalog of one reader-only Codex invocation. */
export interface WorkflowReviewCodexCatalogProjection {
  readonly path: string;
  readonly model: string;
  readonly models: number;
  readonly bytes: number;
  readonly sha256: string;
  /** The host catalog this projection was derived from, and its content digest. */
  readonly input: WorkflowReviewDependencyDigest;
}

/** Emit one complete host catalog with exactly one selected model's tool mode projected to direct. */
function* workflowReviewCodexCatalogFragments(input: { source: string; model: string; tally: { records: number }; native?: boolean }): Generator<string> {
  yield '{';
  let first = true;
  for (const field of iterateWorkflowReviewJsonFields({ path: input.source, arrayKey: 'models' })) {
    if (!first) yield ',';
    first = false;
    yield `${JSON.stringify(field.key)}:${field.raw}`;
  }
  if (!first) yield ',';
  yield '"models":[';
  let records = 0;
  let matching = 0;
  const found = { value: false };
  for (const record of iterateWorkflowReviewJsonRecords({ path: input.source, arrayKey: 'models', found })) {
    let entry: Record<string, unknown>;
    try { entry = JSON.parse(record) as Record<string, unknown>; }
    catch { throw new Error('workflow_review_codex_catalog_unavailable'); }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.slug !== 'string' || !entry.slug) {
      throw new Error('workflow_review_codex_catalog_unavailable');
    }
    if (records) yield ',';
    records++;
    if (entry.slug === input.model) matching++;
    // Every other field of every record is preserved exactly; only the selected model's tool
    // mode changes, so the reviewer runs the binding's own model with a direct tool surface
    // instead of the code-mode-only surface the host catalog would otherwise select.
    yield JSON.stringify(entry.slug === input.model ? { ...entry, tool_mode: 'direct', ...(input.native ? { experimental_supported_tools: [] } : {}) } : entry);
  }
  // A host catalog must carry the selected model exactly once, or the projection is not this model.
  if (!found.value || !records || matching !== 1) throw new Error('workflow_review_codex_catalog_unavailable');
  input.tally.records = records;
  yield ']}';
}

/**
 * A private, collision-free suffix for one staged artifact write in this process. It is a fresh
 * identifier rather than a process-local counter: a counter restarts at zero in every process, so the
 * second process to stage into one directory would name the same path a previous process already
 * owns, and cleaning up its own failure would delete an artifact this invocation never created.
 */
function catalogStagingPath(path: string): string {
  return `${path}.staged-${randomUUID()}`;
}
/**
 * Project the host's own complete model catalog for one reader-only Codex invocation. The catalog is
 * read from, and rewritten to, disk in bounded passes: the top-level fields and each model record are
 * the only things ever held, so a catalog far larger than a buffer is projected losslessly. A host
 * catalog that is missing, unreadable, empty, malformed, or does not carry the selected model exactly
 * once is refused before any invocation is reserved.
 */
export function projectWorkflowReviewCodexCatalog(input: { source: string | undefined; path: string; model: string; preview?: boolean; native?: boolean }):
  WorkflowReviewCodexCatalogProjection {
  const source = input.source;
  const model = assertReaderConfigValue(input.model);
  const path = assertReaderConfigValue(input.path);
  if (typeof source !== 'string' || !source || source.includes('\0') || !isAbsolute(source)) {
    throw new Error('workflow_review_codex_catalog_unavailable');
  }
  const stat = lstatSync(source, { throwIfNoEntry: false });
  if (!stat || stat.isSymbolicLink() || !stat.isFile()) throw new Error('workflow_review_codex_catalog_unavailable');
  // The projection generator validates the source as it walks it; a malformed catalog is refused
  // before the destination artifact is published, so no partial projection can ever be reserved.
  // The destination is a derived per-invocation artifact rather than a frozen one, so it always
  // holds the caller's most recent valid projection: a projection superseded by a review that
  // refused before reserving its pass is replaced atomically instead of colliding with the next
  // attempt, and a refused projection leaves whatever was there before it untouched. The staging name
  // is unique to this invocation, so the cleanup below can only ever remove a file it created itself.
  const tally = { records: 0 };
  if (input.preview) {
    try {
      const hash = createHash('sha256'); let bytes = 0;
      for (const fragment of workflowReviewCodexCatalogFragments({ source, model, tally, native: input.native })) {
        const buffer = Buffer.from(fragment); hash.update(buffer); bytes += buffer.length;
      }
      return Object.freeze({ path, model, models: tally.records, bytes, sha256: hash.digest('hex'),
        input: Object.freeze({ path: source, sha256: hashWorkflowReviewArtifact(source).sha256 }) });
    } catch {
      throw new Error('workflow_review_codex_catalog_unavailable');
    }
  }
  const staged = catalogStagingPath(path);
  let projected: { bytes: number; sha256: string };
  try {
    projected = writeWorkflowReviewArtifact({ path: staged, chunks: workflowReviewCodexCatalogFragments({ source, model, tally, native: input.native }) });
    renameSync(staged, path);
  } catch {
    // Only this invocation's own uniquely named staging file is removed; a staging file left by
    // another invocation, and the destination the caller already had, are both left exactly as they are.
    try { rmSync(staged, { force: true }); } catch { /* the staged artifact was never created */ }
    throw new Error('workflow_review_codex_catalog_unavailable');
  }
  return Object.freeze({ path, model, models: tally.records, bytes: projected.bytes, sha256: projected.sha256,
    input: Object.freeze({ path: source, sha256: hashWorkflowReviewArtifact(source).sha256 }) });
}

/**
 * One typed reader qualification. It is deliberately separate from the reader build identity: a
 * build hash only names the bytes, while this record states that exactly one effective invocation
 * was actually driven over its transport. `synthetic` is an explicit label that a real run never
 * accepts, and neither that label nor `delivered` alone proves anything: every field of the
 * effective invocation below is compared against the one about to be run.
 */
export interface WorkflowReviewDependencyDigest {
  readonly path: string;
  readonly sha256: string;
}
export interface WorkflowReviewEffectiveInvocation {
  readonly controller: { readonly id: string; readonly sha256: string };
  readonly reader: { readonly id: string; readonly sha256: string; readonly dependencies: readonly WorkflowReviewDependencyDigest[] };
  readonly cli: { readonly path: string; readonly sha256: string; readonly version: string };
  readonly route: 'codex' | 'claude';
  readonly model: string;
  readonly effort: string;
  readonly auth: { readonly profile: string; readonly fingerprint: string };
  readonly catalog: { readonly input: WorkflowReviewDependencyDigest | null; readonly projected: { readonly bytes: number; readonly sha256: string } | null };
  /** Canonical fingerprint of the effective reader and tool projection. */
  readonly projection: string;
  /** The complete reader-only tool inventory the invocation exposes. */
  readonly tools: readonly string[];
}
/**
 * The evidence a reader qualification rests on. It is not a set of loose digests: every claim is a
 * bounded reference to an artifact that the controller rehashes and re-derives, the observed ledger
 * is the page stream a *client* decoded off the wire rather than the reader's own intent, and the
 * reader-intended ledger is retained beside it as separate diagnostic evidence only.
 */
export interface WorkflowReviewReaderEvidence {
  /** The frozen bundle the observed bytes were reconstructed against. */
  readonly bundleSha256: string;
  /** What the observed bytes proved: the delivered range count and the reconstruction identity. */
  readonly proof: WorkflowReviewCoverageProof;
  /** The client-observed delivery ledger: the pages the client actually received and decoded. */
  readonly observed: WorkflowReviewEvidenceArtifact;
  /** The reader-intended ledger, kept as a separate diagnostic and never the admission basis. */
  readonly intended: WorkflowReviewEvidenceArtifact;
}
export interface WorkflowReviewReaderQualification {
  readonly schemaVersion: 2;
  readonly validation: 'native' | 'synthetic';
  readonly invocation: WorkflowReviewEffectiveInvocation;
  readonly evidence: WorkflowReviewReaderEvidence;
  readonly routes: readonly ('codex' | 'claude')[];
  readonly delivered: boolean;
  readonly actorId?: string;
}
function qualificationEvidence(value: unknown): WorkflowReviewReaderEvidence {
  const code = 'workflow_review_reader_qualification_invalid';
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(code);
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some(key => !['bundleSha256', 'proof', 'observed', 'intended'].includes(key))) throw new Error(code);
  const proof = raw.proof;
  if (!proof || typeof proof !== 'object' || Array.isArray(proof)) throw new Error(code);
  const proofFields = proof as Record<string, unknown>;
  if (Object.keys(proofFields).some(key => key !== 'ranges' && key !== 'reconstructionSha256')
    || !Number.isSafeInteger(proofFields.ranges) || (proofFields.ranges as number) < 1) throw new Error(code);
  const observed = parseArtifact(raw.observed, code);
  const intended = parseArtifact(raw.intended, code);
  // The two ledgers are distinct observations of the same delivery: a record that points both at one
  // file has not separated the client's returned bytes from the reader's intent at all.
  if (observed.path === intended.path) throw new Error(code);
  return Object.freeze({ bundleSha256: qualificationDigest(raw.bundleSha256, code),
    proof: Object.freeze({ ranges: proofFields.ranges as number,
      reconstructionSha256: qualificationDigest(proofFields.reconstructionSha256, code) }),
    observed, intended });
}
function parseArtifact(value: unknown, code: string): WorkflowReviewEvidenceArtifact {
  try { return parseWorkflowReviewEvidenceArtifact(value); } catch { throw new Error(code); }
}
function qualificationDigest(value: unknown, code: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error(code);
  return value;
}
function qualificationIdentity(value: unknown, code: string): { id: string; sha256: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(code);
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some(key => key !== 'id' && key !== 'sha256')
    || typeof raw.id !== 'string' || !raw.id || raw.id.length > 120) throw new Error(code);
  return Object.freeze({ id: raw.id, sha256: qualificationDigest(raw.sha256, code) });
}
function qualificationDependencies(value: unknown, code: string): readonly WorkflowReviewDependencyDigest[] {
  if (!Array.isArray(value) || !value.length || value.length > 16) throw new Error(code);
  const parsed = value.map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(code);
    const raw = entry as Record<string, unknown>;
    if (Object.keys(raw).some(key => key !== 'path' && key !== 'sha256')
      || typeof raw.path !== 'string' || !raw.path || raw.path.length > 1000 || raw.path.includes('\0')) throw new Error(code);
    return Object.freeze({ path: raw.path, sha256: qualificationDigest(raw.sha256, code) });
  });
  return Object.freeze(parsed);
}
function qualificationInvocation(value: unknown): WorkflowReviewEffectiveInvocation {
  const code = 'workflow_review_reader_qualification_invalid';
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(code);
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some(key => !['controller', 'reader', 'cli', 'route', 'model', 'effort', 'auth', 'catalog', 'projection', 'tools'].includes(key))
    || (raw.route !== 'codex' && raw.route !== 'claude')) throw new Error(code);
  const readerRaw = raw.reader;
  if (!readerRaw || typeof readerRaw !== 'object' || Array.isArray(readerRaw)) throw new Error(code);
  const readerFields = readerRaw as Record<string, unknown>;
  if (Object.keys(readerFields).some(key => !['id', 'sha256', 'dependencies'].includes(key))) throw new Error(code);
  const cli = raw.cli;
  if (!cli || typeof cli !== 'object' || Array.isArray(cli)) throw new Error(code);
  const cliFields = cli as Record<string, unknown>;
  if (Object.keys(cliFields).some(key => !['path', 'sha256', 'version'].includes(key))
    || typeof cliFields.path !== 'string' || !cliFields.path || cliFields.path.length > 1000 || cliFields.path.includes('\0')
    || typeof cliFields.version !== 'string' || !cliFields.version || cliFields.version.length > 120) throw new Error(code);
  const auth = raw.auth;
  if (!auth || typeof auth !== 'object' || Array.isArray(auth)) throw new Error(code);
  const authFields = auth as Record<string, unknown>;
  if (Object.keys(authFields).some(key => key !== 'profile' && key !== 'fingerprint')
    || typeof authFields.profile !== 'string' || !authFields.profile || authFields.profile.length > 200) throw new Error(code);
  const catalog = raw.catalog;
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) throw new Error(code);
  const catalogFields = catalog as Record<string, unknown>;
  if (Object.keys(catalogFields).some(key => key !== 'input' && key !== 'projected')) throw new Error(code);
  const input = catalogFields.input;
  const projected = catalogFields.projected;
  let parsedInput: WorkflowReviewDependencyDigest | null = null;
  let parsedProjected: { bytes: number; sha256: string } | null = null;
  if (input !== null) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(code);
    const rawInput = input as Record<string, unknown>;
    if (Object.keys(rawInput).some(key => key !== 'path' && key !== 'sha256')
      || typeof rawInput.path !== 'string' || !rawInput.path || rawInput.path.length > 1000) throw new Error(code);
    parsedInput = Object.freeze({ path: rawInput.path, sha256: qualificationDigest(rawInput.sha256, code) });
  }
  if (projected !== null) {
    if (!projected || typeof projected !== 'object' || Array.isArray(projected)) throw new Error(code);
    const rawProjected = projected as Record<string, unknown>;
    if (Object.keys(rawProjected).some(key => key !== 'bytes' && key !== 'sha256')
      || !Number.isSafeInteger(rawProjected.bytes) || (rawProjected.bytes as number) < 1) throw new Error(code);
    parsedProjected = Object.freeze({ bytes: rawProjected.bytes as number, sha256: qualificationDigest(rawProjected.sha256, code) });
  }
  if (!Array.isArray(raw.tools) || !raw.tools.length || raw.tools.length > 32
    || raw.tools.some(tool => typeof tool !== 'string' || !tool || tool.length > 120)) throw new Error(code);
  if (typeof raw.model !== 'string' || !raw.model || raw.model.length > 120
    || typeof raw.effort !== 'string' || raw.effort.length > 60
    || typeof raw.projection !== 'string' || !/^[a-f0-9]{64}$/.test(raw.projection)) throw new Error(code);
  // The reader identity is the two fields a build identity carries; the imported dependency digests
  // are parsed separately and belong to the same reader without being part of that identity.
  const identity = qualificationIdentity({ id: readerFields.id, sha256: readerFields.sha256 }, code);
  return Object.freeze({ controller: qualificationIdentity(raw.controller, code),
    reader: Object.freeze({ ...identity, dependencies: qualificationDependencies(readerFields.dependencies, code) }),
    cli: Object.freeze({ path: cliFields.path, sha256: qualificationDigest(cliFields.sha256, code), version: cliFields.version }),
    route: raw.route, model: raw.model, effort: raw.effort,
    auth: Object.freeze({ profile: authFields.profile, fingerprint: qualificationDigest(authFields.fingerprint, code) }),
    catalog: Object.freeze({ input: parsedInput, projected: parsedProjected }),
    projection: raw.projection, tools: Object.freeze([...raw.tools] as string[]) });
}
export function parseWorkflowReviewReaderQualification(value: unknown): WorkflowReviewReaderQualification {
  const code = 'workflow_review_reader_qualification_invalid';
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(code);
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some(key => !['schemaVersion', 'validation', 'invocation', 'evidence', 'routes', 'delivered', 'actorId'].includes(key))
    || raw.schemaVersion !== 2 || (raw.validation !== 'native' && raw.validation !== 'synthetic')
    || !Array.isArray(raw.routes) || !raw.routes.length
    || raw.routes.some(route => route !== 'codex' && route !== 'claude')
    || typeof raw.delivered !== 'boolean') throw new Error(code);
  const evidence = raw.evidence;
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) throw new Error(code);
  if (raw.actorId !== undefined
    && (typeof raw.actorId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/.test(raw.actorId))) throw new Error(code);
  return Object.freeze({ schemaVersion: 2, validation: raw.validation,
    invocation: qualificationInvocation(raw.invocation), evidence: qualificationEvidence(evidence),
    routes: Object.freeze([...raw.routes]) as readonly ('codex' | 'claude')[], delivered: raw.delivered,
    ...(typeof raw.actorId === 'string' ? { actorId: raw.actorId } : {}) });
}

/**
 * Stable placeholders for the paths that no host could ever predict: the frozen bundle directory, the
 * per-attempt receipt ledger, the per-attempt projected-catalog staging file and the two per-attempt
 * reviewer result artifacts are all created by this controller, inside one attempt, under names derived
 * from the attempt number and the bundle digest. Their *content* identity is carried separately and is
 * never normalized — the reader build and its imported dependency digests, the reader module path, the
 * catalog input and projected digests, the CLI path/digest/version, the route, model, effort, auth
 * profile and fingerprint, and every flag of the prospective reviewer argv all retain their real value,
 * so a qualification for an invocation reached through another reader module, another catalog, another
 * model, effort or auth control is a different invocation and cannot match.
 */
export const WORKFLOW_REVIEW_EPHEMERAL_PLACEHOLDERS = Object.freeze({
  bundle: '<bundle-directory>', receipts: '<receipt-ledger>', catalog: '<projected-catalog>',
  schema: '<output-schema>', result: '<result-file>' });
/** The complete reader-only tool inventory of one invocation. */
export const WORKFLOW_REVIEW_READER_TOOLS: readonly string[] = TOOLS.map(tool => tool.name);
/**
 * The prospective reader projection of one invocation, before any attempt has named its own bundle or
 * ledger. It is exactly the projection the real invocation will carry — the same builder, the same
 * flags, the same module path and the same catalog presence — with only the four per-attempt paths
 * named by their placeholders, so the fingerprint below is taken over a projection that names the
 * effective invocation rather than the transient directory a particular attempt happened to use.
 */
export function workflowReviewProjectedReader(input: { route: 'codex' | 'claude'; serverPath: string; catalog: boolean }): {
  mcpConfig: string; codex: readonly string[] } {
  const paths = { serverPath: input.serverPath, bundlePath: WORKFLOW_REVIEW_EPHEMERAL_PLACEHOLDERS.bundle,
    receiptsPath: WORKFLOW_REVIEW_EPHEMERAL_PLACEHOLDERS.receipts,
    ...(input.catalog ? { catalogPath: WORKFLOW_REVIEW_EPHEMERAL_PLACEHOLDERS.catalog } : {}) };
  return input.route === 'codex'
    ? Object.freeze({ mcpConfig: workflowReviewSourceReaderConfig(paths),
        codex: Object.freeze(workflowReviewCodexReaderOverrides(paths)) })
    : Object.freeze({ mcpConfig: workflowReviewSourceReaderConfig(paths), codex: Object.freeze([]) });
}
/**
 * The canonical effective reader and tool projection of one invocation. The fingerprint names the
 * route, the reader namespace, the reader-only tool inventory, the reader projection this invocation
 * actually carries and the complete prospective reviewer argv the controller will run — so it covers
 * the real provider flags, model, effort, sandbox and tool surface, not the reader overrides alone.
 */
export function workflowReviewReaderProjection(input: {
  route: 'codex' | 'claude'; serverPath: string; catalog: boolean; reviewerArguments: readonly string[];
}): { projection: string; tools: readonly string[]; arguments: readonly string[] } {
  const projected = workflowReviewProjectedReader(input);
  const arguments_ = input.route === 'codex' ? [...projected.codex] : [projected.mcpConfig];
  const tools = WORKFLOW_REVIEW_READER_TOOLS;
  return Object.freeze({ projection: createHash('sha256').update(JSON.stringify({ route: input.route,
    namespace: WORKFLOW_REVIEW_CODEX_READER_NAMESPACE, tools, arguments: arguments_,
    reviewerArguments: input.reviewerArguments })).digest('hex'),
    tools, arguments: Object.freeze([...arguments_]) });
}
/** Assemble one typed effective-invocation identity from the fields the controller actually projects. */
export function workflowReviewEffectiveInvocation(input: {
  controller: { id: string; sha256: string };
  reader: { id: string; sha256: string; dependencies: readonly WorkflowReviewDependencyDigest[] };
  cli: { path: string; sha256: string; version: string };
  route: 'codex' | 'claude';
  model: string;
  effort?: string;
  auth: { profile: string; fingerprint: string };
  catalog: { input: WorkflowReviewDependencyDigest | null; projected: { bytes: number; sha256: string } | null };
  /** The reader module path this invocation actually names. */
  serverPath: string;
  /** Whether this invocation carries a projected model catalog at all. */
  carriesCatalog: boolean;
  /** The complete prospective reviewer argv, with only ephemeral artifact paths normalized. */
  reviewerArguments: readonly string[];
}): WorkflowReviewEffectiveInvocation {
  const projection = workflowReviewReaderProjection({ route: input.route, serverPath: input.serverPath,
    catalog: input.carriesCatalog, reviewerArguments: input.reviewerArguments });
  return Object.freeze({ controller: Object.freeze({ ...input.controller }),
    reader: Object.freeze({ ...input.reader, dependencies: Object.freeze([...input.reader.dependencies]) }),
    cli: Object.freeze({ ...input.cli }), route: input.route, model: input.model, effort: input.effort ?? '',
    auth: Object.freeze({ ...input.auth }),
    catalog: Object.freeze({ input: input.catalog.input, projected: input.catalog.projected }),
    projection: projection.projection, tools: projection.tools });
}
export interface WorkflowReviewReaderQualificationSource {
  readonly path: string;
  readonly sha256: string;
}

/**
 * Resolve the private host qualification for the effective invocation the controller is about to
 * run. A missing, unreadable, oversized, changed or malformed record refuses before any attempt,
 * pass, counter or provider start, and so does a record whose every field does not match the
 * invocation being projected: the controller build, the reader build and its imported dependency
 * digests, the CLI path/digest/version, the route, the exact model and effort, the authenticated
 * profile and fingerprint, the input and projected catalog digests, the canonical reader/tool
 * projection fingerprint and the complete reader-only tool inventory. Neither a `native` label nor
 * `delivered: true` is evidence on its own: without complete, distinct delivery and reconstruction
 * digests over a non-empty range set the qualification is refused as incomplete.
 */
export function resolveWorkflowReviewReaderQualification(input: {
  source?: WorkflowReviewReaderQualificationSource;
  allowSynthetic: boolean;
  expected: WorkflowReviewEffectiveInvocation;
}): WorkflowReviewReaderQualification {
  const qualification = readWorkflowReviewReaderQualification(input.source);
  verifyWorkflowReviewReaderQualification(qualification, input.expected, input.allowSynthetic);
  return qualification;
}

/**
 * Read, hash and parse the private reader qualification record on its own, before any caller-side
 * effect. Absence, unreadability, oversize and a changed digest refuse here; an unsupported `native`
 * record refuses here too, rather than after the caller has already projected something on its behalf.
 *
 * Saved native records never create live authority. Native workflow entry uses its privately branded
 * calibration capability instead of this file reader; a complete, internally consistent JSON claim
 * still refuses here, before projection. Historical native fields stay parseable and confer nothing.
 */
export function readWorkflowReviewReaderQualification(source?: WorkflowReviewReaderQualificationSource):
  WorkflowReviewReaderQualification {
  if (!source || typeof source.path !== 'string' || !isAbsolute(source.path)
    || typeof source.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(source.sha256)) {
    throw new Error('workflow_review_reader_qualification_required');
  }
  const stat = lstatSync(source.path, { throwIfNoEntry: false });
  if (!stat || stat.isSymbolicLink() || !stat.isFile() || stat.size > 64 * 1024) {
    throw new Error('workflow_review_reader_qualification_required');
  }
  const bytes = readFileSync(source.path);
  if (bytes.length > 64 * 1024 || createHash('sha256').update(bytes).digest('hex') !== source.sha256) {
    throw new Error('workflow_review_reader_qualification_changed');
  }
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('workflow_review_reader_qualification_invalid'); }
  const qualification = parseWorkflowReviewReaderQualification(parsed);
  if (qualification.validation === 'native') throw new Error('workflow_review_reader_qualification_required');
  return qualification;
}

/**
 * Compare one already-read qualification record with the exact effective invocation the controller is
 * about to run. Every field is compared, not just the reader build: a qualification for another model,
 * effort, route, catalog, CLI, auth profile, reader module or prospective argv is not one for the
 * invocation about to run, and neither is one recorded against another controller build. The mode was
 * already decided when the record was read, so no native claim can be admitted by this comparison.
 */
export function verifyWorkflowReviewReaderQualification(qualification: WorkflowReviewReaderQualification,
  expectedValue: WorkflowReviewEffectiveInvocation, allowSynthetic: boolean): void {
  if (qualification.validation !== 'synthetic' || !allowSynthetic) throw new Error('workflow_review_reader_qualification_required');
  const expected = expectedValue;
  if (!isDeepStrictEqual(qualification.invocation, expected)) {
    throw new Error('workflow_review_reader_qualification_mismatch');
  }
  // A reader-only inventory is required: an invocation that exposes anything beyond the two reader
  // tools, or that exposes fewer, is not the invocation this record qualifies.
  if (expected.tools.length !== WORKFLOW_REVIEW_READER_TOOLS.length
    || WORKFLOW_REVIEW_READER_TOOLS.some(tool => !expected.tools.includes(tool))) {
    throw new Error('workflow_review_reader_qualification_incomplete');
  }
  // The catalog is part of the effective invocation: a Codex run must carry a projected catalog and
  // a Claude run must not, or the tool surface the record describes is not the one being projected.
  if ((expected.route === 'codex') !== (expected.catalog.projected !== null)) {
    throw new Error('workflow_review_reader_qualification_incomplete');
  }
  if (!qualification.delivered || !qualification.routes.includes(expected.route)) {
    throw new Error('workflow_review_reader_qualification_incomplete');
  }
  if (qualification.validation === 'synthetic' && !allowSynthetic) {
    throw new Error('workflow_review_reader_qualification_required');
  }
}

/**
 * Refuse an unsupported native qualification on the exported offline path.
 *
 * This offline path cannot obtain the runtime-only native capability, so it refuses every saved native
 * claim before reading its evidence. The live native session proves its own model-facing delivery
 * against the current frozen bundle; a calibration record cannot replace that per-review proof.
 *
 * A `synthetic` record is precisely the statement that no real observation was made, so it carries no
 * delivered bytes to bind to this frozen bundle. It is passed over rather than trusted: everything a
 * synthetic review admits is admitted later, from the bytes a client actually received.
 */
export function verifyWorkflowReviewQualificationEvidence(qualification: WorkflowReviewReaderQualification,
  bundle: WorkflowReviewSourceBundle): void {
  if (qualification.validation === 'native') throw new Error('workflow_review_reader_qualification_required');
  void bundle;
}

/** Compute this module's on-disk path beside the running module. */
export function workflowReviewSourceServerPath(): string {
  return fileURLToPath(new URL('./workflow-review-source-server.js', import.meta.url));
}
/**
 * The imported modules whose bytes govern this reader: the reader's own module and the source and
 * contracts modules it is compiled against. A build hash alone only names the reader; a qualification
 * that does not also bind the dependencies the reader actually imported could describe a reader whose
 * behaviour has since changed underneath it. Resolution tolerates a source run, where the sibling is
 * the TypeScript module rather than the emitted one, so the same record is computable either way.
 */
export function workflowReviewReaderDependencies(): readonly WorkflowReviewDependencyDigest[] {
  return Object.freeze(['./workflow-review-source-server.js', './workflow-review-source.js', './workflow-contracts.js']
    .map(specifier => {
      const emitted = fileURLToPath(new URL(specifier, import.meta.url));
      const path = existsSync(emitted) ? emitted : emitted.replace(/\.js$/, '.ts');
      return Object.freeze({ path: specifier, sha256: hashWorkflowReviewArtifact(path).sha256 });
    }));
}

/** A byte framer shared by the trusted receiving ends. UTF-8 is validated before JSON parsing. */
export class WorkflowReviewFrameDecoder {
  private pending = Buffer.alloc(0);
  private ended = false;
  private failure?: { value: unknown };
  constructor(private readonly receive: (frame: Buffer) => void, private readonly limit = WORKFLOW_REVIEW_READ_LIMIT_BYTES,
    private readonly original?: (frame: Buffer) => void) {}
  write(chunk: Buffer): void {
    if (this.failure) throw this.failure.value;
    if (this.ended) throw new Error('workflow_review_transport_closed');
    try {
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const end = newline < 0 ? chunk.length : newline + 1;
      const part = chunk.subarray(offset, end);
      if (this.pending.length + part.length > this.limit) throw new Error('workflow_review_source_response_unbounded');
      this.pending = this.pending.length ? Buffer.concat([this.pending, part]) : Buffer.from(part);
      offset = end;
      if (newline < 0) break;
      const frame = this.pending; this.pending = Buffer.alloc(0);
      this.original?.(frame);
      if (!isUtf8(frame)) throw new Error('workflow_review_transport_invalid_utf8');
      this.receive(frame);
    }
    } catch (error) { this.failure = { value: error }; throw error; }
  }
  end(): void {
    if (this.failure) throw this.failure.value;
    if (this.ended) return;
    this.ended = true;
    if (this.pending.length) { this.original?.(this.pending); throw new Error('workflow_review_transport_truncated'); }
  }
}
function frameObject(frame: Buffer): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(frame.toString('utf8')); } catch { throw new Error('workflow_review_transport_invalid_frame'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('workflow_review_transport_invalid_frame');
  return value as Record<string, unknown>;
}
function wire(value: unknown): Buffer { return Buffer.from(JSON.stringify(value) + '\n'); }
function sha(bytes: string | Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }
function diagnostic(error: unknown): string {
  const value = error instanceof Error ? error.message : '';
  return /^workflow_[a-z_]{1,180}$/.test(value) ? value : 'workflow_review_transport_failed';
}
function freezeReviewValue<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeReviewValue(child);
    Object.freeze(value);
  }
  return value;
}
export interface WorkflowSyntheticReviewLaunch {
  readonly command: string;
  readonly args: string[];
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly redactionEnvironment: NodeJS.ProcessEnv;
  readonly timeoutMs: number | null;
  readonly artifactPrefix: string;
  readonly provider: 'codex' | 'claude';
  readonly collectUsage?: boolean;
  readonly superviseProcessTree?: boolean;
  readonly diagnosticOutput?: 'omit';
}
/** Mirror the closed reviewer branch in protected workflow-process.ts; bind and recheck its source. */
export function workflowSyntheticEffectiveProcess(launch: WorkflowSyntheticReviewLaunch): unknown {
  const script = isAbsolute(launch.command) && /\.(?:c?js|mjs)$/i.test(launch.command);
  const command = script ? process.execPath : launch.command;
  const args = script ? [launch.command, ...launch.args] : [...launch.args];
  const environment = { ...launch.environment };
  for (const key of Object.keys(environment)) {
    if (/^OMC_ORCHESTRATOR_|^OMC_WORKFLOW_PUBLICATION_/i.test(key)
      || launch.provider === 'codex' && /^(?:ANTHROPIC_|CLAUDE_|CLAUDECODE$|OMC_GLM_|OMC_MIMO_|GLM_|MIMO_|ZAI_|Z_AI_)/i.test(key)
      || launch.provider === 'claude' && /^(?:OPENAI_|CODEX_|OMC_GLM_|OMC_MIMO_|GLM_|MIMO_|ZAI_|Z_AI_)/i.test(key)) delete environment[key];
  }
  for (const key of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'OMC_TEAM_WORKER', 'OMC_TEAM_WORKER_NAME', 'OMC_TEAM_WORKTREE_PATH']) delete environment[key];
  environment.OMC_TEAM_WORKER_NAME = 'workflow-process'; environment.OMC_TEAM_WORKTREE_PATH = launch.cwd;
  const invocation = launch.superviseProcessTree && process.platform === 'win32'
    ? superviseWindowsWorkflowInvocation({ command, args, cwd: launch.cwd, environment })
    : { command, args, environment };
  const file = (path: string) => ({ path: realpathSync(path), ...hashWorkflowReviewArtifact(path) });
  return freezeReviewValue({ executable: file(invocation.command), interpreter: file(process.execPath),
    script: script ? file(launch.command) : null, argv: invocation.args,
    cwd: realpathSync(launch.cwd), environment: sha(JSON.stringify(Object.entries(invocation.environment).sort())),
    intendedEnvironment: sha(JSON.stringify(Object.entries(environment).sort())),
    systemRoot: process.env.SystemRoot ?? null, nodeVersion: process.version, platform: process.platform, arch: process.arch,
    timeoutMs: launch.timeoutMs, superviseProcessTree: launch.superviseProcessTree === true,
    artifactPrefix: launch.artifactPrefix, provider: launch.provider, collectUsage: launch.collectUsage === true,
    ...(launch.diagnosticOutput ? { diagnosticOutput: launch.diagnosticOutput } : {}) });
}
/** Conservative transitive closure: controller sources/native helpers and every production package tree.
 * Package trees cover opaque computed imports; package manifests/lock bind resolution. No source inventory
 * is retained: only the module graph's visited package roots and one file digest at a time are held. */
export function workflowSyntheticRuntimeClosure(compiler = false): { sha256: string; files: number } {
  if (process.execArgv.some(argument => /^-(?:r|e|p)|^--(?:eval|print|import|loader|experimental-loader)(?:=|$)/.test(argument))) {
    throw new Error('workflow_review_runtime_closure_unavailable');
  }
  let root = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(root, 'package.json'))) {
    const parent = dirname(root); if (parent === root) throw new Error('workflow_review_runtime_closure_unavailable'); root = parent;
  }
  root = realpathSync(root);
  const hash = createHash('sha256'); let files = 0;
  const add = (path: string): void => {
    const canonical = realpathSync(path); const file = new WorkflowReviewOwnedFile(dirname(canonical), canonical.slice(dirname(canonical).length + 1));
    try { const proof = file.seal(); hash.update(JSON.stringify({ path: canonical, bytes: proof.bytes, sha256: proof.sha256 }) + '\n'); files++; }
    finally { file.close(); }
  };
  const tree = (directory: string, controllerSources = false): void => {
    const opened = opendirSync(directory);
    try {
      for (;;) {
        const entry = opened.readSync(); if (!entry) break;
        if (entry.name === 'node_modules' || entry.name === '.git' || controllerSources && entry.name === '__tests__') continue;
        const path = join(directory, entry.name);
        if (entry.isSymbolicLink()) throw new Error('workflow_review_runtime_closure_unavailable');
        if (entry.isDirectory()) tree(path, controllerSources); else if (entry.isFile()) add(path);
        else throw new Error('workflow_review_runtime_closure_unavailable');
      }
    } finally { opened.closeSync(); }
  };
  // The package graph is independent of the reviewed inventory and holds package roots only.
  const visited = new Set<string>();
  const namedPackage = (resolved: string, name: string): string => {
    let location = dirname(resolved);
    for (;;) {
      const manifest = join(location, 'package.json');
      if (existsSync(manifest) && JSON.parse(readFileSync(manifest, 'utf8')).name === name) return location;
      const parent = dirname(location);
      if (parent === location) throw new Error('workflow_review_runtime_closure_unavailable');
      location = parent;
    }
  };
  const packageTree = (directory: string): void => {
    const canonical = realpathSync(directory); if (visited.has(canonical)) return; visited.add(canonical);
    const manifestPath = join(canonical, 'package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string>; peerDependencies?: Record<string, string> };
    tree(canonical);
    const resolveFrom = createRequire(manifestPath);
    for (const name of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies, ...manifest.peerDependencies }).sort()) {
      let resolved: string;
      try { resolved = resolveFrom.resolve(`${name}/package.json`); }
      catch {
        try {
          resolved = resolveFrom.resolve(name);
          let location = dirname(resolved);
          while (!existsSync(join(location, 'package.json')) || JSON.parse(readFileSync(join(location, 'package.json'), 'utf8')).name !== name) {
            const parent = dirname(location); if (parent === location) throw new Error('missing'); location = parent;
          }
          resolved = join(location, 'package.json');
        } catch {
          if (manifest.dependencies?.[name] && !manifest.optionalDependencies?.[name]) throw new Error('workflow_review_runtime_closure_unavailable');
          hash.update(`absent:${canonical}:${name}\n`); continue;
        }
      }
      packageTree(namedPackage(resolved, name));
    }
  };
  add(join(root, 'package.json')); if (existsSync(join(root, 'package-lock.json'))) add(join(root, 'package-lock.json'));
  for (const directory of ['src', 'native']) if (existsSync(join(root, directory))) tree(join(root, directory), true);
  if (!fileURLToPath(import.meta.url).endsWith('.ts') && existsSync(join(root, 'dist'))) tree(join(root, 'dist'));
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
  const resolveFrom = createRequire(join(root, 'package.json'));
  for (let index = 0; index < process.execArgv.length; index++) {
    const argument = process.execArgv[index]!;
    if (!/^--require(?:=|$)/.test(argument)) continue;
    const target = argument.includes('=') ? argument.slice(argument.indexOf('=') + 1) : process.execArgv[++index];
    // This explicitly supported bootstrap is a closed diagnostic filter, not a general loader.
    // Absolute canonical entry custody avoids Node's cwd-dependent --require resolution entirely.
    if (!target || !isAbsolute(target) || !/\.(?:cjs|js)$/.test(target) || realpathSync(target) !== resolve(target)) {
      throw new Error('workflow_review_runtime_closure_unavailable');
    }
    const entry = realpathSync(target);
    const file = new WorkflowReviewOwnedFile(dirname(entry), entry.slice(dirname(entry).length + 1));
    let failed = false;
    try {
      const before = file.seal();
      if (before.bytes > 65536) throw new Error('workflow_review_runtime_closure_unavailable');
      const bytes = file.read(0, before.bytes);
      if (!isUtf8(bytes) || sha(bytes) !== before.sha256) throw new Error('workflow_review_runtime_closure_unavailable');
      const { parse, Lang } = resolveFrom('@ast-grep/napi') as typeof import('@ast-grep/napi');
      const syntax = parse(Lang.JavaScript, bytes.toString('utf8')).root();
      const declarations = syntax.findAll({ rule: { kind: 'variable_declarator' } });
      const functions = syntax.findAll({ rule: { kind: 'function_expression' } });
      const arrays = syntax.findAll({ rule: { kind: 'array' } });
      const set = declarations[0]?.field('name')?.text();
      const parameters = functions[0]?.field('parameters')?.children().filter(node => node.kind() === 'identifier').map(node => node.text());
      const names = [set, ...(parameters ?? [])];
      if (declarations.length !== 2 || functions.length !== 1 || arrays.length !== 1 || names.length !== 3
        || names.some(name => !name || !/^[$A-Z_a-z][$\w]*$/.test(name) || ['emit', 'process', 'Set', 'Reflect', 'arguments'].includes(name))
        || new Set(names).size !== 3
        || arrays[0]!.children().some(node => !['[', ']', ',', 'string', 'comment'].includes(node.kind()))) {
        throw new Error('workflow_review_runtime_closure_unavailable');
      }
      const [event, warning] = parameters!;
      const expected = parse(Lang.JavaScript, `const ${set} = new Set([]); const { emit } = process;
        process.emit = function (${event}, ${warning}) {
          if (${event} === 'warning' && ${set}.has(${warning}.message)) { return; }
          return Reflect.apply(emit, this, arguments);
        };`).root();
      const shape = (node: typeof syntax): string => node.kind() === 'array' ? 'literal-array'
        : node.children().length ? `${node.kind()}(${node.children().filter(child => child.kind() !== 'comment' && child.kind() !== ';').map(shape).join(',')})`
          : `${node.kind()}:${node.text()}`;
      if (shape(syntax) !== shape(expected)) throw new Error('workflow_review_runtime_closure_unavailable');
      // Seal the actual entry even when a containing package walk excludes its directory.
      hash.update(JSON.stringify({ path: entry, bytes: before.bytes, sha256: before.sha256 }) + '\n'); files++;
    } catch (error) { failed = true; throw error; }
    finally { if (failed) { try { file.close(); } catch { /* preserve the closure refusal */ } } else file.close(); }
  }
  hash.update(JSON.stringify(process.execArgv));
  for (const name of [...Object.keys(manifest.dependencies ?? {}), ...(compiler ? ['esbuild'] : [])].sort()) {
    let entry: string;
    try { entry = resolveFrom.resolve(`${name}/package.json`); }
    catch {
      try { entry = resolveFrom.resolve(name); } catch { throw new Error('workflow_review_runtime_closure_unavailable'); }
      let location = dirname(entry);
      while (!existsSync(join(location, 'package.json')) || JSON.parse(readFileSync(join(location, 'package.json'), 'utf8')).name !== name) {
        const parent = dirname(location); if (parent === location) throw new Error('workflow_review_runtime_closure_unavailable'); location = parent;
      }
      entry = join(location, 'package.json');
    }
    packageTree(namedPackage(entry, name));
  }
  return Object.freeze({ sha256: hash.digest('hex'), files });
}
export interface WorkflowSyntheticReviewClientFactory { readonly mode: 'synthetic' }
export interface WorkflowSyntheticReviewCapsule {
  readonly reviewer: string; readonly reader: string; readonly bridge: string;
}
interface SyntheticCapsuleRecord {
  readonly pins: readonly { path: string; sha256: string }[];
  readonly buildClosure: { sha256: string; files: number };
}
const syntheticCapsules = new WeakMap<WorkflowSyntheticReviewCapsule, SyntheticCapsuleRecord>();
/** Explicit synthetic setup only. The controller owns the templates, compiler recipe and outputs. */
export async function buildWorkflowSyntheticReviewCapsule(directory: string, faultReader = false): Promise<WorkflowSyntheticReviewCapsule> {
  for (const [key, value] of Object.entries(process.env)) {
    if (value && /^(?:NODE_OPTIONS|NODE_PATH|ESBUILD_BINARY_PATH)$/i.test(key)) throw new Error('workflow_review_runtime_closure_unavailable');
  }
  const buildClosure = workflowSyntheticRuntimeClosure(true);
  const { build } = await import('esbuild');
  const { parse, Lang } = await import('@ast-grep/napi');
  mkdirSync(directory);
  const root = realpathSync(directory);
  const source = fileURLToPath(import.meta.url);
  const sourceModule = fileURLToPath(new URL(source.endsWith('.ts') ? './workflow-review-source.ts' : './workflow-review-source.js', import.meta.url));
  const observed = new Map<string, string>();
  const pins: { path: string; sha256: string }[] = [];
  const capsule = Object.freeze({ reviewer: join(root, 'reviewer.mjs'), reader: join(root, 'reader.mjs'), bridge: join(root, 'bridge.mjs') });
  for (const [name, contents] of [
    ['reviewer', SYNTHETIC_REVIEWER_SCRIPT],
    ['reader', faultReader ? SYNTHETIC_CORRUPT_READER_SCRIPT : "import { runWorkflowReviewSourceServer } from 'omc-synthetic-reader'; await runWorkflowReviewSourceServer();"],
    ['bridge', "export { connectWorkflowSyntheticReviewBridge } from 'omc-synthetic-reader';"],
  ] as const) {
    const result = await build({ stdin: { contents, sourcefile: `controller-${name}.mjs`, resolveDir: dirname(source), loader: 'js' },
      bundle: true, platform: 'node', format: 'esm', target: 'node20', write: false, metafile: true,
      define: { OMC_SYNTHETIC_LIBRARY: 'true' }, external: ['esbuild', '@ast-grep/napi'], logLevel: 'silent',
      plugins: [{ name: 'closed-controller-synthetic-inputs', setup(builder) {
        builder.onResolve({ filter: /^omc-synthetic-(?:reader|source)$/ }, args => ({ path: args.path.endsWith('reader') ? source : sourceModule }));
        builder.onLoad({ filter: /\.(?:[cm]?js|ts|json)$/ }, args => {
          const path = realpathSync(args.path); const file = new WorkflowReviewOwnedFile(dirname(path), path.slice(dirname(path).length + 1));
          let bytes: Buffer;
          try {
            const before = file.seal(); bytes = readFileSync(path);
            if (sha(bytes) !== before.sha256) throw new Error('workflow_review_prepared_launch_changed');
            if (observed.has(path) && observed.get(path) !== before.sha256) throw new Error('workflow_review_prepared_launch_changed');
            observed.set(path, before.sha256);
          } finally { file.close(); }
          return { contents: bytes, loader: path.endsWith('.ts') ? 'ts' : path.endsWith('.json') ? 'json' : 'js' };
        });
      } }],
    });
    if (result.warnings.length || !result.metafile || result.outputFiles.length !== 1) throw new Error('workflow_review_runtime_closure_unavailable');
    for (const output of Object.values(result.metafile.outputs)) {
      if (output.imports.some(edge => !edge.external || !isBuiltin(edge.path))) throw new Error('workflow_review_runtime_closure_unavailable');
    }
    const output = result.outputFiles[0]!;
    const syntax = parse(Lang.JavaScript, output.text).root();
    if (syntax.find({ rule: { kind: 'ERROR' } })) throw new Error('workflow_review_runtime_closure_unavailable');
    for (const call of syntax.findAll({ rule: { kind: 'call_expression' } })) {
      const callee = call.field('function')?.text();
      if (callee === 'import' || callee === 'require' || callee === '__require' || callee === 'createRequire'
        || callee?.endsWith('.require')) throw new Error('workflow_review_runtime_closure_unavailable');
    }
    const path = capsule[name]; const owned = new WorkflowReviewOwnedFile(root, path.slice(root.length + 1), true);
    try {
      for (let offset = 0; offset < output.contents.length; offset += 65536) owned.append(Buffer.from(output.contents.subarray(offset, offset + 65536)));
      pins.push({ path, sha256: owned.seal().sha256 });
    } finally { owned.close(); }
  }
  for (const [path, sha256] of observed) {
    if (hashWorkflowReviewArtifact(path).sha256 !== sha256) throw new Error('workflow_review_prepared_launch_changed');
    pins.push({ path, sha256 });
  }
  if (!isDeepStrictEqual(workflowSyntheticRuntimeClosure(true), buildClosure)) throw new Error('workflow_review_prepared_launch_changed');
  syntheticCapsules.set(capsule, freezeReviewValue({ pins, buildClosure }));
  return capsule;
}
interface SyntheticFactoryPins {
  readonly reviewer: string;
  readonly reader: string;
  readonly bridge: string;
  readonly pins: readonly { path: string; sha256: string }[];
  readonly binding: WorkflowRoleBinding;
  readonly cwd: string;
  readonly catalogSource?: string;
  readonly capsule: SyntheticCapsuleRecord;
}
const syntheticFactories = new WeakMap<WorkflowSyntheticReviewClientFactory, SyntheticFactoryPins>();
const syntheticFactoryPins = new WeakSet<SyntheticFactoryPins>();
/** Only a runtime caller can select this closed synthetic implementation. No JSON record creates it. */
export function createWorkflowSyntheticReviewClientFactory(input: {
  capsule: WorkflowSyntheticReviewCapsule; binding: WorkflowRoleBinding; cwd: string;
  catalogSource?: string;
}): WorkflowSyntheticReviewClientFactory {
  const capsule = syntheticCapsules.get(input.capsule);
  if (!capsule) throw new Error('workflow_review_runtime_closure_unavailable');
  const paths = [input.capsule.reviewer, input.capsule.reader, input.capsule.bridge, process.execPath];
  const factory = Object.freeze({ mode: 'synthetic' as const });
  const pins = Object.freeze({ reviewer: realpathSync(input.capsule.reviewer), reader: realpathSync(input.capsule.reader),
    bridge: realpathSync(input.capsule.bridge), capsule, pins: [...capsule.pins, ...paths.map(path => Object.freeze({ path: realpathSync(path), sha256: hashWorkflowReviewArtifact(path).sha256 }))],
    binding: freezeReviewValue(structuredClone(input.binding)), cwd: realpathSync(input.cwd), catalogSource: input.catalogSource });
  syntheticFactoryPins.add(pins); syntheticFactories.set(factory, pins);
  return factory;
}
export function requireWorkflowSyntheticReviewClientFactory(factory: WorkflowSyntheticReviewClientFactory | undefined): void {
  if (!factory || !syntheticFactories.has(factory)) throw new Error('workflow_review_reader_observation_required');
}
export interface WorkflowSyntheticReviewPlan {
  readonly invocationId: string;
  readonly reviewerId: string;
  readonly directory: string;
  readonly bundlePath: string;
  readonly receiptsPath: string;
  readonly relay: string;
  readonly token: string;
}
export function planWorkflowSyntheticReview(input: Omit<WorkflowSyntheticReviewPlan, 'relay' | 'token'>): WorkflowSyntheticReviewPlan {
  return Object.freeze({ ...input, relay: process.platform === 'win32' ? `\\\\.\\pipe\\omc-review-${input.invocationId}`
    : join(tmpdir(), `omcr-${input.invocationId}.sock`), token: randomUUID() });
}
interface SyntheticCorrelation {
  invocationId: string; reviewerId: string; effectiveInvocationDigest: string;
  sequence: number; direction: 'request' | 'receive' | 'ack' | 'control';
  frame: { offset: number; bytes: number; sha256: string };
}
interface SyntheticPending { sequence: number; request: Record<string, unknown>; response?: Buffer }
export interface WorkflowSyntheticReviewProof {
  readonly invocationId: string; readonly reviewerId: string; readonly effectiveInvocationDigest: string;
  readonly capture: WorkflowReviewOwnedReference; readonly correlation: WorkflowReviewOwnedReference;
  readonly proof: WorkflowReviewOwnedReference; readonly ranges: number; readonly reconstructionSha256: string;
  readonly native?: WorkflowNativeReviewTraceProof;
}
const syntheticCompletions = new WeakMap<object, WorkflowSyntheticReviewSession>();

/** One connected reviewer, one owned reader, and one outstanding request. */
export class WorkflowSyntheticReviewSession {
  readonly launch: WorkflowSyntheticReviewLaunch;
  readonly effectiveInvocationDigest: string;
  private readonly effectiveProcess: unknown;
  private readonly runtimeClosure: { sha256: string; files: number };
  private readonly files: readonly { path: string; sha256: string }[];
  private readonly readerLaunch: { command: string; args: string[]; cwd: string; environment: NodeJS.ProcessEnv };
  private capture?: WorkflowReviewOwnedFile;
  private correlations?: WorkflowReviewOwnedFile;
  private coverage?: WorkflowReviewCoverageMachine;
  private child?: ChildProcessWithoutNullStreams;
  private childClosed: Promise<void> = Promise.resolve();
  private childDone = false;
  private server?: NetServer;
  private listenerStarted = false;
  private serverClosed: Promise<void> = Promise.resolve();
  private peer?: Socket;
  private peerClosed: Promise<void> = Promise.resolve();
  private pending?: SyntheticPending;
  private sequence = 0;
  private initialized = false;
  private listed = false;
  private connected = false;
  private finishing = false;
  private completed = false;
  private failure = { present: false, value: undefined as unknown };
  private integrityFailure = { present: false, value: undefined as unknown };
  private firstError = { present: false, value: undefined as unknown };
  private readerDecoder?: WorkflowReviewFrameDecoder;
  private peerDecoder?: WorkflowReviewFrameDecoder;
  private settlement?: Promise<void>;
  private sealed?: { capture: WorkflowReviewOwnedReference; correlation: WorkflowReviewOwnedReference };
  constructor(readonly plan: WorkflowSyntheticReviewPlan, private readonly pins: SyntheticFactoryPins,
    launch: WorkflowSyntheticReviewLaunch, private readonly bundle: () => WorkflowReviewSourceBundle,
    files: readonly { path: string; sha256: string }[], private readonly artifacts: readonly { path: string; sha256: string }[]) {
    if (!syntheticFactoryPins.has(pins)) throw new Error('workflow_review_reader_observation_required');
    freezeReviewValue(plan);
    this.launch = freezeReviewValue(launch); this.files = freezeReviewValue([...files]); freezeReviewValue(artifacts);
    this.runtimeClosure = workflowSyntheticRuntimeClosure(true);
    if (!isDeepStrictEqual(this.runtimeClosure, pins.capsule.buildClosure)) throw new Error('workflow_review_prepared_launch_changed');
    this.readerLaunch = freezeReviewValue({ command: process.execPath, args: [pins.reader], cwd: launch.cwd,
      environment: { ...launch.environment, OMC_REVIEW_SOURCE_BUNDLE: plan.bundlePath, OMC_REVIEW_SOURCE_RECEIPTS: plan.receiptsPath,
        OMC_REVIEW_SOURCE_METRICS: join(plan.directory, 'reader-resources.json') } });
    this.effectiveProcess = workflowSyntheticEffectiveProcess(launch);
    this.effectiveInvocationDigest = sha(JSON.stringify({ invocationId: plan.invocationId, reviewerId: plan.reviewerId,
      process: this.effectiveProcess, closure: this.runtimeClosure, build: pins.capsule.buildClosure, files, artifacts,
      reader: { command: this.readerLaunch.command, args: this.readerLaunch.args, cwd: this.readerLaunch.cwd,
        environment: sha(JSON.stringify(Object.entries(this.readerLaunch.environment).sort())) }, bridge: pins.bridge, relay: plan.relay,
      bundle: plan.bundlePath, receipts: plan.receiptsPath }));
  }
  revalidate(materialized = false): void {
    if (!isDeepStrictEqual(workflowSyntheticEffectiveProcess(this.launch), this.effectiveProcess)) throw new Error('workflow_review_prepared_launch_changed');
    for (const pin of [...this.pins.pins, ...this.files, ...(materialized ? this.artifacts : [])]) {
      if (realpathSync(pin.path) !== pin.path) throw new Error('workflow_review_prepared_launch_changed');
      const file = new WorkflowReviewOwnedFile(dirname(pin.path), pin.path.slice(dirname(pin.path).length + 1));
      let failed = false;
      try { if (file.seal().sha256 !== pin.sha256) throw new Error('workflow_review_prepared_launch_changed'); }
      catch (error) { failed = true; throw error; }
      finally { if (failed) { try { file.close(); } catch { /* preserve the first failure */ } } else file.close(); }
    }
    if (!isDeepStrictEqual(workflowSyntheticRuntimeClosure(true), this.runtimeClosure)) throw new Error('workflow_review_prepared_launch_changed');
  }
  assertHealthy = (): void => { if (this.firstError.present) throw this.firstError.value; };
  get integrityDiagnostic(): string | undefined { return this.firstError.present ? diagnostic(this.firstError.value) : undefined; }
  private fail(error: unknown): void {
    if (!this.firstError.present) this.firstError = { present: true, value: error };
    if (!this.failure.present) this.failure = { present: true, value: error };
    if (this.peer && !this.peer.destroyed && !this.peer.writableEnded) this.peer.end(wire({ failure: diagnostic(this.failure.value) }));
    if (this.child && !this.childDone) this.child.kill();
  }
  private record(direction: SyntheticCorrelation['direction'], sequence: number, frame: Buffer,
    captured?: SyntheticCorrelation['frame']): void {
    const reference = captured ?? this.capture!.append(frame);
    this.correlations!.append(wire({ invocationId: this.plan.invocationId, reviewerId: this.plan.reviewerId,
      effectiveInvocationDigest: this.effectiveInvocationDigest, sequence, direction, frame: reference } satisfies SyntheticCorrelation));
  }
  private write(destination: NodeJS.WritableStream, frame: Buffer): void {
    try { destination.write(frame, error => { if (error) this.fail(error); }); } catch (error) { this.fail(error); }
  }
  async start(): Promise<void> {
    this.revalidate(true);
    mkdirSync(this.plan.directory);
    this.capture = new WorkflowReviewOwnedFile(this.plan.directory, 'frames.bin', true);
    this.correlations = new WorkflowReviewOwnedFile(this.plan.directory, 'correlation.jsonl', true);
    this.coverage = new WorkflowReviewCoverageMachine(this.bundle(), { directory: join(this.plan.directory, 'reconstruction'),
      invocationId: this.plan.invocationId, reviewerId: this.plan.reviewerId, effectiveInvocationDigest: this.effectiveInvocationDigest });
    this.server = createServer(peer => this.attach(peer));
    this.serverClosed = new Promise(resolveClose => this.server!.once('close', resolveClose));
    this.server.on('error', error => this.fail(error));
    await new Promise<void>((resolveListen, reject) => {
      this.server!.once('error', reject); this.server!.listen(this.plan.relay, () => { this.listenerStarted = true; this.server!.removeListener('error', reject); resolveListen(); });
    });
  }
  private attach(peer: Socket): void {
    if (this.peer) { peer.destroy(); this.fail(new Error('workflow_review_transport_duplicate_peer')); return; }
    this.peer = peer; this.peerClosed = new Promise(resolveClose => peer.once('close', resolveClose));
    let captured: SyntheticCorrelation['frame'] | undefined;
    this.peerDecoder = new WorkflowReviewFrameDecoder(frame => {
      const message = frameObject(frame);
      if (!this.connected) {
        if (message.token !== this.plan.token || message.invocationId !== this.plan.invocationId) throw new Error('workflow_review_transport_identity_mismatch');
        this.connected = true; this.spawnReader(); this.write(peer, wire({ ready: this.plan.invocationId })); return;
      }
      if (message.complete === true) {
        if (this.pending || !this.initialized || !this.listed) throw new Error('workflow_review_transport_incomplete');
        this.record('control', this.sequence, frame, captured);
        this.finishing = true;
        this.child!.stdin.end();
        void this.childClosed.then(() => {
          if (this.failure.present) throw this.failure.value;
          this.completed = true; this.write(peer, wire({ settled: this.plan.invocationId })); peer.end();
        }).catch(error => this.fail(error));
        return;
      }
      if ('ack' in message) {
        const pending = this.pending;
        if (!pending?.response || message.ack !== pending.sequence || message.requestId !== pending.request.id
          || typeof message.requestId !== typeof pending.request.id || message.sha256 !== sha(pending.response)) throw new Error('workflow_review_transport_ack_mismatch');
        this.record('ack', pending.sequence, frame, captured);
        const response = frameObject(pending.response);
        const receipt = this.receipt(pending.request, response);
        if (receipt && !this.integrityFailure.present) {
          try { this.coverage!.record(receipt, pending.sequence); }
          catch (error) {
            this.integrityFailure = { present: true, value: error };
            if (!this.firstError.present) this.firstError = { present: true, value: error };
          }
        }
        this.pending = undefined; return;
      }
      if (message.method === 'notifications/initialized' && message.id === undefined && this.initialized && !this.pending) {
        this.record('control', this.sequence, frame, captured);
        this.write(this.child!.stdin, frame); return;
      }
      if (this.failure.present) throw this.failure.value;
      if (this.finishing || this.pending || message.jsonrpc !== '2.0' || !Number.isSafeInteger(message.id)
        || message.id !== this.sequence + 1 || !['initialize', 'tools/list', 'tools/call'].includes(String(message.method))) throw new Error('workflow_review_transport_request_mismatch');
      if (message.method === 'initialize' ? this.initialized : !this.initialized) throw new Error('workflow_review_transport_request_mismatch');
      if (message.method === 'tools/call') {
        if (!this.listed) throw new Error('workflow_review_reader_observation_incomplete');
        const params = message.params as Record<string, unknown>;
        if (!params || !WORKFLOW_REVIEW_READER_TOOLS.includes(String(params.name))) throw new Error('workflow_review_transport_request_mismatch');
        readerArguments(String(params.name), params.arguments);
      }
      const sequence = ++this.sequence; this.pending = { sequence, request: message };
      this.record('request', sequence, frame, captured); this.write(this.child!.stdin, frame);
    }, WORKFLOW_REVIEW_READ_LIMIT_BYTES, frame => { captured = this.connected ? this.capture!.append(frame) : undefined; });
    peer.on('data', chunk => { try { this.peerDecoder!.write(chunk); } catch (error) { this.fail(error); } });
    peer.on('error', error => this.fail(error));
    peer.on('end', () => { try { this.peerDecoder!.end(); if (!this.finishing) throw new Error('workflow_review_transport_eof'); } catch (error) { this.fail(error); } });
    peer.on('close', () => { if (!this.finishing && !this.failure.present) this.fail(new Error('workflow_review_transport_eof')); });
  }
  private spawnReader(): void {
    this.child = spawn(this.readerLaunch.command, this.readerLaunch.args, { cwd: this.readerLaunch.cwd,
      env: this.readerLaunch.environment,
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.childClosed = new Promise(resolveClose => this.child!.once('close', (code, signal) => {
      this.childDone = true;
      if (!this.finishing || code !== 0 || signal !== null) this.fail(new Error('workflow_review_reader_process_failed'));
      resolveClose();
    }));
    this.readerDecoder = new WorkflowReviewFrameDecoder(frame => {
      // Original bytes enter custody before parsing, including a malformed or unmatched response.
      const pending = this.pending;
      if (!pending || pending.response) throw new Error('workflow_review_transport_response_mismatch');
      const response = frameObject(frame);
      if (response.jsonrpc !== '2.0' || response.id !== pending.request.id || typeof response.id !== typeof pending.request.id) throw new Error('workflow_review_transport_response_mismatch');
      if (pending.request.method === 'initialize') this.initialized = true;
      if (pending.request.method === 'tools/list') {
        const tools = (response.result as { tools?: { name: string }[] } | undefined)?.tools;
        if (!tools || tools.length !== WORKFLOW_REVIEW_READER_TOOLS.length || tools.some((tool, index) => tool.name !== WORKFLOW_REVIEW_READER_TOOLS[index])) throw new Error('workflow_review_reader_observation_incomplete');
        this.listed = true;
      }
      pending.response = frame; this.write(this.peer!, frame);
    }, WORKFLOW_REVIEW_READ_LIMIT_BYTES, frame => this.record('receive', this.pending?.sequence ?? this.sequence, frame));
    this.child.stdout.on('data', chunk => { try { this.readerDecoder!.write(chunk); } catch (error) { this.fail(error); } });
    this.child.stdout.on('end', () => { try { this.readerDecoder!.end(); if (!this.finishing || this.pending) throw new Error('workflow_review_transport_eof'); } catch (error) { this.fail(error); } });
    this.child.on('error', error => this.fail(error));
    this.child.stdin.on('error', error => this.fail(error)); this.child.stdout.on('error', error => this.fail(error));
    this.child.stdin.on('close', () => { if (!this.finishing && !this.failure.present) this.fail(new Error('workflow_review_transport_eof')); });
    this.child.stdout.on('close', () => { try { this.readerDecoder!.end(); if (!this.finishing || this.pending) throw new Error('workflow_review_transport_eof'); } catch (error) { this.fail(error); } });
    this.child.stderr.on('error', error => this.fail(error)); this.child.stderr.resume();
  }
  private receipt(request: Record<string, unknown>, response: Record<string, unknown>): WorkflowReviewSourceReceipt | undefined {
    if ('error' in response) throw new Error('workflow_review_reader_rpc_error');
    if (request.method !== 'tools/call') return undefined;
    const result = response.result as { content?: { type: string; text: string }[]; isError?: boolean };
    if (!result || result.isError || result.content?.length !== 1 || result.content[0]!.type !== 'text') throw new Error('workflow_review_reader_refused');
    const page = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
    const params = request.params as { name: string; arguments?: { id?: string; cursor?: string } };
    if (!Number.isSafeInteger(page.totalBytes) || Number(page.totalBytes) < 0
      || !Number.isSafeInteger(page.offset) || Number(page.offset) < 0
      || !Number.isSafeInteger(page.bytes) || Number(page.bytes) < 0
      || page.kind !== (params.name === WORKFLOW_REVIEW_READER_TOOL_MANIFEST ? 'manifest' : 'entry')
      || page.id !== (params.arguments?.id ?? null) || page.complete !== (page.cursor === null)
      || (!params.arguments?.cursor && page.offset !== 0)) throw new Error('workflow_review_transport_range_mismatch');
    if (page.totalBytes !== workflowReviewSourceObjectBytes(this.bundle(), page.kind, page.id)) throw new Error('workflow_review_transport_range_mismatch');
    const cursorOffset = (cursor: unknown): number => {
      if (typeof cursor !== 'string' || cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error('workflow_review_transport_range_mismatch');
      const decoded = frameObject(Buffer.from(Buffer.from(cursor, 'base64url').toString('utf8')));
      if (decoded.v !== 1 || decoded.b !== this.bundle().digest.slice(0, 32) || decoded.k !== page.kind || decoded.i !== page.id
        || !Number.isSafeInteger(decoded.o) || Number(decoded.o) < 0) throw new Error('workflow_review_transport_range_mismatch');
      return decoded.o as number;
    };
    if (params.arguments?.cursor && cursorOffset(params.arguments.cursor) !== page.offset
      || page.cursor !== null && cursorOffset(page.cursor) !== Number(page.offset) + Number(page.bytes)
      || page.complete && Number(page.offset) + Number(page.bytes) !== page.totalBytes
      || !page.complete && Number(page.offset) + Number(page.bytes) >= Number(page.totalBytes)) throw new Error('workflow_review_transport_range_mismatch');
    return workflowReviewSourceReceipt(page as unknown as Parameters<typeof workflowReviewSourceReceipt>[0]);
  }
  /** All owned closes join in finally; timers may kill a child, never stand in for its close. */
  settle(): Promise<void> {
    if (this.settlement) return this.settlement;
    this.settlement = (async () => {
      if (!this.completed) this.fail(new Error('workflow_review_transport_incomplete'));
      if (this.child && !this.childDone) this.child.kill();
      const timer = setTimeout(() => { if (this.child && !this.childDone) this.child.kill('SIGKILL'); }, 5000); timer.unref();
      try { await this.childClosed; } finally { clearTimeout(timer); }
      if (this.peer && !this.peer.destroyed) this.peer.destroy();
      await this.peerClosed;
      if (this.listenerStarted) { this.server!.close(); await this.serverClosed; }
      try { if (this.capture && this.correlations) this.sealed = { capture: this.capture.seal(), correlation: this.correlations.seal() }; }
      catch (error) { this.fail(error); }
      try { this.capture?.close(); } catch (error) { this.fail(error); }
      try { this.correlations?.close(); } catch (error) { this.fail(error); }
    })();
    return this.settlement;
  }
  completion(): object {
    this.assertHealthy();
    if (!this.completed || !this.sealed) throw new Error('workflow_review_transport_incomplete');
    const handle = Object.freeze({}); syntheticCompletions.set(handle, this); return handle;
  }
  dispose(): void { this.coverage?.dispose(); }
  prove(handle: object, attestation: unknown): WorkflowSyntheticReviewProof {
    if (syntheticCompletions.get(handle) !== this || !this.sealed) throw new Error('workflow_review_transport_completion_required');
    syntheticCompletions.delete(handle); this.assertHealthy();
    let replay: WorkflowReviewCoverageMachine | undefined;
    let frames: WorkflowReviewOwnedFile | undefined; let records: WorkflowReviewOwnedFile | undefined;
    let originalProof: WorkflowReviewOwnedFile | undefined;
    let failure: { value: unknown } | undefined; let result: WorkflowSyntheticReviewProof | undefined;
    try {
      this.revalidate(true);
      const parsed = assertWorkflowReviewCoverageAttribution(this.bundle(), attestation, this.plan.reviewerId);
      this.coverage!.finish(parsed);
      const proof = this.coverage!.retainedProof;
      const references = { ...this.sealed, proof };
      verifyWorkflowReviewOwnedReference(this.plan.directory, references.capture);
      verifyWorkflowReviewOwnedReference(this.plan.directory, references.correlation);
      replay = new WorkflowReviewCoverageMachine(this.bundle(), { directory: join(this.plan.directory, 'replay'),
        invocationId: this.plan.invocationId, reviewerId: this.plan.reviewerId, effectiveInvocationDigest: this.effectiveInvocationDigest });
      frames = new WorkflowReviewOwnedFile(this.plan.directory, references.capture.name);
      records = new WorkflowReviewOwnedFile(this.plan.directory, references.correlation.name);
      let pending: SyntheticPending | undefined; let sequence = 0; let frameOffset = 0; let replayComplete = false;
      const decoder = new WorkflowReviewFrameDecoder(line => {
        const record = frameObject(line) as unknown as SyntheticCorrelation;
        if (record.invocationId !== this.plan.invocationId || record.reviewerId !== this.plan.reviewerId
          || record.effectiveInvocationDigest !== this.effectiveInvocationDigest || record.frame.offset !== frameOffset) throw new Error('workflow_review_evidence_corrupt');
        const frame = frames!.read(record.frame.offset, record.frame.bytes); frameOffset += frame.length;
        if (sha(frame) !== record.frame.sha256 || !isUtf8(frame) || frame.at(-1) !== 10) throw new Error('workflow_review_evidence_corrupt');
        const message = frameObject(frame);
        if (record.direction === 'control') {
          if (pending || replayComplete || record.sequence !== sequence) throw new Error('workflow_review_evidence_corrupt');
          if (message.complete === true) replayComplete = true;
          else if (message.method !== 'notifications/initialized' || message.id !== undefined) throw new Error('workflow_review_evidence_corrupt');
          return;
        }
        if (replayComplete) throw new Error('workflow_review_evidence_corrupt');
        if (record.direction === 'request') {
          if (pending || record.sequence !== sequence + 1 || message.id !== record.sequence) throw new Error('workflow_review_evidence_corrupt');
          sequence++; pending = { sequence, request: message }; return;
        }
        if (!pending || pending.sequence !== record.sequence) throw new Error('workflow_review_evidence_corrupt');
        if (record.direction === 'receive') {
          if (pending.response || message.id !== pending.request.id || typeof message.id !== typeof pending.request.id) throw new Error('workflow_review_evidence_corrupt');
          pending.response = frame; return;
        }
        if (record.direction !== 'ack' || !pending.response || message.ack !== sequence || message.requestId !== pending.request.id
          || typeof message.requestId !== typeof pending.request.id || message.sha256 !== sha(pending.response)) throw new Error('workflow_review_evidence_corrupt');
        const receipt = this.receipt(pending.request, frameObject(pending.response));
        if (receipt) replay!.record(receipt, sequence);
        pending = undefined;
      }, 8192);
      for (let offset = 0; offset < references.correlation.bytes; offset += 8192) decoder.write(records.read(offset, Math.min(8192, references.correlation.bytes - offset)));
      decoder.end();
      if (pending || !replayComplete || sequence !== this.sequence || frameOffset !== references.capture.bytes) throw new Error('workflow_review_evidence_corrupt');
      replay.finish(parsed);
      const replayProof = replay.retainedProof;
      if (replayProof.bytes !== proof.bytes || replayProof.sha256 !== proof.sha256) throw new Error('workflow_review_evidence_corrupt');
      verifyWorkflowReviewOwnedReference(join(this.plan.directory, 'reconstruction'), proof);
      // Check retained whole-object files independently of proof text and second reconstruction.
      originalProof = new WorkflowReviewOwnedFile(join(this.plan.directory, 'reconstruction'), 'proof.jsonl');
      const proofDecoder = new WorkflowReviewFrameDecoder(line => {
        const record = frameObject(line) as unknown as WorkflowReviewOwnedReference;
        verifyWorkflowReviewOwnedReference(join(this.plan.directory, 'reconstruction'), record);
        verifyWorkflowReviewOwnedReference(join(this.plan.directory, 'replay'), record);
      });
      for (let offset = 0; offset < proof.bytes; offset += 8192) proofDecoder.write(originalProof.read(offset, Math.min(8192, proof.bytes - offset)));
      proofDecoder.end();
      verifyWorkflowReviewOwnedReference(this.plan.directory, references.capture);
      verifyWorkflowReviewOwnedReference(this.plan.directory, references.correlation);
      verifyWorkflowReviewOwnedReference(join(this.plan.directory, 'reconstruction'), proof);
      result = Object.freeze({ invocationId: this.plan.invocationId, reviewerId: this.plan.reviewerId,
        effectiveInvocationDigest: this.effectiveInvocationDigest, ...references,
        ranges: replay.rangeCount, reconstructionSha256: replay.reconstructionDigest });
    } catch (error) { failure = { value: error }; }
    finally {
      for (const close of [() => originalProof?.close(), () => records?.close(), () => frames?.close(),
        () => replay?.dispose(), () => this.coverage?.dispose()]) {
        try { close(); } catch (error) { failure ??= { value: error }; }
      }
    }
    if (failure) throw failure.value;
    return result!;
  }
}

export function prepareWorkflowSyntheticReview(input: { factory: WorkflowSyntheticReviewClientFactory;
  plan: WorkflowSyntheticReviewPlan; prepared: PreparedWorkflowBinding;
  launch: WorkflowSyntheticReviewLaunch; bundle: () => WorkflowReviewSourceBundle;
  files: readonly { path: string; sha256: string }[];
  artifacts: readonly { path: string; sha256: string }[];
  schema: unknown;
  catalogPath?: string;
}): WorkflowSyntheticReviewSession {
  for (const [key, value] of Object.entries(input.launch.environment)) {
    if (value && /^(?:NODE_OPTIONS|NODE_PATH|ESBUILD_BINARY_PATH)$/i.test(key)) throw new Error('workflow_review_runtime_closure_unavailable');
  }
  const pins = syntheticFactories.get(input.factory);
  if (!pins || input.prepared.validation !== 'synthetic' || realpathSync(input.prepared.command) !== pins.reviewer
    || !isDeepStrictEqual(input.prepared.binding, pins.binding) || input.launch.command !== input.prepared.command
    || realpathSync(input.launch.cwd) !== pins.cwd || input.launch.provider !== pins.binding.providerRoute
    || !isDeepStrictEqual(input.launch.redactionEnvironment, input.prepared.redactionEnvironment)
    || input.launch.timeoutMs === null && input.launch.superviseProcessTree !== true
    || !isDeepStrictEqual(input.launch.environment, { ...input.prepared.environment, ...workflowSyntheticBridgeEnvironment(input.factory, input.plan) })) {
    throw new Error('workflow_review_reader_qualification_mismatch');
  }
  const schemaPath = `${input.launch.artifactPrefix}.schema.json`; const resultPath = `${input.launch.artifactPrefix}.result.json`;
  const schema = input.schema;
  const catalog = input.launch.provider === 'codex' ? projectWorkflowReviewCodexCatalog({ source: pins.catalogSource,
    path: input.catalogPath!, model: pins.binding.model, preview: true }) : undefined;
  if (catalog && !input.artifacts.some(artifact => artifact.path === catalog.path && artifact.sha256 === catalog.sha256)
    || !input.artifacts.some(artifact => artifact.path === schemaPath && artifact.sha256 === sha(JSON.stringify(schema, null, 2) + '\n'))) {
    throw new Error('workflow_review_reader_qualification_mismatch');
  }
  const readerInput = { serverPath: pins.reader, bundlePath: input.plan.bundlePath, receiptsPath: input.plan.receiptsPath,
    ...(catalog ? { catalogPath: catalog.path } : {}) };
  const expected = workflowReviewerArguments(input.prepared, schemaPath, resultPath, schema,
    { mcpConfig: workflowReviewSourceReaderConfig(readerInput), codex: workflowReviewCodexReaderOverrides(readerInput) });
  if (!isDeepStrictEqual(expected, input.launch.args)) throw new Error('workflow_review_reader_qualification_mismatch');
  const path = input.launch.environment.OMC_WORKFLOW_TEST_CONFIG;
  if (!path || !isAbsolute(path) || realpathSync(path) !== path) throw new Error('workflow_review_reader_configuration_unavailable');
  const config = new WorkflowReviewOwnedFile(dirname(path), path.slice(dirname(path).length + 1));
  let configuration: { path: string; sha256: string }; let failed = false;
  try { configuration = { path, sha256: config.seal().sha256 }; }
  catch (error) { failed = true; throw error; }
  finally { if (failed) { try { config.close(); } catch { /* preserve the first failure */ } } else config.close(); }
  const session = new WorkflowSyntheticReviewSession(input.plan, pins, input.launch, input.bundle, [...input.files, configuration], input.artifacts);
  session.revalidate(); return session;
}
export function workflowSyntheticBridgeEnvironment(factory: WorkflowSyntheticReviewClientFactory, plan: WorkflowSyntheticReviewPlan): NodeJS.ProcessEnv {
  const pins = syntheticFactories.get(factory);
  if (!pins) throw new Error('workflow_review_reader_observation_required');
  return Object.freeze({ OMC_REVIEW_BRIDGE_MODULE: pins.bridge, OMC_REVIEW_RELAY: plan.relay,
    OMC_REVIEW_RELAY_TOKEN: plan.token, OMC_REVIEW_INVOCATION: plan.invocationId });
}
export function workflowSyntheticReaderPath(factory: WorkflowSyntheticReviewClientFactory): string {
  const pins = syntheticFactories.get(factory);
  if (!pins) throw new Error('workflow_review_reader_observation_required');
  return pins.reader;
}

/** Closed synthetic bridge: decision code receives reader calls, never capture sinks or ACK callbacks. */
export async function connectWorkflowSyntheticReviewBridge(): Promise<{
  call(method: string, params: unknown): Promise<Record<string, unknown>>; notifyInitialized(): void; close(): Promise<void>;
}> {
  const socket = createConnection(process.env.OMC_REVIEW_RELAY!);
  const closed = new Promise<void>(resolveClose => socket.once('close', resolveClose));
  let sequence = 0; let pending: { id: number; resolve(value: Record<string, unknown>): void; reject(error: unknown): void } | undefined;
  let failure = { present: false, value: undefined as unknown }; let ended = false; let settling = false; let settled = false;
  let resolveReady!: () => void; let rejectReady!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const fail = (error: unknown) => { if (!failure.present) failure = { present: true, value: error }; rejectReady(failure.value); pending?.reject(failure.value); pending = undefined; socket.destroy(); };
  const write = (frame: Buffer) => { try { socket.write(frame, error => { if (error) fail(error); }); } catch (error) { fail(error); } };
  const decoder = new WorkflowReviewFrameDecoder(frame => {
    const message = frameObject(frame);
    if (message.failure) throw new Error(String(message.failure));
    if (message.ready === process.env.OMC_REVIEW_INVOCATION) { resolveReady(); return; }
    if (message.settled === process.env.OMC_REVIEW_INVOCATION && settling) { settled = true; socket.end(); return; }
    if (!pending || message.id !== pending.id || typeof message.id !== 'number') throw new Error('workflow_review_transport_response_mismatch');
    const received = pending; pending = undefined;
    // The ACK binds original bytes, before parsing any nested tool content or invoking consumer code.
    write(wire({ ack: received.id, requestId: received.id, sha256: sha(frame) })); received.resolve(message);
  });
  socket.on('connect', () => write(wire({ token: process.env.OMC_REVIEW_RELAY_TOKEN, invocationId: process.env.OMC_REVIEW_INVOCATION })));
  socket.on('data', chunk => { try { decoder.write(chunk); } catch (error) { fail(error); } });
  socket.on('error', fail);
  socket.on('end', () => { ended = true; try { decoder.end(); if (!settled) throw new Error('workflow_review_transport_eof'); } catch (error) { fail(error); } });
  socket.on('close', () => { ended = true; if (!settled && !failure.present) fail(new Error('workflow_review_transport_eof')); });
  try { await ready; } catch (error) { await closed; throw error; }
  return Object.freeze({
    call(method: string, params: unknown) {
      return new Promise<Record<string, unknown>>((resolveCall, reject) => {
        if (failure.present) { reject(failure.value); return; }
        if (ended || settling || pending) { reject(new Error('workflow_review_transport_closed')); return; }
        const id = ++sequence; pending = { id, resolve: resolveCall, reject }; write(wire({ jsonrpc: '2.0', id, method, params }));
      });
    },
    notifyInitialized() { if (failure.present) throw failure.value; if (ended) throw new Error('workflow_review_transport_closed'); write(wire({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })); },
    async close() {
      if (!settling && !ended) { settling = true; write(wire({ complete: true })); }
      await closed;
      if (failure.present) throw failure.value;
      if (!settled) throw new Error('workflow_review_transport_incomplete');
    },
  });
}

/** Supported native producer. A differently built CLI needs a new implementation/qualification. */
const NATIVE_CODEX = Object.freeze({ version: '0.159.1', sha256: '1203922d910426522182b35a52402085d0955101bb585a87bd7c88110d8d68d8' });
export const WORKFLOW_REVIEW_NATIVE_COMPACTION_LIMIT = 98304;
export const WORKFLOW_REVIEW_NATIVE_NAMESPACE = 'functions';
// Codex 0.159.1's finite JsonSchema omits these three pattern fields on the model wire.
// Keep the declared MCP/thread schemas and the reader's argument/cursor/membership guards intact.
const NATIVE_WIRE_TOOLS = structuredClone(TOOLS);
Reflect.deleteProperty(NATIVE_WIRE_TOOLS[0]!.inputSchema.properties.cursor, 'pattern');
Reflect.deleteProperty(NATIVE_WIRE_TOOLS[1]!.inputSchema.properties.id!, 'pattern');
Reflect.deleteProperty(NATIVE_WIRE_TOOLS[1]!.inputSchema.properties.cursor, 'pattern');
const NATIVE_EXCLUDED_FEATURES = ['shell_tool', 'unified_exec', 'image_generation', 'goals', 'multi_agent', 'multi_agent_v2',
  'apps', 'plugins', 'remote_plugin', 'browser_use', 'browser_use_external', 'computer_use', 'in_app_browser',
  'code_mode', 'code_mode_only', 'code_mode_host', 'deferred_executor', 'token_budget', 'current_time_reminder', 'sleep_tool',
  'send_message_to_user_async', 'tool_suggest', 'skill_search', 'workspace_dependencies', 'view_image', 'hooks', 'skill_mcp_dependency_install'];
/** Exact native launch, scoped to one invocation; ordinary reviewer argv is untouched. */
export function workflowNativeReviewArguments(catalogPath: string, mcpServers: readonly string[] = []): string[] {
  // The pinned CLI splits override keys on dots without parsing TOML quoted keys.
  if (mcpServers.some(name => !name || /[.=\0\r\n]/.test(name))) throw new Error('workflow_review_native_mcp_name_unsupported');
  return ['app-server', '--listen', 'stdio://', '--config', `model_catalog_json=${JSON.stringify(catalogPath)}`,
    '--config', 'model="gpt-6.1-sol"', '--config', 'model_reasoning_effort="ultra"',
    '--config', `model_auto_compact_token_limit=${WORKFLOW_REVIEW_NATIVE_COMPACTION_LIMIT}`, '--config', 'model_auto_compact_token_limit_scope="body_after_prefix"',
    '--config', 'features.respect_system_proxy=false', '--config', 'features.system_proxy_fallback=false',
    '--config', 'analytics.enabled=false',
    '--config', 'mcp_servers={}', '--config', 'web_search="disabled"', '--config', 'agents.enabled=false',
    '--config', 'tools.update_plan.enabled=false', '--config', 'tools.experimental_request_user_input.enabled=false',
    '--config', 'project_doc_max_bytes=0', ...mcpServers.flatMap(name => ['--config', `mcp_servers.${name}.enabled=false`]),
    ...NATIVE_EXCLUDED_FEATURES.flatMap(feature => ['--config', `features.${feature}=false`])];
}
function nativeThread(binding: WorkflowRoleBinding, cwd: string): Record<string, unknown> {
  return { model: binding.model, cwd, ephemeral: true, sandbox: 'read-only', approvalPolicy: 'never',
    config: { model_auto_compact_token_limit: WORKFLOW_REVIEW_NATIVE_COMPACTION_LIMIT, model_auto_compact_token_limit_scope: 'body_after_prefix', 'analytics.enabled': false },
    allowProviderModelFallback: false, environments: [], dynamicTools:
      TOOLS.map(tool => ({ type: 'function', name: tool.name, description: tool.description, inputSchema: tool.inputSchema, deferLoading: false })) };
}
export function workflowNativeReviewProjection(input: { binding: WorkflowRoleBinding; schema: unknown; mcpServers?: readonly string[] }): string {
  return sha(JSON.stringify({ arguments: workflowNativeReviewArguments(WORKFLOW_REVIEW_EPHEMERAL_PLACEHOLDERS.catalog, input.mcpServers),
    thread: nativeThread(input.binding, '<review-working-directory>'),
    turn: { model: input.binding.model, effort: input.binding.effort, environments: [], outputSchema: input.schema },
    producer: NATIVE_CODEX, namespace: WORKFLOW_REVIEW_NATIVE_NAMESPACE, tools: TOOLS }));
}
export interface WorkflowNativeReviewClientFactory { readonly mode: 'native' }
interface NativeFactoryPins {
  readonly prepared: PreparedWorkflowBinding;
  readonly preparedSnapshot: PreparedWorkflowBinding;
  readonly cwd: string;
  readonly catalogSource: string;
  readonly expected: WorkflowReviewEffectiveInvocation;
  readonly schema: unknown;
  readonly closure: { sha256: string; files: number };
  readonly mcpServers: readonly string[];
  readonly observer: WorkflowNativeReviewObserver;
  qualification?: WorkflowReviewReaderQualification;
  certificate?: readonly { path: string; sha256: string }[];
}
const nativeFactories = new WeakMap<WorkflowNativeReviewClientFactory, NativeFactoryPins>();
const nativeFactoryPins = new WeakSet<NativeFactoryPins>();
const nativeSessions = new WeakSet<WorkflowNativeReviewSession>();
const nativeCompletions = new WeakMap<object, WorkflowNativeReviewSession>();
function revalidateNativeCertificate(pins: NativeFactoryPins): void {
  workflowNativeReviewObserverConfiguration(pins.observer);
  for (const artifact of pins.certificate ?? []) {
    const file = new WorkflowReviewOwnedFile(dirname(artifact.path), artifact.path.slice(dirname(artifact.path).length + 1));
    try {
      if (file.seal().sha256 !== artifact.sha256) throw new Error('workflow_review_reader_qualification_changed');
      if (artifact.path.endsWith('native-seals.jsonl') || artifact.path.endsWith('proof.jsonl')) {
        const decoder = new WorkflowReviewFrameDecoder(frame => {
          const record = frameObject(frame);
          verifyWorkflowReviewOwnedReference(join(dirname(artifact.path), String(record.directory ?? '')), record as unknown as WorkflowReviewOwnedReference);
        }, 65536);
        const { bytes } = file.seal();
        for (let offset = 0; offset < bytes; offset += 65536) decoder.write(file.read(offset, Math.min(65536, bytes - offset)));
        decoder.end();
      }
    } finally { file.close(); }
  }
}
export function requireWorkflowNativeReviewClientFactory(factory?: WorkflowNativeReviewClientFactory): void {
  if (!factory || !nativeFactories.get(factory)?.qualification) throw new Error('workflow_review_reader_observation_required');
  revalidateNativeCertificate(nativeFactories.get(factory)!);
}
/** Revokes live authority and closes the factory listener, channels and held certificate handles. */
export async function disposeWorkflowNativeReviewClientFactory(factory: WorkflowNativeReviewClientFactory): Promise<void> {
  const pins = nativeFactories.get(factory);
  if (!pins) return;
  nativeFactories.delete(factory); nativeFactoryPins.delete(pins);
  await disposeWorkflowNativeReviewObserver(pins.observer);
}
function nativeObserverEnvironment(prepared: PreparedWorkflowBinding, observer: WorkflowNativeReviewObserver, trace?: string): NodeJS.ProcessEnv {
  const overlay = { ...workflowNativeReviewObserverConfiguration(observer).environment, ...(trace ? { CODEX_ROLLOUT_TRACE_ROOT: trace } : {}) };
  const names = new Set(Object.keys(overlay).map(name => name.toUpperCase()));
  return { ...Object.fromEntries(Object.entries(prepared.environment).filter(([name]) => !names.has(name.toUpperCase()))), ...overlay };
}
export function workflowNativeReviewQualification(factory: WorkflowNativeReviewClientFactory, expected?: WorkflowReviewEffectiveInvocation): WorkflowReviewReaderQualification {
  requireWorkflowNativeReviewClientFactory(factory);
  const pins = nativeFactories.get(factory)!;
  if (expected && !isDeepStrictEqual(pins.expected, expected)) throw new Error('workflow_review_reader_qualification_mismatch');
  return pins.qualification!;
}
export function workflowNativeReviewServerNames(factory: WorkflowNativeReviewClientFactory): readonly string[] {
  requireWorkflowNativeReviewClientFactory(factory); return nativeFactories.get(factory)!.mcpServers;
}
export function workflowNativeReviewCatalogSource(factory: WorkflowNativeReviewClientFactory): string {
  requireWorkflowNativeReviewClientFactory(factory); return nativeFactories.get(factory)!.catalogSource;
}
export function verifyWorkflowNativeReviewPrepared(factory: WorkflowNativeReviewClientFactory, prepared: PreparedWorkflowBinding,
  cwd: string, schema: unknown): void {
  requireWorkflowNativeReviewClientFactory(factory); const pins = nativeFactories.get(factory)!;
  assertNativePrepared(prepared);
  if (!isDeepStrictEqual(prepared, pins.preparedSnapshot) || realpathSync(cwd) !== pins.cwd || !isDeepStrictEqual(schema, pins.schema)
    || !isDeepStrictEqual(workflowSyntheticRuntimeClosure(), pins.closure)) throw new Error('workflow_review_reader_qualification_mismatch');
  revalidateNativeCertificate(pins);
}
function assertNativePrepared(prepared: PreparedWorkflowBinding): void {
  requirePreparedWorkflowBinding(prepared);
  const binding = prepared.binding;
  if (prepared.validation !== 'authenticated' || binding.role !== 'reviewer' || binding.providerRoute !== 'codex'
    || binding.cliFamily !== 'codex-exec' || binding.model !== 'gpt-6.1-sol' || binding.effort !== 'ultra'
    || binding.executableIdentity?.version !== NATIVE_CODEX.version || binding.executableIdentity.sha256 !== NATIVE_CODEX.sha256
    || !isAbsolute(prepared.command) || realpathSync(prepared.command) !== realpathSync(binding.executableIdentity.path)
    || hashWorkflowReviewArtifact(prepared.command).sha256 !== NATIVE_CODEX.sha256) throw new Error('workflow_review_reader_qualification_required');
}
/** Discover inherited MCP names through the supported CLI before creating any provider thread. */
async function discoverNativeServers(input: { prepared: PreparedWorkflowBinding; cwd: string; directory: string; catalogPath: string;
  observer: WorkflowNativeReviewObserver }): Promise<{ readonly servers: readonly string[]; readonly observation: WorkflowNativeBodyObserverSettlement }> {
  const names = new Set<string>(); let writer: WorkflowProcessInputTransport | undefined; let initialized = false; let ended = false;
  const abortController = new AbortController(); const invocationId = randomUUID();
  const observation = beginWorkflowNativeReviewObservation(input.observer, { directory: join(input.directory, 'discovery-bodies'),
    invocationId, onFirstFailure: () => abortController.abort() });
  const decoder = new WorkflowReviewFrameDecoder(frame => {
    const message = frameObject(frame);
    if ('error' in message) throw new Error('workflow_review_reader_rpc_error');
    if (message.id === 1 && !initialized) {
      initialized = true; writer!.write(wire({ method: 'initialized' }));
      writer!.write(wire({ id: 2, method: 'mcpServerStatus/list', params: { limit: 1 } })); return;
    }
    if (message.id === 2 && initialized && !ended) {
      const result = message.result as { data?: { name?: string }[]; nextCursor?: string | null };
      if (!Array.isArray(result?.data)) throw new Error('workflow_review_reader_observation_incomplete');
      for (const server of result.data) {
        if (typeof server.name !== 'string' || !server.name || /[\0\r\n]/.test(server.name) || names.has(server.name)) throw new Error('workflow_review_reader_observation_incomplete');
        names.add(server.name);
      }
      if (result.nextCursor) writer!.write(wire({ id: 2, method: 'mcpServerStatus/list', params: { limit: 1, cursor: result.nextCursor } }));
      else { beginWorkflowNativeReviewClientShutdown(observation); ended = true; writer!.end(); }
      return;
    }
    if ('id' in message) throw new Error('workflow_review_transport_request_mismatch');
  }, 65536);
  let result: WorkflowProcessResult;
  let completion: WorkflowNativeReviewObservationCompletion;
  try { result = await runWorkflowProcess({ command: input.prepared.command, args: workflowNativeReviewArguments(input.catalogPath),
    cwd: input.cwd, environment: nativeObserverEnvironment(input.prepared, input.observer),
    redactionEnvironment: { ...input.prepared.redactionEnvironment, ...workflowNativeReviewObserverConfiguration(input.observer).redactionEnvironment },
    artifactPrefix: join(input.directory, 'discovery'), timeoutMs: null, provider: 'codex', superviseProcessTree: true,
    diagnosticOutput: 'omit', abortSignal: abortController.signal,
    onInput(transport) { writer = transport; writer.write(wire({ id: 1, method: 'initialize', params: {
      clientInfo: { name: 'omc-native-reader-discovery', version: '1.0.0' }, capabilities: { experimentalApi: true } } })); },
    onStdout(chunk) { decoder.write(chunk); } }); }
  finally { completion = await settleWorkflowNativeReviewObservation(observation); }
  decoder.end();
  if (!result.passed || !ended || result.settlement?.parentExitCode !== 0) throw new Error('workflow_review_native_bootstrap_failed');
  writeWorkflowReviewArtifact({ path: join(input.directory, 'discovery-result.json'), chunks: [wire({ result, servers: [...names].sort() })] });
  const observed = consumeWorkflowNativeReviewObservationCompletion(observation, completion!);
  for await (const _transaction of iterateWorkflowNativeObservedTransactions({ directory: join(input.directory, 'discovery-bodies'), invocationId, settlement: observed })) {
    throw new Error('workflow_review_native_discovery_model_forbidden');
  }
  writeWorkflowReviewArtifact({ path: join(input.directory, 'discovery-observer.json'), chunks: [wire(observed)] });
  return Object.freeze({ servers: Object.freeze([...names].sort()), observation: observed });
}
/**
 * Explicit controller bootstrap: a real authenticated native calibration is the sole producer of
 * this runtime-only capability. Saved JSON, arbitrary reviewer files and copied receipts cannot
 * mint it. Calibration has its own evidence directory and consumes no workflow review pass.
 */
export async function qualifyWorkflowNativeReviewClientFactory(input: {
  prepared: PreparedWorkflowBinding; cwd: string; directory: string; catalogSource: string;
  expected: WorkflowReviewEffectiveInvocation; schema: unknown; transport: WorkflowNativeReviewTransportBootstrap;
}): Promise<WorkflowNativeReviewClientFactory> {
  assertNativePrepared(input.prepared);
  const observer = await createWorkflowNativeReviewObserver(input.transport);
  try {
  mkdirSync(input.directory); const directory = realpathSync(input.directory); const cwd = realpathSync(input.cwd);
  const catalog = projectWorkflowReviewCodexCatalog({ source: input.catalogSource, path: join(directory, 'catalog.json'), model: input.prepared.binding.model, native: true });
  for (const record of iterateWorkflowReviewJsonRecords({ path: catalog.path, arrayKey: 'models', found: { value: false } })) {
    const model = JSON.parse(record) as Record<string, unknown>;
    if (model.slug === input.prepared.binding.model && model.context_window !== 272000) throw new Error('workflow_review_reader_qualification_mismatch');
  }
  const discovery = await discoverNativeServers({ prepared: input.prepared, cwd, directory, catalogPath: catalog.path, observer });
  const mcpServers = discovery.servers;
  const expected = freezeReviewValue({ ...structuredClone(input.expected), projection: workflowNativeReviewProjection({ binding: input.prepared.binding, schema: input.schema, mcpServers }) });
  if (expected.cli.path !== input.prepared.binding.executableIdentity!.path || expected.cli.sha256 !== NATIVE_CODEX.sha256
    || expected.cli.version !== NATIVE_CODEX.version || expected.model !== input.prepared.binding.model || expected.effort !== input.prepared.binding.effort
    || expected.auth.profile !== input.prepared.binding.authProfileRef || expected.auth.fingerprint !== input.prepared.binding.authFingerprint
    || expected.route !== 'codex' || !isDeepStrictEqual(expected.catalog, { input: catalog.input, projected: { bytes: catalog.bytes, sha256: catalog.sha256 } })
    || !isDeepStrictEqual(expected.tools, WORKFLOW_REVIEW_READER_TOOLS)) throw new Error('workflow_review_reader_qualification_mismatch');
  const pins: NativeFactoryPins = { prepared: input.prepared, preparedSnapshot: freezeReviewValue(structuredClone(input.prepared)), cwd,
    catalogSource: input.catalogSource, expected, schema: freezeReviewValue(structuredClone(input.schema)),
    closure: workflowSyntheticRuntimeClosure(), mcpServers, observer };
  nativeFactoryPins.add(pins);
  const factory = Object.freeze({ mode: 'native' as const }); nativeFactories.set(factory, pins);
  const plan = planWorkflowSyntheticReview({ invocationId: randomUUID(), reviewerId: input.prepared.actorId ?? `unknown:${input.prepared.binding.id}`,
    directory: join(directory, 'delivery'), bundlePath: join(directory, 'source'), receiptsPath: join(directory, 'intended.jsonl') });
  const bundle = buildWorkflowReviewSourceBundle({ repository: cwd, baseCommit: '0'.repeat(40), head: '1'.repeat(40), directory: plan.bundlePath,
    materials: [
      { kind: 'instruction', path: 'AGENTS.md', content: Buffer.from('Read every calibration material through the controller reader.\n') },
      { kind: 'source', path: 'unicode.txt', content: Buffer.from('界🙂"\\\n'.repeat(512)) },
      { kind: 'source', path: 'binary.bin', content: Buffer.from(Array.from({ length: 2048 }, (_, index) => index % 256)) },
      { kind: 'source', path: 'empty.txt', content: Buffer.alloc(0) },
      ...(['inventory', 'diff', 'objective', 'shared-context', 'contracts'] as const).map(kind => ({ kind, path: kind, content: Buffer.alloc(0) })),
    ] });
  writeWorkflowReviewArtifact({ path: plan.receiptsPath, chunks: [''] });
  const prefix = join(directory, 'native'); const schemaPath = `${prefix}.schema.json`;
  writeWorkflowReviewArtifact({ path: schemaPath, chunks: [JSON.stringify(input.schema, null, 2) + '\n'] });
  const request = JSON.stringify({ operation: 'native-reader-calibration', bundleSha256: bundle.digest, reviewerId: plan.reviewerId,
    entries: bundle.entryCount, server: WORKFLOW_REVIEW_NATIVE_NAMESPACE, tools: WORKFLOW_REVIEW_READER_TOOLS,
    instruction: 'Calibration phase one: read the entire manifest using its cursor. Read entries in manifest order through the first nonempty source page, then stop this turn. Preserve the latest trusted progress and every received page across compaction. Follow progress.next for the next kind/id/cursor; omit the cursor argument when progress.next.cursor is null to start that object. Return findings:[] and coverage with this bundleSha256/reviewerId, complete:false, entries equal to the manifest entry count and ranges copied exactly from the latest progress.ranges. The controller will compact only after this turn completes, then ask you to finish.' });
  const postRequest = JSON.stringify({ operation: 'native-reader-calibration-after-compaction', bundleSha256: bundle.digest, reviewerId: plan.reviewerId,
    instruction: 'Continue from the preserved progress.next kind/id/cursor in manifest order; omit the cursor argument when progress.next.cursor is null to start that object. Read every remaining source byte and every empty terminal page. Preserve the latest trusted progress across compaction; revisit already completed ranges if needed. Return findings:[] and complete:true coverage for this bundle and reviewer only after progress.next is null and the entire original manifest and all entries have been received. Copy the final progress.ranges exactly into coverage.ranges.' });
  const launch: WorkflowSyntheticReviewLaunch = { command: input.prepared.command, args: workflowNativeReviewArguments(catalog.path, mcpServers), cwd,
    environment: nativeObserverEnvironment(input.prepared, observer, join(plan.directory, 'trace')),
    redactionEnvironment: { ...input.prepared.redactionEnvironment, ...workflowNativeReviewObserverConfiguration(observer).redactionEnvironment },
    artifactPrefix: prefix, timeoutMs: null, provider: 'codex', superviseProcessTree: true, collectUsage: false, diagnosticOutput: 'omit' };
  const session = new WorkflowNativeReviewSession(plan, pins, launch, () => bundle, request,
    [{ path: realpathSync(input.prepared.command), sha256: NATIVE_CODEX.sha256 }],
    [{ path: schemaPath, sha256: hashWorkflowReviewArtifact(schemaPath).sha256 }, { path: catalog.path, sha256: catalog.sha256 }], postRequest);
  let processResult: Awaited<ReturnType<typeof runWorkflowProcess>> | undefined;
  try {
    await session.start();
    try {
      processResult = await runWorkflowProcess({ ...launch, abortSignal: session.abortSignal, onInput: session.onInput, onStdout: session.onStdout });
      session.acceptProcessCompletion(processResult);
    }
    finally { await session.settle(); }
    writeWorkflowReviewArtifact({ path: join(directory, 'native-process.json'), chunks: [wire({ processResult, integrityDiagnostic: session.integrityDiagnostic ?? null })] });
    if (!processResult.passed || processResult.settlement?.parentExitCode !== 0 || session.integrityDiagnostic) throw new Error('workflow_review_native_bootstrap_failed');
    const output = ownedJson(directory, 'native.result.json');
    const proof = await session.prove(session.completion(), output.coverage);
    const observed = hashWorkflowReviewArtifact(join(plan.directory, 'native-observed.jsonl'));
    const intended = hashWorkflowReviewArtifact(plan.receiptsPath);
    if (!proof.native?.calibration || !proof.native.compaction?.compactions) throw new Error('workflow_review_native_manual_calibration_required');
    pins.qualification = parseWorkflowReviewReaderQualification({ schemaVersion: 2, validation: 'native', invocation: expected,
      evidence: { bundleSha256: bundle.digest, proof: { ranges: proof.ranges, reconstructionSha256: proof.reconstructionSha256 },
        observed: { path: join(plan.directory, 'native-observed.jsonl'), ...observed, ranges: proof.ranges },
        intended: { path: plan.receiptsPath, ...intended, ranges: proof.ranges } }, routes: ['codex'], delivered: true,
      ...(input.prepared.actorId ? { actorId: input.prepared.actorId } : {}) });
    writeWorkflowReviewArtifact({ path: join(directory, 'qualification.json'), chunks: [wire(pins.qualification)] });
    writeWorkflowReviewArtifact({ path: join(directory, 'qualification-native-proof.json'), chunks: [wire(proof)] });
    verifyWorkflowReviewOwnedReference(join(directory, 'discovery-bodies'), discovery.observation.journal);
    pins.certificate = Object.freeze([...['qualification.json', 'qualification-native-proof.json', 'delivery/native-seals.jsonl',
      'delivery/native-observed.jsonl', 'delivery/frames.bin', 'delivery/correlation.jsonl', 'delivery/calls.jsonl',
      'delivery/reconstruction/proof.jsonl', 'source/manifest.json', 'intended.jsonl', 'catalog.json', 'discovery-result.json', 'discovery-observer.json']
      .map(name => ({ path: join(directory, name), sha256: hashWorkflowReviewArtifact(join(directory, name)).sha256 })),
      { path: join(directory, 'discovery-bodies', discovery.observation.journal.name), sha256: discovery.observation.journal.sha256 }]);
    return factory;
  } catch (error) {
    nativeFactories.delete(factory);
    try { writeWorkflowReviewArtifact({ path: join(directory, 'bootstrap-failure.json'), chunks: [wire({ diagnostic: diagnostic(error), processResult: processResult ?? null })] }); }
    catch { /* Preserve the original failure and any actual process evidence already retained. */ }
    throw error;
  } finally { await session.settle(); session.dispose(); }
  } catch (error) {
    try { await disposeWorkflowNativeReviewObserver(observer); } catch { /* Preserve the failed bootstrap's original evidence. */ }
    throw error;
  }
}
export function prepareWorkflowNativeReview(input: {
  factory: WorkflowNativeReviewClientFactory; plan: WorkflowSyntheticReviewPlan; prepared: PreparedWorkflowBinding;
  bundle: () => WorkflowReviewSourceBundle; request: string; catalog: WorkflowReviewCodexCatalogProjection;
  schema: unknown; artifactPrefix: string; timeoutMs: number | null;
  files: readonly { path: string; sha256: string }[]; artifacts: readonly { path: string; sha256: string }[];
}): WorkflowNativeReviewSession {
  requireWorkflowNativeReviewClientFactory(input.factory); const pins = nativeFactories.get(input.factory)!;
  assertNativePrepared(input.prepared);
  if (input.timeoutMs !== null || !isDeepStrictEqual(input.prepared, pins.preparedSnapshot) || !isDeepStrictEqual(input.schema, pins.schema)
    || input.catalog.input.path !== pins.catalogSource || !isDeepStrictEqual(pins.expected.catalog,
      { input: input.catalog.input, projected: { bytes: input.catalog.bytes, sha256: input.catalog.sha256 } })) throw new Error('workflow_review_reader_qualification_mismatch');
  const launch: WorkflowSyntheticReviewLaunch = { command: input.prepared.command, args: workflowNativeReviewArguments(input.catalog.path, pins.mcpServers),
    cwd: pins.cwd, environment: nativeObserverEnvironment(input.prepared, pins.observer, join(input.plan.directory, 'trace')),
    redactionEnvironment: { ...input.prepared.redactionEnvironment, ...workflowNativeReviewObserverConfiguration(pins.observer).redactionEnvironment }, artifactPrefix: input.artifactPrefix,
    timeoutMs: input.timeoutMs, provider: 'codex', superviseProcessTree: true, collectUsage: false, diagnosticOutput: 'omit' };
  const session = new WorkflowNativeReviewSession(input.plan, pins, launch, input.bundle, input.request, input.files, input.artifacts);
  session.revalidate(); return session;
}
const NATIVE_CURSOR_REFUSAL = 'workflow_review_source_invalid_cursor';
const NATIVE_CURSOR_REFUSAL_RESULT = {
  contentItems: [{ type: 'inputText', text: 'Error: workflow_review_source_invalid_cursor. Copy the cursor exactly from the preceding page for this entry, or omit cursor to restart.' }],
  success: false,
};
const NATIVE_ORDER_REFUSAL = 'workflow_review_source_out_of_order';
const NATIVE_SINGLETON_IDS = ['inventory', 'diff', 'objective', 'shared-context', 'contracts'];
interface NativeSourceProgress {
  readonly ranges: number;
  readonly next: { readonly kind: 'manifest' | 'entry'; readonly id: string | null; readonly cursor: string | null } | null;
}
/** Serving advice only. Independent observed-byte reconstruction remains the coverage authority. */
class NativeSourceProgressTracker {
  private readonly objects: Generator<WorkflowReviewSourceEntry>;
  private current?: WorkflowReviewSourceEntry;
  private next?: WorkflowReviewSourceEntry;
  private manifestComplete = false;
  private instructions = 0;
  private sources = 0;
  private singletons = 0;
  private offset = 0;
  private cursor: string | null = null;
  private ranges = 0;
  constructor(bundle: WorkflowReviewSourceBundle) {
    this.objects = iterateWorkflowReviewManifestEntries(bundle);
    try { this.next = this.objects.next().value; } catch (error) { this.dispose(); throw error; }
  }
  snapshot(): NativeSourceProgress {
    return { ranges: this.ranges, next: !this.manifestComplete ? { kind: 'manifest', id: null, cursor: this.cursor }
      : this.current ? { kind: 'entry', id: this.current.id, cursor: this.cursor } : null };
  }
  private isCurrent(page: WorkflowReviewSourceReadResult): boolean {
    return this.manifestComplete ? page.kind === 'entry' && page.id === this.current?.id : page.kind === 'manifest';
  }
  accepts(page: WorkflowReviewSourceReadResult): boolean {
    if (this.isCurrent(page)) return page.offset === this.offset || page.offset < this.offset && page.offset + page.bytes <= this.offset;
    if (page.kind === 'manifest') return this.manifestComplete;
    const ordinal = /^(instr|src)-(0|[1-9][0-9]*)$/.exec(page.id!);
    if (ordinal) return Number.isSafeInteger(Number(ordinal[2])) && Number(ordinal[2]) < (ordinal[1] === 'instr' ? this.instructions : this.sources);
    const index = NATIVE_SINGLETON_IDS.indexOf(page.id!);
    return index >= 0 && (this.singletons & 1 << index) !== 0;
  }
  /** The fitter may call this many times. No iterator or counter advances for a trial slice. */
  preview(page: WorkflowReviewSourceReadResult): NativeSourceProgress {
    const progress = this.snapshot();
    return { ranges: this.ranges + (page.bytes > 0 ? 1 : 0),
      next: this.isCurrent(page) && page.offset === this.offset
        ? page.cursor === null ? this.next ? { kind: 'entry', id: this.next.id, cursor: null } : null
          : { kind: page.kind, id: page.id, cursor: page.cursor }
        : progress.next };
  }
  commit(page: WorkflowReviewSourceReadResult): void {
    if (!this.accepts(page)) throw new Error(NATIVE_ORDER_REFUSAL);
    if (this.isCurrent(page) && page.offset === this.offset) {
      if (page.cursor === null) {
        if (!this.manifestComplete) this.manifestComplete = true;
        else {
          const entry = this.current!;
          if (entry.kind === 'instruction') {
            if (entry.id !== `instr-${this.instructions}`) throw new Error('workflow_review_source_corrupt');
            this.instructions++;
          } else if (entry.kind === 'source') {
            if (entry.id !== `src-${this.sources}`) throw new Error('workflow_review_source_corrupt');
            this.sources++;
          } else {
            const index = NATIVE_SINGLETON_IDS.indexOf(entry.id);
            if (index < 0 || entry.id !== entry.kind || (this.singletons & 1 << index) !== 0) throw new Error('workflow_review_source_corrupt');
            this.singletons |= 1 << index;
          }
        }
        this.current = this.next; this.next = this.objects.next().value;
        this.offset = 0; this.cursor = null;
      } else { this.offset += page.bytes; this.cursor = page.cursor; }
    }
    if (page.bytes > 0) this.ranges++;
  }
  dispose(): void { this.objects.return(undefined); }
}
function readNativeSource(bundle: WorkflowReviewSourceBundle, progress: NativeSourceProgressTracker,
  tool: string, args: ReturnType<typeof readerArguments>, requestId: string | number) {
  const success = (page: WorkflowReviewSourceReadResult) => ({ contentItems: [{ type: 'inputText',
    text: JSON.stringify({ ...page, progress: progress.preview(page) }) }], success: true });
  let page: WorkflowReviewSourceReadResult | undefined;
  let refusal: typeof NATIVE_CURSOR_REFUSAL | typeof NATIVE_ORDER_REFUSAL | undefined;
  try {
    page = readWorkflowReviewSource(bundle, { kind: tool === WORKFLOW_REVIEW_READER_TOOL_MANIFEST ? 'manifest' : 'entry',
      ...args, requestId, responseEnvelope: candidate => ({ id: requestId, result: success(candidate) }) });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== NATIVE_CURSOR_REFUSAL) throw error;
    refusal = NATIVE_CURSOR_REFUSAL;
  }
  if (page && !progress.accepts(page)) { refusal = NATIVE_ORDER_REFUSAL; page = undefined; }
  const result = page ? success(page) : refusal === NATIVE_CURSOR_REFUSAL ? NATIVE_CURSOR_REFUSAL_RESULT
    : { contentItems: [{ type: 'inputText', text: JSON.stringify({ error: NATIVE_ORDER_REFUSAL, progress: progress.snapshot() }) }], success: false };
  if (wire({ id: requestId, result }).length > WORKFLOW_REVIEW_READ_LIMIT_BYTES) throw new Error('workflow_review_source_response_unbounded');
  if (page) progress.commit(page);
  return { page, refusal, result };
}
type NativeCallRecord = {
  readonly callId: string; readonly requestId: string | number; readonly tool: string; readonly arguments: unknown;
  readonly request: { offset: number; bytes: number; sha256: string };
  readonly response: { offset: number; bytes: number; sha256: string };
} & ({ readonly receipt: WorkflowReviewSourceReceipt; readonly refusal?: never }
  | { readonly refusal: typeof NATIVE_CURSOR_REFUSAL | typeof NATIVE_ORDER_REFUSAL; readonly receipt?: never });
function ownedJson(directory: string, name: string): Record<string, unknown> {
  const file = new WorkflowReviewOwnedFile(directory, name);
  try {
    const sealed = file.seal();
    if (sealed.bytes > 65536) throw new Error('workflow_review_evidence_corrupt');
    return frameObject(file.read(0, sealed.bytes));
  } finally { file.close(); }
}
function nativeCallName(callId: string): string {
  if (typeof callId !== 'string' || !callId || callId.length > 200) throw new Error('workflow_review_transport_identity_mismatch');
  return `${sha(callId)}.json`;
}
interface NativeCalibrationTrace {
  readonly firstTurnId: string; readonly compactTurnId: string; readonly postTurnId: string;
  readonly compactionId: string; readonly firstResult: string; readonly postRequest: string; readonly firstCallCount: number;
}
function assertNativePartialCalibration(bundle: WorkflowReviewSourceBundle, result: string, reviewerId: string, ranges: number): void {
  if (!isDeepStrictEqual(JSON.parse(result), { findings: [], coverage: { bundleSha256: bundle.digest, reviewerId,
    complete: false, entries: bundle.entryCount, ranges } })) throw new Error('workflow_review_native_manual_calibration_required');
}
/** Direct pinned app-server process, with no model-accessible filesystem or write capability. */
export class WorkflowNativeReviewSession {
  readonly launch: WorkflowSyntheticReviewLaunch;
  readonly effectiveInvocationDigest: string;
  readonly #pins: NativeFactoryPins;
  private readonly effectiveProcess: unknown;
  private writer?: WorkflowProcessInputTransport;
  private capture?: WorkflowReviewOwnedFile;
  private correlations?: WorkflowReviewOwnedFile;
  private calls?: WorkflowReviewOwnedFile;
  private sequence = 0;
  private controlStep = 1;
  private readonly listedServers = new Set<string>();
  private callCount = 0;
  private threadId?: string;
  private turnId?: string;
  private finalResult?: string;
  private finished = false;
  private settled = false;
  private processCompleted = false;
  private observation?: WorkflowNativeReviewObservation;
  private observationCompletion?: WorkflowNativeReviewObservationCompletion;
  private failure?: { value: unknown };
  private sealed?: { capture: WorkflowReviewOwnedReference; correlation: WorkflowReviewOwnedReference };
  private readonly decoder: WorkflowReviewFrameDecoder;
  private incoming?: NativeCallRecord['request'];
  private progress?: NativeSourceProgressTracker;
  private readonly abortController = new AbortController();
  private readonly calibration?: { readonly postRequest: string; phase: 'first' | 'compact' | 'post'; firstManifest: boolean; firstSource: boolean; postSource: boolean;
    firstTurnId?: string; compactTurnId?: string; compactionId?: string; firstResult?: string; firstCallCount?: number;
    ranges: number; acknowledged: boolean; itemStarted: boolean; itemCompleted: boolean };
  constructor(readonly plan: WorkflowSyntheticReviewPlan, pins: NativeFactoryPins,
    launch: WorkflowSyntheticReviewLaunch, private readonly bundle: () => WorkflowReviewSourceBundle,
    private readonly request: string, private readonly files: readonly { path: string; sha256: string }[],
    private readonly artifacts: readonly { path: string; sha256: string }[], postCalibrationRequest?: string) {
    if (!nativeFactoryPins.has(pins)) throw new Error('workflow_review_reader_observation_required');
    this.#pins = pins; nativeSessions.add(this);
    if (postCalibrationRequest !== undefined) this.calibration = { postRequest: postCalibrationRequest, phase: 'first', firstManifest: false,
      firstSource: false, postSource: false, ranges: 0, acknowledged: false, itemStarted: false, itemCompleted: false };
    this.launch = freezeReviewValue(launch); freezeReviewValue(plan); freezeReviewValue(files); freezeReviewValue(artifacts);
    this.effectiveProcess = workflowSyntheticEffectiveProcess(launch);
    this.effectiveInvocationDigest = sha(JSON.stringify({ invocationId: plan.invocationId, reviewerId: plan.reviewerId,
      process: this.effectiveProcess, observer: workflowNativeReviewObserverConfiguration(pins.observer).descriptor,
      closure: pins.closure, expected: pins.expected, files, artifacts,
      thread: nativeThread(pins.prepared.binding, launch.cwd), schema: pins.schema, requestSha256: sha(request),
      ...(postCalibrationRequest ? { postCalibrationRequestSha256: sha(postCalibrationRequest) } : {}), bundle: plan.bundlePath }));
    this.decoder = new WorkflowReviewFrameDecoder(frame => this.receive(frame), 65536,
      frame => { this.incoming = this.captureSelectedFrame(frame); });
  }
  revalidate(materialized = false): void {
    assertNativePrepared(this.#pins.prepared);
    if (!isDeepStrictEqual(this.#pins.prepared, this.#pins.preparedSnapshot)) throw new Error('workflow_review_prepared_launch_changed');
    revalidateNativeCertificate(this.#pins);
    if (!isDeepStrictEqual(workflowSyntheticEffectiveProcess(this.launch), this.effectiveProcess)
      || !isDeepStrictEqual(workflowSyntheticRuntimeClosure(), this.#pins.closure)) throw new Error('workflow_review_prepared_launch_changed');
    for (const pin of [...this.files, ...(materialized ? this.artifacts : [])]) {
      if (realpathSync(pin.path) !== pin.path || hashWorkflowReviewArtifact(pin.path).sha256 !== pin.sha256) throw new Error('workflow_review_prepared_launch_changed');
    }
  }
  assertHealthy = (): void => {
    if (this.failure) throw this.failure.value;
    if (this.observation) assertWorkflowNativeReviewObservationHealthy(this.observation);
  };
  get abortSignal(): AbortSignal { return this.abortController.signal; }
  onObserverFailure = (): void => {
    if (this.failure) return;
    try {
      if (this.writer && this.threadId && this.turnId && !this.finished) this.send({ id: 'observer-abort', method: 'turn/interrupt',
        params: { threadId: this.threadId, turnId: this.turnId } });
    } catch { /* The owned abort remains required if the protocol is already closed. */ }
    this.failure = { value: new Error('workflow_review_native_observer_failed') }; this.abortController.abort();
  };
  get integrityDiagnostic(): string | undefined { return this.failure ? diagnostic(this.failure.value) : undefined; }
  acceptProcessCompletion(result: WorkflowProcessResult): void {
    try {
      if (this.processCompleted) throw new Error('workflow_review_transport_completion_required');
      requireWorkflowProcessCompletion(result, { ...this.launch, onInput: this.onInput, abortSignal: this.abortSignal });
      this.processCompleted = true;
    } catch (value) { this.failure ??= { value }; }
  }
  private record(direction: 'request' | 'receive', frame: Buffer): NativeCallRecord['request'] {
    const reference = this.capture!.append(frame);
    this.correlations!.append(wire({ invocationId: this.plan.invocationId, reviewerId: this.plan.reviewerId,
      effectiveInvocationDigest: this.effectiveInvocationDigest, sequence: ++this.sequence, direction, frame: reference }));
    return reference;
  }
  private captureSelectedFrame(frame: Buffer): NativeCallRecord['request'] | undefined {
    const message = frameObject(frame);
    if (message.method === 'error' || Object.hasOwn(message, 'error') && message.error != null) throw new Error('workflow_review_reader_rpc_error');
    const known = message.method === undefined && Object.hasOwn(message, 'result')
      || ['turn/started', 'item/tool/call', 'item/started', 'item/completed', 'turn/completed'].includes(String(message.method));
    if (!known) { if (Object.hasOwn(message, 'id')) throw new Error('workflow_review_transport_request_mismatch'); return undefined; }
    const check = (value: unknown): void => {
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        if (/^(?:headers|authorization|proxy-authorization|cookies?|body|api[_-]?key|access[_-]?token)$/i.test(key)
          || key === 'error' && child != null) throw new Error('workflow_review_native_unsafe_protocol_frame');
        check(child);
      }
    };
    check(message);
    if (message.method === 'item/tool/call') {
      const params = message.params as Record<string, unknown>;
      if (!params || !WORKFLOW_REVIEW_READER_TOOLS.includes(String(params.tool))) throw new Error('workflow_review_transport_request_mismatch');
      readerArguments(String(params.tool), params.arguments);
    }
    return this.record('receive', frame);
  }
  private send(value: unknown, reader = false): NativeCallRecord['response'] {
    this.assertHealthy();
    const frame = wire(value);
    if (frame.length > (reader ? WORKFLOW_REVIEW_READ_LIMIT_BYTES : 65536)) throw new Error('workflow_review_source_response_unbounded');
    const reference = this.record('request', frame); this.writer!.write(frame); return reference;
  }
  private startTurn(id: number, request: string): void {
    this.send({ id, method: 'turn/start', params: { threadId: this.threadId, input: [{ type: 'text', text: request, text_elements: [] }],
      model: this.#pins.prepared.binding.model, effort: this.#pins.prepared.binding.effort, environments: [], outputSchema: this.#pins.schema } });
  }
  async start(): Promise<void> {
    this.revalidate(true);
    mkdirSync(this.plan.directory); mkdirSync(join(this.plan.directory, 'trace')); mkdirSync(join(this.plan.directory, 'calls'));
    this.capture = new WorkflowReviewOwnedFile(this.plan.directory, 'frames.bin', true);
    this.correlations = new WorkflowReviewOwnedFile(this.plan.directory, 'correlation.jsonl', true);
    this.calls = new WorkflowReviewOwnedFile(this.plan.directory, 'calls.jsonl', true);
    this.observation = beginWorkflowNativeReviewObservation(this.#pins.observer, { directory: join(this.plan.directory, 'bodies'),
      invocationId: this.plan.invocationId, onFirstFailure: this.onObserverFailure });
  }
  onInput = (writer: WorkflowProcessInputTransport): void => {
    if (this.writer) throw new Error('workflow_review_transport_duplicate_peer');
    this.writer = writer;
    this.send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'omc-review-reader', version: '1.0.0' }, capabilities: { experimentalApi: true } } });
  };
  onStdout = (chunk: Buffer): void => {
    try { this.assertHealthy(); this.decoder.write(chunk); }
    catch (error) { this.failure ??= { value: error }; throw error; }
  };
  private receive(frame: Buffer): void {
    const reference = this.incoming!; const message = frameObject(frame);
    if ('error' in message) throw new Error('workflow_review_reader_rpc_error');
    const rpcResponse = message.method === undefined && Object.hasOwn(message, 'result');
    if (rpcResponse && message.id === 1 && this.controlStep === 1) {
      this.controlStep = 2;
      this.send({ method: 'initialized' }); this.send({ id: 2, method: 'thread/start', params: nativeThread(this.#pins.prepared.binding, this.launch.cwd) }); return;
    }
    if (rpcResponse && message.id === 2 && this.controlStep === 2) {
      const result = message.result as Record<string, unknown>; const thread = result?.thread as Record<string, unknown>;
      if (!thread || typeof thread.id !== 'string' || result.model !== this.#pins.prepared.binding.model || result.modelProvider !== 'openai' || result.reasoningEffort !== 'ultra'
        || result.approvalPolicy !== 'never' || result.cwd !== this.launch.cwd || (result.sandbox as { type?: string })?.type !== 'readOnly') {
        throw new Error('workflow_review_reader_qualification_mismatch');
      }
      this.threadId = thread.id;
      this.controlStep = 3;
      this.send({ id: 3, method: 'mcpServerStatus/list', params: { threadId: this.threadId, limit: 1 } }); return;
    }
    if (rpcResponse && message.id === 3 && this.controlStep === 3) {
      const result = message.result as { data?: Record<string, unknown>[]; nextCursor?: string | null };
      if (!Array.isArray(result?.data)) throw new Error('workflow_review_reader_observation_incomplete');
      for (const server of result.data) {
        if (typeof server.name !== 'string' || !this.#pins.mcpServers.includes(server.name) || this.listedServers.has(server.name)
          || server.runtimeStatus != null && server.runtimeStatus !== 'disabled' || !server.tools || Object.keys(server.tools).length
          || !Array.isArray(server.resources) || server.resources.length || !Array.isArray(server.resourceTemplates) || server.resourceTemplates.length) {
          throw new Error('workflow_review_reader_observation_incomplete');
        }
        this.listedServers.add(server.name);
      }
      if (result.nextCursor) {
        this.send({ id: 3, method: 'mcpServerStatus/list', params: { threadId: this.threadId, limit: 1, cursor: result.nextCursor } }); return;
      }
      this.controlStep = 4;
      this.startTurn(4, this.request); return;
    }
    const params = message.params as Record<string, unknown> | undefined;
    if (rpcResponse && (message.id === 4 && this.controlStep === 4 || message.id === 6 && this.controlStep === 7 && this.calibration?.phase === 'post')) {
      const turn = (message.result as { turn?: { id?: string } })?.turn;
      if (!turn?.id || this.turnId && this.turnId !== turn.id) throw new Error('workflow_review_transport_identity_mismatch');
      this.turnId = turn.id; this.controlStep = message.id === 4 ? 5 : 8; return;
    }
    if (rpcResponse && message.id === 5 && this.controlStep === 6 && this.calibration?.phase === 'compact') {
      if (this.calibration.acknowledged || !isDeepStrictEqual(message.result, {})) throw new Error('workflow_review_transport_response_mismatch');
      this.calibration.acknowledged = true; return;
    }
    if (message.method === 'turn/started') {
      const turn = params?.turn as { id?: string } | undefined;
      if (!turn?.id || params?.threadId !== this.threadId || this.turnId && this.turnId !== turn.id) throw new Error('workflow_review_transport_identity_mismatch');
      if (this.calibration?.phase === 'compact') {
        if (turn.id === this.calibration.firstTurnId || this.calibration.compactTurnId && this.calibration.compactTurnId !== turn.id) throw new Error('workflow_review_transport_identity_mismatch');
        this.calibration.compactTurnId = turn.id;
      } else if (this.calibration?.phase === 'post' && [this.calibration.firstTurnId, this.calibration.compactTurnId].includes(turn.id)) {
        throw new Error('workflow_review_transport_identity_mismatch');
      }
      this.turnId = turn.id; return;
    }
    if (message.method === 'item/tool/call') {
      if (this.finished || this.calibration?.phase === 'compact' || !params || params.threadId !== this.threadId || params.turnId !== this.turnId
        || params.namespace != null || !WORKFLOW_REVIEW_READER_TOOLS.includes(String(params.tool))
        || typeof params.callId !== 'string' || (typeof message.id !== 'number' && typeof message.id !== 'string')) throw new Error('workflow_review_transport_request_mismatch');
      const args = readerArguments(String(params.tool), params.arguments);
      const bundle = this.bundle();
      const { page, refusal, result } = readNativeSource(bundle, this.progress ??= new NativeSourceProgressTracker(bundle), String(params.tool), args, message.id);
      const receipt = page && workflowReviewSourceReceipt(page);
      if (page && receipt && this.calibration?.phase === 'first') {
        this.calibration.firstManifest ||= receipt.kind === 'manifest' && page.cursor === null;
        this.calibration.firstSource ||= receipt.kind === 'entry' && receipt.id?.startsWith('src-') === true && receipt.bytes > 0;
        if (receipt.bytes > 0) this.calibration.ranges++;
      }
      if (receipt && this.calibration?.phase === 'post') {
        this.calibration.postSource ||= receipt.kind === 'entry' && receipt.id?.startsWith('src-') === true && receipt.bytes > 0;
      }
      if (receipt) appendWorkflowReviewSourceReceipt(this.plan.receiptsPath, receipt);
      const response = this.send({ id: message.id, result }, true);
      const call: NativeCallRecord = { callId: params.callId, requestId: message.id, tool: String(params.tool), arguments: params.arguments,
        request: reference, response, ...(receipt ? { receipt } : { refusal: refusal! }) };
      writeWorkflowReviewArtifact({ path: join(this.plan.directory, 'calls', nativeCallName(params.callId)), chunks: [wire(call)] });
      this.calls!.append(wire(call)); this.callCount++; return;
    }
    if (message.method === 'item/completed' || message.method === 'item/started') {
      const item = params?.item as { type?: string; text?: string; phase?: string; id?: string } | undefined;
      if (params?.threadId !== this.threadId || params?.turnId !== this.turnId) throw new Error('workflow_review_transport_identity_mismatch');
      if (this.calibration?.phase === 'compact' && item?.type === 'contextCompaction') {
        if (!item.id || this.calibration.compactionId && this.calibration.compactionId !== item.id) throw new Error('workflow_review_transport_identity_mismatch');
        this.calibration.compactionId = item.id;
        if (message.method === 'item/started') {
          if (this.calibration.itemStarted || this.calibration.itemCompleted) throw new Error('workflow_review_transport_incomplete');
          this.calibration.itemStarted = true;
        } else {
          if (!this.calibration.itemStarted || this.calibration.itemCompleted) throw new Error('workflow_review_transport_incomplete');
          this.calibration.itemCompleted = true;
        }
      }
      if (message.method === 'item/completed' && item?.type === 'agentMessage' && item.phase === 'final_answer') {
        if (this.finalResult !== undefined || typeof item.text !== 'string' || Buffer.byteLength(item.text) > 65536) throw new Error('workflow_review_transport_response_mismatch');
        this.finalResult = item.text;
      }
      return;
    }
    if (message.method === 'turn/completed') {
      const turn = params?.turn as { id?: string; status?: string; error?: unknown } | undefined;
      if (this.finished || !turn || params?.threadId !== this.threadId || turn.id !== this.turnId || turn.status !== 'completed'
        || turn.error != null) throw new Error('workflow_review_transport_incomplete');
      if (this.calibration?.phase === 'first') {
        if (!this.finalResult || !this.calibration.firstManifest || !this.calibration.firstSource) throw new Error('workflow_review_native_manual_calibration_required');
        assertNativePartialCalibration(this.bundle(), this.finalResult, this.plan.reviewerId, this.calibration.ranges);
        this.calibration.firstTurnId = this.turnId; this.calibration.firstResult = this.finalResult; this.calibration.firstCallCount = this.callCount;
        this.calibration.phase = 'compact'; this.finalResult = undefined; this.turnId = undefined; this.controlStep = 6;
        this.send({ id: 5, method: 'thread/compact/start', params: { threadId: this.threadId } }); return;
      }
      if (this.calibration?.phase === 'compact') {
        if (!this.calibration.acknowledged || !this.calibration.compactTurnId || !this.calibration.itemCompleted || this.finalResult) throw new Error('workflow_review_native_manual_calibration_required');
        this.calibration.phase = 'post'; this.turnId = undefined; this.controlStep = 7; this.startTurn(6, this.calibration.postRequest); return;
      }
      if (this.calibration && (!this.calibration.postSource || this.callCount <= this.calibration.firstCallCount!)) {
        throw new Error('workflow_review_native_manual_calibration_required');
      }
      if (!this.finalResult) throw new Error('workflow_review_transport_incomplete');
      JSON.parse(this.finalResult);
      writeWorkflowReviewArtifact({ path: `${this.launch.artifactPrefix}.result.json`, chunks: [this.finalResult] });
      beginWorkflowNativeReviewClientShutdown(this.observation!);
      this.finished = true; this.writer!.end(); return;
    }
    if ('id' in message || message.method === 'error') throw new Error('workflow_review_transport_request_mismatch');
  }
  async settle(): Promise<void> {
    if (this.settled) return;
    this.settled = true;
    try {
      if (this.observation) this.observationCompletion = await settleWorkflowNativeReviewObservation(this.observation);
      this.decoder.end(); if (!this.finished) throw new Error('workflow_review_transport_incomplete');
      this.sealed = { capture: this.capture!.seal(), correlation: this.correlations!.seal() };
    } catch (error) { this.failure ??= { value: error }; }
    finally {
      try { this.progress?.dispose(); } catch (error) { this.failure ??= { value: error }; }
      for (const file of [this.capture, this.correlations, this.calls]) try { file?.close(); } catch (error) { this.failure ??= { value: error }; }
    }
  }
  completion(): object {
    if (!nativeSessions.has(this)) throw new Error('workflow_review_transport_completion_required');
    this.assertHealthy(); if (!this.finished || !this.settled || !this.sealed || !this.processCompleted || !this.observationCompletion) throw new Error('workflow_review_transport_incomplete');
    const handle = Object.freeze({}); nativeCompletions.set(handle, this); return handle;
  }
  dispose(): void { this.progress?.dispose(); }
  async prove(handle: object, attestation: unknown): Promise<WorkflowSyntheticReviewProof> {
    if (!nativeSessions.has(this) || nativeCompletions.get(handle) !== this || !this.sealed) throw new Error('workflow_review_transport_completion_required');
    nativeCompletions.delete(handle); this.assertHealthy(); this.revalidate(true);
    const transport = consumeWorkflowNativeReviewObservationCompletion(this.observation!, this.observationCompletion!);
    const calibration: NativeCalibrationTrace | undefined = this.calibration ? { firstTurnId: this.calibration.firstTurnId!,
      compactTurnId: this.calibration.compactTurnId!, postTurnId: this.turnId!, compactionId: this.calibration.compactionId!,
      firstResult: this.calibration.firstResult!, firstCallCount: this.calibration.firstCallCount!, postRequest: this.calibration.postRequest } : undefined;
    const result = await verifyWorkflowNativeReviewTrace({ directory: this.plan.directory, bundle: this.bundle(),
      reviewerId: this.plan.reviewerId, invocationId: this.plan.invocationId, effectiveInvocationDigest: this.effectiveInvocationDigest,
      threadId: this.threadId!, turnId: calibration?.firstTurnId ?? this.turnId!, callCount: this.callCount, attestation,
      resultText: this.finalResult!,
      capture: this.sealed.capture, correlation: this.sealed.correlation, request: this.request, schema: this.#pins.schema, transport, calibration });
    return Object.freeze({ invocationId: this.plan.invocationId, reviewerId: this.plan.reviewerId,
      effectiveInvocationDigest: this.effectiveInvocationDigest, ...this.sealed, ...result });
  }
}

export interface WorkflowNativeReviewTraceProof {
  readonly observer: 'codex-rollout-trace';
  readonly producer: { readonly version: string; readonly sha256: string };
  readonly directory: string;
  readonly seals: WorkflowReviewOwnedReference;
  readonly observed: WorkflowReviewOwnedReference;
  readonly calls: WorkflowReviewOwnedReference;
  readonly requests: number;
  readonly abandoned?: number;
  readonly transport?: WorkflowNativeBodyObserverSettlement;
  readonly compaction?: Awaited<ReturnType<WorkflowNativeCompactionChain['finish']>>;
  readonly calibration?: NativeCalibrationTrace;
}
/** Offline verification is evidence checking only; it never mints a live native capability. */
export async function verifyWorkflowNativeReviewTrace(input: {
  directory: string; bundle: WorkflowReviewSourceBundle; reviewerId: string; invocationId: string; effectiveInvocationDigest: string;
  threadId: string; turnId: string; callCount: number; attestation: unknown;
  resultText: string;
  capture: WorkflowReviewOwnedReference; correlation: WorkflowReviewOwnedReference;
  request?: string; schema?: unknown; transport?: WorkflowNativeBodyObserverSettlement; calibration?: NativeCalibrationTrace;
}): Promise<{ proof: WorkflowReviewOwnedReference; ranges: number; reconstructionSha256: string; native: WorkflowNativeReviewTraceProof }> {
  const code = 'workflow_review_native_trace_incomplete';
  const held: WorkflowReviewOwnedFile[] = [];
  const open = (directory: string, name: string, create = false) => {
    const file = new WorkflowReviewOwnedFile(directory, name, create); held.push(file); return file;
  };
  let machine: WorkflowReviewCoverageMachine | undefined;
  let serving: NativeSourceProgressTracker | undefined;
  let result: Awaited<ReturnType<typeof verifyWorkflowNativeReviewTrace>>;
  let cleanupFailure: { value: unknown } | undefined;
  let chain: WorkflowNativeCompactionChain | undefined;
  const transactions = input.transport ? iterateWorkflowNativeObservedTransactions({ directory: join(input.directory, 'bodies'),
    invocationId: input.invocationId, settlement: input.transport, artifactsDirectory: input.directory }) : undefined;
  try {
  const parsed = assertWorkflowReviewCoverageAttribution(input.bundle, input.attestation, input.reviewerId);
  const calibration = input.calibration;
  const turns = calibration ? [input.turnId, calibration.compactTurnId, calibration.postTurnId] : [input.turnId];
  if (calibration && (!input.transport || calibration.firstTurnId !== input.turnId || new Set(turns).size !== 3
    || turns.some(turn => typeof turn !== 'string' || !turn) || !calibration.compactionId
    || !Number.isSafeInteger(calibration.firstCallCount) || calibration.firstCallCount < 2
    || calibration.firstCallCount >= input.callCount)) throw new Error(code);
  verifyWorkflowReviewOwnedReference(input.directory, input.capture); verifyWorkflowReviewOwnedReference(input.directory, input.correlation);
  const capture = open(input.directory, input.capture.name);
  const correlations = open(input.directory, input.correlation.name);
  const journal = open(input.directory, 'calls.jsonl');
  const seals = open(input.directory, 'native-seals.jsonl', true);
  const observed = open(input.directory, 'native-observed.jsonl', true);
  machine = new WorkflowReviewCoverageMachine(input.bundle, { directory: join(input.directory, 'reconstruction'),
    invocationId: input.invocationId, reviewerId: input.reviewerId, effectiveInvocationDigest: input.effectiveInvocationDigest });
  mkdirSync(join(input.directory, 'consumed')); mkdirSync(join(input.directory, 'model-calls'));
  const traceDirectory = join(input.directory, 'trace'); const listing = opendirSync(traceDirectory);
  let nativeDirectory: string;
  try {
    const entry = listing.readSync();
    if (!entry || !entry.isDirectory() || !/^trace-[a-f0-9-]+$/.test(entry.name) || listing.readSync()) throw new Error(code);
    nativeDirectory = join(traceDirectory, entry.name);
  } finally { listing.closeSync(); }
  const trace = open(nativeDirectory!, 'trace.jsonl');
  const sealPayload = (reference: unknown, kind: string): string => {
    const ref = reference as { path?: string; kind?: { type?: string }; raw_payload_id?: string } | undefined;
    if (!ref || ref.kind?.type !== kind || !/^payloads\/[1-9][0-9]*\.json$/.test(ref.path ?? '')
      || ref.raw_payload_id !== `raw_payload:${ref.path!.slice(9, -5)}`) throw new Error(code);
    const file = new WorkflowReviewOwnedFile(nativeDirectory!, ref.path!);
    try { seals.append(wire({ directory: nativeDirectory!.slice(input.directory.length + 1), ...file.seal() })); }
    finally { file.close(); }
    return join(nativeDirectory!, ref.path!);
  };
  const boundedPayload = (reference: unknown, kind: string): Record<string, unknown> => {
    const path = sealPayload(reference, kind); return ownedJson(dirname(path), path.slice(dirname(path).length + 1));
  };
  const flattenInventory = (tools: unknown): void => {
    if (!Array.isArray(tools)) throw new Error('workflow_review_reader_observation_incomplete');
    let count = 0;
    for (const namespace of tools as Record<string, unknown>[]) {
      if (namespace.type !== 'namespace' || namespace.name !== WORKFLOW_REVIEW_NATIVE_NAMESPACE || !Array.isArray(namespace.tools)) {
        throw new Error('workflow_review_reader_observation_incomplete');
      }
      for (const tool of namespace.tools as Record<string, unknown>[]) {
        const expected = NATIVE_WIRE_TOOLS[count++];
        if (!expected || tool.type !== 'function' || tool.name !== expected.name || tool.defer_loading === true
          || !isDeepStrictEqual(tool.parameters, expected.inputSchema)) throw new Error('workflow_review_reader_observation_incomplete');
      }
    }
    if (count !== TOOLS.length) throw new Error('workflow_review_reader_observation_incomplete');
  };
  let count = 0; let received = 0; let receivedReceipts = 0; let sequence = 0; let offset = 0; let previousResponse: string | undefined;
  let firstCallCount = 0; let completedTurns = 0; let currentTurnId = input.turnId; let firstSourceReceived = false; let postSourceReceived = false;
  let pendingInference: { id: string; path: string; postSource: boolean } | undefined; let requestCount = 0; let inventory = false;
  let finalResult = false; let abandonedCount = 0; let reconnectChannel: number | undefined;
  let currentWire: WorkflowNativeObservedTransaction | undefined;
  let pendingCompact: { id: string; requestId: string; completed: boolean } | undefined;
  let outputBatch = 0;
  const nextWire = async (): Promise<WorkflowNativeObservedTransaction | undefined> => {
    if (!transactions) return undefined;
    let next = await transactions.next(); if (next.done || typeof input.request !== 'string') throw new Error(code);
    const retain = (transaction: WorkflowNativeObservedTransaction): void => {
      seals.append(wire({ directory: 'bodies', ...transaction.wire }));
      seals.append(wire({ directory: 'bodies', ...transaction.decoded }));
    };
    retain(next.value);
    if (!chain) {
      const iterator = iterateWorkflowReviewNativeItems(next.value.request);
      let toolsHash: string;
      try { const first = iterator.next(); if (first.done || first.value.type !== 'additional_tools' || !first.value.fields.tools) throw new Error(code); toolsHash = first.value.fields.tools; }
      finally { iterator.return(undefined); }
      chain = new WorkflowNativeCompactionChain({ directory: join(input.directory, 'ancestry'), artifactsDirectory: input.directory,
        threadId: input.threadId, turnId: input.turnId, toolsSha256: toolsHash,
        toolNames: [WORKFLOW_REVIEW_READER_TOOL_MANIFEST, WORKFLOW_REVIEW_READER_TOOL_READ],
        controllerPromptContentSha256: workflowReviewNativeTextContentSha256(input.request) });
      const control = readWorkflowReviewNativeRequestControls(next.value.request.file, next.value.request.representation);
      if (control.generate === false) {
        if (next.value.outcome !== 'completed') throw new Error(code);
        for (const record of iterateWorkflowReviewJsonRecords({ path: join(input.directory, next.value.request.file.name),
          arrayKey: 'input', found: { value: false }, streamScalars: true, skipTypes: ['message'] })) {
          const item = JSON.parse(record) as Record<string, unknown>; if (item.type !== 'additional_tools') throw new Error(code); flattenInventory(item.tools);
        }
        chain.registerWarmup(next.value.request, { kind: 'model-event', eventType: 'response.completed', responseId: next.value.response.responseId,
          output: { sha256: next.value.response.sha256, count: next.value.response.count, mask: 0 } });
        inventory = true;
        previousResponse = next.value.response.responseId;
        next = await transactions.next(); if (next.done) throw new Error(code);
        retain(next.value);
      }
    }
    return next.value;
  };
  const proveModelOutput = (file: WorkflowReviewOwnedFile, responseId?: string): void => {
    if (!currentWire) { if (transactions) throw new Error(code); return; }
    if (currentWire.outcome !== 'completed') throw new Error(code);
    if (responseId !== undefined && currentWire.response.responseId !== responseId) throw new Error(code);
    const aggregate = createHash('sha256').update('array\n'); let count = 0n;
    for (const item of iterateWorkflowReviewNativeItems({ file, arrayKey: 'output_items' })) { aggregate.update(item.sha256 + '\n'); count++; }
    if (String(count) !== currentWire.response.count || aggregate.digest('hex') !== currentWire.response.sha256) throw new Error(code);
  };
  const receiveSource = (path: string, inferenceId: string): boolean => {
    const batch = chain ? new WorkflowReviewOwnedFile(input.directory, `source-outputs-${++outputBatch}.json`, true) : undefined;
    let postSource = false;
    try {
    batch?.append(Buffer.from('{"input":[')); let outputs = 0;
    for (const record of iterateWorkflowReviewJsonRecords({ path, arrayKey: 'input', found: { value: false }, streamScalars: true,
      skipTypes: ['message', 'reasoning', 'compaction', 'additional_tools', 'function_call', 'compaction_trigger'] })) {
      const item = JSON.parse(record) as Record<string, unknown>;
      if (item.type !== 'function_call_output') throw new Error(code);
      if (typeof item.call_id !== 'string') throw new Error(code);
      const call = ownedJson(join(input.directory, 'calls'), nativeCallName(item.call_id)) as unknown as NativeCallRecord;
      const modelCall = ownedJson(join(input.directory, 'model-calls'), nativeCallName(item.call_id));
      if (call.callId !== item.call_id || modelCall.call_id !== item.call_id) throw new Error(code);
      const response = frameObject(capture.read(call.response.offset, call.response.bytes));
      const text = ((response.result as { contentItems: { text: string }[] }).contentItems[0]!).text;
      if (typeof item.output !== 'string' || item.output !== text) throw new Error('workflow_review_native_delivery_mismatch');
      const marker = join(input.directory, 'consumed', nativeCallName(item.call_id));
      if (!existsSync(marker)) {
        if (call.receipt) { machine!.record(call.receipt, ++receivedReceipts); observed.append(wire(call.receipt)); }
        if (call.receipt && calibration && currentTurnId === calibration.firstTurnId && call.receipt.kind === 'entry'
          && call.receipt.id?.startsWith('src-') && call.receipt.bytes > 0) firstSourceReceived = true;
        if (call.receipt && calibration && currentTurnId === calibration.postTurnId && call.receipt.kind === 'entry'
          && call.receipt.id?.startsWith('src-') && call.receipt.bytes > 0) {
          const request = frameObject(capture.read(call.request.offset, call.request.bytes));
          if ((request.params as { turnId?: unknown }).turnId !== calibration.postTurnId) throw new Error(code);
          postSource = true;
        }
        writeWorkflowReviewArtifact({ path: marker, chunks: [wire({ callId: item.call_id, inference: inferenceId })] }); received++;
        batch?.append(Buffer.from((outputs++ ? ',' : '') + record));
      }
    }
    if (batch) {
      batch.append(Buffer.from(']}'));
      if (outputs) chain!.recordToolOutputs({ file: batch, arrayKey: 'input' });
      seals.append(wire({ directory: '', ...batch.seal() }));
    }
    return postSource;
    } finally { batch?.close(); }
  };
  let threadStarted = false; let threadEnded = false; let turnStarted = false; let turnEnded = false; let ended = false;
    for await (const line of streamWorkflowReviewLines(correlations)) {
      const record = frameObject(Buffer.from(line));
      const frame = record.frame as { offset: number; bytes: number; sha256: string };
      if (record.invocationId !== input.invocationId || record.reviewerId !== input.reviewerId
        || record.effectiveInvocationDigest !== input.effectiveInvocationDigest || record.sequence !== ++sequence
        || !frame || frame.offset !== offset || frame.bytes < 1 || frame.bytes > 65536) throw new Error('workflow_review_evidence_corrupt');
      const bytes = capture.read(frame.offset, frame.bytes); offset += bytes.length;
      if (sha(bytes) !== frame.sha256 || !isUtf8(bytes) || bytes.at(-1) !== 10 || !['request', 'receive'].includes(String(record.direction))) {
        throw new Error('workflow_review_evidence_corrupt');
      }
      frameObject(bytes);
    }
    if (offset !== input.capture.bytes) throw new Error('workflow_review_evidence_corrupt');
    serving = new NativeSourceProgressTracker(input.bundle);
    for await (const line of streamWorkflowReviewLines(journal)) {
      const call = frameObject(Buffer.from(line)) as unknown as NativeCallRecord;
      const retained = ownedJson(join(input.directory, 'calls'), nativeCallName(call.callId));
      if (!isDeepStrictEqual(call, retained)) throw new Error('workflow_review_evidence_corrupt');
      const request = capture.read(call.request.offset, call.request.bytes); const response = capture.read(call.response.offset, call.response.bytes);
      const requestMessage = frameObject(request); const responseMessage = frameObject(response);
      const params = requestMessage.params as Record<string, unknown>;
      if (sha(request) !== call.request.sha256 || sha(response) !== call.response.sha256 || response.length > WORKFLOW_REVIEW_READ_LIMIT_BYTES
        || requestMessage.method !== 'item/tool/call' || requestMessage.id !== call.requestId || responseMessage.id !== call.requestId
        || params.threadId !== input.threadId || !(calibration ? [calibration.firstTurnId, calibration.postTurnId] : [input.turnId]).includes(String(params.turnId)) || params.callId !== call.callId
        || params.namespace != null || params.tool !== call.tool || !isDeepStrictEqual(params.arguments, call.arguments)
        || !WORKFLOW_REVIEW_READER_TOOLS.includes(call.tool)) throw new Error('workflow_review_evidence_corrupt');
      const replay = readNativeSource(input.bundle, serving, call.tool, readerArguments(call.tool, call.arguments), call.requestId);
      if (!isDeepStrictEqual(responseMessage, { id: call.requestId, result: replay.result })) throw new Error('workflow_review_evidence_corrupt');
      if (replay.refusal) {
        if (call.refusal !== replay.refusal || Object.hasOwn(call, 'receipt')) throw new Error('workflow_review_evidence_corrupt');
      } else if (Object.hasOwn(call, 'refusal') || !replay.page
        || !isDeepStrictEqual(workflowReviewSourceReceipt(replay.page), call.receipt)) throw new Error('workflow_review_evidence_corrupt');
      const callFile = new WorkflowReviewOwnedFile(join(input.directory, 'calls'), nativeCallName(call.callId));
      try { seals.append(wire({ directory: 'calls', ...callFile.seal() })); } finally { callFile.close(); }
      count++;
      if (params.turnId === input.turnId) firstCallCount++;
    }
    if (count !== input.callCount || calibration && firstCallCount !== calibration.firstCallCount) throw new Error(code);
    sequence = 0;
    for await (const line of streamWorkflowReviewLines(trace)) {
      const event = frameObject(Buffer.from(line)); const payload = event.payload as Record<string, unknown>;
      if (event.schema_version !== 1 || event.seq !== ++sequence || event.rollout_id !== input.threadId || ended || !payload) throw new Error(code);
      switch (payload.type) {
        case 'rollout_started':
          if (sequence !== 1 || payload.root_thread_id !== input.threadId) throw new Error(code); break;
        case 'thread_started': {
          if (threadStarted || payload.thread_id !== input.threadId || payload.agent_path !== '/root') throw new Error(code);
          threadStarted = true;
          const metadata = boundedPayload(payload.metadata_payload, 'session_metadata');
          if (metadata.thread_id !== input.threadId || metadata.model !== 'gpt-6.1-sol' || metadata.provider_name !== 'openai'
            || metadata.approval_policy !== 'never') throw new Error('workflow_review_reader_qualification_mismatch');
          break;
        }
        case 'codex_turn_started':
          if (!threadStarted || turnStarted || payload.thread_id !== input.threadId || payload.codex_turn_id !== turns[completedTurns]) throw new Error(code);
          currentTurnId = String(payload.codex_turn_id);
          if (calibration && completedTurns === 1) {
            if (!chain) throw new Error(code); chain.beginManualCompaction(currentTurnId);
          }
          if (calibration && completedTurns === 2) {
            if (!chain) throw new Error(code); chain.beginPostCompactionTurn(currentTurnId, workflowReviewNativeTextContentSha256(calibration.postRequest));
          }
          turnStarted = true; turnEnded = false; break;
        case 'inference_started': {
          if (finalResult || !turnStarted || turnEnded || pendingInference || pendingCompact || calibration && completedTurns === 1
            || payload.thread_id !== input.threadId || payload.codex_turn_id !== currentTurnId
            || payload.model !== 'gpt-6.1-sol' || payload.provider_name !== 'OpenAI' || typeof payload.inference_call_id !== 'string') throw new Error(code);
          const path = sealPayload(payload.request_payload, 'inference_request');
          currentWire = await nextWire();
          if (reconnectChannel !== undefined) {
            if (!currentWire || currentWire.channelId === reconnectChannel
              || readWorkflowReviewNativeRequestControls(currentWire.request.file, currentWire.request.representation).previousResponseId !== undefined) throw new Error(code);
            reconnectChannel = undefined;
          }
          if (currentWire) {
            const native = new WorkflowReviewOwnedFile(input.directory, path.slice(input.directory.length + 1).replaceAll('\\', '/'));
            try {
              const controls = readWorkflowReviewNativeRequestControls(currentWire.request.file, currentWire.request.representation);
              if (currentWire.outcome === 'abandoned' && (controls.model !== 'gpt-6.1-sol' || controls.effort !== 'xhigh'
                || controls.context !== 'all_turns' || controls.parallel !== false || controls.threadId !== input.threadId
                || controls.sessionId !== input.threadId || controls.turnId !== currentTurnId || controls.requestKind !== 'turn'
                || controls.generate !== undefined)) throw new Error('workflow_review_reader_qualification_mismatch');
              if (input.schema === undefined || !isDeepStrictEqual(controls.text?.format,
                { type: 'json_schema', strict: true, schema: input.schema, name: 'codex_output_schema' })) throw new Error('workflow_review_reader_qualification_mismatch');
              if (fingerprintWorkflowReviewNativeRequest(native) !== fingerprintWorkflowReviewNativeRequest(currentWire.request.file)) throw new Error(code);
            } finally { native.close(); }
          }
          let prior: unknown; let model: unknown; let effort: unknown; let parallel: unknown; let topTools = false;
          for (const field of iterateWorkflowReviewJsonFields({ path, arrayKey: ['input', 'tools', 'include'],
            fields: ['previous_response_id', 'model', 'reasoning', 'parallel_tool_calls'] })) {
            if (field.key === 'previous_response_id') prior = JSON.parse(field.raw);
            if (field.key === 'model') model = JSON.parse(field.raw);
            if (field.key === 'reasoning') effort = (JSON.parse(field.raw) as { effort?: unknown }).effort;
            if (field.key === 'parallel_tool_calls') parallel = JSON.parse(field.raw);
          }
          if (model !== 'gpt-6.1-sol' || effort !== 'xhigh' || parallel !== false || prior != null && prior !== previousResponse) throw new Error('workflow_review_reader_qualification_mismatch');
          const topFound = { value: false };
          for (const record of iterateWorkflowReviewJsonRecords({ path, arrayKey: 'tools', found: topFound, streamScalars: true })) {
            const tool = JSON.parse(record); flattenInventory([tool]); topTools = true;
          }
          const found = { value: false }; let stated = topTools;
          for (const record of iterateWorkflowReviewJsonRecords({ path, arrayKey: 'input', found, streamScalars: true, skipTypes: ['message', 'reasoning', 'compaction'] })) {
            const item = JSON.parse(record) as Record<string, unknown>;
            if (item.type === 'additional_tools') { if (stated) throw new Error(code); flattenInventory(item.tools); stated = true; }
          }
          if (!found.value || (!stated && (!inventory || prior !== previousResponse || !previousResponse))) throw new Error('workflow_review_reader_observation_incomplete');
          const abandoned = currentWire?.outcome === 'abandoned';
          if (stated && !abandoned) inventory = true;
          const postSource = abandoned ? false : receiveSource(path, payload.inference_call_id);
          if (currentWire && !abandoned) await chain!.startGeneration(payload.inference_call_id, currentWire.request);
          pendingInference = { id: payload.inference_call_id, path, postSource }; requestCount++; break;
        }
        case 'inference_failed': {
          if (!pendingInference || !currentWire || currentWire.outcome !== 'abandoned'
            || payload.inference_call_id !== pendingInference.id || event.thread_id !== input.threadId || event.codex_turn_id !== currentTurnId
            || payload.error !== 'stream disconnected before completion: websocket closed by server before response.completed'
            || payload.partial_response_payload !== null) throw new Error(code);
          abandonedCount++; reconnectChannel = currentWire.channelId; pendingInference = undefined; currentWire = undefined; break;
        }
        case 'inference_completed': {
          if (!pendingInference || payload.inference_call_id !== pendingInference.id || typeof payload.response_id !== 'string') throw new Error(code);
          const path = sealPayload(payload.response_payload, 'inference_response'); const found = { value: false };
          if (currentWire) {
            const native = new WorkflowReviewOwnedFile(input.directory, path.slice(input.directory.length + 1).replaceAll('\\', '/'));
            try { proveModelOutput(native, payload.response_id); chain!.completeGeneration(pendingInference.id, payload.response_id, { file: native, arrayKey: 'output_items' }); }
            finally { native.close(); }
          }
          if (pendingInference.postSource) postSourceReceived = true;
          for (const record of iterateWorkflowReviewJsonRecords({ path, arrayKey: 'output_items', found, streamScalars: true, skipTypes: ['reasoning'] })) {
            const item = JSON.parse(record) as Record<string, unknown>;
            if (item.type === 'message' && item.phase === 'final_answer') {
              const content = item.content as { type?: string; text?: string }[];
              const partial = calibration && completedTurns === 0;
              if (finalResult || received !== (partial ? calibration.firstCallCount : count) || !Array.isArray(content)
                || content.some(part => part.type !== 'output_text' || typeof part.text !== 'string')
                || !isDeepStrictEqual(JSON.parse(content.map(part => part.text).join('')), JSON.parse(partial ? calibration.firstResult : input.resultText))) throw new Error(code);
              if (partial) {
                if (!firstSourceReceived) throw new Error(code);
                assertNativePartialCalibration(input.bundle, calibration.firstResult, input.reviewerId, machine.rangeCount);
              } else {
                if (calibration && !postSourceReceived) throw new Error(code);
                machine.finish(parsed);
              }
              finalResult = true;
            }
            if (item.type !== 'function_call') continue;
            if (finalResult || typeof item.call_id !== 'string' || !WORKFLOW_REVIEW_READER_TOOLS.includes(String(item.name))) throw new Error(code);
            const call = ownedJson(join(input.directory, 'calls'), nativeCallName(item.call_id)) as unknown as NativeCallRecord;
            if (item.name !== call.tool || !isDeepStrictEqual(JSON.parse(String(item.arguments)), call.arguments)) throw new Error(code);
            writeWorkflowReviewArtifact({ path: join(input.directory, 'model-calls', nativeCallName(item.call_id)), chunks: [wire(item)] });
          }
          if (!found.value) throw new Error(code);
          previousResponse = payload.response_id; pendingInference = undefined; currentWire = undefined; break;
        }
        case 'compaction_request_started': {
          if (!transactions || finalResult || !turnStarted || turnEnded || pendingInference || pendingCompact
            || payload.thread_id !== input.threadId || payload.codex_turn_id !== currentTurnId || payload.model !== 'gpt-6.1-sol'
            || payload.provider_name !== 'OpenAI' || typeof payload.compaction_id !== 'string' || typeof payload.compaction_request_id !== 'string') throw new Error(code);
          currentWire = await nextWire(); if (!currentWire || currentWire.outcome !== 'completed' || !chain || reconnectChannel !== undefined) throw new Error(code);
          if (calibration && completedTurns === 1 && payload.compaction_id !== calibration.compactionId) throw new Error(code);
          const path = sealPayload(payload.request_payload, 'compaction_request');
          const native = new WorkflowReviewOwnedFile(input.directory, path.slice(input.directory.length + 1).replaceAll('\\', '/'));
          try {
            receiveSource(join(input.directory, currentWire.request.file.name), payload.compaction_request_id);
            await chain.startCompaction(payload.compaction_id, payload.compaction_request_id, currentWire.request, { file: native, arrayKey: 'input' });
          } finally { native.close(); }
          pendingCompact = { id: payload.compaction_id, requestId: payload.compaction_request_id, completed: false }; break;
        }
        case 'compaction_request_completed': {
          if (!chain || !currentWire || currentWire.outcome !== 'completed' || !pendingCompact || pendingCompact.completed || payload.compaction_id !== pendingCompact.id
            || payload.compaction_request_id !== pendingCompact.requestId) throw new Error(code);
          const path = sealPayload(payload.response_payload, 'compaction_response');
          const native = new WorkflowReviewOwnedFile(input.directory, path.slice(input.directory.length + 1).replaceAll('\\', '/'));
          try {
            proveModelOutput(native); chain.completeCompactionReceipt(pendingCompact.id, pendingCompact.requestId, currentWire.response, { file: native, arrayKey: 'output_items' });
          } finally { native.close(); }
          pendingCompact.completed = true; currentWire = undefined; previousResponse = undefined; break;
        }
        case 'compaction_installed': {
          if (!chain || !pendingCompact?.completed || payload.compaction_id !== pendingCompact.id) throw new Error(code);
          const path = sealPayload(payload.checkpoint_payload, 'compaction_checkpoint');
          const native = new WorkflowReviewOwnedFile(input.directory, path.slice(input.directory.length + 1).replaceAll('\\', '/'));
          try { await chain.installCompaction(pendingCompact.id, native); } finally { native.close(); }
          pendingCompact = undefined; break;
        }
        case 'codex_turn_ended':
          if (!turnStarted || turnEnded || pendingInference || pendingCompact || payload.codex_turn_id !== currentTurnId || payload.status !== 'completed'
            || completedTurns !== 1 && !finalResult || !calibration && !finalResult) throw new Error(code);
          completedTurns++; turnEnded = true;
          if (completedTurns < turns.length) { turnStarted = false; finalResult = false; }
          break;
        case 'thread_ended':
          if (!turnEnded || completedTurns !== turns.length || threadEnded || payload.thread_id !== input.threadId || payload.status !== 'completed') throw new Error(code);
          threadEnded = true; break;
        case 'rollout_ended':
          if (!threadEnded || payload.status !== 'completed') throw new Error(code); ended = true; break;
        case 'tool_call_started': {
          const requester = payload.requester as { type?: string }; const kind = payload.kind as { type?: string; name?: string };
          if (finalResult || requester?.type !== 'model' || kind?.type !== 'other' || !WORKFLOW_REVIEW_READER_TOOLS.includes(String(kind.name))) throw new Error(code);
          sealPayload(payload.invocation_payload, 'tool_invocation'); break;
        }
        case 'tool_call_ended': {
          if (payload.status === 'failed') {
            if (typeof payload.tool_call_id !== 'string') throw new Error(code);
            const call = ownedJson(join(input.directory, 'calls'), nativeCallName(payload.tool_call_id)) as unknown as NativeCallRecord;
            const modelCall = ownedJson(join(input.directory, 'model-calls'), nativeCallName(payload.tool_call_id));
            const response = frameObject(capture.read(call.response.offset, call.response.bytes));
            const text = ((response.result as { contentItems: { text: string }[] }).contentItems[0]!).text;
            if (![NATIVE_CURSOR_REFUSAL, NATIVE_ORDER_REFUSAL].includes(call.refusal!) || call.callId !== payload.tool_call_id || modelCall.call_id !== call.callId
              || !isDeepStrictEqual(boundedPayload(payload.result_payload, 'tool_result'), { type: 'direct_response',
                response_item: { type: 'function_call_output', call_id: call.callId, output: text } })) throw new Error(code);
          } else {
            if (payload.status !== 'completed') throw new Error(code);
            sealPayload(payload.result_payload, 'tool_result');
          }
          break;
        }
        case 'protocol_event_observed': sealPayload(payload.event_payload, 'protocol_event'); break;
        default: throw new Error(code);
      }
    }
    if (!ended || completedTurns !== turns.length || pendingInference || pendingCompact || reconnectChannel !== undefined || !inventory || !requestCount || !finalResult || !machine.isFinished || received !== count
      || abandonedCount !== (input.transport?.stats.abandoned ?? 0)) throw new Error(code);
    if (transactions && !(await transactions.next()).done) throw new Error(code);
    const compaction = chain ? await chain.finish(false) : undefined;
    if (input.transport) seals.append(wire({ directory: 'bodies', ...input.transport.journal }));
    if (compaction) {
      seals.append(wire({ directory: 'ancestry', ...compaction.history }));
      seals.append(wire({ directory: 'ancestry', ...compaction.seals }));
    }
    seals.append(wire({ directory: nativeDirectory!.slice(input.directory.length + 1), ...trace.seal() }));
    seals.append(wire({ directory: '', ...journal.seal() }));
    for await (const line of streamWorkflowReviewLines(seals)) {
      const seal = frameObject(Buffer.from(line)); verifyWorkflowReviewOwnedReference(join(input.directory, String(seal.directory)), seal as unknown as WorkflowReviewOwnedReference);
    }
    verifyWorkflowReviewOwnedReference(input.directory, input.capture); verifyWorkflowReviewOwnedReference(input.directory, input.correlation);
    result = Object.freeze({ proof: machine.retainedProof, ranges: machine.rangeCount, reconstructionSha256: machine.reconstructionDigest,
      native: Object.freeze({ observer: 'codex-rollout-trace' as const, producer: NATIVE_CODEX,
        directory: nativeDirectory!.slice(input.directory.length + 1), seals: seals.seal(), observed: observed.seal(),
        calls: journal.seal(), requests: requestCount, ...(abandonedCount ? { abandoned: abandonedCount } : {}), ...(input.transport ? { transport: input.transport, compaction } : {}),
        ...(calibration ? { calibration } : {}) }) });
  } finally {
    try { await transactions?.return(undefined); } catch (value) { cleanupFailure = { value }; }
    for (const close of [() => serving?.dispose(), () => chain?.dispose(), () => machine?.dispose(), ...held.map(file => () => file.close())]) {
      try { close(); } catch (value) { cleanupFailure ??= { value }; }
    }
  }
  if (cleanupFailure) throw cleanupFailure.value;
  return result;
}

export async function runWorkflowReviewSourceServer(): Promise<void> {
  const bundlePath = process.env.OMC_REVIEW_SOURCE_BUNDLE;
  if (!bundlePath) throw new Error('workflow_review_source_bundle_unavailable');
  const bundle = openWorkflowReviewSourceBundle(bundlePath);
  const receiptsPath = process.env.OMC_REVIEW_SOURCE_RECEIPTS;
  const server = createWorkflowReviewSourceServer({ bundle,
    ...(receiptsPath ? { onReceipt: (receipt: WorkflowReviewSourceReceipt) => appendWorkflowReviewSourceReceipt(receiptsPath, receipt) } : {}) });
  await server.connect(createWorkflowReviewSourceTransport());
  const metrics = process.env.OMC_REVIEW_SOURCE_METRICS;
  if (metrics) process.once('exit', () => {
    const usage = workflowReviewResourceUsage();
    const file = new WorkflowReviewOwnedFile(dirname(metrics), metrics.slice(dirname(metrics).length + 1), true);
    try { file.append(wire(usage)); } finally { file.close(); }
  });
}

declare const OMC_SYNTHETIC_LIBRARY: boolean;
if ((typeof OMC_SYNTHETIC_LIBRARY === 'undefined' || !OMC_SYNTHETIC_LIBRARY)
  && process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runWorkflowReviewSourceServer().catch(error => { console.error(error instanceof Error ? error.message : 'workflow_review_source_server_failed'); process.exit(1); });
}
const SYNTHETIC_REVIEWER_SCRIPT = `/* global require, process */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { connectWorkflowSyntheticReviewBridge } from 'omc-synthetic-reader';
const config = JSON.parse(fs.readFileSync(process.env.OMC_WORKFLOW_TEST_CONFIG, 'utf8'));
const behavior = config.tasks?.review ?? {};
const request = JSON.parse(fs.readFileSync(0, 'utf8'));
const args = process.argv.slice(2);
const emit = value => process.stdout.write(JSON.stringify(value) + '\\n');
const page = response => JSON.parse(response.result.content[0].text);
const spoolDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omc-review-consumer-'));
/**
 * The client's own record of what it was handed, appended as each page is accepted: one bounded
 * JSON line per delivered range, in served order, carrying exactly the receipt fields the coverage
 * machine re-derives. Pages that carry no material are not deliveries and are never recorded. This
 * is an *observation of the wire*, so an altered payload or an altered range digest is recorded
 * here exactly as it arrived — the record is evidence, not a restatement of intent.
 */
/** Decode exactly the bytes one page declares it returned, and bind them to its own declaration. */
const decodedPage = value => {
  const bytes = value.encoding === 'base64' ? Buffer.from(value.content, 'base64') : Buffer.from(value.content, 'utf8');
  if (bytes.length !== value.bytes) throw new Error('a returned page did not carry the bytes it declared');
  // An oblivious run — the positive control for wire corruption — accepts pages on their declared
  // length alone, so it can continue to a plausible end with its own counts intact while the record
  // of what it actually received is the only thing that disagrees with the frozen source.
  if (!behavior.observeOnly && crypto.createHash('sha256').update(bytes).digest('hex') !== value.rangeSha256)
    throw new Error('a returned page did not match its own declared range digest');
  return bytes;
};
/**
 * Walk one spooled manifest as bounded records: the bounded header is captured, then each entry
 * object is scanned by balanced braces with escape awareness, so only one record is ever held and
 * the whole document is never parsed at once.
 */
function* manifestRecords(file) {
  const descriptor = fs.openSync(file, 'r');
  const buffer = Buffer.alloc(64 * 1024);
  // A chunk boundary can fall inside a multibyte character. The decoder holds the incomplete tail
  // back until the bytes that complete it arrive, so a character split across two reads is never
  // decoded into replacement characters — which would corrupt both the record text and the brace
  // scanning that walks it.
  const decoder = new StringDecoder('utf8');
  let pending = ''; let head = ''; let scanning = false; let record = ''; let depth = 0;
  let inString = false; let escaped = false; let ended = false; let trailer = '';
  try {
    for (;;) {
      const read = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      pending += read <= 0 ? '' : decoder.write(buffer.subarray(0, read));
      let consumed = 0;
      while (consumed < pending.length) {
        if (!scanning) {
          const marker = pending.indexOf('"entries":[', consumed);
          if (marker < 0) { head += pending.slice(consumed); consumed = pending.length; break; }
          head += pending.slice(consumed, marker);
          if (!head || head.length > 4096) throw new Error('the manifest header was not a bounded document');
          consumed = marker + 11; scanning = true; continue;
        }
        const character = pending[consumed++];
        // Once the array has closed, every remaining character belongs to the outer document itself:
        // it is carried to EOF rather than discarded, so the trailer is validated as well and a
        // closing bracket landing at a chunk seam cannot be mistaken for the end of the document.
        if (ended) { trailer += character; continue; }
        if (inString) {
          record += character;
          if (escaped) escaped = false;
          else if (character === '\\\\') escaped = true;
          else if (character === '"') inString = false;
          continue;
        }
        if (character === '"') { inString = true; record += character; continue; }
        if (character === '{') { depth += 1; record += character; continue; }
        if (character === '}') {
          depth -= 1; record += character;
          if (!depth) { yield { head, record }; record = ''; }
          continue;
        }
        if (depth) { record += character; continue; }
        // Between two records lies exactly the separating comma and, at most, formatting whitespace.
        // Anything else at this depth is material the canonical manifest never emits, so it is
        // refused rather than silently consumed as the previous implementation did.
        if (character === ',' || character === ' ' || character === '\\n' || character === '\\r' || character === '\\t') continue;
        if (character === ']') { ended = true; continue; }
        throw new Error('the manifest entry array carried an unexpected character');
      }
      pending = pending.slice(consumed);
      if (read <= 0) break;
    }
    // Whatever the decoder still holds at end of input is an unterminated character, so the manifest
    // did not end on a character boundary: it is refused rather than completed with a replacement
    // character that no source ever produced.
    if (decoder.end()) throw new Error('the manifest ended mid-character');
    // The record stream is complete only when the array really ended, every record closed, and the
    // outer document's own trailer — the closing brace and nothing else — was read through to EOF.
    if (!ended || depth || record || inString) throw new Error('the manifest was not a complete bounded record stream');
    if (!/^\\}\\s*$/.test(trailer)) throw new Error('the manifest trailer was not the complete outer object close');
  } finally { fs.closeSync(descriptor); }
}
/** Dotted-TOML overrides of one Codex invocation, with JSON values resolved back to their types. */
const configOverrides = argv => {
  const overrides = {};
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] !== '--config' && argv[index] !== '-c') continue;
    const entry = argv[index + 1] ?? '';
    const at = entry.indexOf('=');
    const value = entry.slice(at + 1);
    try { overrides[entry.slice(0, at)] = JSON.parse(value); } catch { overrides[entry.slice(0, at)] = value; }
  }
  return overrides;
};
let descriptor;
let bridge;
let failure; let failed = false;
const fail = error => { if (!failed) { failed = true; failure = error; } };
const settle = async () => { if (bridge) await bridge.close(); };
(async () => {
  descriptor = request.reviewSource;
  if (!descriptor) throw new Error('missing review source descriptor');
  // The descriptor is a fixed shape with no size of the source in it at all, so it can neither
  // state nor imply an aggregate ceiling. Any extra field, however named, fails here.
  const shape = Object.keys(descriptor).sort().join(',');
  if (shape !== 'adoptionSequence,entries,instructions,manifestDigest,responseBytes,reviewerId,server,tools') throw new Error('descriptor is not the exact bounded transport shape: ' + shape);
  // The compact request names the objective, task contracts, acceptance criteria, shared context,
  // inventory, binary diff and every authorized file only through the frozen bundle. No unbounded
  // field, and no file list, may reappear here.
  const unbounded = ["changes","context","objective","paths","projectInstructions","sharedContext","sourceInventory","tasks"].filter(key => key in request);
  const serialized = JSON.stringify(request);
  const requestKeys = Object.keys(request).sort();
  const route = process.env.FIXTURE_ROUTE;
  const overrides = configOverrides(args);
  const readerKey = 'mcp_servers.' + descriptor.server;
  const server = route === 'codex'
    ? { command: overrides[readerKey + '.command'], args: overrides[readerKey + '.args'],
      env: { OMC_REVIEW_SOURCE_BUNDLE: overrides[readerKey + '.env.OMC_REVIEW_SOURCE_BUNDLE'],
        OMC_REVIEW_SOURCE_RECEIPTS: overrides[readerKey + '.env.OMC_REVIEW_SOURCE_RECEIPTS'] } }
    : Object.values(JSON.parse(args[args.indexOf('--mcp-config') + 1]).mcpServers)[0];
  if (server.command !== process.execPath) throw new Error('reader is not launched by the controller interpreter');
  if (!Array.isArray(server.args) || server.args.length !== 1) throw new Error('reader argv is not the single server module');
  let catalogModels = null; let catalogBytes = null;
  if (route === 'codex') {
    // Codex accepts neither --mcp-config nor a global rewrite: both command-executing tool
    // features must be disabled for this invocation and the reader declared by --config alone.
    if (args.includes('--mcp-config')) throw new Error('codex invocation carried a claude-only flag');
    if (overrides['features.shell_tool'] !== false || overrides['features.unified_exec'] !== false)
      throw new Error('codex command tools were not disabled');
    if (overrides.model_reasoning_effort !== 'ultra') throw new Error('codex effort not preserved');
    if (args[args.indexOf('--model') + 1] !== 'gpt-6.1-sol') throw new Error('codex model not preserved');
    // A Codex host applies the model catalog at startup only, so this invocation must have been
    // handed the projected document itself. The reviewer reads the file it was actually given, so
    // a missing projection or a still-deferred tool surface cannot pass unnoticed.
    if (typeof overrides.model_catalog_json !== 'string' || !overrides.model_catalog_json)
      throw new Error('codex invocation carried no projected model catalog');
    const projectedCatalog = JSON.parse(fs.readFileSync(overrides.model_catalog_json, 'utf8'));
    const selectedModel = projectedCatalog.models.find(entry => entry.slug === args[args.indexOf('--model') + 1]);
    if (!selectedModel || selectedModel.tool_mode !== 'direct')
      throw new Error('the reviewed model was not projected onto a direct tool surface');
    catalogModels = projectedCatalog.models; catalogBytes = fs.statSync(overrides.model_catalog_json).size;
  } else if (!args.includes('--strict-mcp-config')) throw new Error('claude reader is not strict');
  bridge = await connectWorkflowSyntheticReviewBridge();
  let ranges = 0; let manifestRanges = 0;
  let entryRanges = 0; let pages = 0; let reconstructed = 0; let maxResponseBytes = 0; let complete = false;
  const call = async (method, params) => {
    const response = await bridge.call(method, params);
    maxResponseBytes = Math.max(maxResponseBytes, Buffer.byteLength(JSON.stringify(response)) + 1);
    return response;
  };
  await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'synthetic-reviewer', version: '1.0.0' } });
  bridge.notifyInitialized();
  const tools = (await call('tools/list', {})).result.tools.map(tool => tool.name);
  if (tools.length !== 2 || tools[0] !== descriptor.tools[0] || tools[1] !== descriptor.tools[1])
    throw new Error('the reader exposed a tool surface other than the two read-only tools');
  // The manifest is spooled and hashed as it arrives: no page text is concatenated in memory and the
  // document is never parsed whole. Its returned bytes must reconstruct to the frozen digest.
  const manifestSpool = path.join(spoolDir, 'manifest');
  const manifestHash = crypto.createHash('sha256');
  let manifestBytes = 0; let cursor = null;
  for (;;) {
    const pageArgs = cursor ? { cursor } : {};
    const manifest = page(await call('tools/call', { name: descriptor.tools[0], arguments: pageArgs }));
    const bytes = decodedPage(manifest);
    fs.appendFileSync(manifestSpool, bytes);
    manifestHash.update(bytes); manifestBytes += bytes.length; pages += 1;
    // A served page with no bytes is a legitimate empty object, not a delivered range: only pages
    // that actually carry material are receipts, exactly as the coverage machine counts them.
    if (manifest.bytes > 0) { manifestRanges += 1; ranges += 1; }
    if (manifest.cursor === null) { if (!manifest.complete) throw new Error('incomplete manifest without a cursor'); break; }
    if (manifest.complete) throw new Error('complete manifest with a cursor');
    cursor = manifest.cursor;
  }
  if (manifestBytes !== fs.statSync(manifestSpool).size) throw new Error('the spooled manifest was shortened');
  if (!behavior.observeOnly && manifestHash.digest('hex') !== descriptor.manifestDigest)
    throw new Error('the delivered manifest did not reconstruct to the frozen manifest digest');
  // The manifest's own accounting is re-derived from the records it was handed, one bounded record
  // at a time, rather than trusted from the descriptor.
  let entries = 0;
  for (const record of manifestRecords(manifestSpool)) { JSON.parse(record.record); entries += 1; }
  if (entries !== descriptor.entries) throw new Error('manifest does not hold the declared entry count');
  const readable = behavior.skipEntries ? entries - behavior.skipEntries : entries;
  let index = 0; let declaredTotalBytes = null; let summedBytes = 0; const leakedPaths = [];
  for (const record of manifestRecords(manifestSpool)) {
    if (declaredTotalBytes === null) {
      const match = /"totalBytes":(\\d+)/.exec(record.head);
      if (!match) throw new Error('the manifest carried no bounded byte total');
      declaredTotalBytes = Number(match[1]);
    }
    const entry = JSON.parse(record.record);
    if (typeof entry.id !== 'string' || !entry.id || !Number.isSafeInteger(entry.bytes)
      || !/^[a-f0-9]{64}$/.test(String(entry.sha256))) throw new Error('the manifest carried a malformed entry record');
    summedBytes += entry.bytes;
    // The compact request may name an authorized file only through the frozen bundle it points at,
    // so no path the manifest lists may appear verbatim in the serialization that was sent.
    if (typeof entry.path === 'string' && entry.path.includes('/') && serialized.includes(entry.path) && leakedPaths.length < 4)
      leakedPaths.push(entry.path);
    // Each object is read to its end and independently reconstructed against its manifest identity.
    if (index < readable) {
      const objectSpool = path.join(spoolDir, entry.id);
      const objectHash = crypto.createHash('sha256');
      let written = 0; let entryCursor = null;
      for (;;) {
        const pageArgs = entryCursor ? { id: entry.id, cursor: entryCursor } : { id: entry.id };
        const value = page(await call('tools/call', { name: descriptor.tools[1], arguments: pageArgs }));
        if (value.id !== entry.id) throw new Error('reader served the wrong entry');
        const bytes = decodedPage(value);
        if (written > value.offset || (written < value.offset && value.offset !== 0))
          throw new Error('a returned range did not tile its object in order');
        if (value.offset !== written) throw new Error('a returned range started at an offset that was never delivered');
        fs.appendFileSync(objectSpool, bytes);
        objectHash.update(bytes); written += bytes.length; pages += 1;
        if (value.bytes > 0) { entryRanges += 1; ranges += 1; }
        if (entryCursor === null ? value.offset !== 0 : false) throw new Error('a paged object skipped its first range');
        if (value.cursor === null) { if (!value.complete) throw new Error('incomplete entry without a cursor'); break; }
        if (value.complete) throw new Error('complete entry with a cursor');
        entryCursor = value.cursor;
      }
      // The byte count and whole-object digest the reviewer verifies are its own reconstruction of
      // what the transport actually returned — never the controller's, and never the source disk.
      // A run under declared obliviousness stops at the declared length, which is precisely what
      // lets it finish plausibly and hand over the record of what it really received.
      if (written !== entry.bytes) throw new Error('entry ' + entry.id + ' was not delivered in full');
      if (fs.statSync(objectSpool).size !== written) throw new Error('entry ' + entry.id + ' was shortened on disk');
      if (!behavior.observeOnly && objectHash.digest('hex') !== entry.sha256)
        throw new Error('entry ' + entry.id + ' did not reconstruct to its manifest identity');
      // An empty material is served as one complete zero-byte page and then carries no delivered
      // range, so it is verified above but is never counted as a reconstruction of returned bytes.
      if (entry.bytes > 0) reconstructed += 1;
    }
    index += 1;
  }
  if (summedBytes !== declaredTotalBytes) throw new Error('manifest total disagrees with its own entries');
  complete = true;
  const output = { findings: config.findings ?? [] };
  if (!behavior.omitCoverage) output.coverage = { bundleSha256: descriptor.manifestDigest,
    reviewerId: descriptor.reviewerId, complete: true, entries: descriptor.entries,
    ranges: ranges + (behavior.inflateRanges ? 1 : 0) };
  if (config.eventsPath) fs.appendFileSync(config.eventsPath, JSON.stringify({ role: 'reviewer', event: 'start',
    route, readerEntry: process.env.OMC_REVIEW_READER_ENTRY, serverArgs: server.args, serverCommand: server.command,
    serverEnv: Object.keys(server.env).sort(), tools, manifestDigest: descriptor.manifestDigest, toolsCount: descriptor.tools.length,
    entries: descriptor.entries, expectedTotalBytes: declaredTotalBytes, summedBytes, manifestBytes, reconstructed,
    ranges, manifestRanges, entryRanges, pages, leakedPaths,
    maxResponseBytes, complete,
    responseBytes: descriptor.responseBytes, descriptorShape: shape, requestKeys, unboundedRequestFields: unbounded,
    requestBytes: Buffer.byteLength(serialized), modelFlag: args[args.indexOf('--model') + 1] ?? null,
    effortConfig: overrides.model_reasoning_effort ?? null, configKeys: Object.keys(overrides).sort(),
    commandTools: { shell_tool: overrides['features.shell_tool'], unified_exec: overrides['features.unified_exec'] },
    catalogModels, catalogBytes,
    mcpConfig: args.includes('--mcp-config'), strictMcpConfig: args.includes('--strict-mcp-config'),
    instructions: descriptor.instructions.slice(0, 60) }) + '\\n');
  return output;
})().then(async output => {
  // The reader is settled *before* any result is published. A failure observed while the reader is
  // being torn down — a truncated trailing frame, an input write that never drained — must poison the
  // run, and a success emitted first could not be taken back.
  await settle();
  if (failed) throw failure;
  const result = JSON.stringify(output);
  if (process.env.FIXTURE_ROUTE === 'codex') {
    fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], result);
    if (!behavior.quiet) emit({ type: 'turn.completed', usage: { input_tokens: 12, cached_input_tokens: 3, output_tokens: 4 } });
  } else emit({ type: 'result', subtype: 'success', is_error: false, session_id: '33333333-3333-4333-8333-333333333333', structured_output: output,
    usage: { input_tokens: 9, output_tokens: 4, cache_read_input_tokens: 3, cache_creation_input_tokens: 0 } });
}).catch(async error => {
  // Every terminal path — success, refusal or an exception raised anywhere above, including inside
  // the wire callback — settles the reader first and only then reports. The report is the first
  // asynchronously observed failure, so a page that was already refused is not masked by whatever
  // tearing the reader down happened to raise afterwards.
  fail(error);
  try { await settle(); } catch (settlementError) { fail(settlementError); }
  process.stderr.write(String(failure ?? error));
  process.exitCode = 1;
});
`;
/**
 * A test-only reader transport: the very same server module the controller projects, with its
 * returned bytes altered in flight. `wire` alters what the reviewer receives while every declared
 * byte count, offset and range digest stays exactly as it was, so only the payload is wrong;
 * `wire-rehash` alters the payload *and* recomputes the range digest that describes it, so each page
 * is internally consistent on the wire and only the frozen source can contradict it; `ledger` alters
 * the bytes recorded as delivered, keeping the receipt internally consistent, so the record of the
 * delivery disagrees with the frozen source. All three are what a dishonest or broken transport
 * looks like from one side, and none of them may pass unnoticed.
 */
const SYNTHETIC_CORRUPT_READER_SCRIPT = `/* global process */
import { createHash } from 'node:crypto';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { appendWorkflowReviewSourceReceipt, createWorkflowReviewSourceServer } from 'omc-synthetic-reader';
import { openWorkflowReviewSourceBundle } from 'omc-synthetic-source';

const mode = process.env.OMC_REVIEW_CORRUPT_MODE;
const receiptsPath = process.env.OMC_REVIEW_SOURCE_RECEIPTS;
const bundle = openWorkflowReviewSourceBundle(process.env.OMC_REVIEW_SOURCE_BUNDLE);
/** Alter the original bytes of one page: same decoded length, different content. */
const alter = value => {
  const bytes = value.encoding === 'base64' ? Buffer.from(value.content, 'base64') : Buffer.from(value.content, 'utf8');
  const copy = Buffer.from(bytes);
  const at = copy.findIndex(byte => (byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122));
  if (at < 0) throw new Error('the fixture could not alter a page');
  copy[at] ^= 0x20;
  return { content: value.encoding === 'base64' ? copy.toString('base64') : copy.toString('utf8'),
    rangeSha256: createHash('sha256').update(copy).digest('hex'), bytes: copy.length };
};
let altered = false;
const server = createWorkflowReviewSourceServer({ bundle, onReceipt: receipt => {
  let recorded = receipt;
  if (mode === 'ledger' && !altered && receipt.kind === 'entry') {
    altered = true;
    const changed = alter(recorded);
    // The receipt stays self-consistent — the same length, a digest of its own bytes — so it looks
    // exactly like a plausible delivery and only the whole-object reconstruction can expose it.
    recorded = { ...recorded, content: changed.content, rangeSha256: changed.rangeSha256 };
  }
  if (receiptsPath) appendWorkflowReviewSourceReceipt(receiptsPath, recorded);
} });
const transport = new StdioServerTransport();
const send = transport.send.bind(transport);
transport.send = async message => {
  const content = message?.result?.content;
  if ((mode === 'wire' || mode === 'wire-rehash') && !altered && Array.isArray(content) && typeof content[0]?.text === 'string') {
    const read = JSON.parse(content[0].text);
    if (read.kind === 'entry') {
      altered = true;
      const changed = alter(read);
      // A 'wire' alteration leaves every declaration exactly as it was, so the payload alone
      // disagrees with the digest that describes it and any honest consumer must refuse. A
      // 'wire-rehash' alteration repairs the declaration too, so the page is self-consistent on the
      // wire, every declared count and metadata field still looks plausible, and only the client's
      // own record of the delivered bytes — reconstructed against the frozen source — can expose it.
      content[0].text = JSON.stringify(mode === 'wire'
        ? { ...read, content: changed.content }
        : { ...read, content: changed.content, rangeSha256: changed.rangeSha256 });
    }
  }
  return send(message);
};
await server.connect(transport);
`;
