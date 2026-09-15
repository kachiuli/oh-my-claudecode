import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { workflowCommand } from '../team-workflow.js';
import { readWorkflow } from '../../../team/workflow.js';
import { parseWorkflowBinding } from '../../../team/workflow-contracts.js';
import { fingerprintWorkflowAuthProfile } from '../../../team/workflow-adapters.js';
import { createWorkflowFixture } from '../../../team/__tests__/helpers/workflow-fixture.js';

const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

describe('workflow V1.2 CLI with the actual controller and no provider calls', () => {
  let fixture: ReturnType<typeof createWorkflowFixture>;
  beforeEach(() => {
    fixture = createWorkflowFixture();
    vi.stubEnv('OMC_STATE_DIR', '');
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    process.exitCode = 0; vi.restoreAllMocks(); vi.unstubAllEnvs();
    console.info(`Synthetic CLI fixture retained: ${fixture.root}`);
  });

  function inputs() {
    const profile = { ref: 'claude-fixture', providerRoute: 'claude' as const, environment: {}, files: [] };
    const authFingerprint = fingerprintWorkflowAuthProfile(profile);
    const executableIdentity = { path: process.execPath, sha256: sha256(readFileSync(process.execPath)), version: process.version };
    const capabilityEvidence: Record<string, string> = {};
    function executableBinding(role: 'implementer' | 'reviewer') {
      const id = `${role}-fixture`;
      const capabilities = role === 'implementer' ? ['structured-handoff', 'session-resume'] : ['structured-findings', 'read-only'];
      // The real Node executable is deliberately NOT claimed to be an authenticated Claude adapter.
      const receipt = JSON.stringify({ schemaVersion: 1, role, providerRoute: 'claude', cliFamily: 'claude-code',
        validation: 'synthetic', executableIdentity, authFingerprint, capabilities, models: [{ model: 'fixture-model', efforts: [null] }] });
      const path = join(fixture.root, `${id}.json`); writeFileSync(path, receipt); capabilityEvidence[id] = path;
      return parseWorkflowBinding({ id, role, providerRoute: 'claude', cliFamily: 'claude-code', model: 'fixture-model',
        authProfileRef: profile.ref, authFingerprint, executableIdentity, capabilities, capabilityEvidenceSha256: sha256(receipt) });
    }
    const lead = parseWorkflowBinding({ id: 'external-lead', role: 'lead', providerRoute: 'codex', cliFamily: 'external',
      model: 'gpt-6-astra', authProfileRef: 'external-evidence', authFingerprint: 'a'.repeat(64),
      capabilities: ['external-lead'], capabilityEvidenceSha256: 'b'.repeat(64) });
    const bindings = { lead, implementer: executableBinding('implementer'), reviewer: executableBinding('reviewer') };
    const rolesFile = join(fixture.root, 'roles.json'); writeFileSync(rolesFile, JSON.stringify(bindings));
    const runtimeFile = join(fixture.root, 'runtime.json');
    writeFileSync(runtimeFile, JSON.stringify({ schemaVersion: 1,
      profiles: { [profile.ref]: { providerRoute: profile.providerRoute, environment: profile.environment, files: profile.files } }, capabilityEvidence }));
    const planFile = join(fixture.root, 'plan.json');
    const check = { command: process.execPath, args: ['-e', 'process.exit(0)'] };
    writeFileSync(planFile, JSON.stringify({ name: 'feature', objective: 'Exercise CLI initialization only', baseCommit: fixture.baseCommit,
      integrationBranch: 'integration/feature', verification: [check], tasks: [
        { id: 'one', objective: 'Owned synthetic task', baseCommit: fixture.baseCommit, writeScope: ['feature/one.txt'],
          readScope: ['README.md'], prohibitedScope: [], dependencies: [], contracts: [], acceptanceCriteria: ['Owned file exists'], tests: [check] },
      ] }));
    return { rolesFile, runtimeFile, planFile };
  }

  it.each(['claude-glm-codex', 'role-substitution'])('initializes and reads %s without an implicit state migration', async profile => {
    const { rolesFile, planFile } = inputs();
    await workflowCommand(['init', '--file', planFile, '--profile', profile, '--mode', 'balanced', '--workers', '1',
      ...(profile === 'role-substitution' ? ['--bindings', rolesFile] : [])], fixture.cwd);
    const state = readWorkflow(fixture.cwd, 'feature');
    expect(state.schemaVersion).toBe(profile === 'role-substitution' ? 2 : 1);
    expect(state.profile).toBe(profile);
    expect(state.options.mode).toBe('balanced');
    const statePath = join(fixture.cwd, '.omc/state/team/feature/workflow.json');
    const before = readFileSync(statePath);
    await workflowCommand(['status', 'feature'], fixture.cwd);
    await workflowCommand(['usage', 'feature'], fixture.cwd);
    expect(readFileSync(statePath)).toEqual(before);
    expect(state.tasks[0].attempts).toBe(0);
    expect(fixture.git('rev-parse', 'main')).toBe(fixture.baseCommit);
  });

  it('refuses synthetic capabilities through the normal CLI before reserving an invocation', async () => {
    const { rolesFile, planFile, runtimeFile } = inputs();
    await workflowCommand(['init', '--file', planFile, '--profile', 'role-substitution', '--bindings', rolesFile, '--workers', '1'], fixture.cwd);
    await expect(workflowCommand(['run', 'feature', '--runtime', runtimeFile], fixture.cwd))
      .rejects.toThrow('workflow_capability_validation_required');
    const state = readWorkflow(fixture.cwd, 'feature');
    expect(state.tasks[0]).toMatchObject({ status: 'pending', attempts: 0 });
    expect(state.tasks[0].invocations ?? []).toEqual([]);
    expect(state.reviewPasses).toBe(0);
    expect(fixture.git('rev-parse', 'HEAD')).toBe(fixture.baseCommit);
    expect(fixture.git('status', '--porcelain')).toBe('');
  });
});
