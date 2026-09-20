import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { issueWorkflowPublication, type IssuedWorkflowPublication } from '../../../team/workflow-publication.js';

const api = vi.hoisted(() => ({
  initWorkflow: vi.fn(async () => ({ plan: { name: 'feature' } })),
  initWorkflowV2: vi.fn(async () => ({ plan: { name: 'feature' } })),
  substituteWorkflowBinding: vi.fn(),
  runWorkflow: vi.fn(), acceptWorkflowTask: vi.fn(), rejectWorkflowTask: vi.fn(),
  resumeWorkflowTask: vi.fn(), readWorkflow: vi.fn(),
  verifyWorkflow: vi.fn(), reviewWorkflow: vi.fn(), adjudicateWorkflow: vi.fn(),
  addWorkflowFix: vi.fn(), finishWorkflow: vi.fn(), cleanupWorkflow: vi.fn(),
  workflowStatus: vi.fn<() => Record<string, unknown>>(() => ({ name: 'feature', stage: 'planned' })),
}));
vi.mock('../../../team/workflow.js', () => api);
vi.mock('../../../team/workflow-report.js', () => ({ workflowUsage: () => ({ name: 'feature', providers: [] }) }));
import { workflowCommand } from '../team-workflow.js';

describe('team workflow CLI', () => {
  let root: string;
  let privateRoot: string;
  beforeEach(() => {
    vi.clearAllMocks();
    root = mkdtempSync(join(tmpdir(), 'omc-workflow-cli-'));
    privateRoot = mkdtempSync(join(tmpdir(), 'omc-workflow-private-'));
    execFileSync('git', ['init'], { cwd: root, stdio: 'pipe' });
    api.readWorkflow.mockReturnValue({ schemaVersion: 1 });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => { process.exitCode = 0; vi.unstubAllEnvs(); vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); rmSync(privateRoot, { recursive: true, force: true }); });

  function planFile() {
    const file = join(root, 'plan.json'); writeFileSync(file, JSON.stringify({ name: 'feature' })); return file;
  }

  function bindingsFile() {
    const file = join(root, 'roles.json');
    writeFileSync(file, JSON.stringify({
      lead: { id: 'external-lead' }, implementer: { id: 'claude-worker' }, reviewer: { id: 'claude-reviewer' } }));
    return file;
  }

  function runtimeFile(overrides: Record<string, unknown> = {}, file = join(privateRoot, 'runtime.json')) {
    writeFileSync(file, JSON.stringify({ schemaVersion: 1,
      profiles: { 'normal-claude': { providerRoute: 'claude', environment: { ANTHROPIC_API_KEY: 'synthetic-private-value' }, files: [] } },
      capabilityEvidence: { 'claude-worker': join(privateRoot, 'worker-capability.json') }, ...overrides }));
    return file;
  }

  function publicationAuthority(taskId = 'task-a', attempt = 1): { destination: string; issued: IssuedWorkflowPublication } {
    const workflowName = 'feature'; const worker = `task-${taskId}`; const sha = 'a'.repeat(40);
    const check = { command: process.execPath, args: ['-e', 'process.exit(0)'] };
    const task = { id: taskId, objective: 'Publish verified result', baseCommit: sha, writeScope: ['feature/a.txt'], readScope: [],
      prohibitedScope: [], dependencies: [], contracts: [], acceptanceCriteria: ['Verified publication succeeds'], tests: [] };
    const teamRoot = join(root, '.omc', 'state', 'team', workflowName); const artifacts = join(teamRoot, 'artifacts');
    mkdirSync(artifacts, { recursive: true });
    writeFileSync(join(teamRoot, 'workflow.json'), JSON.stringify({
      schemaVersion: 1, profile: 'claude-glm-codex', cwd: root,
      plan: { name: workflowName, objective: 'Publication fixture', baseCommit: sha, integrationBranch: 'integration/feature', verification: [check], tasks: [task] },
      options: { mode: 'v1' }, tasks: [{ task, canonicalId: '1', status: 'running', attempts: attempt, worker, worktree: root,
        invocations: [{ attempt, mode: 'fresh', startedAt: new Date().toISOString(), outcome: 'failed',
          error: 'workflow_invocation_incomplete', artifacts: [], telemetry: { provider: 'glm', durationMs: 0, status: 'unknown', scope: 'unknown' } }] }],
      reviews: [],
    }));
    const destination = join(artifacts, `${worker}-${attempt}.result.json`);
    const issued = issueWorkflowPublication({ workflowRoot: root, workflowName, taskId, worker, attempt, worktree: root, resultFile: destination });
    for (const [key, value] of Object.entries(issued.environment)) vi.stubEnv(key, value);
    vi.stubEnv('OMC_TEAM_WORKER', worker); vi.stubEnv('OMC_TEAM_WORKTREE_PATH', root);
    return { destination, issued };
  }

  it('documents explicit V1.2 selection and private runtime without making independence mandatory', async () => {
    await workflowCommand(['--help'], root);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('--profile claude-glm-codex|role-substitution'));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Self-review is allowed'));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('--runtime <absolute-private-config.json>'));
    expect(api.initWorkflow).not.toHaveBeenCalled(); expect(api.initWorkflowV2).not.toHaveBeenCalled();
  });

  it('publishes verified handoff bytes exclusively to the designated result path', async () => {
    const source = join(root, 'verified.json'); const { destination, issued } = publicationAuthority();
    const bytes = `${JSON.stringify({ taskId: 'task-a', outcome: 'completed', commitSha: 'a'.repeat(40),
      changedFiles: ['feature/a.txt'], tests: [], interfaceChanges: [], assumptions: [], risks: [], summary: 'Complete.' }, null, 2)}\n`;
    writeFileSync(source, bytes);
    await workflowCommand(['publish-result', '--source', source, '--result-file', destination, '--task-id', 'task-a'], root);
    expect(readFileSync(destination, 'utf8')).toBe(bytes);
    issued.revoke();
    const next = publicationAuthority();
    await expect(workflowCommand(['publish-result', '--source', source, '--result-file', destination, '--task-id', 'task-a'], root))
      .rejects.toThrow('workflow_result_already_exists');
    next.issued.revoke();
    expect(readFileSync(destination, 'utf8')).toBe(bytes);
  });

  it('rejects malformed or mismatched helper results before creating designated evidence', async () => {
    const source = join(root, 'invalid.json'); const { destination, issued } = publicationAuthority();
    for (const bytes of ['not json', JSON.stringify({ taskId: 'another-task', outcome: 'failed', changedFiles: [], tests: [],
      interfaceChanges: [], assumptions: [], risks: [], summary: 'Failed.' })]) {
      writeFileSync(source, bytes);
      await expect(workflowCommand(['publish-result', '--source', source, '--result-file', destination, '--task-id', 'task-a'], root))
        .rejects.toThrow(/workflow_/);
      expect(() => readFileSync(destination)).toThrow();
    }
    issued.revoke();
  });

  it('binds publication authority to the exact live task, attempt, and designated path', async () => {
    const source = join(root, 'verified.json'); const { destination, issued } = publicationAuthority();
    writeFileSync(source, JSON.stringify({ taskId: 'task-a', outcome: 'completed', commitSha: 'a'.repeat(40), changedFiles: ['feature/a.txt'],
      tests: [], interfaceChanges: [], assumptions: [], risks: [], summary: 'Complete.' }));
    for (const [target, taskId] of [
      [join(root, 'arbitrary-result.json'), 'task-a'],
      [destination.replace('-1.result.json', '-2.result.json'), 'task-a'],
      [destination, 'task-b'],
    ]) {
      await expect(workflowCommand(['publish-result', '--source', source, '--result-file', target, '--task-id', taskId], root))
        .rejects.toThrow('workflow_publication_not_authorized');
      expect(() => readFileSync(target)).toThrow();
    }
    issued.revoke();
  });

  it('explicitly selects a new schema-2 profile and forwards public bindings in balanced mode', async () => {
    const file = join(root, 'plan.json'); const bindingsFile = join(root, 'roles.json');
    const bindings = { lead: { id: 'external-lead' }, implementer: { id: 'claude-worker' }, reviewer: { id: 'claude-reviewer' } };
    writeFileSync(file, JSON.stringify({ name: 'feature' })); writeFileSync(bindingsFile, JSON.stringify(bindings));
    await workflowCommand(['init', '--file', file, '--profile', 'role-substitution', '--bindings', bindingsFile, '--workers', '2'], root);
    expect(api.initWorkflowV2).toHaveBeenCalledWith(root, { name: 'feature' }, bindings, { mode: 'balanced', workers: 2 });
    expect(api.initWorkflow).not.toHaveBeenCalled();
    expect(api.runWorkflow).not.toHaveBeenCalled();
  });

  it.each([
    ['--profile', 'unknown'], ['--bindings', 'unused'],
    ['--profile', 'role-substitution'],
    ['--profile', 'role-substitution', '--bindings', 'unused', '--mode', 'v1'],
  ])('rejects conflicting or incomplete profile selection %j before initialization', async (...flags) => {
    await expect(workflowCommand(['init', '--file', 'unused', ...flags], root)).rejects.toThrow(/workflow_/);
    expect(api.initWorkflow).not.toHaveBeenCalled(); expect(api.initWorkflowV2).not.toHaveBeenCalled();
  });

  it('permits explicit legacy selection without changing its initialization options', async () => {
    const file = join(root, 'plan.json'); writeFileSync(file, JSON.stringify({ name: 'feature' }));
    await workflowCommand(['init', '--file', file, '--profile', 'claude-glm-codex', '--mode', 'balanced'], root);
    expect(api.initWorkflow).toHaveBeenCalledWith(root, { name: 'feature' }, { mode: 'balanced' });
    expect(api.initWorkflowV2).not.toHaveBeenCalled();
  });

  it('forwards an explicit substitution intent without provider dispatch or budget options', async () => {
    const intent = { role: 'reviewer', binding: { id: 'claude-reviewer' }, expectedHead: 'a'.repeat(40),
      reason: 'Inspected unavailable route', authorityRef: 'decision-one' };
    const file = join(root, 'intent.json'); writeFileSync(file, JSON.stringify(intent));
    await workflowCommand(['substitute', 'feature', '--file', file], root);
    expect(api.substituteWorkflowBinding).toHaveBeenCalledWith(root, 'feature', intent);
    expect(api.runWorkflow).not.toHaveBeenCalled(); expect(api.reviewWorkflow).not.toHaveBeenCalled();
  });

  it.each([
    { role: 'executor' }, { expectedHead: 'not-a-sha' }, { reason: '' }, { authorityRef: '' }, { maxAttempts: 5 },
  ])('rejects malformed substitution input %j before controller selection', async override => {
    const file = join(root, 'intent.json'); writeFileSync(file, JSON.stringify({ role: 'reviewer', binding: { id: 'claude-reviewer' },
      expectedHead: 'a'.repeat(40), reason: 'Inspected', authorityRef: 'decision-one', ...override }));
    await expect(workflowCommand(['substitute', 'feature', '--file', file], root)).rejects.toThrow(/workflow_/);
    expect(api.substituteWorkflowBinding).not.toHaveBeenCalled();
  });

  it('resolves only the selected private profile and receipt without copying values to CLI output', async () => {
    api.readWorkflow.mockReturnValue({ schemaVersion: 2 });
    await workflowCommand(['run', 'feature', '--runtime', runtimeFile()], root);
    const runtime = api.runWorkflow.mock.calls[0][2];
    expect(runtime.resolveBinding({ id: 'claude-worker', authProfileRef: 'normal-claude' })).toEqual({
      authProfile: { ref: 'normal-claude', providerRoute: 'claude', environment: { ANTHROPIC_API_KEY: 'synthetic-private-value' }, files: [] },
      capabilityEvidencePath: join(privateRoot, 'worker-capability.json') });
    expect(() => runtime.resolveBinding({ id: 'missing', authProfileRef: 'normal-claude' })).toThrow(/workflow_/);
    expect(JSON.stringify(vi.mocked(console.log).mock.calls)).not.toContain('synthetic-private-value');
    expect(runtime).not.toHaveProperty('allowSyntheticCapabilities');
  });

  it('does not require the private files of an unused provider to exist', async () => {
    api.readWorkflow.mockReturnValue({ schemaVersion: 2 });
    const config = runtimeFile({ profiles: {
      'normal-claude': { providerRoute: 'claude', environment: {}, files: [] },
      'unavailable-glm': { providerRoute: 'glm', environment: {}, files: [join(privateRoot, 'unavailable-glm.json')] },
    } });
    await workflowCommand(['run', 'feature', '--runtime', config], root);
    const runtime = api.runWorkflow.mock.calls[0][2];
    expect(runtime.resolveBinding({ id: 'claude-worker', authProfileRef: 'normal-claude' }).authProfile.ref).toBe('normal-claude');
    expect(() => runtime.resolveBinding({ id: 'claude-worker', authProfileRef: 'unavailable-glm' })).toThrow('workflow_auth_profile_unavailable');
  });

  it('refuses selected private auth files in the project even if the runtime file is outside', async () => {
    api.readWorkflow.mockReturnValue({ schemaVersion: 2 });
    const auth = join(root, 'private-auth.json'); writeFileSync(auth, '{}');
    const config = runtimeFile({ profiles: { 'normal-claude': { providerRoute: 'claude', environment: {}, files: [auth] } } });
    await workflowCommand(['run', 'feature', '--runtime', config], root);
    expect(() => api.runWorkflow.mock.calls[0][2].resolveBinding({ id: 'claude-worker', authProfileRef: 'normal-claude' }))
      .toThrow('workflow_auth_profile_unavailable');
  });

  it.each(['review', 'resume'] as const)('forwards private runtime and authorship evidence to %s without changing the config file', async operation => {
    api.readWorkflow.mockReturnValue({ schemaVersion: 2 });
    const reviewAuthorship = { path: join(privateRoot, 'authors.json'), sha256: 'b'.repeat(64) };
    const config = runtimeFile({ reviewAuthorship }); const before = readFileSync(config);
    const head = 'a'.repeat(40);
    const args = operation === 'review' ? ['review', 'feature'] : ['resume', 'feature', 'task-a', '--expected-head', head, '--reason', 'Inspected'];
    await workflowCommand([...args, '--runtime', config], root);
    if (operation === 'review') expect(api.reviewWorkflow).toHaveBeenCalledWith(root, 'feature', expect.objectContaining({ reviewAuthorship }));
    else expect(api.resumeWorkflowTask).toHaveBeenCalledWith(root, 'feature', 'task-a', head, 'Inspected', expect.objectContaining({ reviewAuthorship }));
    expect(readFileSync(config)).toEqual(before);
    expect(JSON.stringify(vi.mocked(console.log).mock.calls)).not.toContain('synthetic-private-value');
  });

  it('does not load a private runtime as an implicit migration of a legacy workflow', async () => {
    await expect(workflowCommand(['run', 'feature', '--runtime', join(privateRoot, 'does-not-exist.json')], root))
      .rejects.toThrow('workflow_role_substitution_profile_required');
    expect(api.runWorkflow).not.toHaveBeenCalled();
  });

  it('rejects a private runtime inside the project and either direction of a directory alias', async () => {
    api.readWorkflow.mockReturnValue({ schemaVersion: 2 });
    const inside = runtimeFile({}, join(root, 'runtime.json'));
    const privateAlias = join(privateRoot, 'project-alias'); symlinkSync(root, privateAlias, 'junction');
    const projectAlias = join(root, 'private-alias'); symlinkSync(privateRoot, projectAlias, 'junction');
    runtimeFile();
    for (const file of [inside, join(privateAlias, 'runtime.json'), join(projectAlias, 'runtime.json')]) {
      await expect(workflowCommand(['run', 'feature', '--runtime', file], root)).rejects.toThrow('workflow_private_runtime_outside_project_required');
    }
    expect(api.runWorkflow).not.toHaveBeenCalled();
  });

  it.each([
    { schemaVersion: 2 }, { allowSyntheticCapabilities: true }, { profiles: [] },
    { profiles: { 'normal-claude': { providerRoute: 'unknown', environment: {}, files: [] } } },
    { profiles: { 'normal-claude': { providerRoute: 'claude', environment: { SECRET: { nested: 'synthetic-private-value' } }, files: [] } } },
    { capabilityEvidence: { 'claude-worker': 'relative.json' } },
  ])('rejects malformed private configuration %j without exposing its values', async overrides => {
    api.readWorkflow.mockReturnValue({ schemaVersion: 2 });
    await expect(workflowCommand(['run', 'feature', '--runtime', runtimeFile(overrides)], root)).rejects.toThrow('workflow_invalid_runtime_config');
    expect(api.runWorkflow).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(console.log).mock.calls)).not.toContain('synthetic-private-value');
  });

  it('bounds private configuration and hides malformed JSON or relative-path input in a fixed error', async () => {
    api.readWorkflow.mockReturnValue({ schemaVersion: 2 });
    const malformed = join(privateRoot, 'malformed.json'); writeFileSync(malformed, '{"token":"synthetic-private-value", broken}');
    const oversized = join(privateRoot, 'oversized.json'); writeFileSync(oversized, 'x'.repeat(256 * 1024 + 1));
    for (const file of [malformed, oversized, 'relative-runtime.json']) {
      const failure = await workflowCommand(['run', 'feature', '--runtime', file], root).catch(error => error);
      expect(failure.message).toBe('workflow_invalid_runtime_config');
      expect(String(failure)).not.toContain('synthetic-private-value');
    }
    expect(api.runWorkflow).not.toHaveBeenCalled();
  });

  it('rejects unknown or missing public binding roles before initializing a workflow', async () => {
    const plan = join(root, 'plan.json'); writeFileSync(plan, JSON.stringify({ name: 'feature' }));
    const file = join(root, 'roles.json');
    for (const roles of [{ lead: {}, implementer: {} }, { lead: {}, implementer: {}, reviewer: {}, executor: {} }]) {
      writeFileSync(file, JSON.stringify(roles));
      await expect(workflowCommand(['init', '--file', plan, '--profile', 'role-substitution', '--bindings', file], root))
        .rejects.toThrow('workflow_invalid_bindings');
    }
    expect(api.initWorkflowV2).not.toHaveBeenCalled();
  });

  it('passes a file plan and explicit limits to initialization', async () => {
    const file = join(root, 'plan.json');
    writeFileSync(file, JSON.stringify({ name: 'feature' }));
    await workflowCommand(['init', '--file', file, '--workers', '3', '--max-review-passes', '2'], root);
    expect(api.initWorkflow).toHaveBeenCalledWith(root, { name: 'feature' }, { workers: 3, maxReviewPasses: 2 });
    expect(console.log).toHaveBeenCalledWith(JSON.stringify({ name: 'feature', stage: 'planned' }));
  });

  it('forwards an explicit timeout to legacy initialization', async () => {
    await workflowCommand(['init', '--file', planFile(), '--timeout-ms', '3600000'], root);
    expect(api.initWorkflow).toHaveBeenCalledWith(root, { name: 'feature' }, { timeoutMs: 3600000 });
    expect(api.initWorkflowV2).not.toHaveBeenCalled();
  });

  it('forwards the same timeout to role-substitution initialization', async () => {
    await workflowCommand(['init', '--file', planFile(), '--profile', 'role-substitution',
      '--bindings', bindingsFile(), '--timeout-ms', '3600000'], root);
    expect(api.initWorkflowV2).toHaveBeenCalledWith(root, { name: 'feature' },
      { lead: { id: 'external-lead' }, implementer: { id: 'claude-worker' }, reviewer: { id: 'claude-reviewer' } },
      { mode: 'balanced', timeoutMs: 3600000 });
    expect(api.initWorkflow).not.toHaveBeenCalled();
  });

  it.each(['100', '3600000'])('accepts the inclusive timeout boundary %s', async value => {
    await workflowCommand(['init', '--file', planFile(), '--timeout-ms', value], root);
    expect(api.initWorkflow).toHaveBeenCalledWith(root, { name: 'feature' }, { timeoutMs: Number(value) });
  });

  it.each(['0100', '00100', '03600000'])('forwards the zero-padded timeout %s as its numeric value', async value => {
    await workflowCommand(['init', '--file', planFile(), '--timeout-ms', value], root);
    expect(api.initWorkflow).toHaveBeenCalledWith(root, { name: 'feature' }, { timeoutMs: Number(value) });
    expect(api.initWorkflowV2).not.toHaveBeenCalled();
  });

  it.each([
    'malformed', '1.5', '-1', '0', '000', '99', '3600001', '9007199254740993', '+100', '1e3', ' 100', '100 ',
  ])('refuses the invalid timeout %j as an invalid limit before initialization', async value => {
    await expect(workflowCommand(['init', '--file', planFile(), '--timeout-ms', value], root))
      .rejects.toThrow('workflow_invalid_limit');
    expect(api.initWorkflow).not.toHaveBeenCalled(); expect(api.initWorkflowV2).not.toHaveBeenCalled();
  });

  it.each(['0099', '03600001', '0009007199254740993'])(
    'refuses the zero-padded out-of-range timeout %j as an invalid limit', async value => {
      await expect(workflowCommand(['init', '--file', planFile(), '--timeout-ms', value], root))
        .rejects.toThrow('workflow_invalid_limit');
      expect(api.initWorkflow).not.toHaveBeenCalled(); expect(api.initWorkflowV2).not.toHaveBeenCalled();
    });

  it('refuses a missing or duplicate timeout flag before initialization', async () => {
    const file = planFile();
    await expect(workflowCommand(['init', '--file', file, '--timeout-ms'], root))
      .rejects.toThrow('workflow_invalid_arguments');
    await expect(workflowCommand(['init', '--file', file, '--timeout-ms', '1000', '--timeout-ms', '1000'], root))
      .rejects.toThrow('workflow_invalid_arguments');
    expect(api.initWorkflow).not.toHaveBeenCalled(); expect(api.initWorkflowV2).not.toHaveBeenCalled();
  });

  it('omits timeoutMs when the flag is absent so the saved controller default is unchanged', async () => {
    await workflowCommand(['init', '--file', planFile()], root);
    const legacy = api.initWorkflow.mock.calls[0] as unknown as [string, unknown, Record<string, unknown>];
    expect(legacy[2]).toEqual({});
    expect(legacy[2]).not.toHaveProperty('timeoutMs');
    await workflowCommand(['init', '--file', planFile(), '--profile', 'role-substitution', '--bindings', bindingsFile()], root);
    const substitution = api.initWorkflowV2.mock.calls[0] as unknown as [string, unknown, unknown, Record<string, unknown>];
    expect(substitution[3]).not.toHaveProperty('timeoutMs');
  });

  it('documents the timeout flag for init only', async () => {
    await workflowCommand(['--help'], root);
    const help = vi.mocked(console.log).mock.calls.map(call => String(call[0])).join('\n');
    expect(help.slice(help.indexOf('init --file'), help.indexOf('run <name>'))).toContain('--timeout-ms');
    expect(help.split('\n').filter(line => line.includes('--timeout-ms'))).toHaveLength(1);
    await expect(workflowCommand(['run', 'feature', '--timeout-ms', '3600000'], root)).rejects.toThrow('workflow_unknown_option');
    expect(api.runWorkflow).not.toHaveBeenCalled();
  });

  it.each(['run', 'verify', 'review', 'finish'] as const)('dispatches the explicit %s operation', async operation => {
    await workflowCommand([operation, 'feature'], root);
    const methods = { run: api.runWorkflow, verify: api.verifyWorkflow, review: api.reviewWorkflow, finish: api.finishWorkflow };
    expect(methods[operation]).toHaveBeenCalledWith(root, 'feature');
  });

  it('requires a reason for rejection and never accepts a rejected task', async () => {
    await expect(workflowCommand(['reject', 'feature', 'task-a'], root)).rejects.toThrow('workflow_reason_required');
    await workflowCommand(['reject', 'feature', 'task-a', '--reason', 'Outside scope'], root);
    expect(api.rejectWorkflowTask).toHaveBeenCalledWith(root, 'feature', 'task-a', 'Outside scope');
    expect(api.acceptWorkflowTask).not.toHaveBeenCalled();
  });

  it('opts into balanced mode explicitly while rejecting unknown modes', async () => {
    const file = join(root, 'plan.json');
    writeFileSync(file, JSON.stringify({ name: 'feature' }));
    await workflowCommand(['init', '--file', file, '--mode', 'balanced'], root);
    expect(api.initWorkflow).toHaveBeenCalledWith(root, { name: 'feature' }, { mode: 'balanced' });
    await expect(workflowCommand(['init', '--file', file, '--mode', 'cheap'], root)).rejects.toThrow('workflow_invalid_mode');
  });

  it('requires an explicit head and reason for session continuation', async () => {
    const head = 'a'.repeat(40);
    await expect(workflowCommand(['resume', 'feature', 'task-a'], root)).rejects.toThrow('workflow_reason_required');
    await expect(workflowCommand(['resume', 'feature', 'task-a', '--reason', 'Inspected'], root)).rejects.toThrow('workflow_invalid_sha');
    expect(api.resumeWorkflowTask).not.toHaveBeenCalled();
    await workflowCommand(['resume', 'feature', 'task-a', '--expected-head', head, '--reason', 'Inspected'], root);
    expect(api.resumeWorkflowTask).toHaveBeenCalledWith(root, 'feature', 'task-a', head, 'Inspected');
  });

  it('reports usage without dispatching a worker', async () => {
    await workflowCommand(['usage', 'feature'], root);
    expect(api.readWorkflow).toHaveBeenCalledWith(root, 'feature');
    expect(console.log).toHaveBeenCalledWith(JSON.stringify({ name: 'feature', providers: [] }));
    expect(api.runWorkflow).not.toHaveBeenCalled();
  });

  it('reports a failed resumed attempt with a failing exit status', async () => {
    api.workflowStatus.mockReturnValueOnce({ failedTasks: 1 });
    await workflowCommand(['resume', 'feature', 'task-a', '--expected-head', 'a'.repeat(40), '--reason', 'Inspected'], root);
    expect(process.exitCode).toBe(1);
  });

  it('passes lead dispositions from a file without automatic fix dispatch', async () => {
    const file = join(root, 'decisions.json');
    const decisions = [{ findingId: 'p1', disposition: 'fix', reason: 'Reproduced' }];
    writeFileSync(file, JSON.stringify(decisions));
    await workflowCommand(['adjudicate', 'feature', '--file', file], root);
    expect(api.adjudicateWorkflow).toHaveBeenCalledWith(root, 'feature', decisions);
    expect(api.runWorkflow).not.toHaveBeenCalled();
  });

  it('bounds input before passing it to the controller', async () => {
    const file = join(root, 'huge.json');
    writeFileSync(file, 'x'.repeat(256 * 1024 + 1));
    await expect(workflowCommand(['init', '--file', file], root)).rejects.toThrow('workflow_input_too_large');
    expect(api.initWorkflow).not.toHaveBeenCalled();
  });

  it('reports failed local verification as a failing command', async () => {
    api.workflowStatus.mockReturnValueOnce({ verification: { passed: false } });
    await workflowCommand(['verify', 'feature'], root);
    expect(process.exitCode).toBe(1);
  });

  it('forwards the explicit supervised policy to legacy initialization', async () => {
    await workflowCommand(['init', '--file', planFile(), '--provider-policy', 'supervised'], root);
    expect(api.initWorkflow).toHaveBeenCalledWith(root, { name: 'feature' }, { providerPolicy: 'supervised' });
    expect(api.initWorkflowV2).not.toHaveBeenCalled();
  });

  it('forwards the same supervised policy to role-substitution initialization', async () => {
    await workflowCommand(['init', '--file', planFile(), '--profile', 'role-substitution',
      '--bindings', bindingsFile(), '--provider-policy', 'supervised'], root);
    expect(api.initWorkflowV2).toHaveBeenCalledWith(root, { name: 'feature' },
      { lead: { id: 'external-lead' }, implementer: { id: 'claude-worker' }, reviewer: { id: 'claude-reviewer' } },
      { mode: 'balanced', providerPolicy: 'supervised' });
    expect(api.initWorkflow).not.toHaveBeenCalled();
  });

  it.each(['legacy', 'Supervised', 'supervised ', 'unsupervised', 'supervised,legacy', 'null'])(
    'refuses the unsupported policy %j before initialization', async value => {
      await expect(workflowCommand(['init', '--file', planFile(), '--provider-policy', value], root))
        .rejects.toThrow('workflow_invalid_policy');
      await expect(workflowCommand(['init', '--file', planFile(), '--profile', 'role-substitution',
        '--bindings', bindingsFile(), '--provider-policy', value], root)).rejects.toThrow('workflow_invalid_policy');
      expect(api.initWorkflow).not.toHaveBeenCalled(); expect(api.initWorkflowV2).not.toHaveBeenCalled();
    });

  it('refuses a missing or duplicate policy flag before initialization', async () => {
    const file = planFile();
    await expect(workflowCommand(['init', '--file', file, '--provider-policy'], root))
      .rejects.toThrow('workflow_invalid_arguments');
    await expect(workflowCommand(['init', '--file', file, '--provider-policy', 'supervised', '--provider-policy', 'supervised'], root))
      .rejects.toThrow('workflow_invalid_arguments');
    expect(api.initWorkflow).not.toHaveBeenCalled(); expect(api.initWorkflowV2).not.toHaveBeenCalled();
  });

  it('keeps the initialization options free of a policy when the flag is absent in both profiles', async () => {
    await workflowCommand(['init', '--file', planFile()], root);
    const legacy = api.initWorkflow.mock.calls[0] as unknown as [string, unknown, Record<string, unknown>];
    expect(legacy[2]).toEqual({});
    await workflowCommand(['init', '--file', planFile(), '--profile', 'role-substitution', '--bindings', bindingsFile()], root);
    const substitution = api.initWorkflowV2.mock.calls[0] as unknown as [string, unknown, unknown, Record<string, unknown>];
    expect(substitution[3]).not.toHaveProperty('providerPolicy');
  });

  it('documents the supervised policy flag for init only', async () => {
    await workflowCommand(['--help'], root);
    const help = vi.mocked(console.log).mock.calls.map(call => String(call[0])).join('\n');
    expect(help.slice(help.indexOf('init --file'), help.indexOf('run <name>'))).toContain('--provider-policy supervised');
    expect(help.split('\n').filter(line => line.includes('--provider-policy'))).toHaveLength(1);
    await expect(workflowCommand(['run', 'feature', '--provider-policy', 'supervised'], root)).rejects.toThrow('workflow_unknown_option');
    expect(api.runWorkflow).not.toHaveBeenCalled();
  });

  it.each(['run', 'verify', 'review', 'finish', 'status', 'usage', 'cleanup', 'accept'] as const)(
    'rejects the initialization-only policy flag on later %s operations', async operation => {
      await expect(workflowCommand([operation, 'feature', '--provider-policy', 'supervised'], root)).rejects.toThrow('workflow_unknown_option');
      expect(api.runWorkflow).not.toHaveBeenCalled(); expect(api.reviewWorkflow).not.toHaveBeenCalled();
    });

  it.each([
    ['run', 'feature', '--force', 'true'], ['review', 'feature', 'extra'],
    ['init', '--file', 'unused', '--workers', 'NaN'],
    ['init', '--file', 'unused', '--workers', '0'], ['erase', 'feature'],
  ])('rejects invalid arguments %j', async (...args) => {
    await expect(workflowCommand(args, root)).rejects.toThrow(/workflow_/);
    expect(api.initWorkflow).not.toHaveBeenCalled();
    expect(api.reviewWorkflow).not.toHaveBeenCalled();
  });
});
