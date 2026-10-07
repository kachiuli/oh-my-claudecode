/**
 * Explicit administrative review-compatibility adoption and the per-review compatibility
 * selection it authorizes, under the original operation, lease and budget gates.
 *
 * An adoption is one bounded append-only attributed ledger entry: it consumes no review, changes no
 * saved plan, option, binding, pin or counter, and is revalidated against the live head, reviewer
 * identity, controller build, reader build and versioned transport policy at every invocation. It
 * records the authorized source as an immutable on-disk manifest addressed by one constant
 * descriptor — path, byte count, record count and digest over the final-PR pair — instead of a
 * prospective list of paths; a review may only restate that descriptor, never a different file set.
 *
 * An adopted review delivers the authorized complete source only through the controller-owned
 * bounded read-only reader, which both provider routes receive as a *per-invocation* projection:
 * a Claude `--mcp-config` document or repeated Codex dotted-TOML `--config` overrides with the two
 * command-executing tool features disabled. The compact request carries no unbounded material at
 * all — the objective, task contracts, acceptance criteria, shared context, instructions, inventory,
 * binary diff and every authorized file live only in the frozen on-disk bundle the reviewer pages by
 * opaque continuation cursor. Findings are accepted only after attributed complete coverage is proven
 * by replaying the controller-captured requests, responses and acknowledgements into whole-object proofs.
 *
 * The synthetic reviewers boot the reader from a bundle of the real reader module, because a
 * source-mode child cannot import this repository's `.js` specifiers. The consumer decodes every
 * page it actually received, verifies its returned offset/length/range hash, spools and hashes each
 * object incrementally and compares the whole object against the manifest identity before it emits
 * findings — it never trusts the controller's own verdict, and it holds one bounded record at a
 * time. Two corruption fixtures exercise that: a transport that alters what the reviewer receives
 * while every declared count, offset and digest stays plausible must be refused by the consumer, and
 * a delivery whose recorded bytes disagree with the frozen source must be refused by the controller.
 * Everything else the controller supplies is used unchanged: the reader identity bound into the
 * adoption, the reader projection's command, bundle path and receipt path, and the
 * controller-generated adoption receipt, delivery receipts, frozen bundle and coverage artifact that
 * are validated here are the real ones.
 */
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as childProcess from 'node:child_process';
import * as net from 'node:net';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { WORKFLOW_HELP, workflowCommand } from '../../cli/commands/team-workflow.js';
import * as workflow from '../workflow.js';
import { fingerprintWorkflowAuthProfile } from '../workflow-adapters.js';
import type { WorkflowAuthProfile, WorkflowRuntime } from '../workflow-adapters.js';
import {
  parseWorkflowBinding, parseWorkflowState, WORKFLOW_REVIEW_BUFFER_LIMIT_BYTES, WORKFLOW_REVIEW_READ_LIMIT_BYTES,
  WORKFLOW_REVIEW_SOURCE_MANIFEST_SCHEMA_VERSION, workflowReviewTransportPolicy,
} from '../workflow-contracts.js';
import type { WorkflowOptions, WorkflowPlan, WorkflowReviewAttemptV2, WorkflowStateV2,
  WorkflowReviewSourceManifestDescriptor } from '../workflow-contracts.js';
import { iterateWorkflowReviewManifestEntries, iterateWorkflowReviewNulRecords, openWorkflowReviewSourceBundle,
  resetWorkflowReviewResourceUsage, spoolWorkflowReviewGit, streamWorkflowReviewLines,
  workflowReviewResourceUsage, writeWorkflowReviewArtifact, WorkflowReviewOwnedFile } from '../workflow-review-source.js';
import type { WorkflowReviewOwnedReference, WorkflowReviewSourceBundle, WorkflowReviewSourceEntry } from '../workflow-review-source.js';
import {
  buildWorkflowSyntheticReviewCapsule, createWorkflowSyntheticReviewClientFactory, projectWorkflowReviewCodexCatalog, workflowReviewReaderBuildIdentity,
  WORKFLOW_REVIEW_READER_TOOLS,
  type WorkflowReviewEffectiveInvocation,
  type WorkflowSyntheticReviewCapsule,
  WorkflowSyntheticReviewSession,
} from '../workflow-review-source-server.js';
import { createWorkflowFixture } from './helpers/workflow-fixture.js';
import { binding, hash, runtimeFixture } from './helpers/workflow-v2-fixture.js';

vi.mock('node:net', async importOriginal => ({ ...await importOriginal<typeof import('node:net')>() }));
vi.mock('node:fs', async importOriginal => ({ ...await importOriginal<typeof import('node:fs')>() }));
vi.mock('node:child_process', async importOriginal => ({ ...await importOriginal<typeof import('node:child_process')>() }));

/** The retired aggregate source ceiling this delta removes, retained as red evidence. */
const RETIRED_BUNDLE_CEILING_BYTES = 16 * 1024 * 1024;
/** The exact transport descriptor shape: fixed, bounded and carrying no size of the source. */
const DESCRIPTOR_KEYS = 'adoptionSequence,entries,instructions,manifestDigest,responseBytes,reviewerId,server,tools';
const passingCheck = { command: process.execPath, args: ['-e', 'process.exit(0)'] };
const REVIEWER_ID = 'actor-reviewer';
const CODEX_MODEL = 'gpt-6.1-sol';
const CODEX_EFFORT = 'ultra';
/**
 * The host's own complete model catalog. The reader invocation is projected from exactly this
 * document: every record and every unrelated field must survive, and only the selected model's tool
 * mode becomes direct, so the reviewer runs the binding's own model with a reachable tool surface.
 */
const HOST_CATALOG = {
  schemaVersion: 3,
  models: [
    { slug: CODEX_MODEL, displayName: 'Sol', tool_mode: 'code_mode_only', contextWindow: 128000, metadata: { keep: true } },
    { slug: 'gpt-6-astra', displayName: 'Astra', tool_mode: 'code_mode', contextWindow: 400000 },
  ],
  notes: ['preserved'],
};
/** The projected catalog is the host catalog with exactly one field of exactly one record changed. */
const PROJECTED_MODELS = [{ ...HOST_CATALOG.models[0]!, tool_mode: 'direct' }, HOST_CATALOG.models[1]!];
const READER_DIR = mkdtempSync(join(tmpdir(), 'omc-review-reader-'));
let capsule: WorkflowSyntheticReviewCapsule;
let corruptCapsule: WorkflowSyntheticReviewCapsule;
let READER_ENTRY: string;
let CORRUPT_ENTRY: string;
/**
 * A provider-neutral reviewer that pages the controller's reader over a real MCP connection on
 * whichever route it was invoked. It resolves the reader from the projection the controller
 * actually supplied — a Claude `--mcp-config` document or Codex `--config` overrides — asserts the
 * exact bounded descriptor and compact request shape, refuses any wire response above the adopted
 * bound, walks the manifest and every entry by following opaque continuation cursors to completion,
 * and independently reconstructs every object it was delivered: each page is decoded from its own
 * declared encoding, its returned offset/length/range digest is verified, its bytes are spooled and
 * hashed incrementally, and the whole object is compared with the manifest identity before any
 * finding or attestation is emitted. It reports the ranges it actually read and the objects it
 * actually reconstructed.
 */
