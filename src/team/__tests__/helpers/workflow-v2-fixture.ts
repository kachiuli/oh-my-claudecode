import { parseWorkflowBinding, type WorkflowProviderRoute, type WorkflowRole } from '../../workflow-contracts.js';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fingerprintWorkflowAuthProfile, type WorkflowAuthProfile, type WorkflowRuntime } from '../../workflow-adapters.js';
import type { createWorkflowFixture } from './workflow-fixture.js';

export const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const roleProvider = fileURLToPath(new URL('./workflow-role-provider.cjs', import.meta.url));

export function binding(role: WorkflowRole, providerRoute: WorkflowProviderRoute) {
  const hash = 'a'.repeat(64);
  return parseWorkflowBinding({ id: `${role}-${providerRoute}`, role, providerRoute,
    cliFamily: role === 'lead' ? 'external' : providerRoute === 'codex' ? 'codex-exec' : 'claude-code',
    model: providerRoute === 'codex' ? 'gpt-6-astra' : providerRoute === 'glm' ? 'glm-5.3' : 'claude-fable-5-1[1m]',
    authProfileRef: `profile-${providerRoute}`, authFingerprint: hash,
    ...(role === 'lead' ? {} : { executableIdentity: { path: 'C:/synthetic/provider.exe', sha256: hash, version: '1.0' } }),
    capabilities: role === 'lead' ? ['external-lead'] : role === 'reviewer' ? ['structured-findings', 'read-only'] : ['structured-handoff', 'session-resume'],
    capabilityEvidenceSha256: hash });
}
export function runtimeFixture(fixture: ReturnType<typeof createWorkflowFixture>) {
  const profiles = new Map<string, { authProfile: WorkflowAuthProfile; capabilityEvidencePath: string }>();
  const runtime: WorkflowRuntime = { allowSyntheticCapabilities: true, resolveBinding(selected) {
    const value = profiles.get(selected.id); if (!value) throw new Error('Missing synthetic route'); return value;
  } };
  const selectedBinding = (role: 'implementer' | 'reviewer', route: WorkflowProviderRoute, actorId?: string, suffix = '', profileOptions: Partial<WorkflowAuthProfile> = {}, model?: string) => {
    const base = parseWorkflowBinding({ ...binding(role, route), ...(model ? { model } : {}) });
    const id = `${base.id}${suffix}`;
    const authProfile: WorkflowAuthProfile = { ref: base.authProfileRef, providerRoute: route, files: [],
      ...profileOptions, environment: { OMC_WORKFLOW_TEST_CONFIG: fixture.configPath, FIXTURE_ROUTE: route,
        PRIVATE_TEST_SECRET: `synthetic-private-${route}-sentinel`, ...profileOptions.environment } };
    const executableIdentity = { path: roleProvider, sha256: hash(readFileSync(roleProvider)), version: '1.0' };
    const authFingerprint = fingerprintWorkflowAuthProfile(authProfile);
    const evidence = { schemaVersion: 1, role, providerRoute: route, cliFamily: base.cliFamily, validation: 'synthetic',
      executableIdentity, authFingerprint, capabilities: base.capabilities, models: [{ model: base.model, efforts: [null] }],
      dependencies: [{ path: process.execPath, sha256: hash(readFileSync(process.execPath)) }], ...(actorId ? { actorId } : {}) };
    const bytes = JSON.stringify(evidence);
    const capabilityEvidencePath = join(fixture.root, `${id}.capability.json`);
    writeFileSync(capabilityEvidencePath, bytes);
    const selected = parseWorkflowBinding({ ...base, id, executableIdentity, authFingerprint, capabilityEvidenceSha256: hash(bytes) });
    profiles.set(id, { authProfile, capabilityEvidencePath });
    return selected;
  };
  return { runtime, profiles, selectedBinding };
}
