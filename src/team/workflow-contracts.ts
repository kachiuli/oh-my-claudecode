import type { ArtifactDescriptor } from '../shared/artifact-descriptor.js';

export interface WorkflowCommand { command: string; args: string[] }
export interface WorkflowTask {
  id: string;
  objective: string;
  baseCommit: string;
  writeScope: string[];
  readScope: string[];
  prohibitedScope: string[];
  dependencies: string[];
  contracts: string[];
  acceptanceCriteria: string[];
  tests: WorkflowCommand[];
}
export interface WorkflowPlan {
  name: string;
  objective: string;
  baseCommit: string;
  integrationBranch: string;
  tasks: WorkflowTask[];
  verification: WorkflowCommand[];
}
export interface WorkflowOptions {
  workers?: number;
  maxWorkers?: number;
  maxAttempts?: number;
  maxReviewPasses?: number;
  timeoutMs?: number;
  backoffMs?: number;
  glmCommand?: string;
  glmModel?: string;
  codexModel?: string;
  codexCommand?: string;
}
export interface WorkflowHandoff {
  taskId: string;
  outcome: 'completed' | 'failed';
  commitSha?: string;
  changedFiles: string[];
  tests: Array<{ command: string; args: string[]; passed: boolean }>;
  interfaceChanges: string[];
  assumptions: string[];
  risks: string[];
  summary: string;
  artifacts: ArtifactDescriptor[];
}
export interface WorkflowTaskState {
  task: WorkflowTask;
  canonicalId: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'accepted' | 'rejected';
  attempts: number;
  worker: string;
  worktree?: string;
  branch?: string;
  handoff?: WorkflowHandoff;
  error?: string;
  backoffUntil?: string;
  claimToken?: string;
  updatedAt: string;
  findingIds?: string[];
}
export interface WorkflowFinding {
  id: string;
  severity: 'P0' | 'P1' | 'P2' | 'P3';
  message: string;
  file?: string;
  line?: number;
  disposition?: 'fix' | 'dismiss';
  reason?: string;
  fixedBy?: string;
}
export interface WorkflowState {
  schemaVersion: 1;
  profile: 'claude-glm-codex';
  plan: WorkflowPlan;
  cwd: string;
  integrationHead: string;
  options: Required<Omit<WorkflowOptions, 'glmModel' | 'codexModel'>> & { glmModel?: string; codexModel?: string };
  stage: 'implementation' | 'integration' | 'verification' | 'review' | 'adjudication' | 'remediation' | 'complete';
  tasks: WorkflowTaskState[];
  verification?: { head: string; passed: boolean; checks: Array<{ command: WorkflowCommand; passed: boolean; artifacts: ArtifactDescriptor[] }> };
  reviewPasses: number;
  reviews: Array<{ pass: number; head: string; findings: WorkflowFinding[]; artifacts: ArtifactDescriptor[] }>;
  createdAt: string;
  updatedAt: string;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('workflow_expected_object');
  return value as Record<string, unknown>;
}
export function boundedText(value: unknown, limit = 2000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || value.includes('\0')) throw new Error('workflow_invalid_text');
  return value;
}
export function safeWorkflowId(value: unknown): string {
  const text = boundedText(value, 30);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(text)) throw new Error('workflow_invalid_id');
  return text;
}
export function workflowSha(value: unknown): string {
  const text = boundedText(value, 64);
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(text)) throw new Error('workflow_invalid_sha');
  return text;
}
function texts(value: unknown, limit = 100): string[] {
  if (!Array.isArray(value) || value.length > limit) throw new Error('workflow_invalid_list');
  return value.map(item => boundedText(item));
}
export function scopePath(value: unknown): string {
  const text = boundedText(value, 400).replaceAll('\\', '/');
  const path = text.endsWith('/**') ? text.slice(0, -3) : text;
  if (path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..' || part === '.git' || part === '.omc')
    || /[:*?\[\]{}\r\n]/.test(path)) throw new Error('workflow_invalid_scope');
  if (process.platform === 'win32' && path.split('/').some(part => /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error('workflow_invalid_scope');
  return path;
}
export function matchesScope(path: string, scopes: string[]): boolean {
  const normalized = process.platform === 'win32' ? path.toLowerCase() : path;
  return scopes.some(scope => {
    const candidate = process.platform === 'win32' ? scope.toLowerCase() : scope;
    return normalized === candidate || normalized.startsWith(`${candidate}/`);
  });
}
export function parseWorkflowCommand(value: unknown): WorkflowCommand {
  const raw = object(value);
  const command = boundedText(raw.command, 1000);
  if (/[\r\n]/.test(command)) throw new Error('workflow_invalid_command');
  if (!Array.isArray(raw.args) || raw.args.length > 100 || raw.args.some(arg => typeof arg !== 'string' || arg.length > 4000 || arg.includes('\0'))) throw new Error('workflow_invalid_arguments');
  return { command, args: raw.args as string[] };
}
export function parseWorkflowTask(value: unknown): WorkflowTask {
  if (Buffer.byteLength(JSON.stringify(value) ?? '') > 48 * 1024) throw new Error('workflow_task_too_large');
  const raw = object(value);
  const writeScope = texts(raw.writeScope).map(scopePath);
  if (!writeScope.length) throw new Error('workflow_write_scope_required');
  if (!Array.isArray(raw.tests) || raw.tests.length > 30) throw new Error('workflow_invalid_tests');
  return { id: safeWorkflowId(raw.id), objective: boundedText(raw.objective), baseCommit: workflowSha(raw.baseCommit),
    writeScope, readScope: texts(raw.readScope).map(scopePath), prohibitedScope: texts(raw.prohibitedScope).map(scopePath),
    dependencies: texts(raw.dependencies).map(safeWorkflowId), contracts: texts(raw.contracts),
    acceptanceCriteria: texts(raw.acceptanceCriteria), tests: raw.tests.map(parseWorkflowCommand) };
}
export function validateWorkflowTasks(tasks: WorkflowTask[], rejectedTaskIds: ReadonlySet<string> = new Set()): void {
  const byId = new Map(tasks.map(task => [task.id, task]));
  if (byId.size !== tasks.length) throw new Error('workflow_duplicate_task');
  const dependencySets = new Map<string, Set<string>>();
  function dependencies(task: WorkflowTask, visiting = new Set<string>()): Set<string> {
    if (visiting.has(task.id)) throw new Error('workflow_dependency_cycle');
    const cached = dependencySets.get(task.id);
    if (cached) return cached;
    const next = new Set([...visiting, task.id]);
    const all = new Set<string>();
    for (const id of task.dependencies) {
      const dependency = byId.get(id);
      if (!dependency) throw new Error('workflow_missing_dependency');
      all.add(id);
      for (const ancestor of dependencies(dependency, next)) all.add(ancestor);
    }
    dependencySets.set(task.id, all);
    return all;
  }
  const depends = (task: WorkflowTask, target: string) => dependencies(task).has(target);
  for (const task of tasks) {
    depends(task, task.id);
    if (!task.acceptanceCriteria.length) throw new Error('workflow_acceptance_required');
    if (task.writeScope.some(path => task.prohibitedScope.some(p => matchesScope(path, [p]) || matchesScope(p, [path])))) throw new Error('workflow_prohibited_write_scope');
  }
  for (let i = 0; i < tasks.length; i++) for (let j = i + 1; j < tasks.length; j++) {
    const a = tasks[i]!; const b = tasks[j]!;
    // Rejected work remains in the dependency graph and history, but no longer owns its write scope.
    if (rejectedTaskIds.has(a.id) || rejectedTaskIds.has(b.id)) continue;
    const overlap = a.writeScope.some(path => b.writeScope.some(p => matchesScope(path, [p]) || matchesScope(p, [path])));
    if (overlap && !depends(a, b.id) && !depends(b, a.id)) throw new Error('workflow_overlapping_write_scope');
  }
}
export function parseWorkflowPlan(value: unknown, rejectedTaskIds: ReadonlySet<string> = new Set()): WorkflowPlan {
  if (Buffer.byteLength(JSON.stringify(value) ?? '') > 512 * 1024) throw new Error('workflow_plan_too_large');
  const raw = object(value);
  if (!Array.isArray(raw.tasks) || raw.tasks.length < 1 || raw.tasks.length > 100) throw new Error('workflow_invalid_tasks');
  if (!Array.isArray(raw.verification) || !raw.verification.length || raw.verification.length > 30) throw new Error('workflow_verification_required');
  const tasks = raw.tasks.map(parseWorkflowTask);
  validateWorkflowTasks(tasks, rejectedTaskIds);
  return { name: safeWorkflowId(raw.name), objective: boundedText(raw.objective), baseCommit: workflowSha(raw.baseCommit),
    integrationBranch: boundedText(raw.integrationBranch, 200), tasks, verification: raw.verification.map(parseWorkflowCommand) };
}
export function parseWorkflowHandoff(value: unknown, taskId: string): WorkflowHandoff {
  const raw = object(value);
  if (raw.taskId !== taskId || !['completed', 'failed'].includes(String(raw.outcome))) throw new Error('workflow_invalid_handoff_identity');
  if (!Array.isArray(raw.tests) || raw.tests.length > 30) throw new Error('workflow_invalid_handoff_tests');
  const tests = raw.tests.map(value => {
    const test = object(value);
    if (typeof test.passed !== 'boolean') throw new Error('workflow_invalid_test_result');
    return { ...parseWorkflowCommand(test), passed: test.passed };
  });
  return { taskId, outcome: raw.outcome as 'completed' | 'failed', ...(raw.commitSha ? { commitSha: workflowSha(raw.commitSha) } : {}),
    changedFiles: texts(raw.changedFiles).map(scopePath), tests, interfaceChanges: texts(raw.interfaceChanges, 30),
    assumptions: texts(raw.assumptions, 30), risks: texts(raw.risks, 30), summary: boundedText(raw.summary, 1000), artifacts: [] };
}
export function parseWorkflowFindings(value: unknown, pass: number): WorkflowFinding[] {
  const raw = object(value);
  if (!Array.isArray(raw.findings) || raw.findings.length > 50) throw new Error('workflow_invalid_findings');
  return raw.findings.map((entry, index) => {
    const finding = object(entry);
    if (!['P0', 'P1', 'P2', 'P3'].includes(String(finding.severity))) throw new Error('workflow_invalid_severity');
    if (finding.line !== undefined && finding.line !== null && (!Number.isInteger(finding.line) || Number(finding.line) < 1)) throw new Error('workflow_invalid_line');
    return { id: `review-${pass}-${index + 1}`, severity: finding.severity as WorkflowFinding['severity'], message: boundedText(finding.message),
      ...(finding.file ? { file: scopePath(finding.file) } : {}), ...(finding.line ? { line: Number(finding.line) } : {}) };
  });
}
