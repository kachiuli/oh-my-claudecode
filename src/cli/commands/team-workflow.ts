import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import {
  acceptWorkflowTask, addWorkflowFix, adjudicateWorkflow, cleanupWorkflow, finishWorkflow,
  initWorkflow, initWorkflowV2, readWorkflow, rejectWorkflowTask, resumeWorkflowTask, reviewWorkflow, runWorkflow,
  substituteWorkflowBinding, verifyWorkflow, workflowStatus,
} from '../../team/workflow.js';
import type { WorkflowOptions } from '../../team/workflow.js';
import { workflowUsage } from '../../team/workflow-report.js';
import { boundedText, safeWorkflowId, workflowSha } from '../../team/workflow-contracts.js';
import type { WorkflowAuthProfile, WorkflowRuntime } from '../../team/workflow-adapters.js';

export const WORKFLOW_HELP = `Usage: omc team workflow <operation>

  init --file <plan.json> [--mode v1|balanced] [--workers N] [--max-review-passes N] [--max-attempts N]
       [--timeout-ms N] [--profile claude-glm-codex|role-substitution] [--bindings <roles.json>]
  run <name> [--runtime <absolute-private-config.json>]
  status <name>
  usage <name>
  resume <name> <task-id> --expected-head <integration-sha> --reason <reason> [--runtime <absolute-private-config.json>]
  substitute <name> --file <intent.json>
  accept <name> <task-id>
  reject <name> <task-id> --reason <reason>
  verify <name>
  review <name> [--runtime <absolute-private-config.json>]
  adjudicate <name> --file <decisions.json>
  add-fix <name> --file <fix.json>
  finish <name>
  cleanup <name>

The external lead supplies a scoped plan, explicitly accepts worker commits, and
adjudicates review findings. Results contain bounded metadata and artifact paths.
Legacy initialization is unchanged. V1.2 requires an explicit role-substitution
profile, public bindings and balanced mode; private runtime stays outside the project.
Initialization accepts an optional task timeout between 100 and 3600000 ms, inclusive;
omitting it saves the controller's 600000 ms default unchanged.
Substitution records intent without dispatch or budget reset. Self-review is allowed.
See docs/GLM-WORKFLOW.md and docs/GLM-WORKFLOW-V1.2.md for schemas and setup.`;

function readInputFile(path: string | undefined): unknown {
  if (!path) throw new Error('workflow_input_file_required');
  if (statSync(path).size > 256 * 1024) throw new Error('workflow_input_too_large');
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error('workflow_input_invalid_json');
  }
}

function parseArgs(args: string[]): { positional: string[]; flags: Map<string, string> } {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const value = args[i];
    if (!value.startsWith('--')) { positional.push(value); continue; }
    if (flags.has(value) || !args[i + 1] || args[i + 1].startsWith('--')) {
      throw new Error('workflow_invalid_arguments');
    }
    flags.set(value, args[++i]);
  }
  return { positional, flags };
}

