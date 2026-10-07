/** Private launch configuration stays outside saved bindings and public prompts. */
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { isDeepStrictEqual } from 'node:util';
import { isExternalLLMDisabled } from '../lib/security-config.js';
import { parseWorkflowBinding, type WorkflowProviderRoute, type WorkflowRoleBinding, type WorkflowReviewProvenance } from './workflow-contracts.js';
import type { WorkflowSyntheticReviewClientFactory, WorkflowNativeReviewClientFactory } from './workflow-review-source-server.js';

export interface WorkflowAuthProfile {
  ref: string;
  providerRoute: WorkflowProviderRoute;
  environment: NodeJS.ProcessEnv;
  /** Explicit private files used by this route; contents never enter a saved state or receipt. */
  files: readonly string[];
  /** Additional private values known only to the trusted runner, never sent to a child implicitly. */
  redactionValues?: readonly string[];
}
/**
 * The private host qualification of the read-only review reader. It names the receipt file and its
 * expected digest; the controller resolves and validates the typed record itself. Absence is not a
 * default: a review that projects the reader refuses until the host supplies one.
 */
export interface WorkflowReaderQualificationSource {
  /** Absolute path of the typed reader qualification receipt. */
  readonly path: string;
  /** Expected sha256 of that receipt's exact bytes. */
  readonly sha256: string;
  /** Absolute path of the host Codex model catalog to project for a reader-only invocation. */
  readonly catalogPath?: string;
}
/** Consistency declaration only; a live runtime factory separately authorizes delivery. */
export interface WorkflowReaderObservation {
  readonly mode: 'native' | 'synthetic';
  readonly tools: readonly string[];
  /** Historical identity; files/labels confer no runtime observation authority. */
  readonly identity?: WorkflowReaderObservationIdentity;
}
/** Retained for parsing older private configs; these fields confer no observation authority. */
export interface WorkflowReaderObservationIdentity {
  readonly id: string;
  readonly sha256: string;
  readonly observedPath: string;
}
export interface WorkflowRuntime {
  resolveBinding(binding: WorkflowRoleBinding): { authProfile: WorkflowAuthProfile; capabilityEvidencePath: string };
  /** Synthetic evidence is permitted only by an explicit test/compatibility runner. */
  allowSyntheticCapabilities?: boolean;
  reviewAuthorship?: { path: string; sha256: string };
  /** Historical qualification guard; native records are refused in every entry point. */
  readerQualification?: WorkflowReaderQualificationSource;
  /** Historical mode/tool consistency guard; never a substitute for the live factory capability. */
  readerObservation?: WorkflowReaderObservation;
  /** Controller-selected, closed synthetic transport. Saved labels and files cannot create this capability. */
  syntheticReviewClientFactory?: WorkflowSyntheticReviewClientFactory;
  /** Minted only by the controller's actual authenticated native calibration. Never loaded from JSON. */
  nativeReviewClientFactory?: WorkflowNativeReviewClientFactory;
}
export interface PreparedWorkflowBinding {
  binding: WorkflowRoleBinding;
  command: string;
  environment: NodeJS.ProcessEnv;
  redactionEnvironment: NodeJS.ProcessEnv;
  actorId?: string;
  validation: 'synthetic' | 'authenticated';
}
const preparedBindings = new WeakMap<PreparedWorkflowBinding, PreparedWorkflowBinding>();
/** A structural object or copied capability receipt is not a prepared native launch. */
export function requirePreparedWorkflowBinding(prepared: PreparedWorkflowBinding): void {
  const captured = preparedBindings.get(prepared);
  if (!captured || !isDeepStrictEqual(prepared, captured)) throw new Error('workflow_prepared_binding_required');
}
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('workflow_invalid_capability_evidence');
  return value as Record<string, unknown>;
}
function fileDigest(path: string): string {
  if (!isAbsolute(path) || lstatSync(path).isSymbolicLink() || !statSync(path).isFile()) throw new Error('workflow_invalid_runtime_file');
  return digest(readFileSync(path));
}
function receipt(path: string, expected: string): Record<string, unknown> {
  if (!isAbsolute(path) || lstatSync(path).isSymbolicLink() || !statSync(path).isFile() || statSync(path).size > 64 * 1024) throw new Error('workflow_capability_evidence_changed');
  const bytes = readFileSync(path);
  if (bytes.length > 64 * 1024 || digest(bytes) !== expected) throw new Error('workflow_capability_evidence_changed');
  try { return object(JSON.parse(bytes.toString('utf8'))); }
  catch { throw new Error('workflow_invalid_capability_evidence'); }
}
function captureAuthProfile(profile: WorkflowAuthProfile): { fingerprint: string; redactionEnvironment: NodeJS.ProcessEnv } {
  const privateValues = [...(profile.redactionValues ?? [])];
  const secrets = (value: unknown, sensitive = false): void => {
    if (typeof value === 'string' && sensitive && value.length >= 4) privateValues.push(value);
    else if (Array.isArray(value)) for (const entry of value) secrets(entry, sensitive);
    else if (value && typeof value === 'object') for (const [key, entry] of Object.entries(value)) secrets(entry, sensitive || /key|token|secret|password|credential|authorization/i.test(key));
  };
  if (profile.files.length > 30) throw new Error('workflow_invalid_auth_profile');
  const files = profile.files.map(path => {
    if (!isAbsolute(path) || lstatSync(path).isSymbolicLink() || !statSync(path).isFile() || statSync(path).size > 1024 * 1024) throw new Error('workflow_invalid_runtime_file');
    const bytes = readFileSync(path);
    if (bytes.length > 1024 * 1024) throw new Error('workflow_invalid_runtime_file');
    let parsed: unknown;
    try { parsed = JSON.parse(bytes.toString('utf8')); } catch { privateValues.push(bytes.toString('utf8').trim()); }
    secrets(parsed, typeof parsed === 'string');
    if (parsed && typeof parsed === 'object' && 'env' in parsed) {
      const environment: NodeJS.ProcessEnv = {};
      for (const [key, value] of Object.entries(object(parsed.env))) {
        if (typeof value !== 'string') throw new Error('workflow_invalid_profile_environment');
        environment[key] = value;
      }
      childEnvironment({ ...profile, environment });
    }
    return { path: realpathSync(path), sha256: digest(bytes) };
  }).sort((a, b) => a.path.localeCompare(b.path));
  const environment = childEnvironment(profile);
  const fingerprint = digest(JSON.stringify({ ref: profile.ref, providerRoute: profile.providerRoute,
    environment: Object.entries(profile.environment).filter((entry): entry is [string, string] => entry[1] !== undefined)
      .sort(([a], [b]) => a.localeCompare(b)),
    homes: ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA'].map(key => [key, Object.entries(environment).find(([name]) => name.toUpperCase() === key)?.[1] ?? null]),
    files, redactionHashes: (profile.redactionValues ?? []).map(digest) }));
  return { fingerprint, redactionEnvironment: Object.fromEntries(privateValues.filter(value => value.length >= 4).map((value, index) => [`PRIVATE_AUTH_SECRET_${index}`, value])) };
}
export function fingerprintWorkflowAuthProfile(profile: WorkflowAuthProfile): string {
  return captureAuthProfile(profile).fingerprint;
}
/** Never inherit arbitrary parent credentials, provider routes or Node startup hooks. */
function childEnvironment(profile: WorkflowAuthProfile): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(?:PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|PROGRAMDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|LANG|LC_[A-Z_]+|TERM)$/i.test(key)) environment[key] = value;
  }
  const keys = new Set<string>();
  for (const [key, value] of Object.entries(profile.environment)) {
    if (value !== undefined && typeof value !== 'string') throw new Error('workflow_invalid_profile_environment');
    const identity = process.platform === 'win32' ? key.toUpperCase() : key;
    if (keys.has(identity)) throw new Error('workflow_duplicate_profile_environment');
    keys.add(identity);
    if (/^(?:CLAUDECODE|CLAUDE_CODE_ENTRYPOINT|CLAUDE_CODE_SESSION_ID|OMC_TEAM_|NODE_OPTIONS|NODE_PATH)/i.test(key)) throw new Error('workflow_unsafe_profile_environment');
    const foreign = profile.providerRoute === 'codex' ? /^(?:ANTHROPIC_|CLAUDE_|GLM_|MIMO_|ZAI_|Z_AI_|OMC_GLM_|OMC_MIMO_)/i
      : /^(?:OPENAI_|CODEX_)/i;
    if (foreign.test(key) || profile.providerRoute === 'claude' && /^OMC_(?:GLM|MIMO)_/i.test(key)) throw new Error('workflow_auth_route_mismatch');
    if (profile.providerRoute === 'claude' && /^ANTHROPIC_BASE_URL$/i.test(key) && value
      && value.replace(/\/$/, '') !== 'https://api.anthropic.com') throw new Error('workflow_auth_route_mismatch');
    if (profile.providerRoute === 'claude' && /^(?:CLAUDE_CODE_USE_(?:BEDROCK|VERTEX|FOUNDRY)|OMC_EXTERNAL_MODELS_)/i.test(key) && value && !['0', 'false'].includes(value)) throw new Error('workflow_auth_route_mismatch');
    if (value !== undefined) {
      if (process.platform === 'win32') for (const prior of Object.keys(environment)) if (prior.toUpperCase() === identity) delete environment[prior];
      environment[key] = value;
    }
  }
  return environment;
}
export function prepareWorkflowBinding(bindingValue: WorkflowRoleBinding, runtime?: WorkflowRuntime): PreparedWorkflowBinding {
  const binding = parseWorkflowBinding(bindingValue);
  if (!runtime || binding.role === 'lead' || !binding.executableIdentity) throw new Error('workflow_runtime_required');
  if (binding.role === 'reviewer' && binding.capabilities.includes('review-permission-transition')) throw new Error('workflow_review_transition_unsupported');
  if (binding.providerRoute !== 'claude' && isExternalLLMDisabled()) throw new Error('workflow_external_llm_disabled');
  let selected: ReturnType<WorkflowRuntime['resolveBinding']>;
  try { selected = runtime.resolveBinding(binding); } catch { throw new Error('workflow_auth_profile_unavailable'); }
  const profile = selected.authProfile;
  if (profile.ref !== binding.authProfileRef || profile.providerRoute !== binding.providerRoute) throw new Error('workflow_auth_route_mismatch');
  const environment = childEnvironment(profile);
  const captured = captureAuthProfile(profile);
  if (captured.fingerprint !== binding.authFingerprint) throw new Error('workflow_auth_profile_changed');
  const command = binding.executableIdentity.path;
  if (!isAbsolute(command) || process.platform === 'win32' && /\.(?:cmd|bat|ps1)$/i.test(command)) throw new Error('workflow_shell_wrapper_unsupported');
  try { if (fileDigest(command) !== binding.executableIdentity.sha256) throw new Error('changed'); }
  catch { throw new Error('workflow_executable_unavailable_or_changed'); }
  const evidence = receipt(selected.capabilityEvidencePath, binding.capabilityEvidenceSha256);
  const capabilities = evidence.capabilities;
  if (evidence.schemaVersion !== 1 || evidence.role !== binding.role || evidence.providerRoute !== binding.providerRoute
    || evidence.cliFamily !== binding.cliFamily || evidence.authFingerprint !== binding.authFingerprint
    || !isDeepStrictEqual(evidence.executableIdentity, binding.executableIdentity)
    || !Array.isArray(capabilities) || binding.capabilities.some(capability => !capabilities.includes(capability))) {
    throw new Error('workflow_capability_evidence_mismatch');
  }
  if (evidence.validation !== 'authenticated' && !(evidence.validation === 'synthetic' && runtime.allowSyntheticCapabilities)) throw new Error('workflow_capability_validation_required');
  if (!Array.isArray(evidence.models) || !evidence.models.some(value => {
    const model = object(value);
    return model.model === binding.model && Array.isArray(model.efforts) && model.efforts.includes(binding.effort ?? null);
  })) throw new Error('workflow_unsupported_model_or_effort');
  if (evidence.dependencies !== undefined) {
    if (!Array.isArray(evidence.dependencies) || evidence.dependencies.length > 20) throw new Error('workflow_invalid_capability_evidence');
    for (const dependency of evidence.dependencies) {
      const entry = object(dependency);
      if (typeof entry.path !== 'string' || fileDigest(entry.path) !== entry.sha256) throw new Error('workflow_executable_dependency_changed');
    }
  }
  if (/\.(?:c?js|mjs)$/i.test(command) && (!Array.isArray(evidence.dependencies)
    || !evidence.dependencies.some(value => { const entry = object(value); return entry.path === process.execPath && entry.sha256 === fileDigest(process.execPath); }))) {
    throw new Error('workflow_interpreter_evidence_required');
  }
  if (evidence.actorId !== undefined && (typeof evidence.actorId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/.test(evidence.actorId))) throw new Error('workflow_invalid_runner_identity');
  const secretValues = [...Object.entries(environment).filter(([key]) => /key|token|secret|password|credential|authorization/i.test(key)).map(([, value]) => value),
    ...Object.values(captured.redactionEnvironment)].filter((value): value is string => value !== undefined);
  const prepared: PreparedWorkflowBinding = { binding, command, environment, redactionEnvironment: Object.fromEntries(secretValues.map((value, index) => [`WORKFLOW_PRIVATE_SECRET_${index}`, value])), validation: evidence.validation,
    ...(typeof evidence.actorId === 'string' ? { actorId: evidence.actorId } : {}) };
  preparedBindings.set(prepared, structuredClone(prepared)); return prepared;
}
export function workflowWorkerArguments(prepared: PreparedWorkflowBinding, session?: { id: string; resume: boolean }): string[] {
  const binding = prepared.binding;
  if (binding.role !== 'implementer') throw new Error('workflow_adapter_operation_mismatch');
  return ['--dangerously-skip-permissions', '--model', binding.model, ...(binding.effort ? ['--effort', binding.effort] : []), '--print',
    ...(session ? [session.resume ? '--resume' : '--session-id', session.id] : ['--no-session-persistence']),
    '--output-format', 'stream-json', '--verbose'];
}
/**
 * The controller-owned read-only reader as it is projected onto one reviewer
 * invocation. `mcpConfig` is the ephemeral Claude `--mcp-config` document; `codex`
 * is the equivalent repeated dotted-TOML `--config` override list, because Codex
 * accepts neither that flag nor a global config rewrite. The authenticated
 * provider/profile settings the binding selected are never touched by either.
 */
