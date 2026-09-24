import { describe, expect, it } from 'vitest';
import { parseWorkflowFindings, parseWorkflowHandoff, parseWorkflowPlan, parseWorkflowTask } from '../workflow-contracts.js';

const task = {
  id: 'a', objective: 'Implement a', baseCommit: 'a'.repeat(40),
  writeScope: ['feature/a.txt'], readScope: ['README.md'], prohibitedScope: ['package.json'],
  dependencies: [], contracts: ['Keep public APIs stable.'], acceptanceCriteria: ['Scoped output exists.'], tests: [],
};
const plan = {
  name: 'feature', objective: 'Implement feature', baseCommit: 'a'.repeat(40), integrationBranch: 'integration/feature',
  tasks: [task], verification: [{ command: 'node', args: ['-e', 'process.exit(0)'] }],
};

describe('workflow plan boundaries', () => {
  it('preserves optional shared context without changing existing task contracts', () => {
    expect(parseWorkflowPlan(plan).sharedContext).toBeUndefined();
    const parsed = parseWorkflowPlan({ ...plan, sharedContext: 'Architecture and testing conventions.' });
    expect(parsed.sharedContext).toBe('Architecture and testing conventions.');
    expect(parsed.tasks).toEqual(parseWorkflowPlan(plan).tasks);
  });

  it('rejects malformed or oversized shared context, including multibyte text', () => {
    for (const sharedContext of [null, {}, '', 'x'.repeat(16385), '界'.repeat(5462)]) {
      expect(() => parseWorkflowPlan({ ...plan, sharedContext })).toThrow(/workflow_/);
    }
    expect(parseWorkflowPlan({ ...plan, sharedContext: 'x'.repeat(16384) }).sharedContext).toHaveLength(16384);
  });

  it('rejects overlapping write ownership without a dependency', () => {
    expect(() => parseWorkflowPlan({ ...plan, tasks: [task, { ...task, id: 'b', writeScope: ['feature'] }] }))
      .toThrow(/overlap/);
  });

  it('permits overlapping ownership when the later task depends on the owner', () => {
    expect(parseWorkflowPlan({ ...plan, tasks: [task, { ...task, id: 'b', dependencies: ['a'] }] }).tasks).toHaveLength(2);
  });

  it.each(['../outside', '/absolute', 'C:/outside', '.git/config', '.omc/state', 'src/**/foo', 'src/../../outside'])(
    'rejects unsafe ownership scope %s', writeScope => {
    expect(() => parseWorkflowTask({ ...task, writeScope: [writeScope] })).toThrow(/scope/);
    },
  );

  it('keeps bracketed file names literal in handoffs and review findings', () => {
    const file = 'apps/web/app/v1/[...path]/route.ts';
    const handoff = parseWorkflowHandoff({ taskId: 'a', outcome: 'completed', changedFiles: [file],
      tests: [], interfaceChanges: [], assumptions: [], risks: [], summary: 'Done.' }, 'a');
    expect(handoff.changedFiles).toEqual([file]);
    expect(parseWorkflowFindings({ findings: [{ severity: 'P2', message: 'Check route.', file }] }, 1)[0]?.file).toBe(file);
    expect(() => parseWorkflowTask({ ...task, writeScope: [file] })).toThrow('workflow_invalid_scope');
  });

  it.each(['../outside', '/absolute', 'C:/outside', '.git/config', '.omc/state', 'src/../../outside'])(
    'rejects unsafe reported file %s', file => {
      expect(() => parseWorkflowHandoff({ taskId: 'a', outcome: 'completed', changedFiles: [file],
        tests: [], interfaceChanges: [], assumptions: [], risks: [], summary: 'Done.' }, 'a'))
        .toThrow('workflow_invalid_scope');
    },
  );

  it('rejects a write scope containing a prohibited subtree', () => {
    expect(() => parseWorkflowPlan({ ...plan, tasks: [{ ...task, writeScope: ['src'], prohibitedScope: ['src/auth'] }] }))
      .toThrow(/prohibited/);
  });

  it('requires deterministic integration verification', () => {
    expect(() => parseWorkflowPlan({ ...plan, verification: [] })).toThrow(/verification/);
  });

  it('rejects dependency cycles and missing dependencies', () => {
    expect(() => parseWorkflowPlan({ ...plan, tasks: [{ ...task, dependencies: ['missing'] }] })).toThrow(/dependency/);
    expect(() => parseWorkflowPlan({ ...plan, tasks: [{ ...task, dependencies: ['a'] }] })).toThrow(/cycle/);
  });

  it('releases rejected ownership without removing history or weakening active ownership', () => {
    const rejected = new Set(['a']);
    const replacement = { ...task, id: 'replacement' };
    expect(parseWorkflowPlan({ ...plan, tasks: [task, replacement] }, rejected).tasks.map(entry => entry.id))
      .toEqual(['a', 'replacement']);
    expect(() => parseWorkflowPlan({ ...plan, tasks: [task, replacement, { ...task, id: 'other' }] }, rejected))
      .toThrow('workflow_overlapping_write_scope');
  });

  it('keeps missing and cyclic dependency validation for rejected historical tasks', () => {
    const rejected = new Set(['a']);
    expect(() => parseWorkflowPlan({ ...plan, tasks: [{ ...task, dependencies: ['missing'] }] }, rejected))
      .toThrow('workflow_missing_dependency');
    expect(() => parseWorkflowPlan({ ...plan, tasks: [{ ...task, dependencies: ['a'] }] }, rejected))
      .toThrow('workflow_dependency_cycle');
  });
});
