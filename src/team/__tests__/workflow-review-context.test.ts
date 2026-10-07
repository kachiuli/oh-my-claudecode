/**
 * The complete, uncapped ordinary review context and serialized request.
 *
 * A complete automatic review delivers its whole context and its whole serialized request. This
 * worktree's base commit bounded both at 256 KiB and 384 KiB; this worktree's own scaffold raised
 * them to 512 KiB and 1 MiB and additionally rejected any single governed instruction above 64 KiB.
 * This delta removes the aggregate ceiling entirely, so the only remaining per-request bounds are
 * the reader's per-response and per-stream buffer policy.
 *
 * The tests below record that public boundary. The retired ceilings are checked absent from the
 * public contract module, a transport descriptor carrying a total is refused at parse, and a review
 * whose governed instructions alone exceed 1 MiB is delivered at its exact bytes and completes.
 * The provider records the request only after parsing its whole stdin, so a successful review of
 * that shape is itself the proof that nothing was truncated or dropped. The unrelated non-review
 * worker prompt bound stays untouched.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as workflow from '../workflow.js';
import * as contracts from '../workflow-contracts.js';
import type { WorkflowPlan } from '../workflow-contracts.js';
import { resetWorkflowReviewResourceUsage, workflowReviewResourceUsage, writeWorkflowReviewArtifact } from '../workflow-review-source.js';
import { createWorkflowFixture } from './helpers/workflow-fixture.js';
import { binding, runtimeFixture } from './helpers/workflow-v2-fixture.js';

vi.mock('node:fs', async importOriginal => ({ ...await importOriginal<typeof import('node:fs')>() }));
vi.mock('node:crypto', async importOriginal => ({ ...await importOriginal<typeof import('node:crypto')>() }));

/** The aggregate bounds this delta removes, retained here as the red evidence each one replaced. */
const RETIRED_CONTEXT_CEILING_BYTES = 512 * 1024;
const RETIRED_REQUEST_CEILING_BYTES = 1024 * 1024;
const RETIRED_BUNDLE_CEILING_BYTES = 16 * 1024 * 1024;
const RETIRED_INSTRUCTION_CEILING_BYTES = 64 * 1024;
/** One byte above the retired hidden per-instruction bound; the count then clears both aggregates. */
const INSTRUCTION_BYTES = RETIRED_INSTRUCTION_CEILING_BYTES + 1;
const INSTRUCTION_COUNT = 18;
const passingCheck = { command: process.execPath, args: ['-e', 'process.exit(0)'] };
const instructionDir = (index: number) => `d${String(index).padStart(2, '0')}`;
const instructionPath = (index: number) => `${instructionDir(index)}/AGENTS.md`;
function instructionContent(index: number): string {
  const header = `# Complete governing instruction ${index}\n`;
  return `${header}${'x'.repeat(INSTRUCTION_BYTES - header.length)}`;
}
/** Minimal shape of the fixture's recorded review request, which the shared helper does not type. */
interface RecordedReviewEvent {
  readonly role: string;
  readonly event: string;
  readonly request?: {
    readonly projectInstructions: Array<{ path: string; content: string }>;
    readonly sourceInventory: string;
    readonly changes: string;
    readonly instructions: string;
  };
}