export interface WorkflowReviewReaderInvocation {
  readonly mcpConfig: string;
  readonly codex: readonly string[];
}
/**
 * Reviewer argv. A compatibility review adds only an ephemeral read-only reader to
 * the selected native invocation — a Claude `--mcp-config` document or a Codex
 * per-invocation override list; without one the native argv stays byte-identical
 * and no global auth, config or tool surface is mutated.
 */
export function workflowReviewerArguments(prepared: PreparedWorkflowBinding, schemaFile: string, resultFile: string, schema: unknown,
  reader?: WorkflowReviewReaderInvocation): string[] {
  const binding = prepared.binding;
  if (binding.role !== 'reviewer') throw new Error('workflow_adapter_operation_mismatch');
  return reviewerArgumentsFor(binding, schemaFile, resultFile, schema, reader);
}
/**
 * The prospective reviewer argv of one binding over its own reader projection. The provider flags, the
 * model, the effort, the sandbox and tool surface and every argument position are the real ones this
 * invocation will carry, so a fingerprint taken over this list names the effective invocation rather
 * than the controller's own reader overrides alone. The caller names the two per-attempt reviewer
 * artifacts — the output schema file and the result file — by the placeholders this controller invents
 * inside one attempt, and states the reviewer result schema itself, which is controller-fixed.
 */