describe('administrative review compatibility', () => {
  let fixture: ReturnType<typeof createWorkflowFixture>;
  beforeAll(async () => {
    capsule = await buildWorkflowSyntheticReviewCapsule(join(READER_DIR, 'normal'));
    corruptCapsule = await buildWorkflowSyntheticReviewCapsule(join(READER_DIR, 'fault'), true);
    READER_ENTRY = capsule.reader; CORRUPT_ENTRY = corruptCapsule.reader;
  }, 600_000);
  afterAll(() => { rmSync(READER_DIR, { recursive: true, force: true }); });
  beforeEach(() => {
    fixture = createWorkflowFixture();
    // State lives inside the fixture checkout, and the controller's lead-authority guard is told
    // this is not a worker context, so the test is independent of the environment that runs it.
    vi.stubEnv('OMC_STATE_DIR', '');
    for (const name of ['OMC_TEAM_WORKER', 'OMC_TEAM_WORKER_NAME', 'OMC_TEAM_WORKTREE_PATH']) vi.stubEnv(name, '');
  });
  // The physical source case owns several hundred thousand retained files; its real cleanup exceeds
  // the default ten-second hook allowance. This changes only the test runner's filesystem cleanup.
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); fixture.dispose(); }, 1_800_000);

  const name = 'compat';
  const base = () => fixture.git('rev-parse', 'HEAD');
  const events = () => readFileSync(fixture.eventsPath, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  const artifact = (file: string) => join(fixture.cwd, `.omc/state/team/${name}/artifacts`, file);
  /** The constant bundle descriptor exposes no entry array; a consumer walks one bounded record. */
  const entriesOf = (bundle: WorkflowReviewSourceBundle) => [...iterateWorkflowReviewManifestEntries(bundle)];
  /** The controller returns a version-tagged state; compatibility operations are v2-only. */
  const v2 = (state: ReturnType<typeof workflow.readWorkflow>): WorkflowStateV2 => {
    expect(state.schemaVersion).toBe(2);
    return state as WorkflowStateV2;
  };
  const v2Attempt = (state: ReturnType<typeof workflow.readWorkflow>): WorkflowReviewAttemptV2 =>
    v2(state).reviewAttempts!.at(-1)! as WorkflowReviewAttemptV2;
  function plan(taskCount = 1, head = base()): WorkflowPlan {
    return { name, objective: 'Exercise one adopted compatibility review', baseCommit: head,
      integrationBranch: `integration/${name}`, verification: [passingCheck],
      tasks: Array.from({ length: taskCount }, (_, index) => ({ id: ['a', 'b'][index], objective: `Implement owned component ${index}`,
        baseCommit: head, writeScope: [`feature/${['a', 'b'][index]}.txt`], readScope: ['README.md'], prohibitedScope: [], dependencies: [],
        contracts: ['One complete owned component'], acceptanceCriteria: ['One committed component passes its declared check'], tests: [passingCheck] })) };
  }
  /**
   * A reviewer binding on either provider route whose executable boots the controller's reader over
   * a real MCP connection. The Codex route is bound to the exact gpt-6.1-sol/ultra selection.
   */
  function reviewerBinding(configured: ReturnType<typeof runtimeFixture>, route: 'claude' | 'codex',
    readerEntry = READER_ENTRY, extraEnvironment: Record<string, string> = {}) {
    const script = (readerEntry === CORRUPT_ENTRY ? corruptCapsule : capsule).reviewer;
    const base = route === 'codex'
      ? parseWorkflowBinding({ ...binding('reviewer', 'codex'), id: 'reviewer-codex-compat', model: CODEX_MODEL, effort: CODEX_EFFORT })
      : parseWorkflowBinding({ ...binding('reviewer', 'claude'), id: 'reviewer-claude-compat' });
    const authProfile: WorkflowAuthProfile = { ref: base.authProfileRef, providerRoute: route, files: [],
      environment: { OMC_WORKFLOW_TEST_CONFIG: fixture.configPath, FIXTURE_ROUTE: route,
        OMC_REVIEW_READER_ENTRY: readerEntry, ...extraEnvironment } };
    const executableIdentity = { path: script, sha256: hash(readFileSync(script)), version: '1.0' };
    const authFingerprint = fingerprintWorkflowAuthProfile(authProfile);
    const evidence = { schemaVersion: 1, role: 'reviewer', providerRoute: route, cliFamily: base.cliFamily, validation: 'synthetic',
      executableIdentity, authFingerprint, capabilities: base.capabilities,
      models: [{ model: base.model, efforts: [base.effort ?? null] }],
      dependencies: [{ path: process.execPath, sha256: hash(readFileSync(process.execPath)) }], actorId: REVIEWER_ID };
    const bytes = JSON.stringify(evidence);
    const capabilityEvidencePath = join(fixture.root, `${base.id}.capability.json`);
    writeFileSync(capabilityEvidencePath, bytes);
    const selected = parseWorkflowBinding({ ...base, executableIdentity, authFingerprint, capabilityEvidenceSha256: hash(bytes) });
    configured.profiles.set(selected.id, { authProfile, capabilityEvidencePath });
    return { selected, executableIdentity, route };
  }
  /** Publish one host-owned private file and bind it by digest, exactly as a real host would. */
  const publish = (file: string, value: unknown) => {
    const path = join(fixture.root, file);
    writeFileSync(path, JSON.stringify(value));
    return { path, sha256: hash(readFileSync(path)) };
  };
  /**
   * Write one authorized source manifest — JSONL path records sorted strictly ascending, exactly the
   * canonical form the controller consumes — and return the immutable descriptor that binds it. The
   * name is derived from the content, so restating the same authorized set always yields the
   * identical descriptor, while any omitted, added or reordered member yields a different one.
   */
  function authorize(paths: readonly string[], file?: string): WorkflowReviewSourceManifestDescriptor {
    const records = [...new Set(paths)].sort();
    const content = records.map(entry => `${JSON.stringify(entry)}\n`).join('');
    const sha256 = hash(content);
    const path = join(fixture.root, file ?? `authorized-${sha256.slice(0, 16)}.jsonl`);
    writeFileSync(path, content);
    return { schemaVersion: WORKFLOW_REVIEW_SOURCE_MANIFEST_SCHEMA_VERSION, path, bytes: Buffer.byteLength(content),
      records: records.length, sha256 };
  }
  /** A hand-written authorized manifest, for the shapes no correct writer would ever emit. */
  function rawManifest(records: readonly string[], file: string): WorkflowReviewSourceManifestDescriptor {
    const content = records.map(record => `${JSON.stringify(record)}\n`).join('');
    const path = join(fixture.root, file);
    writeFileSync(path, content);
    return { schemaVersion: WORKFLOW_REVIEW_SOURCE_MANIFEST_SCHEMA_VERSION, path, bytes: Buffer.byteLength(content),
      records: records.length, sha256: hash(content) };
  }
  let qualificationSequence = 0;
  /**
   * One bounded evidence pair for a qualification: two distinct private ledgers describing the same
   * delivery, a non-empty delivered range count and one whole-object reconstruction identity. It is a
   * *declaration* rather than a real observation — a synthetic record is never re-derived from the
   * frozen bundle — and is therefore admitted only inside a runner that declared itself synthetic.
   */
  function qualificationEvidence(sequence: number) {
    return { bundleSha256: '1'.repeat(64), proof: { ranges: 5, reconstructionSha256: '2'.repeat(64) },
      observed: { path: join(fixture.root, `qualification-observed-${sequence}.jsonl`), sha256: '3'.repeat(64), bytes: 4096, ranges: 5 },
      intended: { path: join(fixture.root, `qualification-intended-${sequence}.jsonl`), sha256: '4'.repeat(64), bytes: 4096, ranges: 5 } };
  }
  /**
   * The private host qualification record for the reader this run projects. Its effective invocation
   * is computed prospectively by the controller's own builder from the host's own inputs — the
   * controller build, the reader build and the digest of every module it imports, the reviewer CLI
   * path/digest/version, the route, the exact model and effort, the authenticated profile and
   * fingerprint, the real reader module path and the complete prospective reviewer argv, and the
   * input and projected catalog digests — so the record qualifies this one invocation and nothing
   * else.
   */
  function qualificationRecord(reviewer: ReturnType<typeof reviewerBinding>, catalogPath: string,
    overrides: Record<string, unknown> = {}) {
    const catalog = reviewer.route === 'codex'
      ? projectWorkflowReviewCodexCatalog({ source: catalogPath, path: join(fixture.root, 'qualification-catalog.json'),
          model: reviewer.selected.model })
      : undefined;
    const invocation: WorkflowReviewEffectiveInvocation = workflow.workflowReviewProspectiveInvocation(
      reviewer.selected, reviewer.route, catalog);
    return { invocation, record: { schemaVersion: 2, validation: 'synthetic', invocation,
      evidence: qualificationEvidence(++qualificationSequence),
      routes: ['codex', 'claude'], delivered: true, actorId: REVIEWER_ID, ...overrides } };
  }
  async function setup(options: { tasks?: number; reviewerRoute?: 'claude' | 'codex'; workflow?: WorkflowOptions;
    readerEntry?: string; readerEnvironment?: Record<string, string> } = {}) {
    writeFileSync(join(fixture.cwd, 'AGENTS.md'), 'Complete governing instruction for the compatibility fixture.\n');
    fixture.git('add', '--', 'AGENTS.md');
    fixture.git('commit', '-m', 'Track the governing instruction');
    const head = base();
    const configured = runtimeFixture(fixture);
    // Labels constrain the supported mode; only the branded controller capsule and runtime factory
    // can authorize the live reviewer connection and its observed reader inventory.
    configured.runtime.readerObservation = { mode: 'synthetic', tools: [...WORKFLOW_REVIEW_READER_TOOLS] };
    const reviewer = reviewerBinding(configured, options.reviewerRoute ?? 'claude',
      options.readerEntry, options.readerEnvironment);
    // The historical qualification record remains a consistency guard. It cannot create a factory
    // or completion capability, and unsupported native entry points refuse before projection.
    configured.runtime.syntheticReviewClientFactory = createWorkflowSyntheticReviewClientFactory({
      capsule: options.readerEntry === CORRUPT_ENTRY ? corruptCapsule : capsule,
      binding: reviewer.selected, cwd: fixture.cwd, catalogSource: join(fixture.root, 'host-catalog.json') });
    const catalogPath = join(fixture.root, 'host-catalog.json');
    writeFileSync(catalogPath, JSON.stringify(HOST_CATALOG));
    const qualify = (overrides: Record<string, unknown> = {}) => {
      const { invocation, record } = qualificationRecord(reviewer, catalogPath, overrides);
      return { invocation, ...publish(`reader-qualification-${++qualificationSequence}.json`, record) };
    };
    const qualified = qualify();
    configured.runtime.readerQualification = { path: qualified.path, sha256: qualified.sha256, catalogPath };
    const bindings = { lead: binding('lead', 'codex'), implementer: configured.selectedBinding('implementer', 'claude', 'actor-author'),
      reviewer: reviewer.selected };
    await workflow.initWorkflowV2(fixture.cwd, plan(options.tasks ?? 1, head), bindings,
      { maxAttempts: 1, maxReviewPasses: 3, backoffMs: 0, timeoutMs: 60_000, ...options.workflow });
    return { configured, bindings, head, qualified, qualify, catalogPath };
  }
  type Setup = Awaited<ReturnType<typeof setup>>;
  /** Run, accept and verify every declared task, then report the integrated head. */
  async function integrate(scope: Setup, tasks: string[] = ['a']) {
    for (const id of tasks) {
      await workflow.runWorkflow(fixture.cwd, name, scope.configured.runtime);
      await workflow.acceptWorkflowTask(fixture.cwd, name, id);
    }
    await workflow.verifyWorkflow(fixture.cwd, name);
    return workflow.readWorkflow(fixture.cwd, name).integrationHead;
  }
  /** The adopted transport is two buffers and no aggregate. */
  const transport = () => workflowReviewTransportPolicy();
  /**
   * The adoption intent of the authorized source. Its pair defaults to the final PR's own base —
   * the fixture's first commit — and the reviewed head, deliberately not the plan's narrower task
   * base, so an adopted review is always a review of a real pair. The source is named by its
   * immutable disk manifest descriptor, never by a prospective list of paths.
   */
  const intent = (scope: Setup, head: string, paths: string[] = ['README.md'], overrides: Record<string, unknown> = {},
    descriptor: WorkflowReviewSourceManifestDescriptor = authorize(paths)) =>
    ({ requestId: 'compat-adoption-1', source: { baseCommit: fixture.baseCommit, head, descriptor },
      controller: workflow.workflowReviewControllerBuildIdentity(), reader: workflowReviewReaderBuildIdentity(),
      transport: transport(), reviewerBindingId: scope.bindings.reviewer.id,
      reviewerAuthFingerprint: scope.bindings.reviewer.authFingerprint, actor: { id: 'lead-codex', model: 'gpt-6-astra' },
      authorityRef: 'issue-60', reason: 'Adopt lossless read-only review source delivery', ...overrides });
  const selection = (requestId: string, paths: string[]) => ({ requestId, descriptor: authorize(paths) });
  /** Adopt a real final-PR pair; the base defaults to the PR's own base rather than the task delta. */
  const adopt = (scope: Setup, head: string, paths: string[] = ['README.md'], baseCommit: string = fixture.baseCommit) => {
    const descriptor = authorize(paths);
    return workflow.adoptWorkflowReviewCompatibility(fixture.cwd, name,
      intent(scope, head, paths, { source: { baseCommit, head, descriptor } }, descriptor));
  };
  const review = (scope: Setup, compat?: { requestId: string; descriptor: WorkflowReviewSourceManifestDescriptor }) =>
    workflow.reviewWorkflow(fixture.cwd, name, scope.configured.runtime, compat ? { compatibility: compat } : undefined);
  /** The frozen bundle directory of the last completed review, reopened from disk. */
  const frozenBundle = (state: ReturnType<typeof workflow.readWorkflow>) => {
    const digest = v2Attempt(state).compatibility!.bundleSha256;
    return { digest, bundle: openWorkflowReviewSourceBundle(artifact(`review-source-bundle-${v2Attempt(state).invocationId}`)) };
  };

  /** Join both saved proofs to the manifest and hash one retained object at a time. */
  const verifyRetainedDelivery = async (state: ReturnType<typeof workflow.readWorkflow>, bundle: WorkflowReviewSourceBundle,
    inspectEntry?: (entry: WorkflowReviewSourceEntry) => void) => {
    const attempt = v2Attempt(state);
    const directory = `review-delivery-${attempt.invocationId}`;
    const coveragePath = artifact(`review-coverage-${attempt.pass}.json`);
    expect(state.reviews.at(-1)!.artifacts.find(entry => entry.kind === 'workflow-review-coverage'))
      .toMatchObject({ path: coveragePath });
    const coverage = JSON.parse(readFileSync(coveragePath, 'utf8'));
    expect(coverage).toMatchObject({ bundleSha256: bundle.digest, reviewerId: REVIEWER_ID, entries: bundle.entryCount });
    expect(coverage.delivery).toMatchObject({ directory, invocationId: attempt.invocationId, reviewerId: REVIEWER_ID,
      effectiveInvocationDigest: expect.stringMatching(/^[a-f0-9]{64}$/) });
    const owner = { invocationId: attempt.invocationId, reviewerId: REVIEWER_ID,
      effectiveInvocationDigest: coverage.delivery.effectiveInvocationDigest };
    const roots = [join(artifact(directory), 'reconstruction'), join(artifact(directory), 'replay')];
    const entries = iterateWorkflowReviewManifestEntries(bundle);
    let originalFile: WorkflowReviewOwnedFile | undefined; let replayFile: WorkflowReviewOwnedFile | undefined;
    let originalLines: AsyncGenerator<string> | undefined; let replayLines: AsyncGenerator<string> | undefined;
    let failed = false; let failure: unknown;
    let reconstructed = 0; let sequence = 0; let proofBytes = 0;
    const proofHash = createHash('sha256'); const reconstructionHash = createHash('sha256');
    try {
      originalFile = new WorkflowReviewOwnedFile(roots[0]!, 'proof.jsonl');
      replayFile = new WorkflowReviewOwnedFile(roots[1]!, 'proof.jsonl');
      const original = originalLines = streamWorkflowReviewLines(originalFile);
      const replay = replayLines = streamWorkflowReviewLines(replayFile);
      const verify = async (expected: WorkflowReviewOwnedReference & { kind: 'manifest' | 'entry'; id: string | null }) => {
        const actual = await original.next(); const replayed = await replay.next();
        expect(actual.done).toBe(false); expect(replayed).toEqual(actual);
        const record = JSON.parse(actual.value);
        expect(record).toEqual({ ...owner, ...expected, terminalSequence: expect.any(Number) });
        expect(Number.isSafeInteger(record.terminalSequence)).toBe(true);
        expect(record.terminalSequence).toBeGreaterThan(sequence); sequence = record.terminalSequence;
        proofBytes += Buffer.byteLength(actual.value); proofHash.update(actual.value);
        for (const root of roots) {
          const file = new WorkflowReviewOwnedFile(root, expected.name);
          let objectFailed = false;
          try {
            expect(statSync(join(root, expected.name)).size).toBe(expected.bytes);
            const contentHash = createHash('sha256');
            for (let offset = 0; offset < expected.bytes; offset += WORKFLOW_REVIEW_BUFFER_LIMIT_BYTES) {
              contentHash.update(file.read(offset, Math.min(WORKFLOW_REVIEW_BUFFER_LIMIT_BYTES, expected.bytes - offset)));
            }
            // Recheck opened custody after the last range, including the empty object.
            file.read(expected.bytes, 0);
            expect(contentHash.digest('hex')).toBe(expected.sha256);
          } catch (error) { objectFailed = true; throw error; }
          finally { if (objectFailed) { try { file.close(); } catch { /* preserve the assertion failure */ } } else file.close(); }
        }
        reconstructionHash.update(`${expected.kind}:${expected.id ?? ''}:${expected.bytes}:${expected.sha256}\n`);
        reconstructed++;
      };
      await verify({ kind: 'manifest', id: null, name: 'manifest', bytes: bundle.manifestBytes, sha256: bundle.digest });
      for (const entry of entries) {
        await verify({ kind: 'entry', id: entry.id, name: `entry-${entry.id}`, bytes: entry.bytes, sha256: entry.sha256 });
        inspectEntry?.(entry);
      }
      expect((await original.next()).done).toBe(true); expect((await replay.next()).done).toBe(true);
      expect(reconstructed).toBe(bundle.entryCount + 1);
      expect(coverage.delivery.proof).toEqual({ name: 'proof.jsonl', bytes: proofBytes, sha256: proofHash.digest('hex') });
      const digest = reconstructionHash.digest('hex');
      expect(coverage.reconstructionSha256).toBe(digest); expect(coverage.delivery.reconstructionSha256).toBe(digest);
    } catch (error) { failed = true; failure = error; }
    finally {
      for (const close of [() => originalLines?.return(undefined), () => replayLines?.return(undefined),
        () => entries.return(undefined), () => originalFile?.close(), () => replayFile?.close()]) {
        try { await close(); } catch (error) { if (!failed) { failed = true; failure = error; } }
      }
    }
    if (failed) throw failure;
    return coverage;
  };

  it.each(['missing', 'unreadable'] as const)('refuses a %s actual reviewer config before projection, bundle or reservation', async fault => {
    const scope = await setup({ reviewerRoute: 'codex' }); const head = await integrate(scope); await adopt(scope, head);
    const before = readdirSync(artifact('')); const originalOpen = fs.openSync;
    if (fault === 'missing') rmSync(fixture.configPath);
    else vi.spyOn(fs, 'openSync').mockImplementation(((path, flags, mode) => {
      if (String(path) === fixture.configPath) throw Object.assign(new Error('unreadable actual config'), { code: 'EACCES' });
      return originalOpen(path, flags, mode);
    }) as typeof fs.openSync);
    await expect(review(scope, selection('compat-adoption-1', ['README.md']))).rejects.toThrow();
    const state = workflow.readWorkflow(fixture.cwd, name);
    expect(state.reviewPasses).toBe(0); expect(state.reviewAttempts ?? []).toEqual([]); expect(state.reviews).toEqual([]);
    expect(readdirSync(artifact(''))).toEqual(before);
    expect(events().filter(event => event.role === 'reviewer')).toEqual([]);
  }, 600_000);

  it('derives the mandatory reviewer config from the actual launch and refuses its drift before provider start', async () => {
    const scope = await setup(); const head = await integrate(scope); await adopt(scope, head);
    const start = WorkflowSyntheticReviewSession.prototype.start;
    vi.spyOn(WorkflowSyntheticReviewSession.prototype, 'start').mockImplementation(async function (this: WorkflowSyntheticReviewSession) {
      fixture.configure({ findings: [{ severity: 'P3', message: 'Changed after preparation', file: 'README.md', line: null }] });
      return start.call(this);
    });
    await expect(review(scope, selection('compat-adoption-1', ['README.md']))).rejects.toThrow('workflow_review_prepared_launch_changed');
    const state = workflow.readWorkflow(fixture.cwd, name);
    expect(state.reviews).toEqual([]); expect(v2Attempt(state).processResult).toBeUndefined();
    expect(events().filter(event => event.role === 'reviewer')).toEqual([]);
  }, 600_000);

  it.each(['wrong', 'missing', 'wrong-with-repository-change'] as const)('rejects a %s live bridge ACK and joins the actual reviewer and reader closes', async fault => {
    const scope = await setup(); const head = await integrate(scope); await adopt(scope, head);
    const expectedError = fault === 'wrong-with-repository-change'
      ? 'workflow_reviewer_modified_repository' : 'workflow_review_process_failed';
    if (fault === 'wrong-with-repository-change') {
      const settle = WorkflowSyntheticReviewSession.prototype.settle;
      vi.spyOn(WorkflowSyntheticReviewSession.prototype, 'settle').mockImplementation(async function (this: WorkflowSyntheticReviewSession) {
        await settle.call(this);
        fixture.git('update-ref', 'refs/heads/reviewer-mutated', head);
      });
    }
    const originalServer = net.createServer; let injected = false; let peerClosed = false; let serverClosed = false;
    const spawn = childProcess.spawn; let readerClosed = false;
    vi.spyOn(childProcess, 'spawn').mockImplementation((...args) => {
      const child = Reflect.apply(spawn, undefined, args) as ReturnType<typeof childProcess.spawn>;
      if (Array.isArray(args[1]) && args[1][0] === capsule.reader) child.once('close', () => { readerClosed = true; });
      return child;
    });
    vi.spyOn(net, 'createServer').mockImplementation(((listener: (socket: net.Socket) => void) => {
      const server = originalServer(socket => {
        socket.once('close', () => { peerClosed = true; });
        const on = socket.on.bind(socket); let pending = Buffer.alloc(0);
        socket.on = ((event: string, callback: (...args: unknown[]) => void) => {
          if (event !== 'data') return on(event, callback);
          return on('data', (chunk: Buffer) => {
            pending = Buffer.concat([pending, chunk]);
            for (;;) {
              const end = pending.indexOf(10); if (end < 0) break;
              let frame = pending.subarray(0, end + 1); pending = pending.subarray(end + 1);
              const message = JSON.parse(frame.toString('utf8')) as Record<string, unknown>;
              if (!injected && 'ack' in message) {
                injected = true;
                if (fault === 'missing') continue;
                frame = Buffer.from(JSON.stringify({ ...message, sha256: '0'.repeat(64) }) + '\n');
              }
              callback(frame);
            }
          });
        }) as typeof socket.on;
        listener(socket);
      });
      server.once('close', () => { serverClosed = true; }); return server;
    }) as typeof net.createServer);
    await expect(review(scope, selection('compat-adoption-1', ['README.md']))).rejects.toThrow(expectedError);
    expect(injected).toBe(true); expect(peerClosed).toBe(true); expect(serverClosed).toBe(true); expect(readerClosed).toBe(true);
    const state = workflow.readWorkflow(fixture.cwd, name); const attempt = v2Attempt(state);
    expect(state.reviews).toEqual([]); expect(attempt.error).toBe(expectedError);
    expect(attempt.processResult?.passed).toBe(false);
    expect(attempt.processResult?.integrityDiagnostic).toMatch(/workflow_review_transport_(ack|request|incomplete)/);
    expect(attempt.processResult?.error).not.toBe('timeout');
    expect(existsSync(artifact('review-1.integrity.json'))).toBe(fault !== 'wrong-with-repository-change');
    expect(existsSync(artifact('review-coverage-1.json'))).toBe(false);
  }, 600_000);

  it('closes every acquired replay handle and preserves the first falsy open failure', async () => {
    const scope = await setup(); const head = await integrate(scope); await adopt(scope, head);
    const spawn = childProcess.spawn; let reviewerClose: { code: number | null } | undefined;
    vi.spyOn(childProcess, 'spawn').mockImplementation((...args) => {
      const child = Reflect.apply(spawn, undefined, args) as ReturnType<typeof childProcess.spawn>;
      if (Array.isArray(args[1]) && args[1][0] === capsule.reviewer) child.once('close', code => { reviewerClose = { code }; });
      return child;
    });
    const prove = WorkflowSyntheticReviewSession.prototype.prove; const open = fs.openSync; const close = fs.closeSync;
    let injected = false; let secondary = false; let outstanding = 0;
    vi.spyOn(WorkflowSyntheticReviewSession.prototype, 'prove').mockImplementation(function (this: WorkflowSyntheticReviewSession, handle, attestation) {
      const owned = new Set<number>(); let correlations = 0; let frameFd: number | undefined;
      const openSpy = vi.spyOn(fs, 'openSync').mockImplementation(((path, flags, mode) => {
        if (String(path).endsWith('correlation.jsonl') && flags === (fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)) && ++correlations === 2) {
          injected = true; throw undefined;
        }
        const descriptor = open(path, flags, mode); owned.add(descriptor);
        if (correlations === 1 && String(path).endsWith('frames.bin')) frameFd = descriptor;
        return descriptor;
      }) as typeof fs.openSync);
      const closeSpy = vi.spyOn(fs, 'closeSync').mockImplementation(descriptor => {
        close(descriptor); owned.delete(descriptor);
        if (injected && descriptor === frameFd) { secondary = true; throw new Error('secondary replay close'); }
      });
      try { return prove.call(this, handle, attestation); }
      finally { outstanding = owned.size; openSpy.mockRestore(); closeSpy.mockRestore(); }
    });
    const failed = await review(scope, selection('compat-adoption-1', ['README.md'])).then(
      () => ({ rejected: false, value: 'accepted' as unknown }), value => ({ rejected: true, value }));
    expect(injected).toBe(true); expect(secondary).toBe(true); expect(outstanding).toBe(0);
    expect(failed).toEqual({ rejected: true, value: undefined });
    const state = workflow.readWorkflow(fixture.cwd, name); expect(state.reviews).toEqual([]);
    expect(reviewerClose).toEqual({ code: 0 });
    expect(v2Attempt(state).processResult?.parentExitedSuccessfully).toBe(true);
    expect(v2Attempt(state).error).toBe('workflow_review_process_failed');
    expect(existsSync(artifact('review-coverage-1.json'))).toBe(false);
    expect(v2Attempt(state).artifacts.some(entry => entry.kind === 'workflow-review-coverage')).toBe(false);
  }, 600_000);

  it('adopts, freezes, reopens and independently covers more than 100000 committed tiny paths through real SDK pages', async () => {
    const count = 100_001;
    for (let index = 0; index < count; index++) {
      const shard = String(Math.floor(index / 1000)).padStart(3, '0');
      const directory = join(fixture.cwd, 'many', shard);
      if (index % 1000 === 0) mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, `${String(index).padStart(6, '0')}.txt`), `${index}\n`);
    }
    // Import the same distinct tiny bytes as one streamed pack. This creates a real commit without
    // paying for 100001 separate loose-object writes on Windows; neither paths nor contents collect.
    const commitInput = join(fixture.root, 'many.fast-import');
    const originalHead = base(); const message = 'Commit the complete large source inventory';
    writeWorkflowReviewArtifact({ path: commitInput, chunks: (function* () {
      yield `commit refs/heads/main\ncommitter Workflow Fixture <workflow@example.invalid> ${Math.floor(Date.now() / 1000)} +0000\ndata ${Buffer.byteLength(message)}\n${message}\nfrom ${originalHead}\n`;
      for (let index = 0; index < count; index++) {
        const member = `many/${String(Math.floor(index / 1000)).padStart(3, '0')}/${String(index).padStart(6, '0')}.txt`;
        const content = `${index}\n`;
        yield `M 100644 inline ${member}\ndata ${Buffer.byteLength(content)}\n${content}\n`;
      }
      yield '\ndone\n';
    })() });
    const commitDescriptor = openSync(commitInput, 'r');
    try { execFileSync('git', ['fast-import', '--quiet'], { cwd: fixture.cwd, stdio: [commitDescriptor, 'ignore', 'pipe'], windowsHide: true }); }
    finally { closeSync(commitDescriptor); }
    execFileSync('git', ['read-tree', 'HEAD'], { cwd: fixture.cwd, stdio: 'ignore', windowsHide: true });
    const expectedPath = join(fixture.root, 'expected-paths.nul');
    spoolWorkflowReviewGit({ cwd: fixture.cwd, args: ['ls-files', '-z', '--', 'many'], path: expectedPath });
    let records = 0;
    const path = join(fixture.root, 'authorized-many.jsonl');
    const source = writeWorkflowReviewArtifact({ path, chunks: (function* () {
      for (const member of iterateWorkflowReviewNulRecords(expectedPath)) { records++; yield `${JSON.stringify(member)}\n`; }
    })() });
    expect(records).toBe(count);
    const descriptor = { schemaVersion: WORKFLOW_REVIEW_SOURCE_MANIFEST_SCHEMA_VERSION, path,
      bytes: source.bytes, sha256: source.sha256, records };
    const scope = await setup({ workflow: { providerPolicy: 'unbounded-provider-timeout' } });
    const head = await integrate(scope);
    resetWorkflowReviewResourceUsage();
    await workflow.adoptWorkflowReviewCompatibility(fixture.cwd, name, intent(scope, head, [], {}, descriptor));
    const reviewed = await review(scope, { requestId: 'compat-adoption-1', descriptor });
    expect(reviewed.reviews).toHaveLength(1);
    const { bundle } = frozenBundle(reviewed);
    const expected = iterateWorkflowReviewNulRecords(expectedPath);
    let seen = 0;
    let failed = false; let failure: unknown;
    try {
      await verifyRetainedDelivery(reviewed, bundle, entry => {
        if (entry.kind !== 'source') return;
        const member = expected.next();
        expect(member.done).toBe(false);
        expect(entry.path).toBe(member.value);
        const bytes = Buffer.from(`${seen}\n`);
        expect(entry.bytes).toBe(bytes.length); expect(entry.sha256).toBe(hash(bytes)); seen++;
      });
      expect(expected.next().done).toBe(true); expect(seen).toBe(count);
    } catch (error) { failed = true; failure = error; }
    try { expected.return(undefined); } catch (error) { if (!failed) { failed = true; failure = error; } }
    if (failed) throw failure;
    const controller = workflowReviewResourceUsage();
    const reader = JSON.parse(readFileSync(join(artifact(`review-delivery-${v2Attempt(reviewed).invocationId}`), 'reader-resources.json'), 'utf8'));
    for (const usage of [controller, reader]) {
      expect(usage.records).toBe(0); expect(usage.descriptors).toBe(0); expect(usage.bufferBytes).toBe(0);
      expect(usage.peakRecords).toBeLessThanOrEqual(20);
      expect(usage.peakDescriptors).toBeLessThanOrEqual(20);
      expect(usage.peakBufferBytes).toBeLessThanOrEqual(1024 * 1024);
      expect(usage.largestBuffer).toBeLessThanOrEqual(WORKFLOW_REVIEW_BUFFER_LIMIT_BYTES);
    }
    expect(reader.pageRequests).toBeGreaterThan(count);
    expect(reader.positionedReads).toBe(reader.pageRequests - 1); // one acknowledged empty shared context
    expect(reader.recordLookups).toBeLessThan(count * 4 + 100);
    expect(reader.fullVerifications).toBeLessThanOrEqual(2);
    // The measured Windows run took 3h28 through controller admission and 3h38 through closure.
    // Both retained-object hash passes above need additional test-runner headroom; provider and
    // controller deadlines, physical path count and all integrity/resource checks stay unchanged.
  }, 28_800_000);

  it('adopts one immutable attributed receipt without consuming a review or changing any saved decision', async () => {
    const scope = await setup();
    const before = workflow.readWorkflow(fixture.cwd, name);
    const adopted = await adopt(scope, scope.head);
    const [receipt] = adopted.reviewCompatibilityAdoptions!;
    expect(adopted.reviewCompatibilityAdoptions).toHaveLength(1);
    expect(receipt).toMatchObject({ sequence: 1, requestId: 'compat-adoption-1', orchestrationHost: 'claude',
      actor: { id: 'lead-codex', model: 'gpt-6-astra' },
      transport: { schemaVersion: 2, responseBytes: WORKFLOW_REVIEW_READ_LIMIT_BYTES, bufferBytes: WORKFLOW_REVIEW_BUFFER_LIMIT_BYTES } });
    // The recorded source is the exact manifest descriptor the adoption was asked to bind — one
    // immutable host file addressed by its own absolute path, byte count, record count and digest —
    // and its digest is derived from exactly those fields.
    expect(receipt!.source).toEqual({ baseCommit: fixture.baseCommit, head: scope.head,
      descriptor: authorize(['README.md']),
      digest: hash(JSON.stringify({ baseCommit: fixture.baseCommit, head: scope.head, descriptor: authorize(['README.md']) })) });
    // No plan, option, binding, pin, review, attempt or counter moves.
    expect(adopted.reviewPasses).toBe(before.reviewPasses);
    expect(adopted.reviews).toEqual(before.reviews);
    expect(adopted.reviewAttempts ?? []).toEqual(before.reviewAttempts ?? []);
    expect(adopted.plan).toEqual(before.plan);
    expect(adopted.options).toEqual(before.options);
    expect(v2(adopted).bindings).toEqual(v2(before).bindings);
    expect(adopted.integrationHead).toBe(before.integrationHead);
    expect(adopted.stage).toBe(before.stage);
    // The bounded public status reports the adoption as history and keeps every counter.
    expect(workflow.workflowStatus(fixture.cwd, name)).toMatchObject({ reviewCompatibilityAdoptionCount: 1,
      omittedReviewCompatibilityAdoptions: 0, reviewPasses: before.reviewPasses, completedReviews: 0,
      reviewCompatibilityAdoptions: [expect.objectContaining({ sequence: 1, requestId: 'compat-adoption-1', head: scope.head })] });
    expect(events()).toEqual([]);
    // Exactly one immutable receipt, byte-equivalent to the ledger entry it records.
    const receiptPath = artifact('review-compatibility-adoption-1.json');
    expect(existsSync(receiptPath)).toBe(true);
    expect(JSON.parse(readFileSync(receiptPath, 'utf8'))).toEqual(adopted.reviewCompatibilityAdoptions![0]);
    // The saved file still round-trips, and stays readable for a controller without the ledger.
    const saved = JSON.parse(readFileSync(workflow.workflowStatus(fixture.cwd, name).stateFile as string, 'utf8'));
    expect(parseWorkflowState(saved)).toEqual(saved);
    const withoutLedger = { ...saved };
    delete withoutLedger.reviewCompatibilityAdoptions;
    expect(parseWorkflowState(withoutLedger)).toEqual(withoutLedger);
    // An exact replay is idempotent and writes nothing new; any changed field of the same request conflicts.
    await expect(adopt(scope, scope.head)).resolves.toEqual(adopted);
    expect(readdirSync(dirname(receiptPath)).filter(entry => entry.startsWith('review-compatibility-adoption-'))).toEqual(['review-compatibility-adoption-1.json']);
    await expect(workflow.adoptWorkflowReviewCompatibility(fixture.cwd, name, intent(scope, scope.head, ['README.md'], { reason: 'A different decision' })))
      .rejects.toThrow('workflow_review_compatibility_request_conflict');
    // A different authorized file set of the same request is a conflict too, not a silent re-freeze.
    await expect(adopt(scope, scope.head, ['README.md', 'AGENTS.md'])).rejects.toThrow('workflow_review_compatibility_request_conflict');
    // A refused conflict records no second receipt and moves no ledger or counter.
    const replayed = workflow.readWorkflow(fixture.cwd, name);
    expect(replayed.reviewCompatibilityAdoptions).toEqual(adopted.reviewCompatibilityAdoptions);
    expect(replayed.reviewPasses).toBe(before.reviewPasses);
    expect(replayed.reviews).toEqual(before.reviews);
  }, 120_000);

  it('refuses unauthorized, stale, active, mismatched and unsupported adoptions without recording anything', async () => {
    const scope = await setup();
    const source = (head: string, baseCommit: string, descriptor: WorkflowReviewSourceManifestDescriptor) =>
      ({ baseCommit, head, descriptor });
    const cases: Array<[string, (scope: Setup) => Promise<unknown>]> = [
      ['workflow_review_compatibility_actor_mismatch', scope => workflow.adoptWorkflowReviewCompatibility(fixture.cwd, name,
        intent(scope, scope.head, ['README.md'], { actor: { id: 'some-other-lead', model: 'gpt-6-astra' } }))],
      ['workflow_review_compatibility_actor_mismatch', scope => workflow.adoptWorkflowReviewCompatibility(fixture.cwd, name,
        intent(scope, scope.head, ['README.md'], { reviewerBindingId: 'reviewer-somewhere-else' }))],
      ['workflow_review_compatibility_reviewer_identity_changed', scope => workflow.adoptWorkflowReviewCompatibility(fixture.cwd, name,
        intent(scope, scope.head, ['README.md'], { reviewerAuthFingerprint: 'b'.repeat(64) }))],
      ['workflow_review_compatibility_head_mismatch', scope => workflow.adoptWorkflowReviewCompatibility(fixture.cwd, name,
        intent(scope, '0'.repeat(40)))],
      // The adopted pair is the final PR's own base and head: a base the reviewed head does not
      // really descend from — here an invented commit — is refused as a swapped or narrowed pair.
      ['workflow_review_compatibility_base_mismatch', scope => workflow.adoptWorkflowReviewCompatibility(fixture.cwd, name,
        intent(scope, scope.head, ['README.md'], { source: source(scope.head, '1'.repeat(40), authorize(['README.md'])) }))],
      ['workflow_review_compatibility_base_mismatch', scope => workflow.adoptWorkflowReviewCompatibility(fixture.cwd, name,
        intent(scope, scope.head, ['README.md'], { source: source(scope.head, scope.head, authorize(['README.md'])) }))],
      // A transport of another buffer policy, or of another version, is refused rather than adopted.
      ['workflow_review_compatibility_transport_unsupported', scope => workflow.adoptWorkflowReviewCompatibility(fixture.cwd, name,
        intent(scope, scope.head, ['README.md'], { transport: { ...transport(), responseBytes: 4096 } }))],
      ['workflow_review_compatibility_transport_unsupported', scope => workflow.adoptWorkflowReviewCompatibility(fixture.cwd, name,
        intent(scope, scope.head, ['README.md'], { transport: { ...transport(), schemaVersion: 1 } }))],
      // Any attempt to carry an aggregate total is an unknown transport field, so it never parses.
      ['workflow_unknown_field', scope => workflow.adoptWorkflowReviewCompatibility(fixture.cwd, name,
        intent(scope, scope.head, ['README.md'], { transport: { ...transport(), totalBytes: RETIRED_BUNDLE_CEILING_BYTES } }))],
      ['workflow_unknown_field', scope => workflow.adoptWorkflowReviewCompatibility(fixture.cwd, name,
        intent(scope, scope.head, ['README.md'], { limits: { contextBytes: 512 * 1024 } }))],
      ['workflow_review_compatibility_controller_mismatch', scope => workflow.adoptWorkflowReviewCompatibility(fixture.cwd, name,
        intent(scope, scope.head, ['README.md'], { controller: { id: 'team-workflow', sha256: 'c'.repeat(64) } }))],
      ['workflow_review_compatibility_reader_mismatch', scope => workflow.adoptWorkflowReviewCompatibility(fixture.cwd, name,
        intent(scope, scope.head, ['README.md'], { reader: { id: 'omc-review-source', sha256: 'd'.repeat(64) } }))],
      ['workflow_sensitive_input_rejected', scope => workflow.adoptWorkflowReviewCompatibility(fixture.cwd, name,
        intent(scope, scope.head, ['README.md'], { reason: 'Adopt sk-live-abcdefghijklmnopqrstuvwxyz012345' }))],
      // The authorized manifest is validated as a bounded descriptor: one that binds no record at
      // all, or no absolute manifest file, is refused before the set it would name is ever read.
      ['workflow_review_compatibility_invalid_paths', scope => workflow.adoptWorkflowReviewCompatibility(fixture.cwd, name,
        intent(scope, scope.head, [], {}, { schemaVersion: 1, path: join(fixture.root, 'empty.jsonl'), bytes: 0, records: 0, sha256: hash('') }))],
      ['workflow_review_compatibility_invalid_paths', scope => workflow.adoptWorkflowReviewCompatibility(fixture.cwd, name,
        intent(scope, scope.head, [], {}, { schemaVersion: 1, path: 'relative.jsonl', bytes: 1, records: 1, sha256: 'e'.repeat(64) }))],
      // A record saved before this delta keeps its legacy path list and still loads, but it names no
      // manifest at all, so it can never be the source of a new adoption.
      ['workflow_review_compatibility_source_required', scope => workflow.adoptWorkflowReviewCompatibility(fixture.cwd, name,
        intent(scope, scope.head, ['README.md'], { source: { baseCommit: fixture.baseCommit, head: scope.head, paths: ['README.md'] } }))],
      ['workflow_review_compatibility_source_unsupported', scope => workflow.adoptWorkflowReviewCompatibility(fixture.cwd, name,
        intent(scope, scope.head, [], {}, { schemaVersion: 2, path: join(fixture.root, 'unsupported.jsonl'), bytes: 1, records: 1, sha256: 'e'.repeat(64) }))],
      // The manifest itself is walked member by member as canonical records: a repeat, a step
      // backwards or an alias-escaping member is refused rather than recorded as the source set.
      ['workflow_review_source_invalid_path', scope => workflow.adoptWorkflowReviewCompatibility(fixture.cwd, name,
        intent(scope, scope.head, [], {}, authorize(['../escape.md'], 'escaping.jsonl')))],
      ['workflow_review_compatibility_invalid_paths', scope => workflow.adoptWorkflowReviewCompatibility(fixture.cwd, name,
        intent(scope, scope.head, [], {}, rawManifest(['README.md', 'README.md'], 'duplicate.jsonl')))],
      ['workflow_review_compatibility_invalid_paths', scope => workflow.adoptWorkflowReviewCompatibility(fixture.cwd, name,
        intent(scope, scope.head, [], {}, rawManifest(['README.md', 'AGENTS.md'], 'unsorted.jsonl')))],
      ['workflow_review_compatibility_invalid_paths', scope => {
        const path = join(fixture.root, 'not-json.jsonl');
        writeFileSync(path, 'README.md\n');
        return workflow.adoptWorkflowReviewCompatibility(fixture.cwd, name, intent(scope, scope.head, [], {},
          { schemaVersion: 1, path, bytes: Buffer.byteLength('README.md\n'), records: 1, sha256: hash('README.md\n') }));
      }],
      // A member the checkout does not track — an absent file, or a file under the reserved state
      // directory — is refused as an unauthorized member of the manifest.
      ['workflow_review_compatibility_source_mismatch', scope => workflow.adoptWorkflowReviewCompatibility(fixture.cwd, name,
        intent(scope, scope.head, [], {}, authorize(['feature/absent.txt'], 'untracked.jsonl')))],
      ['workflow_review_compatibility_source_mismatch', scope => workflow.adoptWorkflowReviewCompatibility(fixture.cwd, name,
        intent(scope, scope.head, [], {}, authorize(['.omc/routing.md.bak'], 'reserved.jsonl')))],
      // A descriptor that binds no manifest at all is refused as unavailable rather than read.
      ['workflow_review_compatibility_source_unavailable', scope => workflow.adoptWorkflowReviewCompatibility(fixture.cwd, name,
        intent(scope, scope.head, [], {}, { schemaVersion: 1, path: join(fixture.root, 'absent-manifest.jsonl'),
          bytes: 12, records: 1, sha256: 'e'.repeat(64) }))],
      // A descriptor whose manifest was rewritten after it was written no longer binds its own bytes.
      ['workflow_review_compatibility_source_mismatch', scope => {
        const descriptor = authorize(['README.md'], 'rewritten.jsonl');
        writeFileSync(descriptor.path, `${JSON.stringify('AGENTS.md')}\n`);
        return workflow.adoptWorkflowReviewCompatibility(fixture.cwd, name, intent(scope, scope.head, [], {}, descriptor));
      }],
    ];
    const before = workflow.readWorkflow(fixture.cwd, name);
    for (const [index, [error, attempt]] of cases.entries()) {
      await expect(attempt(scope), `refusal case ${index} expected ${error}`).rejects.toThrow(error);
    }
    // An active worker holds the lease this operation needs.
    const active = workflow.readWorkflow(fixture.cwd, name);
    active.tasks[0].status = 'running';
    writeFileSync(workflow.workflowStatus(fixture.cwd, name).stateFile as string, `${JSON.stringify(active, null, 2)}\n`);
    await expect(adopt(scope, scope.head)).rejects.toThrow('workflow_controller_not_idle');
    const after = workflow.readWorkflow(fixture.cwd, name);
    expect(after.reviewCompatibilityAdoptions ?? []).toEqual([]);
    expect(after.reviewPasses).toBe(before.reviewPasses);
    expect(existsSync(artifact('review-compatibility-adoption-1.json'))).toBe(false);
    expect(events()).toEqual([]);
  }, 120_000);

  it('refuses an unsupported profile, a stale adoption and every unbounded adoption shape', async () => {
    // A compatibility selection is meaningless outside the explicit role-substitution profile.
    const legacy = await workflow.initWorkflow(fixture.cwd, plan(), {}, 'claude-glm-codex');
    expect(legacy.schemaVersion).toBe(1);
    const legacyIntent = join(fixture.root, 'legacy-intent.json');
    writeFileSync(legacyIntent, JSON.stringify({ requestId: 'compat-adoption-1',
      source: { baseCommit: base(), head: base(), descriptor: authorize(['README.md']) },
      controller: workflow.workflowReviewControllerBuildIdentity(), reader: workflowReviewReaderBuildIdentity(), transport: transport(),
      reviewerBindingId: 'reviewer-codex', reviewerAuthFingerprint: 'a'.repeat(64), actor: { id: 'legacy', model: 'gpt-6-astra' },
      authorityRef: 'issue-60', reason: 'Legacy adoption must be refused' }));
    await expect(workflow.adoptWorkflowReviewCompatibility(fixture.cwd, name, JSON.parse(readFileSync(legacyIntent, 'utf8'))))
      .rejects.toThrow('workflow_role_substitution_profile_required');
    const legacySelection = join(fixture.root, 'legacy-selection.json');
    writeFileSync(legacySelection, JSON.stringify(selection('compat-adoption-1', ['README.md'])));
    // The original gates run first: an explicit compatibility selection never bypasses the
    // integration and verification gate that the ordinary review path is subject to.
    await expect(workflowCommand(['review', name, '--compatibility', legacySelection], fixture.cwd))
      .rejects.toThrow('workflow_integration_incomplete');
    expect(workflow.readWorkflow(fixture.cwd, name).reviewPasses).toBe(0);
    expect(events()).toEqual([]);

    // An adoption is bound to the reviewed head; integrating past it makes the adoption stale.
    fixture.dispose(); fixture = createWorkflowFixture();
    const stale = await setup({ tasks: 2 });
    await workflow.runWorkflow(fixture.cwd, name, stale.configured.runtime);
    await workflow.acceptWorkflowTask(fixture.cwd, name, 'a');
    await adopt(stale, workflow.readWorkflow(fixture.cwd, name).integrationHead);
    await workflow.runWorkflow(fixture.cwd, name, stale.configured.runtime);
    await workflow.acceptWorkflowTask(fixture.cwd, name, 'b');
    await workflow.verifyWorkflow(fixture.cwd, name);
    const staleEvents = events().length;
    await expect(review(stale, selection('compat-adoption-1', ['README.md']))).rejects.toThrow('workflow_review_compatibility_stale_head');
    expect(workflow.readWorkflow(fixture.cwd, name).reviewPasses).toBe(0);
    expect(events()).toHaveLength(staleEvents);
    expect(existsSync(artifact('review-coverage-1.json'))).toBe(false);
  }, 180_000);

  it('refuses an unadopted, unselected, invalid or extended selection at review time without consuming a review', async () => {
    const scope = await setup();
    const integrated = await integrate(scope);
    await adopt(scope, integrated, ['README.md']);
    const before = events().length;
    const refusals: Array<[string, { requestId: string; descriptor: WorkflowReviewSourceManifestDescriptor }]> = [
      ['workflow_review_compatibility_not_adopted', selection('compat-adoption-2', ['README.md'])],
      // The selection may only restate the descriptor the adoption recorded: another manifest, or a
      // set that omits from, adds to or reorders the authorized one, is a whole-request mismatch.
      ['workflow_review_compatibility_source_mismatch', selection('compat-adoption-1', ['AGENTS.md'])],
      ['workflow_review_compatibility_source_mismatch', selection('compat-adoption-1', ['README.md', 'AGENTS.md'])],
      // Even a member the checkout really carries is not authorized unless the manifest names it.
      ['workflow_review_compatibility_source_mismatch', selection('compat-adoption-1', ['README.md', 'feature/absent.txt'])],
      // A descriptor that binds no record, or no absolute manifest, is refused before comparison.
      ['workflow_review_compatibility_source_mismatch', { requestId: 'compat-adoption-1',
        descriptor: { schemaVersion: 1, path: join(fixture.root, 'empty.jsonl'), bytes: 0, records: 0, sha256: hash('') } }],
    ];
    for (const [error, compat] of refusals) await expect(review(scope, compat)).rejects.toThrow(error);
    // A manifest of the same shape but another revision — rewritten after the descriptor that binds
    // it was written — is no longer the file the descriptor names, so it can never be adopted.
    const rewritten = authorize(['README.md'], 'rewritten-selection.jsonl');
    writeFileSync(rewritten.path, `${JSON.stringify('AGENTS.md')}\n`);
    await expect(workflow.adoptWorkflowReviewCompatibility(fixture.cwd, name, intent(scope, integrated, [],
      { source: { baseCommit: fixture.baseCommit, head: integrated, descriptor: rewritten }, requestId: 'compat-adoption-2' })))
      .rejects.toThrow('workflow_review_compatibility_source_mismatch');
    const after = workflow.readWorkflow(fixture.cwd, name);
    expect(after.reviewPasses).toBe(0);
    expect(after.reviews).toEqual([]);
    expect(after.reviewAttempts ?? []).toEqual([]);
    expect(after.stage).not.toBe('review');
    expect(events()).toHaveLength(before);
    // A refusal before the reservation freezes nothing and leaves no bundle behind.
    expect(readdirSync(artifact('.')).filter(entry => entry.startsWith('review-source-'))).toEqual([]);
    expect(existsSync(artifact('review-coverage-1.json'))).toBe(false);
  }, 120_000);

  it('runs one adopted review through the controller reader and proves complete delivery before findings', async () => {
    const scope = await setup();
    const integrated = await integrate(scope);
    fixture.configure({ findings: [{ severity: 'P1', message: 'Synthetic compatibility finding', file: 'feature/a.txt', line: 1 }],
      tasks: { review: {} } });
    const adopted = await adopt(scope, integrated, ['README.md', 'feature/a.txt']);
    resetWorkflowReviewResourceUsage();
    const reviewed = await review(scope, selection('compat-adoption-1', ['feature/a.txt', 'README.md']));
    expect(reviewed.reviewPasses).toBe(1);
    // The adapter binding records the exact adopted controller and reader builds.
    const attempt = v2Attempt(reviewed);
    expect(attempt).toMatchObject({ outcome: 'completed', pass: 1, compatibility: { adoptionSequence: 1,
      controllerSha256: workflow.workflowReviewControllerBuildIdentity().sha256,
      readerSha256: workflowReviewReaderBuildIdentity().sha256 } });
    const { digest, bundle } = frozenBundle(reviewed);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    // The frozen bundle is a content-addressed on-disk directory bound to the exact repository,
    // base and head: the manifest plus one entry file per addressable object.
    expect(bundle.repositoryIdentity).toBe(fixture.cwd);
    expect(bundle.baseCommit).toBe(fixture.baseCommit);
    expect(bundle.head).toBe(integrated);
    expect(bundle.digest).toBe(digest);
    expect(bundle.directory).toBe(artifact(`review-source-bundle-${attempt.invocationId}`));
    const entries = entriesOf(bundle);
    expect(entries.slice(0, 3).map(entry => `${entry.id}:${entry.path}`)).toEqual(['instr-0:AGENTS.md', 'src-0:README.md', 'src-1:feature/a.txt']);
    expect(entries.slice(3).map(entry => entry.id)).toEqual(['inventory', 'diff', 'objective', 'shared-context', 'contracts']);
    expect(bundle.entryCount).toBe(entries.length);
    expect(readdirSync(join(bundle.directory, 'entries')).sort()).toEqual([...entries.map(entry => entry.id)].sort());
    // Every entry is a real on-disk file whose bytes are exactly the material it names.
    expect(readFileSync(entries.find(entry => entry.id === 'instr-0')!.file).equals(readFileSync(join(fixture.cwd, 'AGENTS.md')))).toBe(true);
    expect(entries.find(entry => entry.id === 'src-1')!.sha256).toBe(hash(readFileSync(join(fixture.cwd, 'feature/a.txt'))));
    // The objective and the governed instruction travel as their exact bytes, not re-encoded.
    expect(readFileSync(entries.find(entry => entry.id === 'objective')!.file, 'utf8'))
      .toBe('Exercise one adopted compatibility review');
    expect(readFileSync(entries.find(entry => entry.id === 'instr-0')!.file, 'utf8'))
      .toBe('Complete governing instruction for the compatibility fixture.\n');
    // The objective, the accepted contracts and the complete acceptance criteria are artifactized,
    // not sent: the compact request below names them only through this bundle.
    expect(JSON.parse(readFileSync(entries.find(entry => entry.id === 'contracts')!.file, 'utf8')))
      .toEqual([{ id: 'a', contracts: ['One complete owned component'], acceptanceCriteria: ['One committed component passes its declared check'] }]);
    // The frozen total is the true sum of the authorized source, not a clamped ceiling.
    expect(bundle.totalBytes).toBe(entries.reduce((total, entry) => total + entry.bytes, 0));
    // The reviewer drove the real reader: exact controller command, config, tools and bounded pages.
    const reviewer = events().findLast(event => event.role === 'reviewer')!;
    expect(reviewer).toMatchObject({ route: 'claude', serverCommand: process.execPath,
      serverArgs: [READER_ENTRY], serverEnv: ['OMC_REVIEW_SOURCE_BUNDLE', 'OMC_REVIEW_SOURCE_RECEIPTS'],
      toolsCount: 2, manifestDigest: digest, entries: bundle.entryCount, expectedTotalBytes: bundle.totalBytes,
      complete: true, responseBytes: WORKFLOW_REVIEW_READ_LIMIT_BYTES, descriptorShape: DESCRIPTOR_KEYS });
    expect(reviewer.tools).toEqual(['review_source_manifest', 'review_source_entry']);
    expect(reviewer.readerEntry).toBe(READER_ENTRY);
    expect(reviewer.entryRanges).toBe(entries.filter(entry => entry.bytes > 0).length);
    expect(reviewer.ranges).toBe(reviewer.entryRanges + reviewer.manifestRanges);
    // The independent consumer reconstructed every object it was delivered, from the bytes it was
    // actually returned, and its own re-derivation of the manifest agreed with the frozen identity.
    expect(reviewer.reconstructed).toBe(entries.filter(entry => entry.bytes > 0).length);
    expect(reviewer.manifestBytes).toBe(bundle.manifestBytes);
    expect(reviewer.summedBytes).toBe(bundle.totalBytes);
    // The whole encoded MCP response stayed inside the adopted bound on the wire.
    expect(reviewer.maxResponseBytes).toBeLessThanOrEqual(WORKFLOW_REVIEW_READ_LIMIT_BYTES);
    // Gap 2: the compact request holds no unbounded material and no file list at all.
    expect(reviewer.requestKeys).toEqual(['baseCommit', 'head', 'instructions', 'kind', 'reviewSource']);
    expect(reviewer.unboundedRequestFields).toEqual([]);
    expect(reviewer.leakedPaths).toEqual([]);
    expect(reviewer.requestBytes).toBeLessThan(4096);
    // Coverage is proven from the delivery a client actually observed and decoded, and both
    // append-only ledgers — the reader's intent and the reviewer's observation — are retained as
    // separate diagnostic evidence alongside the constant-size attestation.
    const coverage = reviewed.reviews[0].artifacts.find(descriptor => descriptor.kind === 'workflow-review-coverage')!;
    const coverageBytes = readFileSync(coverage.path);
    const record = JSON.parse(coverageBytes.toString('utf8'));
    expect(Object.keys(record).sort()).toEqual(['attestation', 'bundleSha256', 'delivery', 'entries', 'ledger',
      'ranges', 'reconstructionSha256', 'reviewerId']);
    expect(record).toMatchObject({ bundleSha256: digest, reviewerId: REVIEWER_ID, entries: bundle.entryCount,
      ranges: reviewer.ranges, reconstructionSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      attestation: { bundleSha256: digest, reviewerId: REVIEWER_ID, complete: true, entries: bundle.entryCount, ranges: reviewer.ranges } });
    const ledgerName = `review-source-receipts-${attempt.invocationId}.jsonl`;
    expect(record.ledger).toEqual({ name: ledgerName, bytes: statSync(artifact(ledgerName)).size, sha256: hash(readFileSync(artifact(ledgerName))) });
    const deliveryRoot = artifact(record.delivery.directory);
    const readerResources = JSON.parse(readFileSync(join(deliveryRoot, 'reader-resources.json'), 'utf8'));
    for (const usage of [workflowReviewResourceUsage(), readerResources]) {
      expect(usage.records).toBe(0); expect(usage.descriptors).toBe(0); expect(usage.bufferBytes).toBe(0);
      expect(usage.peakRecords).toBeLessThanOrEqual(20);
      expect(usage.peakDescriptors).toBeLessThanOrEqual(20);
      expect(usage.peakBufferBytes).toBeLessThanOrEqual(1024 * 1024);
      expect(usage.largestBuffer).toBeLessThanOrEqual(WORKFLOW_REVIEW_BUFFER_LIMIT_BYTES);
    }
    expect(record.delivery).toMatchObject({ invocationId: attempt.invocationId, reviewerId: REVIEWER_ID });
    expect(record.delivery.capture).toEqual({ name: 'frames.bin', bytes: statSync(join(deliveryRoot, 'frames.bin')).size,
      sha256: hash(readFileSync(join(deliveryRoot, 'frames.bin'))) });
    expect(coverageBytes.includes('rangeSha256')).toBe(false);
    expect(coverageBytes.length).toBeLessThan(4096);
    const receipts = readdirSync(dirname(coverage.path)).filter(entry => entry.startsWith('review-source-receipts-'));
    expect(receipts).toEqual([ledgerName]);
    // The append-only ledger holds exactly one delivered range per page that carried bytes, manifest
    // pages included, plus one terminal zero-byte page for every empty object — the record that proves
    // the empty material was delivered at all. Each line carries the exact bytes that were returned,
    // so the delivery can be reconstructed without re-reading the source.
    const emptyObjects = entries.filter(entry => entry.bytes === 0);
    expect(emptyObjects).toHaveLength(1);
    const ledgerLines = readFileSync(artifact(ledgerName), 'utf8').trim().split('\n');
    expect(ledgerLines).toHaveLength(reviewer.ranges + emptyObjects.length);
    const ledgerReceipts = ledgerLines.map(line => JSON.parse(line)) as Array<{ id: string | null; bytes: number;
      rangeSha256: string; encoding: string; content: string }>;
    expect(ledgerReceipts.every(receipt => (receipt.encoding === 'base64' ? Buffer.from(receipt.content, 'base64')
      : Buffer.from(receipt.content, 'utf8')).length === receipt.bytes)).toBe(true);
    expect(ledgerReceipts.filter(receipt => receipt.bytes === 0).map(receipt => receipt.id))
      .toEqual(emptyObjects.map(entry => entry.id));
    const ledgerIds = ledgerReceipts.map(receipt => receipt.id).filter(id => id !== null);
    expect(ledgerIds).toEqual(entries.map(entry => entry.id));
    // The reviewer's own observation of the wire is written independently of the reader that served
    // it, and both descriptions of this delivery are byte-identical: same pages, same order, same
    // returned bytes. Two independently written records of one delivery is the whole evidence basis.
    const correlations = readFileSync(join(deliveryRoot, 'correlation.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(correlations.filter(record => record.direction === 'ack')).toHaveLength(reviewer.ranges + emptyObjects.length + 2);
    const proofBytes = readFileSync(join(deliveryRoot, 'reconstruction', 'proof.jsonl'));
    expect(proofBytes.equals(readFileSync(join(deliveryRoot, 'replay', 'proof.jsonl')))).toBe(true);
    const proofs = proofBytes.toString('utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(proofs).toHaveLength(bundle.entryCount + 1);
    expect(proofs.find(proof => proof.id === 'shared-context')).toMatchObject({ bytes: 0, sha256: hash('') });
    expect(statSync(join(deliveryRoot, 'reconstruction', 'entry-shared-context')).size).toBe(0);
    // The adoption receipt is bound into the review, and the ordinary gates still run to completion.
    expect(reviewed.reviews[0].artifacts.some(descriptor => descriptor.kind === 'workflow-review-compatibility-adoption')).toBe(true);
    expect(JSON.parse(readFileSync(artifact('review-compatibility-adoption-1.json'), 'utf8'))).toEqual(adopted.reviewCompatibilityAdoptions![0]);
    expect(reviewed.reviews[0].findings).toEqual([expect.objectContaining({ severity: 'P1', file: 'feature/a.txt' })]);
    const adjudicated = await workflow.adjudicateWorkflow(fixture.cwd, name,
      [{ findingId: reviewed.reviews[0].findings[0].id, disposition: 'dismiss', reason: 'Synthetic compatibility finding is out of scope' }]);
    expect(adjudicated.stage).toBe('adjudication');
    expect((await workflow.finishWorkflow(fixture.cwd, name)).stage).toBe('complete');
  }, 180_000);

  it('delivers the same adopted source to a Codex reviewer through per-invocation TOML overrides', async () => {
    // Gap 1: the Codex route is a supported reader host. The reader arrives as repeated dotted-TOML
    // --config overrides scoped to this one invocation, with the two command-executing tool features
    // disabled, while the authenticated provider route, profile, fingerprint and exact model/effort
    // selection stay exactly as the binding chose them.
    const scope = await setup({ reviewerRoute: 'codex' });
    expect(scope.bindings.reviewer.model).toBe(CODEX_MODEL);
    expect(scope.bindings.reviewer.effort).toBe(CODEX_EFFORT);
    const integrated = await integrate(scope);
    fixture.configure({ findings: [{ severity: 'P2', message: 'Synthetic codex compatibility finding', file: 'feature/a.txt', line: null }],
      tasks: { review: {} } });
    await adopt(scope, integrated, ['README.md', 'feature/a.txt']);
    const reviewed = await review(scope, selection('compat-adoption-1', ['feature/a.txt', 'README.md']));
    expect(reviewed.reviewPasses).toBe(1);
    expect(v2Attempt(reviewed)).toMatchObject({ outcome: 'completed', model: CODEX_MODEL,
      binding: { providerRoute: 'codex', cliFamily: 'codex-exec', model: CODEX_MODEL, effort: CODEX_EFFORT },
      compatibility: { adoptionSequence: 1, controllerSha256: workflow.workflowReviewControllerBuildIdentity().sha256,
        readerSha256: workflowReviewReaderBuildIdentity().sha256 } });
    const { bundle } = frozenBundle(reviewed);
    const entries = entriesOf(bundle);
    const reviewer = events().findLast(event => event.role === 'reviewer')!;
    expect(reviewer).toMatchObject({ route: 'codex', complete: true, entries: bundle.entryCount,
      expectedTotalBytes: bundle.totalBytes, manifestDigest: bundle.digest });
    expect(reviewer.reconstructed).toBe(entries.filter(entry => entry.bytes > 0).length);
    // The reader projection is Codex-native: no Claude flag, no global config rewrite.
    expect(reviewer.mcpConfig).toBe(false);
    expect(reviewer.strictMcpConfig).toBe(false);
    expect(reviewer.serverCommand).toBe(process.execPath);
    expect(reviewer.serverEnv).toEqual(['OMC_REVIEW_SOURCE_BUNDLE', 'OMC_REVIEW_SOURCE_RECEIPTS']);
    expect(reviewer.tools).toEqual(['review_source_manifest', 'review_source_entry']);
    // Every command-executing and extra tool surface is disabled, together with the multi-agent
    // surfaces, so the two read-only reader tools are the only tools this reviewer can reach.
    expect(reviewer.commandTools).toEqual({ shell_tool: false, unified_exec: false });
    expect(reviewer.configKeys).toEqual([
      'agents.enabled', 'features.code_mode.direct_only_tool_namespaces', 'features.goals',
      'features.image_generation', 'features.multi_agent_v2', 'features.shell_tool', 'features.unified_exec',
      'mcp_servers.omc-review-source.args', 'mcp_servers.omc-review-source.command',
      'mcp_servers.omc-review-source.env.OMC_REVIEW_SOURCE_BUNDLE',
      'mcp_servers.omc-review-source.env.OMC_REVIEW_SOURCE_RECEIPTS',
      'model_catalog_json', 'model_reasoning_effort'].sort());
    // The host's own complete catalog was projected onto this one invocation: every record and
    // every unrelated field survives it, and only the reviewed model's tool mode became direct.
    expect(reviewer.catalogModels).toEqual(PROJECTED_MODELS);
    expect(reviewer.catalogBytes).toBeGreaterThan(0);
    expect(readdirSync(artifact('.')).filter(entry => entry.startsWith('review-codex-catalog-'))).toHaveLength(1);
    // The exact model and effort the binding selected were preserved, not defaulted.
    expect(reviewer.modelFlag).toBe(CODEX_MODEL);
    expect(reviewer.effortConfig).toBe(CODEX_EFFORT);
    // The same compact request, the same descriptor and the same complete delivery as the Claude route.
    expect(reviewer.descriptorShape).toBe(DESCRIPTOR_KEYS);
    expect(reviewer.requestKeys).toEqual(['baseCommit', 'head', 'instructions', 'kind', 'reviewSource']);
    expect(reviewer.unboundedRequestFields).toEqual([]);
    expect(reviewer.leakedPaths).toEqual([]);
    expect(reviewer.expectedTotalBytes).toBe(bundle.totalBytes);
    expect(reviewer.maxResponseBytes).toBeLessThanOrEqual(WORKFLOW_REVIEW_READ_LIMIT_BYTES);
    const record = await verifyRetainedDelivery(reviewed, bundle);
    expect(record).toMatchObject({ bundleSha256: bundle.digest, reviewerId: REVIEWER_ID, entries: bundle.entryCount,
      ranges: reviewer.ranges, reconstructionSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    // The Codex route proves its delivery the same way — from the client's own observation, not from
    // the reader's account of what it meant to serve.
    expect(record.delivery).toMatchObject({ invocationId: v2Attempt(reviewed).invocationId, capture: { name: 'frames.bin' }, proof: { name: 'proof.jsonl' } });
    expect(record.attestation.ranges).toBe(reviewer.ranges);
    expect(reviewed.reviews[0].findings).toEqual([expect.objectContaining({ severity: 'P2', file: 'feature/a.txt' })]);
  }, 180_000);

  it('refuses an unqualified, changed, mismatched or route-incomplete reader before any reservation', async () => {
    // Saved qualification evidence remains a guard beneath the runtime-selected synthetic factory.
    // A mismatched record is refused before reservation, provider start or bundle creation; it cannot
    // mint the factory's private session authority or admit an unsupported native observation.
    // Every mismatch below changes one field of the prospective effective invocation.
    const scope = await setup();
    const integrated = await integrate(scope);
    await adopt(scope, integrated, ['README.md']);
    const reader = workflowReviewReaderBuildIdentity();
    const base = scope.qualified.invocation;
    const qualified = { path: scope.qualified.path, sha256: scope.qualified.sha256 };
    const eventsBefore = events().length;
    const refused = async (expected: string): Promise<void> => {
      await expect(review(scope, selection('compat-adoption-1', ['README.md']))).rejects.toThrow(expected);
      const state = workflow.readWorkflow(fixture.cwd, name);
      expect(state.reviewPasses).toBe(0);
      expect(state.reviews).toEqual([]);
      expect(state.reviewAttempts ?? []).toEqual([]);
      expect(state.stage).not.toBe('review');
      expect(readdirSync(artifact('.')).filter(entry => entry.startsWith('review-source-'))).toEqual([]);
      expect(existsSync(artifact('review-coverage-1.json'))).toBe(false);
      expect(events()).toHaveLength(eventsBefore);
      scope.configured.runtime.readerQualification = { ...qualified, catalogPath: scope.catalogPath };
      scope.configured.runtime.allowSyntheticCapabilities = true;
      scope.configured.runtime.readerObservation = { mode: 'synthetic', tools: [...WORKFLOW_REVIEW_READER_TOOLS] };
    };
    // No qualification at all, and one that is not an absolute path bound by its own digest.
    scope.configured.runtime.readerQualification = undefined;
    await refused('workflow_review_reader_qualification_required');
    scope.configured.runtime.readerQualification = { path: 'relative.json', sha256: qualified.sha256 };
    await refused('workflow_review_reader_qualification_required');
    scope.configured.runtime.readerQualification = { path: join(fixture.root, 'absent-qualification.json'),
      sha256: qualified.sha256 };
    await refused('workflow_review_reader_qualification_required');
    // A record edited after it was bound — to the same size — is a changed record, never accepted.
    const qualifiedBytes = readFileSync(qualified.path, 'utf8');
    writeFileSync(qualified.path, qualifiedBytes.replace('synthetic', 'synthetix'));
    await refused('workflow_review_reader_qualification_changed');
    writeFileSync(qualified.path, qualifiedBytes);
    // A record that binds another reader, another controller build, another dependency digest,
    // another CLI, another model, another effort, another authenticated profile, another catalog
    // input or projection, another tool projection or another inventory is a qualification for some
    // other invocation — never for this one — and a record that is not this schema at all never parses.
    const variants: Array<[string, Record<string, unknown>, string]> = [
      ['reader.json', { invocation: { ...base, reader: { ...base.reader, sha256: 'c'.repeat(64) } } },
        'workflow_review_reader_qualification_mismatch'],
      ['dependency.json', { invocation: { ...base,
        reader: { ...base.reader, dependencies: [{ path: './workflow-contracts.js', sha256: 'c'.repeat(64) }] } } },
        'workflow_review_reader_qualification_mismatch'],
      ['controller.json', { invocation: { ...base, controller: { id: 'team-workflow', sha256: 'c'.repeat(64) } } },
        'workflow_review_reader_qualification_mismatch'],
      ['cli.json', { invocation: { ...base, cli: { path: join(fixture.root, 'another-cli.cjs'), sha256: 'c'.repeat(64), version: '1.0' } } },
        'workflow_review_reader_qualification_mismatch'],
      ['model.json', { invocation: { ...base, model: 'gpt-6-astra' } }, 'workflow_review_reader_qualification_mismatch'],
      ['effort.json', { invocation: { ...base, effort: 'max' } }, 'workflow_review_reader_qualification_mismatch'],
      ['auth.json', { invocation: { ...base, auth: { ...base.auth, fingerprint: 'c'.repeat(64) } } },
        'workflow_review_reader_qualification_mismatch'],
      ['catalog.json', { invocation: { ...base, catalog: { input: null,
        projected: { bytes: 2048, sha256: 'c'.repeat(64) } } } }, 'workflow_review_reader_qualification_mismatch'],
      ['projection.json', { invocation: { ...base, projection: 'c'.repeat(64) } }, 'workflow_review_reader_qualification_mismatch'],
      ['tools.json', { invocation: { ...base, tools: [base.tools[0]] } }, 'workflow_review_reader_qualification_mismatch'],
      ['undelivered.json', { delivered: false }, 'workflow_review_reader_qualification_incomplete'],
      ['codex-only.json', { routes: ['codex'] }, 'workflow_review_reader_qualification_incomplete'],
      // Both ledgers of one qualification are distinct bounded observations of the same delivery: one
      // record naming the same file twice has not separated what the client received from what the
      // reader intended, and a proof over an empty range set attests nothing at all.
      ['same-evidence.json', { evidence: { ...qualificationEvidence(901), intended: {
        path: join(fixture.root, 'qualification-observed-901.jsonl'), sha256: '4'.repeat(64), bytes: 4096, ranges: 5 } } },
        'workflow_review_reader_qualification_invalid'],
      ['no-ranges.json', { evidence: { ...qualificationEvidence(902), proof: { ranges: 0, reconstructionSha256: '2'.repeat(64) } } },
        'workflow_review_reader_qualification_invalid'],
      ['extra-key.json', { extra: 1 }, 'workflow_review_reader_qualification_invalid'],
      ['old-schema.json', { schemaVersion: 1 }, 'workflow_review_reader_qualification_invalid'],
      // The pre-correction record — a reader build, a route list and a delivered flag — is not a
      // qualification of any invocation, so it never parses and never authorizes a review.
      ['old-shape.json', { schemaVersion: 2, validation: 'synthetic',
        reader: { id: reader.id, sha256: reader.sha256 }, routes: ['codex', 'claude'], delivered: true },
        'workflow_review_reader_qualification_invalid'],
    ];
    for (const [_file, overrides, expected] of variants) {
      scope.configured.runtime.readerQualification = { ...scope.qualify(overrides), catalogPath: scope.catalogPath };
      await refused(expected);
    }
    // Complete delivery is observed rather than declared, so the runner's own observation capability is
    // an authority input alongside the record. A runner that declares no observer at all — the shape of
    // a native run with no implemented trusted observer — one whose declared inventory is not exactly
    // the two reader tools, and one whose declared mode disagrees with the qualification it carries,
    // are each refused here, before any pass, receipt, provider or frozen bundle exists.
    const qualifySynthetic = () => { scope.configured.runtime.readerQualification = { ...scope.qualify(), catalogPath: scope.catalogPath }; };
    qualifySynthetic();
    const observationRefusals: Array<[unknown, string]> = [
      [undefined, 'workflow_review_reader_observation_required'],
      [{ mode: 'synthetic', tools: [] }, 'workflow_review_reader_observation_incomplete'],
      [{ mode: 'synthetic', tools: [WORKFLOW_REVIEW_READER_TOOLS[0]] }, 'workflow_review_reader_observation_incomplete'],
      [{ mode: 'synthetic', tools: [...WORKFLOW_REVIEW_READER_TOOLS, 'review_source_write'] },
        'workflow_review_reader_observation_incomplete'],
      // A native observer may only ever be satisfied by a native qualification.
      [{ mode: 'native', tools: [...WORKFLOW_REVIEW_READER_TOOLS], identity: { id: 'trusted-observer', sha256: 'a'.repeat(64) } },
        'workflow_review_reader_observation_required'],
      [{ mode: 'native', tools: [...WORKFLOW_REVIEW_READER_TOOLS], identity: { id: 'trusted-observer', sha256: 'not-a-digest' } },
        'workflow_review_reader_observation_required'],
      [{ mode: 'synthetic', tools: [...WORKFLOW_REVIEW_READER_TOOLS], identity: { id: 'trusted-observer', sha256: 'a'.repeat(64) } },
        'workflow_review_reader_observation_required'],
    ];
    for (const [value, expected] of observationRefusals) {
      scope.configured.runtime.readerObservation = value as WorkflowRuntime['readerObservation'];
      await refused(expected);
    }
    // A native attribution is not admitted even at its most internally honest: the runner names a real
    // retained ledger at its exact digest *and* the qualification rests on that same ledger, so nothing
    // about the claim is self-contradictory — and the run is refused anyway. No trusted native observer
    // is implemented, so this controller has no way to obtain such a record, and an observation it
    // cannot have obtained cannot authorize a review. The refusal is the mode, not the record.
    const observedContent = '{"bundleSha256":"1"}\n';
    const observedPath = join(fixture.root, 'native-observed-ledger.jsonl');
    writeFileSync(observedPath, observedContent);
    const observedSha256 = hash(observedContent);
    scope.configured.runtime.readerObservation = { mode: 'native', tools: [...WORKFLOW_REVIEW_READER_TOOLS],
      identity: { id: 'trusted-observer', sha256: observedSha256, observedPath } };
    scope.configured.runtime.readerQualification = { ...scope.qualify({ validation: 'native',
      evidence: { bundleSha256: '1'.repeat(64), proof: { ranges: 5, reconstructionSha256: '2'.repeat(64) },
        observed: { path: observedPath, sha256: observedSha256, bytes: Buffer.byteLength(observedContent), ranges: 5 },
        intended: { path: join(fixture.root, 'native-intended-ledger.jsonl'), sha256: '4'.repeat(64), bytes: 4096, ranges: 5 } } }),
      catalogPath: scope.catalogPath };
    await refused('workflow_review_reader_observation_required');
    // ...and the refusal is the mode itself, never a weaker check that could be satisfied. It does not
    // degrade into a lookup of the record the attribution names, so an absent ledger, a digest that
    // matches nothing and a present ledger that matches exactly are refused alike: an observer cannot be
    // conjured by supplying one. `refused` also proves the stop lands before any pass, receipt,
    // provider, frozen bundle or coverage artifact exists.
    for (const identity of [
      { id: 'trusted-observer', sha256: observedSha256, observedPath: join(fixture.root, 'absent-ledger.jsonl') },
      { id: 'trusted-observer', sha256: 'a'.repeat(64), observedPath },
    ]) {
      scope.configured.runtime.readerObservation = { mode: 'native', tools: [...WORKFLOW_REVIEW_READER_TOOLS], identity };
      scope.configured.runtime.readerQualification = { ...scope.qualify({ validation: 'native' }), catalogPath: scope.catalogPath };
      await refused('workflow_review_reader_observation_required');
    }
    const fabricated = workflow.readWorkflow(fixture.cwd, name);
    expect(fabricated.reviewPasses).toBe(0);
    expect(fabricated.reviews).toEqual([]);
    expect(fabricated.reviewAttempts ?? []).toEqual([]);
    expect(fabricated.stage).not.toBe('review');
    expect(events()).toHaveLength(eventsBefore);
    expect(existsSync(artifact('review-coverage-1.json'))).toBe(false);
    expect(readdirSync(artifact('.')).filter(entry => entry.startsWith('review-source-'))).toEqual([]);
    // A synthetic record is accepted only inside a runner that declared itself synthetic — and it is
    // exactly that, a declaration rather than evidence — so here it resolves and reviews in full.
    fixture.configure({ findings: [{ severity: 'P3', message: 'Synthetic qualification finding',
      file: 'README.md', line: null }], tasks: { review: {} } });
    expect(qualified.sha256).toBe(hash(readFileSync(qualified.path)));
    scope.configured.runtime.readerObservation = { mode: 'synthetic', tools: [...WORKFLOW_REVIEW_READER_TOOLS] };
    scope.configured.runtime.readerQualification = { ...scope.qualify(), catalogPath: scope.catalogPath };
    const reviewed = await review(scope, selection('compat-adoption-1', ['README.md']));
    expect(reviewed.reviewPasses).toBe(1);
    expect(reviewed.reviews[0].findings).toEqual([expect.objectContaining({ severity: 'P3' })]);
    // The same record is refused outright the moment the runner stops declaring itself synthetic.
    scope.configured.runtime.allowSyntheticCapabilities = false;
    scope.configured.runtime.readerQualification = { ...scope.qualify(), catalogPath: scope.catalogPath };
    await expect(review(scope, selection('compat-adoption-1', ['README.md'])))
      .rejects.toThrow('workflow_review_reader_qualification_required');
  }, 300_000);

  it('refuses an untenable observation before the Codex catalog projection writes anything', async () => {
    // A Codex invocation is only reachable through a projected model catalog, and that projection is a
    // real artifact written into this attempt's artifact root. The observation authority is therefore
    // proven *first*: a runner whose declared observation cannot be accepted is refused before the
    // projection runs, so a refused review leaves no catalog artifact — and nothing else — behind. The
    // qualification carried below is a well-formed record for exactly this invocation, so the
    // observation is the only thing that can refuse the run.
    const scope = await setup({ reviewerRoute: 'codex' });
    const integrated = await integrate(scope);
    await adopt(scope, integrated, ['README.md', 'feature/a.txt']);
    const projected = () => readdirSync(artifact('.')).filter(entry => entry.startsWith('review-codex-catalog-'));
    const staging = () => readdirSync(artifact('.')).filter(entry => entry.startsWith('review-source-'));
    expect(projected()).toEqual([]);
    expect(staging()).toEqual([]);
    const eventsBefore = events().length;
    const untenable: Array<[unknown, string]> = [
      [undefined, 'workflow_review_reader_observation_required'],
      [{ mode: 'synthetic', tools: [WORKFLOW_REVIEW_READER_TOOLS[0]] },
        'workflow_review_reader_observation_incomplete'],
      [{ mode: 'native', tools: [...WORKFLOW_REVIEW_READER_TOOLS],
        identity: { id: 'trusted-observer', sha256: 'a'.repeat(64), observedPath: join(fixture.root, 'absent.jsonl') } },
        'workflow_review_reader_observation_required'],
    ];
    for (const [observation, expected] of untenable) {
      scope.configured.runtime.readerObservation = observation as WorkflowRuntime['readerObservation'];
      scope.configured.runtime.readerQualification = { ...scope.qualify(), catalogPath: scope.catalogPath };
      await expect(review(scope, selection('compat-adoption-1', ['feature/a.txt', 'README.md']))).rejects.toThrow(expected);
      const state = workflow.readWorkflow(fixture.cwd, name);
      expect(state.reviewPasses).toBe(0);
      expect(state.reviews).toEqual([]);
      expect(state.reviewAttempts ?? []).toEqual([]);
      expect(state.stage).not.toBe('review');
      // The projection is the witness: the refusal happened before it, so no catalog was written for a
      // run that was never going to start.
      expect(projected()).toEqual([]);
      expect(staging()).toEqual([]);
      expect(events()).toHaveLength(eventsBefore);
    }
    // The same invocation with an acceptable observation does project the catalog and does review, so
    // the emptiness above is the refusal and not a projection this route never performs.
    scope.configured.runtime.readerObservation = { mode: 'synthetic', tools: [...WORKFLOW_REVIEW_READER_TOOLS] };
    scope.configured.runtime.readerQualification = { ...scope.qualify(), catalogPath: scope.catalogPath };
    fixture.configure({ findings: [{ severity: 'P3', message: 'Projected catalog finding', file: 'feature/a.txt', line: null }],
      tasks: { review: {} } });
    const reviewed = await review(scope, selection('compat-adoption-1', ['feature/a.txt', 'README.md']));
    expect(reviewed.reviewPasses).toBe(1);
    expect(projected()).toHaveLength(1);
    expect(reviewed.reviews[0].findings).toEqual([expect.objectContaining({ severity: 'P3', file: 'feature/a.txt' })]);
  }, 300_000);

  it('refuses a Codex reviewer whose host model catalog is absent, malformed or does not carry the model', async () => {
    // The model catalog is applied at startup only, so an invocation with no usable projection would
    // run the binding's model on a code-mode-only surface where the reader can be deferred away. The
    // catalog is also part of the effective invocation, so a host catalog that is usable but is not
    // the one the qualification was computed against refuses as a mismatch of that invocation.
    const scope = await setup({ reviewerRoute: 'codex' });
    const integrated = await integrate(scope);
    await adopt(scope, integrated, ['README.md']);
    const qualified = { path: scope.qualified.path, sha256: scope.qualified.sha256 };
    const withCatalog = (catalogPath: string | undefined) => catalogPath === undefined
      ? { ...qualified, catalogPath: undefined } : { ...qualified, catalogPath };
    const emptyCatalog = join(fixture.root, 'empty-catalog.json');
    writeFileSync(emptyCatalog, JSON.stringify({ models: [] }));
    const malformed = join(fixture.root, 'malformed-catalog.json');
    writeFileSync(malformed, '{not json');
    const otherModel = join(fixture.root, 'other-model-catalog.json');
    writeFileSync(otherModel, JSON.stringify({ models: [{ slug: 'gpt-6-astra', tool_mode: 'code_mode' }] }));
    const eventsBefore = events().length;
    const refusals = [undefined, join(fixture.root, 'absent-catalog.json'), emptyCatalog, malformed, otherModel];
    for (const catalogPath of refusals) {
      scope.configured.runtime.readerQualification = withCatalog(catalogPath);
      await expect(review(scope, selection('compat-adoption-1', ['README.md'])))
        .rejects.toThrow('workflow_review_codex_catalog_unavailable');
      const state = workflow.readWorkflow(fixture.cwd, name);
      expect(state.reviewPasses).toBe(0);
      expect(state.reviews).toEqual([]);
      expect(state.reviewAttempts ?? []).toEqual([]);
      expect(events()).toHaveLength(eventsBefore);
      // A refused projection leaves no reservation, no receipt and no frozen bundle behind.
      expect(readdirSync(artifact('.')).filter(entry => entry.startsWith('review-source-'))).toEqual([]);
    }
    // A catalog the host really carries, but not the one this qualification was computed against,
    // is a qualification for another invocation: the review refuses rather than projecting it.
    const substituted = join(fixture.root, 'substituted-catalog.json');
    writeFileSync(substituted, JSON.stringify({ ...HOST_CATALOG, notes: ['substituted'] }));
    scope.configured.runtime.readerQualification = withCatalog(substituted);
    await expect(review(scope, selection('compat-adoption-1', ['README.md'])))
      .rejects.toThrow('workflow_review_reader_qualification_mismatch');
    // The host's own catalog is the one that projects, and the review then runs to completion.
    scope.configured.runtime.readerQualification = withCatalog(scope.catalogPath);
    fixture.configure({ findings: [{ severity: 'P3', message: 'Synthetic catalog finding',
      file: 'README.md', line: null }], tasks: { review: {} } });
    const reviewed = await review(scope, selection('compat-adoption-1', ['README.md']));
    expect(reviewed.reviewPasses).toBe(1);
    expect(events().findLast(event => event.role === 'reviewer')!.catalogModels).toEqual(PROJECTED_MODELS);
  }, 240_000);

  it("adopts the final PR's own base rather than the plan task base and freezes exactly that pair", async () => {
    // The plan's base is the narrower task delta. The authorized final-PR base is the PR's own base:
    // it may differ, but only if the reviewed head really descends from it. The adopted pair must
    // travel through adoption, freeze and request together.
    const scope = await setup();
    const integrated = await integrate(scope);
    expect(fixture.baseCommit).not.toBe(scope.head);
    const adopted = await adopt(scope, integrated, ['README.md', 'feature/a.txt'], fixture.baseCommit);
    expect(adopted.reviewCompatibilityAdoptions![0]!.source)
      .toMatchObject({ baseCommit: fixture.baseCommit, head: integrated });
    fixture.configure({ findings: [{ severity: 'P2', message: 'Synthetic final-PR base finding',
      file: 'feature/a.txt', line: 1 }], tasks: { review: {} } });
    const reviewed = await review(scope, selection('compat-adoption-1', ['feature/a.txt', 'README.md']));
    expect(reviewed.reviewPasses).toBe(1);
    const { bundle } = frozenBundle(reviewed);
    const entries = entriesOf(bundle);
    // The frozen bundle is bound to the adopted final-PR pair, never to the plan's narrower delta.
    expect(bundle.baseCommit).toBe(fixture.baseCommit);
    expect(bundle.head).toBe(integrated);
    // The frozen patch is the final PR's own binary-safe diff over that exact pair, so it carries
    // the governing instruction the plan's narrower task delta never contained.
    const freezeDiff = readFileSync(entries.find(entry => entry.id === 'diff')!.file, 'utf8');
    expect(freezeDiff).toContain('feature/a.txt');
    expect(freezeDiff).toContain('AGENTS.md');
    expect(entries.find(entry => entry.id === 'instr-0')!.path).toBe('AGENTS.md');
    expect(reviewed.reviews[0].findings).toEqual([expect.objectContaining({ file: 'feature/a.txt' })]);
    // A base the reviewed head does not descend from — including the head itself — is refused before
    // anything is recorded, so no review can be attributed to a pair that never existed.
    fixture.dispose(); fixture = createWorkflowFixture();
    const orphan = await setup();
    const orphanHead = await integrate(orphan);
    const orphanEvents = events().length;
    const tree = fixture.git('rev-parse', `${orphanHead}^{tree}`);
    const unrelated = fixture.git('commit-tree', tree, '-m', 'Unrelated root');
    expect(unrelated).not.toBe(orphanHead);
    await expect(adopt(orphan, orphanHead, ['README.md'], unrelated))
      .rejects.toThrow('workflow_review_compatibility_base_mismatch');
    await expect(adopt(orphan, orphanHead, ['README.md'], orphanHead))
      .rejects.toThrow('workflow_review_compatibility_base_mismatch');
    expect(workflow.readWorkflow(fixture.cwd, name).reviewCompatibilityAdoptions ?? []).toEqual([]);
    expect(events()).toHaveLength(orphanEvents);
  }, 300_000);

  it('delivers an authorized source above the retired 16 MiB bundle ceiling byte-for-byte', async () => {
    // The staged bounded scaffold refused exactly this selection with
    // workflow_review_source_bundle_too_large. Every byte, including the binary body, must arrive.
    const oversized = Buffer.alloc(RETIRED_BUNDLE_CEILING_BYTES + 1, 0x5a);
    mkdirSync(join(fixture.cwd, 'source'), { recursive: true });
    writeFileSync(join(fixture.cwd, 'source/large.bin'), oversized);
    fixture.git('add', '--', 'source/large.bin');
    fixture.git('commit', '-m', 'Track an authorized source above the retired bundle ceiling');
    // The finite fixture hit its provider timeout with both child closes retained. This scale case
    // uses the existing unbounded policy so every required page and proof can actually complete.
    const scope = await setup({ workflow: { providerPolicy: 'unbounded-provider-timeout' } });
    const integrated = await integrate(scope);
    await adopt(scope, integrated, ['README.md', 'source/large.bin']);
    // Retain actual child closes and the controller's bounded diagnostics before fixture disposal.
    // A missing close stays unknown; elapsed duration alone never establishes a provider timeout.
    const children: Array<{ role: 'reviewer' | 'reader'; pid: number | null; startedAt: string;
      endedAt: string | null; code: number | null; signal: NodeJS.Signals | null; error: string | null }> = [];
    const spawn = childProcess.spawn;
    vi.spyOn(childProcess, 'spawn').mockImplementation((...args) => {
      const child = Reflect.apply(spawn, undefined, args) as ReturnType<typeof childProcess.spawn>;
      const entry = Array.isArray(args[1]) ? args[1][0] : undefined;
      if (entry === capsule.reviewer || entry === capsule.reader) {
        const observed: typeof children[number] = { role: entry === capsule.reviewer ? 'reviewer' : 'reader',
          pid: child.pid ?? null, startedAt: new Date().toISOString(), endedAt: null, code: null, signal: null, error: null };
        children.push(observed);
        child.once('error', error => { observed.error = error.message.slice(0, 4096); });
        child.once('close', (code, signal) => { Object.assign(observed, { endedAt: new Date().toISOString(), code, signal }); });
      }
      return child;
    });
    let reviewed: Awaited<ReturnType<typeof review>>;
    try { reviewed = await review(scope, selection('compat-adoption-1', ['README.md', 'source/large.bin'])); }
    catch (error) {
      try {
        const directory = mkdtempSync(join(process.cwd(), '.tmp/large-object-failure-'));
        const attempt = v2Attempt(workflow.readWorkflow(fixture.cwd, name));
        const saved = JSON.stringify(attempt);
        if (Buffer.byteLength(saved) > 64 * 1024) throw new Error('oversized saved attempt diagnostic');
        writeFileSync(join(directory, 'attempt.json'), saved + '\n', { flag: 'wx' });
        const artifacts = [];
        for (const name of ['review-1.stdout.log', 'review-1.stderr.log', 'review-1.integrity.json']) {
          const path = artifact(name);
          if (!existsSync(path)) continue;
          if (statSync(path).size > 2 * 1024 * 1024) throw new Error('oversized process diagnostic');
          const bytes = readFileSync(path);
          writeFileSync(join(directory, name), bytes, { flag: 'wx' });
          artifacts.push({ name, bytes: bytes.length, sha256: hash(bytes) });
        }
        writeFileSync(join(directory, 'process-observations.json'), JSON.stringify({
          test: 'authorized source above the retired 16 MiB bundle ceiling',
          testSourceSha256: hash(readFileSync(new URL(import.meta.url))),
          rejection: error instanceof Error ? error.message.slice(0, 4096) : { type: typeof error },
          children, unknownCloses: ['reviewer', 'reader'].filter(role => !children.some(child => child.role === role && child.endedAt)),
          attempt: { name: 'attempt.json', bytes: Buffer.byteLength(saved + '\n'), sha256: hash(saved + '\n') },
          artifacts,
        }, null, 2) + '\n', { flag: 'wx' });
      } catch { /* Diagnostic retention must never replace the original rejection, including falsy values. */ }
      throw error;
    }
    expect(reviewed.reviewPasses).toBe(1);
    const { bundle } = frozenBundle(reviewed);
    const entries = entriesOf(bundle);
    const large = entries.find(entry => entry.path === 'source/large.bin')!;
    expect(large.bytes).toBeGreaterThan(RETIRED_BUNDLE_CEILING_BYTES);
    expect(bundle.totalBytes).toBeGreaterThan(RETIRED_BUNDLE_CEILING_BYTES);
    // The entry is one on-disk artifact whose bytes are the authorized source exactly.
    const onDisk = readFileSync(large.file);
    expect(onDisk.length).toBe(oversized.length);
    expect(hash(onDisk)).toBe(hash(oversized));
    expect(onDisk.equals(oversized)).toBe(true);
    // The reviewer read the whole object through many bounded pages, and coverage was proven.
    const reviewer = events().findLast(event => event.role === 'reviewer')!;
    expect(reviewer).toMatchObject({ complete: true, entries: bundle.entryCount, expectedTotalBytes: bundle.totalBytes });
    expect(reviewer.reconstructed).toBe(entries.filter(entry => entry.bytes > 0).length);
    expect(reviewer.ranges).toBeGreaterThan(RETIRED_BUNDLE_CEILING_BYTES / WORKFLOW_REVIEW_READ_LIMIT_BYTES);
    expect(reviewer.maxResponseBytes).toBeLessThanOrEqual(WORKFLOW_REVIEW_READ_LIMIT_BYTES);
    const coverage = reviewed.reviews[0].artifacts.find(descriptor => descriptor.kind === 'workflow-review-coverage')!;
    const record = JSON.parse(readFileSync(coverage.path, 'utf8'));
    expect(record.ranges).toBe(reviewer.ranges);
    expect(record.entries).toBe(bundle.entryCount);
    // The coverage artifact stays a constant-size descriptor however many ranges it attests.
    expect(readFileSync(coverage.path).length).toBeLessThan(2048);
  }, 1_800_000);

  it('refuses an adopted review whose delivery or coverage cannot be proven, without accepting findings', async () => {
    // A missing adoption receipt and each incomplete delivery are refused after the provider runs,
    // so the pass is spent and the attempt is settled as failed rather than shortened.
    const receipt = await setup();
    const receiptHead = await integrate(receipt);
    await adopt(receipt, receiptHead);
    rmSync(artifact('review-compatibility-adoption-1.json'));
    await expect(review(receipt, selection('compat-adoption-1', ['README.md']))).rejects.toThrow('workflow_review_compatibility_receipt_missing');
    const receiptState = workflow.readWorkflow(fixture.cwd, name);
    expect(receiptState.reviewPasses).toBe(1);
    expect(receiptState.reviews).toEqual([]);
    expect(receiptState.reviewAttempts?.at(-1)?.outcome).toBe('failed');
    expect(receiptState.reviewAttempts?.at(-1)?.error).toBe('workflow_review_compatibility_receipt_missing');
    expect(v2Attempt(receiptState).processResult).toMatchObject({ passed: true, parentExitedSuccessfully: true });
    expect(v2Attempt(receiptState).processResult?.integrityDiagnostic).toBeUndefined();
    expect(existsSync(artifact('review-1.integrity.json'))).toBe(false);
    expect(receiptState.stage).not.toBe('adjudication');
    expect(existsSync(artifact('review-coverage-1.json'))).toBe(false);

    // An unattributed delivery: the reviewer returns no attestation at all.
    fixture.dispose(); fixture = createWorkflowFixture();
    const silent = await setup();
    const silentHead = await integrate(silent);
    fixture.configure({ tasks: { review: { omitCoverage: true } } });
    await adopt(silent, silentHead);
    await expect(review(silent, selection('compat-adoption-1', ['README.md']))).rejects.toThrow('workflow_review_coverage_attestation_invalid');
    const silentState = workflow.readWorkflow(fixture.cwd, name);
    expect(silentState.reviews).toEqual([]);
    expect(v2Attempt(silentState).error).toBe('workflow_review_process_failed');
    expect(v2Attempt(silentState).processResult).toMatchObject({ passed: true, parentExitedSuccessfully: true });
    expect(JSON.parse(readFileSync(artifact('review-1.integrity.json'), 'utf8')).integrityDiagnostic)
      .toBe('workflow_review_coverage_attestation_invalid');

    // A partial delivery: one authorized entry is never read, so the tiling is incomplete.
    fixture.dispose(); fixture = createWorkflowFixture();
    const partial = await setup();
    const partialHead = await integrate(partial);
    fixture.configure({ tasks: { review: { skipEntries: 1 } } });
    await adopt(partial, partialHead);
    await expect(review(partial, selection('compat-adoption-1', ['README.md']))).rejects.toThrow('workflow_review_coverage_incomplete');
    const partialState = workflow.readWorkflow(fixture.cwd, name);
    expect(partialState.reviews).toEqual([]);
    expect(partialState.stage).not.toBe('adjudication');
    expect(existsSync(artifact('review-coverage-1.json'))).toBe(false);

    // A delivery that covers every entry but overstates its own tiling is refused too.
    fixture.dispose(); fixture = createWorkflowFixture();
    const inflated = await setup();
    const inflatedHead = await integrate(inflated);
    fixture.configure({ tasks: { review: { inflateRanges: true } } });
    await adopt(inflated, inflatedHead);
    await expect(review(inflated, selection('compat-adoption-1', ['README.md']))).rejects.toThrow('workflow_review_coverage_incomplete');
    expect(existsSync(artifact('review-coverage-1.json'))).toBe(false);

    // The same holds on the Codex route: a delivery that cannot be tiled is never accepted there either.
    fixture.dispose(); fixture = createWorkflowFixture();
    const codexPartial = await setup({ reviewerRoute: 'codex' });
    const codexHead = await integrate(codexPartial);
    fixture.configure({ tasks: { review: { skipEntries: 1 } } });
    await adopt(codexPartial, codexHead);
    await expect(review(codexPartial, selection('compat-adoption-1', ['README.md']))).rejects.toThrow('workflow_review_coverage_incomplete');
    expect(workflow.readWorkflow(fixture.cwd, name).reviews).toEqual([]);
    expect(existsSync(artifact('review-coverage-1.json'))).toBe(false);
    // All five real provider fixtures must run. Their combined setup and proof work exceeded the
    // ten-minute test allowance; each provider still has its original finite timeout.
  }, 1_800_000);

  it('refuses content altered in flight, in the recorded delivery and self-consistently on the wire alike', async () => {
    // The unchanged run is the control: the very same selection, reader and consumer, with no
    // alteration anywhere, completes and is accepted.
    const control = await setup();
    const controlHead = await integrate(control);
    fixture.configure({ findings: [{ severity: 'P3', message: 'Synthetic control finding', file: 'README.md', line: null }],
      tasks: { review: {} } });
    await adopt(control, controlHead);
    const reviewed = await review(control, selection('compat-adoption-1', ['README.md']));
    expect(reviewed.reviewPasses).toBe(1);
    expect(reviewed.reviews[0].findings).toEqual([expect.objectContaining({ severity: 'P3' })]);

    // A transport that alters the bytes it returns while every declared count, offset and range
    // digest stays plausible is refused by the consumer's own reconstruction, before any finding or
    // attestation: the reviewer never trusts a page it has not decoded and hashed itself.
    fixture.dispose(); fixture = createWorkflowFixture();
    const wire = await setup({ readerEntry: CORRUPT_ENTRY, readerEnvironment: { OMC_REVIEW_CORRUPT_MODE: 'wire' } });
    const wireHead = await integrate(wire);
    fixture.configure({ findings: [{ severity: 'P3', message: 'Synthetic wire finding', file: 'README.md', line: null }],
      tasks: { review: {} } });
    await adopt(wire, wireHead);
    await expect(review(wire, selection('compat-adoption-1', ['README.md']))).rejects.toThrow('workflow_review_process_failed');
    const wireState = workflow.readWorkflow(fixture.cwd, name);
    expect(wireState.reviewPasses).toBe(1);
    expect(wireState.reviews).toEqual([]);
    expect(wireState.reviewAttempts?.at(-1)?.outcome).toBe('failed');
    expect(existsSync(artifact('review-coverage-1.json'))).toBe(false);
    expect(events().findLast(event => event.role === 'reviewer')).toBeUndefined();
    // The consumer caught the substitution itself and said exactly what was wrong with it: the
    // saved process outcome is a genuine provider failure carrying that diagnostic, not a timeout
    // and not a truncated read. A refusal that could only be explained by the clock would prove
    // nothing about the delivery.
    const wireAttempt = v2Attempt(wireState);
    expect(wireAttempt.error).toBe('workflow_review_process_failed');
    expect(wireAttempt.processResult).toMatchObject({ passed: false, error: 'process_failed', stdoutTruncated: false });
    expect(readFileSync(artifact('review-1.stderr.log'), 'utf8'))
      .toContain('a returned page did not match its own declared range digest');

    // A delivery whose recorded bytes disagree with the frozen source — while the receipt itself is
    // internally consistent and every count and page is exactly what it should be — is refused by
    // the controller's own reconstruction of the returned bytes, not by re-reading the source disk.
    fixture.dispose(); fixture = createWorkflowFixture();
    const ledger = await setup({ readerEntry: CORRUPT_ENTRY, readerEnvironment: { OMC_REVIEW_CORRUPT_MODE: 'ledger' } });
    const ledgerHead = await integrate(ledger);
    fixture.configure({ findings: [{ severity: 'P3', message: 'Synthetic ledger finding', file: 'README.md', line: null }],
      tasks: { review: {} } });
    const ledgerAdopted = await adopt(ledger, ledgerHead);
    await expect(review(ledger, selection('compat-adoption-1', ['README.md']))).rejects.toThrow('workflow_review_source_corrupt');
    const ledgerState = workflow.readWorkflow(fixture.cwd, name);
    expect(ledgerState.reviewPasses).toBe(1);
    expect(ledgerState.reviews).toEqual([]);
    expect(ledgerState.reviewAttempts?.at(-1)?.outcome).toBe('failed');
    expect(ledgerState.reviewAttempts?.at(-1)?.error).toBe('workflow_review_process_failed');
    expect(ledgerState.stage).not.toBe('adjudication');
    expect(existsSync(artifact('review-coverage-1.json'))).toBe(false);
    // The reviewer itself completed and reported: the refusal came from the controller's own
    // reconstruction of the delivered bytes, which is what makes this a delivery-integrity failure
    // rather than a provider failure.
    const reviewer = events().findLast(event => event.role === 'reviewer')!;
    expect(reviewer).toMatchObject({ complete: true, ranges: expect.any(Number) });
    expect(typeof ledgerAdopted.reviewCompatibilityAdoptions?.[0]?.source.digest).toBe('string');

    // The hardest case: a transport that alters the bytes it returns *and* recomputes the digest
    // that describes them. Every page is now internally consistent on the wire, every declared count
    // and offset is plausible, and the reader's own receipt ledger is left completely clean. A
    // reviewer that only checks what it was told — declared here as oblivious — runs to completion
    // and exits zero with plausible findings and a complete coverage attestation, exactly as a
    // compromised or careless consumer would. Admission still fails, and it fails because the
    // delivery the client actually observed cannot reconstruct to the frozen source: two
    // independently written accounts of one delivery, reconciled against the immutable bundle.
    fixture.dispose(); fixture = createWorkflowFixture();
    const rehashed = await setup({ reviewerRoute: 'codex', readerEntry: CORRUPT_ENTRY, readerEnvironment: { OMC_REVIEW_CORRUPT_MODE: 'wire-rehash' } });
    const rehashedHead = await integrate(rehashed);
    fixture.configure({ findings: [{ severity: 'P3', message: 'Synthetic self-consistent finding', file: 'README.md', line: null }],
      tasks: { review: { observeOnly: true, quiet: true } } });
    await adopt(rehashed, rehashedHead);
    const spawn = childProcess.spawn; let reviewerClose: { code: number | null } | undefined;
    vi.spyOn(childProcess, 'spawn').mockImplementation((...args) => {
      const child = Reflect.apply(spawn, undefined, args) as ReturnType<typeof childProcess.spawn>;
      if (Array.isArray(args[1]) && args[1][0] === corruptCapsule.reviewer) child.once('close', code => { reviewerClose = { code }; });
      return child;
    });
    await expect(review(rehashed, selection('compat-adoption-1', ['README.md']))).rejects.toThrow('workflow_review_process_failed');
    const rehashedState = workflow.readWorkflow(fixture.cwd, name);
    expect(rehashedState.reviewPasses).toBe(1);
    expect(rehashedState.reviews).toEqual([]);
    expect(rehashedState.stage).not.toBe('adjudication');
    const rehashedAttempt = v2Attempt(rehashedState);
    expect(rehashedAttempt).toMatchObject({ outcome: 'failed', error: 'workflow_review_process_failed' });
    // The real child exits zero. Quiet output lacks Codex terminal telemetry, which the protected
    // process result correctly refuses separately; the saved session diagnostic proves corruption.
    expect(reviewerClose).toEqual({ code: 0 });
    expect(rehashedAttempt.processResult).toMatchObject({ passed: false, parentExitedSuccessfully: true,
      error: 'process_failed', stdoutTruncated: false,
      integrityDiagnostic: 'workflow_review_source_corrupt' });
    expect(JSON.parse(readFileSync(artifact('review-1.integrity.json'), 'utf8')).integrityDiagnostic)
      .toBe('workflow_review_source_corrupt');
    expect(existsSync(artifact('review-coverage-1.json'))).toBe(false);
    const rehashedReviewer = events().findLast(event => event.role === 'reviewer')!;
    expect(rehashedReviewer).toMatchObject({ complete: true, ranges: rehashedReviewer.entryRanges + rehashedReviewer.manifestRanges });
    // The reader's account of this delivery is clean and plausible; the reviewer's own observation
    // of the same delivery is not. The two records disagree byte for byte, and it is the observed
    // one — the only account of what really crossed the wire — that decides.
    const rehashedFrozen = frozenBundle(rehashedState);
    const intended = artifact(`review-source-receipts-${rehashedAttempt.invocationId}.jsonl`);
    const observed = join(artifact(`review-delivery-${rehashedAttempt.invocationId}`), 'frames.bin');
    expect(statSync(intended).size).toBeGreaterThan(0);
    expect(readFileSync(observed).equals(readFileSync(intended))).toBe(false);
    let alteredReceipt: { content: string; encoding: string; rangeSha256: string; bytes: number } | undefined;
    for await (const line of streamWorkflowReviewLines(observed)) {
      const message = JSON.parse(line);
      const content = message.result?.content?.[0]?.text;
      if (content && JSON.parse(content).id === 'instr-0') { alteredReceipt = JSON.parse(content); break; }
    }
    expect(alteredReceipt).toBeDefined();
    const receipt = alteredReceipt!;
    const alteredBytes = receipt.encoding === 'base64'
      ? Buffer.from(receipt.content, 'base64') : Buffer.from(receipt.content, 'utf8');
    expect(alteredBytes.length).toBe(receipt.bytes);
    // The altered page is entirely self-consistent: it carries exactly the bytes it declares and a
    // digest that truly describes them. Only the frozen object can contradict it.
    expect(hash(alteredBytes)).toBe(receipt.rangeSha256);
    expect(hash(alteredBytes)).not.toBe(entriesOf(rehashedFrozen.bundle)[0].sha256);
  }, 1_200_000);

  it('exposes the adoption and the per-review selection through the CLI under the same gates', async () => {
    const logged = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(WORKFLOW_HELP).toContain('adopt-review-compatibility <name> --file <intent.json>');
    expect(WORKFLOW_HELP).toContain('review <name> [--runtime <absolute-private-config.json>] [--compatibility <selection.json>]');
    const scope = await setup();
    const intentPath = join(fixture.root, 'adoption-intent.json');
    writeFileSync(intentPath, JSON.stringify(intent(scope, scope.head)));
    await workflowCommand(['adopt-review-compatibility', name, '--file', intentPath], fixture.cwd);
    const status = JSON.parse(String(logged.mock.calls.at(-1)![0]));
    expect(status).toMatchObject({ name, reviewPasses: 0, completedReviews: 0, reviewCompatibilityAdoptionCount: 1 });
    expect(workflow.readWorkflow(fixture.cwd, name).reviewCompatibilityAdoptions).toHaveLength(1);
    expect(existsSync(artifact('review-compatibility-adoption-1.json'))).toBe(true);
    // The intent file is mandatory for the operation.
    await expect(workflowCommand(['adopt-review-compatibility', name], fixture.cwd)).rejects.toThrow('workflow_input_file_required');
    // A selection that is not the declared shape is refused by the CLI before the controller runs:
    // the legacy path list, an unknown field and an unsupported manifest descriptor all fail here.
    const malformed = join(fixture.root, 'malformed-selection.json');
    writeFileSync(malformed, JSON.stringify({ requestId: 'compat-adoption-1', paths: ['README.md'] }));
    await expect(workflowCommand(['review', name, '--compatibility', malformed], fixture.cwd))
      .rejects.toThrow('workflow_invalid_compatibility_selection');
    const extended = join(fixture.root, 'extended-selection.json');
    writeFileSync(extended, JSON.stringify({ requestId: 'compat-adoption-1', descriptor: authorize(['README.md']), extra: true }));
    await expect(workflowCommand(['review', name, '--compatibility', extended], fixture.cwd))
      .rejects.toThrow('workflow_invalid_compatibility_selection');
    const unsupported = join(fixture.root, 'unsupported-selection.json');
    writeFileSync(unsupported, JSON.stringify({ requestId: 'compat-adoption-1',
      descriptor: { ...authorize(['README.md']), schemaVersion: 2 } }));
    await expect(workflowCommand(['review', name, '--compatibility', unsupported], fixture.cwd))
      .rejects.toThrow('workflow_invalid_compatibility_selection');
    // The CLI surfaces the same whole-request refusal the controller raises for a mismatched set.
    const narrowed = join(fixture.root, 'narrowed-selection.json');
    writeFileSync(narrowed, JSON.stringify(selection('compat-adoption-1', ['AGENTS.md'])));
    await expect(workflowCommand(['review', name, '--compatibility', narrowed], fixture.cwd))
      .rejects.toThrow('workflow_integration_incomplete');
    expect(workflow.readWorkflow(fixture.cwd, name).reviewPasses).toBe(0);
    expect(events()).toEqual([]);
  }, 120_000);
});
