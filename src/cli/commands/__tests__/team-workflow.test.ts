import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const api = vi.hoisted(() => ({
  initWorkflow: vi.fn(async () => ({ plan: { name: 'feature' } })),
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
  beforeEach(() => {
    vi.clearAllMocks();
    root = mkdtempSync(join(tmpdir(), 'omc-workflow-cli-'));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => { process.exitCode = 0; vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

  it('passes a file plan and explicit limits to initialization', async () => {
    const file = join(root, 'plan.json');
    writeFileSync(file, JSON.stringify({ name: 'feature' }));
    await workflowCommand(['init', '--file', file, '--workers', '3', '--max-review-passes', '2'], root);
    expect(api.initWorkflow).toHaveBeenCalledWith(root, { name: 'feature' }, { workers: 3, maxReviewPasses: 2 });
    expect(console.log).toHaveBeenCalledWith(JSON.stringify({ name: 'feature', stage: 'planned' }));
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