export function workflowReviewerProjectionArguments(binding: WorkflowRoleBinding, reader: WorkflowReviewReaderInvocation | undefined,
  input: { schemaFile: string; resultFile: string; schema: unknown }): string[] {
  return reviewerArgumentsFor(binding, input.schemaFile, input.resultFile, input.schema, reader);
}
function reviewerArgumentsFor(binding: WorkflowRoleBinding, schemaFile: string, resultFile: string, schema: unknown,
  reader: WorkflowReviewReaderInvocation | undefined): string[] {
  if (binding.providerRoute === 'codex') return ['exec', '--sandbox', 'read-only', '--ephemeral', '--json', '--model', binding.model,
    ...(binding.effort ? ['--config', `model_reasoning_effort=${JSON.stringify(binding.effort)}`] : []),
    ...(reader ? reader.codex : []),
    '--output-schema', schemaFile, '--output-last-message', resultFile, '-'];
  return ['--print', '--model', binding.model, ...(binding.effort ? ['--effort', binding.effort] : []), '--safe-mode', '--restricted',
    '--tools', 'Read,Glob,Grep', '--permission-mode', 'dontAsk', '--strict-mcp-config', '--mcp-config',
    reader ? reader.mcpConfig : '{"mcpServers":{}}',
    '--no-chrome', '--disable-slash-commands', '--no-session-persistence', '--output-format', 'stream-json', '--verbose', '--json-schema', JSON.stringify(schema)];
}
export function workflowReviewProvenance(prepared: PreparedWorkflowBinding, head: string, runtime: WorkflowRuntime): WorkflowReviewProvenance {
  const reviewerId = prepared.actorId ?? `unknown:${prepared.binding.id}`;
  if (!runtime.reviewAuthorship || !prepared.actorId) return { relation: 'unknown', authorIds: [], reviewerId, context: 'fresh' };
  const evidence = receipt(runtime.reviewAuthorship.path, runtime.reviewAuthorship.sha256);
  if (evidence.head !== head || evidence.complete !== true || !Array.isArray(evidence.authorIds) || evidence.authorIds.length === 0) {
    return { relation: 'unknown', authorIds: [], reviewerId, context: 'fresh' };
  }
  const authorIds = evidence.authorIds;
  if (authorIds.length > 100 || authorIds.some(id => typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/.test(id))) throw new Error('workflow_invalid_runner_identity');
  return { relation: authorIds.includes(reviewerId) ? 'self-review' : 'independent', authorIds, reviewerId, context: 'fresh' };
}
/** Decode only a bounded Claude terminal envelope; transcripts are not a structured result. */
export function createClaudeWorkflowResultDecoder(): { write(chunk: Buffer): void; finish(): unknown } {
  const decoder = new StringDecoder('utf8');
  let pending = ''; let oversized = false; let invalid = false; let terminalCount = 0; let output: unknown;
  const line = (value: string) => {
    if (!value.trim()) return;
    let event: Record<string, unknown>;
    try { event = object(JSON.parse(value)); } catch { invalid = true; return; }
    if (event.type !== 'result') return;
    terminalCount++;
    try {
      if (event.subtype !== 'success' || event.is_error !== false || !Object.hasOwn(event, 'structured_output')
        || Buffer.byteLength(JSON.stringify(event.structured_output) ?? '') > 64 * 1024) { invalid = true; return; }
      output = event.structured_output;
    } catch { invalid = true; }
  };
  return {
    write(chunk) {
      if (oversized) return;
      pending += decoder.write(chunk);
      let end: number;
      while ((end = pending.indexOf('\n')) >= 0) {
        const value = pending.slice(0, end); pending = pending.slice(end + 1);
        if (Buffer.byteLength(value) > 256 * 1024) { oversized = true; return; }
        line(value);
      }
      if (Buffer.byteLength(pending) > 256 * 1024) oversized = true;
    },
    finish() {
      pending += decoder.end();
      if (pending) line(pending);
      if (oversized || invalid || terminalCount !== 1) throw new Error('workflow_invalid_claude_result');
      return output;
    },
  };
}