function inputObject(value: unknown, keys?: string[], error = 'workflow_invalid_runtime_config'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 100
    || keys && Object.keys(value).some(key => !keys.includes(key))) throw new Error(error);
  return value as Record<string, unknown>;
}
function runtimeText(value: unknown, limit = 4000): string {
  if (typeof value !== 'string' || value.length > limit || value.includes('\0')) throw new Error('workflow_invalid_runtime_config');
  return value;
}
function runtimePath(value: unknown): string {
  const path = runtimeText(value);
  if (!isAbsolute(path) || /[\r\n]/.test(path)) throw new Error('workflow_invalid_runtime_config');
  return path;
}
function privatePath(value: unknown, cwd: string): string {
  const path = runtimePath(value);
  const inside = (root: string, target: string) => {
    const suffix = relative(root, target);
    return suffix === '' || !isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`);
  };
  if (inside(resolve(cwd), resolve(path)) || inside(realpathSync(cwd), realpathSync(path))) {
    throw new Error('workflow_private_runtime_outside_project_required');
  }
  if (lstatSync(path).isSymbolicLink() || !statSync(path).isFile()) throw new Error('workflow_invalid_runtime_config');
  return path;
}
/** Load explicit machine-local configuration, never serialize it into workflow state or output. */
function readRuntime(path: string, cwd: string): WorkflowRuntime {
  try {
    privatePath(path, cwd);
    if (statSync(path).size > 256 * 1024) throw new Error('workflow_invalid_runtime_config');
    const bytes = readFileSync(path);
    if (bytes.length > 256 * 1024) throw new Error('workflow_invalid_runtime_config');
    const raw = inputObject(JSON.parse(bytes.toString('utf8')), ['schemaVersion', 'profiles', 'capabilityEvidence', 'reviewAuthorship']);
    if (raw.schemaVersion !== 1) throw new Error('workflow_invalid_runtime_config');
    const profiles = new Map<string, WorkflowAuthProfile>();
    for (const [ref, value] of Object.entries(inputObject(raw.profiles))) {
      safeWorkflowId(ref);
      const profile = inputObject(value, ['providerRoute', 'environment', 'files', 'redactionValues']);
      const providerRoute = profile.providerRoute;
      if (providerRoute !== 'claude' && providerRoute !== 'glm' && providerRoute !== 'codex') throw new Error('workflow_invalid_runtime_config');
      const environment = Object.fromEntries(Object.entries(inputObject(profile.environment)).map(([key, value]) => {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error('workflow_invalid_runtime_config');
        return [key, runtimeText(value, 32 * 1024)];
      }));
      if (!Array.isArray(profile.files) || profile.files.length > 30) throw new Error('workflow_invalid_runtime_config');
      const files = profile.files.map(runtimePath);
      let redactionValues: string[] | undefined;
      if (profile.redactionValues !== undefined) {
        if (!Array.isArray(profile.redactionValues) || profile.redactionValues.length > 100) throw new Error('workflow_invalid_runtime_config');
        redactionValues = profile.redactionValues.map(value => runtimeText(value));
      }
      profiles.set(ref, { ref, providerRoute, environment, files, ...(redactionValues === undefined ? {} : { redactionValues }) });
    }
    const evidence = new Map(Object.entries(inputObject(raw.capabilityEvidence)).map(([id, path]) => [safeWorkflowId(id), runtimePath(path)]));
    let reviewAuthorship: WorkflowRuntime['reviewAuthorship'];
    if (raw.reviewAuthorship !== undefined) {
      const receipt = inputObject(raw.reviewAuthorship, ['path', 'sha256']);
      const sha256 = runtimeText(receipt.sha256);
      if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('workflow_invalid_runtime_config');
      reviewAuthorship = { path: runtimePath(receipt.path), sha256 };
    }
    return { ...(reviewAuthorship ? { reviewAuthorship } : {}), resolveBinding(binding) {
      const authProfile = profiles.get(binding.authProfileRef); const capabilityEvidencePath = evidence.get(binding.id);
      if (!authProfile || !capabilityEvidencePath) throw new Error('workflow_auth_profile_unavailable');
      try {
        return { authProfile: { ...authProfile, files: authProfile.files.map(path => privatePath(path, cwd)) }, capabilityEvidencePath };
      } catch { throw new Error('workflow_auth_profile_unavailable'); }
    } };
  } catch (error) {
    if (error instanceof Error && error.message === 'workflow_private_runtime_outside_project_required') throw error;
    // Filesystem and JSON errors must not echo private paths, environment values or file contents.
    throw new Error('workflow_invalid_runtime_config');
  }
}

/** Explicit lead operations; ordinary team dispatch remains unchanged. */
export async function workflowCommand(args: string[], cwd = process.cwd()): Promise<void> {
  const [operation, ...rest] = args;
  if (!operation || ['--help', '-h', 'help'].includes(operation)) {
    console.log(WORKFLOW_HELP);
    return;
  }
  const { positional, flags } = parseArgs(rest);
  const allowed: Record<string, string[]> = {
    init: ['--file', '--mode', '--workers', '--max-review-passes', '--max-attempts', '--timeout-ms', '--profile', '--bindings'],
    run: ['--runtime'], status: [], usage: [], resume: ['--expected-head', '--reason', '--runtime'], accept: [], reject: ['--reason'], verify: [], review: ['--runtime'],
    substitute: ['--file'], adjudicate: ['--file'], 'add-fix': ['--file'], finish: [], cleanup: [],
  };
  if (!Object.hasOwn(allowed, operation)) throw new Error('workflow_unknown_operation');
  if ([...flags.keys()].some(flag => !allowed[operation].includes(flag))) {
    throw new Error('workflow_unknown_option');
  }
  const expected = operation === 'init' ? 0 : ['accept', 'reject', 'resume'].includes(operation) ? 2 : 1;
  if (positional.length !== expected) throw new Error('workflow_invalid_arguments');
  let name = positional[0];
  const runtime = () => {
    const file = flags.get('--runtime');
    if (file === undefined) return undefined;
    if (readWorkflow(cwd, name).schemaVersion !== 2) throw new Error('workflow_role_substitution_profile_required');
    return readRuntime(file, cwd);
  };
  if (operation === 'usage') {
    console.log(JSON.stringify(workflowUsage(readWorkflow(cwd, name))));
    return;
  }
  let cleanup: Awaited<ReturnType<typeof cleanupWorkflow>> | undefined;
  if (operation === 'init') {
    const options: WorkflowOptions = {};
    const profile = flags.get('--profile') ?? 'claude-glm-codex';
    if (profile !== 'claude-glm-codex' && profile !== 'role-substitution') throw new Error('workflow_invalid_profile');
    if (profile === 'claude-glm-codex' && flags.has('--bindings')) throw new Error('workflow_role_substitution_profile_required');
    if (profile === 'role-substitution' && !flags.has('--bindings')) throw new Error('workflow_bindings_required');
    const mode = flags.get('--mode');
    if (mode !== undefined) {
      if (mode !== 'v1' && mode !== 'balanced') throw new Error('workflow_invalid_mode');
      options.mode = mode;
    }
    if (profile === 'role-substitution') {
      if (mode !== undefined && mode !== 'balanced') throw new Error('workflow_balanced_mode_required');
      options.mode = 'balanced';
    }
    for (const [flag, key] of [
      ['--workers', 'workers'], ['--max-review-passes', 'maxReviewPasses'],
      ['--max-attempts', 'maxAttempts'],
    ] as const) {
      const raw = flags.get(flag);
      if (raw !== undefined) {
        if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
          throw new Error('workflow_invalid_limit');
        }
        options[key] = Number(raw);
      }
    }
    // The controller's own inclusive timeout range; the CLI refuses early, before either initializer runs.
    const timeout = flags.get('--timeout-ms');
    if (timeout !== undefined) {
      const value = /^\d+$/.test(timeout) ? Number(timeout) : Number.NaN;
      if (!Number.isSafeInteger(value) || value < 100 || value > 3_600_000) throw new Error('workflow_invalid_limit');
      options.timeoutMs = value;
    }
    const plan = readInputFile(flags.get('--file'));
    if (profile === 'role-substitution') {
      const roles = inputObject(readInputFile(flags.get('--bindings')), ['lead', 'implementer', 'reviewer'], 'workflow_invalid_bindings');
      for (const role of ['lead', 'implementer', 'reviewer']) inputObject(roles[role], undefined, 'workflow_invalid_bindings');
      name = (await initWorkflowV2(cwd, plan, { lead: roles.lead, implementer: roles.implementer, reviewer: roles.reviewer }, options)).plan.name;
    } else name = (await initWorkflow(cwd, plan, options)).plan.name;
  } else if (operation === 'run') {
    const selected = runtime();
    if (selected) await runWorkflow(cwd, name, selected); else await runWorkflow(cwd, name);
  }
  else if (operation === 'resume') {
    const reason = flags.get('--reason');
    const head = flags.get('--expected-head');
    if (!reason?.trim()) throw new Error('workflow_reason_required');
    if (!head || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(head)) throw new Error('workflow_invalid_sha');
    const selected = runtime();
    if (selected) await resumeWorkflowTask(cwd, name, positional[1], head, reason, selected);
    else await resumeWorkflowTask(cwd, name, positional[1], head, reason);
  }
  else if (operation === 'substitute') {
    const input = inputObject(readInputFile(flags.get('--file')), ['role', 'binding', 'expectedHead', 'reason', 'authorityRef', 'taskId'], 'workflow_invalid_substitution_intent');
    const role = input.role;
    if (role !== 'lead' && role !== 'implementer' && role !== 'reviewer') throw new Error('workflow_invalid_substitution_intent');
    inputObject(input.binding, undefined, 'workflow_invalid_substitution_intent');
    await substituteWorkflowBinding(cwd, name, { role, binding: input.binding, expectedHead: workflowSha(input.expectedHead),
      reason: boundedText(input.reason, 1000), authorityRef: boundedText(input.authorityRef, 1000),
      ...(input.taskId === undefined ? {} : { taskId: safeWorkflowId(input.taskId) }) });
  }
  else if (operation === 'accept') await acceptWorkflowTask(cwd, name, positional[1]);
  else if (operation === 'reject') {
    const reason = flags.get('--reason');
    if (!reason?.trim()) throw new Error('workflow_reason_required');
    await rejectWorkflowTask(cwd, name, positional[1], reason);
  } else if (operation === 'verify') await verifyWorkflow(cwd, name);
  else if (operation === 'review') {
    const selected = runtime();
    if (selected) await reviewWorkflow(cwd, name, selected); else await reviewWorkflow(cwd, name);
  }
  else if (operation === 'adjudicate') {
    const input = readInputFile(flags.get('--file'));
    // The controller performs authoritative schema validation.
    await adjudicateWorkflow(cwd, name, input as Parameters<typeof adjudicateWorkflow>[2]);
  } else if (operation === 'add-fix') {
    const input = readInputFile(flags.get('--file'));
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('workflow_invalid_fix');
    const fix = input as Record<string, unknown>;
    if (!Array.isArray(fix.findingIds) || fix.findingIds.some(id => typeof id !== 'string')) {
      throw new Error('workflow_invalid_fix_findings');
    }
    await addWorkflowFix(cwd, name, fix.task, fix.findingIds);
  } else if (operation === 'finish') await finishWorkflow(cwd, name);
  else if (operation === 'cleanup') cleanup = await cleanupWorkflow(cwd, name);
  const status = workflowStatus(cwd, name);
  console.log(JSON.stringify(cleanup ? { ...status, cleanup } : status));
  const verification = status.verification as { passed?: boolean } | null;
  const tasks = status.tasks as Array<{ status?: string }> | undefined;
  if ((operation === 'verify' && verification?.passed === false)
    || (['run', 'resume'].includes(operation) && (Number(status.failedTasks ?? 0) > 0 || tasks?.some(task => task.status === 'failed')))) {
    process.exitCode = 1;
  }
}