describe('uncapped complete review context and request', () => {
  let fixture: ReturnType<typeof createWorkflowFixture>;
  beforeEach(() => {
    fixture = createWorkflowFixture();
    // State lives inside the fixture checkout, and the controller's lead-authority guard is told
    // this is not a worker context, so the test is independent of the environment that runs it.
    vi.stubEnv('OMC_STATE_DIR', '');
    for (const name of ['OMC_TEAM_WORKER', 'OMC_TEAM_WORKER_NAME', 'OMC_TEAM_WORKTREE_PATH']) vi.stubEnv(name, '');
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); fixture.dispose(); });

  it('exposes only per-response and per-buffer bounds, and no aggregate review ceiling at all', () => {
    // The retired aggregates are gone from the public contract, not merely raised.
    expect('WORKFLOW_REVIEW_CONTEXT_LIMIT_BYTES' in contracts).toBe(false);
    expect('WORKFLOW_REVIEW_REQUEST_LIMIT_BYTES' in contracts).toBe(false);
    expect('WORKFLOW_REVIEW_BUNDLE_LIMIT_BYTES' in contracts).toBe(false);
    // What remains is a versioned policy of two buffers, both far below every retired aggregate.
    expect(contracts.WORKFLOW_REVIEW_TRANSPORT_SCHEMA_VERSION).toBe(2);
    expect(contracts.WORKFLOW_REVIEW_READ_LIMIT_BYTES).toBe(8 * 1024);
    expect(contracts.WORKFLOW_REVIEW_BUFFER_LIMIT_BYTES).toBe(64 * 1024);
    const policy = contracts.workflowReviewTransportPolicy();
    expect(Object.keys(policy).sort()).toEqual(['bufferBytes', 'responseBytes', 'schemaVersion']);
    expect(policy).toEqual({ schemaVersion: 2, responseBytes: 8 * 1024, bufferBytes: 64 * 1024 });
    expect(policy.responseBytes).toBeLessThan(RETIRED_INSTRUCTION_CEILING_BYTES);
    expect(policy.bufferBytes).toBeLessThan(RETIRED_CONTEXT_CEILING_BYTES);
    // A descriptor that tries to carry an aggregate total is refused at parse, so no saved
    // adoption can re-introduce a context, request, source or read total behind the policy.
    const intent = { requestId: 'review-compatibility-1',
      source: { baseCommit: 'a'.repeat(40), head: 'e'.repeat(40),
        descriptor: { schemaVersion: 1, path: join(fixture.root, 'authorized-source.jsonl'), bytes: 40, records: 2, sha256: 'f'.repeat(64) } },
      controller: { id: 'team-workflow', sha256: 'b'.repeat(64) }, reader: { id: 'omc-review-source', sha256: 'c'.repeat(64) },
      transport: policy, reviewerBindingId: 'reviewer-claude', reviewerAuthFingerprint: 'd'.repeat(64),
      actor: { id: 'lead-codex', model: 'gpt-6-astra' }, authorityRef: 'issue-60',
      reason: 'Adopt the lossless review transport for one review' };
    expect(contracts.parseWorkflowReviewCompatibilityAdoptionIntent(intent))
      .toMatchObject({ requestId: 'review-compatibility-1', transport: policy });
    // The authorized source is one immutable on-disk manifest addressed by a constant descriptor —
    // its absolute path, byte count, record count and digest — so the intent names no file, no
    // content and no total: the set it authorizes is only readable from the manifest itself.
    expect(Object.keys(contracts.parseWorkflowReviewCompatibilityAdoptionIntent(intent).source).sort())
      .toEqual(['baseCommit', 'descriptor', 'head']);
    // A descriptor that binds no record, or no absolute manifest file, is refused outright.
    for (const invalid of [{ ...intent.source.descriptor, records: 0 }, { ...intent.source.descriptor, bytes: -1 },
      { ...intent.source.descriptor, path: 'authorized-source.jsonl' }]) {
      expect(() => contracts.parseWorkflowReviewCompatibilityAdoptionIntent({ ...intent,
        source: { ...intent.source, descriptor: invalid } })).toThrow('workflow_review_compatibility_invalid_paths');
    }
    // The legacy array form still loads, so a record saved before this delta stays readable, but it
    // carries no descriptor at all: no new selection can name it and no adoption can bind it.
    const legacy = contracts.parseWorkflowReviewCompatibilityAdoptionIntent({ ...intent,
      source: { baseCommit: intent.source.baseCommit, head: intent.source.head, paths: ['src/example.ts'] } });
    expect(Object.keys(legacy.source).sort()).toEqual(['baseCommit', 'head', 'paths']);
    expect('descriptor' in legacy.source).toBe(false);
    // Any aggregate total, named anything, is an unknown field and refused outright.
    for (const total of [{ ...policy, totalBytes: 1 }, { ...policy, maxBytes: 1 }, { ...policy, contextBytes: 1 },
      { ...policy, requestBytes: 1 }, { ...policy, bundleBytes: 1 }]) {
      expect(() => contracts.parseWorkflowReviewCompatibilityAdoptionIntent({ ...intent, transport: total }))
        .toThrow('workflow_unknown_field');
    }
    // A well-formed descriptor of another version or another buffer policy is refused, not adopted.
    for (const stale of [{ schemaVersion: 1, responseBytes: 8 * 1024, bufferBytes: 64 * 1024 },
      { schemaVersion: 2, responseBytes: 64 * 1024, bufferBytes: 64 * 1024 },
      { schemaVersion: 2, responseBytes: 8 * 1024, bufferBytes: 1024 * 1024 }]) {
      expect(() => contracts.parseWorkflowReviewCompatibilityAdoptionIntent({ ...intent, transport: stale }))
        .toThrow('workflow_review_compatibility_transport_unsupported');
    }
    // The unrelated non-review worker prompt bound is untouched by this change.
    const prompt = readFileSync(new URL('../workflow-prompt.ts', import.meta.url), 'utf8');
    expect(prompt).toContain('> 384 * 1024) throw new Error(\'workflow_prompt_too_large\')');
  });

  /**
   * Commit `count` governed instruction files before the integration starts. An index listed in
   * `asDirectory` gets a directory of the governed name instead of a regular instruction file.
   */
  function seedInstructions(count: number, asDirectory: readonly number[] = []): string {
    for (let index = 0; index < count; index++) {
      mkdirSync(join(fixture.cwd, instructionDir(index)), { recursive: true });
      const target = join(fixture.cwd, instructionDir(index), 'AGENTS.md');
      if (asDirectory.includes(index)) {
        mkdirSync(target);
        writeFileSync(join(target, 'inner.txt'), 'not a governed instruction\n');
      } else writeFileSync(target, instructionContent(index));
    }
    fixture.git('add', '--', '.');
    fixture.git('commit', '-m', `Track ${count} complete governing instructions`);
    return fixture.git('rev-parse', 'HEAD');
  }
  function plan(baseCommit: string, count: number): WorkflowPlan {
    return { name: 'context-bounds', objective: 'Deliver one complete automatic review context', baseCommit,
      integrationBranch: 'integration/context-bounds', verification: [passingCheck], tasks: [{ id: 'a', objective: 'Implement the owned component',
        baseCommit, writeScope: ['feature/a.txt'],
        readScope: ['README.md', ...Array.from({ length: count }, (_, index) => instructionPath(index))],
        prohibitedScope: [], dependencies: [], contracts: ['One complete owned component'],
        acceptanceCriteria: ['One committed component passes its declared check'], tests: [passingCheck] }] };
  }
  /** Integrate one task over a repository whose governed instructions dominate the review context. */
  async function integrate(count: number, asDirectory: readonly number[] = []) {
    const configured = runtimeFixture(fixture);
    await workflow.initWorkflowV2(fixture.cwd, plan(seedInstructions(count, asDirectory), count), {
      lead: binding('lead', 'codex'), implementer: configured.selectedBinding('implementer', 'claude', 'actor-author'),
      reviewer: configured.selectedBinding('reviewer', 'codex', 'actor-reviewer') },
    { maxAttempts: 1, maxReviewPasses: 2, backoffMs: 0, timeoutMs: 60_000 });
    await workflow.runWorkflow(fixture.cwd, 'context-bounds', configured.runtime);
    await workflow.acceptWorkflowTask(fixture.cwd, 'context-bounds', 'a');
    await workflow.verifyWorkflow(fixture.cwd, 'context-bounds');
    return configured;
  }
  const reviewEvents = () => (fixture.events() as unknown as RecordedReviewEvent[]).filter(event => event.role === 'reviewer');
  const deliveredRequest = () => reviewEvents()[0]!.request!;

  it('discovers actual ancestor and nested AGENTS and CLAUDE instructions once under overlapping unordered scopes', async () => {
    const instructions = ['AGENTS.md', 'CLAUDE.md', 'feature/AGENTS.md', 'feature/nested/CLAUDE.md'];
    mkdirSync(join(fixture.cwd, 'feature/nested'), { recursive: true });
    for (const path of instructions) writeFileSync(join(fixture.cwd, path), `Governing ${path}: é😀\n`);
    writeFileSync(join(fixture.cwd, 'feature/nested/source.txt'), 'source\n');
    fixture.git('add', '--', '.'); fixture.git('commit', '-m', 'Commit ancestor and nested instructions');
    const head = fixture.git('rev-parse', 'HEAD'); const configured = runtimeFixture(fixture);
    const selectedPlan = plan(head, 0);
    selectedPlan.tasks[0]!.readScope = ['feature/nested/source.txt', 'README.md', 'feature/**', 'feature/nested/**'];
    await workflow.initWorkflowV2(fixture.cwd, selectedPlan, { lead: binding('lead', 'codex'),
      implementer: configured.selectedBinding('implementer', 'claude', 'actor-author'),
      reviewer: configured.selectedBinding('reviewer', 'codex', 'actor-reviewer') },
    { maxAttempts: 1, maxReviewPasses: 3, backoffMs: 0, timeoutMs: 60_000 });
    await workflow.runWorkflow(fixture.cwd, 'context-bounds', configured.runtime);
    await workflow.acceptWorkflowTask(fixture.cwd, 'context-bounds', 'a');
    await workflow.verifyWorkflow(fixture.cwd, 'context-bounds');
    await workflow.reviewWorkflow(fixture.cwd, 'context-bounds', configured.runtime);
    const received = deliveredRequest().projectInstructions;
    expect(received.map(entry => entry.path).sort()).toEqual(instructions.slice().sort());
    for (const entry of received) expect(entry.content).toBe(readFileSync(join(fixture.cwd, entry.path), 'utf8'));

    const originalHash = crypto.createHash;
    const collide = vi.spyOn(crypto, 'createHash').mockImplementation((algorithm, options) => {
      const hash = originalHash(algorithm, options); const update = hash.update.bind(hash); let instruction = false;
      hash.update = ((value: string | Buffer, encoding?: BufferEncoding) => {
        if (typeof value === 'string' && instructions.includes(value)) instruction = true;
        return typeof value === 'string' ? update(value, encoding ?? 'utf8') : update(value);
      }) as typeof hash.update;
      const finish = hash.digest.bind(hash);
      hash.digest = ((encoding?: 'hex') => instruction && encoding === 'hex' ? 'f'.repeat(64) : encoding ? finish(encoding) : finish()) as typeof hash.digest;
      return hash;
    });
    try { await expect(workflow.reviewWorkflow(fixture.cwd, 'context-bounds', configured.runtime)).rejects.toThrow('workflow_review_context_invalid'); }
    finally { collide.mockRestore(); }
    expect(reviewEvents()).toHaveLength(1);

    const originalStat = fs.lstatSync;
    const denied = vi.spyOn(fs, 'lstatSync').mockImplementation(((path: fs.PathLike, options: fs.StatOptions) => {
      if (String(path) === join(fixture.cwd, 'CLAUDE.md')) throw Object.assign(new Error('instruction_read_denied'), { code: 'EACCES' });
      return originalStat(path, options);
    }) as typeof fs.lstatSync);
    try { await expect(workflow.reviewWorkflow(fixture.cwd, 'context-bounds', configured.runtime)).rejects.toThrow('instruction_read_denied'); }
    finally { denied.mockRestore(); }
    expect(reviewEvents()).toHaveLength(1);
  }, 180_000);

  it('delivers every governed instruction and the whole request above all three retired bounds', async () => {
    // 18 instructions of 65537 bytes are 1179666 bytes: every single instruction exceeds the retired
    // 64 KiB per-instruction bound, and their total alone exceeds both the retired 512 KiB context
    // ceiling and the retired 1 MiB request ceiling. The bounded scaffold refused exactly this shape.
    const configured = await integrate(INSTRUCTION_COUNT);
    const reviewed = await workflow.reviewWorkflow(fixture.cwd, 'context-bounds', configured.runtime);
    expect(reviewed.reviewPasses).toBe(1);
    expect(reviewed.reviews).toHaveLength(1);
    expect(reviewed.reviews[0]!.findings).toEqual([]);
    expect(reviewed.reviewAttempts?.[0]).toMatchObject({ outcome: 'completed', pass: 1 });

    const request = deliveredRequest();
    expect(request.projectInstructions).toHaveLength(INSTRUCTION_COUNT);
    expect(request.projectInstructions.map(entry => entry.path)).toEqual(
      Array.from({ length: INSTRUCTION_COUNT }, (_, index) => instructionPath(index)));
    // Delivered complete, never summarized or truncated: every instruction is present at its exact
    // bytes, and the request reached the provider only because the provider parsed its whole stdin.
    expect(request.projectInstructions.every(entry => Buffer.byteLength(entry.content) === INSTRUCTION_BYTES)).toBe(true);
    expect(request.projectInstructions.every(entry => Buffer.byteLength(entry.content) > RETIRED_INSTRUCTION_CEILING_BYTES)).toBe(true);
    expect(request.projectInstructions[11]!.content).toBe(instructionContent(11));
    expect(request.projectInstructions[0]!.path).toBe('d00/AGENTS.md');
    expect(request.changes).toContain('+complete synthetic component');
    expect(request.sourceInventory.split('\n')).toContain(instructionPath(INSTRUCTION_COUNT - 1));
    const instructions = Buffer.byteLength(JSON.stringify(request.projectInstructions));
    // The serialized instruction set is exactly the governed bytes plus its own small JSON framing.
    expect(instructions).toBeGreaterThan(INSTRUCTION_COUNT * INSTRUCTION_BYTES);
    expect(instructions).toBeLessThan(INSTRUCTION_COUNT * (INSTRUCTION_BYTES + 64));
    expect(instructions).toBeGreaterThan(RETIRED_CONTEXT_CEILING_BYTES);
    expect(instructions).toBeGreaterThan(RETIRED_REQUEST_CEILING_BYTES);
    // The complete serialized request, not just the instructions, clears the retired request ceiling.
    const serialized = Buffer.byteLength(JSON.stringify(request));
    expect(serialized).toBeGreaterThan(RETIRED_REQUEST_CEILING_BYTES);
    expect(serialized).toBeGreaterThan(instructions);
    expect(request.instructions).toContain('Inspect the integrated code against baseCommit');
    // The same shape stays repeatable: nothing was consumed, dropped or degraded to make it fit.
    const again = await workflow.reviewWorkflow(fixture.cwd, 'context-bounds', configured.runtime);
    expect(again.reviews).toHaveLength(2);
    expect(deliveredRequest().projectInstructions).toHaveLength(INSTRUCTION_COUNT);
  }, 240_000);

  it('keeps every integrity refusal intact: a non-file instruction still fails before any reservation', async () => {
    // Removing the size ceilings removed no integrity check. One governed instruction is a
    // directory rather than a regular file, and the review is refused for it — before the pass
    // counter, the reservation and any provider start.
    const configured = await integrate(4, [2]);
    const launches = fixture.events().length;

    await expect(workflow.reviewWorkflow(fixture.cwd, 'context-bounds', configured.runtime))
      .rejects.toThrow('workflow_review_context_invalid');

    const state = workflow.readWorkflow(fixture.cwd, 'context-bounds');
    expect(state.reviewPasses).toBe(0);
    expect(state.reviews).toEqual([]);
    expect(state.reviewAttempts ?? []).toEqual([]);
    expect(state.stage).not.toBe('review');
    expect(fixture.events()).toHaveLength(launches);
  }, 120_000);

  it('preserves a real surrogate pair across the 32768-unit material slice seam', () => {
    const value = 'a'.repeat(32767) + '\ud83d\ude00' + 'b'.repeat(32769);
    let chunks = 0;
    const path = join(fixture.root, 'material-seam.txt');
    writeWorkflowReviewArtifact({ path, chunks: (function* () {
      for (const chunk of workflow.reviewMaterialSlices(value)) {
        expect(chunk.length).toBeLessThanOrEqual(32768);
        expect(chunk).not.toMatch(/[\ud800-\udbff]$/);
        expect(chunk).not.toMatch(/^[\udc00-\udfff]/);
        chunks++; yield chunk;
      }
    })() });
    expect(chunks).toBe(3);
    expect(readFileSync(path)).toEqual(Buffer.from(value));
  });

  it('bounds encoded allocations for CJK material slices and whole JSON string fragments', () => {
    const value = '界'.repeat(21844) + '😀' + '界'.repeat(32768);
    resetWorkflowReviewResourceUsage();
    const from = Buffer.from; let largest = 0;
    const allocation = vi.spyOn(Buffer, 'from').mockImplementation(((...args: Parameters<typeof Buffer.from>) => {
      const result = Reflect.apply(from, Buffer, args) as Buffer;
      if (typeof args[0] === 'string') largest = Math.max(largest, result.length);
      return result;
    }) as typeof Buffer.from);
    try {
      writeWorkflowReviewArtifact({ path: join(fixture.root, 'cjk-material'), chunks: workflow.reviewMaterialSlices(value) });
      writeWorkflowReviewArtifact({ path: join(fixture.root, 'cjk-json'), chunks: [JSON.stringify({ value })] });
    } finally { allocation.mockRestore(); }
    expect(largest).toBeLessThanOrEqual(65536);
    expect(workflowReviewResourceUsage()).toMatchObject({ bufferBytes: 0, peakBufferBytes: largest, largestBuffer: largest });
    expect(readFileSync(join(fixture.root, 'cjk-material'), 'utf8')).toBe(value);
    expect(JSON.parse(readFileSync(join(fixture.root, 'cjk-json'), 'utf8'))).toEqual({ value });
  });

  it('never names a review-only aggregate ceiling anywhere in the controller', () => {
    // The retired error names and limit identifiers must not survive anywhere in the controller or
    // the reader it drives: a silently retained ceiling would be worse than the original bound.
    for (const file of ['../workflow.ts', '../workflow-review-source.ts', '../workflow-review-source-server.ts',
      '../workflow-contracts.ts', '../workflow-adapters.ts']) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8');
      for (const retired of ['workflow_review_context_too_large', 'workflow_review_request_too_large',
        'workflow_review_source_bundle_too_large', 'WORKFLOW_REVIEW_CONTEXT_LIMIT_BYTES',
        'WORKFLOW_REVIEW_REQUEST_LIMIT_BYTES', 'WORKFLOW_REVIEW_BUNDLE_LIMIT_BYTES']) {
        expect(source).not.toContain(retired);
      }
    }
    expect(RETIRED_BUNDLE_CEILING_BYTES).toBe(16 * 1024 * 1024);
  });
});
