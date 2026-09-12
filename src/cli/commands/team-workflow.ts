import { readFileSync, statSync } from 'node:fs';
import {
  acceptWorkflowTask, addWorkflowFix, adjudicateWorkflow, cleanupWorkflow, finishWorkflow,
  initWorkflow, readWorkflow, rejectWorkflowTask, resumeWorkflowTask, reviewWorkflow, runWorkflow,
  verifyWorkflow, workflowStatus,
} from '../../team/workflow.js';
import type { WorkflowOptions } from '../../team/workflow.js';
import { workflowUsage } from '../../team/workflow-report.js';

export const WORKFLOW_HELP = `Usage: omc team workflow <operation>

  init --file <plan.json> [--mode v1|balanced] [--workers N] [--max-review-passes N] [--max-attempts N]
  run <name>
  status <name>
  usage <name>
  resume <name> <task-id> --expected-head <integration-sha> --reason <reason>
  accept <name> <task-id>
  reject <name> <task-id> --reason <reason>
  verify <name>
  review <name>
  adjudicate <name> --file <decisions.json>
  add-fix <name> --file <fix.json>
  finish <name>
  cleanup <name>

The Claude lead supplies a scoped plan, explicitly accepts worker commits, and
adjudicates review findings. Results contain bounded metadata and artifact paths.
See docs/GLM-WORKFLOW.md for plan, decision and fix schemas.`;

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

/** Explicit lead operations; ordinary team dispatch remains unchanged. */
export async function workflowCommand(args: string[], cwd = process.cwd()): Promise<void> {
  const [operation, ...rest] = args;
  if (!operation || ['--help', '-h', 'help'].includes(operation)) {
    console.log(WORKFLOW_HELP);
    return;
  }
  const { positional, flags } = parseArgs(rest);
  const allowed: Record<string, string[]> = {
    init: ['--file', '--mode', '--workers', '--max-review-passes', '--max-attempts'],
    run: [], status: [], usage: [], resume: ['--expected-head', '--reason'], accept: [], reject: ['--reason'], verify: [], review: [],
    adjudicate: ['--file'], 'add-fix': ['--file'], finish: [], cleanup: [],
  };
  if (!Object.hasOwn(allowed, operation)) throw new Error('workflow_unknown_operation');
  if ([...flags.keys()].some(flag => !allowed[operation].includes(flag))) {
    throw new Error('workflow_unknown_option');
  }
  const expected = operation === 'init' ? 0 : ['accept', 'reject', 'resume'].includes(operation) ? 2 : 1;
  if (positional.length !== expected) throw new Error('workflow_invalid_arguments');
  let name = positional[0];
  if (operation === 'usage') {
    console.log(JSON.stringify(workflowUsage(readWorkflow(cwd, name))));
    return;
  }
  let cleanup: Awaited<ReturnType<typeof cleanupWorkflow>> | undefined;
  if (operation === 'init') {
    const options: WorkflowOptions = {};
    const mode = flags.get('--mode');
    if (mode !== undefined) {
      if (mode !== 'v1' && mode !== 'balanced') throw new Error('workflow_invalid_mode');
      options.mode = mode;
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
    const state = await initWorkflow(cwd, readInputFile(flags.get('--file')), options);
    name = state.plan.name;
  } else if (operation === 'run') await runWorkflow(cwd, name);
  else if (operation === 'resume') {
    const reason = flags.get('--reason');
    const head = flags.get('--expected-head');
    if (!reason?.trim()) throw new Error('workflow_reason_required');
    if (!head || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(head)) throw new Error('workflow_invalid_sha');
    await resumeWorkflowTask(cwd, name, positional[1], head, reason);
  }
  else if (operation === 'accept') await acceptWorkflowTask(cwd, name, positional[1]);
  else if (operation === 'reject') {
    const reason = flags.get('--reason');
    if (!reason?.trim()) throw new Error('workflow_reason_required');
    await rejectWorkflowTask(cwd, name, positional[1], reason);
  } else if (operation === 'verify') await verifyWorkflow(cwd, name);
  else if (operation === 'review') await reviewWorkflow(cwd, name);
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
